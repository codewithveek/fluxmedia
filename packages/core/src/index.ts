// Export types
export type {
    UploadResult,
    UploadOptions,
    TransformationOptions,
    SearchOptions,
    MediaProvider,
    ProviderFeatures,
} from './types';

// Export errors
export { MediaError, MediaErrorCode, createMediaError } from './errors';

// Export plugins
export {
    PluginManager,
    createPlugin,
    type FluxMediaPlugin,
    type PluginHooks,
} from './plugin';

// Export main class
export { MediaUploader } from './media-uploader';

// Export file type utilities
export {
    getFileType,
    getFileTypeFromStream,
    isImage,
    isVideo,
    type FileTypeResult,
} from './file-type';
