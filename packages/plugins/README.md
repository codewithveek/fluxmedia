# @fluxmedia/plugins

Official plugins for FluxMedia providing validation, optimization, analytics, and retry functionality.

## Installation

```bash
npm install @fluxmedia/plugins
# For image optimization, also install sharp:
npm install sharp
```

## Available Plugins

### File Validation Plugin

Validates files before upload based on type, size, and extension.

```typescript
import { createFileValidationPlugin } from '@fluxmedia/plugins';

const validationPlugin = createFileValidationPlugin({
  allowedTypes: ['image/*', 'video/mp4'],
  maxSize: 10 * 1024 * 1024, // 10MB
  blockedExtensions: ['.exe', '.bat'],
});
```

### Image Optimization Plugin (Server-side)

Optimizes images using sharp before upload.

```typescript
import { createImageOptimizationPlugin } from '@fluxmedia/plugins';

const optimizationPlugin = createImageOptimizationPlugin({
  maxWidth: 2000,
  maxHeight: 2000,
  quality: 0.85,
  format: 'webp',
});
```

### Metadata Extraction Plugin

Extracts EXIF data, dimensions, and file hashes.

```typescript
import { createMetadataExtractionPlugin } from '@fluxmedia/plugins';

const metadataPlugin = createMetadataExtractionPlugin({
  extractExif: true,
  extractDimensions: true,
  hashFile: true,
});
```

### Analytics Plugin

Logs and tracks upload operations.

```typescript
import { createAnalyticsPlugin } from '@fluxmedia/plugins';

const analyticsPlugin = createAnalyticsPlugin({
  environment: 'production',
  track: (event, data) => myAnalytics.track(event, data),
});
```

### Retry Plugin

Provides retry configuration with exponential backoff.

```typescript
import { createRetryPlugin, withRetry } from '@fluxmedia/plugins';

const retryPlugin = createRetryPlugin({
  maxRetries: 3,
  exponentialBackoff: true,
});
```

## License

MIT
