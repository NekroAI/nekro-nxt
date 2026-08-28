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
      include: [
        'packages/*/src/**/*.ts',
        'apps/server/src/bootstrap.ts',
        'apps/server/src/dsh-plugin-installer.ts',
        'apps/server/src/dsh-plugin-lifecycle.ts',
        'apps/server/src/host-api.ts',
        'apps/server/src/host-extension-installation.ts',
        'apps/server/src/host-ui-network.ts',
        'apps/server/src/imported-extension-verifier.ts',
        'apps/server/src/index.ts',
        'apps/server/src/main.ts',
        'apps/server/src/management-edge.ts',
        'apps/server/src/sse-hub.ts',
        'apps/web/src/dsh-dynamic-client.ts',
        'apps/web/src/extension-client.ts',
        'apps/web/src/host-event-stream.ts',
        'apps/web/src/http-dynamic-host.ts',
        'apps/web/src/http-host.ts',
        'apps/web/src/product-port.ts',
        'apps/web/src/product-store.ts',
        'apps/desktop/src/host-supervisor.ts',
        'apps/desktop/src/instance-profiles.ts',
        'apps/desktop/src/ipc-registration.ts',
        'apps/desktop/src/local-host-state.ts',
        'apps/desktop/src/profile-visibility.ts',
        'apps/desktop/src/remote-profile-enrollment.ts',
        'apps/desktop/src/remote-session.ts',
        'apps/desktop/src/runtime-credential-store.ts',
        'apps/desktop/src/runtime-file-monitor.ts',
        'apps/desktop/src/serialized-task-queue.ts',
        'apps/desktop/src/settings-command-fallback.ts',
        'apps/desktop/src/settings-navigation.ts',
        'apps/desktop/src/view-transition-lifecycle.ts',
      ],
      exclude: ['packages/storage-sqlite/src/schema.ts', 'apps/web/src/**/*.d.ts'],
      reporter: ['text', 'html'],
      thresholds: {
        'packages/*/src/**': { lines: 90, branches: 80 },
        'apps/server/src/**': { lines: 72, branches: 52 },
        'apps/web/src/**': { lines: 70, branches: 45 },
        'apps/desktop/src/**': { lines: 80, branches: 70 },
        'packages/core/src/**': { lines: 90, branches: 80 },
        'packages/channel-runtime/src/**': { lines: 90, branches: 80 },
        'packages/storage-sqlite/src/**': { lines: 90, branches: 80 },
        'packages/contracts/src/**': { lines: 90, branches: 80 },
        'packages/extension-runtime/src/**': { lines: 90, branches: 80 },
      },
    },
  },
})
