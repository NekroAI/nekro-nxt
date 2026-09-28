import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './electron-tests',
  outputDir: '../../.local/desktop-electron-test-results',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env['CI']),
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 5_000 },
  reporter: 'list',
  use: { trace: 'retain-on-failure' },
})
