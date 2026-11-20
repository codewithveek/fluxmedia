import {
  type UploadInput,
  getFileType,
  isBuffer,
  isFileInput,
  isStreamInput,
  readHead,
} from '@fluxmedia/core';

/**
 * Read a non-stream input into a Buffer. Streams are rejected because
 * reading them would consume them before the upload.
 */
export async function fileToBuffer(file: UploadInput): Promise<Buffer> {
  if (isBuffer(file)) return file;
  if (isFileInput(file)) return Buffer.from(await file.arrayBuffer());
  throw new Error('Streams cannot be buffered by plugins without consuming them');
}

/**
 * True for inputs plugins can inspect without consuming (Buffer, File).
 */
export function isInspectable(file: UploadInput): file is Buffer | File {
  return !isStreamInput(file) && (isBuffer(file) || isFileInput(file));
}

/**
 * Detect the MIME type of a Buffer or File from its first bytes.
 */
export async function sniffMime(file: Buffer | File): Promise<string | undefined> {
  const detected = await getFileType(await readHead(file)).catch(() => null);
  return detected?.mime;
}

/**
 * True when the input is a raster image (by magic bytes, falling back to
 * the File's declared type). SVG is never treated as raster.
 */
export async function isRasterImage(file: UploadInput): Promise<boolean> {
  if (!isInspectable(file)) return false;
  const mime = (await sniffMime(file)) ?? (isFileInput(file) ? file.type : '');
  return !!mime && mime.startsWith('image/') && mime !== 'image/svg+xml';
}

/**
 * Format bytes to a human-readable string.
 */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return 'unknown size';
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}
