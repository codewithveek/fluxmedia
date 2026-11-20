# @fluxmedia/local

Local filesystem provider for [FluxMedia](https://www.fluxmedia.dev). Use it for development, tests, self-hosting and single-server deployments.

```bash
pnpm add @fluxmedia/core @fluxmedia/local
```

```typescript
import { MediaUploader } from '@fluxmedia/core';
import { LocalProvider } from '@fluxmedia/local';

const uploader = new MediaUploader(
  new LocalProvider({
    root: './uploads', // created if missing
    baseUrl: '/media', // where you serve the files
    signingSecret: process.env.MEDIA_SECRET, // 32+ chars, for getSignedUrl()
  })
);

const result = await uploader.upload(buffer, { folder: 'avatars', filename: 'me' });
// result.id === 'avatars/me-x1y2z3a4.png'
```

- Writes are atomic (temp file + rename) and cancellable with `signal`.
- Keys are sanitized and every path is checked to stay inside `root`.
- Metadata is stored in `root/.fluxmedia-meta/`.
- Supports `get`, `delete`, `list`, `copy`, `move`, `download`, `updateMetadata` and `getSignedUrl`.

## Serving files

`createLocalFileHandler` serves files from a Web `Request` handler. It sends `X-Content-Type-Options: nosniff` and a sandboxing `Content-Security-Policy`, so uploaded HTML or SVG cannot run scripts on your origin.

```typescript
// app/media/[...key]/route.ts
import { createLocalFileHandler } from '@fluxmedia/local';

export const GET = createLocalFileHandler(provider, { pathPrefix: '/media' });
```

With `private: true`, results have no `publicUrl` and the handler only serves valid, unexpired signed URLs from `getSignedUrl()`.

## Configuration

| Option            | Type    | Description                                              |
| ----------------- | ------- | -------------------------------------------------------- |
| `root`            | string  | Storage directory (required)                             |
| `baseUrl`         | string  | Base URL used by `getUrl()` (required)                   |
| `private`         | boolean | Omit `publicUrl`; require signatures in the file handler |
| `signingSecret`   | string  | 32+ character secret for signed URLs                     |
| `appendExtension` | boolean | Append the detected extension to keys (default `true`)   |
