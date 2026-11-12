import { defineConfig, devices } from '@playwright/test'

// Parallel worktrees each run the journey on their own port and data directory.
const productPort = Number(process.env['NEKRO_E2E_PORT'] ?? 4970)

// CI runs the journeys as two parallel jobs: the two longest files, one per worker, and every other file. Without a
// group everything runs.
const LONGEST = ['layout-audit', 'product-quality']
const group = process.env['NEKRO_JOURNEY_GROUP']
if (group !== undefined && group !== 'longest' && group !== 'rest') throw new Error(`未知的旅程测试分组：${group}`)

export default defineConfig({
  testDir: './apps/web/e2e',
  ...(group === 'longest' ? { testMatch: LONGEST.map((name) => `**/${name}.spec.ts`) } : {}),
  ...(group === 'rest' ? { testIgnore: LONGEST.map((name) => `**/${name}.spec.ts`) } : {}),
  outputDir: './.local/playwright-results',
  fullyParallel: false,
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] ? 1 : 0,
  reporter: [['list'], ['html', { outputFolder: '.local/playwright-report', open: 'never' }]],
  use: {
    baseURL: `http://127.0.0.1:${productPort}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // The journeys replace network responses per page; a Service Worker would answer /assets/ from its own cache
    // and never reach those routes. sw.spec.ts covers the worker itself.
    serviceWorkers: 'block',
  },
  projects: [
    {
      name: 'chromium-production',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'pnpm --filter @nekro-nxt/server start',
    env: {
      ...process.env,
      NEKRO_DATA: process.env['NEKRO_E2E_DATA'] ?? '.local/playwright-data',
      NEKRO_LLM_PROVIDERS: '',
      NEKRO_PORT: String(productPort),
    },
    url: `http://127.0.0.1:${productPort}/api/snapshot`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
})
