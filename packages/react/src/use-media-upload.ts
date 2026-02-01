import { useState, useCallback, useRef, useEffect } from 'react';
import type { UploadResult } from '@fluxmedia/core';
import type { UseMediaUploadConfig, UseMediaUploadReturn } from './types';

/**
 * React hook for media uploads.
 * Supports direct, signed, and proxy upload modes.
 *
 * @example
 * ```tsx
 * function UploadButton() {
 *   const { upload, uploading, progress, error, result } = useMediaUpload({
 *     mode: 'signed',
 *     signUrlEndpoint: '/api/media/sign'
 *   });
 *
 *   return (
 *     <input
 *       type="file"
 *       onChange={(e) => upload(e.target.files?.[0]!)}
 *       disabled={uploading}
 *     />
 *   );
 * }
 * ```
 */
export function useMediaUpload(config: UseMediaUploadConfig): UseMediaUploadReturn {
    const [uploading, setUploading] = useState(false);
    const [progress, setProgress] = useState(0);
    const [result, setResult] = useState<UploadResult | null>(null);
    const [error, setError] = useState<Error | null>(null);
    const [preview, setPreviewUrl] = useState<string | null>(null);
    const [fileType, setFileType] = useState<{ mime: string; ext: string } | null>(null);

    // Track preview URL for cleanup
    const previewUrlRef = useRef<string | null>(null);

    // Cleanup preview URL on unmount
    useEffect(() => {
        return () => {
            if (previewUrlRef.current) {
                URL.revokeObjectURL(previewUrlRef.current);
            }
        };
    }, []);

    const setPreview = useCallback((file: File | null) => {
        // Revoke previous preview URL to prevent memory leaks
        if (previewUrlRef.current) {
            URL.revokeObjectURL(previewUrlRef.current);
            previewUrlRef.current = null;
        }

        if (file) {
            const url = URL.createObjectURL(file);
            previewUrlRef.current = url;
            setPreviewUrl(url);
        } else {
            setPreviewUrl(null);
        }
    }, []);

    const reset = useCallback(() => {
        setUploading(false);
        setProgress(0);
        setResult(null);
        setError(null);
        setPreview(null);
        setFileType(null);
    }, [setPreview]);

    /**
     * Detect file type using magic bytes (more reliable than MIME type)
     */
    const detectFileType = useCallback(async (file: File) => {
        try {
            // Dynamic import for tree-shaking
            const { fileTypeFromBuffer } = await import('file-type');
            const buffer = await file.arrayBuffer();
            const result = await fileTypeFromBuffer(new Uint8Array(buffer));

            if (result) {
                const typeResult = { mime: result.mime, ext: result.ext };
                setFileType(typeResult);
                return typeResult;
            }
            setFileType(null);
            return null;
        } catch {
            // Fallback to browser MIME type if detection fails
            const fallback = { mime: file.type, ext: file.name.split('.').pop() ?? '' };
            setFileType(fallback);
            return fallback;
        }
    }, []);

    const upload = useCallback(
        async (
            file: File,
            options?: {
                folder?: string;
                tags?: string[];
                provider?: string;
                metadata?: Record<string, unknown>;
            }
        ): Promise<UploadResult> => {
            setUploading(true);
            setProgress(0);
            setError(null);
            setResult(null);

            config.onUploadStart?.();

            try {
                let uploadResult: UploadResult;

                switch (config.mode) {
                    case 'signed':
                        uploadResult = await uploadSigned(file, config, options, setProgress);
                        break;
                    case 'proxy':
                        uploadResult = await uploadProxy(file, config, options, setProgress);
                        break;
                    case 'direct':
                    default:
                        throw new Error('Direct mode requires server-side implementation');
                }

                setResult(uploadResult);
                setProgress(100);
                config.onUploadComplete?.(uploadResult);
                return uploadResult;
            } catch (err) {
                const uploadError = err instanceof Error ? err : new Error('Upload failed');
                setError(uploadError);
                config.onUploadError?.(uploadError);
                throw uploadError;
            } finally {
                setUploading(false);
            }
        },
        [config]
    );

    return {
        upload,
        uploading,
        progress,
        result,
        error,
        reset,
        preview,
        setPreview,
        fileType,
        detectFileType,
    };
}

/**
 * Upload using signed URL (recommended for production)
 */
async function uploadSigned(
    file: File,
    config: UseMediaUploadConfig,
    options?: {
        folder?: string;
        tags?: string[];
        provider?: string;
        metadata?: Record<string, unknown>;
    },
    onProgress?: (progress: number) => void
): Promise<UploadResult> {
    if (!config.signUrlEndpoint) {
        throw new Error('signUrlEndpoint is required for signed mode');
    }

    // Step 1: Get signed URL from server
    onProgress?.(10);
    const signResponse = await fetch(config.signUrlEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            filename: file.name,
            contentType: file.type,
            folder: options?.folder ?? config.defaultOptions?.folder,
            tags: options?.tags ?? config.defaultOptions?.tags,
            provider: options?.provider,
            metadata: options?.metadata,
        }),
    });

    if (!signResponse.ok) {
        throw new Error('Failed to get signed upload URL');
    }

    const { uploadUrl, fields, publicId, method, headers, publicUrl: signedPublicUrl } = await signResponse.json();

    // Step 2: Upload to signed URL
    onProgress?.(30);

    let uploadResponse: Response;

    if (method === 'PUT') {
        // S3/R2: Use PUT with raw file body
        uploadResponse = await fetch(uploadUrl, {
            method: 'PUT',
            headers: {
                ...headers,
            },
            body: file,
        });
    } else {
        // Cloudinary: Use POST with FormData
        const formData = new FormData();
        if (fields) {
            Object.entries(fields).forEach(([key, value]) => {
                formData.append(key, value as string);
            });
        }
        formData.append('file', file);

        uploadResponse = await fetch(uploadUrl, {
            method: 'POST',
            body: formData,
        });
    }

    onProgress?.(90);

    if (!uploadResponse.ok) {
        throw new Error('Upload failed');
    }

    // S3/R2 returns empty response on success, Cloudinary returns JSON
    let result: Record<string, unknown> = {};
    const responseText = await uploadResponse.text();
    if (responseText) {
        try {
            result = JSON.parse(responseText);
        } catch {
            // S3/R2 may return empty or non-JSON response
        }
    }

    // Build result URL (S3/R2 use signedPublicUrl, Cloudinary uses result.secure_url)
    const resultUrl = signedPublicUrl ?? result.secure_url ?? result.url ?? uploadUrl.split('?')[0];

    return {
        id: publicId ?? result.public_id ?? result.key,
        url: resultUrl as string,
        publicUrl: resultUrl as string,
        size: file.size,
        format: file.name.split('.').pop() ?? '',
        provider: options?.provider ?? 'signed',
        metadata: result,
        createdAt: new Date(),
    };
}

/**
 * Upload through proxy server
 */
async function uploadProxy(
    file: File,
    config: UseMediaUploadConfig,
    options?: {
        folder?: string;
        tags?: string[];
        provider?: string;
        metadata?: Record<string, unknown>;
    },
    onProgress?: (progress: number) => void
): Promise<UploadResult> {
    if (!config.proxyEndpoint) {
        throw new Error('proxyEndpoint is required for proxy mode');
    }

    onProgress?.(10);

    const formData = new FormData();
    formData.append('file', file);

    if (options?.folder ?? config.defaultOptions?.folder) {
        formData.append('folder', options?.folder ?? config.defaultOptions?.folder ?? '');
    }

    if (options?.tags ?? config.defaultOptions?.tags) {
        formData.append('tags', JSON.stringify(options?.tags ?? config.defaultOptions?.tags));
    }

    // Pass provider for multi-provider support
    if (options?.provider) {
        formData.append('provider', options.provider);
    }

    // Pass metadata (will be sanitized server-side)
    if (options?.metadata) {
        formData.append('metadata', JSON.stringify(options.metadata));
    }

    onProgress?.(30);

    const response = await fetch(config.proxyEndpoint, {
        method: 'POST',
        body: formData,
    });

    onProgress?.(90);

    if (!response.ok) {
        throw new Error('Upload failed');
    }

    const result = await response.json();

    return {
        id: result.id,
        url: result.url,
        publicUrl: result.publicUrl ?? result.url,
        size: result.size ?? file.size,
        format: result.format ?? file.name.split('.').pop() ?? '',
        provider: result.provider ?? 'proxy',
        metadata: result.metadata ?? {},
        createdAt: result.createdAt ? new Date(result.createdAt) : new Date(),
    };
}
