import type { S3Client, S3ClientConfig } from '@aws-sdk/client-s3';

/**
 * Configuration options for Cloudflare R2 provider
 */
export interface R2Config {
  /**
   * R2 bucket name
   */
  bucket: string;

  /**
   * R2 Access Key ID
   */
  accessKeyId: string;

  /**
   * R2 Secret Access Key
   */
  secretAccessKey: string;

  /**
   * Public base URL for the bucket (custom domain or r2.dev subdomain).
   * Optional: leave unset for private buckets served through signed URLs.
   * Without it, upload results carry no `publicUrl` and `getUrl()` returns
   * the storage endpoint URL, which is only readable with a signed request.
   */
  publicUrl?: string;

  /**
   * Jurisdiction-specific endpoints (`eu`, `fedramp`) when using `accountId`.
   */
  jurisdiction?: 'eu' | 'fedramp';

  /**
   * Append the detected file extension to generated keys. Default false.
   */
  appendExtension?: boolean;

  /**
   * Use an existing S3Client.
   */
  client?: S3Client;

  /**
   * Extra S3Client options.
   */
  clientConfig?: Partial<S3ClientConfig>;

  /**
   * Multipart upload tuning (see S3Config.multipart).
   */
  multipart?: { partSize?: number; queueSize?: number };
}

export interface R2ProviderConfigWithAccountId extends R2Config {
  accountId: string;
}
export interface R2ProviderConfigWithEndpoint extends R2Config {
  endpoint: string;
}
export type R2ProviderConfig = R2ProviderConfigWithAccountId | R2ProviderConfigWithEndpoint;
