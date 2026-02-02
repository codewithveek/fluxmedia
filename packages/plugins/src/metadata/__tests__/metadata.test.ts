import { describe, it, expect, vi } from 'vitest';
import { createMetadataExtractionPlugin } from '../index';

// Mock sharp for testing
vi.mock('sharp', () => {
    const mockSharp = {
        metadata: vi.fn().mockResolvedValue({
            width: 1920,
            height: 1080,
            format: 'jpeg',
            orientation: 1,
            density: 72,
            exif: Buffer.from('exif data'),
        }),
    };

    return {
        default: vi.fn(() => mockSharp),
    };
});

// Helper to create a mock file
function createMockFile(name: string, type: string, content: string = 'test content'): File {
    const file = new File([content], name, { type });
    return file;
}

describe('MetadataExtractionPlugin', () => {
    describe('dimension extraction', () => {
        it('should extract image dimensions', async () => {
            const plugin = createMetadataExtractionPlugin({
                extractDimensions: true,
                extractExif: false,
            });

            const file = createMockFile('test.jpg', 'image/jpeg');

            const result = await plugin.hooks.beforeUpload!(file, {});

            expect(result).toBeDefined();
            expect(result!.options.metadata?.extracted).toBeDefined();
            expect(result!.options.metadata?.extracted.dimensions).toEqual({
                width: 1920,
                height: 1080,
            });
        });
    });

    describe('hash generation', () => {
        it('should generate MD5 hash', async () => {
            const plugin = createMetadataExtractionPlugin({
                hashFile: true,
                hashAlgorithm: 'md5',
                extractDimensions: false,
                extractExif: false,
            });

            const file = createMockFile('test.txt', 'text/plain', 'test content');

            const result = await plugin.hooks.beforeUpload!(file, {});

            expect(result).toBeDefined();
            expect(result!.options.metadata?.extracted.hash).toBeDefined();
            expect(result!.options.metadata?.extracted.hash).toHaveLength(32); // MD5 is 32 hex chars
            expect(result!.options.metadata?.extracted.hashAlgorithm).toBe('md5');
        });

        it('should generate SHA256 hash', async () => {
            const plugin = createMetadataExtractionPlugin({
                hashFile: true,
                hashAlgorithm: 'sha256',
                extractDimensions: false,
                extractExif: false,
            });

            const file = createMockFile('test.txt', 'text/plain', 'test content');

            const result = await plugin.hooks.beforeUpload!(file, {});

            expect(result).toBeDefined();
            expect(result!.options.metadata?.extracted.hash).toBeDefined();
            expect(result!.options.metadata?.extracted.hash).toHaveLength(64); // SHA256 is 64 hex chars
            expect(result!.options.metadata?.extracted.hashAlgorithm).toBe('sha256');
        });
    });

    describe('configuration', () => {
        it('should use default options', async () => {
            const plugin = createMetadataExtractionPlugin();

            expect(plugin.name).toBe('metadata-extraction');
            expect(plugin.version).toBe('1.0.0');
        });
    });
});
