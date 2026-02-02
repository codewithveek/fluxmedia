/**
 * File Validation Plugin for FluxMedia
 *
 * Validates files before upload based on type, size, and extension.
 */

import {
    type FluxMediaPlugin,
    type UploadOptions,
    MediaError,
    MediaErrorCode,
} from '@fluxmedia/core';

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
    file: File | Buffer;
}

/**
 * Options for the file validation plugin
 */
export interface FileValidationOptions {
    /** Allowed MIME types (e.g., ['image/*', 'video/mp4']) */
    allowedTypes?: string[];
    /** Maximum file size in bytes */
    maxSize?: number;
    /** Minimum file size in bytes */
    minSize?: number;
    /** Allowed file extensions (e.g., ['.jpg', '.png']) */
    allowedExtensions?: string[];
    /** Blocked file extensions (e.g., ['.exe', '.bat']) */
    blockedExtensions?: string[];
    /** Custom validation function */
    customValidator?: (file: File | Buffer, filename: string) => Promise<boolean> | boolean;
    /** Callback when validation fails */
    onValidationFailed?: (error: ValidationError) => void;
}

/**
 * Format bytes to human-readable string
 */
function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 Bytes';

    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

/**
 * Get file information from File or Buffer
 */
function getFileInfo(
    file: File | Buffer,
    options: UploadOptions
): { size: number; name: string; type: string; ext: string } {
    const isFile = typeof File !== 'undefined' && file instanceof File;

    const size = isFile ? (file as File).size : (file as Buffer).byteLength;
    const name = isFile ? (file as File).name : options.filename || 'unknown';
    const type = isFile ? (file as File).type : '';
    const ext = name.includes('.') ? name.substring(name.lastIndexOf('.')).toLowerCase() : '';

    return { size, name, type, ext };
}

/**
 * Create a file validation plugin
 *
 * @param options - Validation options
 * @returns FluxMediaPlugin instance
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
export function createFileValidationPlugin(
    options: FileValidationOptions = {}
): FluxMediaPlugin {
    return {
        name: 'file-validation',
        version: '1.0.0',
        hooks: {
            async beforeUpload(
                file: File | Buffer,
                uploadOptions: UploadOptions
            ): Promise<{ file: File | Buffer; options: UploadOptions }> {
                const { size: fileSize, name: fileName, type: fileType, ext: fileExt } = getFileInfo(file, uploadOptions);

                // Validate max file size
                if (options.maxSize && fileSize > options.maxSize) {
                    const error: ValidationError = {
                        type: 'SIZE',
                        message: `File size ${formatBytes(fileSize)} exceeds maximum ${formatBytes(options.maxSize)}`,
                        file,
                    };

                    options.onValidationFailed?.(error);

                    throw new MediaError(
                        error.message,
                        MediaErrorCode.FILE_TOO_LARGE,
                        'validation-plugin',
                        undefined,
                        { fileSize, maxSize: options.maxSize }
                    );
                }

                // Validate min file size
                if (options.minSize && fileSize < options.minSize) {
                    const error: ValidationError = {
                        type: 'SIZE',
                        message: `File size ${formatBytes(fileSize)} is below minimum ${formatBytes(options.minSize)}`,
                        file,
                    };

                    options.onValidationFailed?.(error);

                    throw new MediaError(
                        error.message,
                        MediaErrorCode.INVALID_FILE_TYPE,
                        'validation-plugin',
                        undefined,
                        { fileSize, minSize: options.minSize }
                    );
                }

                // Validate file type (MIME type)
                if (options.allowedTypes && options.allowedTypes.length > 0) {
                    const isAllowed = options.allowedTypes.some((type) => {
                        if (type.endsWith('/*')) {
                            const baseType = type.replace('/*', '');
                            return fileType.startsWith(baseType);
                        }
                        return fileType === type;
                    });

                    if (!isAllowed) {
                        const error: ValidationError = {
                            type: 'TYPE',
                            message: `File type "${fileType || 'unknown'}" not allowed. Allowed types: ${options.allowedTypes.join(', ')}`,
                            file,
                        };

                        options.onValidationFailed?.(error);

                        throw new MediaError(
                            error.message,
                            MediaErrorCode.INVALID_FILE_TYPE,
                            'validation-plugin',
                            undefined,
                            { fileType, allowedTypes: options.allowedTypes }
                        );
                    }
                }

                // Validate blocked extensions
                if (options.blockedExtensions && options.blockedExtensions.includes(fileExt)) {
                    const error: ValidationError = {
                        type: 'EXTENSION',
                        message: `File extension "${fileExt}" is blocked`,
                        file,
                    };

                    options.onValidationFailed?.(error);

                    throw new MediaError(
                        error.message,
                        MediaErrorCode.INVALID_FILE_TYPE,
                        'validation-plugin',
                        undefined,
                        { extension: fileExt, blockedExtensions: options.blockedExtensions }
                    );
                }

                // Validate allowed extensions
                if (options.allowedExtensions && options.allowedExtensions.length > 0) {
                    if (!options.allowedExtensions.includes(fileExt)) {
                        const error: ValidationError = {
                            type: 'EXTENSION',
                            message: `File extension "${fileExt}" not allowed. Allowed: ${options.allowedExtensions.join(', ')}`,
                            file,
                        };

                        options.onValidationFailed?.(error);

                        throw new MediaError(
                            error.message,
                            MediaErrorCode.INVALID_FILE_TYPE,
                            'validation-plugin',
                            undefined,
                            { extension: fileExt, allowedExtensions: options.allowedExtensions }
                        );
                    }
                }

                // Custom validation
                if (options.customValidator) {
                    const isValid = await options.customValidator(file, fileName);

                    if (!isValid) {
                        const error: ValidationError = {
                            type: 'CUSTOM',
                            message: 'File failed custom validation',
                            file,
                        };

                        options.onValidationFailed?.(error);

                        throw new MediaError(
                            error.message,
                            MediaErrorCode.INVALID_FILE_TYPE,
                            'validation-plugin'
                        );
                    }
                }

                // Add validation metadata to options
                const enrichedOptions: UploadOptions = {
                    ...uploadOptions,
                    metadata: {
                        ...uploadOptions.metadata,
                        validation: {
                            fileSize,
                            fileName,
                            fileType,
                            fileExt,
                            validated: true,
                            timestamp: new Date().toISOString(),
                        },
                    },
                };

                return { file, options: enrichedOptions };
            },
        },
    };
}
