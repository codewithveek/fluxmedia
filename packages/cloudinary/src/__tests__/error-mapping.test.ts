import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CloudinaryProvider } from '../cloudinary-provider';
import { MediaErrorCode } from '@fluxmedia/core';

// Mock cloudinary SDK
vi.mock('cloudinary', () => ({
    v2: {
        config: vi.fn(),
        uploader: {
            upload: vi.fn(),
            destroy: vi.fn(),
            explicit: vi.fn(),
        },
        url: vi.fn(),
    },
}));

describe('CloudinaryProvider Error Mapping', () => {
    let provider: CloudinaryProvider;

    beforeEach(() => {
        vi.clearAllMocks();
        provider = new CloudinaryProvider({
            cloudName: 'test-cloud',
            apiKey: 'test-key',
            apiSecret: 'test-secret',
        });
    });

    describe('upload errors', () => {
        it('should map 401 error to INVALID_CREDENTIALS', async () => {
            const cloudinary = await import('cloudinary');
            (cloudinary.v2.uploader.upload as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
                http_code: 401,
                message: 'Invalid API key',
            });

            try {
                await provider.upload(Buffer.from('test'));
            } catch (error: unknown) {
                const err = error as { code?: string };
                expect(err.code).toBe(MediaErrorCode.INVALID_CREDENTIALS);
            }
        });

        it('should map 402 error to QUOTA_EXCEEDED', async () => {
            const cloudinary = await import('cloudinary');
            (cloudinary.v2.uploader.upload as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
                http_code: 402,
                message: 'Quota exceeded',
            });

            try {
                await provider.upload(Buffer.from('test'));
            } catch (error: unknown) {
                const err = error as { code?: string };
                expect(err.code).toBe(MediaErrorCode.QUOTA_EXCEEDED);
            }
        });

        it('should map timeout errors to NETWORK_ERROR', async () => {
            const cloudinary = await import('cloudinary');
            (cloudinary.v2.uploader.upload as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
                http_code: 408,
                message: 'Request timeout',
            });

            try {
                await provider.upload(Buffer.from('test'));
            } catch (error: unknown) {
                const err = error as { code?: string };
                expect(err.code).toBe(MediaErrorCode.NETWORK_ERROR);
            }
        });

        it('should map file size errors to FILE_TOO_LARGE', async () => {
            const cloudinary = await import('cloudinary');
            (cloudinary.v2.uploader.upload as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
                message: 'File size too large',
            });

            try {
                await provider.upload(Buffer.from('test'));
            } catch (error: unknown) {
                const err = error as { code?: string };
                expect(err.code).toBe(MediaErrorCode.FILE_TOO_LARGE);
            }
        });

        it('should map generic errors to UPLOAD_FAILED', async () => {
            const cloudinary = await import('cloudinary');
            (cloudinary.v2.uploader.upload as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
                message: 'Some unknown error',
            });

            try {
                await provider.upload(Buffer.from('test'));
            } catch (error: unknown) {
                const err = error as { code?: string };
                expect(err.code).toBe(MediaErrorCode.UPLOAD_FAILED);
            }
        });
    });

    describe('get errors', () => {
        it('should map 404 error to FILE_NOT_FOUND', async () => {
            const cloudinary = await import('cloudinary');
            (cloudinary.v2.uploader.explicit as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
                http_code: 404,
                message: 'Resource not found',
            });

            try {
                await provider.get('non-existent-id');
            } catch (error: unknown) {
                const err = error as { code?: string };
                expect(err.code).toBe(MediaErrorCode.FILE_NOT_FOUND);
            }
        });
    });

    describe('delete errors', () => {
        it('should handle "not found" result gracefully', async () => {
            const cloudinary = await import('cloudinary');
            (cloudinary.v2.uploader.destroy as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
                result: 'not found',
            });

            // Should not throw
            await expect(provider.delete('non-existent-id')).resolves.toBeUndefined();
        });

        it('should throw DELETE_FAILED for actual failures', async () => {
            const cloudinary = await import('cloudinary');
            (cloudinary.v2.uploader.destroy as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
                result: 'error',
            });

            try {
                await provider.delete('test-id');
            } catch (error: unknown) {
                const err = error as { code?: string };
                expect(err.code).toBe(MediaErrorCode.DELETE_FAILED);
            }
        });
    });
});
