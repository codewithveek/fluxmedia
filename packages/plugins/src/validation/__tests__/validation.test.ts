import { describe, it, expect, vi } from 'vitest';
import { createFileValidationPlugin } from '../index';
import { MediaError, MediaErrorCode } from '@fluxmedia/core';

// Helper to create a mock file
function createMockFile(
    name: string,
    type: string,
    size: number
): File {
    const file = new File(['x'.repeat(size)], name, { type });
    // Override size since File constructor doesn't respect content length properly in tests
    Object.defineProperty(file, 'size', { value: size, writable: false });
    return file;
}

describe('FileValidationPlugin', () => {
    describe('file size validation', () => {
        it('should allow files within size limits', async () => {
            const plugin = createFileValidationPlugin({
                maxSize: 5 * 1024 * 1024, // 5MB
                minSize: 1024, // 1KB
            });

            const file = createMockFile('test.jpg', 'image/jpeg', 1024 * 1024); // 1MB

            const result = await plugin.hooks.beforeUpload!(file, {});

            expect(result).toBeDefined();
            expect(result!.file).toBe(file);
            expect(result!.options.metadata?.validation).toMatchObject({
                validated: true,
                fileSize: 1024 * 1024,
            });
        });

        it('should reject files exceeding max size', async () => {
            const plugin = createFileValidationPlugin({
                maxSize: 1 * 1024 * 1024, // 1MB
            });

            const file = createMockFile('large.jpg', 'image/jpeg', 5 * 1024 * 1024); // 5MB

            await expect(plugin.hooks.beforeUpload!(file, {})).rejects.toThrow(MediaError);
            await expect(plugin.hooks.beforeUpload!(file, {})).rejects.toMatchObject({
                code: MediaErrorCode.FILE_TOO_LARGE,
            });
        });

        it('should reject files below min size', async () => {
            const plugin = createFileValidationPlugin({
                minSize: 1024, // 1KB
            });

            const file = createMockFile('small.jpg', 'image/jpeg', 100); // 100 bytes

            await expect(plugin.hooks.beforeUpload!(file, {})).rejects.toThrow(MediaError);
            await expect(plugin.hooks.beforeUpload!(file, {})).rejects.toThrow('below minimum');
        });
    });

    describe('file type validation', () => {
        it('should allow files with matching MIME types', async () => {
            const plugin = createFileValidationPlugin({
                allowedTypes: ['image/*'],
            });

            const file = createMockFile('test.jpg', 'image/jpeg', 1024);

            const result = await plugin.hooks.beforeUpload!(file, {});

            expect(result).toBeDefined();
            expect(result!.file).toBe(file);
        });

        it('should allow specific MIME types', async () => {
            const plugin = createFileValidationPlugin({
                allowedTypes: ['image/jpeg', 'image/png'],
            });

            const jpegFile = createMockFile('test.jpg', 'image/jpeg', 1024);
            const pngFile = createMockFile('test.png', 'image/png', 1024);

            await expect(plugin.hooks.beforeUpload!(jpegFile, {})).resolves.toBeDefined();
            await expect(plugin.hooks.beforeUpload!(pngFile, {})).resolves.toBeDefined();
        });

        it('should reject files with disallowed MIME types', async () => {
            const plugin = createFileValidationPlugin({
                allowedTypes: ['image/*'],
            });

            const file = createMockFile('doc.pdf', 'application/pdf', 1024);

            await expect(plugin.hooks.beforeUpload!(file, {})).rejects.toThrow('not allowed');
        });
    });

    describe('extension validation', () => {
        it('should reject blocked extensions', async () => {
            const plugin = createFileValidationPlugin({
                blockedExtensions: ['.exe', '.bat', '.sh'],
            });

            const file = createMockFile('virus.exe', 'application/octet-stream', 1024);

            await expect(plugin.hooks.beforeUpload!(file, {})).rejects.toThrow('blocked');
        });

        it('should allow only specified extensions', async () => {
            const plugin = createFileValidationPlugin({
                allowedExtensions: ['.jpg', '.png', '.gif'],
            });

            const jpgFile = createMockFile('image.jpg', 'image/jpeg', 1024);
            const pdfFile = createMockFile('doc.pdf', 'application/pdf', 1024);

            await expect(plugin.hooks.beforeUpload!(jpgFile, {})).resolves.toBeDefined();
            await expect(plugin.hooks.beforeUpload!(pdfFile, {})).rejects.toThrow('not allowed');
        });
    });

    describe('custom validation', () => {
        it('should call custom validator', async () => {
            const customValidator = vi.fn().mockResolvedValue(true);

            const plugin = createFileValidationPlugin({
                customValidator,
            });

            const file = createMockFile('test.jpg', 'image/jpeg', 1024);

            await plugin.hooks.beforeUpload!(file, {});

            expect(customValidator).toHaveBeenCalledWith(file, 'test.jpg');
        });

        it('should reject when custom validator returns false', async () => {
            const plugin = createFileValidationPlugin({
                customValidator: async (file, filename) => {
                    return filename.startsWith('allowed');
                },
            });

            const validFile = createMockFile('allowed-file.jpg', 'image/jpeg', 1024);
            const invalidFile = createMockFile('blocked-file.jpg', 'image/jpeg', 1024);

            await expect(plugin.hooks.beforeUpload!(validFile, {})).resolves.toBeDefined();
            await expect(plugin.hooks.beforeUpload!(invalidFile, {})).rejects.toThrow(
                'custom validation'
            );
        });
    });

    describe('callbacks', () => {
        it('should call onValidationFailed callback', async () => {
            const onValidationFailed = vi.fn();

            const plugin = createFileValidationPlugin({
                maxSize: 1024,
                onValidationFailed,
            });

            const file = createMockFile('large.jpg', 'image/jpeg', 5000);

            try {
                await plugin.hooks.beforeUpload!(file, {});
            } catch {
                // Expected to throw
            }

            expect(onValidationFailed).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'SIZE',
                    message: expect.stringContaining('exceeds maximum'),
                })
            );
        });
    });
});
