/**
 * Integration tests against a real S3-compatible server (LocalStack in CI;
 * MinIO, Garage or a real bucket work too).
 *
 * Run locally:
 *   docker run -p 4566:4566 -e SERVICES=s3 -e S3_SKIP_SIGNATURE_VALIDATION=0 localstack/localstack:3.8
 *   S3_INTEGRATION_ENDPOINT=http://localhost:4566 S3_INTEGRATION_ACCESS_KEY=test \
 *     S3_INTEGRATION_SECRET_KEY=test pnpm vitest run packages/s3
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { MediaErrorCode, MediaUploader } from '@fluxmedia/core';
import { S3Provider } from '../s3-provider';

const endpoint = process.env.S3_INTEGRATION_ENDPOINT;
const accessKeyId = process.env.S3_INTEGRATION_ACCESS_KEY ?? 'test';
const secretAccessKey = process.env.S3_INTEGRATION_SECRET_KEY ?? 'test';
const bucket = `fluxmedia-it-${Date.now().toString(36)}`;

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

describe.skipIf(!endpoint)('S3Provider integration', () => {
  let provider: S3Provider;
  let uploader: MediaUploader;

  beforeAll(async () => {
    const config = { region: 'us-east-1', endpoint: endpoint!, forcePathStyle: true, accessKeyId, secretAccessKey };
    await new S3Client({ ...config, credentials: { accessKeyId, secretAccessKey } }).send(
      new CreateBucketCommand({ Bucket: bucket })
    );
    provider = new S3Provider({ ...config, bucket, publicUrl: false });
    uploader = new MediaUploader(provider);
  }, 60_000);

  it('uploads, reads metadata and serves a signed download', async () => {
    const result = await uploader.upload(PNG, { folder: 'it', metadata: { owner: 'u1', city: 'Zürich' } });
    expect(result).not.toHaveProperty('publicUrl');

    const stored = await uploader.get(result);
    expect(stored).toMatchObject({
      size: PNG.byteLength,
      contentType: 'image/png',
      metadata: { owner: 'u1', city: 'Zürich' },
    });

    const res = await fetch(await uploader.getSignedUrl(result, { expiresIn: 60 }));
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it('enforces the signed content type and size on presigned uploads', async () => {
    const target = await uploader.createUploadUrl({ contentType: 'image/png', size: PNG.byteLength, folder: 'direct' });

    const wrongSize = await fetch(target.uploadUrl, {
      method: 'PUT',
      headers: target.headers!,
      body: Buffer.concat([PNG, Buffer.from('extra')]),
    });
    expect(wrongSize.ok).toBe(false);

    const wrongType = await fetch(target.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/html' },
      body: PNG,
    });
    expect(wrongType.ok).toBe(false);

    const ok = await fetch(target.uploadUrl, { method: 'PUT', headers: target.headers!, body: PNG });
    expect(ok.status).toBe(200);
    expect(await uploader.exists(target.storageKey)).toBe(true);
  });

  it('lists, copies, updates metadata, downloads and batch-deletes', async () => {
    const a = await uploader.upload(PNG, { folder: 'batch' });
    await uploader.upload(PNG, { folder: 'batch' });
    const copy = await uploader.copy(a, 'batch-copy/a.png');
    await uploader.updateMetadata(copy, { label: 'copié' });
    const updated = await uploader.get('batch-copy/a.png');
    expect(updated.metadata).toMatchObject({ label: 'copié' });
    expect(updated.contentType).toBe('image/png');

    const { body } = await uploader.download('batch-copy/a.png');
    expect(Buffer.from(await new Response(body).arrayBuffer()).equals(PNG)).toBe(true);

    const ids: string[] = [];
    for await (const item of uploader.listAll({ folder: 'batch', limit: 1 })) ids.push(item.id);
    expect(ids).toHaveLength(2);

    await uploader.deleteMultiple([...ids, 'batch-copy/a.png']);
    expect(await uploader.exists(ids[0]!)).toBe(false);
    await expect(uploader.get(ids[0]!)).rejects.toMatchObject({ code: MediaErrorCode.FILE_NOT_FOUND });
  });
});
