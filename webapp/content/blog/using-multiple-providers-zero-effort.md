---
title: Using Multiple Providers with Zero Effort
date: '2026-02-05'
excerpt: Learn how FluxMedia's unified API lets you use S3, Cloudinary, and R2 together in the same application.
author: FluxMedia Team
tags: ['providers', 'multi-cloud', 'tutorial']
---

# Using Multiple Providers Together

Modern applications often benefit from using multiple cloud providers side by side — Cloudinary for image optimization, S3 for archival storage, R2 for cost-effective delivery. FluxMedia makes this straightforward by giving every provider the same interface.

## The Problem

Each provider has its own SDK with its own conventions:

```typescript
// AWS S3
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
const client = new S3Client({ region: 'us-east-1', credentials: {...} });
await client.send(new PutObjectCommand({ Bucket: '...', Key: '...', Body: file }));

// Cloudinary — completely different API
import { v2 as cloudinary } from 'cloudinary';
cloudinary.config({ cloud_name: '...', api_key: '...', api_secret: '...' });
await cloudinary.uploader.upload(file, { folder: '...' });
```

If your application uses multiple providers, you end up learning and maintaining two (or more) different sets of upload logic. FluxMedia gives you one interface for all of them.

## One Interface, Many Providers

With FluxMedia, your upload code is consistent regardless of which provider handles the file:

```typescript
// Your upload logic — works identically with any provider
async function uploadFile(uploader: MediaUploader, file: File) {
  const result = await uploader.upload(file, {
    folder: 'uploads',
    metadata: { type: 'user-upload' },
  });
  return result.url;
}
```

Configure different uploaders for different use cases:

```typescript
// Cloudinary for media assets (transformations, CDN)
const cloudinaryUploader = new MediaUploader(
  new CloudinaryProvider({
    cloudName: process.env.CLOUDINARY_CLOUD,
    apiKey: process.env.CLOUDINARY_KEY,
    apiSecret: process.env.CLOUDINARY_SECRET,
  })
);

// S3 for long-term archives
const s3Uploader = new MediaUploader(
  new S3Provider({
    region: 'us-east-1',
    bucket: 'my-archive-bucket',
    accessKeyId: process.env.S3_KEY,
    secretAccessKey: process.env.S3_SECRET,
  })
);

// R2 for bandwidth-friendly video delivery
const r2Uploader = new MediaUploader(
  new R2Provider({
    accountId: process.env.R2_ACCOUNT,
    bucket: process.env.R2_BUCKET,
    accessKeyId: process.env.R2_KEY,
    secretAccessKey: process.env.R2_SECRET,
  })
);

// Same function works with all three
await uploadFile(cloudinaryUploader, imageFile);
await uploadFile(s3Uploader, archiveFile);
await uploadFile(r2Uploader, videoFile);
```

## Use-Case-Based Provider Selection

A common pattern is choosing the right provider for the right job:

```typescript
function createUploader(useCase: 'media' | 'archive' | 'video') {
  switch (useCase) {
    case 'media':
      return new MediaUploader(new CloudinaryProvider({ ... }));
    case 'archive':
      return new MediaUploader(new S3Provider({ ... }));
    case 'video':
      return new MediaUploader(new R2Provider({ ... }));
  }
}

const mediaUploader = createUploader('media');
const archiveUploader = createUploader('archive');
```

## Fallback Providers

FluxMedia also supports automatic failover. If the primary provider hits an error, the fallback provider takes over seamlessly:

```typescript
import { MediaUploader, MediaErrorCode } from '@fluxmedia/core';

const uploader = new MediaUploader(
  new CloudinaryProvider({ ... }),
  [],
  {
    fallbackProvider: new S3Provider({ ... }),
    fallbackOnErrors: [
      MediaErrorCode.NETWORK_ERROR,
      MediaErrorCode.RATE_LIMITED,
      MediaErrorCode.PROVIDER_ERROR,
    ],
    onFallback: (error, fallback) => {
      console.warn(`Using ${fallback.name} due to: ${error.message}`);
    },
  }
);
```

This adds resilience without any changes to your upload code.

## Feature Detection

Some features are provider-specific, and FluxMedia handles this gracefully with `supports()`:

```typescript
if (uploader.supports('transformations.resize')) {
  // Cloudinary supports on-the-fly transformations
  const url = uploader.getUrl(id, { width: 400, height: 400 });
} else {
  // S3/R2 — serve the original
  const url = uploader.getUrl(id);
}
```

## When to Use Which Provider

| Provider       | Best For                                        |
| -------------- | ----------------------------------------------- |
| **Cloudinary** | Image/video transformations, CDN delivery       |
| **S3**         | General storage, AWS ecosystem integration      |
| **R2**         | Cost savings (no egress fees), edge performance |

The beauty of FluxMedia is that you don't have to pick just one. Use each provider where it shines, with the same clean API everywhere.

## Next Steps

- [Getting Started](/blog/getting-started-with-fluxmedia)
- [Plugin System Deep Dive](/blog/understanding-the-plugin-system)
- [Advanced Uploads: Streaming, Abort & Transactions](/blog/advanced-uploads-streaming-abort-transactions)
- [Full Documentation](/docs)
