/**
 * FluxMedia Next.js Library
 * Configured uploaders and shared upload rules for server-side use.
 */

import { MediaUploader, createPlugin, type FluxMediaPlugin } from '@fluxmedia/core';
import { CloudinaryProvider } from '@fluxmedia/cloudinary';
import { S3Provider } from '@fluxmedia/s3';
import { R2Provider } from '@fluxmedia/r2';
import { createRetryPlugin } from '@fluxmedia/plugins';

export type ProviderType = 'cloudinary' | 's3' | 'r2';

const PROVIDERS: readonly ProviderType[] = ['cloudinary', 's3', 'r2'];

/** Upload rules shared by the sign and proxy routes. */
export const UPLOAD_RULES = {
  allowedTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  maxSize: 10 * 1024 * 1024,
};

/**
 * Resolve the current user.
 *
 * Replace this with your real session lookup (NextAuth, Clerk, Lucia, …).
 * In development any request is accepted as a demo user; in production a
 * bearer token matching UPLOAD_API_TOKEN is required, so a deployed example
 * is never an open upload endpoint.
 */
export function getUser(request: Request): { id: string } | null {
  if (process.env.NODE_ENV !== 'production') return { id: 'demo' };
  const token = process.env.UPLOAD_API_TOKEN;
  const header = request.headers.get('authorization');
  return token && header === `Bearer ${token}` ? { id: 'api' } : null;
}

export function parseProvider(value: string | null): ProviderType | null {
  return PROVIDERS.includes(value as ProviderType) ? (value as ProviderType) : null;
}

/**
 * Logger Plugin - Logs upload/delete operations (keys only, never file data)
 */
export const loggerPlugin: FluxMediaPlugin = createPlugin(
  'logger',
  {
    afterUpload: async (result) => {
      console.log(`[FluxMedia] Uploaded ${result.provider}:${result.storageKey} (${result.size} bytes)`);
      return result;
    },
    onError: async (error, { phase }) => {
      console.error(`[FluxMedia] Upload failed during ${phase}:`, error.message);
    },
    afterDelete: async (id) => {
      console.log(`[FluxMedia] Deleted: ${id}`);
    },
  },
  { version: '2.0.0', optional: true }
);

const cache = new Map<ProviderType, Promise<MediaUploader>>();

/**
 * Get (and cache) an uploader for a provider.
 */
export function getUploader(provider: ProviderType): Promise<MediaUploader> {
  const cached = cache.get(provider);
  if (cached) return cached;
  const created = createUploader(provider);
  // Don't cache a failed setup (e.g. missing env vars)
  created.catch(() => cache.delete(provider));
  cache.set(provider, created);
  return created;
}

async function createUploader(provider: ProviderType): Promise<MediaUploader> {
  let uploader: MediaUploader;
  switch (provider) {
    case 'cloudinary':
      uploader = new MediaUploader(
        new CloudinaryProvider({
          cloudName: process.env.CLOUDINARY_CLOUD_NAME!,
          apiKey: process.env.CLOUDINARY_API_KEY!,
          apiSecret: process.env.CLOUDINARY_API_SECRET!,
        })
      );
      break;
    case 's3':
      uploader = new MediaUploader(
        new S3Provider({
          region: process.env.AWS_REGION!,
          bucket: process.env.AWS_BUCKET!,
          // Optional: without keys the AWS default credential chain is used
          ...(process.env.AWS_ACCESS_KEY_ID && {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
          }),
          // CloudFront/custom domain, or omit for the S3 URL; set AWS_PRIVATE_BUCKET for signed-only access
          ...(process.env.AWS_PUBLIC_URL && { publicUrl: process.env.AWS_PUBLIC_URL }),
          ...(process.env.AWS_PRIVATE_BUCKET === 'true' && { publicUrl: false as const }),
        })
      );
      break;
    case 'r2':
      uploader = new MediaUploader(
        new R2Provider({
          accountId: process.env.R2_ACCOUNT_ID!,
          bucket: process.env.R2_BUCKET!,
          accessKeyId: process.env.R2_ACCESS_KEY_ID!,
          secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
          // Optional: leave unset for a private bucket served with signed URLs
          ...(process.env.R2_PUBLIC_URL && { publicUrl: process.env.R2_PUBLIC_URL }),
        })
      );
      break;
  }

  await uploader.use(createRetryPlugin({ maxRetries: 2 }));
  await uploader.use(loggerPlugin);
  return uploader;
}
