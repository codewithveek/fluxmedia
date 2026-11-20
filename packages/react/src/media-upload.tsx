import React, { useRef, useCallback, useState } from 'react';
import type { UploadResult } from '@fluxmedia/core';
import { useMediaUpload } from './use-media-upload';
import { UploadClientError, validateFile } from './upload-client';
import type { MediaUploadProps } from './types';

/**
 * React component for media uploads with file dialog and drag-and-drop.
 *
 * @example
 * ```tsx
 * <MediaUpload
 *   config={{ mode: 'signed', signUrlEndpoint: '/api/upload/sign' }}
 *   accept="image/*"
 *   onComplete={(results) => console.log('Uploaded:', results)}
 * >
 *   {({ uploading, progress, openFileDialog, getRootProps, isDragging }) => (
 *     <div {...getRootProps()} className={isDragging ? 'drop active' : 'drop'}>
 *       <button onClick={openFileDialog} disabled={uploading}>
 *         {uploading ? `Uploading ${progress}%` : 'Upload or drop a file'}
 *       </button>
 *     </div>
 *   )}
 * </MediaUpload>
 * ```
 */
export function MediaUpload({
  config,
  accept,
  multiple = false,
  maxSize,
  disabled = false,
  children,
  onSelect,
  onComplete,
  onError,
}: MediaUploadProps): React.ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const [isDragging, setIsDragging] = useState(false);
  const { upload, cancel, uploading, progress, result, error } = useMediaUpload(config);

  const handleFiles = useCallback(
    async (input: File[]) => {
      const files = multiple ? input : input.slice(0, 1);
      if (files.length === 0) return;

      for (const file of files) {
        const invalid = validateFile(file, { accept: accept ?? config.accept, maxSize: maxSize ?? config.maxSize });
        if (invalid) {
          onError?.(new UploadClientError(invalid, 'validation'));
          return;
        }
      }

      onSelect?.(files);

      try {
        const results: UploadResult[] = [];
        for (const file of files) {
          results.push(await upload(file));
        }
        onComplete?.(results);
      } catch (err) {
        onError?.(err instanceof Error ? err : new Error('Upload failed'));
      }
    },
    [accept, config.accept, config.maxSize, maxSize, multiple, onComplete, onError, onSelect, upload]
  );

  const handleFileChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      // Reset so selecting the same file again fires change
      if (inputRef.current) inputRef.current.value = '';
      await handleFiles(files);
    },
    [handleFiles]
  );

  const openFileDialog = useCallback(() => {
    if (!disabled) inputRef.current?.click();
  }, [disabled]);

  const getRootProps = useCallback(
    () => ({
      onDragEnter: (event: React.DragEvent) => {
        event.preventDefault();
        if (disabled) return;
        dragDepth.current += 1;
        setIsDragging(true);
      },
      onDragOver: (event: React.DragEvent) => {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = disabled ? 'none' : 'copy';
      },
      onDragLeave: (event: React.DragEvent) => {
        event.preventDefault();
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setIsDragging(false);
      },
      onDrop: (event: React.DragEvent) => {
        event.preventDefault();
        dragDepth.current = 0;
        setIsDragging(false);
        if (disabled || uploading) return;
        void handleFiles(Array.from(event.dataTransfer?.files ?? []));
      },
    }),
    [disabled, handleFiles, uploading]
  );

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={accept ?? (Array.isArray(config.accept) ? config.accept.join(',') : config.accept)}
        multiple={multiple}
        disabled={disabled}
        onChange={handleFileChange}
        style={{ display: 'none' }}
        data-testid="fluxmedia-file-input"
      />
      {children?.({
        uploading,
        progress,
        result,
        error,
        openFileDialog,
        cancel,
        isDragging,
        getRootProps,
      })}
    </>
  );
}
