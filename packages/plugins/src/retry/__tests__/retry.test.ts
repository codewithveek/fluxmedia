import { describe, it, expect, vi } from 'vitest';
import { createRetryPlugin, withRetry, getRetryConfig } from '../index';
import { MediaError, MediaErrorCode } from '@fluxmedia/core';

describe('RetryPlugin', () => {
    describe('createRetryPlugin', () => {
        it('should add retry config to metadata', async () => {
            const plugin = createRetryPlugin({
                maxRetries: 5,
                retryDelay: 500,
            });

            const file = Buffer.from('test');

            const result = await plugin.hooks.beforeUpload!(file, {});

            expect(result).toBeDefined();
            expect(result!.options.metadata?._retry).toMatchObject({
                maxRetries: 5,
                currentAttempt: 0,
            });
        });

        it('should use default options', async () => {
            const plugin = createRetryPlugin();

            expect(plugin.name).toBe('retry');
            expect(plugin.version).toBe('1.0.0');
        });
    });

    describe('getRetryConfig', () => {
        it('should extract retry config from options', async () => {
            const plugin = createRetryPlugin({ maxRetries: 3 });
            const file = Buffer.from('test');

            const result = await plugin.hooks.beforeUpload!(file, {});
            const config = getRetryConfig(result!.options);

            expect(config).toBeDefined();
            expect(config!.maxRetries).toBe(3);
        });
    });
});

describe('withRetry', () => {
    describe('retry behavior', () => {
        it('should succeed on first attempt', async () => {
            const fn = vi.fn().mockResolvedValue('success');

            const result = await withRetry(fn, { maxRetries: 3 });

            expect(result).toBe('success');
            expect(fn).toHaveBeenCalledTimes(1);
        });

        it('should retry on network errors', async () => {
            let attempts = 0;
            const fn = vi.fn().mockImplementation(async () => {
                attempts++;
                if (attempts < 3) {
                    throw new MediaError('Network error', MediaErrorCode.NETWORK_ERROR, 'test');
                }
                return 'success';
            });

            const result = await withRetry(fn, {
                maxRetries: 3,
                retryDelay: 10,
                exponentialBackoff: false,
            });

            expect(result).toBe('success');
            expect(attempts).toBe(3);
        });

        it('should not retry on non-retryable errors', async () => {
            const fn = vi.fn().mockRejectedValue(
                new MediaError('Invalid file', MediaErrorCode.INVALID_FILE_TYPE, 'test')
            );

            await expect(
                withRetry(fn, {
                    maxRetries: 3,
                    retryableErrors: [MediaErrorCode.NETWORK_ERROR],
                })
            ).rejects.toThrow('Invalid file');

            expect(fn).toHaveBeenCalledTimes(1);
        });

        it('should call onRetry callback', async () => {
            const onRetry = vi.fn();
            let attempts = 0;

            const fn = vi.fn().mockImplementation(async () => {
                attempts++;
                if (attempts < 2) {
                    throw new MediaError('Network error', MediaErrorCode.NETWORK_ERROR, 'test');
                }
                return 'success';
            });

            await withRetry(fn, {
                maxRetries: 3,
                retryDelay: 10,
                onRetry,
            });

            expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error), expect.any(Number));
        });

        it('should use exponential backoff', async () => {
            const onRetry = vi.fn();
            let attempts = 0;

            const fn = vi.fn().mockImplementation(async () => {
                attempts++;
                if (attempts < 3) {
                    throw new MediaError('Network error', MediaErrorCode.NETWORK_ERROR, 'test');
                }
                return 'success';
            });

            await withRetry(fn, {
                maxRetries: 3,
                retryDelay: 100,
                exponentialBackoff: true,
                onRetry,
            });

            // First retry: 100ms, second retry: 200ms
            expect(onRetry).toHaveBeenNthCalledWith(1, 1, expect.any(Error), 100);
            expect(onRetry).toHaveBeenNthCalledWith(2, 2, expect.any(Error), 200);
        });

        it('should fail after max retries', async () => {
            const fn = vi.fn().mockRejectedValue(
                new MediaError('Network error', MediaErrorCode.NETWORK_ERROR, 'test')
            );

            await expect(
                withRetry(fn, {
                    maxRetries: 2,
                    retryDelay: 10,
                })
            ).rejects.toThrow('Network error');

            expect(fn).toHaveBeenCalledTimes(3); // Initial + 2 retries
        });

        it('should use custom shouldRetry function', async () => {
            const shouldRetry = vi.fn().mockReturnValue(false);

            const fn = vi.fn().mockRejectedValue(new Error('Custom error'));

            await expect(
                withRetry(fn, {
                    maxRetries: 3,
                    shouldRetry,
                })
            ).rejects.toThrow('Custom error');

            expect(shouldRetry).toHaveBeenCalledWith(expect.any(Error), 0);
            expect(fn).toHaveBeenCalledTimes(1);
        });
    });
});
