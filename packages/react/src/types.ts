import type { UploadResult, TransformationOptions } from '@fluxmedia/core';

/**
 * Upload mode for React hook
 * - 'signed': ask your server for a signed target, then upload from the browser
 *   straight to storage (recommended)
 * - 'proxy': upload through your server endpoint
 * - 'direct': not supported — it would require storage credentials in the
 *   browser. Kept only so existing code gets a clear error.
 */
export type UploadMode = 'signed' | 'proxy' | 'direct';

/**
 * Per-upload options sent to your server.
 */
export interface ClientUploadOptions {
  /**
   * Folder hint. The FluxMedia server handlers ignore it and decide the
   * folder on the server; custom servers must validate it.
   */
  folder?: string;
  tags?: string[];
  /** Provider hint for multi-provider servers. */
  provider?: string;
  metadata?: Record<string, unknown>;
  /** Cancel this upload. */
  signal?: AbortSignal;
}

/**
 * Configuration for useMediaUpload hook
 */
export interface UseMediaUploadConfig {
  /**
   * Upload mode, see `UploadMode`.
   */
  mode: UploadMode;

  /**
   * Server endpoint for signed URL generation (mode: 'signed'). It receives
   * `{ filename, contentType, size, … }` as JSON and returns a
   * `SignedUploadTarget` — see `createSignedUploadHandler` in
   * `@fluxmedia/core/server`.
   */
  signUrlEndpoint?: string;

  /**
   * Server endpoint for proxy upload (mode: 'proxy'). It receives multipart
   * form data with a `file` field — see `createProxyUploadHandler`.
   */
  proxyEndpoint?: string;

  /**
   * Extra headers for requests to your endpoints (e.g. an auth token).
   * A function is called before each upload.
   */
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);

  /**
   * Credentials mode for requests to your endpoints (default 'same-origin').
   */
  credentials?: RequestCredentials;

  /**
   * Client-side allow-list, like the `accept` attribute: MIME types
   * (`image/png`), wildcards (`image/*`) or extensions (`.pdf`). This is a
   * convenience — always validate on the server too.
   */
  accept?: string | string[];

  /**
   * Client-side maximum file size in bytes.
   */
  maxSize?: number;

  /**
   * Provider configuration for direct mode
   * @deprecated Direct mode is not supported; it would expose credentials.
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
   * Upload a file. Rejects with an `UploadClientError`.
   */
  upload: (file: File, options?: ClientUploadOptions) => Promise<UploadResult>;

  /**
   * Cancel every upload in progress. Concurrent `upload()` calls are allowed;
   * the hook's `progress`, `result` and `error` follow the most recent one.
   */
  cancel: () => void;

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
 * State of one file in an upload queue.
 */
export interface UploadQueueItem {
  id: string;
  file: File;
  status: 'pending' | 'uploading' | 'done' | 'error' | 'cancelled';
  progress: number;
  result: UploadResult | null;
  error: Error | null;
}

/**
 * Options for useMediaUploadQueue.
 */
export interface UseMediaUploadQueueOptions {
  /** Uploads running at once (default 3). */
  concurrency?: number;
  /** Start uploading as soon as files are added (default true). */
  autoStart?: boolean;
  /** Called once every queued file has finished (done, error or cancelled). */
  onQueueComplete?: (items: UploadQueueItem[]) => void;
}

/**
 * Return type for useMediaUploadQueue.
 */
export interface UseMediaUploadQueueReturn {
  items: UploadQueueItem[];
  /** Add files. Files failing `accept`/`maxSize` are added with status 'error'. */
  add: (files: File[] | FileList, options?: ClientUploadOptions) => void;
  /** Start pending uploads (when autoStart is false). */
  start: () => void;
  cancel: (id: string) => void;
  cancelAll: () => void;
  retry: (id: string) => void;
  remove: (id: string) => void;
  clear: () => void;
  /** True while any upload runs. */
  uploading: boolean;
  /** Overall progress across all non-cancelled items (0-100). */
  progress: number;
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
   * Accepted file types (input `accept` attribute; also validated)
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
   * Disable the file dialog and drop target
   */
  disabled?: boolean;

  /**
   * Custom render function
   */
  children?: (props: {
    uploading: boolean;
    progress: number;
    result: UploadResult | null;
    error: Error | null;
    openFileDialog: () => void;
    cancel: () => void;
    isDragging: boolean;
    /** Spread onto the element that should accept dropped files. */
    getRootProps: () => {
      onDragEnter: (event: React.DragEvent) => void;
      onDragOver: (event: React.DragEvent) => void;
      onDragLeave: (event: React.DragEvent) => void;
      onDrop: (event: React.DragEvent) => void;
    };
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
