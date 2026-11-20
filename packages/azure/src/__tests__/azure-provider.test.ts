import { beforeAll, describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { MediaErrorCode } from '@fluxmedia/core';
import { createProviderContractTests } from '@fluxmedia/core/testing';
import { AzureBlobProvider } from '../azure-provider';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function fakeService(sharedKey = false) {
  const blobs = new Map<string, { data: Buffer; props: Record<string, unknown>; metadata: Record<string, string> }>();
  const calls: Array<{ op: string; key: string; args: unknown[] }> = [];
  const notFound = () => Object.assign(new Error('not found'), { statusCode: 404, code: 'BlobNotFound' });
  const url = 'https://acct.blob.core.windows.net';

  const blob = (key: string) => {
    const store = (data: Buffer, options: Record<string, unknown>) => {
      const headers = options.blobHTTPHeaders as Record<string, string>;
      blobs.set(key, {
        data,
        props: { contentType: headers.blobContentType, contentLength: data.length, createdOn: new Date(0) },
        metadata: options.metadata as Record<string, string>,
      });
      (options.onProgress as (e: { loadedBytes: number }) => void)?.({ loadedBytes: data.length });
    };
    return {
      url: `${url}/media/${key}`,
      uploadData: async (data: Buffer, options: Record<string, unknown>) => {
        calls.push({ op: 'uploadData', key, args: [options] });
        store(data, options);
      },
      uploadStream: async (stream: Readable, _b: number, _c: number, options: Record<string, unknown>) => {
        calls.push({ op: 'uploadStream', key, args: [options] });
        const chunks: Buffer[] = [];
        for await (const c of stream) chunks.push(c as Buffer);
        store(Buffer.concat(chunks), options);
      },
      deleteIfExists: async () => blobs.delete(key),
      getProperties: async () => {
        const b = blobs.get(key);
        if (!b) throw notFound();
        return { ...b.props, metadata: b.metadata };
      },
      exists: async () => blobs.has(key),
      download: async () => {
        const b = blobs.get(key);
        if (!b) throw notFound();
        return { readableStreamBody: Readable.from([b.data]), contentType: b.props.contentType as string, contentLength: b.data.length };
      },
      setMetadata: async (m: Record<string, string>) => {
        blobs.get(key)!.metadata = m;
      },
      beginCopyFromURL: async (source: string) => ({
        pollUntilDone: async () => {
          const from = decodeURIComponent(new URL(source).pathname.replace('/media/', ''));
          blobs.set(key, structuredClone(blobs.get(from)!));
        },
      }),
      generateSasUrl: async (options: Record<string, unknown>) => {
        if (!sharedKey) {
          throw new RangeError('Can only generate the SAS when the client is initialized with a shared key credential');
        }
        calls.push({ op: 'sas', key, args: [options] });
        return `${url}/media/${encodeURIComponent(key)}?sp=${String(options.permissions)}&sig=x`;
      },
      generateUserDelegationSasUrl: async (options: Record<string, unknown>, delegationKey: unknown) => {
        calls.push({ op: 'udsas', key, args: [options, delegationKey] });
        return `${url}/media/${encodeURIComponent(key)}?sp=${String(options.permissions)}&skoid=x`;
      },
    };
  };

  const service = {
    url,
    getContainerClient: () => ({
      getBlockBlobClient: blob,
      listBlobsFlat: (opts: { prefix?: string }) => ({
        byPage: ({ maxPageSize, continuationToken }: { maxPageSize: number; continuationToken?: string }) => {
          const names = [...blobs.keys()].filter((n) => !opts.prefix || n.startsWith(opts.prefix)).sort();
          const start = continuationToken ? Number(continuationToken) : 0;
          const page = names.slice(start, start + maxPageSize);
          const next = start + maxPageSize < names.length ? String(start + maxPageSize) : undefined;
          return (async function* () {
            yield {
              ...(next && { continuationToken: next }),
              segment: { blobItems: page.map((name) => ({ name, properties: blobs.get(name)!.props, metadata: blobs.get(name)!.metadata })) },
            };
          })();
        },
      }),
    }),
    getUserDelegationKey: async () => ({ signedOid: 'x' }),
  };
  return { service: service as never, blobs, calls };
}

const make = (extra: Record<string, unknown> = {}, sharedKey = !!extra.accountKey) => {
  const fake = fakeService(sharedKey);
  return { fake, provider: new AzureBlobProvider({ container: 'media', serviceClient: fake.service, ...extra }) };
};

// The Azure SDK is slow to load cold; SAS generation imports it lazily
beforeAll(async () => {
  await import('@azure/storage-blob');
}, 120_000);

describe('AzureBlobProvider', () => {
  createProviderContractTests('Azure', () => make().provider);

  it('requires credentials of some kind', () => {
    expect(() => new AzureBlobProvider({ container: 'c' })).toThrow();
    expect(() => new AzureBlobProvider({ container: 'c', accountName: 'a' })).toThrow();
    const p = new AzureBlobProvider({
      container: 'c',
      connectionString: 'DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=a2V5;EndpointSuffix=core.windows.net',
    });
    expect(p.getUrl('a b.png')).toBe('https://acct.blob.core.windows.net/c/a%20b.png');
  });

  it('uploads buffers and streams with headers and identifier-safe metadata', async () => {
    const { fake, provider } = make();
    const result = await provider.upload(PNG, {
      filename: 'a',
      uniqueFilename: false,
      cacheControl: 'max-age=1',
      metadata: { 'user-id': 'u1', '1st': 'x', nested: { a: 1 } },
    });
    expect(fake.calls[0]!.op).toBe('uploadData');
    expect(fake.calls[0]!.args[0]).toMatchObject({
      blobHTTPHeaders: { blobContentType: 'image/png', blobCacheControl: 'max-age=1' },
      metadata: { user_id: 'u1', _1st: 'x' },
    });
    expect(result).toMatchObject({ id: 'a', size: PNG.byteLength, contentType: 'image/png' });

    const streamed = await provider.upload(Readable.from([PNG]), { contentType: 'image/png' });
    expect(fake.calls[1]!.op).toBe('uploadStream');
    expect(streamed.size).toBe(PNG.byteLength);
  });

  it('passes the abort signal to the SDK', async () => {
    const { fake, provider } = make();
    const controller = new AbortController();
    await provider.upload(PNG, { signal: controller.signal });
    expect(fake.calls[0]!.args[0]).toMatchObject({ abortSignal: controller.signal });
  });

  it('creates read SAS with the account key and user delegation SAS otherwise', async () => {
    const withKey = make({ accountKey: 'a2V5', accountName: 'acct' });
    expect(await withKey.provider.getSignedUrl('a.png')).toContain('sp=r');
    expect(withKey.fake.calls.at(-1)!.op).toBe('sas');

    // A client built with a shared key, passed in without accountKey in the config
    const sharedClient = make({}, true);
    expect(await sharedClient.provider.getSignedUrl('a.png')).toContain('sp=r');
    expect(sharedClient.fake.calls.at(-1)!.op).toBe('sas');

    const withToken = make();
    expect(await withToken.provider.getSignedUrl('a.png')).toContain('skoid');
    expect(withToken.fake.calls.at(-1)!.op).toBe('udsas');
  });

  it('creates write SAS targets with the block blob headers', async () => {
    const { provider } = make({ accountKey: 'a2V5', accountName: 'acct', publicUrl: false });
    const target = await provider.createUploadUrl({ contentType: 'image/png', filename: 'x', uniqueFilename: false });
    expect(target).toMatchObject({
      method: 'PUT',
      storageKey: 'x',
      headers: { 'x-ms-blob-type': 'BlockBlob', 'x-ms-blob-content-type': 'image/png' },
    });
    expect(target.uploadUrl).toContain('sp=cw');
    expect(target).not.toHaveProperty('publicUrl');
  });

  it('maps BlobNotFound, lists pages, copies and moves', async () => {
    const { provider } = make({ accountKey: 'a2V5', accountName: 'acct' });
    await expect(provider.get('nope')).rejects.toMatchObject({ code: MediaErrorCode.FILE_NOT_FOUND });
    for (let i = 0; i < 3; i++) await provider.upload(PNG, { folder: 'f' });
    const first = await provider.list({ folder: 'f', limit: 2 });
    expect(first.items).toHaveLength(2);
    const second = await provider.list({ folder: 'f', limit: 2, cursor: first.nextCursor! });
    expect(second.items).toHaveLength(1);

    await provider.move(first.items[0]!.id, 'moved.png');
    expect(await provider.exists(first.items[0]!.id)).toBe(false);
    const { body } = await provider.download('moved.png');
    expect(Buffer.from(await new Response(body).arrayBuffer()).equals(PNG)).toBe(true);
  });
});
