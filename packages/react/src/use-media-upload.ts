import { useState, useCallback, useRef, useEffect } from 'react';

import { getFileType, type UploadResult } from '@fluxmedia/core';
import type { ClientUploadOptions, UseMediaUploadConfig, UseMediaUploadReturn } from './types';
import { UploadClientError, uploadFile } from './upload-client';

/**
 * Read a Blob, falling back to FileReader where Blob.arrayBuffer is missing
 * (Safari < 14, jsdom).
 */
function readBlob(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

/**
 * React hook for media uploads.
 * Supports signed (browser → storage) and proxy (browser → your server) modes.
 *
 * @example
 * ```tsx
 * function UploadButton() {
 *   const { upload, cancel, uploading, progress, error } = useMediaUpload({
 *     mode: 'signed',
 *     signUrlEndpoint: '/api/upload/sign',
 *     accept: ['image/*'],
 *     maxSize: 10 * 1024 * 1024,
 *   });
 *
 *   return (
 *     <input
 *       type="file"
 *       onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
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

  // Keep callbacks stable even when the config object is recreated each render
  const configRef = useRef(config);
  configRef.current = config;

  const previewUrlRef = useRef<string | null>(null);
  // Every upload in flight (concurrent calls are allowed) and the latest one,
  // whose progress/result/error the hook state reflects.
  const controllersRef = useRef(new Set<AbortController>());
  const latestRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      controllersRef.current.forEach((c) => c.abort());
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
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

  const cancel = useCallback(() => {
    controllersRef.current.forEach((c) => c.abort());
  }, []);

  const reset = useCallback(() => {
    controllersRef.current.forEach((c) => c.abort());
    setUploading(false);
    setProgress(0);
    setResult(null);
    setError(null);
    setPreview(null);
    setFileType(null);
  }, [setPreview]);

  /**
   * Detect file type using magic bytes (more reliable than MIME type).
   * Reads only the first 4 KB of the file.
   */
  const detectFileType = useCallback(async (file: File) => {
    try {
      const head = new Uint8Array(await readBlob(file.slice(0, 4100)));
      const detected = await getFileType(head);
      const typeResult = detected ? { mime: detected.mime, ext: detected.ext } : null;
      if (mountedRef.current) setFileType(typeResult);
      return typeResult;
    } catch {
      // Fallback to browser MIME type if detection fails
      const fallback = { mime: file.type, ext: file.name.split('.').pop() ?? '' };
      if (mountedRef.current) setFileType(fallback);
      return fallback;
    }
  }, []);

  const upload = useCallback(async (file: File, options?: ClientUploadOptions): Promise<UploadResult> => {
    const current = configRef.current;
    const controller = new AbortController();
    controllersRef.current.add(controller);
    latestRef.current = controller;
    const isLatest = () => mountedRef.current && latestRef.current === controller;
    const forwardAbort = () => controller.abort();
    options?.signal?.addEventListener('abort', forwardAbort, { once: true });

    setUploading(true);
    setProgress(0);
    setError(null);
    setResult(null);
    current.onUploadStart?.();

    try {
      const uploadResult = await uploadFile(
        file,
        current,
        { ...options, signal: controller.signal },
        (p) => {
          if (isLatest()) setProgress(p);
        }
      );
      if (isLatest()) {
        setResult(uploadResult);
        setProgress(100);
      }
      current.onUploadComplete?.(uploadResult);
      return uploadResult;
    } catch (err) {
      const uploadError =
        err instanceof Error ? err : new UploadClientError('Upload failed', 'network');
      if (isLatest()) setError(uploadError);
      current.onUploadError?.(uploadError);
      throw uploadError;
    } finally {
      options?.signal?.removeEventListener('abort', forwardAbort);
      controllersRef.current.delete(controller);
      if (mountedRef.current && controllersRef.current.size === 0) setUploading(false);
    }
  }, []);

  return {
    upload,
    cancel,
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
