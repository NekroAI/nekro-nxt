import { defineConfig, devices } from '@playwright/test'

const productPort = 4970

export default defineConfig({
  testDir: './apps/web/e2e',
  outputDir: './.local/playwright-results',
  fullyParallel: false,
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] ? 1 : 0,
  reporter: [['list'], ['html', { outputFolder: '.local/playwright-report', open: 'never' }]],
  use: {
    baseURL: `http://127.0.0.1:${productPort}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
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
      NEKRO_DATA: '.local/playwright-data',
      NEKRO_LLM_PROVIDERS: '',
      NEKRO_PORT: String(productPort),
    },
    url: `http://127.0.0.1:${productPort}/api/snapshot`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
})
