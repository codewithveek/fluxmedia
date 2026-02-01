import type { UploadResult, TransformationOptions } from '@fluxmedia/core';

/**
 * Upload mode for React hook
 */
export type UploadMode = 'direct' | 'signed' | 'proxy';

/**
 * Configuration for useMediaUpload hook
 */
export interface UseMediaUploadConfig {
    /**
     * Upload mode:
     * - 'direct': Upload directly from browser (requires exposed credentials)
     * - 'signed': Get signed URL from server, then upload from browser
     * - 'proxy': Upload through server endpoint
     */
    mode: UploadMode;

    /**
     * Server endpoint for signed URL generation (mode: 'signed')
     */
    signUrlEndpoint?: string;

    /**
     * Server endpoint for proxy upload (mode: 'proxy')
     */
    proxyEndpoint?: string;

    /**
     * Provider configuration for direct mode
     */
    providerConfig?: Record<string, unknown>;

    /**
     * Default upload options
     */
    defaultOptions?: {
        folder?: string;
        tags?: string[];
        transformation?: TransformationOptions;
    };

    /**
     * Callback when upload starts
     */
    onUploadStart?: () => void;

    /**
     * Callback when upload completes
     */
    onUploadComplete?: (result: UploadResult) => void;

    /**
     * Callback when upload fails
     */
    onUploadError?: (error: Error) => void;
}

/**
 * Return type for useMediaUpload hook
 */
export interface UseMediaUploadReturn {
    /**
     * Upload a file
     */
    upload: (
        file: File,
        options?: {
            folder?: string;
            tags?: string[];
            provider?: string;
            metadata?: Record<string, unknown>;
        }
    ) => Promise<UploadResult>;

    /**
     * Current upload state
     */
    uploading: boolean;

    /**
     * Upload progress (0-100)
     */
    progress: number;

    /**
     * Last upload result
     */
    result: UploadResult | null;

    /**
     * Last upload error
     */
    error: Error | null;

    /**
     * Reset state
     */
    reset: () => void;

    /**
     * Preview URL for the selected file (created via URL.createObjectURL)
     */
    preview: string | null;

    /**
     * Set preview for a file (creates object URL for preview, handles cleanup)
     */
    setPreview: (file: File | null) => void;

    /**
     * Detected file type from magic bytes (more reliable than browser MIME type)
     */
    fileType: { mime: string; ext: string } | null;

    /**
     * Detect file type using magic bytes. Returns detected type and sets fileType state.
     */
    detectFileType: (file: File) => Promise<{ mime: string; ext: string } | null>;
}

/**
 * Props for MediaUpload component
 */
export interface MediaUploadProps {
    /**
     * Upload configuration
     */
    config: UseMediaUploadConfig;

    /**
     * Accepted file types
     */
    accept?: string;

    /**
     * Allow multiple file selection
     */
    multiple?: boolean;

    /**
     * Maximum file size in bytes
     */
    maxSize?: number;

    /**
     * Custom render function
     */
    children?: (props: {
        uploading: boolean;
        progress: number;
        result: UploadResult | null;
        error: Error | null;
        openFileDialog: () => void;
    }) => React.ReactNode;

    /**
     * Callback when file is selected
     */
    onSelect?: (files: File[]) => void;

    /**
     * Callback when upload completes
     */
    onComplete?: (results: UploadResult[]) => void;

    /**
     * Callback when upload fails
     */
    onError?: (error: Error) => void;
}
