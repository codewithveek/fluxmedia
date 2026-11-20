/**
 * Configuration options for Cloudinary provider
 */
export interface CloudinaryConfig {
  /**
   * Cloudinary cloud name
   */
  cloudName: string;

  /**
   * API key
   */
  apiKey: string;

  /**
   * API secret
   */
  apiSecret: string;

  /**
   * Use secure URLs (https)
   * @default true
   */
  secure?: boolean;

  /**
   * Token-based authentication key (Cloudinary Advanced plans). When set,
   * `getSignedUrl()` returns delivery URLs with a real expiry that also
   * support transformations. Without it, signed URLs use the private
   * download API (original file only).
   */
  authTokenKey?: string;

  /**
   * Custom delivery domain (CNAME / private CDN distribution).
   */
  secureDistribution?: string;
}

/**
 * Cloudinary resource types.
 */
export type CloudinaryResourceType = 'image' | 'video' | 'raw';

/**
 * Cloudinary delivery types used by this provider.
 */
export type CloudinaryDeliveryType = 'upload' | 'authenticated' | 'private';

/**
 * Cloudinary-specific upload options
 */
export interface CloudinaryUploadOptions {
  folder?: string;
  public_id?: string;
  tags?: string[];
  context?: Record<string, string>;
  transformation?: unknown[];
  resource_type?: 'image' | 'video' | 'raw' | 'auto';
  type?: CloudinaryDeliveryType;
  [key: string]: unknown;
}

/**
 * Raw response from Cloudinary upload API
 */
export interface CloudinaryUploadResponse {
  public_id: string;
  version: number;
  signature?: string;
  width?: number;
  height?: number;
  format: string;
  resource_type: string;
  created_at: string;
  tags?: string[];
  bytes: number;
  type: string;
  url: string;
  secure_url: string;
  context?: { custom?: Record<string, string> } | Record<string, string>;
  [key: string]: unknown;
}

/**
 * Type alias for the Cloudinary SDK v2 client.
 * Uses the actual SDK type for full type safety and native access.
 */
export type CloudinaryClient = typeof import('cloudinary').v2;
