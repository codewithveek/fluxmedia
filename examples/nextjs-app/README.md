# FluxMedia Next.js Example

Uploads from a Next.js App Router app to Cloudinary, AWS S3 or Cloudflare R2, using the FluxMedia server handlers and React hook.

## Features

- **Multiple providers**: Cloudinary, AWS S3, Cloudflare R2, picked per request (`?provider=`)
- **Signed uploads**: the browser uploads straight to storage with a short-lived target; on S3/R2 the content type and exact size are part of the signature
- **Proxy uploads**: the file goes through the server so plugins run (retry, logging)
- **Server-side rules**: authentication, allowed types (checked from the file's bytes), size limit and destination folder are decided on the server
- **Private buckets**: leave `R2_PUBLIC_URL` unset (or set `AWS_PRIVATE_BUCKET=true`) and read files through `/api/media/url`, which returns 5-minute signed links

## Setup

```bash
pnpm install
cp .env.example .env   # then add your credentials
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

> **Authentication.** `getUser()` in `src/lib/uploaders.ts` accepts every request in development and requires `Authorization: Bearer $UPLOAD_API_TOKEN` in production. Replace it with your real session lookup before deploying.

## Routes

| Route | Purpose |
| --- | --- |
| `POST /api/upload/sign?provider=` | Returns a signed upload target (`createSignedUploadHandler`) |
| `POST /api/upload?provider=` | Receives a multipart upload (`createProxyUploadHandler`) |
| `GET /api/media/url?provider=&key=` | Returns a short-lived read URL for one of the user's own files |

## Client

```tsx
import { useMediaUpload } from '@fluxmedia/react';

const { upload, cancel, uploading, progress, result, error } = useMediaUpload({
  mode: 'signed',
  signUrlEndpoint: '/api/upload/sign?provider=r2',
  accept: ['image/jpeg', 'image/png', 'image/webp'],
  maxSize: 10 * 1024 * 1024,
});
```

## Server

```ts
// app/api/upload/sign/route.ts
import { createSignedUploadHandler } from '@fluxmedia/core/server';

export const POST = createSignedUploadHandler(uploader, {
  authorize: (request) => getUser(request),
  allowedTypes: ['image/jpeg', 'image/png', 'image/webp'],
  maxSize: 10 * 1024 * 1024,
  folder: (user) => `uploads/${user.id}`,
});
```

Storage CORS must allow `PUT` (S3/R2) or `POST` (Cloudinary) from your origin, with the `Content-Type` header.
