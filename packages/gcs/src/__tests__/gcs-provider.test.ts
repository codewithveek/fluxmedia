import { describe, it, expect, vi } from 'vitest';
import { Writable, Readable } from 'node:stream';
import { MediaErrorCode } from '@fluxmedia/core';
import { createProviderContractTests } from '@fluxmedia/core/testing';
import { GCSProvider } from '../gcs-provider';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function fakeStorage() {
  const objects = new Map<string, { data: Buffer; metadata: Record<string, unknown> }>();
  const writeOptions: Array<Record<string, unknown>> = [];
  const signed: Array<Record<string, unknown>> = [];
  const notFound = () => Object.assign(new Error('No such object'), { code: 404 });

  const file = (name: string) => ({
    name,
    get metadata() {
      return objects.get(name)?.metadata ?? {};
    },
    createWriteStream(options: Record<string, unknown>) {
      writeOptions.push(options);
      const chunks: Buffer[] = [];
      return new Writable({
        write(chunk, _e, done) {
          chunks.push(chunk);
          done();
        },
        final(done) {
          const data = Buffer.concat(chunks);
          const meta = options.metadata as Record<string, unknown>;
          objects.set(name, {
            data,
            metadata: { ...meta, size: String(data.length), timeCreated: '2026-01-01T00:00:00Z' },
          });
          done();
        },
      });
    },
    createReadStream: () => Readable.from([objects.get(name)!.data]),
    delete: vi.fn(async () => {
      objects.delete(name);
    }),
    getMetadata: async () => {
      const obj = objects.get(name);
      if (!obj) throw notFound();
      return [obj.metadata];
    },
    setMetadata: async (patch: { metadata: Record<string, string | null> }) => {
      const obj = objects.get(name)!;
      const merged = { ...(obj.metadata.metadata as Record<string, string>), ...patch.metadata };
      for (const [k, v] of Object.entries(merged)) if (v === null) delete merged[k];
      obj.metadata = { ...obj.metadata, metadata: merged };
    },
    exists: async () => [objects.has(name)],
    getSignedUrl: async (config: Record<string, unknown>) => {
      signed.push(config);
      return [`https://storage.googleapis.com/b/${name}?X-Goog-Signature=x`];
    },
    copy: async (dest: { name: string }) => {
      objects.set(dest.name, structuredClone(objects.get(name)!));
    },
    move: async (dest: { name: string }) => {
      objects.set(dest.name, objects.get(name)!);
      objects.delete(name);
    },
  });

  const storage = {
    bucket: () => ({
      file,
      getFiles: async (q: { prefix?: string; maxResults: number; pageToken?: string }) => {
        const names = [...objects.keys()].filter((n) => !q.prefix || n.startsWith(q.prefix)).sort();
        const start = q.pageToken ? Number(q.pageToken) : 0;
        const page = names.slice(start, start + q.maxResults).map(file);
        const next = start + q.maxResults < names.length ? { pageToken: String(start + q.maxResults) } : null;
        return [page, next];
      },
    }),
  };
  return { storage: storage as never, objects, writeOptions, signed };
}

describe('GCSProvider', () => {
  createProviderContractTests('GCS', () => new GCSProvider({ bucket: 'b', storage: fakeStorage().storage }));

  it('uploads with content type, headers and primitive metadata', async () => {
    const fake = fakeStorage();
    const provider = new GCSProvider({ bucket: 'b', storage: fake.storage });
    const result = await provider.upload(PNG, {
      folder: 'img',
      filename: 'a',
      uniqueFilename: false,
      cacheControl: 'max-age=60',
      metadata: { owner: 'u', deep: { x: 1 } },
      tags: ['t1', 't2'],
    });
    expect(fake.writeOptions[0]).toMatchObject({
      contentType: 'image/png',
      resumable: false,
      metadata: { cacheControl: 'max-age=60', metadata: { owner: 'u', tags: 't1,t2' } },
    });
    expect(result).toMatchObject({
      id: 'img/a',
      size: PNG.byteLength,
      publicUrl: 'https://storage.googleapis.com/b/img/a',
    });
  });

  it('uses resumable uploads for streams and counts their size', async () => {
    const fake = fakeStorage();
    const result = await new GCSProvider({ bucket: 'b', storage: fake.storage }).upload(Readable.from([PNG]), {
      contentType: 'image/png',
    });
    expect(fake.writeOptions[0]!.resumable).toBe(true);
    expect(result.size).toBe(PNG.byteLength);
  });

  it('signs V4 read and write URLs with limits', async () => {
    const fake = fakeStorage();
    const provider = new GCSProvider({ bucket: 'b', storage: fake.storage, publicUrl: false });
    await provider.getSignedUrl('a.png', { expiresIn: 10 ** 9 });
    expect(fake.signed[0]).toMatchObject({ version: 'v4', action: 'read' });
    expect((fake.signed[0]!.expires as number) - Date.now()).toBeLessThanOrEqual(7 * 24 * 3600 * 1000);

    const target = await provider.createUploadUrl({ contentType: 'image/png', size: 100, filename: 'x', uniqueFilename: false });
    expect(fake.signed[1]).toMatchObject({
      action: 'write',
      contentType: 'image/png',
      extensionHeaders: { 'x-goog-content-length-range': '0,100' },
    });
    expect(target.headers).toMatchObject({ 'x-goog-content-length-range': '0,100' });
    expect(target).not.toHaveProperty('publicUrl');
  });

  it('maps 404 to FILE_NOT_FOUND and lists with page tokens', async () => {
    const fake = fakeStorage();
    const provider = new GCSProvider({ bucket: 'b', storage: fake.storage });
    await expect(provider.get('missing')).rejects.toMatchObject({ code: MediaErrorCode.FILE_NOT_FOUND });
    for (let i = 0; i < 3; i++) await provider.upload(PNG, { folder: 'f' });
    const first = await provider.list({ folder: 'f', limit: 2 });
    expect(first.items).toHaveLength(2);
    const second = await provider.list({ folder: 'f', limit: 2, cursor: first.nextCursor! });
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeUndefined();
  });

  it('replaces metadata, clearing removed keys', async () => {
    const fake = fakeStorage();
    const provider = new GCSProvider({ bucket: 'b', storage: fake.storage });
    const { id } = await provider.upload(PNG, { metadata: { a: '1', b: '2' } });
    await provider.updateMetadata(id, { c: '3' });
    expect((await provider.get(id)).metadata).toEqual({ c: '3' });
  });

  it('moves and downloads', async () => {
    const fake = fakeStorage();
    const provider = new GCSProvider({ bucket: 'b', storage: fake.storage });
    const { id } = await provider.upload(PNG);
    await provider.move(id, 'moved.png');
    expect(await provider.exists(id)).toBe(false);
    const { body } = await provider.download('moved.png');
    expect(Buffer.from(await new Response(body).arrayBuffer()).equals(PNG)).toBe(true);
  });
});
