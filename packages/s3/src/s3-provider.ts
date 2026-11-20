import type {
  DownloadResult,
  ListOptions,
  ListResult,
  MediaProvider,
  ProviderFeatures,
  ResourceOptions,
  SignedUploadOptions,
  SignedUploadTarget,
  SignedUrlOptions,
  TransformationOptions,
  UploadInput,
  UploadOptions,
  UploadResult,
} from '@fluxmedia/core';
import {
  MediaError,
  MediaErrorCode,
  assertSafeKey,
  buildStorageKey,
  clampExpiresIn,
  createMediaError,
  decodePersistedMetadata,
  detectContentInfo,
  encodeKeyForUrl,
  extensionFromMime,
  isAbortError,
  mapSettled,
  sanitizeFolder,
  stripInternalMetadata,
  throwIfAborted,
  toPersistedMetadata,
} from '@fluxmedia/core';
import type { S3Client as S3ClientType, S3ClientConfig } from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';
import { S3Features } from './features';
import type { S3Config } from './types';

type S3Sdk = typeof import('@aws-sdk/client-s3');

let sdkPromise: Promise<S3Sdk> | null = null;
let uploadClassPromise: Promise<typeof import('@aws-sdk/lib-storage').Upload> | null = null;
let presignerPromise: Promise<typeof import('@aws-sdk/s3-request-presigner').getSignedUrl> | null =
  null;

function loadSdk(): Promise<S3Sdk> {
  sdkPromise ??= import('@aws-sdk/client-s3');
  return sdkPromise;
}

function loadUploadClass() {
  uploadClassPromise ??= import('@aws-sdk/lib-storage').then((m) => m.Upload);
  return uploadClassPromise;
}

function loadPresigner(provider: string) {
  presignerPromise ??= import('@aws-sdk/s3-request-presigner').then((m) => m.getSignedUrl);
  return presignerPromise.catch((error) => {
    presignerPromise = null;
    throw createMediaError(
      MediaErrorCode.INVALID_CONFIG,
      provider,
      new Error('Signed URLs require @aws-sdk/s3-request-presigner — install it alongside @aws-sdk/client-s3'),
      { cause: String(error) }
    );
  });
}

type Progress = { loaded?: number; total?: number };

const MAX_PRESIGN_SECONDS = 7 * 24 * 60 * 60;
const MIN_PART_SIZE = 5 * 1024 * 1024;
/** Params callers can never override through `providerOptions`. */
const RESERVED_PARAMS = new Set(['Bucket', 'Key', 'Body', 'ContentLength']);

/**
 * Internal options for subclasses (e.g. R2Provider).
 */
export interface S3ProviderInternals {
  name?: string;
  features?: ProviderFeatures;
}

function contentDispositionFor(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * AWS S3 provider implementation (also works with S3-compatible storage).
 * Storage-focused provider without transformation support.
 */
export class S3Provider implements MediaProvider {
  readonly name: string;
  readonly features: ProviderFeatures;

  private client: S3ClientType | null = null;
  private clientPromise: Promise<S3ClientType> | null = null;
  protected readonly config!: S3Config;

  constructor(config: S3Config, internals: S3ProviderInternals = {}) {
    this.name = internals.name ?? 's3';
    this.features = internals.features ?? S3Features;

    const fail = (message: string) =>
      createMediaError(MediaErrorCode.INVALID_CONFIG, this.name, new Error(message));

    if (!config?.bucket) throw fail('Missing required configuration: bucket');
    if (!config.client && !config.region) throw fail('Missing required configuration: region');
    if (!!config.accessKeyId !== !!config.secretAccessKey) {
      throw fail('accessKeyId and secretAccessKey must be provided together');
    }
    if (config.bucket.includes('/')) throw fail('Bucket name cannot contain slashes');
    if (config.multipart?.partSize !== undefined && config.multipart.partSize < MIN_PART_SIZE) {
      throw fail('multipart.partSize must be at least 5 MB');
    }

    // Store config in non-enumerable property to prevent credential exposure
    Object.defineProperty(this, 'config', {
      value: config,
      writable: false,
      enumerable: false,
      configurable: false,
    });
    if (config.client) this.client = config.client;
  }

  /**
   * Get safe config info for debugging (no secrets)
   */
  getConfigInfo(): Record<string, unknown> {
    return {
      bucket: this.config.bucket,
      region: this.config.region,
      endpoint: this.config.endpoint,
      publicUrl: this.config.publicUrl,
    };
  }

  /**
   * The S3 client, created on first use.
   */
  async getClient(): Promise<S3ClientType> {
    if (this.client) return this.client;
    this.clientPromise ??= this.initializeClient();
    return this.clientPromise;
  }

  private async initializeClient(): Promise<S3ClientType> {
    const { S3Client } = await loadSdk();
    const { accessKeyId, secretAccessKey, sessionToken } = this.config;
    const clientConfig: S3ClientConfig = {
      // Presigned PUTs break when the SDK adds default CRC32 checksums, and
      // several S3-compatible services reject them.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      ...this.config.clientConfig,
    };
    if (this.config.region) clientConfig.region = this.config.region;
    if (this.config.endpoint) clientConfig.endpoint = this.config.endpoint;
    if (this.config.forcePathStyle !== undefined) clientConfig.forcePathStyle = this.config.forcePathStyle;
    if (this.config.credentials) {
      clientConfig.credentials = this.config.credentials;
    } else if (accessKeyId && secretAccessKey) {
      clientConfig.credentials = {
        accessKeyId,
        secretAccessKey,
        ...(sessionToken && { sessionToken }),
      };
    }
    const client = new S3Client(clientConfig);
    this.client = client;
    return client;
  }

  async upload(file: UploadInput, options: UploadOptions = {}): Promise<UploadResult> {
    throwIfAborted(options.signal, this.name);
    this.assertVisibility(options.public);
    const client = await this.getClient();
    const Upload = await loadUploadClass();

    const info = await detectContentInfo(file, options);
    const key = buildStorageKey({
      folder: options.folder,
      filename: options.filename,
      uniqueFilename: options.uniqueFilename,
      extension: this.config.appendExtension ? info.extension : undefined,
    });

    const params: Record<string, unknown> = {
      ...this.filterProviderOptions(options.providerOptions),
      Bucket: this.config.bucket,
      Key: key,
      Body: file as Buffer | File | Readable | ReadableStream<Uint8Array>,
      ContentType: info.contentType,
      Metadata: this.persistedMetadata(options.metadata, info.extension),
    };
    if (options.cacheControl) params.CacheControl = options.cacheControl;
    if (options.contentDisposition) params.ContentDisposition = options.contentDisposition;
    if (options.tags?.length) params.Tagging = this.encodeTags(options.tags);
    if (this.config.useAcl && options.public !== undefined) {
      params.ACL = options.public ? 'public-read' : 'private';
    }

    const upload = new Upload({
      client,
      params: params as unknown as ConstructorParameters<typeof Upload>[0]['params'],
      queueSize: this.config.multipart?.queueSize ?? 4,
      partSize: this.config.multipart?.partSize ?? MIN_PART_SIZE,
      leavePartsOnError: false,
    });

    let loaded = 0;
    upload.on('httpUploadProgress', (progress: Progress) => {
      loaded = Math.max(loaded, progress.loaded ?? 0);
      const total = info.size ?? progress.total;
      options.onByteProgress?.(loaded, total);
      if (options.onProgress && total) options.onProgress(Math.min(100, (loaded / total) * 100));
    });

    const onAbort = () => {
      void upload.abort().catch(() => undefined);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      await upload.done();
    } catch (error) {
      if (options.signal?.aborted || isAbortError(error)) {
        throw new MediaError('Upload aborted', MediaErrorCode.ABORTED, this.name, error);
      }
      throw this.mapError(error, MediaErrorCode.UPLOAD_FAILED);
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
    }

    return this.createResult(key, {
      size: info.size ?? loaded,
      extension: info.extension,
      contentType: info.contentType,
      metadata: stripInternalMetadata(options.metadata),
    });
  }

  async delete(id: string, _options?: ResourceOptions): Promise<void> {
    assertSafeKey(id, this.name);
    const client = await this.getClient();
    const { DeleteObjectCommand } = await loadSdk();
    try {
      await client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: id }));
    } catch (error) {
      throw this.mapError(error, MediaErrorCode.DELETE_FAILED);
    }
  }

  /**
   * Delete many objects with `DeleteObjects` (1000 keys per request).
   * @throws {MediaError} DELETE_FAILED with `details.failedIds`
   */
  async deleteMultiple(ids: string[], _options?: ResourceOptions): Promise<void> {
    if (ids.length === 0) return;
    ids.forEach((id) => assertSafeKey(id, this.name));
    const client = await this.getClient();
    const { DeleteObjectsCommand } = await loadSdk();
    const failed: Array<{ id: string; error: unknown }> = [];

    for (let i = 0; i < ids.length; i += 1000) {
      const batch = ids.slice(i, i + 1000);
      try {
        const response = await client.send(
          new DeleteObjectsCommand({
            Bucket: this.config.bucket,
            Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
          })
        );
        for (const err of response.Errors ?? []) {
          failed.push({ id: err.Key ?? '', error: new Error(`${err.Code}: ${err.Message}`) });
        }
      } catch (error) {
        batch.forEach((id) => failed.push({ id, error }));
      }
    }

    if (failed.length > 0) {
      throw createMediaError(
        MediaErrorCode.DELETE_FAILED,
        this.name,
        new Error(
          `Failed to delete ${failed.length} of ${ids.length} files: ${failed.map((f) => f.id).join(', ')}`
        ),
        { failedIds: failed.map((f) => f.id), failed }
      );
    }
  }

  async get(id: string, _options?: ResourceOptions): Promise<UploadResult> {
    assertSafeKey(id, this.name);
    const client = await this.getClient();
    const { HeadObjectCommand } = await loadSdk();

    try {
      const response = await client.send(
        new HeadObjectCommand({ Bucket: this.config.bucket, Key: id })
      );
      const { extension, ...metadata } = decodePersistedMetadata(response.Metadata);
      return this.createResult(id, {
        size: response.ContentLength ?? 0,
        extension: extension || extensionFromMime(response.ContentType) || this.extensionFromKey(id),
        contentType: response.ContentType,
        metadata: { ...metadata, ...(response.ContentType && { contentType: response.ContentType }) },
        createdAt: response.LastModified,
      });
    } catch (error) {
      throw this.mapError(error, MediaErrorCode.PROVIDER_ERROR);
    }
  }

  async exists(id: string): Promise<boolean> {
    try {
      await this.get(id);
      return true;
    } catch (error) {
      if (error instanceof MediaError && error.code === MediaErrorCode.FILE_NOT_FOUND) return false;
      throw error;
    }
  }

  getUrl(id: string, _transform?: TransformationOptions, _options?: ResourceOptions): string {
    // S3 doesn't support transformations; the transform parameter is ignored
    const publicBase = this.publicBase();
    if (publicBase) return `${publicBase}/${encodeKeyForUrl(id)}`;
    return this.objectUrl(id);
  }

  /**
   * Create a presigned GET URL for a private object.
   */
  async getSignedUrl(id: string, options: SignedUrlOptions = {}): Promise<string> {
    assertSafeKey(id, this.name);
    const client = await this.getClient();
    const getSignedUrl = await loadPresigner(this.name);
    const { GetObjectCommand } = await loadSdk();
    const command = new GetObjectCommand({
      Bucket: this.config.bucket,
      Key: id,
      ...(options.downloadAs && {
        ResponseContentDisposition: contentDispositionFor(options.downloadAs),
      }),
    });
    try {
      return await getSignedUrl(client, command, {
        expiresIn: clampExpiresIn(options.expiresIn, 3600, MAX_PRESIGN_SECONDS),
      });
    } catch (error) {
      throw this.mapError(error, MediaErrorCode.PROVIDER_ERROR);
    }
  }

  /**
   * Create a presigned PUT target for a direct browser upload.
   *
   * The content type and — when `size` is given — the exact content length
   * are part of the signature, so storage rejects any other file.
   */
  async createUploadUrl(options: SignedUploadOptions): Promise<SignedUploadTarget> {
    this.assertVisibility(options.public);
    if (!options.contentType) {
      throw createMediaError(MediaErrorCode.INVALID_CONFIG, this.name, new Error('contentType is required'));
    }
    const client = await this.getClient();
    const getSignedUrl = await loadPresigner(this.name);
    const { PutObjectCommand } = await loadSdk();

    const extension = extensionFromMime(options.contentType);
    const key = buildStorageKey({
      folder: options.folder,
      filename: options.filename,
      uniqueFilename: options.uniqueFilename,
      extension: this.config.appendExtension ? extension : undefined,
    });
    const expiresIn = clampExpiresIn(options.expiresIn, 600, MAX_PRESIGN_SECONDS);
    const headers: Record<string, string> = { 'Content-Type': options.contentType };
    if (options.cacheControl) headers['Cache-Control'] = options.cacheControl;
    if (options.contentDisposition) headers['Content-Disposition'] = options.contentDisposition;

    const command = new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: key,
      ContentType: options.contentType,
      Metadata: this.persistedMetadata(options.metadata, extension),
      ...(options.size !== undefined && { ContentLength: options.size }),
      ...(options.cacheControl && { CacheControl: options.cacheControl }),
      ...(options.contentDisposition && { ContentDisposition: options.contentDisposition }),
      ...(this.config.useAcl &&
        options.public !== undefined && {
          ACL: options.public ? ('public-read' as const) : ('private' as const),
        }),
    });

    const signableHeaders = new Set(['content-type']);
    if (options.size !== undefined) signableHeaders.add('content-length');
    if (options.contentDisposition) signableHeaders.add('content-disposition');

    try {
      const uploadUrl = await getSignedUrl(client, command, { expiresIn, signableHeaders });
      const target: SignedUploadTarget = {
        uploadUrl,
        method: 'PUT',
        headers,
        storageKey: key,
        expiresAt: new Date(Date.now() + expiresIn * 1000),
        provider: this.name,
      };
      const publicUrl = this.publicUrlFor(key);
      if (publicUrl) target.publicUrl = publicUrl;
      return target;
    } catch (error) {
      throw this.mapError(error, MediaErrorCode.PROVIDER_ERROR);
    }
  }

  /**
   * List objects with `ListObjectsV2`. The cursor is S3's continuation token.
   */
  async list(options: ListOptions = {}): Promise<ListResult> {
    const client = await this.getClient();
    const { ListObjectsV2Command } = await loadSdk();
    const folder = sanitizeFolder(options.folder);
    try {
      const response = await client.send(
        new ListObjectsV2Command({
          Bucket: this.config.bucket,
          MaxKeys: Math.min(Math.max(options.limit ?? 100, 1), 1000),
          ...(folder && { Prefix: `${folder}/` }),
          ...(options.cursor && { ContinuationToken: options.cursor }),
        })
      );
      const result: ListResult = {
        items: (response.Contents ?? [])
          .filter((obj) => obj.Key)
          .map((obj) =>
            this.createResult(obj.Key!, {
              size: obj.Size ?? 0,
              extension: this.extensionFromKey(obj.Key!),
              metadata: {},
              createdAt: obj.LastModified,
            })
          ),
      };
      if (response.IsTruncated && response.NextContinuationToken) {
        result.nextCursor = response.NextContinuationToken;
      }
      return result;
    } catch (error) {
      throw this.mapError(error, MediaErrorCode.PROVIDER_ERROR);
    }
  }

  async copy(fromId: string, toId: string): Promise<UploadResult> {
    assertSafeKey(fromId, this.name);
    assertSafeKey(toId, this.name);
    const client = await this.getClient();
    const { CopyObjectCommand } = await loadSdk();
    try {
      await client.send(
        new CopyObjectCommand({
          Bucket: this.config.bucket,
          Key: toId,
          CopySource: `${this.config.bucket}/${encodeKeyForUrl(fromId)}`,
          MetadataDirective: 'COPY',
        })
      );
    } catch (error) {
      throw this.mapError(error, MediaErrorCode.PROVIDER_ERROR);
    }
    return this.get(toId);
  }

  async move(fromId: string, toId: string): Promise<UploadResult> {
    const result = await this.copy(fromId, toId);
    await this.delete(fromId);
    return result;
  }

  async download(id: string): Promise<DownloadResult> {
    assertSafeKey(id, this.name);
    const client = await this.getClient();
    const { GetObjectCommand } = await loadSdk();
    try {
      const response = await client.send(
        new GetObjectCommand({ Bucket: this.config.bucket, Key: id })
      );
      if (!response.Body) throw new Error('Empty response body');
      const result: DownloadResult = {
        body: response.Body.transformToWebStream() as ReadableStream<Uint8Array>,
      };
      if (response.ContentType) result.contentType = response.ContentType;
      if (response.ContentLength !== undefined) result.size = response.ContentLength;
      return result;
    } catch (error) {
      throw this.mapError(error, MediaErrorCode.PROVIDER_ERROR);
    }
  }

  /**
   * Replace custom metadata by copying the object onto itself. Content
   * headers, tags, storage class and server-side encryption settings are
   * preserved. (Objects encrypted with customer-provided keys, SSE-C, are not
   * supported.)
   */
  async updateMetadata(id: string, metadata: Record<string, unknown>): Promise<void> {
    assertSafeKey(id, this.name);
    const client = await this.getClient();
    const { CopyObjectCommand, HeadObjectCommand } = await loadSdk();
    try {
      const head = await client.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: id }));
      await client.send(
        new CopyObjectCommand({
          Bucket: this.config.bucket,
          Key: id,
          CopySource: `${this.config.bucket}/${encodeKeyForUrl(id)}`,
          MetadataDirective: 'REPLACE',
          Metadata: this.persistedMetadata(metadata, head.Metadata?.extension ?? ''),
          ...(head.ContentType && { ContentType: head.ContentType }),
          ...(head.CacheControl && { CacheControl: head.CacheControl }),
          ...(head.ContentDisposition && { ContentDisposition: head.ContentDisposition }),
          ...(head.ContentEncoding && { ContentEncoding: head.ContentEncoding }),
          ...(head.ContentLanguage && { ContentLanguage: head.ContentLanguage }),
          // A self-copy otherwise resets the object to STANDARD storage and
          // the bucket's default encryption
          ...(head.StorageClass && { StorageClass: head.StorageClass }),
          ...(head.ServerSideEncryption && { ServerSideEncryption: head.ServerSideEncryption }),
          ...(head.SSEKMSKeyId && { SSEKMSKeyId: head.SSEKMSKeyId }),
          ...(head.BucketKeyEnabled !== undefined && { BucketKeyEnabled: head.BucketKeyEnabled }),
        })
      );
    } catch (error) {
      throw this.mapError(error, MediaErrorCode.PROVIDER_ERROR);
    }
  }

  async uploadMultiple(
    files: UploadInput[],
    options?: UploadOptions & {
      concurrency?: number;
      onBatchProgress?: (completed: number, total: number) => void;
    }
  ): Promise<UploadResult[]> {
    const { concurrency = 5, onBatchProgress, ...uploadOptions } = options ?? {};
    let completed = 0;
    const settled = await mapSettled(files, concurrency, async (file) => {
      const result = await this.upload(file, uploadOptions);
      onBatchProgress?.(++completed, files.length);
      return result;
    });
    const failure = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failure) throw failure.reason;
    return settled.map((r) => (r as PromiseFulfilledResult<UploadResult>).value);
  }

  /**
   * Access to the native AWS S3 client (null until the first request).
   */
  get native(): S3ClientType | null {
    return this.client;
  }

  // Prevent credential exposure in serialization
  toJSON(): { name: string; features: ProviderFeatures } {
    return {
      name: this.name,
      features: this.features,
    };
  }

  /**
   * Base URL for public links, or undefined for a private bucket.
   */
  protected publicBase(): string | undefined {
    return typeof this.config.publicUrl === 'string'
      ? this.config.publicUrl.replace(/\/+$/, '')
      : undefined;
  }

  /**
   * The public URL for a key, or undefined when the bucket is private.
   */
  protected publicUrlFor(key: string): string | undefined {
    if (this.config.publicUrl === false) return undefined;
    return this.getUrl(key);
  }

  /**
   * The storage URL for a key (not necessarily readable).
   */
  protected objectUrl(key: string): string {
    const encoded = encodeKeyForUrl(key);
    if (this.config.endpoint) {
      return `${this.config.endpoint.replace(/\/+$/, '')}/${this.config.bucket}/${encoded}`;
    }
    return `https://${this.config.bucket}.s3.${this.config.region ?? 'us-east-1'}.amazonaws.com/${encoded}`;
  }

  /**
   * Refuse visibility requests the bucket cannot honour, so a file is never
   * silently more public (or less private) than the caller asked for.
   */
  protected assertVisibility(visibility: boolean | undefined): void {
    if (visibility === undefined || this.config.useAcl) return;
    if (visibility && this.config.publicUrl === false) {
      throw createMediaError(
        MediaErrorCode.INVALID_CONFIG,
        this.name,
        new Error('public: true was requested but this bucket is configured as private (publicUrl: false)')
      );
    }
    if (!visibility && typeof this.config.publicUrl === 'string') {
      throw createMediaError(
        MediaErrorCode.INVALID_CONFIG,
        this.name,
        new Error(
          'public: false was requested but this bucket is public (publicUrl is set). Use a private bucket or enable useAcl.'
        )
      );
    }
  }

  private createResult(
    key: string,
    data: {
      size: number;
      extension: string;
      contentType?: string | undefined;
      metadata: Record<string, unknown>;
      createdAt?: Date | undefined;
    }
  ): UploadResult {
    const result: UploadResult = {
      id: key,
      storageKey: key,
      url: this.getUrl(key),
      size: data.size,
      format: data.extension,
      provider: this.name,
      metadata: data.metadata,
      createdAt: data.createdAt ?? new Date(),
    };
    const publicUrl = this.publicUrlFor(key);
    if (publicUrl) result.publicUrl = publicUrl;
    if (data.contentType) result.contentType = data.contentType;
    return result;
  }

  private persistedMetadata(
    metadata: Record<string, unknown> | undefined,
    extension: string
  ): Record<string, string> {
    return { ...toPersistedMetadata(metadata, { ascii: true }), extension };
  }

  private encodeTags(tags: string[]): string {
    return tags
      .slice(0, 10)
      .map((tag) => `${encodeURIComponent(tag)}=`)
      .join('&');
  }

  private filterProviderOptions(options: Record<string, unknown> | undefined): Record<string, unknown> {
    if (!options) return {};
    return Object.fromEntries(Object.entries(options).filter(([k]) => !RESERVED_PARAMS.has(k)));
  }

  private extensionFromKey(key: string): string {
    const name = key.split('/').pop() ?? '';
    return name.includes('.') ? (name.split('.').pop() ?? '').toLowerCase() : '';
  }

  /**
   * Maps S3 errors to MediaError with appropriate codes
   */
  protected mapError(error: unknown, defaultCode: MediaErrorCode): MediaError {
    if (error instanceof MediaError) return error;
    const err = error as {
      name?: string;
      Code?: string;
      message?: string;
      $metadata?: { httpStatusCode?: number };
    };
    const name = err?.name ?? err?.Code;
    const httpCode = err?.$metadata?.httpStatusCode;
    const details = { httpCode, awsCode: name };

    if (name === 'AbortError') {
      return createMediaError(MediaErrorCode.ABORTED, this.name, error, details);
    }
    if (name === 'NoSuchBucket') {
      return createMediaError(
        MediaErrorCode.INVALID_CONFIG,
        this.name,
        new Error(`Bucket '${this.config.bucket}' does not exist`),
        details
      );
    }
    if (name === 'SignatureDoesNotMatch' || name === 'InvalidAccessKeyId' || httpCode === 401) {
      return createMediaError(
        MediaErrorCode.INVALID_CREDENTIALS,
        this.name,
        new Error(`Invalid ${this.name.toUpperCase()} credentials - check the access key and secret`),
        details
      );
    }
    if (name === 'AccessDenied' || httpCode === 403) {
      return createMediaError(
        MediaErrorCode.UNAUTHORIZED,
        this.name,
        new Error(`Access denied - check ${this.name.toUpperCase()} credentials and bucket permissions`),
        details
      );
    }
    if (name === 'NoSuchKey' || name === 'NotFound' || httpCode === 404) {
      return createMediaError(MediaErrorCode.FILE_NOT_FOUND, this.name, new Error('File not found'), details);
    }
    if (name === 'SlowDown' || name === 'TooManyRequests' || httpCode === 429) {
      return createMediaError(
        MediaErrorCode.RATE_LIMITED,
        this.name,
        new Error('Rate limited by storage - try again later'),
        details
      );
    }
    if (name === 'ServiceUnavailable' || httpCode === 503 || httpCode === 500) {
      return createMediaError(
        MediaErrorCode.NETWORK_ERROR,
        this.name,
        new Error('Storage service temporarily unavailable - try again later'),
        details
      );
    }
    if (
      name === 'TimeoutError' ||
      name === 'RequestTimeout' ||
      err?.message?.includes('ETIMEDOUT') ||
      err?.message?.includes('ECONNRESET') ||
      err?.message?.includes('ECONNREFUSED')
    ) {
      return createMediaError(
        MediaErrorCode.NETWORK_ERROR,
        this.name,
        new Error('Network error - check the connection and try again'),
        details
      );
    }
    if (name === 'EntityTooLarge' || httpCode === 413) {
      return createMediaError(
        MediaErrorCode.FILE_TOO_LARGE,
        this.name,
        new Error('File exceeds maximum allowed size'),
        details
      );
    }
    if (name === 'AccessControlListNotSupported') {
      return createMediaError(
        MediaErrorCode.INVALID_CONFIG,
        this.name,
        new Error('This bucket has ACLs disabled; set useAcl: false'),
        details
      );
    }

    return createMediaError(defaultCode, this.name, error, details);
  }
}
