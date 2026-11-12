import { defineConfig, devices } from '@playwright/test'

// CI runs the browser tests as parallel jobs, one per group: each of the largest files alone, every other file in
// `rest`. Without a group everything runs.
const LARGEST = ['app', 'settings', 'shell']
const group = process.env['NEKRO_BROWSER_TEST_GROUP']
if (group !== undefined && group !== 'rest' && !LARGEST.includes(group))
  throw new Error(`未知的浏览器测试分组：${group}`)

export default defineConfig({
  testDir: './apps',
  testMatch:
    group === undefined || group === 'rest'
      ? '**/browser-tests/**/*.spec.{ts,tsx}'
      : `**/browser-tests/${group}.spec.{ts,tsx}`,
  testIgnore: group === 'rest' ? LARGEST.map((name) => `**/browser-tests/${name}.spec.{ts,tsx}`) : [],
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
