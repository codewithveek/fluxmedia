import { describe, it, expect, vi } from 'vitest';
import { createImageOptimizationPlugin } from '../index';

// Mock sharp for testing
vi.mock('sharp', () => {
    const mockSharp = {
        metadata: vi.fn().mockResolvedValue({
            width: 3000,
            height: 2000,
            format: 'jpeg',
        }),
        rotate: vi.fn().mockReturnThis(),
        resize: vi.fn().mockReturnThis(),
        webp: vi.fn().mockReturnThis(),
        avif: vi.fn().mockReturnThis(),
        jpeg: vi.fn().mockReturnThis(),
        png: vi.fn().mockReturnThis(),
        withMetadata: vi.fn().mockReturnThis(),
        toBuffer: vi.fn().mockResolvedValue(Buffer.from('optimized')),
    };

    return {
        default: vi.fn(() => mockSharp),
    };
});

// Helper to create a mock file
function createMockFile(name: string, type: string, size: number): File {
    const file = new File(['x'.repeat(size)], name, { type });
    Object.defineProperty(file, 'size', { value: size, writable: false });
    return file;
}

describe('ImageOptimizationPlugin', () => {
    describe('image processing', () => {
        it('should optimize image files', async () => {
            const plugin = createImageOptimizationPlugin({
                maxWidth: 2000,
                quality: 0.85,
                format: 'webp',
            });

            const file = createMockFile('test.jpg', 'image/jpeg', 1024 * 1024);

            const result = await plugin.hooks.beforeUpload!(file, {});

            expect(result).toBeDefined();
            expect(result!.options.metadata?.optimization).toBeDefined();
        });

        it('should skip non-image files', async () => {
            const plugin = createImageOptimizationPlugin();

            const file = createMockFile('document.pdf', 'application/pdf', 1024);

            const result = await plugin.hooks.beforeUpload!(file, {});

            expect(result).toBeDefined();
            expect(result!.file).toBe(file);
            expect(result!.options.metadata?.optimization).toBeUndefined();
        });

        it('should skip SVG files', async () => {
            const plugin = createImageOptimizationPlugin();

            const file = createMockFile('icon.svg', 'image/svg+xml', 1024);

            const result = await plugin.hooks.beforeUpload!(file, {});

            expect(result).toBeDefined();
            expect(result!.file).toBe(file);
            expect(result!.options.metadata?.optimization).toBeUndefined();
        });
    });

    describe('configuration', () => {
        it('should use default options', async () => {
            const plugin = createImageOptimizationPlugin();

            expect(plugin.name).toBe('image-optimization');
            expect(plugin.version).toBe('1.0.0');
        });

        it('should accept custom options', async () => {
            const plugin = createImageOptimizationPlugin({
                maxWidth: 1000,
                maxHeight: 800,
                quality: 0.7,
                format: 'avif',
                stripMetadata: false,
            });

            expect(plugin.name).toBe('image-optimization');
        });
    });
});
