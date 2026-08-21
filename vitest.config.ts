import { defineConfig } from 'vitest/config'

import { workspaceSourceAliases } from './scripts/workspace-source-aliases.mjs'

export default defineConfig({
  resolve: {
    alias: workspaceSourceAliases,
  },
  test: {
    include: ['apps/*/tests/**/*.spec.{ts,tsx}', 'packages/*/tests/**/*.spec.{ts,tsx}', 'scripts/**/*.spec.{ts,tsx}'],
    server: {
      deps: {
        // DSH rc.1 UI primitives publish CSS-module imports from the package
        // entry. Keep the package in Vite's transform pipeline during browser
        // runtime tests instead of handing those imports to bare Node ESM.
        inline: ['@deepseek-ai/dsh-client-ui-primitives'],
      },
    },
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['packages/storage-sqlite/src/schema.ts'],
      reporter: ['text', 'html'],
      thresholds: {
        lines: 90,
        branches: 80,
        'packages/core/src/**': { lines: 90, branches: 80 },
        'packages/channel-runtime/src/**': { lines: 90, branches: 80 },
        'packages/storage-sqlite/src/**': { lines: 90, branches: 80 },
        'packages/contracts/src/**': { lines: 90, branches: 80 },
        'packages/extension-runtime/src/**': { lines: 90, branches: 80 },
      },
    },
  },
})
