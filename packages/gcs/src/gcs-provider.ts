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
  isBuffer,
  isFileInput,
  isNodeReadable,
  mapSettled,
  sanitizeFolder,
  stripInternalMetadata,
  throwIfAborted,
  toPersistedMetadata,
} from '@fluxmedia/core';
import { PassThrough, Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Storage, StorageOptions } from '@google-cloud/storage';

export interface GCSConfig {
  /** Bucket name. */
  bucket: string;
  /** Google Cloud project ID (optional with Application Default Credentials). */
  projectId?: string;
  /** Path to a service account key file. */
  keyFilename?: string;
  /** Service account credentials object. */
  credentials?: StorageOptions['credentials'];
  /** Use an existing Storage client. */
  storage?: Storage;
  /** Extra Storage client options. */
  storageOptions?: StorageOptions;
  /**
   * Public URL configuration: a base URL (CDN / custom domain), `false` for
   * a private bucket (no `publicUrl`; use signed URLs), or unset to report
   * `https://storage.googleapis.com/<bucket>/<key>`.
   */
  publicUrl?: string | false;
  /**
   * Apply `UploadOptions.public` as an object ACL. Only for buckets with
   * fine-grained access; buckets with uniform bucket-level access reject ACLs.
   */
  useAcl?: boolean;
  /** Append the detected extension to generated keys. Default false. */
  appendExtension?: boolean;
  /** Use resumable uploads above this size in bytes (default 8 MB; streams always). */
  resumableThreshold?: number;
}

export const GCSFeatures: ProviderFeatures = {
  transformations: {
    resize: false,
    crop: false,
    format: false,
    quality: false,
    blur: false,
    rotate: false,
    effects: false,
  },
  capabilities: {
    signedUploads: true,
    directUpload: true,
    multipartUpload: true,
    videoProcessing: false,
    aiTagging: false,
    facialDetection: false,
    signedUrls: true,
    list: true,
    search: false,
    copy: true,
    download: true,
    updateMetadata: true,
  },
  storage: {
    maxFileSize: 5 * 1024 * 1024 * 1024 * 1024, // 5 TiB
    supportedFormats: ['*'],
  },
};

/** Subset of the GCS File API used here. */
interface GcsFile {
  name: string;
  metadata: Record<string, unknown>;
  createWriteStream(options: Record<string, unknown>): Writable;
  createReadStream(): Readable;
  delete(options?: { ignoreNotFound?: boolean }): Promise<unknown>;
  getMetadata(): Promise<[Record<string, unknown>, ...unknown[]]>;
  setMetadata(metadata: Record<string, unknown>): Promise<unknown>;
  exists(): Promise<[boolean]>;
  getSignedUrl(config: Record<string, unknown>): Promise<[string]>;
  copy(destination: GcsFile): Promise<unknown>;
  move(destination: string | GcsFile): Promise<unknown>;
}

interface GcsBucket {
  file(name: string): GcsFile;
  getFiles(query: Record<string, unknown>): Promise<[GcsFile[], { pageToken?: string } | null, ...unknown[]]>;
}

const MAX_SIGNED_SECONDS = 7 * 24 * 3600;
const RESERVED = new Set(['metadata', 'contentType', 'resumable', 'predefinedAcl']);

/**
 * Google Cloud Storage provider.
 *
 * Without explicit credentials it uses Application Default Credentials
 * (Workload Identity, GCE/Cloud Run service accounts, `gcloud auth`).
 */
export class GCSProvider implements MediaProvider {
  readonly name = 'gcs';
  readonly features: ProviderFeatures = GCSFeatures;
  private storage: Storage | null = null;
  private storagePromise: Promise<Storage> | null = null;
  private readonly config!: GCSConfig;

  constructor(config: GCSConfig) {
    if (!config?.bucket) throw new MediaError('bucket is required', MediaErrorCode.INVALID_CONFIG, 'gcs');
    if (config.bucket.includes('/')) {
      throw new MediaError('Bucket name cannot contain slashes', MediaErrorCode.INVALID_CONFIG, 'gcs');
    }
    Object.defineProperty(this, 'config', { value: config, enumerable: false });
    if (config.storage) this.storage = config.storage;
  }

  get native(): Storage | null {
    return this.storage;
  }

  async getStorage(): Promise<Storage> {
    if (this.storage) return this.storage;
    this.storagePromise ??= import('@google-cloud/storage').then(({ Storage }) => {
      const storage = new Storage({
        ...this.config.storageOptions,
        ...(this.config.projectId && { projectId: this.config.projectId }),
        ...(this.config.keyFilename && { keyFilename: this.config.keyFilename }),
        ...(this.config.credentials && { credentials: this.config.credentials }),
      });
      this.storage = storage;
      return storage;
    });
    return this.storagePromise;
  }

  private async bucket(): Promise<GcsBucket> {
    return (await this.getStorage()).bucket(this.config.bucket) as unknown as GcsBucket;
  }

  private async file(key: string): Promise<GcsFile> {
    assertSafeKey(key, this.name);
    return (await this.bucket()).file(key);
  }

  async upload(file: UploadInput, options: UploadOptions = {}): Promise<UploadResult> {
    throwIfAborted(options.signal, this.name);
    this.assertVisibility(options.public);
    const info = await detectContentInfo(file, options);
    const key = buildStorageKey({
      folder: options.folder,
      filename: options.filename,
      uniqueFilename: options.uniqueFilename,
      extension: this.config.appendExtension ? info.extension : undefined,
    });
    const target = await this.file(key);

    const writeOptions: Record<string, unknown> = {
      ...this.filterProviderOptions(options.providerOptions),
      contentType: info.contentType,
      resumable: info.size === undefined || info.size > (this.config.resumableThreshold ?? 8 * 1024 * 1024),
      metadata: {
        contentType: info.contentType,
        ...(options.cacheControl && { cacheControl: options.cacheControl }),
        ...(options.contentDisposition && { contentDisposition: options.contentDisposition }),
        metadata: { ...toPersistedMetadata(options.metadata), ...this.tagMetadata(options.tags) },
      },
    };
    if (this.config.useAcl && options.public !== undefined) {
      writeOptions.predefinedAcl = options.public ? 'publicRead' : 'private';
    }

    let loaded = 0;
    const counter = new PassThrough();
    counter.on('data', (chunk: Buffer) => {
      loaded += chunk.length;
      options.onByteProgress?.(loaded, info.size);
      if (options.onProgress && info.size) options.onProgress(Math.min(100, (loaded / info.size) * 100));
    });

    try {
      await pipeline(this.toReadable(file), counter, target.createWriteStream(writeOptions), {
        ...(options.signal && { signal: options.signal }),
      });
    } catch (error) {
      if (options.signal?.aborted) throw new MediaError('Upload aborted', MediaErrorCode.ABORTED, this.name, error);
      throw this.mapError(error, MediaErrorCode.UPLOAD_FAILED);
    }

    return this.createResult(key, {
      size: info.size ?? loaded,
      extension: info.extension,
      contentType: info.contentType,
      metadata: stripInternalMetadata(options.metadata),
    });
  }

  async delete(id: string): Promise<void> {
    try {
      await (await this.file(id)).delete({ ignoreNotFound: true });
    } catch (error) {
      throw this.mapError(error, MediaErrorCode.DELETE_FAILED);
    }
  }

  async deleteMultiple(ids: string[], _options?: ResourceOptions): Promise<void> {
    const settled = await mapSettled(ids, 10, (id) => this.delete(id));
    const failed = ids.filter((_, i) => settled[i]!.status === 'rejected');
    if (failed.length) {
      throw createMediaError(
        MediaErrorCode.DELETE_FAILED,
        this.name,
        new Error(`Failed to delete ${failed.length} of ${ids.length} files: ${failed.join(', ')}`),
        { failedIds: failed }
      );
    }
  }

  async get(id: string): Promise<UploadResult> {
    try {
      const [metadata] = await (await this.file(id)).getMetadata();
      return this.fromMetadata(id, metadata);
    } catch (error) {
      throw this.mapError(error, MediaErrorCode.PROVIDER_ERROR);
    }
  }

  async exists(id: string): Promise<boolean> {
    try {
      const [exists] = await (await this.file(id)).exists();
      return exists;
    } catch (error) {
      throw this.mapError(error, MediaErrorCode.PROVIDER_ERROR);
    }
  }

  getUrl(id: string, _transform?: TransformationOptions): string {
    const base =
      typeof this.config.publicUrl === 'string'
        ? this.config.publicUrl.replace(/\/+$/, '')
        : `https://storage.googleapis.com/${this.config.bucket}`;
    return `${base}/${encodeKeyForUrl(id)}`;
  }

  async getSignedUrl(id: string, options: SignedUrlOptions = {}): Promise<string> {
    const expiresIn = clampExpiresIn(options.expiresIn, 3600, MAX_SIGNED_SECONDS);
    try {
      const [url] = await (await this.file(id)).getSignedUrl({
        version: 'v4',
        action: 'read',
        expires: Date.now() + expiresIn * 1000,
        ...(options.downloadAs && {
          responseDisposition: `attachment; filename="${options.downloadAs.replace(/[^\x20-\x7e]|["\\]/g, '_')}"`,
        }),
      });
      return url;
    } catch (error) {
      throw this.mapError(error, MediaErrorCode.PROVIDER_ERROR);
    }
  }

  /**
   * V4 signed PUT URL. The content type is signed; with `size`, the
   * `x-goog-content-length-range` header caps the upload at that size.
   */
  async createUploadUrl(options: SignedUploadOptions): Promise<SignedUploadTarget> {
    this.assertVisibility(options.public);
    const extension = extensionFromMime(options.contentType);
    const key = buildStorageKey({
      folder: options.folder,
      filename: options.filename,
      uniqueFilename: options.uniqueFilename,
      extension: this.config.appendExtension ? extension : undefined,
    });
    const expiresIn = clampExpiresIn(options.expiresIn, 600, MAX_SIGNED_SECONDS);
    const extensionHeaders: Record<string, string> = {};
    if (options.size !== undefined) extensionHeaders['x-goog-content-length-range'] = `0,${options.size}`;
    for (const [k, v] of Object.entries(toPersistedMetadata(options.metadata, { ascii: true }))) {
      extensionHeaders[`x-goog-meta-${k}`] = v;
    }
    if (options.cacheControl) extensionHeaders['cache-control'] = options.cacheControl;

    try {
      const [uploadUrl] = await (await this.file(key)).getSignedUrl({
        version: 'v4',
        action: 'write',
        expires: Date.now() + expiresIn * 1000,
        contentType: options.contentType,
        extensionHeaders,
      });
      const target: SignedUploadTarget = {
        uploadUrl,
        method: 'PUT',
        headers: { 'Content-Type': options.contentType, ...extensionHeaders },
        storageKey: key,
        expiresAt: new Date(Date.now() + expiresIn * 1000),
        provider: this.name,
      };
      if (this.config.publicUrl !== false) target.publicUrl = this.getUrl(key);
      return target;
    } catch (error) {
      throw this.mapError(error, MediaErrorCode.PROVIDER_ERROR);
    }
  }

  async list(options: ListOptions = {}): Promise<ListResult> {
    const folder = sanitizeFolder(options.folder);
    try {
      const [files, next] = await (await this.bucket()).getFiles({
        autoPaginate: false,
        maxResults: Math.min(Math.max(options.limit ?? 100, 1), 1000),
        ...(folder && { prefix: `${folder}/` }),
        ...(options.cursor && { pageToken: options.cursor }),
      });
      const result: ListResult = { items: files.map((f) => this.fromMetadata(f.name, f.metadata)) };
      if (next?.pageToken) result.nextCursor = next.pageToken;
      return result;
    } catch (error) {
      throw this.mapError(error, MediaErrorCode.PROVIDER_ERROR);
    }
  }

  async copy(fromId: string, toId: string): Promise<UploadResult> {
    try {
      await (await this.file(fromId)).copy(await this.file(toId));
    } catch (error) {
      throw this.mapError(error, MediaErrorCode.PROVIDER_ERROR);
    }
    return this.get(toId);
  }

  async move(fromId: string, toId: string): Promise<UploadResult> {
    try {
      await (await this.file(fromId)).move(await this.file(toId));
    } catch (error) {
      throw this.mapError(error, MediaErrorCode.PROVIDER_ERROR);
    }
    return this.get(toId);
  }

  async download(id: string): Promise<DownloadResult> {
    const info = await this.get(id);
    const stream = (await this.file(id)).createReadStream();
    const result: DownloadResult = {
      body: Readable.toWeb(stream) as ReadableStream<Uint8Array>,
      size: info.size,
    };
    if (info.contentType) result.contentType = info.contentType;
    return result;
  }

  /**
   * Replace custom metadata (GCS merges by default, so removed keys are
   * explicitly cleared).
   */
  async updateMetadata(id: string, metadata: Record<string, unknown>): Promise<void> {
    try {
      const file = await this.file(id);
      const [current] = await file.getMetadata();
      const existing = (current.metadata as Record<string, string> | undefined) ?? {};
      const next: Record<string, string | null> = Object.fromEntries(Object.keys(existing).map((k) => [k, null]));
      Object.assign(next, toPersistedMetadata(metadata));
      await file.setMetadata({ metadata: next });
    } catch (error) {
      throw this.mapError(error, MediaErrorCode.PROVIDER_ERROR);
    }
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

  private assertVisibility(visibility: boolean | undefined): void {
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
        new Error('public: false was requested but this bucket is public (publicUrl is set). Enable useAcl or use a private bucket.')
      );
    }
  }

  private tagMetadata(tags: string[] | undefined): Record<string, string> {
    return tags?.length ? { tags: tags.join(',') } : {};
  }

  private filterProviderOptions(options: Record<string, unknown> | undefined): Record<string, unknown> {
    if (!options) return {};
    return Object.fromEntries(Object.entries(options).filter(([k]) => !RESERVED.has(k)));
  }

  private toReadable(file: UploadInput): Readable {
    if (isNodeReadable(file)) return file;
    if (isBuffer(file)) return Readable.from([file]);
    const web = isFileInput(file) ? file.stream() : (file as ReadableStream<Uint8Array>);
    return Readable.fromWeb(web as import('node:stream/web').ReadableStream<Uint8Array>);
  }

  private fromMetadata(key: string, metadata: Record<string, unknown>): UploadResult {
    const contentType = metadata.contentType as string | undefined;
    return this.createResult(key, {
      size: Number(metadata.size ?? 0),
      extension: extensionFromMime(contentType) || (key.includes('.') ? key.split('.').pop()!.toLowerCase() : ''),
      contentType,
      metadata: decodePersistedMetadata(metadata.metadata as Record<string, string> | undefined),
      createdAt: metadata.timeCreated ? new Date(String(metadata.timeCreated)) : undefined,
    });
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
    if (this.config.publicUrl !== false) result.publicUrl = result.url;
    if (data.contentType) result.contentType = data.contentType;
    return result;
  }

  private mapError(error: unknown, defaultCode: MediaErrorCode): MediaError {
    if (error instanceof MediaError) return error;
    const err = error as { code?: number | string; message?: string; name?: string };
    const status = typeof err?.code === 'number' ? err.code : undefined;
    const details = { httpCode: status };
    if (err?.name === 'AbortError') return createMediaError(MediaErrorCode.ABORTED, this.name, error, details);
    if (status === 404) return createMediaError(MediaErrorCode.FILE_NOT_FOUND, this.name, new Error('File not found'), details);
    if (status === 401) return createMediaError(MediaErrorCode.INVALID_CREDENTIALS, this.name, error, details);
    if (status === 403) return createMediaError(MediaErrorCode.UNAUTHORIZED, this.name, error, details);
    if (status === 429) return createMediaError(MediaErrorCode.RATE_LIMITED, this.name, error, details);
    if (status === 413) return createMediaError(MediaErrorCode.FILE_TOO_LARGE, this.name, error, details);
    if (status !== undefined && status >= 500) return createMediaError(MediaErrorCode.PROVIDER_ERROR, this.name, error, details);
    if (typeof err?.code === 'string' && /^(ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND)$/.test(err.code)) {
      return createMediaError(MediaErrorCode.NETWORK_ERROR, this.name, error, details);
    }
    return createMediaError(defaultCode, this.name, error, details);
  }
}
