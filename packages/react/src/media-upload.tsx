import React, { useRef, useCallback } from 'react';
import type { UploadResult } from '@fluxmedia/core';
import { useMediaUpload } from './use-media-upload';
import type { MediaUploadProps } from './types';

/**
 * React component for media uploads with drag and drop support.
 *
 * @example
 * ```tsx
 * <MediaUpload
 *   config={{ mode: 'signed', signUrlEndpoint: '/api/media/sign' }}
 *   onComplete={(results) => console.log('Uploaded:', results)}
 * >
 *   {({ uploading, progress, openFileDialog }) => (
 *     <button onClick={openFileDialog} disabled={uploading}>
 *       {uploading ? `Uploading ${progress}%` : 'Upload File'}
 *     </button>
 *   )}
 * </MediaUpload>
 * ```
 */
export function MediaUpload({
    config,
    accept,
    multiple = false,
    maxSize,
    children,
    onSelect,
    onComplete,
    onError,
}: MediaUploadProps): React.ReactElement {
    const inputRef = useRef<HTMLInputElement>(null);
    const { upload, uploading, progress, result, error } = useMediaUpload(config);

    const handleFileChange = useCallback(
        async (event: React.ChangeEvent<HTMLInputElement>) => {
            const files = Array.from(event.target.files ?? []);

            if (files.length === 0) return;

            // Validate file size
            if (maxSize) {
                const oversizedFiles = files.filter((f) => f.size > maxSize);
                if (oversizedFiles.length > 0) {
                    const error = new Error(`File(s) exceed maximum size of ${maxSize} bytes`);
                    onError?.(error);
                    return;
                }
            }

            onSelect?.(files);

            try {
                const results: UploadResult[] = [];
                for (const file of files) {
                    const res = await upload(file);
                    results.push(res);
                }
                onComplete?.(results);
            } catch (err) {
                onError?.(err instanceof Error ? err : new Error('Upload failed'));
            }

            // Reset input
            if (inputRef.current) {
                inputRef.current.value = '';
            }
        },
        [upload, maxSize, onSelect, onComplete, onError]
    );

    const openFileDialog = useCallback(() => {
        inputRef.current?.click();
    }, []);

    return (
        <>
            <input
                ref={inputRef}
                type="file"
                accept={accept}
                multiple={multiple}
                onChange={handleFileChange}
                style={{ display: 'none' }}
            />
            {children?.({
                uploading,
                progress,
                result,
                error,
                openFileDialog,
            })}
        </>
    );
}
