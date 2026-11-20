import { MediaErrorCode, createMediaError } from '@fluxmedia/core';
import { S3Provider } from '@fluxmedia/s3';
import { R2Features } from './features';
import type {
  R2ProviderConfig,
  R2ProviderConfigWithAccountId,
  R2ProviderConfigWithEndpoint,
} from './types';

function resolveEndpoint(config: R2ProviderConfig): string {
  const endpoint = (config as R2ProviderConfigWithEndpoint).endpoint;
  if (endpoint) return endpoint.replace(/\/+$/, '');
  const accountId = (config as R2ProviderConfigWithAccountId).accountId;
  const jurisdiction = config.jurisdiction ? `.${config.jurisdiction}` : '';
  return `https://${accountId}${jurisdiction}.r2.cloudflarestorage.com`;
}

/**
 * Cloudflare R2 provider implementation.
 * Uses the S3-compatible API (it is an `S3Provider` configured for R2).
 *
 * R2 has no object ACLs: visibility is a bucket setting. Configure
 * `publicUrl` for a public bucket; leave it unset for a private bucket and
 * serve files with `getSignedUrl()`.
 */
export class R2Provider extends S3Provider {
  private readonly r2Config!: R2ProviderConfig;

  constructor(config: R2ProviderConfig) {
    const accountId = (config as R2ProviderConfigWithAccountId)?.accountId;
    const endpoint = (config as R2ProviderConfigWithEndpoint)?.endpoint;
    if (!accountId && !endpoint) {
      throw createMediaError(
        MediaErrorCode.INVALID_CONFIG,
        'r2',
        new Error('Either accountId or endpoint must be provided')
      );
    }
    const missing = (['bucket', 'accessKeyId', 'secretAccessKey'] as const).filter(
      (field) => !config[field] && !(field !== 'bucket' && config.client)
    );
    if (missing.length > 0) {
      throw createMediaError(
        MediaErrorCode.INVALID_CONFIG,
        'r2',
        new Error(`Missing required R2 configuration: ${missing.join(', ')}`)
      );
    }

    super(
      {
        region: 'auto', // R2 uses 'auto' for region
        bucket: config.bucket,
        endpoint: resolveEndpoint(config),
        forcePathStyle: true,
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        // R2 buckets are private unless a public domain is configured
        publicUrl: config.publicUrl ? config.publicUrl : false,
        ...(config.client && { client: config.client }),
        ...(config.clientConfig && { clientConfig: config.clientConfig }),
        ...(config.multipart && { multipart: config.multipart }),
        ...(config.appendExtension !== undefined && { appendExtension: config.appendExtension }),
      },
      { name: 'r2', features: R2Features }
    );

    Object.defineProperty(this, 'r2Config', {
      value: config,
      writable: false,
      enumerable: false,
      configurable: false,
    });
  }

  /**
   * Get safe config info for debugging (no secrets)
   */
  override getConfigInfo(): Record<string, unknown> {
    return {
      bucket: this.r2Config.bucket,
      accountId: (this.r2Config as R2ProviderConfigWithAccountId).accountId,
      endpoint: resolveEndpoint(this.r2Config),
      publicUrl: this.r2Config.publicUrl,
    };
  }
}
