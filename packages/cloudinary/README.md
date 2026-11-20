# @fluxmedia/cloudinary

Cloudinary provider for FluxMedia - unified media uploads with full-featured management (transformations, AI tagging, etc).

## Installation

```bash
pnpm add @fluxmedia/core @fluxmedia/cloudinary cloudinary
```

## Quick Start

```typescript
import { MediaUploader } from '@fluxmedia/core';
import { CloudinaryProvider } from '@fluxmedia/cloudinary';

const uploader = new MediaUploader(
  new CloudinaryProvider({
    cloudName: 'your-cloud-name',
    apiKey: process.env.CLOUDINARY_API_KEY,
    apiSecret: process.env.CLOUDINARY_API_SECRET
  })
);

// Upload with transformations
const result = await uploader.upload(file, {
  folder: 'products',
  transformation: {
    width: 800,
    height: 600,
    fit: 'cover',
    format: 'webp',
    quality: 80
  }
});

console.log(result.url);
```

## Features

Cloudinary supports all FluxMedia features:

- **Image transformations** - resize, crop, format, quality
- **Advanced effects** - blur, rotate, filters
- **Video processing** - transcoding, thumbnails
- **AI features** - tagging, facial detection
- **Batch operations** - with progress tracking

## Configuration

```typescript
interface CloudinaryConfig {
  cloudName: string;   // Your Cloudinary cloud name
  apiKey: string;      // API key from dashboard
  apiSecret: string;   // API secret (keep secure!)
  secure?: boolean;    // Use HTTPS (default: true)
  authTokenKey?: string; // Token-based auth key: expiring URLs with transformations
  secureDistribution?: string; // Custom delivery domain (CNAME / private CDN)
}
```

Credentials are sent with each request instead of through the global `cloudinary.config()`, so several providers for different accounts can run in one process.

## Private Assets and Signed URLs

```typescript
// Stored as "authenticated": no public URL, readable only through signed URLs
const result = await uploader.upload(file, { public: false });

// Expiring link. Pass the result so the provider knows the resource type.
const url = await uploader.getSignedUrl(result, { expiresIn: 600 });
```

For `authenticated` assets, signed URLs use Cloudinary's private download API (original file, real expiry), or, with `authTokenKey` (Advanced plans), token-authenticated delivery URLs that also support `transform`. Public (`upload`) assets are readable by anyone, so `getSignedUrl` returns their normal delivery URL. Pass the `UploadResult` to avoid an Admin API lookup of the asset's type and format.

`createUploadUrl()` returns signed form fields for a direct browser upload. The signature fixes the public ID, tags, context, delivery type and allowed formats; it cannot cap the file size, so use an upload preset with limits (or the proxy handler) when size matters.

## Videos, Raw Files and Deletes

Pass the `UploadResult` (or `{ metadata: { resourceType: 'video' } }`) to `delete`, `get`, `getUrl` and `move` so the right resource type is used. With only an ID, the provider tries image, video and raw in turn.

## Advanced Usage

### Access Native Cloudinary Client

```typescript
const cloudinary = uploader.provider.native; // null until the first request

// The global config is not set; pass credentials with each call
await cloudinary.uploader.explicit('sample', {
  cloud_name: 'my-cloud',
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  type: 'upload',
  eager: [{ effect: 'sepia' }],
});
```

### Check Feature Support

```typescript
if (uploader.supports('transformations.blur')) {
  // Cloudinary supports blur
}
```

## Examples

### Upload with tags

```typescript
const result = await uploader.upload(file, {
  folder: 'avatars',
  tags: ['user', 'profile'],
  transformation: {
    width: 400,
    height: 400,
    fit: 'cover',
    quality: 80,
    format: 'webp'
  },  metadata: {
    userId: '12345',
    uploadedAt: new Date().toISOString()
  }
});
```

## Generate Transformed URLs

```typescript
// Single transformation
const thumbnail = uploader.getUrl(result.id, {
  width: 150,
  height: 150,
  fit: 'cover',
  format: 'webp'
});

// Responsive sizes
const sizes = {
  small: uploader.getUrl(id, { width: 100 }),
  medium: uploader.getUrl(id, { width: 400 }),
  large: uploader.getUrl(id, { width: 800 })
};
```

## Batch Uploads

```typescript
const results = await uploader.uploadMultiple(files, {
  folder: 'batch-upload',
  concurrency: 5,
  onBatchProgress: (completed, total) => {
    console.log(`Uploaded ${completed}/${total} files`);
  }
});
```

## Delete Files

```typescript
// Pass the upload result so the resource type (image, video, raw) is known
await uploader.delete(result);

// With only an ID, give the resource type (otherwise image, video and raw are tried in turn)
await uploader.delete(videoId, { metadata: { resourceType: 'video' } });

// Delete multiple files
await uploader.deleteMultiple(['id1', 'id2', 'id3']);
```

## Search

```typescript
const results = await uploader.search({ query: 'shoe', folder: 'products', tags: ['summer'] });
const page = await uploader.list({ folder: 'products', limit: 50 });
```

Both use the Search API, which indexes new uploads asynchronously. For native SDK access, see [Advanced Usage](#advanced-usage).

## Check Feature Support

```typescript
if (uploader.supports('transformations.blur')) {
  // Apply blur effect
}

if (uploader.supports('capabilities.aiTagging')) {
  // Use AI tagging
}
```

## Environment Variables

```bash
CLOUDINARY_CLOUD_NAME=your-cloud-name
CLOUDINARY_API_KEY=your-api-key
CLOUDINARY_API_SECRET=your-api-secret
```

## Provider Switching

The beauty of FluxMedia is that you can switch providers without changing your code:

```typescript
// Before: Cloudinary
import { CloudinaryProvider } from '@fluxmedia/cloudinary';
const uploader = new MediaUploader(new CloudinaryProvider({ ... }));

// After: S3 (same upload code!)
import { S3Provider } from '@fluxmedia/s3';
const uploader = new MediaUploader(new S3Provider({ ... }));

// Your upload code stays exactly the same
await uploader.upload(file, { folder: 'uploads' });
```

## License

MIT
