import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './apps',
  testMatch: '**/browser-tests/**/*.spec.{ts,tsx}',
  outputDir: './.local/browser-test-results',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] ? 1 : 0,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: 'list',
  use: { ...devices['Desktop Chrome'], trace: 'retain-on-failure' },
})
