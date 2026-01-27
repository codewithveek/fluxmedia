# Next.js Example

This example demonstrates how to use FluxMedia with Next.js App Router.

## Features

- ✅ Signed URL uploads (recommended)
- ✅ Proxy uploads through server
- ✅ Progress tracking
- ✅ Error handling
- ✅ Modern UI with dark theme

## Setup

1. Install dependencies (from root):
```bash
pnpm install
```

2. Build packages:
```bash
pnpm build
```

3. Configure environment:
```bash
cd examples/nextjs-app
cp .env.example .env.local
# Edit .env.local with your Cloudinary credentials
```

4. Run the example:
```bash
pnpm dev
```

5. Open http://localhost:3000

## Upload Modes

### Signed URL (Recommended)

1. Browser requests signed upload parameters from `/api/upload/sign`
2. Server generates signature using API secret (never exposed to client)
3. Browser uploads directly to Cloudinary with signed params

```typescript
const { upload } = useMediaUpload({
  mode: 'signed',
  signUrlEndpoint: '/api/upload/sign'
});
```

### Proxy

1. Browser uploads file to `/api/upload`
2. Server uploads file to Cloudinary using FluxMedia
3. Server returns result to browser

```typescript
const { upload } = useMediaUpload({
  mode: 'proxy',
  proxyEndpoint: '/api/upload'
});
```

## API Routes

- `POST /api/upload/sign` - Generate signed upload parameters
- `POST /api/upload` - Proxy upload through server

## Learn More

- [FluxMedia Documentation](../../packages/core/README.md)
- [React Package](../../packages/react/README.md)
