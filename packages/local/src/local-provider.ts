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
  isBuffer,
  isFileInput,
  isNodeReadable,
  mapSettled,
  sanitizeFolder,
  stripInternalMetadata,
  throwIfAborted,
  toPersistedMetadata,
  verifySignedUrl,
} from '@fluxmedia/core';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomBytes } from 'node:crypto';

export interface LocalProviderConfig {
  /** Directory files are stored in. Created if missing. */
  root: string;
  /**
   * Base URL files are served from, e.g. `/media` (with a static file route)
   * or `https://files.example.com`. Used by `getUrl()`.
   */
  baseUrl: string;
  /**
   * Treat stored files as private: results have no `publicUrl` and files
   * should be served only through signed URLs (`createLocalFileHandler`).
   */
  private?: boolean;
  /** Secret (32+ characters) for `getSignedUrl()`. */
  signingSecret?: string;
  /** Append the detected extension to generated keys. Default true. */
  appendExtension?: boolean;
}

interface Meta {
  contentType: string;
  extension: string;
  cacheControl?: string;
  contentDisposition?: string;
  metadata: Record<string, string>;
  tags: string[];
}

const META_DIR = '.fluxmedia-meta';

export const LocalFeatures: ProviderFeatures = {
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
    search: false,
    copy: true,
    download: true,
    updateMetadata: true,
  },
  storage: {
    maxFileSize: Number.MAX_SAFE_INTEGER,
    supportedFormats: ['*'],
  },
};

/**
 * Stores files on the local filesystem. Useful for development, tests,
 * self-hosting and single-server deployments.
 *
 * Writes are atomic (temp file + rename). Keys are sanitized and every path
 * is checked to stay inside `root`.
 */
export class LocalProvider implements MediaProvider {
  readonly name = 'local';
  readonly features: ProviderFeatures = LocalFeatures;
  private readonly root: string;
  private readonly config!: LocalProviderConfig;

  constructor(config: LocalProviderConfig) {
    if (!config?.root) throw new MediaError('root is required', MediaErrorCode.INVALID_CONFIG, 'local');
    if (!config.baseUrl) throw new MediaError('baseUrl is required', MediaErrorCode.INVALID_CONFIG, 'local');
    if (config.signingSecret !== undefined && config.signingSecret.length < 32) {
      throw new MediaError('signingSecret must be at least 32 characters', MediaErrorCode.INVALID_CONFIG, 'local');
    }
    this.root = resolve(config.root);
    Object.defineProperty(this, 'config', { value: config, enumerable: false });
  }

  get native(): { root: string } {
    return { root: this.root };
  }

  async upload(file: UploadInput, options: UploadOptions = {}): Promise<UploadResult> {
    throwIfAborted(options.signal, this.name);
    const info = await detectContentInfo(file, options);
    const key = buildStorageKey({
      folder: options.folder,
      filename: options.filename,
      uniqueFilename: options.uniqueFilename,
      extension: this.config.appendExtension === false ? undefined : info.extension,
    });
    const target = this.pathFor(key);
    await mkdir(dirname(target), { recursive: true });
    const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`;

    let written = 0;
    const counter = new PassThrough();
    counter.on('data', (chunk: Buffer) => {
      written += chunk.length;
      options.onByteProgress?.(written, info.size);
      if (options.onProgress && info.size) options.onProgress((written / info.size) * 100);
    });

    try {
      await pipeline(this.toReadable(file), counter, createWriteStream(temp, { flags: 'wx' }), {
        ...(options.signal && { signal: options.signal }),
      });
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true });
      if (options.signal?.aborted) {
        throw new MediaError('Upload aborted', MediaErrorCode.ABORTED, this.name, error);
      }
      if ((error as MediaError).code && error instanceof MediaError) throw error;
      throw new MediaError((error as Error).message, MediaErrorCode.UPLOAD_FAILED, this.name, error);
    }

    const meta: Meta = {
      contentType: info.contentType,
      extension: info.extension,
      metadata: toPersistedMetadata(options.metadata),
      tags: options.tags ?? [],
      ...(options.cacheControl && { cacheControl: options.cacheControl }),
      ...(options.contentDisposition && { contentDisposition: options.contentDisposition }),
    };
    await this.writeMeta(key, meta);
    return { ...(await this.get(key)), metadata: stripInternalMetadata(options.metadata) };
  }

  async delete(id: string): Promise<void> {
    const path = this.pathFor(id);
    await rm(path, { force: true });
    await rm(this.metaPathFor(id), { force: true });
  }

  async deleteMultiple(ids: string[], _options?: ResourceOptions): Promise<void> {
    const settled = await mapSettled(ids, 10, (id) => this.delete(id));
    const failedIds = ids.filter((_, i) => settled[i]!.status === 'rejected');
    if (failedIds.length) {
      throw new MediaError(
        `Failed to delete ${failedIds.length} of ${ids.length} files`,
        MediaErrorCode.DELETE_FAILED,
        this.name,
        undefined,
        { failedIds }
      );
    }
  }

  async get(id: string): Promise<UploadResult> {
    const path = this.pathFor(id);
    const stats = await stat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        throw new MediaError('File not found', MediaErrorCode.FILE_NOT_FOUND, this.name, error);
      }
      throw new MediaError(error.message, MediaErrorCode.PROVIDER_ERROR, this.name, error);
    });
    if (!stats.isFile()) throw new MediaError('File not found', MediaErrorCode.FILE_NOT_FOUND, this.name);
    const meta = await this.readMeta(id);
    const result: UploadResult = {
      id,
      storageKey: id,
      url: this.getUrl(id),
      size: stats.size,
      format: meta?.extension ?? (id.includes('.') ? id.split('.').pop()! : ''),
      provider: this.name,
      metadata: { ...meta?.metadata, ...(meta?.tags.length && { tags: meta.tags }) },
      createdAt: stats.birthtime.getTime() ? stats.birthtime : stats.mtime,
    };
    if (meta?.contentType) result.contentType = meta.contentType;
    if (!this.config.private) result.publicUrl = result.url;
    return result;
  }

  async exists(id: string): Promise<boolean> {
    return stat(this.pathFor(id)).then(
      (s) => s.isFile(),
      () => false
    );
  }

  getUrl(id: string, _transform?: TransformationOptions): string {
    return `${this.config.baseUrl.replace(/\/+$/, '')}/${encodeKeyForUrl(id)}`;
  }

  /**
   * HMAC-signed URL; serve it with `createLocalFileHandler`, which verifies
   * the signature and expiry.
   */
  async getSignedUrl(id: string, options: SignedUrlOptions = {}): Promise<string> {
    assertSafeKey(id, this.name);
    if (!this.config.signingSecret) {
      throw new MediaError('getSignedUrl requires signingSecret', MediaErrorCode.INVALID_CONFIG, this.name);
    }
    return createSignedUrl(this.config.baseUrl, id, {
      secret: this.config.signingSecret,
      expiresIn: clampExpiresIn(options.expiresIn, 3600, 30 * 24 * 3600),
      downloadAs: options.downloadAs,
    });
  }

  /**
   * List files in key order. The cursor is the last key of the previous page.
   */
  async list(options: ListOptions = {}): Promise<ListResult> {
    const folder = sanitizeFolder(options.folder);
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 1000);
    const start = folder ? this.pathFor(folder) : this.root;
    const keys: string[] = [];

    const walk = async (dir: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.name === META_DIR || entry.name.endsWith('.tmp')) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile()) keys.push(relative(this.root, full).split(sep).join('/'));
      }
    };
    await walk(start);
    keys.sort();

    const remaining = options.cursor ? keys.filter((k) => k > options.cursor!) : keys;
    const page = remaining.slice(0, limit);
    const result: ListResult = { items: await Promise.all(page.map((k) => this.get(k))) };
    if (remaining.length > limit) result.nextCursor = page[page.length - 1]!;
    return result;
  }

  async copy(fromId: string, toId: string): Promise<UploadResult> {
    const from = this.pathFor(fromId);
    const to = this.pathFor(toId);
    await this.get(fromId);
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to);
    const meta = await this.readMeta(fromId);
    if (meta) await this.writeMeta(toId, meta);
    return this.get(toId);
  }

  async move(fromId: string, toId: string): Promise<UploadResult> {
    const from = this.pathFor(fromId);
    const to = this.pathFor(toId);
    await this.get(fromId);
    await mkdir(dirname(to), { recursive: true });
    await rename(from, to);
    const meta = await this.readMeta(fromId);
    if (meta) {
      await this.writeMeta(toId, meta);
      await rm(this.metaPathFor(fromId), { force: true });
    }
    return this.get(toId);
  }

  async download(id: string): Promise<DownloadResult> {
    const { size, contentType } = await this.get(id);
    const result: DownloadResult = {
      body: Readable.toWeb(createReadStream(this.pathFor(id))) as ReadableStream<Uint8Array>,
      size,
    };
    if (contentType) result.contentType = contentType;
    return result;
  }

  async updateMetadata(id: string, metadata: Record<string, unknown>): Promise<void> {
    await this.get(id);
    const meta = (await this.readMeta(id)) ?? { contentType: 'application/octet-stream', extension: '', metadata: {}, tags: [] };
    await this.writeMeta(id, { ...meta, metadata: toPersistedMetadata(metadata) });
  }

  async uploadMultiple(files: UploadInput[], options?: UploadOptions): Promise<UploadResult[]> {
    const settled = await mapSettled(files, 5, (f) => this.upload(f, options));
    const failure = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failure) throw failure.reason;
    return settled.map((r) => (r as PromiseFulfilledResult<UploadResult>).value);
  }

  /** Stored HTTP headers for a key (used by the file handler). */
  async headersFor(id: string): Promise<{ contentType: string; cacheControl?: string; contentDisposition?: string }> {
    const meta = await this.readMeta(id);
    const out: { contentType: string; cacheControl?: string; contentDisposition?: string } = {
      contentType: meta?.contentType ?? 'application/octet-stream',
    };
    if (meta?.cacheControl) out.cacheControl = meta.cacheControl;
    if (meta?.contentDisposition) out.contentDisposition = meta.contentDisposition;
    return out;
  }

  /** @internal Absolute path for a key; throws if it would leave the root. */
  pathFor(key: string): string {
    assertSafeKey(key, this.name);
    const path = resolve(this.root, ...key.split('/'));
    if (path !== this.root && !path.startsWith(this.root + sep)) {
      throw new MediaError('Key resolves outside the storage root', MediaErrorCode.INVALID_CONFIG, this.name);
    }
    if (key.split('/')[0] === META_DIR) {
      throw new MediaError('Reserved key', MediaErrorCode.INVALID_CONFIG, this.name);
    }
    return path;
  }

  toJSON(): { name: string; features: ProviderFeatures } {
    return { name: this.name, features: this.features };
  }

  private metaPathFor(key: string): string {
    this.pathFor(key);
    return resolve(this.root, META_DIR, ...key.split('/')) + '.json';
  }

  private async readMeta(key: string): Promise<Meta | undefined> {
    try {
      return JSON.parse(await readFile(this.metaPathFor(key), 'utf8')) as Meta;
    } catch {
      return undefined;
    }
  }

  private async writeMeta(key: string, meta: Meta): Promise<void> {
    const path = this.metaPathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(meta));
  }

  private toReadable(file: UploadInput): Readable {
    if (isNodeReadable(file)) return file;
    if (isBuffer(file)) return Readable.from([file]);
    const web = isFileInput(file) ? file.stream() : (file as ReadableStream<Uint8Array>);
    return Readable.fromWeb(web as import('node:stream/web').ReadableStream<Uint8Array>);
  }
}

export interface LocalFileHandlerOptions {
  /** URL path files are mounted under, e.g. `/media`. */
  pathPrefix: string;
  /**
   * Require a valid signature (default: true when the provider is private).
   * Uses the provider's `signingSecret`.
   */
  requireSignature?: boolean;
  /** Secret for verification (defaults to the provider's signingSecret). */
  signingSecret?: string;
}

/**
 * Serve files stored by a LocalProvider from a Web `Request` handler
 * (Next.js route, Hono, Bun, …), verifying signed URLs when required.
 *
 * Responses carry `X-Content-Type-Options: nosniff` and a sandboxing
 * Content-Security-Policy so uploaded HTML/SVG cannot run scripts on your
 * origin.
 */
export function createLocalFileHandler(
  provider: LocalProvider,
  options: LocalFileHandlerOptions
): (request: Request) => Promise<Response> {
  const secret =
    options.signingSecret ??
    (provider as unknown as { config: LocalProviderConfig }).config.signingSecret;
  const requireSignature =
    options.requireSignature ?? !!(provider as unknown as { config: LocalProviderConfig }).config.private;
  if (requireSignature && !secret) throw new Error('A signing secret is required to verify signed URLs');
  const prefix = options.pathPrefix.replace(/\/+$/, '');

  return async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405 });
    }
    const url = new URL(request.url);
    let key: string;
    let downloadAs: string | undefined;

    if (requireSignature) {
      const verified = await verifySignedUrl(url, { secret: secret!, pathPrefix: prefix });
      if (!verified.valid) return new Response('Forbidden', { status: 403 });
      key = verified.key;
      downloadAs = verified.downloadAs;
    } else {
      if (!url.pathname.startsWith(`${prefix}/`)) return new Response('Not found', { status: 404 });
      try {
        key = url.pathname
          .slice(prefix.length + 1)
          .split('/')
          .map(decodeURIComponent)
          .join('/');
      } catch {
        return new Response('Bad request', { status: 400 });
      }
    }

    try {
      const { body, size } = await provider.download(key);
      const stored = await provider.headersFor(key);
      const headers = new Headers({
        'content-type': stored.contentType,
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        'cache-control': stored.cacheControl ?? (requireSignature ? 'private, no-store' : 'public, max-age=3600'),
      });
      if (size !== undefined) headers.set('content-length', String(size));
      if (downloadAs) {
        headers.set(
          'content-disposition',
          `attachment; filename="${downloadAs.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(downloadAs)}`
        );
      } else if (stored.contentDisposition) {
        headers.set('content-disposition', stored.contentDisposition);
      }
      if (request.method === 'HEAD') {
        await body.cancel();
        return new Response(null, { status: 200, headers });
      }
      return new Response(body, { status: 200, headers });
    } catch (error) {
      if (error instanceof MediaError && (error.code === MediaErrorCode.FILE_NOT_FOUND || error.code === MediaErrorCode.INVALID_CONFIG)) {
        return new Response('Not found', { status: 404 });
      }
      return new Response('Internal error', { status: 500 });
    }
  };
}
