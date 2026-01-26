/**
 * Configuration options for S3 provider
 */
export interface S3Config {
    /**
     * AWS region
     */
    region: string;

    /**
     * S3 bucket name
     */
    bucket: string;

    /**
     * AWS Access Key ID
     */
    accessKeyId: string;

    /**
     * AWS Secret Access Key
     */
    secretAccessKey: string;

    /**
     * Custom endpoint URL (for S3-compatible services)
     */
    endpoint?: string;

    /**
     * Whether to force path style (required for some S3-compatible services)
     */
    forcePathStyle?: boolean;
}
