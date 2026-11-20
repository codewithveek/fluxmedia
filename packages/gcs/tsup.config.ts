import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: {
    only: false,
  },
  sourcemap: false,
  clean: true,
  treeshake: true,
  external: ['@fluxmedia/core', '@google-cloud/storage', /^node:/],
});
