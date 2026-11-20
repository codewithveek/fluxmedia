import { describe, it, expect, vi } from 'vitest';
import { R2Provider } from '../r2-provider';

vi.mock('@aws-sdk/client-s3', () => ({
    S3Client: vi.fn().mockImplementation(function () {
        return {
            send: vi.fn().mockResolvedValue({ ContentLength: 3, Metadata: { extension: 'png' } }),
        };
    }),
    DeleteObjectCommand: vi.fn(),
    HeadObjectCommand: vi.fn(),
}));

vi.mock('@aws-sdk/lib-storage', () => ({
    Upload: vi.fn().mockImplementation(function () {
        return {
            on: vi.fn(),
            done: vi.fn().mockResolvedValue({}),
        };
    }),
}));

const base = {
    accountId: 'acct',
    bucket: 'private-bucket',
    accessKeyId: 'test-key',
    secretAccessKey: 'test-secret',
};

const uploadOptions = { filename: 'report', uniqueFilename: false, folder: 'docs' };

describe('R2Provider publicUrl', () => {
    describe('without publicUrl (private bucket / signed URLs)', () => {
        it('uploads successfully and omits publicUrl from the result', async () => {
            const provider = new R2Provider(base);

            const result = await provider.upload(Buffer.from('abc'), uploadOptions);

            expect(result.storageKey).toBe('docs/report');
            expect('publicUrl' in result).toBe(false);
            expect(result.url).toBe(
                'https://acct.r2.cloudflarestorage.com/private-bucket/docs/report'
            );
        });

        it('get() omits publicUrl', async () => {
            const provider = new R2Provider(base);

            const result = await provider.get('docs/report');

            expect('publicUrl' in result).toBe(false);
            expect(result.url).toBe(
                'https://acct.r2.cloudflarestorage.com/private-bucket/docs/report'
            );
        });

        it('getUrl() returns the storage endpoint URL instead of throwing', () => {
            const provider = new R2Provider(base);

            expect(provider.getUrl('a/b.png')).toBe(
                'https://acct.r2.cloudflarestorage.com/private-bucket/a/b.png'
            );
        });

        it('getUrl() uses a custom endpoint when configured', () => {
            const provider = new R2Provider({
                bucket: 'private-bucket',
                accessKeyId: 'test-key',
                secretAccessKey: 'test-secret',
                endpoint: 'https://r2.internal.example.com/',
            });

            expect(provider.getUrl('a.png')).toBe(
                'https://r2.internal.example.com/private-bucket/a.png'
            );
        });
    });

    describe('with publicUrl', () => {
        it('sets url and publicUrl from the public base URL', async () => {
            const provider = new R2Provider({ ...base, publicUrl: 'https://cdn.example.com' });

            const result = await provider.upload(Buffer.from('abc'), uploadOptions);

            expect(result.publicUrl).toBe('https://cdn.example.com/docs/report');
            expect(result.url).toBe('https://cdn.example.com/docs/report');
        });

        it('tolerates a trailing slash on publicUrl', () => {
            const provider = new R2Provider({ ...base, publicUrl: 'https://cdn.example.com/' });

            expect(provider.getUrl('a.png')).toBe('https://cdn.example.com/a.png');
        });
    });
});
