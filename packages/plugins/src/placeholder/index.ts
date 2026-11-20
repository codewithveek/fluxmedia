/**
 * Placeholder Plugin for FluxMedia
 *
 * Generates a tiny blurred preview (LQIP data URI) and the dominant color for
 * images, for use as a placeholder while the full image loads.
 * Requires sharp.
 */

import type { FluxMediaPlugin, UploadInput, UploadOptions, UploadResult } from '@fluxmedia/core';
import { fileToBuffer, isInspectable, isRasterImage } from '../utils';

export interface PlaceholderOptions {
  /** Longest side of the preview in pixels (default 16). */
  size?: number;
  /** Blur sigma applied to the preview (default 1). */
  blur?: number;
  /** Preview encoding (default webp). */
  format?: 'webp' | 'png' | 'jpeg';
}

export interface PlaceholderMetadata {
  /** `data:` URI of the blurred preview. */
  dataUri: string;
  /** Dominant color as `#rrggbb`. */
  dominantColor: string;
  width: number;
  height: number;
}

const INTERNAL_KEY = '_placeholder';

/**
 * Create a placeholder plugin. Results get `metadata.placeholder`.
 *
 * @example
 * ```tsx
 * <img src={result.url} style={{ backgroundImage: `url(${result.metadata.placeholder.dataUri})` }} />
 * ```
 */
export function createPlaceholderPlugin(options: PlaceholderOptions = {}): FluxMediaPlugin {
  const size = Math.min(Math.max(options.size ?? 16, 4), 64);
  const format = options.format ?? 'webp';

  return {
    name: 'placeholder',
    version: '1.0.0',
    optional: true,
    hooks: {
      async beforeUpload(
        file: UploadInput,
        uploadOptions: UploadOptions
      ): Promise<{ file: UploadInput; options: UploadOptions } | void> {
        if (!isInspectable(file) || !(await isRasterImage(file))) return;
        const sharp = (await import('sharp')).default;
        const image = sharp(await fileToBuffer(file), { limitInputPixels: 100_000_000 }).rotate();
        const [{ dominant }, preview] = await Promise.all([
          image.clone().stats(),
          image
            .clone()
            .resize(size, size, { fit: 'inside' })
            .blur(options.blur ?? 1)
            .toFormat(format, { quality: 50 })
            .toBuffer({ resolveWithObject: true }),
        ]);
        const hex = (n: number) => n.toString(16).padStart(2, '0');
        const placeholder: PlaceholderMetadata = {
          dataUri: `data:image/${format};base64,${preview.data.toString('base64')}`,
          dominantColor: `#${hex(dominant.r)}${hex(dominant.g)}${hex(dominant.b)}`,
          width: preview.info.width,
          height: preview.info.height,
        };
        return {
          file,
          options: { ...uploadOptions, metadata: { ...uploadOptions.metadata, [INTERNAL_KEY]: placeholder } },
        };
      },
      async afterUpload(result: UploadResult, context): Promise<UploadResult> {
        const placeholder = context?.options.metadata?.[INTERNAL_KEY];
        if (!placeholder) return result;
        const metadata: Record<string, unknown> = { ...result.metadata, placeholder };
        delete metadata[INTERNAL_KEY];
        return { ...result, metadata };
      },
    },
  };
}
