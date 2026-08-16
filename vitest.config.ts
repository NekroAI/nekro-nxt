import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      '@nekro-nxt/adapter-sdk': fileURLToPath(new URL('./packages/adapter-sdk/src/index.ts', import.meta.url)),
      '@nekro-nxt/adapter-web': fileURLToPath(new URL('./packages/adapter-web/src/index.ts', import.meta.url)),
      '@nekro-nxt/contracts': fileURLToPath(new URL('./packages/contracts/src/index.ts', import.meta.url)),
      '@nekro-nxt/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
      '@nekro-nxt/extension-sdk': fileURLToPath(new URL('./packages/extension-sdk/src/index.ts', import.meta.url)),
      '@nekro-nxt/extension-runtime': fileURLToPath(
        new URL('./packages/extension-runtime/src/index.ts', import.meta.url),
      ),
      '@nekro-nxt/channel-runtime': fileURLToPath(new URL('./packages/channel-runtime/src/index.ts', import.meta.url)),
      '@nekro-nxt/storage-sqlite': fileURLToPath(new URL('./packages/storage-sqlite/src/index.ts', import.meta.url)),
      '@nekro-nxt/test-harness': fileURLToPath(new URL('./packages/test-harness/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['apps/*/tests/**/*.spec.{ts,tsx}', 'packages/*/tests/**/*.spec.{ts,tsx}', 'scripts/**/*.spec.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      reporter: ['text', 'html'],
    },
  },
})
