/**
 * Configuration options for Cloudflare R2 provider
 */
export interface R2Config {
    /**
     * Cloudflare account ID
     */
    accountId: string;

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
     * Custom public URL for the bucket (if configured)
     */
    publicUrl?: string;
}
