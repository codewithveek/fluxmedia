import { describe, it, expect, vi } from 'vitest';
import { createProxyUploadHandler, createSignedUploadHandler } from '../server';
import { MemoryProvider } from '../memory-provider';
import { MediaUploader } from '../media-uploader';
import type { SignedUploadOptions, SignedUploadTarget } from '../types';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

const user = { id: 'u1' };
const base = {
  authorize: (req: Request) => (req.headers.get('authorization') === 'ok' ? user : null),
  allowedTypes: ['image/*'],
  maxSize: 1000,
  folder: (u: typeof user) => `users/${u.id}`,
};

function signRequest(body: unknown, auth = 'ok'): Request {
  return new Request('http://x/sign', {
    method: 'POST',
    headers: { authorization: auth, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function signer() {
  const createUploadUrl = vi.fn(
    async (o: SignedUploadOptions): Promise<SignedUploadTarget> => ({
      uploadUrl: 'https://bucket/put',
      method: 'PUT',
      headers: { 'content-type': o.contentType },
      storageKey: `${o.folder}/${o.filename}`,
      expiresAt: new Date(0),
      provider: 'test',
    })
  );
  return { createUploadUrl, upload: vi.fn() };
}

describe('createSignedUploadHandler', () => {
  it('requires authorize, allowedTypes and maxSize', () => {
    expect(() =>
      createSignedUploadHandler(signer(), { ...base, authorize: undefined as never })
    ).toThrow();
    expect(() => createSignedUploadHandler(signer(), { ...base, allowedTypes: [] })).toThrow();
  });

  it('answers 401 without authorization', async () => {
    const handler = createSignedUploadHandler(signer(), base);
    const res = await handler(signRequest({ contentType: 'image/png', size: 10 }, 'bad'));
    expect(res.status).toBe(401);
  });

  it('answers 405 for non-POST', async () => {
    const handler = createSignedUploadHandler(signer(), base);
    expect((await handler(new Request('http://x', { method: 'GET' }))).status).toBe(405);
  });

  it('enforces size and type limits', async () => {
    const handler = createSignedUploadHandler(signer(), base);
    expect((await handler(signRequest({ contentType: 'image/png', size: 5000 }))).status).toBe(413);
    expect((await handler(signRequest({ contentType: 'text/html', size: 10 }))).status).toBe(415);
    expect((await handler(signRequest({ contentType: 'image/svg+xml', size: 10 }))).status).toBe(415);
    expect((await handler(signRequest({ contentType: 'image/png' }))).status).toBe(400);
  });

  it('uses the server folder and a sanitized filename, ignoring client paths', async () => {
    const s = signer();
    const handler = createSignedUploadHandler(s, base);
    const res = await handler(
      signRequest({ contentType: 'image/png', size: 10, filename: '../../admin/x.png', folder: 'evil' })
    );
    expect(res.status).toBe(200);
    expect(s.createUploadUrl).toHaveBeenCalledWith({
      contentType: 'image/png',
      size: 10,
      filename: 'x',
      folder: 'users/u1',
    });
    expect((await res.json()).storageKey).toBe('users/u1/x');
  });

  it('hides unexpected errors behind a generic 500', async () => {
    const s = signer();
    s.createUploadUrl.mockRejectedValue(new Error('secret internals'));
    const onError = vi.fn();
    const handler = createSignedUploadHandler(s, { ...base, onError });
    const res = await handler(signRequest({ contentType: 'image/png', size: 10 }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Upload failed' });
    expect(onError).toHaveBeenCalled();
  });
});

describe('createProxyUploadHandler', () => {
  function proxyRequest(file: Blob, name: string, opts: { auth?: string; length?: boolean } = {}) {
    const form = new FormData();
    form.append('file', file, name);
    const req = new Request('http://x/upload', {
      method: 'POST',
      headers: { authorization: opts.auth ?? 'ok' },
      body: form,
    });
    return req;
  }

  async function withLength(req: Request): Promise<Request> {
    const body = await req.arrayBuffer();
    const headers = new Headers(req.headers);
    headers.set('content-length', String(body.byteLength));
    return new Request(req.url, { method: 'POST', headers, body });
  }

  it('stores a valid image under the server folder without leaking metadata', async () => {
    const provider = new MemoryProvider();
    const handler = createProxyUploadHandler(new MediaUploader(provider), base);
    const res = await handler(await withLength(proxyRequest(new Blob([PNG]), 'me.png')));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.storageKey).toMatch(/^users\/u1\/me-[a-z0-9]{8}$/);
    expect(json.contentType).toBe('image/png');
    expect(json).not.toHaveProperty('metadata');
  });

  it('requires Content-Length', async () => {
    const handler = createProxyUploadHandler(new MemoryProvider(), base);
    const req = proxyRequest(new Blob([PNG]), 'a.png');
    req.headers.delete('content-length');
    expect((await handler(req)).status).toBe(411);
  });

  it('rejects files whose bytes do not match an allowed type', async () => {
    const handler = createProxyUploadHandler(new MemoryProvider(), base);
    const spoofed = new Blob(['<script>alert(1)</script>'], { type: 'image/png' });
    const res = await handler(await withLength(proxyRequest(spoofed, 'x.png')));
    expect(res.status).toBe(415);
  });

  it('rejects oversized files', async () => {
    const handler = createProxyUploadHandler(new MemoryProvider(), { ...base, maxSize: 10 });
    const res = await handler(await withLength(proxyRequest(new Blob([PNG]), 'a.png')));
    expect(res.status).toBe(413);
  });
});
