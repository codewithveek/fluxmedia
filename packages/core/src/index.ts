// Export types
export type {
  UploadResult,
  UploadOptions,
  UploadInput,
  TransformationOptions,
  SearchOptions,
  MediaProvider,
  ProviderFeatures,
  ResourceOptions,
  SignedUrlOptions,
  SignedUploadOptions,
  SignedUploadTarget,
  ListOptions,
  ListResult,
  DownloadResult,
} from './types';

// Export errors
export {
  MediaError,
  MediaErrorCode,
  createMediaError,
  isAbortError,
  PartialUploadError,
  type PartialUploadContext,
} from './errors';

// Export plugins
export {
  PluginManager,
  createPlugin,
  type FluxMediaPlugin,
  type PluginHooks,
  type UploadPhase,
  type UploadFn,
  type AfterUploadContext,
} from './plugin';

// Export main class
export {
  MediaUploader,
  type MediaUploaderConfig,
  type TransactionCallbacks,
  type FileRef,
  type UploadMultipleOptions,
} from './media-uploader';

// In-memory provider
export { MemoryProvider, MemoryFeatures, type MemoryProviderConfig } from './memory-provider';

// Signed URLs for providers without native signing
export {
  createSignedUrl,
  verifySignedUrl,
  type CreateSignedUrlOptions,
  type VerifySignedUrlResult,
} from './signing';

// Shared helpers for provider and plugin authors
export {
  randomId,
  sanitizeKeySegment,
  sanitizeFolder,
  buildStorageKey,
  assertSafeKey,
  encodeKeyForUrl,
  stripInternalMetadata,
  toPersistedMetadata,
  encodeHeaderValue,
  decodePersistedMetadata,
  isStreamInput,
  isNodeReadable,
  isFileInput,
  isBuffer,
  getInputSize,
  getInputName,
  readHead,
  extensionFromMime,
  mimeFromExtension,
  detectContentInfo,
  detectTrustedType,
  isTextLikeMime,
  isMimeAllowed,
  throwIfAborted,
  clampExpiresIn,
  mapSettled,
  MAGIC_BYTES_LENGTH,
} from './utils';

// Export file type utilities
export {
  getFileType,
  getFileTypeFromStream,
  isImage,
  isVideo,
  type FileTypeResult,
} from './file-type';
