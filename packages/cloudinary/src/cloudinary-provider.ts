import type {
  DownloadResult,
  ListOptions,
  ListResult,
  MediaProvider,
  ProviderFeatures,
  ResourceOptions,
  SearchOptions,
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
  detectContentInfo,
  encodeKeyForUrl,
  extensionFromMime,
  isBuffer,
  isFileInput,
  isNodeReadable,
  mapSettled,
  mimeFromExtension,
  sanitizeFolder,
  throwIfAborted,
  toPersistedMetadata,
} from '@fluxmedia/core';
import { PassThrough, Readable, pipeline } from 'node:stream';
import { CloudinaryFeatures } from './features';
import type {
  CloudinaryClient,
  CloudinaryConfig,
  CloudinaryDeliveryType,
  CloudinaryResourceType,
  CloudinaryUploadOptions,
  CloudinaryUploadResponse,
} from './types';

// Cached SDK import (shared across instances; credentials are passed per call)
let sdkPromise: Promise<CloudinaryClient> | null = null;

function getCloudinarySDK(): Promise<CloudinaryClient> {
  sdkPromise ??= import('cloudinary').then((m) => m.v2);
  return sdkPromise;
}

type ResolvedCloudinaryConfig = CloudinaryConfig & { secure: boolean };
type LooseFn = (...args: unknown[]) => Promise<Record<string, unknown>>;

const RESOURCE_TYPES: CloudinaryResourceType[] = ['image', 'video', 'raw'];
const CHUNK_SIZE = 64 * 1024;
/** Cloudinary rejects upload signatures older than one hour. */
const SIGNATURE_TTL_SECONDS = 3600;
/** Params callers can never override through `providerOptions`. */
const RESERVED_PARAMS = new Set([
  'public_id',
  'file',
  'cloud_name',
  'api_key',
  'api_secret',
  'signature',
  'timestamp',
]);

/**
 * Cloudinary provider implementation.
 * Provides full-featured media upload with transformations, AI tagging, and more.
 *
 * Credentials are passed with every request rather than through the global
 * `cloudinary.config()`, so several providers with different accounts can
 * coexist in one process.
 */
export class CloudinaryProvider implements MediaProvider {
  readonly name: string = 'cloudinary';
  readonly features: ProviderFeatures = CloudinaryFeatures;

  private client: CloudinaryClient | null = null;
  private config!: ResolvedCloudinaryConfig;

  constructor(config: CloudinaryConfig) {
    const required: (keyof CloudinaryConfig)[] = ['cloudName', 'apiKey', 'apiSecret'];
    const missing = required.filter((field) => !config?.[field]);

    if (missing.length > 0) {
      throw createMediaError(
        MediaErrorCode.INVALID_CONFIG,
        'cloudinary',
        new Error(`Missing required Cloudinary configuration: ${missing.join(', ')}`)
      );
    }

    if (typeof config.cloudName !== 'string' || config.cloudName.trim().length === 0) {
      throw createMediaError(
        MediaErrorCode.INVALID_CONFIG,
        'cloudinary',
        new Error('cloudName must be a non-empty string')
      );
    }

    // Store config in a non-enumerable property to prevent credential exposure
    Object.defineProperty(this, 'config', {
      value: { ...config, secure: config.secure ?? true },
      writable: false,
      enumerable: false,
      configurable: false,
    });
  }

  /**
   * Prevent credentials from being exposed via JSON.stringify
   */
  toJSON() {
    return {
      name: this.name,
      features: this.features,
    };
  }

  /**
   * Get safe config info for debugging (no secrets)
   */
  getConfigInfo() {
    return {
      cloudName: this.config.cloudName,
      secure: this.config.secure,
    };
  }

  /**
   * Access to the native Cloudinary SDK (null until the first request).
   * The SDK's global config is not set; pass `this.credentials()`-style
   * options (cloud_name, api_key, api_secret) when calling it directly.
   */
  get native(): CloudinaryClient | null {
    return this.client;
  }

  private async ensureClient(): Promise<CloudinaryClient> {
    this.client ??= await getCloudinarySDK();
    return this.client;
  }

  /** Per-request credentials. */
  private credentials() {
    return {
      cloud_name: this.config.cloudName,
      api_key: this.config.apiKey,
      api_secret: this.config.apiSecret,
      secure: this.config.secure,
      ...(this.config.secureDistribution && {
        secure_distribution: this.config.secureDistribution,
        private_cdn: true,
      }),
    };
  }

  async upload(file: UploadInput, options: UploadOptions = {}): Promise<UploadResult> {
    throwIfAborted(options.signal, this.name);
    const client = await this.ensureClient();

    try {
      const info = await detectContentInfo(file, options);
      const params = this.mapOptions(options, info.contentType);
      options.onProgress?.(0);
      const result = await this.uploadFromStream(client, this.toReadable(file), params, options, info.size);
      options.onProgress?.(100);
      return this.normalizeResult(result);
    } catch (error) {
      throw this.mapCloudinaryError(error, 'upload');
    }
  }

  async delete(id: string, options?: ResourceOptions): Promise<void> {
    assertSafeKey(id, this.name);
    const client = await this.ensureClient();
    const { resourceTypes, type } = this.hints(options);

    try {
      for (const resourceType of resourceTypes) {
        const result = (await client.uploader.destroy(id, {
          ...this.credentials(),
          resource_type: resourceType,
          type,
          invalidate: true,
        } as never)) as { result?: string };
        if (result?.result === 'ok') return;
        if (result?.result !== 'not found') throw new Error(`Delete failed: ${result?.result}`);
      }
      // Not found under any resource type: already deleted
    } catch (error) {
      throw this.mapCloudinaryError(error, 'delete');
    }
  }

  async get(id: string, options?: ResourceOptions): Promise<UploadResult> {
    assertSafeKey(id, this.name);
    const client = await this.ensureClient();
    const { resourceTypes, type } = this.hints(options);

    let lastError: unknown;
    for (const resourceType of resourceTypes) {
      try {
        const resource = await (client.api.resource as unknown as LooseFn)(id, {
          ...this.credentials(),
          resource_type: resourceType,
          type,
        });
        return this.normalizeResult(resource as unknown as CloudinaryUploadResponse);
      } catch (error) {
        lastError = error;
        if (this.httpCode(error) !== 404) break;
      }
    }
    throw this.mapCloudinaryError(lastError, 'get');
  }

  async exists(id: string, options?: ResourceOptions): Promise<boolean> {
    try {
      await this.get(id, options);
      return true;
    } catch (error) {
      if (error instanceof MediaError && error.code === MediaErrorCode.FILE_NOT_FOUND) return false;
      throw error;
    }
  }

  getUrl(id: string, transform?: TransformationOptions, options?: ResourceOptions): string {
    const { resourceTypes, type } = this.hints(options);
    const resourceType = resourceTypes[0]!;

    if (this.client) {
      return this.client.url(id, {
        ...this.credentials(),
        resource_type: resourceType,
        type,
        ...(transform && { transformation: [this.mapTransformations(transform)] }),
      });
    }

    // SDK not loaded yet: construct the URL manually
    const protocol = this.config.secure ? 'https' : 'http';
    const host = this.config.secureDistribution ?? `res.cloudinary.com/${this.config.cloudName}`;
    const transformPath = transform ? this.buildTransformationPath(transform) : '';
    const path = [resourceType, type, transformPath, encodeKeyForUrl(id)].filter(Boolean).join('/');
    return `${protocol}://${host}/${path}`;
  }

  /**
   * Create an expiring URL for a file.
   *
   * - `authenticated`/`private` assets with `authTokenKey`: a
   *   token-authenticated delivery URL (supports transformations).
   * - `authenticated`/`private` assets without it: a private download URL for
   *   the original file (transformations are not available).
   * - Public (`upload`) assets: their delivery URL. They are readable by
   *   anyone, so a signature would not restrict access.
   *
   * Pass the `UploadResult` (or its metadata) to skip an Admin API lookup of
   * the asset's resource type, delivery type and format.
   */
  async getSignedUrl(id: string, options: SignedUrlOptions = {}): Promise<string> {
    assertSafeKey(id, this.name);
    const client = await this.ensureClient();
    const expiresIn = clampExpiresIn(options.expiresIn, 3600, 30 * 24 * 3600);

    const meta = options.metadata ?? {};
    let hints: ResourceOptions = options;
    let format = typeof meta.format === 'string' ? meta.format : '';
    if (!meta.resourceType || !meta.type || !format) {
      const resource = await this.get(id, options);
      format = resource.format;
      hints = { metadata: resource.metadata };
    }
    const { resourceTypes, type } = this.hints(hints);
    const resourceType = resourceTypes[0]!;
    const transformation = options.transform ? [this.mapTransformations(options.transform)] : undefined;
    const attachment = options.downloadAs
      ? { flags: `attachment:${options.downloadAs.replace(/\.[^.]+$/, '').replace(/[^\w-]/g, '_')}` }
      : {};

    if (type === 'upload') {
      return client.url(id, {
        ...this.credentials(),
        resource_type: resourceType,
        type,
        ...(transformation && { transformation }),
        ...attachment,
      });
    }

    if (this.config.authTokenKey) {
      return client.url(id, {
        ...this.credentials(),
        resource_type: resourceType,
        type,
        sign_url: true,
        auth_token: { key: this.config.authTokenKey, duration: expiresIn } as never,
        ...(transformation && { transformation }),
        ...attachment,
      });
    }

    if (options.transform) {
      throw createMediaError(
        MediaErrorCode.NOT_SUPPORTED,
        this.name,
        new Error('Expiring URLs with transformations require authTokenKey (token-based authentication)')
      );
    }

    return client.utils.private_download_url(id, format, {
      ...this.credentials(),
      resource_type: resourceType,
      type,
      expires_at: Math.floor(Date.now() / 1000) + expiresIn,
      attachment: !!options.downloadAs,
    } as never);
  }

  /**
   * Create signed upload parameters for a direct browser upload (multipart
   * POST to the Cloudinary upload API).
   *
   * The signature fixes the public ID, folder, tags, context and delivery
   * type, and `allowed_formats` for images/videos. Cloudinary signatures
   * cannot enforce a maximum size — use an upload preset with limits, or the
   * proxy handler, when that matters.
   */
  async createUploadUrl(options: SignedUploadOptions): Promise<SignedUploadTarget> {
    const client = await this.ensureClient();
    const resourceType = this.resourceTypeFromContentType(options.contentType);
    const publicId = buildStorageKey({
      folder: options.folder,
      filename: options.filename,
      uniqueFilename: options.uniqueFilename,
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const params: Record<string, string> = { timestamp: String(timestamp), public_id: publicId };
    if (options.tags?.length) params.tags = options.tags.join(',');
    const context = toPersistedMetadata(options.metadata);
    if (Object.keys(context).length) {
      params.context = Object.entries(context)
        .map(([k, v]) => `${k}=${v.replace(/([|=])/g, '\\$1')}`)
        .join('|');
    }
    if (options.public === false) params.type = 'authenticated';
    const format = extensionFromMime(options.contentType);
    if ((resourceType === 'image' || resourceType === 'video') && format) {
      params.allowed_formats = format === 'jpg' ? 'jpg,jpeg' : format;
    }

    const signature = client.utils.api_sign_request(params, this.config.apiSecret);
    const target: SignedUploadTarget = {
      uploadUrl: `https://api.cloudinary.com/v1_1/${encodeURIComponent(this.config.cloudName)}/${resourceType}/upload`,
      method: 'POST',
      fields: { ...params, api_key: this.config.apiKey, signature },
      storageKey: publicId,
      expiresAt: new Date((timestamp + SIGNATURE_TTL_SECONDS) * 1000),
      provider: this.name,
    };
    // With resource type 'auto' the final type (and so the URL) is only known after upload
    if (options.public !== false && resourceType !== 'auto') {
      target.publicUrl = this.getUrl(publicId, undefined, { metadata: { resourceType } });
    }
    return target;
  }

  /**
   * List assets under a folder with the Search API (all resource types).
   * Search results are indexed asynchronously, so very recent uploads may
   * take a moment to appear.
   */
  async list(options: ListOptions = {}): Promise<ListResult> {
    const folder = sanitizeFolder(options.folder);
    const { items, nextCursor } = await this.runSearch(
      folder ? `public_id:${this.escapeSearch(folder)}/*` : '',
      Math.min(Math.max(options.limit ?? 100, 1), 500),
      options.cursor
    );
    return nextCursor ? { items, nextCursor } : { items };
  }

  /**
   * Search assets by text, folder and tags (Search API). `offset` is not
   * supported; use `list()` cursors to page.
   */
  async search(query: SearchOptions): Promise<UploadResult[]> {
    const parts: string[] = [];
    if (query.query) parts.push(`"${query.query.replace(/["\\]/g, '\\$&')}"`);
    const folder = sanitizeFolder(query.folder);
    if (folder) parts.push(`public_id:${this.escapeSearch(folder)}/*`);
    for (const tag of query.tags ?? []) parts.push(`tags="${tag.replace(/["\\]/g, '\\$&')}"`);
    const { items } = await this.runSearch(parts.join(' AND '), Math.min(query.limit ?? 100, 500));
    return items;
  }

  /**
   * Copy an asset by re-uploading it from its (signed) URL.
   */
  async copy(fromId: string, toId: string, options?: ResourceOptions): Promise<UploadResult> {
    assertSafeKey(toId, this.name);
    const client = await this.ensureClient();
    const source = await this.get(fromId, options);
    const type = (source.metadata.type as CloudinaryDeliveryType | undefined) ?? 'upload';
    const sourceUrl =
      type === 'upload' ? source.url : await this.getSignedUrl(fromId, { metadata: source.metadata, expiresIn: 600 });
    try {
      const result = await client.uploader.upload(sourceUrl, {
        ...this.credentials(),
        public_id: toId,
        resource_type: source.metadata.resourceType as CloudinaryResourceType,
        type,
        overwrite: false,
      } as never);
      return this.normalizeResult(result as unknown as CloudinaryUploadResponse);
    } catch (error) {
      throw this.mapCloudinaryError(error, 'upload');
    }
  }

  async move(fromId: string, toId: string, options?: ResourceOptions): Promise<UploadResult> {
    assertSafeKey(fromId, this.name);
    assertSafeKey(toId, this.name);
    const client = await this.ensureClient();
    const source = options?.metadata?.resourceType ? null : await this.get(fromId, options);
    const { resourceTypes, type } = this.hints(source ? { metadata: source.metadata } : options);
    try {
      const result = await client.uploader.rename(fromId, toId, {
        ...this.credentials(),
        resource_type: resourceTypes[0],
        type,
        overwrite: false,
        invalidate: true,
      } as never);
      return this.normalizeResult(result as unknown as CloudinaryUploadResponse);
    } catch (error) {
      throw this.mapCloudinaryError(error, 'get');
    }
  }

  async download(id: string, options?: ResourceOptions): Promise<DownloadResult> {
    const resource = await this.get(id, options);
    const url =
      resource.metadata.type === 'upload'
        ? resource.url
        : await this.getSignedUrl(id, { metadata: resource.metadata, expiresIn: 300 });
    const response = await fetch(url);
    if (!response.ok || !response.body) {
      throw createMediaError(
        response.status === 404 ? MediaErrorCode.FILE_NOT_FOUND : MediaErrorCode.PROVIDER_ERROR,
        this.name,
        new Error(`Download failed with HTTP ${response.status}`)
      );
    }
    const result: DownloadResult = { body: response.body as ReadableStream<Uint8Array> };
    const contentType = response.headers.get('content-type');
    if (contentType) result.contentType = contentType;
    const length = Number(response.headers.get('content-length'));
    if (length) result.size = length;
    return result;
  }

  /**
   * Replace an asset's contextual metadata (primitive values only).
   */
  async updateMetadata(
    id: string,
    metadata: Record<string, unknown>,
    options?: ResourceOptions
  ): Promise<void> {
    assertSafeKey(id, this.name);
    const client = await this.ensureClient();
    const source = options?.metadata?.resourceType ? null : await this.get(id, options);
    const { resourceTypes, type } = this.hints(source ? { metadata: source.metadata } : options);
    try {
      await (client.api.update as unknown as LooseFn)(id, {
        ...this.credentials(),
        resource_type: resourceTypes[0],
        type,
        context: toPersistedMetadata(metadata),
      });
    } catch (error) {
      throw this.mapCloudinaryError(error, 'get');
    }
  }

  async uploadMultiple(
    files: UploadInput[],
    options?: UploadOptions & {
      concurrency?: number;
      onBatchProgress?: (completed: number, total: number) => void;
    }
  ): Promise<UploadResult[]> {
    const { onProgress, concurrency = 5, onBatchProgress, ...rest } = options ?? {};
    const fileProgress = new Array<number>(files.length).fill(0);
    let completed = 0;

    const settled = await mapSettled(files, concurrency, async (file, index) => {
      const fileOptions: UploadOptions = { ...rest };
      if (onProgress) {
        fileOptions.onProgress = (percent: number) => {
          fileProgress[index] = percent;
          const overall = fileProgress.reduce((a, b) => a + b, 0) / files.length;
          onProgress(Math.round(overall));
        };
      }
      const result = await this.upload(file, fileOptions);
      onBatchProgress?.(++completed, files.length);
      return result;
    });
    const failure = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failure) throw failure.reason;
    return settled.map((r) => (r as PromiseFulfilledResult<UploadResult>).value);
  }

  async deleteMultiple(ids: string[], options?: ResourceOptions): Promise<void> {
    const settled = await mapSettled(ids, 10, (id) => this.delete(id, options));
    const failed = settled
      .map((r, i) => ({ r, id: ids[i]! }))
      .filter((x) => x.r.status === 'rejected')
      .map((x) => ({ id: x.id, error: (x.r as PromiseRejectedResult).reason as unknown }));

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

  /**
   * Resource types to try and the delivery type, from hints.
   */
  private hints(options?: ResourceOptions): {
    resourceTypes: CloudinaryResourceType[];
    type: CloudinaryDeliveryType;
  } {
    const meta = options?.metadata ?? {};
    const resourceType = meta.resourceType as CloudinaryResourceType | undefined;
    const type = (meta.type as CloudinaryDeliveryType | undefined) ?? 'upload';
    return {
      resourceTypes: resourceType && RESOURCE_TYPES.includes(resourceType) ? [resourceType] : RESOURCE_TYPES,
      type: ['upload', 'authenticated', 'private'].includes(type) ? type : 'upload',
    };
  }

  private async runSearch(
    expression: string,
    limit: number,
    cursor?: string
  ): Promise<{ items: UploadResult[]; nextCursor?: string }> {
    const client = await this.ensureClient();
    try {
      let search = client.search.expression(expression).max_results(limit).with_field('context').with_field('tags');
      if (cursor) search = search.next_cursor(cursor);
      const response = (await (search.execute as unknown as LooseFn)(this.credentials())) as {
        resources?: CloudinaryUploadResponse[];
        next_cursor?: string;
      };
      const items = (response.resources ?? []).map((r) => this.normalizeResult(r));
      return response.next_cursor ? { items, nextCursor: response.next_cursor } : { items };
    } catch (error) {
      throw this.mapCloudinaryError(error, 'get');
    }
  }

  private escapeSearch(value: string): string {
    // Folders are sanitized (letters, digits, '.', '_', '-', '/', never a
    // leading '-'), so '/' and '-' are left as-is, as in Cloudinary's own
    // examples (`folder:shirts/*`); anything else special is escaped.
    return value.replace(/[+!():^[\]"{}~*?|&\\ ]/g, '\\$&');
  }

  private httpCode(error: unknown): number | undefined {
    const err = error as Record<string, unknown> | null;
    return (err?.http_code ?? (err?.error as Record<string, unknown> | undefined)?.http_code) as
      | number
      | undefined;
  }

  /**
   * Map Cloudinary-specific errors to appropriate MediaErrorCodes
   */
  private mapCloudinaryError(error: unknown, operation: 'upload' | 'delete' | 'get'): MediaError {
    if (error instanceof MediaError) return error;
    const err = error as Record<string, unknown> | null;
    const nested = err?.error as Record<string, unknown> | undefined;
    const errorMessage = String(err?.message ?? nested?.message ?? error);
    const lower = errorMessage.toLowerCase();
    const httpCode = this.httpCode(error);
    const details = { httpCode, cloudinaryError: errorMessage };

    if (err?.name === 'AbortError') {
      return createMediaError(MediaErrorCode.ABORTED, this.name, error, details);
    }
    if (httpCode === 401 || errorMessage.includes('Invalid API key') || lower.includes('invalid signature')) {
      return createMediaError(
        MediaErrorCode.INVALID_CREDENTIALS,
        this.name,
        new Error('Invalid Cloudinary credentials - check apiKey and apiSecret'),
        details
      );
    }
    if (httpCode === 403) {
      return createMediaError(MediaErrorCode.UNAUTHORIZED, this.name, new Error(errorMessage), details);
    }
    if (httpCode === 420 || httpCode === 429 || lower.includes('rate limit')) {
      return createMediaError(
        MediaErrorCode.RATE_LIMITED,
        this.name,
        new Error('Cloudinary rate limit reached - try again later'),
        details
      );
    }
    if (httpCode === 402 || lower.includes('quota')) {
      return createMediaError(
        MediaErrorCode.QUOTA_EXCEEDED,
        this.name,
        new Error('Cloudinary account quota exceeded'),
        details
      );
    }
    if (httpCode === 404) {
      return createMediaError(MediaErrorCode.FILE_NOT_FOUND, this.name, new Error('File not found'), details);
    }
    if (lower.includes('file size too large') || httpCode === 413) {
      return createMediaError(
        MediaErrorCode.FILE_TOO_LARGE,
        this.name,
        new Error(`File too large: ${errorMessage}`),
        details
      );
    }
    if (
      lower.includes('invalid image file') ||
      lower.includes('unsupported') ||
      lower.includes('format not allowed') ||
      lower.includes('invalid file')
    ) {
      return createMediaError(
        MediaErrorCode.INVALID_FILE_TYPE,
        this.name,
        new Error(`Invalid file: ${errorMessage}`),
        details
      );
    }
    if (
      httpCode === 408 ||
      httpCode === 499 ||
      lower.includes('timeout') ||
      errorMessage.includes('ETIMEDOUT') ||
      errorMessage.includes('ECONNRESET') ||
      errorMessage.includes('ECONNREFUSED')
    ) {
      return createMediaError(
        MediaErrorCode.NETWORK_ERROR,
        this.name,
        new Error('Request timeout - network may be slow or file too large'),
        details
      );
    }
    if (httpCode !== undefined && httpCode >= 500) {
      return createMediaError(MediaErrorCode.PROVIDER_ERROR, this.name, new Error(errorMessage), details);
    }

    const defaultCode =
      operation === 'upload'
        ? MediaErrorCode.UPLOAD_FAILED
        : operation === 'delete'
          ? MediaErrorCode.DELETE_FAILED
          : MediaErrorCode.PROVIDER_ERROR;

    return createMediaError(
      defaultCode,
      this.name,
      error instanceof Error ? error : new Error(errorMessage),
      details
    );
  }

  private mapOptions(options: UploadOptions, contentType: string): CloudinaryUploadOptions {
    const params: CloudinaryUploadOptions = {
      ...this.filterProviderOptions(options.providerOptions),
      ...this.credentials(),
      public_id: buildStorageKey({
        folder: options.folder,
        filename: options.filename,
        uniqueFilename: options.uniqueFilename,
      }),
      resource_type: this.resourceTypeFromContentType(contentType),
    };
    if (options.tags?.length) params.tags = options.tags;
    const context = toPersistedMetadata(options.metadata);
    if (Object.keys(context).length) params.context = context;
    if (options.transformation) {
      params.transformation = [this.mapTransformations(options.transformation)];
    }
    if (options.public === false) params.type = 'authenticated';
    return params;
  }

  private filterProviderOptions(options: Record<string, unknown> | undefined): Record<string, unknown> {
    if (!options) return {};
    return Object.fromEntries(Object.entries(options).filter(([k]) => !RESERVED_PARAMS.has(k)));
  }

  private mapTransformations(transform: TransformationOptions): Record<string, unknown> {
    const cloudinaryTransform: Record<string, unknown> = {};

    if (transform.width) cloudinaryTransform.width = transform.width;
    if (transform.height) cloudinaryTransform.height = transform.height;
    if (transform.quality) cloudinaryTransform.quality = transform.quality;
    if (transform.format) cloudinaryTransform.fetch_format = transform.format;
    if (transform.fit) cloudinaryTransform.crop = this.mapFitMode(transform.fit);

    // Additional Cloudinary transformations passed through the options object
    const extended = transform as Record<string, unknown>;
    for (const key of ['gravity', 'effect', 'angle', 'background', 'radius', 'border'] as const) {
      if (extended[key] !== undefined) cloudinaryTransform[key] = extended[key];
    }

    return cloudinaryTransform;
  }

  /**
   * Build transformation path for manual URL generation
   */
  private buildTransformationPath(transform: TransformationOptions): string {
    const parts: string[] = [];
    const n = (v: number | undefined) => (v !== undefined && Number.isFinite(v) ? Math.round(v) : undefined);

    if (n(transform.width)) parts.push(`w_${n(transform.width)}`);
    if (n(transform.height)) parts.push(`h_${n(transform.height)}`);
    if (n(transform.quality)) parts.push(`q_${n(transform.quality)}`);
    if (transform.format && /^[a-z]+$/.test(transform.format)) parts.push(`f_${transform.format}`);
    if (transform.fit) parts.push(`c_${this.mapFitMode(transform.fit)}`);

    return parts.join(',');
  }

  private mapFitMode(fit: string): string {
    const mapping: Record<string, string> = {
      cover: 'fill',
      contain: 'fit',
      fill: 'scale',
      inside: 'limit',
      outside: 'mfit',
    };
    return mapping[fit] ?? 'fill';
  }

  private normalizeResult(result: CloudinaryUploadResponse): UploadResult {
    const context = result.context as { custom?: Record<string, string> } | Record<string, string> | undefined;
    const custom =
      context && typeof (context as { custom?: unknown }).custom === 'object'
        ? (context as { custom: Record<string, string> }).custom
        : (context as Record<string, string> | undefined);
    const uploadResult: UploadResult = {
      id: result.public_id,
      storageKey: result.public_id,
      url: result.secure_url || result.url,
      size: result.bytes,
      format: result.format,
      provider: this.name,
      metadata: {
        ...custom,
        resourceType: result.resource_type,
        type: result.type,
        version: result.version,
        tags: result.tags,
        format: result.format,
      },
      createdAt: new Date(result.created_at),
    };
    // Only assets with the "upload" delivery type are publicly readable
    if (result.type === 'upload' && uploadResult.url) uploadResult.publicUrl = uploadResult.url;
    const contentType =
      mimeFromExtension(result.format) ??
      (result.resource_type === 'image' || result.resource_type === 'video'
        ? `${result.resource_type}/${result.format}`
        : undefined);
    if (contentType) uploadResult.contentType = contentType;

    if (result.width !== undefined) uploadResult.width = result.width;
    if (result.height !== undefined) uploadResult.height = result.height;

    return uploadResult;
  }

  /**
   * Convert any upload input to a Node Readable without buffering it again.
   */
  private toReadable(file: UploadInput): Readable {
    if (isNodeReadable(file)) return file;
    if (isBuffer(file)) {
      // Chunk so progress is reported as data flows
      return Readable.from(
        (function* () {
          for (let i = 0; i < file.byteLength; i += CHUNK_SIZE) yield file.subarray(i, i + CHUNK_SIZE);
        })()
      );
    }
    const web = isFileInput(file) ? (file.stream() as ReadableStream<Uint8Array>) : (file as ReadableStream<Uint8Array>);
    return Readable.fromWeb(web as import('node:stream/web').ReadableStream<Uint8Array>);
  }

  /**
   * Upload a Node Readable through Cloudinary's upload_stream with byte
   * progress, source-error propagation and abort support.
   */
  private uploadFromStream(
    client: CloudinaryClient,
    source: Readable,
    params: CloudinaryUploadOptions,
    options: UploadOptions,
    total: number | undefined
  ): Promise<CloudinaryUploadResponse> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener('abort', onAbort);
        fn();
      };

      const uploadStream = client.uploader.upload_stream(
        params as never,
        (error: unknown, result: unknown) => {
          if (error) return finish(() => reject(error));
          if (!result) return finish(() => reject(new Error('Cloudinary upload_stream returned no result')));
          finish(() => resolve(result as CloudinaryUploadResponse));
        }
      );

      let loaded = 0;
      const counter = new PassThrough();
      counter.on('data', (chunk: Buffer) => {
        loaded += chunk.length;
        options.onByteProgress?.(loaded, total);
        // Reserve the last few percent for Cloudinary's processing
        if (options.onProgress && total) options.onProgress(Math.min(95, (loaded / total) * 95));
      });

      // The SDK does not expose its HTTP request, so cancelling stops sending
      // data and rejects immediately; the half-sent request is then dropped by
      // the SDK's idle timeout (60 s by default, `providerOptions.timeout`).
      const onAbort = () => {
        source.destroy();
        counter.destroy();
        (uploadStream as unknown as { destroy?: () => void }).destroy?.();
        finish(() =>
          reject(new MediaError('Upload aborted', MediaErrorCode.ABORTED, this.name, options.signal?.reason))
        );
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });

      pipeline(source, counter, uploadStream as unknown as NodeJS.WritableStream, (error) => {
        if (error && !settled) finish(() => reject(error));
      });
    });
  }

  /**
   * Derive Cloudinary resource_type from a MIME content type.
   */
  private resourceTypeFromContentType(contentType?: string): 'image' | 'video' | 'raw' | 'auto' {
    if (!contentType || contentType === 'application/octet-stream') return 'auto';
    // PDFs are delivered as images by Cloudinary (page rendering)
    if (contentType.startsWith('image/') || contentType === 'application/pdf') return 'image';
    if (contentType.startsWith('video/') || contentType.startsWith('audio/')) return 'video';
    return 'raw';
  }
}
