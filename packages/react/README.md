# @fluxmedia/react

React hooks and components for FluxMedia - unified media upload components.

## Installation

```bash
pnpm add @fluxmedia/core @fluxmedia/react
```

## Hooks

### useMediaUpload

```tsx
import { useMediaUpload } from '@fluxmedia/react';

function UploadButton() {
  const { upload, uploading, progress, error, result } = useMediaUpload({
    mode: 'signed',
    signUrlEndpoint: '/api/media/sign'
  });

  return (
    <div>
      <input
        type="file"
        onChange={(e) => upload(e.target.files?.[0]!)}
        disabled={uploading}
      />
      {uploading && <progress value={progress} max={100} />}
      {result && <img src={result.url} alt="Uploaded" />}
      {error && <div>Error: {error.message}</div>}
    </div>
  );
}
```

## Components

### MediaUpload

```tsx
import { MediaUpload } from '@fluxmedia/react';

function FileUploader() {
  return (
    <MediaUpload
      config={{ mode: 'signed', signUrlEndpoint: '/api/media/sign' }}
      accept="image/*"
      maxSize={5 * 1024 * 1024} // 5MB
      onComplete={(results) => console.log('Uploaded:', results)}
      onError={(error) => console.error('Error:', error)}
    >
      {({ uploading, progress, openFileDialog }) => (
        <button onClick={openFileDialog} disabled={uploading}>
          {uploading ? `Uploading ${progress}%` : 'Upload Image'}
        </button>
      )}
    </MediaUpload>
  );
}
```

## Upload Modes

### 1. Signed Upload (Recommended)

Browser gets a signed URL from your server, then uploads directly to the provider.

```tsx
const { upload } = useMediaUpload({
  mode: 'signed',
  signUrlEndpoint: '/api/media/sign'
});
```

Server endpoint example (Next.js):

```typescript
// app/api/media/sign/route.ts
import { CloudinaryProvider } from '@fluxmedia/cloudinary';

export async function POST(request: Request) {
  const { filename, folder } = await request.json();
  
  // Generate signed upload params
  const timestamp = Math.round(Date.now() / 1000);
  const signature = cloudinary.utils.api_sign_request({
    timestamp,
    folder,
    public_id: filename
  }, process.env.CLOUDINARY_API_SECRET);

  return Response.json({
    uploadUrl: `https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/auto/upload`,
    fields: {
      api_key: process.env.CLOUDINARY_API_KEY,
      timestamp,
      signature,
      folder,
      public_id: filename
    }
  });
}
```

### 2. Proxy Upload

Upload goes through your server (full control, may be slower).

```tsx
const { upload } = useMediaUpload({
  mode: 'proxy',
  proxyEndpoint: '/api/media/upload'
});
```

### 3. Direct Upload

Upload directly from browser (requires exposing provider credentials - **not recommended for production**).

## Configuration Options

```typescript
interface UseMediaUploadConfig {
  mode: 'direct' | 'signed' | 'proxy';
  signUrlEndpoint?: string;
  proxyEndpoint?: string;
  defaultOptions?: {
    folder?: string;
    tags?: string[];
    transformation?: TransformationOptions;
  };
  onUploadStart?: () => void;
  onUploadComplete?: (result: UploadResult) => void;
  onUploadError?: (error: Error) => void;
}
```

## License

MIT
