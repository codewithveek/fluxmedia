import { useState, useCallback } from 'react';
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

    const reset = useCallback(() => {
        setUploading(false);
        setProgress(0);
        setResult(null);
        setError(null);
    }, []);

    const upload = useCallback(
        async (
            file: File,
            options?: { folder?: string; tags?: string[] }
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
    };
}

/**
 * Upload using signed URL (recommended for production)
 */
async function uploadSigned(
    file: File,
    config: UseMediaUploadConfig,
    options?: { folder?: string; tags?: string[] },
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
        }),
    });

    if (!signResponse.ok) {
        throw new Error('Failed to get signed upload URL');
    }

    const { uploadUrl, fields, publicId } = await signResponse.json();

    // Step 2: Upload to signed URL
    onProgress?.(30);
    const formData = new FormData();

    // Add any required fields (e.g., for Cloudinary signed uploads)
    if (fields) {
        Object.entries(fields).forEach(([key, value]) => {
            formData.append(key, value as string);
        });
    }
    formData.append('file', file);

    const uploadResponse = await fetch(uploadUrl, {
        method: 'POST',
        body: formData,
    });

    onProgress?.(90);

    if (!uploadResponse.ok) {
        throw new Error('Upload failed');
    }

    const result = await uploadResponse.json();

    return {
        id: publicId ?? result.public_id ?? result.key,
        url: result.secure_url ?? result.url ?? result.Location,
        publicUrl: result.secure_url ?? result.url ?? result.Location,
        size: file.size,
        format: file.name.split('.').pop() ?? '',
        provider: 'signed',
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
    options?: { folder?: string; tags?: string[] },
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
