import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import { MediaError, MediaErrorCode } from '@fluxmedia/core';

const sent: Array<{ name: string; input: Record<string, unknown> }> = [];
const sendImpl = vi.fn(async (command: { name: string; input: Record<string, unknown> }) => {
  sent.push(command);
  return {};
});
const clientConfigs: unknown[] = [];

vi.mock('@aws-sdk/client-s3', () => {
  const command = (name: string) =>
    class {
      name = name;
      constructor(public input: Record<string, unknown>) {}
    };
  return {
    S3Client: vi.fn().mockImplementation(function (config: unknown) {
      clientConfigs.push(config);
      return { send: sendImpl };
    }),
    DeleteObjectCommand: command('DeleteObject'),
    DeleteObjectsCommand: command('DeleteObjects'),
    HeadObjectCommand: command('HeadObject'),
    GetObjectCommand: command('GetObject'),
    PutObjectCommand: command('PutObject'),
    CopyObjectCommand: command('CopyObject'),
    ListObjectsV2Command: command('ListObjectsV2'),
  };
});

const uploads: Array<{ params: Record<string, unknown>; aborted: boolean }> = [];
let uploadDone: () => Promise<unknown> = async () => ({});
vi.mock('@aws-sdk/lib-storage', () => ({
  Upload: vi.fn().mockImplementation(function (opts: { params: Record<string, unknown> }) {
    const record = { params: opts.params, aborted: false };
    uploads.push(record);
    const listeners: Array<(p: unknown) => void> = [];
    return {
      on: (_event: string, fn: (p: unknown) => void) => listeners.push(fn),
      abort: async () => {
        record.aborted = true;
      },
      done: async () => {
        listeners.forEach((fn) => fn({ loaded: 42, total: undefined }));
        return uploadDone();
      },
    };
  }),
}));

const presignCalls: Array<{ command: { input: Record<string, unknown> }; options: Record<string, unknown> }> = [];
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(async (_client: unknown, command: { input: Record<string, unknown> }, options: Record<string, unknown>) => {
    presignCalls.push({ command, options });
    return `https://signed.example/${command.input.Key as string}?X-Amz-Signature=abc`;
  }),
}));

import { S3Provider } from '../s3-provider';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

const config = {
  region: 'us-east-1',
  bucket: 'bucket',
  accessKeyId: 'AKIA',
  secretAccessKey: 'secret',
};

beforeEach(() => {
  sent.length = 0;
  uploads.length = 0;
  presignCalls.length = 0;
  clientConfigs.length = 0;
  uploadDone = async () => ({});
  sendImpl.mockImplementation(async (command) => {
    sent.push(command);
    return {};
  });
});

describe('S3Provider configuration', () => {
  it('uses the default credential chain when no keys are given', async () => {
    const provider = new S3Provider({ region: 'eu-west-1', bucket: 'b' });
    await provider.getClient();
    expect(clientConfigs[0]).not.toHaveProperty('credentials');
    expect(clientConfigs[0]).toMatchObject({ requestChecksumCalculation: 'WHEN_REQUIRED' });
  });

  it('passes session tokens through', async () => {
    await new S3Provider({ ...config, sessionToken: 'tok' }).getClient();
    expect(clientConfigs[0]).toMatchObject({
      credentials: { accessKeyId: 'AKIA', secretAccessKey: 'secret', sessionToken: 'tok' },
    });
  });

  it('accepts an existing client', async () => {
    const client = { send: vi.fn() } as never;
    const provider = new S3Provider({ bucket: 'b', client });
    expect(await provider.getClient()).toBe(client);
  });

  it('rejects half-configured keys and missing region', () => {
    expect(() => new S3Provider({ bucket: 'b', region: 'x', accessKeyId: 'a' })).toThrow(MediaError);
    expect(() => new S3Provider({ bucket: 'b' })).toThrow(/region/);
  });

  it('does not expose credentials when serialized', () => {
    expect(JSON.stringify(new S3Provider(config))).not.toContain('secret');
  });
});

describe('S3Provider.upload', () => {
  it('sanitizes keys, sets content type and persists only primitive metadata', async () => {
    const provider = new S3Provider(config);
    const result = await provider.upload(PNG, {
      folder: '../../etc',
      filename: 'my photo',
      uniqueFilename: false,
      metadata: { owner: 'u1', _retry: { a: 1 }, extracted: { gps: [1] }, file: Buffer.from('x') },
      cacheControl: 'max-age=60',
      tags: ['a b'],
      providerOptions: { StorageClass: 'STANDARD_IA', Bucket: 'other', Key: 'evil' },
    });

    const params = uploads[0]!.params;
    expect(params).toMatchObject({
      Bucket: 'bucket',
      Key: 'etc/my-photo',
      ContentType: 'image/png',
      CacheControl: 'max-age=60',
      StorageClass: 'STANDARD_IA',
      Tagging: 'a%20b=',
      Metadata: { owner: 'u1', extension: 'png' },
    });
    expect(result).toMatchObject({
      id: 'etc/my-photo',
      contentType: 'image/png',
      size: PNG.byteLength,
      url: 'https://bucket.s3.us-east-1.amazonaws.com/etc/my-photo',
    });
    expect(result.metadata).not.toHaveProperty('_retry');
  });

  it('appends extensions when configured', async () => {
    const provider = new S3Provider({ ...config, appendExtension: true });
    const result = await provider.upload(PNG, { filename: 'a', uniqueFilename: false });
    expect(result.id).toBe('a.png');
  });

  it('reports stream size from upload progress', async () => {
    const provider = new S3Provider(config);
    const result = await provider.upload(Readable.from([PNG]), { contentType: 'image/png' });
    expect(result.size).toBe(42);
  });

  it('aborts the multipart upload when the signal fires', async () => {
    const provider = new S3Provider(config);
    const controller = new AbortController();
    uploadDone = () =>
      new Promise((_, reject) => {
        controller.signal.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        );
      });
    const promise = provider.upload(PNG, { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 0));
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: MediaErrorCode.ABORTED });
    expect(uploads[0]!.aborted).toBe(true);
  });

  it('applies ACLs only when useAcl is enabled', async () => {
    await new S3Provider({ ...config, useAcl: true }).upload(PNG, { public: false });
    expect(uploads[0]!.params.ACL).toBe('private');
    await new S3Provider(config).upload(PNG, {});
    expect(uploads[1]!.params).not.toHaveProperty('ACL');
  });

  it('refuses visibility requests the bucket cannot honour', async () => {
    await expect(
      new S3Provider({ ...config, publicUrl: false }).upload(PNG, { public: true })
    ).rejects.toMatchObject({ code: MediaErrorCode.INVALID_CONFIG });
    await expect(
      new S3Provider({ ...config, publicUrl: 'https://cdn.x' }).upload(PNG, { public: false })
    ).rejects.toMatchObject({ code: MediaErrorCode.INVALID_CONFIG });
  });

  it('maps throttling to RATE_LIMITED', async () => {
    uploadDone = async () => {
      throw Object.assign(new Error('slow'), { name: 'SlowDown' });
    };
    await expect(new S3Provider(config).upload(PNG)).rejects.toMatchObject({
      code: MediaErrorCode.RATE_LIMITED,
    });
  });
});

describe('S3Provider URLs', () => {
  it('uses a CDN base and encodes keys', () => {
    const provider = new S3Provider({ ...config, publicUrl: 'https://cdn.example.com/' });
    expect(provider.getUrl('a b/c#d.png')).toBe('https://cdn.example.com/a%20b/c%23d.png');
  });

  it('omits publicUrl for private buckets', async () => {
    const result = await new S3Provider({ ...config, publicUrl: false }).upload(PNG);
    expect(result).not.toHaveProperty('publicUrl');
  });

  it('creates download URLs with a lifetime cap and attachment filename', async () => {
    const provider = new S3Provider(config);
    const url = await provider.getSignedUrl('a/b.png', { expiresIn: 10 ** 9, downloadAs: 'résumé.pdf' });
    expect(url).toContain('X-Amz-Signature');
    expect(presignCalls[0]!.options.expiresIn).toBe(7 * 24 * 3600);
    expect(presignCalls[0]!.command.input.ResponseContentDisposition).toBe(
      `attachment; filename="r_sum_.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf`
    );
  });

  it('signs content type and length into upload URLs', async () => {
    const provider = new S3Provider(config);
    const target = await provider.createUploadUrl({
      contentType: 'image/png',
      size: 1234,
      folder: 'users/1',
      filename: 'avatar',
      uniqueFilename: false,
    });
    expect(target).toMatchObject({
      method: 'PUT',
      storageKey: 'users/1/avatar',
      headers: { 'Content-Type': 'image/png' },
      provider: 's3',
    });
    expect(presignCalls[0]!.command.input).toMatchObject({ ContentType: 'image/png', ContentLength: 1234 });
    expect([...(presignCalls[0]!.options.signableHeaders as Set<string>)]).toEqual([
      'content-type',
      'content-length',
    ]);
    expect(presignCalls[0]!.options.expiresIn).toBe(600);
  });
});

describe('S3Provider object operations', () => {
  it('deletes in batches and reports partial failures', async () => {
    sendImpl.mockImplementation(async (command) => {
      sent.push(command);
      return { Errors: [{ Key: 'b', Code: 'AccessDenied', Message: 'no' }] };
    });
    const error = await new S3Provider(config).deleteMultiple(['a', 'b']).catch((e) => e);
    expect(sent[0]!.name).toBe('DeleteObjects');
    expect(error.details.failedIds).toEqual(['b']);
  });

  it('rejects traversal keys before calling S3', async () => {
    await expect(new S3Provider(config).delete('../x')).rejects.toMatchObject({
      code: MediaErrorCode.INVALID_CONFIG,
    });
    expect(sent).toHaveLength(0);
  });

  it('maps HEAD 404 to FILE_NOT_FOUND and other failures to PROVIDER_ERROR', async () => {
    const provider = new S3Provider(config);
    sendImpl.mockRejectedValueOnce(Object.assign(new Error(''), { name: 'NotFound', $metadata: { httpStatusCode: 404 } }));
    await expect(provider.get('x')).rejects.toMatchObject({ code: MediaErrorCode.FILE_NOT_FOUND });
    sendImpl.mockRejectedValueOnce(new Error('weird'));
    await expect(provider.get('x')).rejects.toMatchObject({ code: MediaErrorCode.PROVIDER_ERROR });
    sendImpl.mockRejectedValueOnce(Object.assign(new Error(''), { name: 'NotFound' }));
    expect(await provider.exists('x')).toBe(false);
  });

  it('lists with prefix and continuation token', async () => {
    sendImpl.mockImplementation(async (command) => {
      sent.push(command);
      return {
        Contents: [{ Key: 'docs/a.pdf', Size: 3, LastModified: new Date(0) }],
        IsTruncated: true,
        NextContinuationToken: 'next',
      };
    });
    const page = await new S3Provider(config).list({ folder: 'docs', limit: 5000, cursor: 'c1' });
    expect(sent[0]!.input).toMatchObject({ Prefix: 'docs/', MaxKeys: 1000, ContinuationToken: 'c1' });
    expect(page.nextCursor).toBe('next');
    expect(page.items[0]).toMatchObject({ id: 'docs/a.pdf', size: 3, format: 'pdf' });
  });

  it('copies with an encoded copy source and moves by copy + delete', async () => {
    sendImpl.mockImplementation(async (command) => {
      sent.push(command);
      return command.name === 'HeadObject' ? { ContentLength: 1, ContentType: 'image/png' } : {};
    });
    await new S3Provider(config).move('a b.png', 'c.png');
    expect(sent.map((c) => c.name)).toEqual(['CopyObject', 'HeadObject', 'DeleteObject']);
    expect(sent[0]!.input.CopySource).toBe('bucket/a%20b.png');
  });

  it('replaces metadata while preserving content headers', async () => {
    sendImpl.mockImplementation(async (command) => {
      sent.push(command);
      return command.name === 'HeadObject'
        ? {
            ContentType: 'image/png',
            CacheControl: 'max-age=1',
            StorageClass: 'STANDARD_IA',
            ServerSideEncryption: 'aws:kms',
            SSEKMSKeyId: 'key-1',
            Metadata: { extension: 'png' },
          }
        : {};
    });
    await new S3Provider(config).updateMetadata('a.png', { label: 'x', city: 'Zürich' });
    expect(sent[1]!.input).toMatchObject({
      MetadataDirective: 'REPLACE',
      Metadata: { label: 'x', city: '=?UTF-8?B?WsO8cmljaA==?=', extension: 'png' },
      ContentType: 'image/png',
      CacheControl: 'max-age=1',
      StorageClass: 'STANDARD_IA',
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: 'key-1',
    });
  });

  it('decodes non-ASCII metadata on read', async () => {
    sendImpl.mockImplementation(async (command) => {
      sent.push(command);
      return { ContentLength: 1, Metadata: { extension: 'png', city: '=?UTF-8?B?WsO8cmljaA==?=' } };
    });
    expect((await new S3Provider(config).get('a.png')).metadata).toMatchObject({ city: 'Zürich' });
  });
});
