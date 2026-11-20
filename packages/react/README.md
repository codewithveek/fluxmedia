# @fluxmedia/react

React hooks and components for [FluxMedia](https://www.fluxmedia.dev) uploads.

## Installation

```bash
pnpm add @fluxmedia/react @fluxmedia/core
```

## Hooks

### useMediaUpload

```tsx
import { useMediaUpload } from '@fluxmedia/react';

function AvatarUpload() {
  const { upload, cancel, uploading, progress, result, error } = useMediaUpload({
    mode: 'signed',
    signUrlEndpoint: '/api/upload/sign',
    accept: ['image/jpeg', 'image/png', 'image/webp'], // client-side check
    maxSize: 5 * 1024 * 1024,
    headers: async () => ({ authorization: `Bearer ${await getToken()}` }),
  });

  return (
    <div>
      <input
        type="file"
        onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
        disabled={uploading}
      />
      {uploading && (
        <>
          <progress value={progress} max={100} />
          <button onClick={cancel}>Cancel</button>
        </>
      )}
      {result?.publicUrl && <img src={result.publicUrl} alt="" />}
      {error && <p role="alert">{error.message}</p>}
    </div>
  );
}
```

Errors are `UploadClientError`s with a `kind` (`'validation' | 'aborted' | 'network' | 'server' | 'config'`) and, for server errors, the HTTP `status` and the server's error message.

`detectFileType(file)` reads only the first 4 KB of a file to identify it by magic bytes; it works in the browser without a `Buffer` polyfill.

### useMediaUploadQueue

Many files with per-file status, progress, cancel and retry:

```tsx
import { useMediaUploadQueue } from '@fluxmedia/react';

function Gallery() {
  const queue = useMediaUploadQueue(
    { mode: 'signed', signUrlEndpoint: '/api/upload/sign', accept: 'image/*' },
    { concurrency: 3 }
  );

  return (
    <>
      <input type="file" multiple onChange={(e) => e.target.files && queue.add(e.target.files)} />
      <p>Overall: {queue.progress}%</p>
      {queue.items.map((item) => (
        <div key={item.id}>
          {item.file.name}: {item.status} {item.progress}%
          {item.status === 'uploading' && <button onClick={() => queue.cancel(item.id)}>Cancel</button>}
          {item.status === 'error' && <button onClick={() => queue.retry(item.id)}>Retry</button>}
        </div>
      ))}
    </>
  );
}
```

Files that fail `accept` or `maxSize` are added with status `'error'` without contacting the server.

## Components

### MediaUpload

A file dialog and drop target with a render prop:

```tsx
import { MediaUpload } from '@fluxmedia/react';

<MediaUpload
  config={{ mode: 'signed', signUrlEndpoint: '/api/upload/sign' }}
  accept="image/*"
  maxSize={10 * 1024 * 1024}
  onComplete={(results) => console.log(results)}
  onError={(error) => console.error(error)}
>
  {({ getRootProps, isDragging, openFileDialog, uploading, progress, cancel }) => (
    <div {...getRootProps()} data-dragging={isDragging}>
      <button type="button" onClick={openFileDialog} disabled={uploading}>
        {uploading ? `Uploading ${progress}%` : 'Choose or drop a file'}
      </button>
      {uploading && <button onClick={cancel}>Cancel</button>}
    </div>
  )}
</MediaUpload>
```

## Upload Modes

### Signed (recommended)

The browser asks your server for a signed target, then uploads straight to storage. Use `createSignedUploadHandler` from `@fluxmedia/core/server` for the endpoint: it authenticates the request, checks type and size, and decides the folder on the server.

```typescript
// app/api/upload/sign/route.ts
import { createSignedUploadHandler } from '@fluxmedia/core/server';

export const POST = createSignedUploadHandler(uploader, {
  authorize: (request) => getSessionUser(request),
  allowedTypes: ['image/jpeg', 'image/png', 'image/webp'],
  maxSize: 10 * 1024 * 1024,
  folder: (user) => `users/${user.id}`,
});
```

The hook sends `{ filename, contentType, size }` and handles both `PUT` targets (S3, R2, GCS, Azure) and `POST` form targets (Cloudinary). Your storage needs a CORS rule that allows your origin to `PUT`/`POST` with the `Content-Type` header.

### Proxy

The file goes through your server (plugins run there). Use `createProxyUploadHandler`:

```tsx
const { upload } = useMediaUpload({ mode: 'proxy', proxyEndpoint: '/api/upload' });
```

### Direct

Not supported: it would need storage credentials in the browser. `mode: 'direct'` rejects with an explanation.

## Configuration Options

```typescript
interface UseMediaUploadConfig {
  mode: 'signed' | 'proxy';
  signUrlEndpoint?: string;
  proxyEndpoint?: string;
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
  credentials?: RequestCredentials; // default 'same-origin'
  accept?: string | string[];       // MIME types, wildcards or extensions
  maxSize?: number;
  defaultOptions?: { folder?: string; tags?: string[] };
  onUploadStart?: () => void;
  onUploadComplete?: (result: UploadResult) => void;
  onUploadError?: (error: Error) => void;
}
```

Client-side checks are for quick feedback only; the server handlers enforce the real limits.

## License

MIT
