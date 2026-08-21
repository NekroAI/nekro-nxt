import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/main.ts'],
  deps: { neverBundle: ['electron'] },
  format: ['esm'],
  clean: true,
  dts: false,
  sourcemap: true,
})
