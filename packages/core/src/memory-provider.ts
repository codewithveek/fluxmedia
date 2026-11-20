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
} from './types';
import { MediaError, MediaErrorCode } from './errors';
import {
  assertSafeKey,
  buildStorageKey,
  clampExpiresIn,
  detectContentInfo,
  encodeKeyForUrl,
  isBuffer,
  isFileInput,
  isNodeReadable,
  mapSettled,
  sanitizeFolder,
  stripInternalMetadata,
  throwIfAborted,
  toPersistedMetadata,
} from './utils';
import { createSignedUrl } from './signing';

export interface MemoryProviderConfig {
  /** Base URL used in returned URLs. Default `memory://fluxmedia`. */
  baseUrl?: string;
  /** Secret for `getSignedUrl()` (32+ characters). Random per instance by default. */
  signingSecret?: string;
  /** Provider name (default `memory`). Useful as a named fallback in tests. */
  name?: string;
  /** Maximum file size in bytes (default 100 MB). */
  maxFileSize?: number;
}

interface StoredObject {
  data: Uint8Array;
  contentType: string;
  extension: string;
  metadata: Record<string, string>;
  tags: string[];
  createdAt: Date;
}

export const MemoryFeatures: ProviderFeatures = {
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
    signedUploads: false,
    directUpload: true,
    multipartUpload: false,
    videoProcessing: false,
    aiTagging: false,
    facialDetection: false,
    signedUrls: true,
    list: true,
    search: true,
    copy: true,
    download: true,
    updateMetadata: true,
  },
  storage: {
    maxFileSize: 100 * 1024 * 1024,
    supportedFormats: ['*'],
  },
};

async function readAll(file: UploadInput): Promise<Uint8Array> {
  if (isBuffer(file)) return new Uint8Array(file);
  if (isFileInput(file)) return new Uint8Array(await file.arrayBuffer());
  const chunks: Uint8Array[] = [];
  if (isNodeReadable(file)) {
    for await (const chunk of file) chunks.push(chunk as Uint8Array);
  } else {
    const reader = (file as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * In-memory provider for tests, local development and examples. Implements
 * every optional capability. Data lives only as long as the instance.
 *
 * @example
 * ```typescript
 * const uploader = new MediaUploader(new MemoryProvider());
 * ```
 */
export class MemoryProvider implements MediaProvider {
  readonly name: string;
  readonly features: ProviderFeatures;
  private readonly store = new Map<string, StoredObject>();
  private readonly baseUrl: string;
  private readonly secret: string;
  private readonly maxFileSize: number;

  constructor(config: MemoryProviderConfig = {}) {
    this.name = config.name ?? 'memory';
    this.baseUrl = (config.baseUrl ?? 'memory://fluxmedia').replace(/\/+$/, '');
    this.maxFileSize = config.maxFileSize ?? MemoryFeatures.storage.maxFileSize;
    this.features = {
      ...MemoryFeatures,
      storage: { ...MemoryFeatures.storage, maxFileSize: this.maxFileSize },
    };
    const bytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(bytes);
    this.secret =
      config.signingSecret ?? Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  /** The underlying Map (read-only view intended for assertions in tests). */
  get native(): ReadonlyMap<string, StoredObject> {
    return this.store;
  }

  async upload(file: UploadInput, options: UploadOptions = {}): Promise<UploadResult> {
    throwIfAborted(options.signal, this.name);
    const info = await detectContentInfo(file, options);
    const data = await readAll(file);
    throwIfAborted(options.signal, this.name);
    if (data.byteLength > this.maxFileSize) {
      throw new MediaError(
        `File exceeds maximum size of ${this.maxFileSize} bytes`,
        MediaErrorCode.FILE_TOO_LARGE,
        this.name
      );
    }
    const key = buildStorageKey(options);
    this.store.set(key, {
      data,
      contentType: info.contentType,
      extension: info.extension,
      metadata: toPersistedMetadata(options.metadata),
      tags: options.tags ?? [],
      createdAt: new Date(),
    });
    options.onByteProgress?.(data.byteLength, data.byteLength);
    options.onProgress?.(100);
    return { ...this.toResult(key), metadata: stripInternalMetadata(options.metadata) };
  }

  async delete(id: string): Promise<void> {
    assertSafeKey(id, this.name);
    this.store.delete(id);
  }

  async get(id: string): Promise<UploadResult> {
    assertSafeKey(id, this.name);
    return this.toResult(id);
  }

  getUrl(id: string, _transform?: TransformationOptions): string {
    return `${this.baseUrl}/${encodeKeyForUrl(id)}`;
  }

  async getSignedUrl(id: string, options: SignedUrlOptions = {}): Promise<string> {
    assertSafeKey(id, this.name);
    return createSignedUrl(this.baseUrl, id, {
      secret: this.secret,
      expiresIn: clampExpiresIn(options.expiresIn, 3600, 7 * 24 * 3600),
      downloadAs: options.downloadAs,
    });
  }

  async createUploadUrl(_options: SignedUploadOptions): Promise<SignedUploadTarget> {
    throw new MediaError(
      'MemoryProvider cannot accept direct browser uploads',
      MediaErrorCode.NOT_SUPPORTED,
      this.name
    );
  }

  async exists(id: string): Promise<boolean> {
    return this.store.has(id);
  }

  async list(options: ListOptions = {}): Promise<ListResult> {
    const prefix = sanitizeFolder(options.folder);
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 1000);
    const keys = [...this.store.keys()]
      .filter((k) => !prefix || k.startsWith(`${prefix}/`))
      .sort()
      .filter((k) => !options.cursor || k > options.cursor);
    const page = keys.slice(0, limit);
    const result: ListResult = { items: page.map((k) => this.toResult(k)) };
    if (keys.length > limit) result.nextCursor = page[page.length - 1]!;
    return result;
  }

  async search(query: SearchOptions): Promise<UploadResult[]> {
    const { items } = await this.list(query.folder ? { folder: query.folder, limit: 1000 } : { limit: 1000 });
    return items
      .filter((item) => !query.query || item.id.includes(query.query))
      .filter((item) => {
        const tags = this.store.get(item.id)?.tags ?? [];
        return !query.tags?.length || query.tags.every((t) => tags.includes(t));
      })
      .slice(query.offset ?? 0, (query.offset ?? 0) + (query.limit ?? 100));
  }

  async copy(fromId: string, toId: string): Promise<UploadResult> {
    assertSafeKey(toId, this.name);
    const obj = this.getObject(fromId);
    this.store.set(toId, { ...obj, data: obj.data.slice(), createdAt: new Date() });
    return this.toResult(toId);
  }

  async move(fromId: string, toId: string): Promise<UploadResult> {
    const result = await this.copy(fromId, toId);
    this.store.delete(fromId);
    return result;
  }

  async download(id: string): Promise<DownloadResult> {
    const obj = this.getObject(id);
    const data = obj.data;
    return {
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(data.slice());
          controller.close();
        },
      }),
      contentType: obj.contentType,
      size: data.byteLength,
    };
  }

  async updateMetadata(id: string, metadata: Record<string, unknown>): Promise<void> {
    const obj = this.getObject(id);
    obj.metadata = toPersistedMetadata(metadata);
  }

  async uploadMultiple(files: UploadInput[], options?: UploadOptions): Promise<UploadResult[]> {
    const results = await mapSettled(files, 5, (f) => this.upload(f, options));
    const failure = results.find((r) => r.status === 'rejected');
    if (failure) throw (failure as PromiseRejectedResult).reason;
    return results.map((r) => (r as PromiseFulfilledResult<UploadResult>).value);
  }

  async deleteMultiple(ids: string[], _options?: ResourceOptions): Promise<void> {
    for (const id of ids) await this.delete(id);
  }

  toJSON(): { name: string; features: ProviderFeatures } {
    return { name: this.name, features: this.features };
  }

  private getObject(id: string): StoredObject {
    assertSafeKey(id, this.name);
    const obj = this.store.get(id);
    if (!obj) {
      throw new MediaError(`File not found: ${id}`, MediaErrorCode.FILE_NOT_FOUND, this.name);
    }
    return obj;
  }

  private toResult(key: string): UploadResult {
    const obj = this.getObject(key);
    return {
      id: key,
      storageKey: key,
      url: this.getUrl(key),
      publicUrl: this.getUrl(key),
      size: obj.data.byteLength,
      format: obj.extension,
      contentType: obj.contentType,
      provider: this.name,
      metadata: { ...obj.metadata, tags: [...obj.tags] },
      createdAt: obj.createdAt,
    };
  }
}
