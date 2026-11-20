/**
 * File Validation Plugin for FluxMedia
 *
 * Validates files before upload based on type, size, and extension.
 * Uses magic byte detection for reliable MIME type checking.
 */

import {
  type FluxMediaPlugin,
  type UploadOptions,
  type UploadInput,
  MediaError,
  MediaErrorCode,
  detectTrustedType,
  getInputName,
  getInputSize,
  isFileInput,
  isMimeAllowed,
  isNodeReadable,
  isStreamInput,
  isTextLikeMime,
} from '@fluxmedia/core';
import { Transform } from 'node:stream';
import { formatBytes } from '../utils';

/**
 * Validation error types
 */
export type ValidationErrorType = 'TYPE' | 'SIZE' | 'EXTENSION' | 'CUSTOM';

/**
 * Validation error details
 */
export interface ValidationError {
  type: ValidationErrorType;
  message: string;
  file: UploadInput;
}

/**
 * Options for the file validation plugin
 */
export interface FileValidationOptions {
  /**
   * Allowed MIME types (e.g., ['image/*', 'video/mp4']). SVG only matches
   * when `image/svg+xml` is listed explicitly — `image/*` excludes it
   * because SVG can contain scripts.
   */
  allowedTypes?: string[];
  /** Maximum file size in bytes. Enforced on streams while they are read. */
  maxSize?: number;
  /** Minimum file size in bytes */
  minSize?: number;
  /** Allowed file extensions (e.g., ['.jpg', '.png']); case-insensitive */
  allowedExtensions?: string[];
  /** Blocked file extensions (e.g., ['.exe', '.bat']); case-insensitive */
  blockedExtensions?: string[];
  /** Custom validation function */
  customValidator?: (file: UploadInput, filename: string) => Promise<boolean> | boolean;
  /** Callback when validation fails */
  onValidationFailed?: (error: ValidationError) => void;
  /**
   * Detect the MIME type from file content (default: true). When false, the
   * File's declared type or `options.contentType` is trusted — only do that
   * for input you already trust.
   */
  useMagicBytes?: boolean;
}

function normalizeExt(ext: string): string {
  const e = ext.trim().toLowerCase();
  return e ? (e.startsWith('.') ? e : `.${e}`) : '';
}

function extOf(name: string | undefined): string {
  if (!name || !name.includes('.')) return '';
  return normalizeExt(name.slice(name.lastIndexOf('.')));
}

/**
 * Wrap a stream so that it fails once more than `maxSize` bytes pass.
 */
function limitStream(file: UploadInput, maxSize: number): UploadInput {
  const tooLarge = () =>
    new MediaError(
      `File exceeds maximum ${formatBytes(maxSize)}`,
      MediaErrorCode.FILE_TOO_LARGE,
      'validation-plugin',
      undefined,
      { maxSize }
    );
  if (isNodeReadable(file)) {
    let seen = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        seen += chunk.length;
        if (seen > maxSize) done(tooLarge());
        else done(null, chunk);
      },
    });
    file.on('error', (e) => limiter.destroy(e));
    return file.pipe(limiter);
  }
  let seen = 0;
  return (file as ReadableStream<Uint8Array>).pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > maxSize) controller.error(tooLarge());
        else controller.enqueue(chunk);
      },
    })
  );
}

/**
 * Create a file validation plugin
 *
 * @example
 * ```typescript
 * const validationPlugin = createFileValidationPlugin({
 *   allowedTypes: ['image/*', 'video/mp4'],
 *   maxSize: 10 * 1024 * 1024, // 10MB
 *   blockedExtensions: ['.exe', '.bat'],
 * });
 * ```
 */
export function createFileValidationPlugin(options: FileValidationOptions = {}): FluxMediaPlugin {
  const useMagicBytes = options.useMagicBytes ?? true;
  const blocked = (options.blockedExtensions ?? []).map(normalizeExt);
  const allowedExt = (options.allowedExtensions ?? []).map(normalizeExt);

  const fail = (
    file: UploadInput,
    type: ValidationErrorType,
    message: string,
    code: MediaErrorCode,
    details?: Record<string, unknown>
  ): never => {
    options.onValidationFailed?.({ type, message, file });
    throw new MediaError(message, code, 'validation-plugin', undefined, details);
  };

  return {
    name: 'file-validation',
    version: '2.0.0',
    hooks: {
      async beforeUpload(
        file: UploadInput,
        uploadOptions: UploadOptions
      ): Promise<{ file: UploadInput; options: UploadOptions }> {
        const isStream = isStreamInput(file);
        const fileName = getInputName(file) ?? uploadOptions.filename ?? 'unknown';
        const fileSize = getInputSize(file);

        // Determine the type
        let fileType: string;
        let detectedExt = '';
        if (isStream) {
          fileType = uploadOptions.contentType ?? '';
        } else if (useMagicBytes) {
          const trusted = await detectTrustedType(file as File | Buffer, uploadOptions.contentType);
          fileType = trusted?.mime ?? '';
          detectedExt = trusted?.detected ? normalizeExt(trusted.ext) : '';
        } else {
          fileType = uploadOptions.contentType || (isFileInput(file) ? file.type : '') || '';
        }

        // Size
        if (fileSize !== undefined) {
          if (options.maxSize && fileSize > options.maxSize) {
            fail(
              file,
              'SIZE',
              `File size ${formatBytes(fileSize)} exceeds maximum ${formatBytes(options.maxSize)}`,
              MediaErrorCode.FILE_TOO_LARGE,
              { fileSize, maxSize: options.maxSize }
            );
          }
          if (options.minSize && fileSize < options.minSize) {
            fail(
              file,
              'SIZE',
              `File size ${formatBytes(fileSize)} is below minimum ${formatBytes(options.minSize)}`,
              MediaErrorCode.INVALID_FILE_TYPE,
              { fileSize, minSize: options.minSize }
            );
          }
        }

        // Type
        if (options.allowedTypes?.length) {
          if (!fileType || !isMimeAllowed(fileType, options.allowedTypes)) {
            const reason = isStream && !fileType ? ' (set contentType for streams)' : '';
            fail(
              file,
              'TYPE',
              `File type "${fileType || 'unknown'}" not allowed${reason}. Allowed types: ${options.allowedTypes.join(', ')}`,
              MediaErrorCode.INVALID_FILE_TYPE,
              { fileType, allowedTypes: options.allowedTypes }
            );
          }
        } else if (useMagicBytes && !isStream && !fileType) {
          // Without an allow-list, still refuse content that claims a type it is not
          const declared = uploadOptions.contentType || (isFileInput(file) ? file.type : '');
          if (declared && !isTextLikeMime(declared) && declared !== 'application/octet-stream') {
            fail(
              file,
              'TYPE',
              `File content does not match its declared type "${declared}"`,
              MediaErrorCode.INVALID_FILE_TYPE,
              { declared }
            );
          }
        }

        // Extensions: check both the filename and the detected type
        const nameExt = extOf(getInputName(file) ?? uploadOptions.filename);
        const exts = [...new Set([nameExt, detectedExt].filter(Boolean))];
        const blockedHit = exts.find((e) => blocked.includes(e));
        if (blockedHit) {
          fail(file, 'EXTENSION', `File extension "${blockedHit}" is blocked`, MediaErrorCode.INVALID_FILE_TYPE, {
            extension: blockedHit,
            blockedExtensions: options.blockedExtensions,
          });
        }
        if (allowedExt.length) {
          const ext = nameExt || detectedExt;
          if (!ext || !allowedExt.includes(ext)) {
            fail(
              file,
              'EXTENSION',
              `File extension "${ext}" not allowed. Allowed: ${options.allowedExtensions!.join(', ')}`,
              MediaErrorCode.INVALID_FILE_TYPE,
              { extension: ext, allowedExtensions: options.allowedExtensions }
            );
          }
        }

        // Custom validation
        if (options.customValidator && !(await options.customValidator(file, fileName))) {
          fail(file, 'CUSTOM', 'File failed custom validation', MediaErrorCode.INVALID_FILE_TYPE);
        }

        const outFile = isStream && options.maxSize ? limitStream(file, options.maxSize) : file;
        return {
          file: outFile,
          options: {
            ...uploadOptions,
            ...(fileType && { contentType: fileType }),
            metadata: {
              ...uploadOptions.metadata,
              validation: {
                fileSize,
                fileName,
                fileType,
                fileExt: nameExt || detectedExt,
                validated: true,
                timestamp: new Date().toISOString(),
              },
            },
          },
        };
      },
    },
  };
}
