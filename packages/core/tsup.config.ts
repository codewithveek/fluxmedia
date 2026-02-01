import { defineConfig } from 'tsup';

export default defineConfig({
    entry: ['src/index.ts', 'src/testing.ts'],
    format: ['esm', 'cjs'],
    dts: false,
    sourcemap: true,
    clean: true,
    treeshake: true,
});
