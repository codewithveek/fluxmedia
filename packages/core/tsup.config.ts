import { defineConfig } from 'tsup';

export default defineConfig({
    entry: ['src/index.ts', 'src/testing.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: false,
    clean: true,
    treeshake: true,
    external: ['vitest'],
});

