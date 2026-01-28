import { describe } from 'vitest';
import { S3Provider } from '../s3-provider';
import { createProviderContractTests } from '@fluxmedia/core/testing';

describe('S3Provider', () => {
    createProviderContractTests('S3', () => {
        return new S3Provider({
            region: 'us-east-1',
            bucket: 'test-bucket',
            accessKeyId: 'test-key',
            secretAccessKey: 'test-secret',
        });
    });
});
