import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    entry: ['src/main.ts'],
    deps: { neverBundle: ['electron'] },
    format: ['esm'],
    clean: true,
    dts: false,
    sourcemap: true,
  },
  {
    entry: ['src/product-preload.ts', 'src/overlay-preload.ts'],
    deps: { neverBundle: ['electron'] },
    format: ['cjs'],
    clean: false,
    dts: false,
    sourcemap: true,
  },
])
