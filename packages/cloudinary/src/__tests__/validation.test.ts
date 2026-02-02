import { describe, it, expect, vi } from 'vitest';
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

describe('CloudinaryProvider Validation', () => {
    describe('constructor validation', () => {
        it('should throw INVALID_CONFIG when cloudName is missing', () => {
            expect(() => {
                new CloudinaryProvider({
                    cloudName: '',
                    apiKey: 'test-key',
                    apiSecret: 'test-secret',
                });
            }).toThrow();

            try {
                new CloudinaryProvider({
                    cloudName: '',
                    apiKey: 'test-key',
                    apiSecret: 'test-secret',
                });
            } catch (error: unknown) {
                const err = error as { code?: string };
                expect(err.code).toBe(MediaErrorCode.INVALID_CONFIG);
            }
        });

        it('should throw INVALID_CONFIG when apiKey is missing', () => {
            expect(() => {
                new CloudinaryProvider({
                    cloudName: 'test-cloud',
                    apiKey: '',
                    apiSecret: 'test-secret',
                });
            }).toThrow();

            try {
                new CloudinaryProvider({
                    cloudName: 'test-cloud',
                    apiKey: '',
                    apiSecret: 'test-secret',
                });
            } catch (error: unknown) {
                const err = error as { code?: string };
                expect(err.code).toBe(MediaErrorCode.INVALID_CONFIG);
            }
        });

        it('should throw INVALID_CONFIG when apiSecret is missing', () => {
            expect(() => {
                new CloudinaryProvider({
                    cloudName: 'test-cloud',
                    apiKey: 'test-key',
                    apiSecret: '',
                });
            }).toThrow();

            try {
                new CloudinaryProvider({
                    cloudName: 'test-cloud',
                    apiKey: 'test-key',
                    apiSecret: '',
                });
            } catch (error: unknown) {
                const err = error as { code?: string };
                expect(err.code).toBe(MediaErrorCode.INVALID_CONFIG);
            }
        });

        it('should create provider successfully with valid config', () => {
            const provider = new CloudinaryProvider({
                cloudName: 'test-cloud',
                apiKey: 'test-key',
                apiSecret: 'test-secret',
            });

            expect(provider).toBeInstanceOf(CloudinaryProvider);
            expect(provider.name).toBe('cloudinary');
        });

        it('should default secure to true', () => {
            const provider = new CloudinaryProvider({
                cloudName: 'test-cloud',
                apiKey: 'test-key',
                apiSecret: 'test-secret',
            });

            const configInfo = provider.getConfigInfo();
            expect(configInfo.secure).toBe(true);
        });

        it('should respect secure setting when provided', () => {
            const provider = new CloudinaryProvider({
                cloudName: 'test-cloud',
                apiKey: 'test-key',
                apiSecret: 'test-secret',
                secure: false,
            });

            const configInfo = provider.getConfigInfo();
            expect(configInfo.secure).toBe(false);
        });
    });

    describe('credential protection', () => {
        it('should not expose credentials in JSON.stringify', () => {
            const provider = new CloudinaryProvider({
                cloudName: 'test-cloud',
                apiKey: 'super-secret-key',
                apiSecret: 'super-secret-secret',
            });

            const json = JSON.stringify(provider);
            const parsed = JSON.parse(json);

            expect(parsed.apiKey).toBeUndefined();
            expect(parsed.apiSecret).toBeUndefined();
            expect(parsed.name).toBe('cloudinary');
            expect(parsed.features).toBeDefined();
        });

        it('should not expose config in Object.keys', () => {
            const provider = new CloudinaryProvider({
                cloudName: 'test-cloud',
                apiKey: 'test-key',
                apiSecret: 'test-secret',
            });

            const keys = Object.keys(provider);
            expect(keys).not.toContain('config');
        });

        it('getConfigInfo should only expose safe fields', () => {
            const provider = new CloudinaryProvider({
                cloudName: 'test-cloud',
                apiKey: 'test-key',
                apiSecret: 'test-secret',
            });

            const configInfo = provider.getConfigInfo();
            expect(configInfo.cloudName).toBe('test-cloud');
            expect(configInfo.secure).toBe(true);
            expect((configInfo as Record<string, unknown>).apiKey).toBeUndefined();
            expect((configInfo as Record<string, unknown>).apiSecret).toBeUndefined();
        });
    });

    describe('URL generation', () => {
        it('should generate fallback URL when client is not initialized', () => {
            const provider = new CloudinaryProvider({
                cloudName: 'test-cloud',
                apiKey: 'test-key',
                apiSecret: 'test-secret',
            });

            const url = provider.getUrl('my-image');
            expect(url).toBe('https://res.cloudinary.com/test-cloud/image/upload/my-image');
        });

        it('should generate fallback URL with transformations', () => {
            const provider = new CloudinaryProvider({
                cloudName: 'test-cloud',
                apiKey: 'test-key',
                apiSecret: 'test-secret',
            });

            const url = provider.getUrl('my-image', { width: 200, height: 150, quality: 80 });
            expect(url).toContain('w_200');
            expect(url).toContain('h_150');
            expect(url).toContain('q_80');
        });

        it('should use http when secure is false', () => {
            const provider = new CloudinaryProvider({
                cloudName: 'test-cloud',
                apiKey: 'test-key',
                apiSecret: 'test-secret',
                secure: false,
            });

            const url = provider.getUrl('my-image');
            expect(url.startsWith('http://')).toBe(true);
        });
    });
});
