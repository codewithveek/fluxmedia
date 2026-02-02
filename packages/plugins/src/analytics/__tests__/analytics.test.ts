import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAnalyticsPlugin } from '../index';
import type { UploadResult } from '@fluxmedia/core';

// Helper to create a mock file
function createMockFile(name: string, type: string, size: number): File {
    const file = new File(['x'.repeat(size)], name, { type });
    Object.defineProperty(file, 'size', { value: size, writable: false });
    return file;
}

// Helper to create a mock upload result
function createMockResult(overrides: Partial<UploadResult> = {}): UploadResult {
    return {
        id: 'test-id',
        url: 'https://example.com/test.jpg',
        publicUrl: 'https://example.com/test.jpg',
        size: 1024,
        format: 'jpg',
        provider: 's3',
        metadata: {},
        createdAt: new Date(),
        ...overrides,
    };
}

describe('AnalyticsPlugin', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('upload lifecycle tracking', () => {
        it('should track upload start', async () => {
            const track = vi.fn();
            const onUploadStart = vi.fn();

            const plugin = createAnalyticsPlugin({
                track,
                onUploadStart,
                console: false,
            });

            const file = createMockFile('test.jpg', 'image/jpeg', 1024);

            await plugin.hooks.beforeUpload!(file, {});

            expect(onUploadStart).toHaveBeenCalledWith(file, {});
            expect(track).toHaveBeenCalledWith(
                'media.upload.started',
                expect.objectContaining({
                    fileName: 'test.jpg',
                    fileSize: 1024,
                })
            );
        });

        it('should track upload completion', async () => {
            const track = vi.fn();
            const onUploadComplete = vi.fn();

            const plugin = createAnalyticsPlugin({
                track,
                onUploadComplete,
                console: false,
            });

            const file = createMockFile('test.jpg', 'image/jpeg', 1024);

            // Simulate beforeUpload to set up tracking
            const beforeResult = await plugin.hooks.beforeUpload!(file, {});

            // Simulate afterUpload
            const result = createMockResult({
                metadata: beforeResult?.options.metadata,
            });

            await plugin.hooks.afterUpload!(result);

            expect(onUploadComplete).toHaveBeenCalled();
            expect(track).toHaveBeenCalledWith(
                'media.upload.completed',
                expect.objectContaining({
                    fileId: 'test-id',
                    provider: 's3',
                })
            );
        });

        it('should track file deletion', async () => {
            const track = vi.fn();
            const onDelete = vi.fn();

            const plugin = createAnalyticsPlugin({
                track,
                onDelete,
                console: false,
            });

            await plugin.hooks.afterDelete!('file-123');

            expect(onDelete).toHaveBeenCalledWith('file-123');
            expect(track).toHaveBeenCalledWith('media.delete.completed', {
                fileId: 'file-123',
            });
        });
    });

    describe('error tracking', () => {
        it('should track errors', async () => {
            const track = vi.fn();
            const onUploadError = vi.fn();

            const plugin = createAnalyticsPlugin({
                track,
                onUploadError,
                console: false,
            });

            const error = new Error('Upload failed');
            const file = createMockFile('test.jpg', 'image/jpeg', 1024);

            await plugin.hooks.onError!(error, { file, options: {} });

            expect(onUploadError).toHaveBeenCalledWith(error, file);
            expect(track).toHaveBeenCalledWith(
                'media.error',
                expect.objectContaining({
                    operation: 'upload',
                    error: expect.objectContaining({
                        message: 'Upload failed',
                    }),
                })
            );
        });
    });

    describe('environment filtering', () => {
        it('should be inactive in non-matching environment', async () => {
            // Simulate production environment check
            const originalEnv = process.env.NODE_ENV;
            process.env.NODE_ENV = 'development';

            const track = vi.fn();

            const plugin = createAnalyticsPlugin({
                environment: 'production',
                track,
            });

            const file = createMockFile('test.jpg', 'image/jpeg', 1024);

            // Plugin should be a no-op
            const result = await plugin.hooks.beforeUpload?.(file, {});

            expect(result).toBeUndefined(); // No hooks defined for inactive plugin
            expect(track).not.toHaveBeenCalled();

            process.env.NODE_ENV = originalEnv;
        });

        it('should be active when environment is "all"', async () => {
            const track = vi.fn();

            const plugin = createAnalyticsPlugin({
                environment: 'all',
                track,
                console: false,
            });

            const file = createMockFile('test.jpg', 'image/jpeg', 1024);

            await plugin.hooks.beforeUpload!(file, {});

            expect(track).toHaveBeenCalled();
        });
    });

    describe('configuration', () => {
        it('should use default options', () => {
            const plugin = createAnalyticsPlugin();

            expect(plugin.name).toBe('analytics');
            expect(plugin.version).toBe('1.0.0');
        });
    });
});
