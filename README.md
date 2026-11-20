# FluxMedia

<p align="left">
  <img src="./webapp/public/fluxmedia-logo.svg" alt="FluxMedia logo" width="260" />
</p>

**One API for all your media uploads.**

A unified, TypeScript-first media library for modern applications. Upload to Cloudinary, AWS S3, Cloudflare R2, Google Cloud Storage, Azure Blob Storage or the local filesystem with a single interface.

## Features

- **Unified API** - Write once, use any provider
- **Secure browser uploads** - Server handlers that authenticate, check type (by content) and size, and choose the folder on the server; signed upload URLs that enforce content type and size on S3/R2
- **Private files** - Optional public URLs, time-limited signed download URLs on every provider
- **File operations** - Upload, get, delete (batched), list with cursors, copy, move, download streams, metadata updates
- **Reliable** - Cancel with `AbortSignal`, retry with backoff, provider failover, transactional uploads
- **Type-safe** - Full TypeScript support with intelligent autocomplete
- **React integration** - Hooks for single files and queues, drag-and-drop component
- **Extensible** - Plugin system (validation, optimization, virus scanning, dedupe, placeholders…) and native SDK access
- **Lightweight** - SDKs are peer dependencies and load lazily

## Quick Start

```bash
# Install core + provider
pnpm add @fluxmedia/core @fluxmedia/cloudinary cloudinary
```

```typescript
import { MediaUploader } from '@fluxmedia/core';
import { CloudinaryProvider } from '@fluxmedia/cloudinary';

const uploader = new MediaUploader(
  new CloudinaryProvider({
    cloudName: 'your-cloud',
    apiKey: 'your-key',
    apiSecret: 'your-secret',
  })
);

const result = await uploader.upload(file, {
  folder: 'avatars',
  transformation: {
    width: 400,
    height: 400,
    fit: 'cover',
    format: 'webp',
  },
});

console.log(result.url);
```

## Packages

| Package                                        | Description                                                 |
| ---------------------------------------------- | ----------------------------------------------------------- |
| [@fluxmedia/core](./packages/core)             | Core API, server handlers, in-memory provider, signing      |
| [@fluxmedia/cloudinary](./packages/cloudinary) | Cloudinary provider                                         |
| [@fluxmedia/s3](./packages/s3)                 | AWS S3 and S3-compatible storage (MinIO, B2, Wasabi, …)     |
| [@fluxmedia/r2](./packages/r2)                 | Cloudflare R2 (S3 API, or Workers bucket bindings)          |
| [@fluxmedia/gcs](./packages/gcs)               | Google Cloud Storage                                        |
| [@fluxmedia/azure](./packages/azure)           | Azure Blob Storage                                          |
| [@fluxmedia/local](./packages/local)           | Local filesystem (development, self-hosting)                |
| [@fluxmedia/plugins](./packages/plugins)       | Official plugins                                            |
| [@fluxmedia/react](./packages/react)           | React hooks and components                                  |

## Why FluxMedia?

### Unified API Across Providers

```typescript
const uploader = new MediaUploader(new CloudinaryProvider({ ... }));
// or new S3Provider, R2Provider, GCSProvider, AzureBlobProvider, LocalProvider, MemoryProvider

const result = await uploader.upload(file);
await uploader.getSignedUrl(result, { expiresIn: 300 });
await uploader.delete(result);
```

### Secure Browser Uploads

The browser uploads straight to storage; your server only signs the request after checking who is uploading and what:

```typescript
// app/api/upload/sign/route.ts (Next.js, Remix, Hono, Bun, …)
import { createSignedUploadHandler } from '@fluxmedia/core/server';

export const POST = createSignedUploadHandler(uploader, {
  authorize: (request) => getSessionUser(request), // required
  allowedTypes: ['image/jpeg', 'image/png', 'image/webp'],
  maxSize: 10 * 1024 * 1024,
  folder: (user) => `users/${user.id}`, // decided on the server
});
```

On S3 and R2 the content type and exact byte size are part of the signature, so storage rejects any other file. `createProxyUploadHandler` does the same for uploads that go through your server, detecting the type from the file's bytes.

### Private Files

Public URLs are optional. Leave them off for private buckets and hand out short-lived links:

```typescript
const provider = new R2Provider({ accountId, bucket, accessKeyId, secretAccessKey }); // no publicUrl
const result = await uploader.upload(file);           // result.publicUrl is undefined
const url = await uploader.getSignedUrl(result, { expiresIn: 300 });
```

## Examples

- [Basic Node.js](./examples/basic-node) - All providers, plugins, and core features
- [Next.js App](./examples/nextjs-app) - Signed and proxy uploads with authentication and private files

## React Integration

```bash
pnpm add @fluxmedia/react
```

```tsx
import { useMediaUpload } from '@fluxmedia/react';

function UploadButton() {
  const { upload, cancel, uploading, progress, error, result } = useMediaUpload({
    mode: 'signed',
    signUrlEndpoint: '/api/upload/sign',
    accept: ['image/*'],
    maxSize: 10 * 1024 * 1024,
  });

  return (
    <div>
      <input
        type="file"
        onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
        disabled={uploading}
      />
      {uploading && <progress value={progress} max={100} />}
      {uploading && <button onClick={cancel}>Cancel</button>}
      {result?.publicUrl && <img src={result.publicUrl} alt="Uploaded" />}
      {error && <div>Error: {error.message}</div>}
    </div>
  );
}
```

`useMediaUploadQueue` handles many files with per-file progress, cancel and retry; `<MediaUpload>` adds drag-and-drop.

## Plugins

```bash
pnpm add @fluxmedia/plugins
```

- **File Validation** - Types (detected from content), sizes, extensions; SVG must be allowed explicitly
- **Image Optimization** - Resize, re-encode and strip EXIF/GPS (requires sharp)
- **Metadata Extraction** - Dimensions, EXIF (GPS opt-in), hashing
- **Virus Scanning** - Any scanner, or the built-in ClamAV client
- **Deduplication** - Skip re-uploading identical content within a folder
- **Placeholders** - Blurred preview data URI and dominant color
- **Analytics** - Logging and tracking with typed events
- **Retry** - Automatic retry with exponential backoff and jitter

## Provider Feature Comparison

| Feature                  | Cloudinary | S3  | R2  | GCS | Azure | Local |
| ------------------------ | ---------- | --- | --- | --- | ----- | ----- |
| Image Transformations    | Yes        | No  | No  | No  | No    | No    |
| Video Processing         | Yes        | No  | No  | No  | No    | No    |
| Signed download URLs     | Yes        | Yes | Yes | Yes | Yes   | Yes   |
| Signed browser uploads   | Yes        | Yes | Yes | Yes | Yes   | No    |
| Size/type in signature   | Type only  | Yes | Yes | Yes | No    | -     |
| List / copy / move       | Yes        | Yes | Yes | Yes | Yes   | Yes   |
| Search                   | Yes        | No  | No  | No  | No    | No    |
| Multipart / resumable    | Yes        | Yes | Yes | Yes | Yes   | -     |

## Development

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run tests
pnpm test

# Lint
pnpm lint
```

S3 integration tests run against LocalStack when `S3_INTEGRATION_ENDPOINT` is set (see `packages/s3/src/__tests__/integration.test.ts`).

## Contributing

We welcome contributions! Please see [CONTRIBUTING.md](./CONTRIBUTING.md) for details.

## License

MIT © FluxMedia Contributors

---

**Built with TypeScript**
