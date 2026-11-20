# @fluxmedia/r2

Cloudflare R2 provider for FluxMedia - unified media uploads with cost-effective R2 storage.

## Installation

```bash
pnpm add @fluxmedia/core @fluxmedia/r2 @aws-sdk/client-s3 @aws-sdk/lib-storage
```

R2 uses the S3-compatible API, so it requires the AWS SDK.

## Quick Start

```typescript
import { MediaUploader } from '@fluxmedia/core';
import { R2Provider } from '@fluxmedia/r2';

const uploader = new MediaUploader(
  new R2Provider({
    accountId: 'your-cloudflare-account-id',
    bucket: 'my-bucket',
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    publicUrl: 'https://cdn.example.com' // Optional custom domain
  })
);

const result = await uploader.upload(file, {
  folder: 'uploads'
});

console.log(result.url);
```

## Why R2?

- **Zero egress fees** - Free outbound data transfer
- **S3-compatible** - Easy migration from S3
- **Global distribution** - Cloudflare's edge network
- **Cost-effective** - Only pay for storage and operations

## Configuration

```typescript
interface R2Config {
  accountId?: string;       // Cloudflare account ID
  endpoint?: string;        // Custom endpoint (alternative to accountId)
  bucket: string;           // R2 bucket name
  accessKeyId: string;      // R2 Access Key
  secretAccessKey: string;  // R2 Secret Key
  publicUrl?: string;       // Public base URL; omit for private buckets
}
```

> **Note:** Provide either `accountId` or `endpoint`. The endpoint will be auto-generated from accountId if not provided.

### Private buckets and signed URLs

`publicUrl` is optional. Leave it unset when the bucket is private and files are served through short-lived signed URLs. In that case `result.publicUrl` is omitted, and `result.url` / `getUrl()` return the storage endpoint URL, which identifies the object but is only readable with a signed request. Keep `result.storageKey` and sign it when you need to serve the file.

## Getting R2 Credentials

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com) → R2
2. Create a bucket
3. Click "Manage R2 API Tokens"
4. Create a token with read/write permissions
5. Copy the Access Key ID and Secret Access Key

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

Access the underlying S3-compatible client for advanced operations:

```typescript
const client = await (uploader.provider as R2Provider).getClient();

// Use native AWS SDK methods with R2
const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
const objects = await client.send(new ListObjectsV2Command({
  Bucket: 'my-bucket'
}));
```

`R2Provider` is an `S3Provider` configured for R2, so it also has `getSignedUrl`, `createUploadUrl` (content type and size are signed), `list`, `copy`, `move`, `download` and `updateMetadata`. For EU or FedRAMP buckets, set `jurisdiction: 'eu' | 'fedramp'`.

## Cloudflare Workers (bucket bindings)

In a Worker, use the R2 binding directly — no AWS SDK and no credentials:

```typescript
import { MediaUploader } from '@fluxmedia/core';
import { R2BindingProvider } from '@fluxmedia/r2';

export default {
  async fetch(request: Request, env: Env) {
    const uploader = new MediaUploader(
      new R2BindingProvider({
        bucket: env.MEDIA,
        // Optional: signed links served by your own Worker route
        signedUrlBase: 'https://media.example.com/files',
        signingSecret: env.MEDIA_SECRET,
      })
    );
    const result = await uploader.upload(request.body!, { contentType: 'image/png' });
    return Response.json(result);
  },
};
```

Bindings cannot presign URLs, so `getSignedUrl()` returns an HMAC-signed link to your route; check it there with `verifySignedUrl()` from `@fluxmedia/core`. Streams must have a known length (a request body with `Content-Length`, or a `FixedLengthStream`).

## Adding Transformations

R2 is storage-only. For image transformations, use [Cloudflare Images](https://developers.cloudflare.com/images/) or consider [Cloudinary](https://www.fluxmedia.dev/docs/cloudinary) for built-in support.

## Environment Variables

```bash
CLOUDFLARE_ACCOUNT_ID=your-account-id
R2_BUCKET=my-bucket
R2_ACCESS_KEY_ID=your-access-key
R2_SECRET_ACCESS_KEY=your-secret-key
# Optional: omit for a private bucket
R2_PUBLIC_URL=https://cdn.example.com
```

## License

MIT
