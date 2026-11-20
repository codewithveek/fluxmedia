import type { S3Client, S3ClientConfig } from '@aws-sdk/client-s3';

/**
 * Configuration options for S3 provider
 */
export interface S3Config {
  /**
   * AWS region. Required unless you pass your own `client`.
   */
  region?: string;

  /**
   * S3 bucket name
   */
  bucket: string;

  /**
   * AWS Access Key ID. Optional: without static keys (and without
   * `credentials`), the AWS SDK default credential chain is used — IAM roles,
   * ECS/EKS task roles, SSO, environment variables, shared config files.
   */
  accessKeyId?: string;

  /**
   * AWS Secret Access Key. Must be set together with `accessKeyId`.
   */
  secretAccessKey?: string;

  /**
   * Session token for temporary (STS) credentials.
   */
  sessionToken?: string;

  /**
   * Credentials or a credential provider (e.g. from `@aws-sdk/credential-providers`).
   * Takes precedence over the static keys.
   */
  credentials?: S3ClientConfig['credentials'];

  /**
   * Custom endpoint URL (for S3-compatible services: MinIO, Backblaze B2,
   * Wasabi, DigitalOcean Spaces, Supabase Storage, …)
   */
  endpoint?: string;

  /**
   * Whether to force path style (required for some S3-compatible services)
   */
  forcePathStyle?: boolean;

  /**
   * Use an existing S3Client instead of creating one. `region`, credentials
   * and `endpoint` are then ignored for requests.
   */
  client?: S3Client;

  /**
   * Extra S3Client options (retry strategy, request handler, …).
   */
  clientConfig?: Partial<S3ClientConfig>;

  /**
   * Public URL configuration:
   * - a string: base URL for public links, e.g. a CloudFront distribution
   *   (`https://d111.cloudfront.net`) or custom domain
   * - `false`: the bucket is private; results have no `publicUrl` — serve
   *   files with `getSignedUrl()`
   * - unset: the S3 object URL is reported as the public URL
   */
  publicUrl?: string | false;

  /**
   * Apply `UploadOptions.public` as an object ACL (`public-read` / `private`).
   * Only enable this for buckets with ACLs enabled; new buckets have ACLs
   * disabled ("Bucket owner enforced") and reject ACL headers.
   */
  useAcl?: boolean;

  /**
   * Append the detected file extension to generated keys
   * (`avatars/me-x1y2z3.png` instead of `avatars/me-x1y2z3`). Default false.
   */
  appendExtension?: boolean;

  /**
   * Multipart upload tuning.
   */
  multipart?: {
    /** Part size in bytes (min 5 MB). Default 5 MB. */
    partSize?: number;
    /** Parts uploaded in parallel. Default 4. */
    queueSize?: number;
  };
}
