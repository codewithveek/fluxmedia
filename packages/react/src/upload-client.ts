import type { SignedUploadTarget, UploadResult } from '@fluxmedia/core';
import type { ClientUploadOptions, UseMediaUploadConfig } from './types';

/**
 * Error thrown by browser uploads.
 */
export class UploadClientError extends Error {
  constructor(
    message: string,
    /** 'validation' | 'aborted' | 'network' | 'server' | 'config' */
    readonly kind: 'validation' | 'aborted' | 'network' | 'server' | 'config',
    /** HTTP status, for server errors. */
    readonly status?: number
  ) {
    super(message);
    this.name = 'UploadClientError';
  }
}

/**
 * Check a file against an `accept`-style list and a size limit.
 * Returns an error message, or null when the file is acceptable.
 */
export function validateFile(
  file: File,
  rules: { accept?: string | string[] | undefined; maxSize?: number | undefined }
): string | null {
  if (rules.maxSize !== undefined && file.size > rules.maxSize) {
    return `${file.name} exceeds the maximum size of ${rules.maxSize} bytes`;
  }
  const accept = typeof rules.accept === 'string' ? rules.accept.split(',') : rules.accept;
  const patterns = (accept ?? []).map((p) => p.trim().toLowerCase()).filter(Boolean);
  if (patterns.length === 0) return null;

  const type = (file.type || '').toLowerCase();
  const name = file.name.toLowerCase();
  const ok = patterns.some((p) => {
    if (p.startsWith('.')) return name.endsWith(p);
    if (p.endsWith('/*')) return type.startsWith(p.slice(0, -1)) && type !== 'image/svg+xml';
    return type === p;
  });
  return ok ? null : `${file.name} is not an accepted file type`;
}

async function resolveHeaders(config: UseMediaUploadConfig): Promise<Record<string, string>> {
  if (!config.headers) return {};
  return typeof config.headers === 'function' ? await config.headers() : config.headers;
}

async function serverError(response: Response, fallback: string): Promise<UploadClientError> {
  let message = fallback;
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body?.error === 'string' && body.error.length < 300) message = body.error;
  } catch {
    // not JSON
  }
  return new UploadClientError(message, 'server', response.status);
}

function parseJson(text: string): Record<string, unknown> {
  if (!text) return {};
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Send a request with XMLHttpRequest for real upload progress and abort.
 */
export function sendWithProgress(
  url: string,
  options: {
    method: 'PUT' | 'POST';
    body: File | FormData;
    headers?: Record<string, string> | undefined;
    withCredentials?: boolean;
    onProgress?: ((loaded: number, total: number) => void) | undefined;
    signal?: AbortSignal | undefined;
  }
): Promise<{ status: number; response: string }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new UploadClientError('Upload cancelled', 'aborted'));
      return;
    }
    const xhr = new XMLHttpRequest();
    const onAbort = () => xhr.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => options.signal?.removeEventListener('abort', onAbort);

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) options.onProgress?.(event.loaded, event.total);
    });
    xhr.addEventListener('load', () => {
      cleanup();
      resolve({ status: xhr.status, response: xhr.responseText });
    });
    xhr.addEventListener('error', () => {
      cleanup();
      reject(new UploadClientError('Network error during upload', 'network'));
    });
    xhr.addEventListener('abort', () => {
      cleanup();
      reject(new UploadClientError('Upload cancelled', 'aborted'));
    });

    xhr.open(options.method, url);
    xhr.withCredentials = !!options.withCredentials;
    for (const [key, value] of Object.entries(options.headers ?? {})) {
      // Browsers set Content-Length themselves and refuse it from scripts
      if (key.toLowerCase() !== 'content-length') xhr.setRequestHeader(key, value);
    }
    xhr.send(options.body);
  });
}

function extensionOf(name: string): string {
  return name.includes('.') ? (name.split('.').pop() ?? '').toLowerCase() : '';
}

/**
 * Upload a file using the configured mode. Progress is reported 0-100.
 */
export async function uploadFile(
  file: File,
  config: UseMediaUploadConfig,
  options: ClientUploadOptions = {},
  onProgress?: (progress: number) => void
): Promise<UploadResult> {
  const invalid = validateFile(file, { accept: config.accept, maxSize: config.maxSize });
  if (invalid) throw new UploadClientError(invalid, 'validation');

  switch (config.mode) {
    case 'signed':
      return uploadSigned(file, config, options, onProgress);
    case 'proxy':
      return uploadProxy(file, config, options, onProgress);
    default:
      throw new UploadClientError(
        "Direct mode is not supported: it would expose storage credentials in the browser. Use mode 'signed'.",
        'config'
      );
  }
}

async function uploadSigned(
  file: File,
  config: UseMediaUploadConfig,
  options: ClientUploadOptions,
  onProgress?: (progress: number) => void
): Promise<UploadResult> {
  if (!config.signUrlEndpoint) {
    throw new UploadClientError('signUrlEndpoint is required for signed mode', 'config');
  }

  onProgress?.(0);
  let signResponse: Response;
  try {
    signResponse = await fetch(config.signUrlEndpoint, {
      method: 'POST',
      credentials: config.credentials ?? 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(await resolveHeaders(config)) },
      body: JSON.stringify({
        filename: file.name,
        contentType: file.type || 'application/octet-stream',
        size: file.size,
        folder: options.folder ?? config.defaultOptions?.folder,
        tags: options.tags ?? config.defaultOptions?.tags,
        provider: options.provider,
        metadata: options.metadata,
      }),
      ...(options.signal && { signal: options.signal }),
    });
  } catch (error) {
    if (options.signal?.aborted) throw new UploadClientError('Upload cancelled', 'aborted');
    throw new UploadClientError(`Could not reach the sign endpoint: ${(error as Error).message}`, 'network');
  }
  if (!signResponse.ok) throw await serverError(signResponse, 'Failed to get signed upload URL');

  const target = (await signResponse.json()) as Partial<SignedUploadTarget> & {
    publicId?: string;
  };
  if (!target.uploadUrl) throw new UploadClientError('Sign endpoint returned no uploadUrl', 'server');
  onProgress?.(5);

  const reportProgress = (loaded: number, total: number) =>
    onProgress?.(Math.floor(5 + (loaded / total) * 90));

  let response: { status: number; response: string };
  if (target.method === 'PUT') {
    response = await sendWithProgress(target.uploadUrl, {
      method: 'PUT',
      body: file,
      headers: target.headers ?? { 'Content-Type': file.type || 'application/octet-stream' },
      onProgress: reportProgress,
      signal: options.signal,
    });
  } else {
    const formData = new FormData();
    for (const [key, value] of Object.entries(target.fields ?? {})) formData.append(key, String(value));
    formData.append('file', file);
    response = await sendWithProgress(target.uploadUrl, {
      method: 'POST',
      body: formData,
      onProgress: reportProgress,
      signal: options.signal,
    });
  }

  if (response.status < 200 || response.status >= 300) {
    const body = parseJson(response.response);
    const message =
      (body.error as { message?: string } | undefined)?.message ?? `Upload failed with HTTP ${response.status}`;
    throw new UploadClientError(message, 'server', response.status);
  }
  onProgress?.(100);

  // S3/R2 return an empty body; Cloudinary returns the asset as JSON
  const body = parseJson(response.response);
  const storageKey = String(target.storageKey ?? target.publicId ?? body.public_id ?? body.key ?? '');
  const cloudinaryPublic = body.type === 'upload' ? (body.secure_url as string | undefined) : undefined;
  const publicUrl = target.publicUrl ?? cloudinaryPublic;
  const url = publicUrl ?? (body.secure_url as string | undefined) ?? target.uploadUrl.split('?')[0]!;

  const result: UploadResult = {
    id: storageKey,
    storageKey,
    url,
    size: typeof body.bytes === 'number' ? body.bytes : file.size,
    format: (body.format as string | undefined) ?? extensionOf(file.name),
    provider: target.provider ?? options.provider ?? 'signed',
    metadata: body,
    createdAt: body.created_at ? new Date(String(body.created_at)) : new Date(),
  };
  if (publicUrl) result.publicUrl = publicUrl;
  if (file.type) result.contentType = file.type;
  if (typeof body.width === 'number') result.width = body.width;
  if (typeof body.height === 'number') result.height = body.height;
  return result;
}

async function uploadProxy(
  file: File,
  config: UseMediaUploadConfig,
  options: ClientUploadOptions,
  onProgress?: (progress: number) => void
): Promise<UploadResult> {
  if (!config.proxyEndpoint) {
    throw new UploadClientError('proxyEndpoint is required for proxy mode', 'config');
  }

  onProgress?.(0);
  const formData = new FormData();
  formData.append('file', file);
  const folder = options.folder ?? config.defaultOptions?.folder;
  if (folder) formData.append('folder', folder);
  const tags = options.tags ?? config.defaultOptions?.tags;
  if (tags) formData.append('tags', JSON.stringify(tags));
  if (options.provider) formData.append('provider', options.provider);
  if (options.metadata) formData.append('metadata', JSON.stringify(options.metadata));

  const response = await sendWithProgress(config.proxyEndpoint, {
    method: 'POST',
    body: formData,
    headers: await resolveHeaders(config),
    withCredentials: config.credentials === 'include',
    onProgress: (loaded, total) => onProgress?.(Math.floor((loaded / total) * 95)),
    signal: options.signal,
  });

  const body = parseJson(response.response);
  if (response.status < 200 || response.status >= 300) {
    const message = typeof body.error === 'string' ? body.error : `Upload failed with HTTP ${response.status}`;
    throw new UploadClientError(message, 'server', response.status);
  }
  if (typeof body.id !== 'string' || typeof body.url !== 'string') {
    throw new UploadClientError('Upload endpoint returned an invalid response', 'server', response.status);
  }
  onProgress?.(100);

  const result: UploadResult = {
    id: body.id,
    url: body.url,
    size: typeof body.size === 'number' ? body.size : file.size,
    format: (body.format as string | undefined) ?? extensionOf(file.name),
    provider: (body.provider as string | undefined) ?? 'proxy',
    metadata: (body.metadata as Record<string, unknown> | undefined) ?? {},
    createdAt: body.createdAt ? new Date(String(body.createdAt)) : new Date(),
  };
  if (typeof body.storageKey === 'string') result.storageKey = body.storageKey;
  if (typeof body.publicUrl === 'string') result.publicUrl = body.publicUrl;
  if (typeof body.contentType === 'string') result.contentType = body.contentType;
  if (typeof body.width === 'number') result.width = body.width;
  if (typeof body.height === 'number') result.height = body.height;
  return result;
}
