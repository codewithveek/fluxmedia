# @fluxmedia/plugins

Official plugins for FluxMedia - extend your unified media upload pipeline with validation, optimization, analytics, and retry functionality.

## Installation

```bash
pnpm add @fluxmedia/plugins

# For image optimization:
pnpm add sharp
```

## Using Plugins

```typescript
import { MediaUploader } from '@fluxmedia/core';
import { 
  createFileValidationPlugin,
  createAnalyticsPlugin 
} from '@fluxmedia/plugins';

const uploader = new MediaUploader(provider);

// Add validation plugin
await uploader.use(createFileValidationPlugin({
  maxSize: 10 * 1024 * 1024,
  allowedTypes: ['image/*']
}));

// Add analytics plugin
await uploader.use(createAnalyticsPlugin({
  logLevel: 'info'
}));

// Uploads are now validated and logged
await uploader.upload(file);
```

## Available Plugins

### File Validation

Validates files before upload based on type, size, and extension.

```typescript
import { createFileValidationPlugin } from '@fluxmedia/plugins';

const plugin = createFileValidationPlugin({
  allowedTypes: ['image/*', 'video/mp4'],
  maxSize: 10 * 1024 * 1024, // 10MB
  minSize: 1024,             // 1KB minimum
  blockedExtensions: ['.exe', '.bat'],
  allowedExtensions: ['.jpg', '.png', '.webp'],
  useMagicBytes: true,       // Detect type from content (default)
  customValidator: async (file, filename) => {
    // Custom validation logic
    return true;
  },
  onValidationFailed: (error) => {
    console.log(`Validation failed: ${error.message}`);
  }
});
```

**Options:**
| Option               | Type       | Description                                            |
| -------------------- | ---------- | ------------------------------------------------------ |
| `allowedTypes`       | `string[]` | Allowed MIME types (supports wildcards like `image/*`) |
| `maxSize`            | `number`   | Maximum file size in bytes                             |
| `minSize`            | `number`   | Minimum file size in bytes                             |
| `allowedExtensions`  | `string[]` | Allowed file extensions                                |
| `blockedExtensions`  | `string[]` | Blocked file extensions                                |
| `useMagicBytes`      | `boolean`  | Detect the type from content (default: true)           |
| `customValidator`    | `function` | Custom validation function                             |
| `onValidationFailed` | `function` | Callback when validation fails                         |

- The type comes from the file's bytes. A declared type is trusted only for formats without a signature (text, CSV, JSON, SVG), so an HTML file named `photo.png` is rejected.
- `image/*` does not match SVG, which can contain scripts; list `image/svg+xml` explicitly to allow it.
- Extensions are compared case-insensitively, against both the filename and the detected type.
- Streams are validated against `options.contentType` (required when `allowedTypes` is set), and `maxSize` is enforced while the stream is read.

### Image Optimization (Server-side)

Optimizes images using sharp before upload. Requires `sharp` as a peer dependency.

```typescript
import { createImageOptimizationPlugin } from '@fluxmedia/plugins';

const plugin = createImageOptimizationPlugin({
  maxWidth: 2000,
  maxHeight: 2000,
  quality: 0.85,
  format: 'webp',
  stripMetadata: true,
  autoOrient: true,
  preserveAspectRatio: true,
});
```

**Options:**
| Option                | Type      | Description                                          |
| --------------------- | --------- | ---------------------------------------------------- |
| `maxWidth`            | `number`  | Maximum width in pixels (default: 2000)              |
| `maxHeight`           | `number`  | Maximum height in pixels (default: 2000)             |
| `quality`             | `number`  | Quality 0-1 for lossy formats (default: 0.85)        |
| `format`              | `string`  | Output format: 'auto', 'webp', 'avif', 'jpeg', 'png' |
| `stripMetadata`       | `boolean` | Strip EXIF (including GPS) and other metadata (default: true) |
| `autoOrient`          | `boolean` | Auto-orient based on EXIF (default: true)            |
| `preserveAspectRatio` | `boolean` | Preserve aspect ratio (default: true)                |
| `skipIfLarger`        | `boolean` | Keep the original if re-encoding makes it bigger and nothing else changed (default: true) |
| `maxInputPixels`      | `number`  | Refuse images above this pixel count (default: 100 MP) |

Works with Buffers and Files; streams pass through untouched. The upload's `contentType` is updated to the output format.

### Metadata Extraction

Extracts EXIF data, dimensions, and file hashes. Requires `sharp` for image metadata; install `exif-reader` for full EXIF (camera, exposure, lens, date). GPS coordinates are only included with `includeGps: true`. Extracted data stays in-process (it is not written to object metadata), and fills `result.width`/`height` when the provider does not report them.

```typescript
import { createMetadataExtractionPlugin } from '@fluxmedia/plugins';

const plugin = createMetadataExtractionPlugin({
  extractExif: true,
  extractDimensions: true,
  hashFile: true,
  hashAlgorithm: 'sha256',
});

// Metadata is added to upload result
const result = await uploader.upload(file);
console.log(result.metadata.extracted);
// { dimensions: { width, height }, hash: '...', hashAlgorithm: 'sha256' }
```

**Options:**
| Option              | Type      | Description                                        |
| ------------------- | --------- | -------------------------------------------------- |
| `extractExif`       | `boolean` | Extract EXIF metadata (default: true)              |
| `extractDimensions` | `boolean` | Extract width/height (default: true)               |
| `hashFile`          | `boolean` | Generate file hash (default: false)                |
| `hashAlgorithm`     | `string`  | Hash algorithm: 'md5' or 'sha256' (default: 'md5') |

### Analytics/Logging

Logs and tracks upload operations with environment-aware behavior and **strongly-typed events**.

```typescript
import { 
  createAnalyticsPlugin,
  type TrackFunction,
  type AnalyticsEventType 
} from '@fluxmedia/plugins';

const plugin = createAnalyticsPlugin({
  environment: 'production',
  logLevel: 'info',
  console: true,
  trackPerformance: true,
  // Typed track function - TypeScript verifies event/data match
  track: (event, data) => {
    // event: 'media.upload.started' | 'media.upload.completed' | 'media.delete.completed' | 'media.error'
    // data: typed based on event type
    myAnalytics.track(event, data);
  },
  onUploadStart: (file, options) => {
    console.log('Upload starting...');
  },
  onUploadComplete: (result, durationMs) => {
    console.log(`Completed in ${durationMs}ms`);
  },
  onUploadError: (error, file) => {
    console.error('Upload failed:', error);
  },
  onDelete: (id) => {
    console.log(`Deleted: ${id}`);
  }
});
```

**Event Types:**
| Event                    | Data Type                  | Description                                            |
| ------------------------ | -------------------------- | ------------------------------------------------------ |
| `media.upload.started`   | `UploadStartedEventData`   | fileName, fileSize, folder, uploadId                   |
| `media.upload.completed` | `UploadCompletedEventData` | fileId, fileName, fileSize, format, provider, duration |
| `media.delete.completed` | `DeleteCompletedEventData` | fileId                                                 |
| `media.error`            | `ErrorEventData`           | operation, error, totalErrors                          |

**Options:**
| Option             | Type            | Description                                   |
| ------------------ | --------------- | --------------------------------------------- |
| `environment`      | `string`        | 'development', 'production', 'test', or 'all' |
| `logLevel`         | `string`        | 'none', 'error', 'warn', 'info', or 'debug'   |
| `console`          | `boolean`       | Enable console logging (default: true)        |
| `trackPerformance` | `boolean`       | Track upload duration (default: true)         |
| `track`            | `TrackFunction` | Typed tracking callback                       |
| `onUploadStart`    | `function`      | Called when upload starts                     |
| `onUploadComplete` | `function`      | Called when upload completes                  |
| `onUploadError`    | `function`      | Called on upload error                        |
| `onDelete`         | `function`      | Called when file is deleted                   |

### Retry

Retries failed uploads with exponential backoff and jitter. The plugin wraps the provider upload, so adding it is enough:

```typescript
import { createRetryPlugin, withRetry } from '@fluxmedia/plugins';

await uploader.use(createRetryPlugin({
  maxRetries: 3,
  retryDelay: 1000,
  onRetry: (attempt, error, delay) => {
    console.log(`Retry ${attempt} after ${delay}ms: ${error.message}`);
  }
}));

await uploader.upload(file); // retried on network, rate-limit and provider errors

// Or wrap any async function
const result = await withRetry(() => uploader.get(id), { maxRetries: 2 });
```

Streams are never retried (they can only be read once), aborted uploads are never retried, and waiting between attempts stops as soon as the upload's `signal` aborts.

**Options:**
| Option               | Type               | Description                                        |
| -------------------- | ------------------ | -------------------------------------------------- |
| `maxRetries`         | `number`           | Maximum retry attempts (default: 3)                |
| `retryDelay`         | `number`           | Base delay in milliseconds (default: 1000)         |
| `maxDelay`           | `number`           | Upper bound for one delay (default: 30000)         |
| `exponentialBackoff` | `boolean`          | Use exponential backoff (default: true)            |
| `jitter`             | `boolean`          | Randomize delays ±50% (default: true)              |
| `retryableErrors`    | `MediaErrorCode[]` | Error codes to retry on                            |
| `onRetry`            | `function`         | Callback when retry is attempted                   |
| `shouldRetry`        | `function`         | Custom function to determine if error should retry |

### Virus Scanning

Scans files before upload and rejects infected ones. Bring any scanner, or use the built-in ClamAV (clamd) client:

```typescript
import { createVirusScanPlugin, createClamAVScanner } from '@fluxmedia/plugins';

await uploader.use(createVirusScanPlugin({
  scan: createClamAVScanner({ host: 'clamav', port: 3310 }),
  onThreat: (threat, fileName) => console.warn(`Blocked ${fileName}: ${threat}`),
}));
```

It fails closed: if the scanner is unreachable the upload is rejected (`onScannerError: 'allow'` changes that). Streams are rejected by default because they cannot be scanned without buffering (`streams: 'skip'` changes that).

### Deduplication

Returns the existing result instead of uploading identical content again:

```typescript
import { createDeduplicationPlugin } from '@fluxmedia/plugins';

await uploader.use(createDeduplicationPlugin({
  store: myRedisStore, // { get(key), set(key, result), deleteById?(id) }; in-memory by default
}));
```

Deduplication is scoped to the upload folder by default, so one user's upload is never returned for another user's folder. Duplicates have `metadata.deduplicated: true`.

### Placeholders

Adds a tiny blurred preview and the dominant color for images (requires sharp):

```typescript
import { createPlaceholderPlugin } from '@fluxmedia/plugins';

await uploader.use(createPlaceholderPlugin({ size: 16 }));
const result = await uploader.upload(image);
result.metadata.placeholder; // { dataUri: 'data:image/webp;base64,…', dominantColor: '#a1b2c3', width, height }
```

## Creating Custom Plugins

```typescript
import { createPlugin } from '@fluxmedia/core';

const myPlugin = createPlugin('my-plugin', {
  beforeUpload: async (file, options) => {
    return { file, options: { ...options, metadata: { ...options.metadata, source: 'web' } } };
  },
  // Wrap the upload itself: retry, short-circuit, time it…
  wrapUpload: (next) => async (file, options) => {
    const started = Date.now();
    const result = await next(file, options);
    console.log(`Uploaded in ${Date.now() - started}ms`);
    return result;
  },
  afterUpload: async (result, { options }) => {
    console.log('Uploaded:', result.url, 'to', options.folder);
    return result;
  },
  onError: async (error, { phase }) => {
    console.error(`Failed during ${phase}:`, error.message);
  }
});

await uploader.use(myPlugin);
```

## License

MIT
