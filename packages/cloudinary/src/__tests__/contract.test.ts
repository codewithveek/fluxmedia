import { describe } from 'vitest';
import { CloudinaryProvider } from '../cloudinary-provider';
import { createProviderContractTests } from '@fluxmedia/core/testing';

describe('CloudinaryProvider', () => {
    createProviderContractTests('Cloudinary', () => {
        return new CloudinaryProvider({
            cloudName: 'test-cloud',
            apiKey: 'test-key',
            apiSecret: 'test-secret',
        });
    });
});
