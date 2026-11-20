/**
 * Result returned after a successful media upload.
 * Normalized across all providers to ensure consistent API.
 */
export interface UploadResult {
  /**
   * Unique identifier for the uploaded file (provider-specific format)
   */
  id: string;

  /**
   * URL of the uploaded file. For private storage (e.g. an R2 bucket with no
   * `publicUrl` configured) this is the storage endpoint URL, which is not
   * readable without a signed request.
   */
  url: string;

  /**
   * Publicly accessible URL. Omitted when the provider has no public URL for
   * the file — for example a private bucket served through short-lived signed
   * URLs.
   */
  publicUrl?: string;

  /**
   * File size in bytes. 0 when the provider could not determine it.
   */
  size: number;

  /**
   * File format/extension (e.g., 'jpg', 'png', 'mp4')
   */
  format: string;

  /**
   * Image/video width in pixels (if applicable)
   */
  width?: number;

  /**
   * Image/video height in pixels (if applicable)
   */
  height?: number;

  /**
   * Name of the provider used for upload. `MediaUploader` uses this to route
   * `delete`, `get` and URL calls to the right provider after a failover.
   */
  provider: string;

  /**
   * Additional provider-specific metadata
   */
  metadata: Record<string, unknown>;

  /**
   * Upload timestamp
   */
  createdAt: Date;

  /**
   * Raw provider storage key.
   * S3/R2: the S3 object key (e.g. 'uploads/video-abc123')
   * Cloudinary: the public_id (e.g. 'uploads/video-abc123')
   * Always safe to pass to provider.delete().
   */
  storageKey?: string;

  /**
   * MIME type of the stored file, when known.
   */
  contentType?: string;
}

/**
 * Provider-agnostic transformation options for images.
 * Not all providers support all transformations - check provider features.
 */
export interface TransformationOptions {
  /**
   * Target width in pixels
   */
  width?: number;

  /**
   * Target height in pixels
   */
  height?: number;

  /**
   * Quality (0-100 for lossy formats)
   */
  quality?: number;

  /**
   * Output format
   */
  format?: 'auto' | 'webp' | 'avif' | 'jpg' | 'png';

  /**
   * Resize fit mode
   * - cover: Crop to fill dimensions
   * - contain: Fit within dimensions
   * - fill: Stretch to fill dimensions
   * - inside: Resize to fit inside dimensions
   * - outside: Resize to fit outside dimensions
   */
  fit?: 'cover' | 'contain' | 'fill' | 'inside' | 'outside';
}

/**
 * Options for uploading a file.
 */
export interface UploadOptions {
  /**
   * Custom filename (without extension). Sanitized before use: path
   * separators, `..` segments and control characters are removed.
   */
  filename?: string;

  /**
   * Folder/path where file should be stored. Sanitized the same way as
   * `filename`; it can never escape the bucket root.
   */
  folder?: string;

  /**
   * Whether the file should be publicly accessible.
   * - Cloudinary: `false` stores the asset as `authenticated` (signed URLs only).
   * - S3: applied as an object ACL when the provider is configured with `useAcl: true`.
   * - R2 / buckets with ACLs disabled: access is controlled at the bucket level;
   *   `public: true` on a private bucket throws so it can never silently leak.
   */
  public?: boolean;

  /**
   * Tags for organizing files. S3/R2 store them as object tags.
   */
  tags?: string[];

  /**
   * Custom metadata to store with the file. Only top-level string, number
   * and boolean values are persisted to the provider; nested objects and keys
   * starting with `_` stay in-process (they are available to plugins and on
   * the returned result).
   */
  metadata?: Record<string, unknown>;

  /**
   * Callback for upload progress (0-100)
   */
  onProgress?: (progress: number) => void;

  /**
   * Callback with bytes transferred and total bytes.
   * Total may be undefined for streams.
   */
  onByteProgress?: (loaded: number, total: number | undefined) => void;

  /**
   * Transformations to apply during upload
   */
  transformation?: TransformationOptions;

  /**
   * When true (default), generates unique filenames by appending a short ID
   * to prevent overwriting existing files. Set to false to replace files
   * with the same name.
   */
  uniqueFilename?: boolean;

  /**
   * Explicit content type. Required when uploading streams
   * (where magic-byte detection is not possible without buffering).
   */
  contentType?: string;

  /**
   * `Cache-Control` header for the stored object (S3, R2, GCS, Azure, local).
   */
  cacheControl?: string;

  /**
   * `Content-Disposition` header for the stored object, e.g.
   * `attachment; filename="report.pdf"` (S3, R2, GCS, Azure).
   */
  contentDisposition?: string;

  /**
   * Abort signal for cancelling an in-progress upload.
   */
  signal?: AbortSignal;

  /**
   * Provider-specific parameters merged into the native request
   * (e.g. `{ StorageClass: 'STANDARD_IA', ServerSideEncryption: 'aws:kms' }`
   * for S3, or extra Cloudinary upload params). They can never override the
   * bucket, key or body. Never populate this from untrusted client input.
   */
  providerOptions?: Record<string, unknown>;
}

/**
 * Hints that help a provider locate a stored file. Pass the `metadata` of the
 * original `UploadResult` — e.g. Cloudinary needs the resource type to delete
 * a video. `MediaUploader` fills this in when you pass it an `UploadResult`.
 */
export interface ResourceOptions {
  metadata?: Record<string, unknown>;
}

/**
 * Options for a signed (time-limited) download URL.
 */
export interface SignedUrlOptions extends ResourceOptions {
  /**
   * Lifetime in seconds. Default 3600 (1 hour). S3/R2 cap this at 7 days.
   */
  expiresIn?: number;

  /**
   * Transformations (providers with transformation support only).
   */
  transform?: TransformationOptions;

  /**
   * Force a download with this filename (`Content-Disposition: attachment`).
   */
  downloadAs?: string;
}

/**
 * Options for creating a signed upload target that a browser can upload to
 * directly, without the file passing through your server.
 */
export interface SignedUploadOptions {
  /** Base filename (without extension); sanitized. */
  filename?: string;
  /** Destination folder; sanitized. Decide it on the server, not the client. */
  folder?: string;
  /** MIME type the client will upload. Enforced by the signature on S3/R2. */
  contentType: string;
  /**
   * Exact size in bytes the client will upload. Enforced by the signature on
   * S3/R2 (the upload fails if the body differs). Required by the server
   * handlers so `maxSize` can be checked before signing.
   */
  size?: number;
  /** Lifetime of the upload URL in seconds. Default 600 (10 minutes). */
  expiresIn?: number;
  /** Append a random suffix to the filename (default true). */
  uniqueFilename?: boolean;
  /** Primitive metadata stored with the object. */
  metadata?: Record<string, unknown>;
  /** Tags (Cloudinary). */
  tags?: string[];
  /** `Cache-Control` for the stored object (S3/R2). */
  cacheControl?: string;
  /** `Content-Disposition` for the stored object (S3/R2). */
  contentDisposition?: string;
  /** See `UploadOptions.public`. */
  public?: boolean;
}

/**
 * Where and how a client should upload a file. Returned by
 * `createUploadUrl()` and by the signed-upload server handler; consumed by
 * `useMediaUpload({ mode: 'signed' })`.
 */
export interface SignedUploadTarget {
  /** URL to send the file to. */
  uploadUrl: string;
  /** HTTP method: `PUT` with the raw file as body, or `POST` multipart form. */
  method: 'PUT' | 'POST';
  /** Headers the client must send with a `PUT` (they are part of the signature). */
  headers?: Record<string, string>;
  /** Form fields to send before the `file` field with a `POST`. */
  fields?: Record<string, string>;
  /** Storage key / public ID the file will be stored under. */
  storageKey: string;
  /** Public URL after upload, when the storage is public. */
  publicUrl?: string;
  /** When the upload URL stops working. */
  expiresAt: Date;
  /** Provider name. */
  provider: string;
}

/**
 * Options for listing stored files.
 */
export interface ListOptions {
  /** Only list files under this folder/prefix. */
  folder?: string;
  /** Maximum number of results (default 100, max 1000). */
  limit?: number;
  /** Cursor from a previous `ListResult.nextCursor`. */
  cursor?: string;
}

/**
 * A page of listed files.
 */
export interface ListResult {
  items: UploadResult[];
  /** Pass to `list({ cursor })` for the next page; absent on the last page. */
  nextCursor?: string;
}

/**
 * A file body returned by `download()`.
 */
export interface DownloadResult {
  /** File body as a Web ReadableStream. */
  body: ReadableStream<Uint8Array>;
  contentType?: string;
  size?: number;
}

/**
 * Options for searching/filtering files.
 * Not all providers support search functionality.
 */
export interface SearchOptions {
  /**
   * Search query string
   */
  query?: string;

  /**
   * Filter by folder
   */
  folder?: string;

  /**
   * Filter by tags
   */
  tags?: string[];

  /**
   * Maximum number of results
   */
  limit?: number;

  /**
   * Pagination offset
   */
  offset?: number;
}

/**
 * Feature matrix describing provider capabilities.
 * Use this to check what features are supported before using them.
 */
export interface ProviderFeatures {
  /**
   * Supported image transformation features
   */
  transformations: {
    resize: boolean;
    crop: boolean;
    format: boolean;
    quality: boolean;
    blur: boolean;
    rotate: boolean;
    effects: boolean;
  };

  /**
   * General provider capabilities
   */
  capabilities: {
    signedUploads: boolean;
    directUpload: boolean;
    multipartUpload: boolean;
    videoProcessing: boolean;
    aiTagging: boolean;
    facialDetection: boolean;
    /** `getSignedUrl()` is available. */
    signedUrls?: boolean;
    /** `list()` is available. */
    list?: boolean;
    /** `search()` is available. */
    search?: boolean;
    /** `copy()` / `move()` are available. */
    copy?: boolean;
    /** `download()` is available. */
    download?: boolean;
    /** `updateMetadata()` is available. */
    updateMetadata?: boolean;
  };

  /**
   * Storage-related limitations
   */
  storage: {
    maxFileSize: number;
    supportedFormats: string[];
  };
}

/**
 * Core interface that all media providers must implement.
 * Ensures consistent API across different cloud providers.
 *
 * Methods marked optional are capabilities; check `features.capabilities`
 * or use `MediaUploader`, which throws a `NOT_SUPPORTED` MediaError.
 */
export interface MediaProvider {
  /**
   * Upload a single file to the provider.
   */
  upload(file: UploadInput, options?: UploadOptions): Promise<UploadResult>;

  /**
   * Delete a file by its ID. Deleting a file that does not exist succeeds.
   */
  delete(id: string, options?: ResourceOptions): Promise<void>;

  /**
   * Get metadata for a file by its ID.
   * @throws {MediaError} FILE_NOT_FOUND if the file does not exist
   */
  get(id: string, options?: ResourceOptions): Promise<UploadResult>;

  /**
   * Generate a URL for accessing the file, optionally with transformations.
   * For private storage this URL is not readable; use `getSignedUrl()`.
   */
  getUrl(id: string, transform?: TransformationOptions, options?: ResourceOptions): string;

  /**
   * Upload multiple files in batch.
   */
  uploadMultiple(files: UploadInput[], options?: UploadOptions): Promise<UploadResult[]>;

  /**
   * Delete multiple files in batch.
   * @throws {MediaError} DELETE_FAILED listing the IDs that failed
   */
  deleteMultiple(ids: string[], options?: ResourceOptions): Promise<void>;

  /**
   * Create a time-limited URL for reading a private file.
   */
  getSignedUrl?(id: string, options?: SignedUrlOptions): Promise<string>;

  /**
   * Create a signed target the browser can upload a file to directly.
   */
  createUploadUrl?(options: SignedUploadOptions): Promise<SignedUploadTarget>;

  /**
   * Check whether a file exists.
   */
  exists?(id: string, options?: ResourceOptions): Promise<boolean>;

  /**
   * List stored files, page by page.
   */
  list?(options?: ListOptions): Promise<ListResult>;

  /**
   * Search for files.
   */
  search?(query: SearchOptions): Promise<UploadResult[]>;

  /**
   * Copy a file to a new key. Returns the new file.
   */
  copy?(fromId: string, toId: string, options?: ResourceOptions): Promise<UploadResult>;

  /**
   * Move/rename a file. Returns the moved file.
   */
  move?(fromId: string, toId: string, options?: ResourceOptions): Promise<UploadResult>;

  /**
   * Stream a file's contents.
   */
  download?(id: string, options?: ResourceOptions): Promise<DownloadResult>;

  /**
   * Replace a file's custom metadata (primitive values only).
   */
  updateMetadata?(
    id: string,
    metadata: Record<string, unknown>,
    options?: ResourceOptions
  ): Promise<void>;

  /**
   * Access to the native provider client for advanced usage.
   * Type is provider-specific (e.g., cloudinary.v2, S3Client).
   */
  readonly native: unknown;

  /**
   * Feature matrix describing what this provider supports
   */
  readonly features: ProviderFeatures;

  /**
   * Provider name identifier
   */
  readonly name: string;
}

/**
 * Supported upload input types.
 * - `File`: Browser File API object (or Node 20+ global File)
 * - `Buffer`: Node.js Buffer
 * - `Readable`: Node.js readable stream (from `node:stream`)
 * - `ReadableStream<Uint8Array>`: Web Streams API readable stream
 *
 * When providing a stream, set `options.contentType` explicitly since
 * magic-byte detection requires buffering. Streams can only be read once,
 * so they are never retried or sent to a fallback provider.
 */
export type UploadInput =
  | File
  | Buffer
  | import('node:stream').Readable
  | ReadableStream<Uint8Array>;
