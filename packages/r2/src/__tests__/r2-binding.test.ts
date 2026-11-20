import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { MediaErrorCode, verifySignedUrl } from '@fluxmedia/core';
import { R2BindingProvider, type R2BucketBinding, type R2ObjectLike } from '../r2-binding-provider';
import { R2Provider } from '../r2-provider';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const SECRET = 's'.repeat(32);

function fakeBucket(): R2BucketBinding & { objects: Map<string, R2ObjectLike & { data: Uint8Array }> } {
  const objects = new Map<string, R2ObjectLike & { data: Uint8Array }>();
  const toBytes = async (value: unknown): Promise<Uint8Array> => {
    if (value instanceof Uint8Array) return value;
    if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
    return new Uint8Array(await new Response(value as ReadableStream).arrayBuffer());
  };
  return {
    objects,
    async put(key, value, options) {
      const data = await toBytes(value);
      const obj = {
        key,
        size: data.byteLength,
        uploaded: new Date(),
        data,
        ...(options?.httpMetadata && { httpMetadata: options.httpMetadata }),
        ...(options?.customMetadata && { customMetadata: options.customMetadata }),
      };
      objects.set(key, obj);
      return obj;
    },
    async get(key) {
      const obj = objects.get(key);
      if (!obj) return null;
      return { ...obj, body: new Response(obj.data).body! };
    },
    async head(key) {
      return objects.get(key) ?? null;
    },
    async delete(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k);
    },
    async list(options) {
      const all = [...objects.values()]
        .filter((o) => !options?.prefix || o.key.startsWith(options.prefix))
        .sort((a, b) => a.key.localeCompare(b.key));
      const start = options?.cursor ? Number(options.cursor) : 0;
      const limit = options?.limit ?? 1000;
      const page = all.slice(start, start + limit);
      const truncated = start + limit < all.length;
      return truncated
        ? { objects: page, truncated, cursor: String(start + limit) }
        : { objects: page, truncated };
    },
  };
}

describe('R2BindingProvider', () => {
  it('uploads with content type and primitive metadata only', async () => {
    const bucket = fakeBucket();
    const provider = new R2BindingProvider({ bucket });
    const result = await provider.upload(PNG, {
      folder: 'img',
      metadata: { owner: 'u', nested: { a: 1 } },
      cacheControl: 'max-age=5',
    });
    const stored = bucket.objects.get(result.id)!;
    expect(stored.httpMetadata).toEqual({ contentType: 'image/png', cacheControl: 'max-age=5' });
    expect(stored.customMetadata).toEqual({ owner: 'u' });
    expect(result).not.toHaveProperty('publicUrl');
  });

  it('rejects Node streams with a clear error', async () => {
    const provider = new R2BindingProvider({ bucket: fakeBucket() });
    await expect(provider.upload(Readable.from([PNG]))).rejects.toMatchObject({
      code: MediaErrorCode.INVALID_FILE_TYPE,
    });
  });

  it('lists pages, copies, moves and downloads', async () => {
    const provider = new R2BindingProvider({ bucket: fakeBucket() });
    for (let i = 0; i < 3; i++) await provider.upload(PNG, { folder: 'a' });
    const first = await provider.list({ folder: 'a', limit: 2 });
    expect(first.items).toHaveLength(2);
    const second = await provider.list({ folder: 'a', limit: 2, cursor: first.nextCursor! });
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeUndefined();

    await provider.move(first.items[0]!.id, 'b/moved.png');
    expect(await provider.exists(first.items[0]!.id)).toBe(false);
    const download = await provider.download('b/moved.png');
    expect(download.contentType).toBe('image/png');
    expect(new Uint8Array(await new Response(download.body).arrayBuffer())).toEqual(new Uint8Array(PNG));
  });

  it('creates HMAC signed URLs verifiable with verifySignedUrl', async () => {
    const provider = new R2BindingProvider({
      bucket: fakeBucket(),
      signedUrlBase: 'https://worker.example/files',
      signingSecret: SECRET,
    });
    const url = await provider.getSignedUrl('a/b.png', { expiresIn: 60 });
    expect(await verifySignedUrl(url, { secret: SECRET, pathPrefix: '/files' })).toMatchObject({
      valid: true,
      key: 'a/b.png',
    });
  });

  it('requires signing config for signed URLs', async () => {
    await expect(
      new R2BindingProvider({ bucket: fakeBucket() }).getSignedUrl('a')
    ).rejects.toMatchObject({ code: MediaErrorCode.INVALID_CONFIG });
  });
});

describe('R2Provider configuration', () => {
  it('builds jurisdiction endpoints', () => {
    const provider = new R2Provider({
      accountId: 'acct',
      jurisdiction: 'eu',
      bucket: 'b',
      accessKeyId: 'k',
      secretAccessKey: 's',
    });
    expect(provider.getUrl('x')).toBe('https://acct.eu.r2.cloudflarestorage.com/b/x');
  });

  it('refuses public: true on a private bucket', async () => {
    const provider = new R2Provider({ accountId: 'a', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' });
    await expect(provider.upload(PNG, { public: true })).rejects.toMatchObject({
      code: MediaErrorCode.INVALID_CONFIG,
    });
  });
});
