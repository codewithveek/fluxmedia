# @fluxmedia/s3

AWS S3 provider for FluxMedia - unified media uploads with simple, reliable S3 storage.

## Installation

```bash
pnpm add @fluxmedia/core @fluxmedia/s3 @aws-sdk/client-s3 @aws-sdk/lib-storage
```

## Quick Start

```typescript
import { MediaUploader } from '@fluxmedia/core';
import { S3Provider } from '@fluxmedia/s3';

const uploader = new MediaUploader(
  new S3Provider({
    region: 'us-east-1',
    bucket: 'my-bucket',
    // Optional: without keys the AWS default credential chain is used
    // (IAM roles, ECS/EKS task roles, SSO, env vars, ~/.aws).
  })
);

const result = await uploader.upload(file, { folder: 'uploads', filename: 'photo' });

console.log(result.url);
// https://my-bucket.s3.us-east-1.amazonaws.com/uploads/photo-x1y2z3a4
```

## Features

- **Automatic multipart uploads** for files >5MB, cancellable with `signal`
- **Progress tracking** for individual and batch uploads
- **Batch deletes** with `DeleteObjects` (1000 keys per request)
- **Signed URLs** for downloads and direct browser uploads
- **List, copy, move, download, metadata updates**
- **S3-compatible** - MinIO, Backblaze B2, Wasabi, DigitalOcean Spaces, Supabase Storage, …

## Configuration

```typescript
interface S3Config {
  region?: string;          // Required unless you pass `client`
  bucket: string;
  accessKeyId?: string;     // Optional: default credential chain otherwise
  secretAccessKey?: string;
  sessionToken?: string;    // Temporary (STS) credentials
  credentials?: AwsCredentialIdentity | AwsCredentialIdentityProvider;
  client?: S3Client;        // Bring your own client
  clientConfig?: Partial<S3ClientConfig>;
  endpoint?: string;        // S3-compatible services
  forcePathStyle?: boolean;
  publicUrl?: string | false; // CDN base URL (CloudFront), or false for a private bucket
  useAcl?: boolean;         // Apply `public` as an object ACL (ACL-enabled buckets only)
  appendExtension?: boolean; // 'photo-x1y2.png' instead of 'photo-x1y2'
  multipart?: { partSize?: number; queueSize?: number };
}
```

## Private Buckets and Signed URLs

```typescript
const provider = new S3Provider({ region: 'us-east-1', bucket: 'private-bucket', publicUrl: false });
const uploader = new MediaUploader(provider);

const result = await uploader.upload(file);    // result.publicUrl is undefined
const url = await uploader.getSignedUrl(result, { expiresIn: 300, downloadAs: 'report.pdf' });

// Direct browser upload: the content type and exact size are signed
const target = await uploader.createUploadUrl({ contentType: 'image/png', size: 48213, folder: 'users/1' });
// → { uploadUrl, method: 'PUT', headers: { 'Content-Type': 'image/png' }, storageKey, expiresAt }
```

Use `createSignedUploadHandler` from `@fluxmedia/core/server` to expose `createUploadUrl` safely. Signed URLs need `@aws-sdk/s3-request-presigner`.

## CloudFront

```typescript
new S3Provider({ region: 'us-east-1', bucket: 'media', publicUrl: 'https://d111111abcdef8.cloudfront.net' });
```

## Upload with Progress

```typescript
const result = await uploader.upload(file, {
  folder: 'uploads',
  onProgress: (percent) => {
    console.log(`Upload progress: ${percent}%`);
  }
});
```

## Batch Uploads

Upload multiple files with concurrency control:

```typescript
const results = await uploader.uploadMultiple(files, {
  folder: 'batch-uploads',
  concurrency: 5,
  onBatchProgress: (completed, total) => {
    console.log(`Uploaded ${completed}/${total} files`);
  }
});
```

## Delete Files

```typescript
// Delete single file
await uploader.delete(result.id);

// Delete multiple files
await uploader.deleteMultiple(['file1', 'file2', 'file3']);
```

## Native SDK Access

Access the underlying AWS S3 client for advanced operations:

```typescript
const s3Client = await (uploader.provider as S3Provider).getClient();

// Use native AWS SDK methods
const { ListBucketsCommand } = await import('@aws-sdk/client-s3');
const buckets = await s3Client.send(new ListBucketsCommand({}));
```

## S3-Compatible Services

Works with DigitalOcean Spaces, MinIO, and other S3-compatible services:

```typescript
// DigitalOcean Spaces
const uploader = new MediaUploader(
  new S3Provider({
    region: 'nyc3',
    bucket: 'my-space',
    accessKeyId: 'your-key',
    secretAccessKey: 'your-secret',
    endpoint: 'https://nyc3.digitaloceanspaces.com'
  })
);

// MinIO (self-hosted)
const uploader = new MediaUploader(
  new S3Provider({
    region: 'us-east-1',
    bucket: 'my-bucket',
    accessKeyId: 'minio-key',
    secretAccessKey: 'minio-secret',
    endpoint: 'http://localhost:9000',
    forcePathStyle: true
  })
);

// Backblaze B2
new S3Provider({
  region: 'us-west-004',
  bucket: 'my-bucket',
  accessKeyId: process.env.B2_KEY_ID,
  secretAccessKey: process.env.B2_APPLICATION_KEY,
  endpoint: 'https://s3.us-west-004.backblazeb2.com',
});

// Supabase Storage (S3 protocol)
new S3Provider({
  region: 'us-east-1',
  bucket: 'media',
  accessKeyId: process.env.SUPABASE_S3_KEY_ID,
  secretAccessKey: process.env.SUPABASE_S3_SECRET,
  endpoint: 'https://<project-ref>.supabase.co/storage/v1/s3',
  forcePathStyle: true,
});
```

## Environment Variables

```bash
AWS_ACCESS_KEY_ID=your-access-key
AWS_SECRET_ACCESS_KEY=your-secret-key
AWS_REGION=us-east-1
S3_BUCKET=my-bucket
```

## License

MIT
