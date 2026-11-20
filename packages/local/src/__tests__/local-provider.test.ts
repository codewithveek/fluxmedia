import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { MediaErrorCode, MediaUploader } from '@fluxmedia/core';
import { createProviderContractTests } from '@fluxmedia/core/testing';
import { LocalProvider, createLocalFileHandler } from '../local-provider';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const SECRET = 'k'.repeat(32);

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fluxmedia-local-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('LocalProvider', () => {
  createProviderContractTests('Local', () => new LocalProvider({ root: tmpdir(), baseUrl: '/media' }));

  it('stores files with extensions, content type and primitive metadata', async () => {
    const provider = new LocalProvider({ root, baseUrl: 'https://files.test/media/' });
    const result = await provider.upload(PNG, {
      folder: '../../etc',
      filename: 'cat photo',
      uniqueFilename: false,
      metadata: { owner: 'u1', nested: { a: 1 } },
    });
    expect(result).toMatchObject({
      id: 'etc/cat-photo.png',
      url: 'https://files.test/media/etc/cat-photo.png',
      publicUrl: 'https://files.test/media/etc/cat-photo.png',
      contentType: 'image/png',
      size: PNG.byteLength,
    });
    const stored = await provider.get('etc/cat-photo.png');
    expect(stored.metadata).toEqual({ owner: 'u1' });
  });

  it('writes streams atomically and cleans up on abort', async () => {
    const provider = new LocalProvider({ root, baseUrl: '/m' });
    const controller = new AbortController();
    const slow = new Readable({
      read() {
        setTimeout(() => this.push(Buffer.alloc(10)), 5);
      },
    });
    const promise = provider.upload(slow, { contentType: 'image/png', signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(promise).rejects.toMatchObject({ code: MediaErrorCode.ABORTED });
    const leftovers = (await readdir(root)).filter((f) => f !== '.fluxmedia-meta');
    expect(leftovers).toEqual([]);
  });

  it('rejects keys that escape the root', async () => {
    const provider = new LocalProvider({ root, baseUrl: '/m' });
    await expect(provider.get('../outside')).rejects.toMatchObject({ code: MediaErrorCode.INVALID_CONFIG });
    await expect(provider.get('.fluxmedia-meta/x')).rejects.toMatchObject({ code: MediaErrorCode.INVALID_CONFIG });
  });

  it('lists, copies, moves, downloads and deletes', async () => {
    const uploader = new MediaUploader(new LocalProvider({ root, baseUrl: '/m' }));
    for (let i = 0; i < 3; i++) await uploader.upload(PNG, { folder: 'a' });
    const first = await uploader.list({ folder: 'a', limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeDefined();
    const second = await uploader.list({ folder: 'a', limit: 2, cursor: first.nextCursor! });
    expect(second.items).toHaveLength(1);

    const moved = await uploader.move(first.items[0]!, 'b/moved.png');
    expect(moved.contentType).toBe('image/png');
    await uploader.copy('b/moved.png', 'b/copy.png');
    const { body } = await uploader.download('b/copy.png');
    expect(Buffer.from(await new Response(body).arrayBuffer()).equals(PNG)).toBe(true);
    await uploader.deleteMultiple(['b/moved.png', 'b/copy.png']);
    expect(await uploader.exists('b/copy.png')).toBe(false);
  });

  it('serves private files only through valid signed URLs, with safe headers', async () => {
    const provider = new LocalProvider({
      root,
      baseUrl: 'http://localhost/files',
      private: true,
      signingSecret: SECRET,
    });
    const html = await provider.upload(Buffer.from('<script>alert(1)</script>'), {
      contentType: 'text/html',
      filename: 'x',
    });
    expect(html).not.toHaveProperty('publicUrl');
    const handler = createLocalFileHandler(provider, { pathPrefix: '/files' });

    expect((await handler(new Request(html.url))).status).toBe(403);

    const signed = await provider.getSignedUrl(html.id, { expiresIn: 60, downloadAs: 'x.html' });
    const res = await handler(new Request(signed));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(await res.text()).toContain('<script>');
  });

  it('answers 404 for missing public files', async () => {
    const provider = new LocalProvider({ root, baseUrl: 'http://localhost/files' });
    const handler = createLocalFileHandler(provider, { pathPrefix: '/files' });
    expect((await handler(new Request('http://localhost/files/nope.png'))).status).toBe(404);
    expect((await handler(new Request('http://localhost/files/..%2F..%2Fetc'))).status).toBe(404);
  });
});
