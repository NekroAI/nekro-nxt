import { defineConfig, devices } from '@playwright/test'

// Documentation flows (docs/site/flows): every flow starts its own blank server, takes the screenshots its page shows
// and writes a report to .local/docs-shots for scripts/docs-bundle.mjs. Needs `pnpm build` first.
export default defineConfig({
  testDir: './docs/site/flows',
  testMatch: '**/*.flow.ts',
  outputDir: './.local/docs-flows-results',
  fullyParallel: true,
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] ? 1 : 0,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    // Narrow enough that a cropped shot keeps its text readable in the docs column, wide enough for the desktop layout.
    viewport: { width: 1100, height: 720 },
    deviceScaleFactor: 2,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    trace: 'retain-on-failure',
    serviceWorkers: 'block',
  },
})
