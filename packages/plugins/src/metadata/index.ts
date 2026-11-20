/**
 * Metadata Extraction Plugin for FluxMedia
 *
 * Extracts EXIF data, dimensions, and file hashes.
 * Requires `sharp` for image metadata and, for full EXIF, `exif-reader`
 * (both optional peer dependencies).
 */

import type { FluxMediaPlugin, UploadInput, UploadOptions, UploadResult } from '@fluxmedia/core';
import { createHash } from 'node:crypto';
import { fileToBuffer, isInspectable, isRasterImage } from '../utils';

/**
 * Options for the metadata extraction plugin
 */
export interface MetadataExtractionOptions {
  /** Extract EXIF data (default: true) */
  extractExif?: boolean;
  /**
   * Include GPS coordinates from EXIF (default: false). Location data is
   * personal data; only enable this when you need it and protect it.
   */
  includeGps?: boolean;
  /** Extract image dimensions (default: true) */
  extractDimensions?: boolean;
  /** Generate file hash for deduplication (default: false) */
  hashFile?: boolean;
  /** Hash algorithm: 'md5' or 'sha256' (default: 'md5') */
  hashAlgorithm?: 'md5' | 'sha256';
}

/**
 * Extracted metadata structure. Stored under `options.metadata.extracted`;
 * as a nested object it stays in-process and is not written to the
 * provider's object metadata.
 */
export interface ExtractedMetadata {
  dimensions?:
    | {
        width: number;
        height: number;
      }
    | undefined;
  exif?:
    | {
        make?: string | undefined;
        model?: string | undefined;
        software?: string | undefined;
        orientation?: number | undefined;
        dateTime?: string | undefined;
        exposureTime?: number | undefined;
        fNumber?: number | undefined;
        iso?: number | undefined;
        focalLength?: number | undefined;
        lensModel?: string | undefined;
        format?: string | undefined;
        density?: number | undefined;
        gps?:
          | {
              latitude?: number | undefined;
              longitude?: number | undefined;
              altitude?: number | undefined;
            }
          | undefined;
      }
    | undefined;
  hash?: string | undefined;
  hashAlgorithm?: string | undefined;
}

type ExifData = {
  Image?: Record<string, unknown>;
  Photo?: Record<string, unknown>;
  GPSInfo?: Record<string, unknown>;
};

function toDegrees(value: unknown, ref: unknown): number | undefined {
  if (!Array.isArray(value) || value.length < 3) return undefined;
  const [d, m, s] = value as number[];
  const deg = d! + m! / 60 + s! / 3600;
  return ref === 'S' || ref === 'W' ? -deg : deg;
}

function asDate(value: unknown): string | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  return typeof value === 'string' ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  if (Array.isArray(value)) return num(value[0]);
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

async function parseExif(raw: Buffer, includeGps: boolean): Promise<ExtractedMetadata['exif']> {
  let reader: (buffer: Buffer) => ExifData;
  try {
    const mod = (await import('exif-reader')) as unknown as {
      default?: (b: Buffer) => ExifData;
    };
    reader = (mod.default ?? mod) as (b: Buffer) => ExifData;
  } catch {
    return undefined; // exif-reader not installed
  }
  const data = reader(raw);
  const exif: NonNullable<ExtractedMetadata['exif']> = {
    make: str(data.Image?.Make),
    model: str(data.Image?.Model),
    software: str(data.Image?.Software),
    dateTime: asDate(data.Photo?.DateTimeOriginal ?? data.Image?.DateTime),
    exposureTime: num(data.Photo?.ExposureTime),
    fNumber: num(data.Photo?.FNumber),
    iso: num(data.Photo?.ISOSpeedRatings ?? data.Photo?.PhotographicSensitivity),
    focalLength: num(data.Photo?.FocalLength),
    lensModel: str(data.Photo?.LensModel),
  };
  if (includeGps && data.GPSInfo) {
    exif.gps = {
      latitude: toDegrees(data.GPSInfo.GPSLatitude, data.GPSInfo.GPSLatitudeRef),
      longitude: toDegrees(data.GPSInfo.GPSLongitude, data.GPSInfo.GPSLongitudeRef),
      altitude: num(data.GPSInfo.GPSAltitude),
    };
  }
  return exif;
}

/**
 * Create a metadata extraction plugin
 *
 * @example
 * ```typescript
 * const metadataPlugin = createMetadataExtractionPlugin({
 *   extractExif: true,
 *   extractDimensions: true,
 *   hashFile: true,
 *   hashAlgorithm: 'sha256',
 * });
 * ```
 */
export function createMetadataExtractionPlugin(
  options: MetadataExtractionOptions = {}
): FluxMediaPlugin {
  const config = {
    extractExif: options.extractExif ?? true,
    includeGps: options.includeGps ?? false,
    extractDimensions: options.extractDimensions ?? true,
    hashFile: options.hashFile ?? false,
    hashAlgorithm: options.hashAlgorithm ?? 'md5',
  };

  return {
    name: 'metadata-extraction',
    version: '1.0.0',
    optional: true,
    hooks: {
      async beforeUpload(
        file: UploadInput,
        uploadOptions: UploadOptions
      ): Promise<{ file: UploadInput; options: UploadOptions } | void> {
        // Streams can only be read once; leave them alone
        if (!isInspectable(file)) return { file, options: uploadOptions };

        try {
          const extracted: ExtractedMetadata = {};
          const buffer = await fileToBuffer(file);

          if ((config.extractDimensions || config.extractExif) && (await isRasterImage(file))) {
            try {
              const sharp = (await import('sharp')).default;
              const metadata = await sharp(buffer).metadata();

              if (config.extractDimensions && metadata.width && metadata.height) {
                // Report display dimensions (EXIF orientations 5-8 swap axes)
                const swap = (metadata.orientation ?? 1) >= 5;
                extracted.dimensions = swap
                  ? { width: metadata.height, height: metadata.width }
                  : { width: metadata.width, height: metadata.height };
              }

              if (config.extractExif) {
                const parsed = metadata.exif ? await parseExif(metadata.exif, config.includeGps).catch(() => undefined) : undefined;
                extracted.exif = {
                  ...parsed,
                  orientation: metadata.orientation,
                  format: metadata.format,
                  density: metadata.density,
                };
              }
            } catch {
              // Sharp not available or image processing failed
              console.warn('[metadata-extraction] Image metadata extraction failed');
            }
          }

          if (config.hashFile) {
            extracted.hash = createHash(config.hashAlgorithm).update(buffer).digest('hex');
            extracted.hashAlgorithm = config.hashAlgorithm;
          }

          return {
            file,
            options: {
              ...uploadOptions,
              metadata: {
                ...uploadOptions.metadata,
                extracted,
              },
            },
          };
        } catch (error) {
          // Don't fail upload on metadata extraction errors
          console.error('[metadata-extraction] Extraction failed:', error);
          return { file, options: uploadOptions };
        }
      },

      async afterUpload(result: UploadResult, context): Promise<UploadResult> {
        const extracted = context?.options.metadata?.extracted as ExtractedMetadata | undefined;
        if (!extracted) return result;
        const enriched: UploadResult = { ...result, metadata: { ...result.metadata, extracted } };
        if (extracted.dimensions && result.width === undefined) {
          enriched.width = extracted.dimensions.width;
          enriched.height = extracted.dimensions.height;
        }
        return enriched;
      },
    },
  };
}
