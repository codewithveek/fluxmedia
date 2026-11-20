# @fluxmedia/core

Core library for FluxMedia - a unified media upload library for JavaScript and TypeScript.

## Installation

```bash
pnpm add @fluxmedia/core
```

> **Note:** You also need a provider package (e.g., `@fluxmedia/cloudinary`, `@fluxmedia/s3`, `@fluxmedia/r2`)

## Quick Start

```typescript
import { MediaUploader } from '@fluxmedia/core';
import { CloudinaryProvider } from '@fluxmedia/cloudinary';

const uploader = new MediaUploader(
  new CloudinaryProvider({
    cloudName: 'your-cloud',
    apiKey: 'your-key',
    apiSecret: 'your-secret'
  })
);

// Upload a file
const result = await uploader.upload(file, {
  folder: 'avatars',
  transformation: {
    width: 400,
    height: 400,
    fit: 'cover',
    format: 'webp'
  },
  metadata: {
    userId: '12345',
    uploadedAt: new Date().toISOString()
  }
});

console.log(result.url);
```

## MediaUploader API

### Constructor

```typescript
new MediaUploader(provider: MediaProvider, plugins?: FluxMediaPlugin[], config?: {
  fallbackProvider?: MediaProvider;   // used when the primary fails with a retryable error
  fallbackOnErrors?: MediaErrorCode[];
  onFallback?: (error, from, to) => void;
})
```

Constructor plugins are initialized before the first operation; `await uploader.ready()` surfaces a failing `init()` early.

### Methods

Methods that take a file accept its ID or the `UploadResult` from `upload()`. Passing the result routes the call to the provider that stored the file (after a failover) and passes hints the provider needs, such as Cloudinary's resource type.

| Method                                    | Description                                                 |
| ----------------------------------------- | ----------------------------------------------------------- |
| `upload(file, options?)`                  | Upload a single file                                        |
| `uploadMultiple(files, options?)`         | Upload many files (`concurrency`, default 3)                |
| `uploadWithTransaction(file, opts, cbs)`  | Upload, then commit; rolls the upload back if commit throws |
| `delete(ref)` / `deleteMultiple(refs)`    | Delete files (batched where the provider supports it)       |
| `get(ref)` / `exists(ref)`                | File metadata / existence                                   |
| `getUrl(ref, transform?)`                 | URL, optionally transformed                                 |
| `getSignedUrl(ref, options?)`             | Time-limited URL for private files                          |
| `createUploadUrl(options)`                | Signed target for a direct browser upload                   |
| `list(options?)` / `listAll(options?)`    | List files with cursors / iterate over every file           |
| `search(query)`                           | Search (Cloudinary)                                         |
| `copy(ref, toId)` / `move(ref, toId)`     | Copy or rename a file                                       |
| `download(ref)`                           | Stream a file's contents                                    |
| `updateMetadata(ref, metadata)`           | Replace custom metadata                                     |
| `supports(feature)`                       | Check if provider supports a feature                        |

Optional operations throw a `MediaError` with code `NOT_SUPPORTED` when the provider lacks them.

## Upload Options

```typescript
interface UploadOptions {
  filename?: string;           // Custom filename (sanitized)
  folder?: string;             // Destination folder (sanitized; cannot escape the root)
  public?: boolean;            // Visibility, see below
  tags?: string[];             // Tags for organizing
  metadata?: Record<string, unknown>; // only top-level primitives are stored
  onProgress?: (percent: number) => void;
  onByteProgress?: (loaded: number, total: number | undefined) => void;
  transformation?: TransformationOptions;
  uniqueFilename?: boolean;    // Append a random suffix (default: true)
  contentType?: string;        // Required for streams
  cacheControl?: string;
  contentDisposition?: string;
  signal?: AbortSignal;        // Cancel the upload
  providerOptions?: Record<string, unknown>; // native params, e.g. S3 StorageClass
}
```

- **Metadata**: only top-level string, number and boolean values are stored. Keys starting with `_` and nested objects (EXIF, plugin data) stay in-process, so private data never ends up in object headers.
- **`public`**: Cloudinary stores `public: false` uploads as `authenticated`; S3 applies an ACL when configured with `useAcl`. If a bucket cannot honour the request (public on a private bucket, or the reverse), the upload fails instead of silently doing something else.
- **Streams** are uploaded once: they are never retried or sent to a fallback provider.

## Transformations

```typescript
interface TransformationOptions {
  width?: number;
  height?: number;
  quality?: number;            // 0-100
  format?: 'auto' | 'webp' | 'avif' | 'jpg' | 'png';
  fit?: 'cover' | 'contain' | 'fill' | 'inside' | 'outside';
}
```

## Upload Result

```typescript
interface UploadResult {
  id: string;          // Unique file identifier
  storageKey?: string; // Raw provider key
  url: string;         // Storage URL (not readable for private storage)
  publicUrl?: string;  // Public URL (omitted for private storage)
  contentType?: string;
  size: number;        // Size in bytes
  format: string;      // File format
  width?: number;      // Image/video width
  height?: number;     // Image/video height
  provider: string;    // Provider name
  metadata: Record<string, unknown>;
  createdAt: Date;
}
```

## Using Plugins

Extend functionality with plugins:

```typescript
import { createFileValidationPlugin } from '@fluxmedia/plugins';

const uploader = new MediaUploader(provider);

// Add validation
await uploader.use(createFileValidationPlugin({
  maxSize: 10 * 1024 * 1024, // 10MB
  allowedTypes: ['image/*', 'video/mp4']
}));

// Now uploads are validated
await uploader.upload(file);
```

## Browser Uploads (Server Handlers)

`@fluxmedia/core/server` has framework-agnostic handlers built on the Web `Request`/`Response` API (Next.js App Router, Remix, Hono, SvelteKit, Bun, Deno). Both require `authorize`, `allowedTypes` and `maxSize`, and decide the folder on the server.

```typescript
import { createSignedUploadHandler, createProxyUploadHandler } from '@fluxmedia/core/server';

const rules = {
  authorize: async (request: Request) => getSessionUser(request), // return null to answer 401
  allowedTypes: ['image/jpeg', 'image/png', 'image/webp'], // SVG must be listed explicitly
  maxSize: 10 * 1024 * 1024,
  folder: (user: { id: string }) => `users/${user.id}`,
};

// Browser uploads straight to storage
export const signHandler = createSignedUploadHandler(uploader, { ...rules, expiresIn: 300 });

// Browser uploads through your server (plugins run)
export const uploadHandler = createProxyUploadHandler(uploader, rules);
```

- The signed handler takes `{ filename, contentType, size }` and returns a `SignedUploadTarget`. On S3 and R2, the content type and exact size are part of the signature.
- The proxy handler rejects oversized bodies before reading them (`Content-Length` is required) and detects the type from the file's bytes, so a file that claims to be `image/png` but is not gets a 415.
- Unexpected errors are answered with a generic 500; pass `onError` to log them.

## Private Files and Signed URLs

```typescript
const url = await uploader.getSignedUrl(result, { expiresIn: 300, downloadAs: 'report.pdf' });
```

Providers without native signing (local filesystem, R2 bindings, memory) use HMAC-signed URLs. Verify them in your file route:

```typescript
import { verifySignedUrl } from '@fluxmedia/core';

const check = await verifySignedUrl(request.url, { secret: process.env.MEDIA_SECRET!, pathPrefix: '/files' });
if (!check.valid) return new Response('Forbidden', { status: 403 });
```

## In-memory Provider

`MemoryProvider` implements every capability in memory, for tests and local development:

```typescript
import { MediaUploader, MemoryProvider } from '@fluxmedia/core';

const uploader = new MediaUploader(new MemoryProvider());
```

## File Type Detection

Detect file types using magic bytes (more reliable than extensions):

```typescript
import { getFileType, isImage, isVideo } from '@fluxmedia/core';

const type = await getFileType(buffer);
console.log(type); // { mime: 'image/jpeg', ext: 'jpg' }

if (await isImage(buffer)) {
  // Handle image
}

if (await isVideo(buffer)) {
  // Handle video
}
```

## Error Handling

All errors use standardized `MediaErrorCode`:

```typescript
import { MediaError, MediaErrorCode } from '@fluxmedia/core';

try {
  await uploader.upload(file);
} catch (err) {
  if (err instanceof MediaError) {
    console.log(err.code);      // e.g., 'FILE_TOO_LARGE'
    console.log(err.provider);  // e.g., 'cloudinary'
    console.log(err.message);   // Human-readable message
  }
}
```

### Error Codes

| Code                  | Description              |
| --------------------- | ------------------------ |
| `UPLOAD_FAILED`       | General upload failure   |
| `FILE_TOO_LARGE`      | File exceeds size limit  |
| `INVALID_FILE_TYPE`   | Unsupported file type    |
| `NETWORK_ERROR`       | Network or timeout issue |
| `INVALID_CREDENTIALS` | Bad credentials          |
| `UNAUTHORIZED`        | Access denied            |
| `FILE_NOT_FOUND`      | File doesn't exist       |
| `QUOTA_EXCEEDED`      | Storage quota reached    |
| `RATE_LIMITED`        | Throttled by the provider |
| `PROVIDER_ERROR`      | Provider-side failure (5xx) |
| `INVALID_CONFIG`      | Bad configuration or unsafe key |
| `DELETE_FAILED`       | Delete failed (`details.failedIds` for batches) |
| `ABORTED`             | Cancelled through an `AbortSignal` |
| `NOT_SUPPORTED`       | The provider lacks this operation |

## Feature Detection

Check what your provider supports:

```typescript
// Transformation features
uploader.supports('transformations.resize');
uploader.supports('transformations.blur');

// Capabilities
uploader.supports('capabilities.aiTagging');
uploader.supports('capabilities.videoProcessing');
```

## License

MIT
