/**
 * FluxMedia Plugins
 *
 * Official plugins for FluxMedia providing validation, optimization,
 * analytics, and retry functionality.
 */

// Validation Plugin
export {
    createFileValidationPlugin,
    type FileValidationOptions,
    type ValidationError,
    type ValidationErrorType,
} from './validation';

// Image Optimization Plugin (Server-side)
export {
    createImageOptimizationPlugin,
    type ImageOptimizationOptions,
    type OptimizationMetadata,
} from './optimization';

// Metadata Extraction Plugin
export {
    createMetadataExtractionPlugin,
    type MetadataExtractionOptions,
    type ExtractedMetadata,
} from './metadata';

// Analytics/Logging Plugin
export {
    createAnalyticsPlugin,
    type AnalyticsOptions,
    type LogLevel,
    type Environment,
    type AnalyticsEventType,
    type AnalyticsEventMap,
    type TrackFunction,
    type UploadStartedEventData,
    type UploadCompletedEventData,
    type DeleteCompletedEventData,
    type ErrorEventData,
} from './analytics';

// Retry Plugin
export {
    createRetryPlugin,
    withRetry,
    getRetryConfig,
    type RetryOptions,
    type RetryMetadata,
} from './retry';

// Virus Scanning Plugin
export {
    createVirusScanPlugin,
    createClamAVScanner,
    type VirusScanOptions,
    type VirusScanner,
    type ScanResult,
    type ClamAVOptions,
} from './virus-scan';

// Deduplication Plugin
export {
    createDeduplicationPlugin,
    createMemoryDedupeStore,
    type DedupeOptions,
    type DedupeStore,
} from './dedupe';

// Placeholder (LQIP) Plugin
export {
    createPlaceholderPlugin,
    type PlaceholderOptions,
    type PlaceholderMetadata,
} from './placeholder';
