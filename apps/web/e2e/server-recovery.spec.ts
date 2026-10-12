import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from '@playwright/test'

test('the production server presents a private read-only recovery page after an early startup failure', async ({
  page,
  request,
}, testInfo) => {
  const root = await mkdtemp(path.join(tmpdir(), 'nxt-recovery-journey-'))
  const data = path.join(root, 'data')
  await mkdir(data)
  await writeFile(path.join(data, 'workspaces'), 'synthetic filesystem conflict')
  const child = spawn(process.execPath, ['apps/server/dist/main.mjs'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NEKRO_DATA: data,
      NEKRO_HOST: '127.0.0.1',
      NEKRO_PORT: '0',
      NEKRO_MANAGEMENT_KEY: '',
      NEKRO_RELEASE_ID: 'synthetic-recovery-journey',
      NEKRO_LLM_PROVIDERS: '',
    },
  })
  let output = ''
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
  child.stderr.on('data', () => undefined)
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  try {
    await expect
      .poll(() => /恢复页面已监听 (http:\/\/127\.0\.0\.1:\d+)/u.exec(output)?.[1], { timeout: 30_000 })
      .toBeTruthy()
    const origin = /恢复页面已监听 (http:\/\/127\.0\.0\.1:\d+)/u.exec(output)![1]!
    expect((await request.get(`${origin}/health/live`)).status()).toBe(200)
    expect((await request.get(`${origin}/health/ready`)).status()).toBe(503)
    expect((await request.post(`${origin}/api/recovery/retry`)).status()).toBe(405)
    for (const [theme, width] of [
      ['light', 1440],
      ['dark', 390],
    ] as const) {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme })
      expect((await page.goto(`${origin}/channels/chn_synthetic`))?.status()).toBe(503)
      await expect(page.getByRole('heading', { name: '启动未完成' })).toBeVisible()
      await expect(page.getByText(/--retry-upgrade/u)).toBeVisible()
      await expect(page.locator('body')).not.toContainText(data)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await page.screenshot({ path: testInfo.outputPath(`recovery-${theme}-${width}.png`) })
    }
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
    timer.unref()
    await exited
    clearTimeout(timer)
    await rm(root, { recursive: true, force: true })
  }
})
