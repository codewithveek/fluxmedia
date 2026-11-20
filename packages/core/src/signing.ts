/**
 * HMAC-signed, expiring URLs for providers that have no native signing
 * (local filesystem, in-memory). Uses Web Crypto, so it works in Node 20+,
 * browsers and edge runtimes.
 */
import { encodeKeyForUrl } from './utils';

const encoder = new TextEncoder();

function toBase64Url(bytes: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmac(secret: string, payload: string): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return toBase64Url(await globalThis.crypto.subtle.sign('HMAC', key, encoder.encode(payload)));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function canonical(key: string, expires: number, downloadAs: string): string {
  return `fluxmedia:v1\n${key}\n${expires}\n${downloadAs}`;
}

export interface CreateSignedUrlOptions {
  /** Secret used to sign; at least 32 characters. */
  secret: string;
  /** Lifetime in seconds. */
  expiresIn: number;
  /** Suggested download filename. */
  downloadAs?: string | undefined;
  /** Override the current time (ms), for tests. */
  now?: number;
}

/**
 * Create a signed URL: `${baseUrl}/${key}?expires=…&signature=…`.
 */
export async function createSignedUrl(
  baseUrl: string,
  key: string,
  options: CreateSignedUrlOptions
): Promise<string> {
  assertSecret(options.secret);
  const expires = Math.floor((options.now ?? Date.now()) / 1000) + options.expiresIn;
  const downloadAs = options.downloadAs ?? '';
  const signature = await hmac(options.secret, canonical(key, expires, downloadAs));
  const params = new URLSearchParams({ expires: String(expires), signature });
  if (downloadAs) params.set('download', downloadAs);
  return `${baseUrl.replace(/\/+$/, '')}/${encodeKeyForUrl(key)}?${params.toString()}`;
}

export type VerifySignedUrlResult =
  | { valid: true; key: string; downloadAs?: string }
  | { valid: false; reason: 'malformed' | 'expired' | 'bad-signature' };

/**
 * Verify a URL produced by `createSignedUrl`.
 *
 * @param url - The full request URL.
 * @param options.secret - The signing secret.
 * @param options.pathPrefix - Path the key is mounted under, e.g. `/files`.
 */
export async function verifySignedUrl(
  url: string | URL,
  options: { secret: string; pathPrefix?: string; now?: number }
): Promise<VerifySignedUrlResult> {
  assertSecret(options.secret);
  const parsed = typeof url === 'string' ? new URL(url, 'http://localhost') : url;
  const prefix = (options.pathPrefix ?? '').replace(/\/+$/, '');
  if (!parsed.pathname.startsWith(`${prefix}/`)) return { valid: false, reason: 'malformed' };

  let key: string;
  try {
    key = parsed.pathname
      .slice(prefix.length + 1)
      .split('/')
      .map(decodeURIComponent)
      .join('/');
  } catch {
    return { valid: false, reason: 'malformed' };
  }
  const expires = Number(parsed.searchParams.get('expires'));
  const signature = parsed.searchParams.get('signature') ?? '';
  const downloadAs = parsed.searchParams.get('download') ?? '';
  if (!key || !Number.isInteger(expires) || !signature) return { valid: false, reason: 'malformed' };

  const expected = await hmac(options.secret, canonical(key, expires, downloadAs));
  if (!timingSafeEqual(expected, signature)) return { valid: false, reason: 'bad-signature' };
  if (expires < Math.floor((options.now ?? Date.now()) / 1000)) {
    return { valid: false, reason: 'expired' };
  }
  return downloadAs ? { valid: true, key, downloadAs } : { valid: true, key };
}

function assertSecret(secret: string): void {
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new Error('Signing secret must be a string of at least 32 characters');
  }
}
