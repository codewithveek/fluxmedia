import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html', 'lcov'],
            exclude: [
                'node_modules/',
                'dist/',
                '**/*.config.ts',
                '**/__tests__/**',
                "**/*.js",
                'examples/',
                'docs/',
                'webapp/',
            ],
            thresholds: {
                lines: 80,
                functions: 80,
                branches: 80,
                statements: 80,
            },
        },
    },
    resolve: {
        alias: {
            '@fluxmedia/core/testing': path.resolve(__dirname, 'packages/core/src/testing.ts'),
            '@fluxmedia/core/server': path.resolve(__dirname, 'packages/core/src/server.ts'),
            '@fluxmedia/core': path.resolve(__dirname, 'packages/core/src/index.ts'),
            '@fluxmedia/s3': path.resolve(__dirname, 'packages/s3/src/index.ts'),
        },
    },
});
