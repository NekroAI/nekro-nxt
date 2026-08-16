import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: false,
  sourcemap: true,
  clean: true,
  external: ['@nekro-nxt/contracts', '@nekro-nxt/core', '@nekro-nxt/extension-sdk'],
})
