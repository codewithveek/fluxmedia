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
import { PassThrough, Readable } from 'node:stream';
import type { BlobServiceClient } from '@azure/storage-blob';

export interface AzureBlobConfig {
  /** Container name. */
  container: string;
  /** Storage account connection string. */
  connectionString?: string;
  /** Account name (with `accountKey`, or with `credential` for Entra ID auth). */
  accountName?: string;
  /** Account key (shared key auth). */
  accountKey?: string;
  /**
   * A TokenCredential (e.g. `new DefaultAzureCredential()` from
   * `@azure/identity`) for Microsoft Entra ID auth. Signed URLs then use
   * user delegation SAS.
   */
  credential?: unknown;
  /** Use an existing BlobServiceClient. */
  serviceClient?: BlobServiceClient;
  /**
   * Public URL configuration: a base URL (CDN / custom domain), `false` for
   * a private container (no `publicUrl`; use signed URLs), or unset to report
   * the blob URL.
   */
  publicUrl?: string | false;
  /** Append the detected extension to generated keys. Default false. */
  appendExtension?: boolean;
  /** Block size for stream uploads in bytes (default 8 MB). */
  blockSize?: number;
  /** Parallel block uploads for streams (default 4). */
  concurrency?: number;
}

export const AzureFeatures: ProviderFeatures = {
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
    maxFileSize: 190.7 * 1024 * 1024 * 1024 * 1024, // ~190.7 TiB block blob limit
    supportedFormats: ['*'],
  },
};

/** Subset of the BlockBlobClient API used here. */
interface BlobLike {
  url: string;
  uploadData(data: Buffer, options: Record<string, unknown>): Promise<unknown>;
  uploadStream(stream: Readable, bufferSize: number, concurrency: number, options: Record<string, unknown>): Promise<unknown>;
  deleteIfExists(options?: Record<string, unknown>): Promise<unknown>;
  getProperties(): Promise<Record<string, unknown>>;
  exists(): Promise<boolean>;
  download(): Promise<{ readableStreamBody?: NodeJS.ReadableStream; contentType?: string; contentLength?: number }>;
  setMetadata(metadata: Record<string, string>): Promise<unknown>;
  beginCopyFromURL(url: string): Promise<{ pollUntilDone(): Promise<unknown> }>;
  generateSasUrl(options: Record<string, unknown>): Promise<string>;
  generateUserDelegationSasUrl(options: Record<string, unknown>, key: unknown): Promise<string>;
}

interface ContainerLike {
  getBlockBlobClient(name: string): BlobLike;
  listBlobsFlat(options: Record<string, unknown>): {
    byPage(settings: { maxPageSize: number; continuationToken?: string }): AsyncIterableIterator<{
      continuationToken?: string;
      segment: { blobItems: Array<{ name: string; properties: Record<string, unknown>; metadata?: Record<string, string> }> };
    }>;
  };
}

interface ServiceLike {
  url: string;
  getContainerClient(name: string): ContainerLike;
  getUserDelegationKey(start: Date, end: Date): Promise<unknown>;
}

const MAX_SAS_SECONDS = 7 * 24 * 3600;

function parseConnectionString(cs: string): Record<string, string> {
  return Object.fromEntries(
    cs
      .split(';')
      .filter(Boolean)
      .map((part) => {
        const i = part.indexOf('=');
        return [part.slice(0, i).trim(), part.slice(i + 1).trim()];
      })
  );
}

/** Azure metadata keys must be C# identifiers. */
function toAzureMetadata(metadata: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(toPersistedMetadata(metadata, { ascii: true }))) {
    let k = key.replace(/[^A-Za-z0-9_]/g, '_');
    if (/^[0-9]/.test(k)) k = `_${k}`;
    out[k] = value;
  }
  return out;
}

/**
 * Azure Blob Storage provider (block blobs).
 */
export class AzureBlobProvider implements MediaProvider {
  readonly name = 'azure';
  readonly features: ProviderFeatures = AzureFeatures;
  private client: BlobServiceClient | null = null;
  private clientPromise: Promise<BlobServiceClient> | null = null;
  private readonly accountUrl: string;
  private readonly config!: AzureBlobConfig;

  constructor(config: AzureBlobConfig) {
    const fail = (m: string) => new MediaError(m, MediaErrorCode.INVALID_CONFIG, 'azure');
    if (!config?.container) throw fail('container is required');
    if (!config.serviceClient && !config.connectionString && !config.accountName) {
      throw fail('Provide serviceClient, connectionString, or accountName with accountKey/credential');
    }
    if (config.accountName && !config.connectionString && !config.serviceClient && !config.accountKey && !config.credential) {
      throw fail('accountName requires accountKey or credential');
    }
    Object.defineProperty(this, 'config', { value: config, enumerable: false });
    if (config.serviceClient) this.client = config.serviceClient;

    if (config.serviceClient) {
      this.accountUrl = (config.serviceClient as unknown as ServiceLike).url.replace(/\/+$/, '');
    } else if (config.connectionString) {
      const parts = parseConnectionString(config.connectionString);
      this.accountUrl = (
        parts.BlobEndpoint ??
        `${parts.DefaultEndpointsProtocol ?? 'https'}://${parts.AccountName}.blob.${parts.EndpointSuffix ?? 'core.windows.net'}`
      ).replace(/\/+$/, '');
    } else {
      this.accountUrl = `https://${config.accountName}.blob.core.windows.net`;
    }
  }

  get native(): BlobServiceClient | null {
    return this.client;
  }

  async getServiceClient(): Promise<BlobServiceClient> {
    if (this.client) return this.client;
    this.clientPromise ??= import('@azure/storage-blob').then((sdk) => {
      const { connectionString, accountName, accountKey, credential } = this.config;
      const client = connectionString
        ? sdk.BlobServiceClient.fromConnectionString(connectionString)
        : new sdk.BlobServiceClient(
            this.accountUrl,
            accountKey
              ? new sdk.StorageSharedKeyCredential(accountName!, accountKey)
              : (credential as import('@azure/storage-blob').AnonymousCredential)
          );
      this.client = client;
      return client;
    });
    return this.clientPromise;
  }

  private async blob(key: string): Promise<BlobLike> {
    assertSafeKey(key, this.name);
    const service = (await this.getServiceClient()) as unknown as ServiceLike;
    return service.getContainerClient(this.config.container).getBlockBlobClient(key);
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
    const blob = await this.blob(key);

    let loaded = 0;
    const uploadOptions: Record<string, unknown> = {
      ...options.providerOptions,
      blobHTTPHeaders: {
        blobContentType: info.contentType,
        ...(options.cacheControl && { blobCacheControl: options.cacheControl }),
        ...(options.contentDisposition && { blobContentDisposition: options.contentDisposition }),
      },
      metadata: toAzureMetadata(options.metadata),
      onProgress: (event: { loadedBytes: number }) => {
        loaded = event.loadedBytes;
        options.onByteProgress?.(loaded, info.size);
        if (options.onProgress && info.size) options.onProgress(Math.min(100, (loaded / info.size) * 100));
      },
      ...(options.signal && { abortSignal: options.signal }),
    };

    try {
      if (isBuffer(file)) {
        await blob.uploadData(file, uploadOptions);
      } else {
        await blob.uploadStream(
          this.toReadable(file),
          this.config.blockSize ?? 8 * 1024 * 1024,
          this.config.concurrency ?? 4,
          uploadOptions
        );
      }
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
      await (await this.blob(id)).deleteIfExists({ deleteSnapshots: 'include' });
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
      const props = await (await this.blob(id)).getProperties();
      return this.fromProperties(id, props, props.metadata as Record<string, string> | undefined);
    } catch (error) {
      throw this.mapError(error, MediaErrorCode.PROVIDER_ERROR);
    }
  }

  async exists(id: string): Promise<boolean> {
    try {
      return await (await this.blob(id)).exists();
    } catch (error) {
      throw this.mapError(error, MediaErrorCode.PROVIDER_ERROR);
    }
  }

  getUrl(id: string, _transform?: TransformationOptions): string {
    const base =
      typeof this.config.publicUrl === 'string'
        ? this.config.publicUrl.replace(/\/+$/, '')
        : `${this.accountUrl}/${encodeURIComponent(this.config.container)}`;
    return `${base}/${encodeKeyForUrl(id)}`;
  }

  /**
   * Read SAS URL. Uses the account key when available, otherwise a user
   * delegation key (Entra ID credential with "Storage Blob Delegator").
   */
  async getSignedUrl(id: string, options: SignedUrlOptions = {}): Promise<string> {
    const expiresIn = clampExpiresIn(options.expiresIn, 3600, MAX_SAS_SECONDS);
    return this.sas(id, 'r', expiresIn, {
      ...(options.downloadAs && {
        contentDisposition: `attachment; filename="${options.downloadAs.replace(/[^\x20-\x7e]|["\\]/g, '_')}"`,
      }),
    });
  }

  /**
   * Create/write SAS URL for a direct PUT. Azure SAS cannot restrict content
   * type or size; validate uploads after the fact (or use the proxy handler)
   * when that matters.
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
    const expiresIn = clampExpiresIn(options.expiresIn, 600, MAX_SAS_SECONDS);
    const uploadUrl = await this.sas(key, 'cw', expiresIn, {});
    const headers: Record<string, string> = {
      'x-ms-blob-type': 'BlockBlob',
      'x-ms-blob-content-type': options.contentType,
      'Content-Type': options.contentType,
    };
    if (options.cacheControl) headers['x-ms-blob-cache-control'] = options.cacheControl;
    for (const [k, v] of Object.entries(toAzureMetadata(options.metadata))) headers[`x-ms-meta-${k}`] = v;
    const target: SignedUploadTarget = {
      uploadUrl,
      method: 'PUT',
      headers,
      storageKey: key,
      expiresAt: new Date(Date.now() + expiresIn * 1000),
      provider: this.name,
    };
    if (this.config.publicUrl !== false) target.publicUrl = this.getUrl(key);
    return target;
  }

  async list(options: ListOptions = {}): Promise<ListResult> {
    const folder = sanitizeFolder(options.folder);
    const service = (await this.getServiceClient()) as unknown as ServiceLike;
    try {
      const pages = service
        .getContainerClient(this.config.container)
        .listBlobsFlat({ includeMetadata: true, ...(folder && { prefix: `${folder}/` }) })
        .byPage({
          maxPageSize: Math.min(Math.max(options.limit ?? 100, 1), 5000),
          ...(options.cursor && { continuationToken: options.cursor }),
        });
      const { value: page } = await pages.next();
      if (!page) return { items: [] };
      const result: ListResult = {
        items: page.segment.blobItems.map((item: { name: string; properties: Record<string, unknown>; metadata?: Record<string, string> }) => this.fromProperties(item.name, item.properties, item.metadata)),
      };
      if (page.continuationToken) result.nextCursor = page.continuationToken;
      return result;
    } catch (error) {
      throw this.mapError(error, MediaErrorCode.PROVIDER_ERROR);
    }
  }

  async copy(fromId: string, toId: string): Promise<UploadResult> {
    const source = await this.sas(fromId, 'r', 600, {});
    try {
      const poller = await (await this.blob(toId)).beginCopyFromURL(source);
      await poller.pollUntilDone();
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
    try {
      const response = await (await this.blob(id)).download();
      if (!response.readableStreamBody) throw new Error('Empty response body');
      const result: DownloadResult = {
        body: Readable.toWeb(response.readableStreamBody as Readable) as ReadableStream<Uint8Array>,
      };
      if (response.contentType) result.contentType = response.contentType;
      if (response.contentLength !== undefined) result.size = response.contentLength;
      return result;
    } catch (error) {
      throw this.mapError(error, MediaErrorCode.PROVIDER_ERROR);
    }
  }

  /** Replace blob metadata (primitive values only). */
  async updateMetadata(id: string, metadata: Record<string, unknown>): Promise<void> {
    try {
      await (await this.blob(id)).setMetadata(toAzureMetadata(metadata));
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

  private async sas(
    key: string,
    permissions: string,
    expiresIn: number,
    extra: Record<string, unknown>
  ): Promise<string> {
    const { BlobSASPermissions } = await import('@azure/storage-blob');
    const blob = await this.blob(key);
    const startsOn = new Date(Date.now() - 5 * 60 * 1000); // tolerate clock skew
    const expiresOn = new Date(Date.now() + expiresIn * 1000);
    const sasOptions = { permissions: BlobSASPermissions.parse(permissions), startsOn, expiresOn, ...extra };
    try {
      // Shared key credentials (account key, connection string with a key, or a
      // client built with one) sign locally; anything else uses a user delegation key.
      try {
        return await blob.generateSasUrl(sasOptions);
      } catch (error) {
        if (!(error instanceof RangeError) || !/shared key/i.test(error.message)) throw error;
      }
      const service = (await this.getServiceClient()) as unknown as ServiceLike;
      const delegationKey = await service.getUserDelegationKey(startsOn, expiresOn);
      return await blob.generateUserDelegationSasUrl(sasOptions, delegationKey);
    } catch (error) {
      throw this.mapError(error, MediaErrorCode.PROVIDER_ERROR);
    }
  }

  private assertVisibility(visibility: boolean | undefined): void {
    if (visibility === undefined) return;
    if (visibility && this.config.publicUrl === false) {
      throw createMediaError(
        MediaErrorCode.INVALID_CONFIG,
        this.name,
        new Error('public: true was requested but this container is configured as private (publicUrl: false)')
      );
    }
    if (!visibility && typeof this.config.publicUrl === 'string') {
      throw createMediaError(
        MediaErrorCode.INVALID_CONFIG,
        this.name,
        new Error('public: false was requested but this container is public (publicUrl is set)')
      );
    }
  }

  private toReadable(file: UploadInput): Readable {
    if (isNodeReadable(file)) return file;
    if (isBuffer(file)) return Readable.from([file]);
    const web = isFileInput(file) ? file.stream() : (file as ReadableStream<Uint8Array>);
    return Readable.fromWeb(web as import('node:stream/web').ReadableStream<Uint8Array>).pipe(new PassThrough());
  }

  private fromProperties(
    key: string,
    props: Record<string, unknown>,
    metadata: Record<string, string> | undefined
  ): UploadResult {
    const contentType = (props.contentType ?? props.blobContentType) as string | undefined;
    return this.createResult(key, {
      size: Number(props.contentLength ?? 0),
      extension: extensionFromMime(contentType) || (key.includes('.') ? key.split('.').pop()!.toLowerCase() : ''),
      contentType,
      metadata: decodePersistedMetadata(metadata),
      createdAt: (props.createdOn ?? props.lastModified) as Date | undefined,
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
    const err = error as { statusCode?: number; code?: string; name?: string };
    const status = err?.statusCode;
    const details = { httpCode: status, azureCode: err?.code };
    if (err?.name === 'AbortError') return createMediaError(MediaErrorCode.ABORTED, this.name, error, details);
    if (status === 404 || err?.code === 'BlobNotFound') {
      return createMediaError(MediaErrorCode.FILE_NOT_FOUND, this.name, new Error('File not found'), details);
    }
    if (err?.code === 'ContainerNotFound') {
      return createMediaError(MediaErrorCode.INVALID_CONFIG, this.name, new Error(`Container '${this.config.container}' does not exist`), details);
    }
    if (status === 401 || err?.code === 'AuthenticationFailed') {
      return createMediaError(MediaErrorCode.INVALID_CREDENTIALS, this.name, error, details);
    }
    if (status === 403) return createMediaError(MediaErrorCode.UNAUTHORIZED, this.name, error, details);
    if (status === 429 || err?.code === 'ServerBusy') return createMediaError(MediaErrorCode.RATE_LIMITED, this.name, error, details);
    if (status === 413 || err?.code === 'RequestBodyTooLarge') {
      return createMediaError(MediaErrorCode.FILE_TOO_LARGE, this.name, error, details);
    }
    if (status !== undefined && status >= 500) return createMediaError(MediaErrorCode.PROVIDER_ERROR, this.name, error, details);
    if (err?.code && /^(ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|REQUEST_SEND_ERROR)$/.test(err.code)) {
      return createMediaError(MediaErrorCode.NETWORK_ERROR, this.name, error, details);
    }
    return createMediaError(defaultCode, this.name, error, details);
  }
}
