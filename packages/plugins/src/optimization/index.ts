/**
 * Image Optimization Plugin for FluxMedia (Server-side)
 *
 * Optimizes images using sharp before upload.
 * Requires sharp as a peer dependency.
 */

import type { FluxMediaPlugin, UploadInput, UploadOptions } from '@fluxmedia/core';
import { isFileInput } from '@fluxmedia/core';
import { fileToBuffer, isInspectable, isRasterImage } from '../utils';

/**
 * Options for the image optimization plugin
 */
export interface ImageOptimizationOptions {
  /** Maximum width in pixels (default: 2000) */
  maxWidth?: number;
  /** Maximum height in pixels (default: 2000) */
  maxHeight?: number;
  /** Quality 0-1 for lossy formats (default: 0.85) */
  quality?: number;
  /** Output format: 'auto' (WebP), 'webp', 'avif', 'jpeg', 'png' (default: 'auto') */
  format?: 'auto' | 'webp' | 'avif' | 'jpeg' | 'png';
  /**
   * Strip EXIF (including GPS location) and other metadata (default: true).
   * sharp drops metadata unless told to keep it.
   */
  stripMetadata?: boolean;
  /** Auto-orient based on EXIF (default: true) */
  autoOrient?: boolean;
  /** Preserve aspect ratio when resizing (default: true) */
  preserveAspectRatio?: boolean;
  /**
   * Keep the original when re-encoding would make it larger and no resize
   * was needed (default: true). Ignored when `stripMetadata` is true and
   * the original has EXIF data, so location data is never kept by accident.
   */
  skipIfLarger?: boolean;
  /** Refuse to decode images with more pixels than this (default: 100 megapixels). */
  maxInputPixels?: number;
}

/**
 * Optimization result metadata
 */
export interface OptimizationMetadata {
  originalSize: number;
  optimizedSize: number;
  savings: number;
  savingsPercent: string;
  format: string;
  quality: number;
  resized: boolean;
  skipped?: boolean;
  dimensions?:
    | {
        original: { width: number; height: number };
        optimized: { width: number; height: number };
      }
    | undefined;
}

const MIME: Record<string, string> = {
  webp: 'image/webp',
  avif: 'image/avif',
  jpeg: 'image/jpeg',
  png: 'image/png',
};

/**
 * Create an image optimization plugin (server-side). Works with Buffers and
 * Files; streams are passed through untouched.
 *
 * @example
 * ```typescript
 * const optimizationPlugin = createImageOptimizationPlugin({
 *   maxWidth: 2000,
 *   maxHeight: 2000,
 *   quality: 0.85,
 *   format: 'webp',
 * });
 * ```
 */
export function createImageOptimizationPlugin(
  options: ImageOptimizationOptions = {}
): FluxMediaPlugin {
  const config = {
    maxWidth: options.maxWidth ?? 2000,
    maxHeight: options.maxHeight ?? 2000,
    quality: Math.min(Math.max(options.quality ?? 0.85, 0.01), 1),
    format: options.format ?? 'auto',
    stripMetadata: options.stripMetadata ?? true,
    autoOrient: options.autoOrient ?? true,
    preserveAspectRatio: options.preserveAspectRatio ?? true,
    skipIfLarger: options.skipIfLarger ?? true,
    maxInputPixels: options.maxInputPixels ?? 100_000_000,
  };

  return {
    name: 'image-optimization',
    version: '1.0.0',
    hooks: {
      async beforeUpload(
        file: UploadInput,
        uploadOptions: UploadOptions
      ): Promise<{ file: UploadInput; options: UploadOptions } | void> {
        // Only raster images that can be read without consuming a stream (SVG excluded)
        if (!isInspectable(file) || !(await isRasterImage(file))) {
          return { file, options: uploadOptions };
        }

        try {
          // Lazy load sharp (peer dependency)
          const sharp = (await import('sharp')).default;
          const buffer = await fileToBuffer(file);
          const originalSize = buffer.byteLength;

          let image = sharp(buffer, { limitInputPixels: config.maxInputPixels });
          if (config.autoOrient) image = image.rotate();

          const originalMetadata = await image.metadata();
          const needsResize = !!(
            (originalMetadata.width && originalMetadata.width > config.maxWidth) ||
            (originalMetadata.height && originalMetadata.height > config.maxHeight)
          );

          if (needsResize) {
            image = image.resize(config.maxWidth, config.maxHeight, {
              fit: config.preserveAspectRatio ? 'inside' : 'cover',
              withoutEnlargement: true,
            });
          }

          const outputFormat = config.format === 'auto' ? 'webp' : config.format;
          const qualityPercent = Math.round(config.quality * 100);
          switch (outputFormat) {
            case 'webp':
              image = image.webp({ quality: qualityPercent });
              break;
            case 'avif':
              image = image.avif({ quality: qualityPercent });
              break;
            case 'jpeg':
              image = image.jpeg({ quality: qualityPercent, mozjpeg: true });
              break;
            case 'png':
              image = image.png({ compressionLevel: 9, palette: qualityPercent < 100, quality: qualityPercent });
              break;
          }

          // sharp strips metadata by default; keep it only when asked to
          if (!config.stripMetadata) image = image.withMetadata();

          const optimizedBuffer = await image.toBuffer();
          const optimizedSize = optimizedBuffer.byteLength;

          const sameFormat = originalMetadata.format === outputFormat;
          const hasPrivateMetadata = config.stripMetadata && !!originalMetadata.exif;
          if (config.skipIfLarger && !needsResize && sameFormat && optimizedSize >= originalSize && !hasPrivateMetadata) {
            return {
              file,
              options: {
                ...uploadOptions,
                metadata: {
                  ...uploadOptions.metadata,
                  optimization: {
                    originalSize,
                    optimizedSize: originalSize,
                    savings: 0,
                    savingsPercent: '0.00%',
                    format: outputFormat,
                    quality: config.quality,
                    resized: false,
                    skipped: true,
                  } satisfies OptimizationMetadata,
                },
              },
            };
          }

          const optimizedMetadata = await sharp(optimizedBuffer).metadata();
          const savings = originalSize - optimizedSize;

          const optimizationMeta: OptimizationMetadata = {
            originalSize,
            optimizedSize,
            savings,
            savingsPercent: `${((savings / originalSize) * 100).toFixed(2)}%`,
            format: outputFormat,
            quality: config.quality,
            resized: needsResize,
            dimensions:
              originalMetadata.width && originalMetadata.height
                ? {
                    original: { width: originalMetadata.width, height: originalMetadata.height },
                    optimized: {
                      width: optimizedMetadata.width ?? 0,
                      height: optimizedMetadata.height ?? 0,
                    },
                  }
                : undefined,
          };

          const extension = outputFormat === 'jpeg' ? 'jpg' : outputFormat;
          const optimizedFile: File | Buffer = isFileInput(file)
            ? new File([new Uint8Array(optimizedBuffer)], (file as File).name.replace(/\.[^.]+$/, '') + `.${extension}`, {
                type: MIME[outputFormat]!,
              })
            : optimizedBuffer;

          return {
            file: optimizedFile,
            options: {
              ...uploadOptions,
              contentType: MIME[outputFormat]!,
              metadata: {
                ...uploadOptions.metadata,
                optimization: optimizationMeta,
              },
            },
          };
        } catch (error) {
          // Log error but don't fail upload
          console.error('[image-optimization] Optimization failed:', error);
          return { file, options: uploadOptions };
        }
      },
    },
  };
}
