import type { ProviderFeatures } from '@fluxmedia/core';

/**
 * Feature matrix for S3 provider.
 * S3 is storage-only - no transformation support.
 */
export const S3Features: ProviderFeatures = {
    transformations: {
        resize: false,
        crop: false,
        format: false,
        quality: false,
        blur: false,
        rotate: false,
        effects: false,
    },
    capabilities: {
        signedUploads: true,
        directUpload: true,
        multipartUpload: true,
        videoProcessing: false,
        aiTagging: false,
        facialDetection: false,
        signedUrls: true,
        list: true,
        search: false,
        copy: true,
        download: true,
        updateMetadata: true,
    },
    storage: {
        maxFileSize: 5 * 1024 * 1024 * 1024 * 1024, // 5 TiB via multipart (5 GiB per single PUT)
        supportedFormats: ['*'], // All formats
    },
};
