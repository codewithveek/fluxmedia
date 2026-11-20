import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import { MediaUploader } from '../media-uploader';
import { MediaError, MediaErrorCode } from '../errors';
import { MemoryProvider } from '../memory-provider';
import { createSignedUrl, verifySignedUrl } from '../signing';
import {
  buildStorageKey,
  sanitizeFolder,
  assertSafeKey,
  toPersistedMetadata,
  decodePersistedMetadata,
  isMimeAllowed,
  detectTrustedType,
  randomId,
} from '../utils';
import type { UploadResult } from '../types';

// 1x1 PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const SECRET = 'x'.repeat(32);

describe('MediaUploader lifecycle', () => {
  it('awaits constructor plugin init before uploading', async () => {
    const order: string[] = [];
    const provider = new MemoryProvider();
    const uploader = new MediaUploader(provider, [
      {
        name: 'slow-init',
        init: async () => {
          await new Promise((r) => setTimeout(r, 10));
          order.push('init');
        },
        hooks: {
          beforeUpload: async (file, options) => {
            order.push('beforeUpload');
            return { file, options };
          },
        },
      },
    ]);
    await uploader.upload(PNG);
    expect(order).toEqual(['init', 'beforeUpload']);
  });

  it('rejects operations when a constructor plugin init fails', async () => {
    const uploader = new MediaUploader(new MemoryProvider(), [
      { name: 'broken', init: () => Promise.reject(new Error('init failed')), hooks: {} },
    ]);
    await expect(uploader.ready()).rejects.toThrow('init failed');
    await expect(uploader.upload(PNG)).rejects.toThrow('init failed');
  });

  it('reports beforeUpload failures to onError with phase beforeUpload', async () => {
    const onError = vi.fn(async () => undefined);
    const uploader = new MediaUploader(new MemoryProvider(), [
      { name: 'reject', hooks: { beforeUpload: async () => Promise.reject(new Error('nope')) } },
      { name: 'observer', hooks: { onError } },
    ]);
    await expect(uploader.upload(PNG)).rejects.toThrow('nope');
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'nope' }),
      expect.objectContaining({ phase: 'beforeUpload' })
    );
  });

  it('does not let a failing onError hook mask the original error', async () => {
    const provider = new MemoryProvider();
    vi.spyOn(provider, 'upload').mockRejectedValue(new Error('original'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const uploader = new MediaUploader(provider, [
      { name: 'bad-hook', hooks: { onError: async () => Promise.reject(new Error('hook')) } },
    ]);
    await expect(uploader.upload(PNG)).rejects.toThrow('original');
    warn.mockRestore();
  });

  it('composes wrapUpload hooks with the first plugin outermost', async () => {
    const calls: string[] = [];
    const uploader = new MediaUploader(new MemoryProvider(), [
      {
        name: 'outer',
        hooks: {
          wrapUpload: (next) => async (f, o) => {
            calls.push('outer');
            return next(f, o);
          },
        },
      },
      {
        name: 'inner',
        hooks: {
          wrapUpload: (next) => async (f, o) => {
            calls.push('inner');
            return next(f, o);
          },
        },
      },
    ]);
    await uploader.upload(PNG);
    expect(calls).toEqual(['outer', 'inner']);
  });

  it('passes the upload options to afterUpload hooks', async () => {
    const afterUpload = vi.fn(async (r: UploadResult) => r);
    const uploader = new MediaUploader(new MemoryProvider(), [{ name: 'a', hooks: { afterUpload } }]);
    await uploader.upload(PNG, { folder: 'x' });
    expect(afterUpload.mock.calls[0]![1]).toMatchObject({ options: { folder: 'x' } });
  });

  it('rejects with ABORTED when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const uploader = new MediaUploader(new MemoryProvider());
    await expect(uploader.upload(PNG, { signal: controller.signal })).rejects.toMatchObject({
      code: MediaErrorCode.ABORTED,
    });
  });
});

describe('MediaUploader fallback routing', () => {
  const networkError = () =>
    new MediaError('down', MediaErrorCode.NETWORK_ERROR, 'primary');

  it('does not fail over a stream (it was already consumed)', async () => {
    const primary = new MemoryProvider({ name: 'primary' });
    const fallback = new MemoryProvider({ name: 'fallback' });
    vi.spyOn(primary, 'upload').mockRejectedValue(networkError());
    const fallbackUpload = vi.spyOn(fallback, 'upload');
    const uploader = new MediaUploader(primary, [], { fallbackProvider: fallback });

    await expect(
      uploader.upload(Readable.from([PNG]), { contentType: 'image/png' })
    ).rejects.toThrow('down');
    expect(fallbackUpload).not.toHaveBeenCalled();
  });

  it('routes delete/get/signed URLs for a fallback result to the fallback provider', async () => {
    const primary = new MemoryProvider({ name: 'primary' });
    const fallback = new MemoryProvider({ name: 'fallback', signingSecret: SECRET });
    vi.spyOn(primary, 'upload').mockRejectedValue(networkError());
    const uploader = new MediaUploader(primary, [], { fallbackProvider: fallback });

    const result = await uploader.upload(PNG);
    expect(result.provider).toBe('fallback');
    expect((await uploader.get(result)).id).toBe(result.id);
    expect(await uploader.getSignedUrl(result)).toContain('signature=');
    await uploader.delete(result);
    expect(await fallback.exists(result.id)).toBe(false);
  });
});

describe('MediaUploader batch and capabilities', () => {
  it('uploadMultiple reports succeeded and failed uploads', async () => {
    const provider = new MemoryProvider();
    const real = provider.upload.bind(provider);
    vi.spyOn(provider, 'upload').mockImplementation(async (file, options) => {
      if ((file as Buffer).toString() === 'bad') throw new Error('boom');
      return real(file, options);
    });
    const uploader = new MediaUploader(provider);

    const error = await uploader
      .uploadMultiple([PNG, Buffer.from('bad'), PNG])
      .catch((e: MediaError) => e);

    expect(error).toBeInstanceOf(MediaError);
    expect((error as MediaError).details?.succeeded).toHaveLength(2);
    expect((error as MediaError).details?.failed).toEqual([
      expect.objectContaining({ index: 1 }),
    ]);
  });

  it('uploadMultiple reports batch progress and does not pass it to each upload', async () => {
    const provider = new MemoryProvider();
    const upload = vi.spyOn(provider, 'upload');
    const progress: Array<[number, number]> = [];
    await new MediaUploader(provider).uploadMultiple([PNG, PNG, PNG], {
      folder: 'b',
      onBatchProgress: (done, total) => progress.push([done, total]),
    });
    expect(progress).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
    expect(upload.mock.calls[0]![1]).not.toHaveProperty('onBatchProgress');
    expect(upload.mock.calls[0]![1]).not.toHaveProperty('concurrency');
  });

  it('throws NOT_SUPPORTED for missing optional capabilities', async () => {
    const provider = new MemoryProvider();
    (provider as { getSignedUrl?: unknown }).getSignedUrl = undefined;
    const uploader = new MediaUploader(provider);
    await expect(uploader.getSignedUrl('a')).rejects.toMatchObject({
      code: MediaErrorCode.NOT_SUPPORTED,
    });
  });

  it('exists() falls back to get() when the provider has no exists()', async () => {
    const provider = new MemoryProvider();
    (provider as { exists?: unknown }).exists = undefined;
    const uploader = new MediaUploader(provider);
    const result = await uploader.upload(PNG);
    expect(await uploader.exists(result.id)).toBe(true);
    expect(await uploader.exists('missing')).toBe(false);
  });

  it('listAll follows cursors', async () => {
    const uploader = new MediaUploader(new MemoryProvider());
    for (let i = 0; i < 5; i++) await uploader.upload(PNG, { folder: 'docs' });
    await uploader.upload(PNG, { folder: 'other' });

    const ids: string[] = [];
    for await (const item of uploader.listAll({ folder: 'docs', limit: 2 })) ids.push(item.id);
    expect(ids).toHaveLength(5);
    expect(ids.every((id) => id.startsWith('docs/'))).toBe(true);
  });
});

describe('MemoryProvider', () => {
  it('detects content type and never persists nested or internal metadata', async () => {
    const provider = new MemoryProvider();
    const result = await provider.upload(PNG, {
      metadata: { owner: 'u1', _internal: 'x', extracted: { gps: [1, 2] } },
    });
    expect(result.contentType).toBe('image/png');
    expect(result.format).toBe('png');
    const stored = await provider.get(result.id);
    expect(stored.metadata).toMatchObject({ owner: 'u1' });
    expect(stored.metadata).not.toHaveProperty('_internal');
    expect(stored.metadata).not.toHaveProperty('extracted');
  });

  it('copies, moves, downloads and updates metadata', async () => {
    const provider = new MemoryProvider();
    const { id } = await provider.upload(PNG, { filename: 'a', uniqueFilename: false });
    await provider.copy(id, 'b');
    await provider.move('b', 'c');
    expect(await provider.exists('b')).toBe(false);
    const { body, size } = await provider.download('c');
    expect(size).toBe(PNG.byteLength);
    const bytes = new Uint8Array(await new Response(body).arrayBuffer());
    expect(Buffer.from(bytes).equals(PNG)).toBe(true);
    await provider.updateMetadata('c', { label: 'x', nested: { a: 1 } });
    expect((await provider.get('c')).metadata).toMatchObject({ label: 'x' });
  });

  it('rejects traversal keys', async () => {
    const provider = new MemoryProvider();
    await expect(provider.get('../etc/passwd')).rejects.toMatchObject({
      code: MediaErrorCode.INVALID_CONFIG,
    });
  });

  it('throws FILE_NOT_FOUND for missing files', async () => {
    await expect(new MemoryProvider().get('nope')).rejects.toMatchObject({
      code: MediaErrorCode.FILE_NOT_FOUND,
    });
  });
});

describe('key and metadata utils', () => {
  it('sanitizes folders so they cannot escape the root', () => {
    expect(sanitizeFolder('../../etc//passwd')).toBe('etc/passwd');
    expect(sanitizeFolder('a\\..\\b')).toBe('a/b');
    expect(sanitizeFolder('/users/ 42 /')).toBe('users/42');
  });

  it('builds keys with sanitized names, unique suffixes and extensions', () => {
    expect(
      buildStorageKey({ folder: 'up', filename: '../x y', uniqueFilename: false, extension: 'png' })
    ).toBe('up/x-y.png');
    expect(buildStorageKey({ filename: 'photo' })).toMatch(/^photo-[a-z0-9]{8}$/);
    expect(buildStorageKey({ filename: 'фото', uniqueFilename: false })).toBe('фото');
    expect(buildStorageKey({})).toMatch(/^[a-z0-9]+-[a-z0-9]{10}$/);
  });

  it('rejects unsafe keys', () => {
    for (const key of ['', '/abs', 'a/../b', 'a\\b', 'a\u0000b']) {
      expect(() => assertSafeKey(key, 'p')).toThrow(MediaError);
    }
    expect(() => assertSafeKey('a/b.png', 'p')).not.toThrow();
  });

  it('keeps only primitive, non-internal metadata and makes it header-safe', () => {
    expect(
      toPersistedMetadata(
        { Name: 'café', n: 1, ok: true, _x: 'y', obj: { a: 1 }, fn: () => 1, nil: null },
        { ascii: true }
      )
    ).toEqual({ name: '=?UTF-8?B?Y2Fmw6k=?=', n: '1', ok: 'true' });
    expect(decodePersistedMetadata({ name: '=?UTF-8?B?Y2Fmw6k=?=', raw: '50%' })).toEqual({
      name: 'café',
      raw: '50%',
    });
  });

  it('does not let image/* match SVG', () => {
    expect(isMimeAllowed('image/png', ['image/*'])).toBe(true);
    expect(isMimeAllowed('image/svg+xml', ['image/*'])).toBe(false);
    expect(isMimeAllowed('image/svg+xml', ['image/svg+xml'])).toBe(true);
    expect(isMimeAllowed('IMAGE/PNG; charset=x', ['image/png'])).toBe(true);
  });

  it('refuses to trust a declared binary type that the bytes do not match', async () => {
    expect(await detectTrustedType(Buffer.from('<html>'), 'image/png')).toBeNull();
    expect(await detectTrustedType(Buffer.from('a,b'), 'text/csv')).toMatchObject({
      mime: 'text/csv',
      detected: false,
    });
    expect(await detectTrustedType(PNG, 'text/plain')).toMatchObject({ mime: 'image/png' });
  });

  it('generates random IDs from the alphabet', () => {
    expect(randomId(20)).toMatch(/^[a-z0-9]{20}$/);
  });
});

describe('signed URLs', () => {
  it('verifies valid URLs and rejects tampered or expired ones', async () => {
    const now = Date.now();
    const url = await createSignedUrl('https://cdn.test/files', 'a/b c.png', {
      secret: SECRET,
      expiresIn: 60,
      downloadAs: 'x.png',
      now,
    });
    expect(await verifySignedUrl(url, { secret: SECRET, pathPrefix: '/files', now })).toEqual({
      valid: true,
      key: 'a/b c.png',
      downloadAs: 'x.png',
    });
    expect(
      await verifySignedUrl(url.replace('a/b', 'a/c'), { secret: SECRET, pathPrefix: '/files', now })
    ).toMatchObject({ valid: false, reason: 'bad-signature' });
    expect(
      await verifySignedUrl(url, { secret: SECRET, pathPrefix: '/files', now: now + 120_000 })
    ).toMatchObject({ valid: false, reason: 'expired' });
  });

  it('requires a long secret', async () => {
    await expect(createSignedUrl('https://x', 'k', { secret: 'short', expiresIn: 1 })).rejects.toThrow();
  });
});
