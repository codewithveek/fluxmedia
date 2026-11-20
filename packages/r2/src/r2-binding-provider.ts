import type {
  DownloadResult,
  ListOptions,
  ListResult,
  MediaProvider,
  ProviderFeatures,
  ResourceOptions,
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
  createSignedUrl,
  detectContentInfo,
  encodeKeyForUrl,
  extensionFromMime,
  isNodeReadable,
  mapSettled,
  sanitizeFolder,
  stripInternalMetadata,
  throwIfAborted,
  toPersistedMetadata,
} from '@fluxmedia/core';
import { R2Features } from './features';

/** Subset of the Workers `R2Object` type used by this provider. */
export interface R2ObjectLike {
  key: string;
  size: number;
  uploaded: Date;
  httpMetadata?: { contentType?: string; cacheControl?: string; contentDisposition?: string };
  customMetadata?: Record<string, string>;
}

/** Subset of the Workers `R2Bucket` binding used by this provider. */
export interface R2BucketBinding {
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob | null,
    options?: {
      httpMetadata?: { contentType?: string; cacheControl?: string; contentDisposition?: string };
      customMetadata?: Record<string, string>;
    }
  ): Promise<R2ObjectLike | null>;
  get(key: string): Promise<(R2ObjectLike & { body: ReadableStream }) | null>;
  head(key: string): Promise<R2ObjectLike | null>;
  delete(keys: string | string[]): Promise<void>;
  list(options?: {
    prefix?: string;
    limit?: number;
    cursor?: string;
    include?: Array<'httpMetadata' | 'customMetadata'>;
  }): Promise<{ objects: R2ObjectLike[]; truncated: boolean; cursor?: string }>;
}

export interface R2BindingProviderConfig {
  /** The R2 bucket binding from your Worker's `env`. */
  bucket: R2BucketBinding;
  /** Public base URL (custom domain / r2.dev). Unset for private buckets. */
  publicUrl?: string;
  /**
   * Base URL of a route in your Worker that serves files after checking
   * signatures with `verifySignedUrl()`. Required for `getSignedUrl()`.
   */
  signedUrlBase?: string;
  /** Secret (32+ characters) for `getSignedUrl()`. */
  signingSecret?: string;
  /** Append the detected extension to generated keys. Default false. */
  appendExtension?: boolean;
}

const BindingFeatures: ProviderFeatures = {
  ...R2Features,
  capabilities: { ...R2Features.capabilities, signedUploads: false, multipartUpload: false },
};

/**
 * Cloudflare R2 provider for Workers, using an R2 bucket binding instead of
 * the S3 API (no AWS SDK, no credentials).
 *
 * Bindings cannot presign URLs. `getSignedUrl()` instead returns an
 * HMAC-signed URL for a route in your Worker that you verify with
 * `verifySignedUrl()` from `@fluxmedia/core`.
 *
 * Streams must have a known length (e.g. a request body with
 * `Content-Length`, or a `FixedLengthStream`).
 *
 * @example
 * ```typescript
 * export default {
 *   async fetch(request, env) {
 *     const uploader = new MediaUploader(new R2BindingProvider({ bucket: env.MEDIA }));
 *     ...
 *   },
 * };
 * ```
 */
export class R2BindingProvider implements MediaProvider {
  readonly name = 'r2';
  readonly features: ProviderFeatures = BindingFeatures;
  private readonly config!: R2BindingProviderConfig;

  constructor(config: R2BindingProviderConfig) {
    if (!config?.bucket || typeof config.bucket.put !== 'function') {
      throw new MediaError('bucket must be an R2 bucket binding', MediaErrorCode.INVALID_CONFIG, 'r2');
    }
    if (config.signingSecret !== undefined && config.signingSecret.length < 32) {
      throw new MediaError('signingSecret must be at least 32 characters', MediaErrorCode.INVALID_CONFIG, 'r2');
    }
    Object.defineProperty(this, 'config', { value: config, enumerable: false });
  }

  get native(): R2BucketBinding {
    return this.config.bucket;
  }

  async upload(file: UploadInput, options: UploadOptions = {}): Promise<UploadResult> {
    throwIfAborted(options.signal, this.name);
    if (isNodeReadable(file)) {
      throw new MediaError(
        'Node.js streams are not supported by R2 bindings; pass a Web ReadableStream, Blob or Buffer',
        MediaErrorCode.INVALID_FILE_TYPE,
        this.name
      );
    }
    const info = await detectContentInfo(file, options);
    const key = buildStorageKey({
      folder: options.folder,
      filename: options.filename,
      uniqueFilename: options.uniqueFilename,
      extension: this.config.appendExtension ? info.extension : undefined,
    });
    const httpMetadata: { contentType: string; cacheControl?: string; contentDisposition?: string } = {
      contentType: info.contentType,
    };
    if (options.cacheControl) httpMetadata.cacheControl = options.cacheControl;
    if (options.contentDisposition) httpMetadata.contentDisposition = options.contentDisposition;

    try {
      const stored = await this.config.bucket.put(key, file as Blob | ReadableStream | Uint8Array, {
        httpMetadata,
        customMetadata: toPersistedMetadata(options.metadata),
      });
      const size = stored?.size ?? info.size ?? 0;
      options.onByteProgress?.(size, size);
      options.onProgress?.(100);
      return this.toResult(
        stored ?? { key, size, uploaded: new Date(), httpMetadata },
        stripInternalMetadata(options.metadata)
      );
    } catch (error) {
      throw this.wrap(error, MediaErrorCode.UPLOAD_FAILED);
    }
  }

  async delete(id: string): Promise<void> {
    assertSafeKey(id, this.name);
    try {
      await this.config.bucket.delete(id);
    } catch (error) {
      throw this.wrap(error, MediaErrorCode.DELETE_FAILED);
    }
  }

  async deleteMultiple(ids: string[], _options?: ResourceOptions): Promise<void> {
    ids.forEach((id) => assertSafeKey(id, this.name));
    for (let i = 0; i < ids.length; i += 1000) {
      try {
        await this.config.bucket.delete(ids.slice(i, i + 1000));
      } catch (error) {
        throw new MediaError(
          'Failed to delete files',
          MediaErrorCode.DELETE_FAILED,
          this.name,
          error,
          { failedIds: ids.slice(i) }
        );
      }
    }
  }

  async get(id: string): Promise<UploadResult> {
    assertSafeKey(id, this.name);
    const obj = await this.config.bucket.head(id).catch((e) => {
      throw this.wrap(e, MediaErrorCode.PROVIDER_ERROR);
    });
    if (!obj) throw new MediaError('File not found', MediaErrorCode.FILE_NOT_FOUND, this.name);
    return this.toResult(obj, { ...obj.customMetadata });
  }

  async exists(id: string): Promise<boolean> {
    assertSafeKey(id, this.name);
    return (await this.config.bucket.head(id)) !== null;
  }

  getUrl(id: string, _transform?: TransformationOptions): string {
    const base = (this.config.publicUrl ?? this.config.signedUrlBase ?? 'r2://bucket').replace(/\/+$/, '');
    return `${base}/${encodeKeyForUrl(id)}`;
  }

  async getSignedUrl(id: string, options: SignedUrlOptions = {}): Promise<string> {
    assertSafeKey(id, this.name);
    if (!this.config.signedUrlBase || !this.config.signingSecret) {
      throw new MediaError(
        'getSignedUrl requires signedUrlBase and signingSecret for R2 bindings',
        MediaErrorCode.INVALID_CONFIG,
        this.name
      );
    }
    return createSignedUrl(this.config.signedUrlBase, id, {
      secret: this.config.signingSecret,
      expiresIn: clampExpiresIn(options.expiresIn, 3600, 7 * 24 * 3600),
      downloadAs: options.downloadAs,
    });
  }

  async list(options: ListOptions = {}): Promise<ListResult> {
    const folder = sanitizeFolder(options.folder);
    const page = await this.config.bucket.list({
      limit: Math.min(Math.max(options.limit ?? 100, 1), 1000),
      include: ['httpMetadata', 'customMetadata'],
      ...(folder && { prefix: `${folder}/` }),
      ...(options.cursor && { cursor: options.cursor }),
    });
    const result: ListResult = {
      items: page.objects.map((obj) => this.toResult(obj, { ...obj.customMetadata })),
    };
    if (page.truncated && page.cursor) result.nextCursor = page.cursor;
    return result;
  }

  async copy(fromId: string, toId: string): Promise<UploadResult> {
    assertSafeKey(toId, this.name);
    const source = await this.getBody(fromId);
    const putOptions: Parameters<R2BucketBinding['put']>[2] = {};
    if (source.httpMetadata) putOptions.httpMetadata = source.httpMetadata;
    if (source.customMetadata) putOptions.customMetadata = source.customMetadata;
    const stored = await this.config.bucket.put(toId, source.body, putOptions);
    return this.toResult(stored ?? { ...source, key: toId }, { ...source.customMetadata });
  }

  async move(fromId: string, toId: string): Promise<UploadResult> {
    const result = await this.copy(fromId, toId);
    await this.delete(fromId);
    return result;
  }

  async download(id: string): Promise<DownloadResult> {
    const obj = await this.getBody(id);
    const result: DownloadResult = { body: obj.body as ReadableStream<Uint8Array>, size: obj.size };
    if (obj.httpMetadata?.contentType) result.contentType = obj.httpMetadata.contentType;
    return result;
  }

  async updateMetadata(id: string, metadata: Record<string, unknown>): Promise<void> {
    const obj = await this.getBody(id);
    await this.config.bucket.put(id, obj.body, {
      ...(obj.httpMetadata && { httpMetadata: obj.httpMetadata }),
      customMetadata: toPersistedMetadata(metadata),
    });
  }

  async uploadMultiple(files: UploadInput[], options?: UploadOptions): Promise<UploadResult[]> {
    const settled = await mapSettled(files, 5, (f) => this.upload(f, options));
    const failure = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failure) throw failure.reason;
    return settled.map((r) => (r as PromiseFulfilledResult<UploadResult>).value);
  }

  toJSON(): { name: string; features: ProviderFeatures } {
    return { name: this.name, features: this.features };
  }

  private async getBody(id: string) {
    assertSafeKey(id, this.name);
    const obj = await this.config.bucket.get(id);
    if (!obj) throw new MediaError('File not found', MediaErrorCode.FILE_NOT_FOUND, this.name);
    return obj;
  }

  private toResult(obj: R2ObjectLike, metadata: Record<string, unknown>): UploadResult {
    const contentType = obj.httpMetadata?.contentType;
    const result: UploadResult = {
      id: obj.key,
      storageKey: obj.key,
      url: this.getUrl(obj.key),
      size: obj.size,
      format: extensionFromMime(contentType) || (obj.key.includes('.') ? obj.key.split('.').pop()! : ''),
      provider: this.name,
      metadata,
      createdAt: obj.uploaded,
    };
    if (this.config.publicUrl) result.publicUrl = result.url;
    if (contentType) result.contentType = contentType;
    return result;
  }

  private wrap(error: unknown, code: MediaErrorCode): MediaError {
    if (error instanceof MediaError) return error;
    return new MediaError(error instanceof Error ? error.message : String(error), code, this.name, error);
  }
}
