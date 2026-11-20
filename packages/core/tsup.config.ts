import { defineConfig } from 'tsup';

export default defineConfig({
    entry: ['src/index.ts', 'src/testing.ts', 'src/server.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: false,
    clean: true,
    treeshake: true,
    external: ['vitest'],
});

