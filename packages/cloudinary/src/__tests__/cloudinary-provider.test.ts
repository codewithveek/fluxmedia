import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Writable, Readable } from 'node:stream';
import { MediaErrorCode } from '@fluxmedia/core';

type Callback = (error: unknown, result?: unknown) => void;

const state = {
  streamParams: [] as Array<Record<string, unknown>>,
  received: [] as Buffer[],
  uploadError: null as unknown,
  hang: false,
  destroyResults: [] as Array<{ result: string }>,
  destroyCalls: [] as Array<{ id: string; options: Record<string, unknown> }>,
  resource: vi.fn(),
  update: vi.fn(),
  rename: vi.fn(),
  searchExecute: vi.fn(),
  searchExpression: [] as string[],
};

vi.mock('cloudinary', () => {
  const searchBuilder = {
    max_results: () => searchBuilder,
    with_field: () => searchBuilder,
    next_cursor: () => searchBuilder,
    execute: (...args: unknown[]) => state.searchExecute(...args),
  };
  return {
    v2: {
      config: vi.fn(),
      uploader: {
        upload_stream: (params: Record<string, unknown>, cb: Callback) => {
          state.streamParams.push(params);
          const chunks: Buffer[] = [];
          return new Writable({
            write(chunk, _enc, done) {
              chunks.push(chunk);
              done();
            },
            final(done) {
              state.received.push(Buffer.concat(chunks));
              done();
              if (state.hang) return;
              if (state.uploadError) cb(state.uploadError);
              else
                cb(undefined, {
                  public_id: params.public_id,
                  version: 1,
                  format: 'png',
                  resource_type: 'image',
                  type: params.type ?? 'upload',
                  created_at: '2026-01-01T00:00:00Z',
                  bytes: Buffer.concat(chunks).length,
                  url: 'http://res/x',
                  secure_url: `https://res.cloudinary.com/demo/image/upload/${params.public_id as string}`,
                  width: 1,
                  height: 1,
                  context: { custom: { owner: 'u1' } },
                });
            },
          });
        },
        destroy: vi.fn(async (id: string, options: Record<string, unknown>) => {
          state.destroyCalls.push({ id, options });
          return state.destroyResults.shift() ?? { result: 'ok' };
        }),
        rename: (...args: unknown[]) => state.rename(...args),
        upload: vi.fn(),
      },
      api: {
        resource: (...args: unknown[]) => state.resource(...args),
        update: (...args: unknown[]) => state.update(...args),
      },
      search: { expression: (e: string) => (state.searchExpression.push(e), searchBuilder) },
      url: vi.fn((id: string, options: Record<string, unknown>) => `https://cdn/${options.resource_type as string}/${options.type as string}/${id}${options.auth_token ? '?__cld_token__=t' : ''}`),
      utils: {
        api_sign_request: vi.fn(() => 'sig'),
        private_download_url: vi.fn((id: string, format: string, options: Record<string, unknown>) =>
          `https://api.cloudinary.com/download?public_id=${id}&format=${format}&expires_at=${options.expires_at as number}`
        ),
      },
    },
  };
});

import { CloudinaryProvider } from '../cloudinary-provider';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const creds = { cloudName: 'demo', apiKey: 'key', apiSecret: 'secret' };

beforeEach(() => {
  state.streamParams.length = 0;
  state.received.length = 0;
  state.uploadError = null;
  state.hang = false;
  state.destroyResults.length = 0;
  state.destroyCalls.length = 0;
  state.searchExpression.length = 0;
  state.resource.mockReset();
  state.update.mockReset();
  state.rename.mockReset();
  state.searchExecute.mockReset();
});

describe('CloudinaryProvider.upload', () => {
  it('streams buffers with per-request credentials and sanitized public IDs', async () => {
    const provider = new CloudinaryProvider(creds);
    const progress: number[] = [];
    const result = await provider.upload(PNG, {
      folder: '../users/1',
      filename: 'me',
      uniqueFilename: false,
      metadata: { owner: 'u1', nested: { a: 1 }, _internal: 'x' },
      onByteProgress: (loaded) => progress.push(loaded),
    });

    expect(state.received[0]!.equals(PNG)).toBe(true);
    expect(state.streamParams[0]).toMatchObject({
      cloud_name: 'demo',
      api_key: 'key',
      api_secret: 'secret',
      public_id: 'users/1/me',
      resource_type: 'image',
      context: { owner: 'u1' },
    });
    expect(progress.at(-1)).toBe(PNG.byteLength);
    expect(result).toMatchObject({
      id: 'users/1/me',
      contentType: 'image/png',
      publicUrl: expect.stringContaining('users/1/me'),
      metadata: { owner: 'u1', resourceType: 'image', type: 'upload' },
    });
  });

  it('keeps two accounts separate (no global config)', async () => {
    await new CloudinaryProvider(creds).upload(PNG);
    await new CloudinaryProvider({ ...creds, cloudName: 'other', apiKey: 'k2' }).upload(PNG);
    expect(state.streamParams.map((p) => p.cloud_name)).toEqual(['demo', 'other']);
  });

  it('uploads File objects', async () => {
    await new CloudinaryProvider(creds).upload(new File([PNG], 'a.png', { type: 'image/png' }));
    expect(state.received[0]!.equals(PNG)).toBe(true);
  });

  it('stores public: false uploads as authenticated without a public URL', async () => {
    const result = await new CloudinaryProvider(creds).upload(PNG, { public: false });
    expect(state.streamParams[0]!.type).toBe('authenticated');
    expect(result).not.toHaveProperty('publicUrl');
  });

  it('rejects when the source stream errors instead of hanging', async () => {
    const source = new Readable({
      read() {
        this.destroy(new Error('disk read failed'));
      },
    });
    await expect(
      new CloudinaryProvider(creds).upload(source, { contentType: 'image/png' })
    ).rejects.toThrow('disk read failed');
  });

  it('rejects with ABORTED when cancelled', async () => {
    state.hang = true;
    const controller = new AbortController();
    const promise = new CloudinaryProvider(creds).upload(PNG, { signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    await expect(promise).rejects.toMatchObject({ code: MediaErrorCode.ABORTED });
  });

  it.each([
    [{ http_code: 401, message: 'Invalid API key' }, MediaErrorCode.INVALID_CREDENTIALS],
    [{ http_code: 402, message: 'Quota' }, MediaErrorCode.QUOTA_EXCEEDED],
    [{ http_code: 420, message: 'Rate Limit Exceeded' }, MediaErrorCode.RATE_LIMITED],
    [{ http_code: 400, message: 'Invalid image file' }, MediaErrorCode.INVALID_FILE_TYPE],
    [{ http_code: 400, message: 'File size too large' }, MediaErrorCode.FILE_TOO_LARGE],
    [{ http_code: 499, message: 'Request Timeout' }, MediaErrorCode.NETWORK_ERROR],
    [{ http_code: 500, message: 'oops' }, MediaErrorCode.PROVIDER_ERROR],
    [{ message: 'something else' }, MediaErrorCode.UPLOAD_FAILED],
  ])('maps %o to %s', async (error, code) => {
    state.uploadError = error;
    await expect(new CloudinaryProvider(creds).upload(PNG)).rejects.toMatchObject({ code });
  });
});

describe('CloudinaryProvider delete/get', () => {
  it('tries each resource type until the asset is found', async () => {
    state.destroyResults.push({ result: 'not found' }, { result: 'ok' });
    await new CloudinaryProvider(creds).delete('clip');
    expect(state.destroyCalls.map((c) => c.options.resource_type)).toEqual(['image', 'video']);
  });

  it('uses the resource type hint when given', async () => {
    await new CloudinaryProvider(creds).delete('clip', { metadata: { resourceType: 'video', type: 'authenticated' } });
    expect(state.destroyCalls).toHaveLength(1);
    expect(state.destroyCalls[0]!.options).toMatchObject({ resource_type: 'video', type: 'authenticated' });
  });

  it('treats a missing asset as already deleted', async () => {
    state.destroyResults.push({ result: 'not found' }, { result: 'not found' }, { result: 'not found' });
    await expect(new CloudinaryProvider(creds).delete('gone')).resolves.toBeUndefined();
  });

  it('reads with the Admin API instead of explicit()', async () => {
    state.resource
      .mockRejectedValueOnce({ error: { http_code: 404, message: 'not found' } })
      .mockResolvedValueOnce({
        public_id: 'clip',
        format: 'mp4',
        resource_type: 'video',
        type: 'upload',
        bytes: 10,
        created_at: '2026-01-01T00:00:00Z',
        secure_url: 'https://x/clip.mp4',
      });
    const result = await new CloudinaryProvider(creds).get('clip');
    expect(state.resource.mock.calls.map((c) => (c[1] as { resource_type: string }).resource_type)).toEqual([
      'image',
      'video',
    ]);
    expect(result).toMatchObject({ id: 'clip', contentType: 'video/mp4' });
  });

  it('maps a missing asset to FILE_NOT_FOUND', async () => {
    state.resource.mockRejectedValue({ error: { http_code: 404, message: 'Resource not found' } });
    await expect(new CloudinaryProvider(creds).get('nope')).rejects.toMatchObject({
      code: MediaErrorCode.FILE_NOT_FOUND,
    });
    expect(await new CloudinaryProvider(creds).exists('nope')).toBe(false);
  });
});

describe('CloudinaryProvider signing', () => {
  it('creates private download URLs that expire', async () => {
    const url = await new CloudinaryProvider(creds).getSignedUrl('doc', {
      expiresIn: 60,
      metadata: { resourceType: 'image', type: 'authenticated', format: 'pdf' },
    });
    expect(url).toContain('public_id=doc&format=pdf&expires_at=');
  });

  it('uses token auth (with transformations) for authenticated assets when authTokenKey is set', async () => {
    const url = await new CloudinaryProvider({ ...creds, authTokenKey: 'abcd' }).getSignedUrl('img', {
      transform: { width: 100 },
      metadata: { resourceType: 'image', type: 'authenticated', format: 'png' },
    });
    expect(url).toBe('https://cdn/image/authenticated/img?__cld_token__=t');
  });

  it('keeps the real delivery type: public assets get their public URL, not an "authenticated" one', async () => {
    const url = await new CloudinaryProvider({ ...creds, authTokenKey: 'abcd' }).getSignedUrl('img', {
      metadata: { resourceType: 'image', type: 'upload', format: 'png' },
    });
    expect(url).toBe('https://cdn/image/upload/img');
  });

  it('looks up the asset when hints are missing', async () => {
    state.resource.mockResolvedValue({
      public_id: 'clip',
      format: 'mp4',
      resource_type: 'video',
      type: 'authenticated',
      bytes: 1,
      created_at: '2026-01-01T00:00:00Z',
      secure_url: 'https://x/clip',
    });
    const url = await new CloudinaryProvider(creds).getSignedUrl('clip');
    expect(url).toContain('public_id=clip&format=mp4');
  });

  it('refuses expiring transformed URLs for private assets without token auth', async () => {
    await expect(
      new CloudinaryProvider(creds).getSignedUrl('img', {
        transform: { width: 1 },
        metadata: { resourceType: 'image', type: 'authenticated', format: 'png' },
      })
    ).rejects.toMatchObject({ code: MediaErrorCode.NOT_SUPPORTED });
  });

  it('creates signed upload params with fixed public ID and allowed formats', async () => {
    const target = await new CloudinaryProvider(creds).createUploadUrl({
      contentType: 'image/png',
      folder: 'users/1',
      filename: 'avatar',
      uniqueFilename: false,
      public: false,
    });
    expect(target).toMatchObject({
      method: 'POST',
      uploadUrl: 'https://api.cloudinary.com/v1_1/demo/image/upload',
      storageKey: 'users/1/avatar',
      fields: {
        public_id: 'users/1/avatar',
        type: 'authenticated',
        allowed_formats: 'png',
        api_key: 'key',
        signature: 'sig',
      },
    });
    expect(target.fields).not.toHaveProperty('api_secret');
    expect(target).not.toHaveProperty('publicUrl');
  });
});

describe('CloudinaryProvider list/search/move/metadata', () => {
  it('lists a folder through the Search API with escaped expressions', async () => {
    state.searchExecute.mockResolvedValue({ resources: [], next_cursor: 'n' });
    const page = await new CloudinaryProvider(creds).list({ folder: 'a-b/c' });
    expect(state.searchExpression[0]).toBe('public_id:a-b/c/*');
    expect(state.searchExecute.mock.calls[0]![0]).toMatchObject({ cloud_name: 'demo' });
    expect(page.nextCursor).toBe('n');
  });

  it('renames with the resource type from hints', async () => {
    state.rename.mockResolvedValue({
      public_id: 'b',
      format: 'mp4',
      resource_type: 'video',
      type: 'upload',
      bytes: 1,
      created_at: '2026-01-01T00:00:00Z',
      secure_url: 'https://x/b',
    });
    await new CloudinaryProvider(creds).move('a', 'b', { metadata: { resourceType: 'video' } });
    expect(state.rename.mock.calls[0]![2]).toMatchObject({ resource_type: 'video', overwrite: false });
  });

  it('updates context metadata with primitive values only', async () => {
    state.update.mockResolvedValue({});
    await new CloudinaryProvider(creds).updateMetadata('a', { label: 'x', deep: { y: 1 } }, {
      metadata: { resourceType: 'image' },
    });
    expect(state.update.mock.calls[0]![1]).toMatchObject({ context: { label: 'x' } });
  });
});
