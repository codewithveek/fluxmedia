/**
 * Shared helpers used by providers and plugins. Everything here is
 * runtime-agnostic (Node 20+, browsers, edge runtimes).
 */
import { MediaError, MediaErrorCode } from './errors';
import { getFileType } from './file-type';
import type { UploadInput, UploadOptions } from './types';

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const MAX_SEGMENT_LENGTH = 200;
/** Bytes needed by magic-byte detection. */
export const MAGIC_BYTES_LENGTH = 4100;

/**
 * Cryptographically random lowercase alphanumeric ID.
 */
export function randomId(length = 12): string {
  let out = '';
  while (out.length < length) {
    const bytes = new Uint8Array(length * 2);
    globalThis.crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      // 252 = 36 * 7: reject the top bytes to avoid modulo bias
      if (byte < 252 && out.length < length) out += ID_ALPHABET[byte % 36];
    }
  }
  return out;
}

/**
 * Sanitize a single path segment (a filename or one folder level).
 * Keeps letters and numbers from any script plus `.`, `_` and `-`;
 * everything else becomes `-`. Leading dots are removed so a segment can never
 * be `.` / `..` or a hidden file. Returns '' when nothing usable is left.
 */
export function sanitizeKeySegment(segment: string): string {
  return segment
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/[.-]+$/, '')
    .slice(0, MAX_SEGMENT_LENGTH);
}

/**
 * Sanitize a folder path. Splits on `/` and `\`, drops empty, `.` and `..`
 * segments and sanitizes each one, so the result can never escape the root.
 */
export function sanitizeFolder(folder: string | undefined): string {
  if (!folder) return '';
  return folder
    .split(/[/\\]+/)
    .map(sanitizeKeySegment)
    .filter(Boolean)
    .join('/');
}

/**
 * Build a storage key from upload options.
 *
 * - `filename` is sanitized; with `uniqueFilename` (default true) a random
 *   suffix is appended.
 * - Without a filename, a random ID is used.
 * - `extension` (without dot) is appended when given.
 */
export function buildStorageKey(options: {
  folder?: string | undefined;
  filename?: string | undefined;
  uniqueFilename?: boolean | undefined;
  extension?: string | undefined;
}): string {
  const folder = sanitizeFolder(options.folder);
  const base = options.filename ? sanitizeKeySegment(options.filename) : '';
  let name: string;
  if (!base) {
    name = `${Date.now().toString(36)}-${randomId(10)}`;
  } else if (options.uniqueFilename === false) {
    name = base;
  } else {
    name = `${base}-${randomId(8)}`;
  }
  const ext = options.extension ? sanitizeKeySegment(options.extension.replace(/^\./, '')) : '';
  if (ext) name = `${name}.${ext}`;
  return folder ? `${folder}/${name}` : name;
}

/**
 * Validate a caller-supplied storage key (used by get/delete/copy/move).
 * Rejects empty keys, `..` segments, leading slashes, backslashes and control
 * characters.
 */
export function assertSafeKey(key: string, provider: string): void {
  // eslint-disable-next-line no-control-regex
  const bad = /[\u0000-\u001f\u007f\\]/.test(key);
  const segments = key.split('/');
  if (
    !key ||
    bad ||
    key.startsWith('/') ||
    segments.some((s) => s === '..' || s === '.') ||
    key.length > 1024
  ) {
    throw new MediaError(
      `Invalid storage key: ${JSON.stringify(key.slice(0, 100))}`,
      MediaErrorCode.INVALID_CONFIG,
      provider
    );
  }
}

/**
 * Percent-encode each segment of a storage key for use in a URL path.
 */
export function encodeKeyForUrl(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

/**
 * Remove internal keys (prefixed with `_`) from metadata.
 */
export function stripInternalMetadata(
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!metadata) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!key.startsWith('_')) out[key] = value;
  }
  return out;
}

/**
 * Convert metadata into the flat string map providers persist.
 *
 * Only top-level string/number/boolean values are kept. Keys starting with
 * `_` (plugin-internal), nested objects, arrays, functions and nullish values
 * are dropped so that in-process data (whole files, EXIF/GPS data, configs)
 * is never written to object headers that may be publicly readable.
 *
 * With `ascii: true` (S3/R2 header requirements), keys are lowercased and
 * limited to `[a-z0-9-_]`, and non-ASCII values are percent-encoded.
 */
export function toPersistedMetadata(
  metadata: Record<string, unknown> | undefined,
  options: { ascii?: boolean } = {}
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!metadata) return out;
  for (const [rawKey, value] of Object.entries(metadata)) {
    if (rawKey.startsWith('_')) continue;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      continue;
    }
    const key = options.ascii ? rawKey.toLowerCase().replace(/[^a-z0-9_-]/g, '-') : rawKey;
    if (!key) continue;
    let str = String(value);
    if (options.ascii && /[^\x20-\x7e]/.test(str)) str = encodeHeaderValue(str);
    out[key] = str;
  }
  return out;
}

const ENCODED_WORD = /^=\?UTF-8\?B\?([A-Za-z0-9+/=]*)\?=$/;

/**
 * Encode a non-ASCII string as an RFC 2047 encoded-word
 * (`=?UTF-8?B?…?=`), the form S3 uses for non-ASCII metadata.
 */
export function encodeHeaderValue(value: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return `=?UTF-8?B?${btoa(binary)}?=`;
}

/**
 * Decode metadata values written by `toPersistedMetadata({ ascii: true })`.
 * Values that are not RFC 2047 encoded-words are returned unchanged.
 */
export function decodePersistedMetadata(
  metadata: Record<string, string> | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    const match = typeof value === 'string' ? ENCODED_WORD.exec(value) : null;
    if (!match) {
      out[key] = value;
      continue;
    }
    try {
      out[key] = new TextDecoder('utf-8', { fatal: true }).decode(
        Uint8Array.from(atob(match[1]!), (c) => c.charCodeAt(0))
      );
    } catch {
      out[key] = value;
    }
  }
  return out;
}

/**
 * True for Node.js Readable streams and Web ReadableStreams.
 */
export function isStreamInput(file: unknown): boolean {
  if (!file || typeof file !== 'object') return false;
  if (isBuffer(file) || isFileInput(file)) return false;
  return (
    typeof (file as { pipe?: unknown }).pipe === 'function' ||
    typeof (file as { getReader?: unknown }).getReader === 'function'
  );
}

/** True for Node.js Readable streams. */
export function isNodeReadable(file: unknown): file is import('node:stream').Readable {
  return (
    !!file &&
    typeof file === 'object' &&
    typeof (file as { pipe?: unknown }).pipe === 'function' &&
    typeof (file as { on?: unknown }).on === 'function'
  );
}

/** True for File/Blob objects. */
export function isFileInput(file: unknown): file is File {
  return typeof Blob !== 'undefined' && file instanceof Blob;
}

/** True for Node.js Buffers. */
export function isBuffer(file: unknown): file is Buffer {
  return typeof Buffer !== 'undefined' && Buffer.isBuffer(file);
}

/**
 * Size of a non-stream input in bytes, or undefined for streams.
 */
export function getInputSize(file: UploadInput): number | undefined {
  if (isBuffer(file)) return file.byteLength;
  if (isFileInput(file)) return file.size;
  return undefined;
}

/**
 * Name of a File input, if any.
 */
export function getInputName(file: UploadInput): string | undefined {
  return isFileInput(file) && typeof (file as File).name === 'string'
    ? (file as File).name
    : undefined;
}

/**
 * Read the first bytes of a non-stream input (for magic-byte detection).
 */
export async function readHead(
  file: File | Buffer,
  length = MAGIC_BYTES_LENGTH
): Promise<Uint8Array> {
  if (isBuffer(file)) return file.subarray(0, length);
  return new Uint8Array(await file.slice(0, length).arrayBuffer());
}

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/heic': 'heic',
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'application/pdf': 'pdf',
  'application/json': 'json',
  'application/zip': 'zip',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'text/html': 'html',
  'text/markdown': 'md',
};

/**
 * Derive a file extension (without dot) from a MIME type.
 */
export function extensionFromMime(mime: string | undefined): string {
  if (!mime) return '';
  const base = mime.split(';')[0]!.trim().toLowerCase();
  if (base === 'application/octet-stream') return '';
  if (MIME_TO_EXT[base]) return MIME_TO_EXT[base]!;
  const sub = base.split('/')[1] ?? '';
  return /^[a-z0-9]{1,8}$/.test(sub) ? sub : '';
}

/**
 * Derive a MIME type from a file extension.
 */
export function mimeFromExtension(ext: string | undefined): string | undefined {
  if (!ext) return undefined;
  const normalized = ext.replace(/^\./, '').toLowerCase();
  if (normalized === 'jpeg') return 'image/jpeg';
  for (const [mime, e] of Object.entries(MIME_TO_EXT)) {
    if (e === normalized) return mime;
  }
  return undefined;
}

/**
 * Determine content type, extension and size for an input.
 *
 * Buffers and Files are sniffed with magic bytes (only the first 4 KB is
 * read). When detection fails, `options.contentType` or the File's declared
 * type is used. Streams use `options.contentType`.
 */
export async function detectContentInfo(
  file: UploadInput,
  options?: Pick<UploadOptions, 'contentType'>
): Promise<{ contentType: string; extension: string; size: number | undefined }> {
  const size = getInputSize(file);
  if (isStreamInput(file)) {
    const contentType = options?.contentType ?? 'application/octet-stream';
    return { contentType, extension: extensionFromMime(contentType), size };
  }
  const detected = await getFileType(await readHead(file as File | Buffer)).catch(() => null);
  if (detected) return { contentType: detected.mime, extension: detected.ext, size };

  const declared =
    options?.contentType ||
    (isFileInput(file) && (file as File).type) ||
    mimeFromExtension(getInputName(file)?.split('.').pop()) ||
    'application/octet-stream';
  const nameExt = getInputName(file)?.includes('.') ? getInputName(file)!.split('.').pop() : '';
  return {
    contentType: declared,
    extension: extensionFromMime(declared) || sanitizeKeySegment(nameExt ?? '').toLowerCase(),
    size,
  };
}

/**
 * MIME types that have no magic-byte signature, so a declared type is the
 * best information available. Anything else must be detected from content.
 */
export function isTextLikeMime(mime: string): boolean {
  const base = mime.split(';')[0]!.trim().toLowerCase();
  return (
    base.startsWith('text/') ||
    base === 'application/json' ||
    base === 'application/xml' ||
    base === 'image/svg+xml'
  );
}

/**
 * Check a MIME type against an allow-list that may contain wildcards
 * (`image/*`). SVG is active content (it can run scripts when served inline),
 * so it only matches when `image/svg+xml` is listed explicitly — `image/*`
 * does not include it.
 */
export function isMimeAllowed(mime: string, allowed: readonly string[]): boolean {
  const type = mime.split(';')[0]!.trim().toLowerCase();
  return allowed.some((pattern) => {
    const p = pattern.trim().toLowerCase();
    if (p === '*/*' || p === '*') return type !== 'image/svg+xml';
    if (p.endsWith('/*')) {
      return type.startsWith(p.slice(0, -1)) && type !== 'image/svg+xml';
    }
    return type === p;
  });
}

/**
 * Determine the content type of an input from its bytes, trusting a declared
 * type only for formats that have no magic-byte signature (text, JSON, SVG).
 * Returns `null` when the content cannot be identified — e.g. a file that
 * claims to be `image/png` but is not.
 */
export async function detectTrustedType(
  file: File | Buffer,
  declaredType?: string
): Promise<{ mime: string; ext: string; detected: boolean } | null> {
  const detected = await getFileType(await readHead(file)).catch(() => null);
  if (detected) return { mime: detected.mime, ext: detected.ext, detected: true };
  const declared = declaredType || (isFileInput(file) ? (file as File).type : '') || '';
  if (declared && isTextLikeMime(declared)) {
    return { mime: declared.split(';')[0]!.trim().toLowerCase(), ext: extensionFromMime(declared), detected: false };
  }
  return null;
}

/**
 * Throw a MediaError(ABORTED) if the signal has been aborted.
 */
export function throwIfAborted(signal: AbortSignal | undefined, provider: string): void {
  if (signal?.aborted) {
    throw new MediaError('Operation aborted', MediaErrorCode.ABORTED, provider, signal.reason);
  }
}

/**
 * Clamp a signed-URL lifetime to `[1, max]` seconds.
 */
export function clampExpiresIn(expiresIn: number | undefined, fallback: number, max: number): number {
  const value = expiresIn ?? fallback;
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), max);
}

/**
 * Run async tasks with a concurrency limit, preserving result order.
 * Rejections are captured, not thrown.
 */
export async function mapSettled<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const limit = Math.max(1, Math.min(concurrency, items.length || 1));
  const workers = Array.from({ length: limit }, async () => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { status: 'fulfilled', value: await fn(items[index]!, index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}
