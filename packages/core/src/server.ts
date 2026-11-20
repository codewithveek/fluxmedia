/**
 * Framework-agnostic request handlers for browser uploads, built on the Web
 * `Request`/`Response` API. They work with Next.js App Router route handlers,
 * Remix/React Router actions, Hono, SvelteKit, Bun and Deno.
 *
 * Both handlers require an `authorize` function, a type allow-list and a size
 * limit, and decide the storage folder on the server. Client-supplied folders
 * and keys are never used.
 *
 * @example
 * ```typescript
 * // app/api/upload/sign/route.ts
 * import { createSignedUploadHandler } from '@fluxmedia/core/server';
 *
 * export const POST = createSignedUploadHandler(uploader, {
 *   authorize: async (req) => getSession(req)?.user ?? null,
 *   allowedTypes: ['image/jpeg', 'image/png', 'image/webp'],
 *   maxSize: 10 * 1024 * 1024,
 *   folder: (user) => `users/${user.id}`,
 * });
 * ```
 */
import { MediaError, MediaErrorCode } from './errors';
import type { MediaUploader } from './media-uploader';
import type { MediaProvider, SignedUploadTarget, UploadResult } from './types';
import { detectTrustedType, extensionFromMime, isMimeAllowed, sanitizeKeySegment } from './utils';

type Awaitable<T> = T | Promise<T>;
type UploaderLike = Pick<MediaUploader, 'upload' | 'createUploadUrl'> | MediaProvider;

export interface UploadHandlerOptions<TUser> {
  /**
   * Authenticate the request. Return the user (any truthy value) to allow it,
   * or a falsy value to answer 401. Required: an upload endpoint without
   * authentication lets anyone store files in your bucket.
   */
  authorize: (request: Request) => Awaitable<TUser | null | undefined | false>;
  /**
   * Allowed MIME types. Wildcards like `image/*` are supported; SVG must be
   * listed explicitly (`image/svg+xml`) because it can carry scripts.
   */
  allowedTypes: string[];
  /** Maximum file size in bytes. */
  maxSize: number;
  /**
   * Destination folder, decided on the server. A function receives the
   * authorized user, e.g. `(user) => \`users/${user.id}\``.
   */
  folder?: string | ((user: TUser, request: Request) => Awaitable<string>);
  /** Extra metadata to store with the file. */
  metadata?: (user: TUser, request: Request) => Awaitable<Record<string, unknown>>;
  /** Extra response headers (e.g. CORS). */
  headers?: Record<string, string>;
  /** Called with unexpected errors (they are answered with a generic 500). */
  onError?: (error: unknown, request: Request) => void;
}

export interface SignedUploadHandlerOptions<TUser> extends UploadHandlerOptions<TUser> {
  /** Lifetime of the upload URL in seconds (default 600). */
  expiresIn?: number;
}

export interface ProxyUploadHandlerOptions<TUser> extends UploadHandlerOptions<TUser> {
  /** Multipart field holding the file (default `file`). */
  fieldName?: string;
  /** Shape the JSON response. Defaults to a result without internal metadata. */
  serialize?: (result: UploadResult) => unknown;
}

/** Request body accepted by the signed-upload handler. */
export interface SignedUploadRequestBody {
  filename?: string;
  contentType: string;
  size: number;
}

const MAX_JSON_BODY = 16 * 1024;
const MULTIPART_OVERHEAD = 64 * 1024;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

function json(body: unknown, status: number, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
}

function baseName(filename: unknown): string | undefined {
  if (typeof filename !== 'string') return undefined;
  const name = filename.split(/[/\\]/).pop() ?? '';
  const withoutExt = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name;
  return sanitizeKeySegment(withoutExt) || undefined;
}

async function authorizeOrThrow<TUser>(
  request: Request,
  options: UploadHandlerOptions<TUser>
): Promise<TUser> {
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  const user = await options.authorize(request);
  if (!user) throw new HttpError(401, 'Unauthorized');
  return user;
}

async function resolveFolder<TUser>(
  user: TUser,
  request: Request,
  options: UploadHandlerOptions<TUser>
): Promise<string | undefined> {
  if (typeof options.folder === 'function') return options.folder(user, request);
  return options.folder;
}

function validateOptions(options: UploadHandlerOptions<unknown>): void {
  if (typeof options.authorize !== 'function') {
    throw new Error('Upload handlers require an authorize() function');
  }
  if (!Array.isArray(options.allowedTypes) || options.allowedTypes.length === 0) {
    throw new Error('Upload handlers require a non-empty allowedTypes list');
  }
  if (!Number.isFinite(options.maxSize) || options.maxSize <= 0) {
    throw new Error('Upload handlers require a positive maxSize');
  }
}

function handleError(error: unknown, request: Request, options: UploadHandlerOptions<never>): Response {
  if (error instanceof HttpError) return json({ error: error.message }, error.status, options.headers);
  if (error instanceof MediaError) {
    const status =
      error.code === MediaErrorCode.FILE_TOO_LARGE
        ? 413
        : error.code === MediaErrorCode.INVALID_FILE_TYPE
          ? 415
          : null;
    if (status) return json({ error: error.message, code: error.code }, status, options.headers);
  }
  options.onError?.(error, request);
  return json({ error: 'Upload failed' }, 500, options.headers);
}

async function readJson(request: Request): Promise<unknown> {
  const length = Number(request.headers.get('content-length') ?? 0);
  if (length > MAX_JSON_BODY) throw new HttpError(413, 'Request body too large');
  const text = await request.text();
  if (text.length > MAX_JSON_BODY) throw new HttpError(413, 'Request body too large');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

/**
 * Create a handler that returns a signed upload target, so the browser
 * uploads straight to storage.
 *
 * The client sends `{ filename, contentType, size }`. On S3 and R2 the
 * content type and exact size are part of the signature, so the storage
 * rejects any other file. Cloudinary signatures cannot enforce size or type;
 * use an upload preset with limits there, or the proxy handler.
 */
export function createSignedUploadHandler<TUser>(
  uploader: UploaderLike,
  options: SignedUploadHandlerOptions<TUser>
): (request: Request) => Promise<Response> {
  validateOptions(options as UploadHandlerOptions<unknown>);
  if (typeof uploader.createUploadUrl !== 'function') {
    throw new Error('This provider does not support signed uploads');
  }
  return async (request) => {
    try {
      const user = await authorizeOrThrow(request, options);
      const body = (await readJson(request)) as Partial<SignedUploadRequestBody> | null;
      const contentType = typeof body?.contentType === 'string' ? body.contentType.trim() : '';
      const size = body?.size;

      if (!contentType) throw new HttpError(400, 'contentType is required');
      if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) {
        throw new HttpError(400, 'size must be a positive integer');
      }
      if (size > options.maxSize) {
        throw new HttpError(413, `File exceeds maximum size of ${options.maxSize} bytes`);
      }
      if (!isMimeAllowed(contentType, options.allowedTypes)) {
        throw new HttpError(415, `File type ${contentType} is not allowed`);
      }

      const folder = await resolveFolder(user, request, options);
      const metadata = options.metadata ? await options.metadata(user, request) : undefined;
      const filename = baseName(body?.filename);
      const target: SignedUploadTarget = await uploader.createUploadUrl!({
        contentType,
        size,
        ...(filename && { filename }),
        ...(folder && { folder }),
        ...(metadata && { metadata }),
        ...(options.expiresIn && { expiresIn: options.expiresIn }),
      });
      return json(target, 200, options.headers);
    } catch (error) {
      return handleError(error, request, options as UploadHandlerOptions<never>);
    }
  };
}

/**
 * Create a handler that receives a multipart upload and stores it through
 * the uploader (so plugins run). The request must declare `Content-Length`;
 * oversized bodies are rejected before they are read. The file type is
 * detected from its bytes, not trusted from the client.
 */
export function createProxyUploadHandler<TUser>(
  uploader: Pick<MediaUploader, 'upload'> | MediaProvider,
  options: ProxyUploadHandlerOptions<TUser>
): (request: Request) => Promise<Response> {
  validateOptions(options as UploadHandlerOptions<unknown>);
  const fieldName = options.fieldName ?? 'file';
  return async (request) => {
    try {
      const user = await authorizeOrThrow(request, options);

      const declaredLength = request.headers.get('content-length');
      if (!declaredLength) throw new HttpError(411, 'Content-Length required');
      if (Number(declaredLength) > options.maxSize + MULTIPART_OVERHEAD) {
        throw new HttpError(413, `File exceeds maximum size of ${options.maxSize} bytes`);
      }

      let form: FormData;
      try {
        form = await request.formData();
      } catch {
        throw new HttpError(400, 'Expected multipart/form-data');
      }
      const file = form.get(fieldName);
      if (!file || typeof file === 'string') throw new HttpError(400, `Missing "${fieldName}" file`);
      if (file.size === 0) throw new HttpError(400, 'File is empty');
      if (file.size > options.maxSize) {
        throw new HttpError(413, `File exceeds maximum size of ${options.maxSize} bytes`);
      }

      const type = await detectTrustedType(file);
      if (!type || !isMimeAllowed(type.mime, options.allowedTypes)) {
        throw new HttpError(415, `File type ${type?.mime ?? 'unknown'} is not allowed`);
      }

      const folder = await resolveFolder(user, request, options);
      const metadata = options.metadata ? await options.metadata(user, request) : undefined;
      const filename = baseName(file.name);
      const result = await uploader.upload(file, {
        contentType: type.mime,
        ...(filename && { filename }),
        ...(folder && { folder }),
        ...(metadata && { metadata }),
        signal: request.signal,
      });
      return json(options.serialize ? options.serialize(result) : publicResult(result), 200, options.headers);
    } catch (error) {
      return handleError(error, request, options as UploadHandlerOptions<never>);
    }
  };
}

/**
 * The fields of an upload result that are safe to send to a browser.
 */
export function publicResult(result: UploadResult): Omit<UploadResult, 'metadata'> {
  const out: Omit<UploadResult, 'metadata'> = {
    id: result.id,
    url: result.url,
    size: result.size,
    format: result.format || extensionFromMime(result.contentType),
    provider: result.provider,
    createdAt: result.createdAt,
  };
  if (result.storageKey) out.storageKey = result.storageKey;
  if (result.publicUrl) out.publicUrl = result.publicUrl;
  if (result.contentType) out.contentType = result.contentType;
  if (result.width !== undefined) out.width = result.width;
  if (result.height !== undefined) out.height = result.height;
  return out;
}
