import { chromium, expect, test, type Browser, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, type ViteDevServer } from 'vite'
import { installSnapshotHealthRoutes } from '../e2e/fixtures/host-release.js'
import { productSnapshot, targetChannelId } from '../e2e/fixtures/product-quality.js'

/** Workshop journeys against a stubbed Host: every `/api` call is answered here, never by a real service. */
test.describe('workshop', () => {
  test.describe.configure({ mode: 'default', timeout: 30_000 })
  let server: ViteDevServer
  let browser: Browser
  let baseUrl: string
  let cacheDirectory: string

  test.beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), 'nekro-workshop-spec-'))
    server = await createServer({
      root: fileURLToPath(new URL('..', import.meta.url)),
      configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
      cacheDir: cacheDirectory,
      logLevel: 'silent',
      server: { host: '127.0.0.1', strictPort: false },
    })
    await server.listen()
    const address = server.httpServer?.address()
    if (!address || typeof address === 'string') throw new Error('Vite test server did not expose a TCP port.')
    baseUrl = `http://127.0.0.1:${address.port}`
    browser = await chromium.launch({ headless: true })
  })

  test.afterAll(async () => {
    await browser?.close()
    await server?.close()
    if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true })
  })

  const openWorkshop = async (snapshot: typeof productSnapshot): Promise<Page> => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    // Registered first so it has the lowest priority: anything not stubbed below fails loudly instead of leaking.
    await page.route('**/api/**', (route) =>
      route.fulfill({ status: 501, json: { error: { code: 'unstubbed', message: 'unstubbed' } } }),
    )
    await page.route('**/api/attention', (route) => route.fulfill({ json: { revision: 'fixture', items: [] } }))
    await installSnapshotHealthRoutes(page, snapshot)
    await page.route('**/api/snapshot', (route) => route.fulfill({ json: snapshot }))
    await page.route('**/api/events', (route) =>
      route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' }),
    )
    await page.goto(`${baseUrl}/workshop`)
    return page
  }

  test('explains the empty workshop and starts an example in a creator channel with the request typed', async () => {
    const page = await openWorkshop({ ...productSnapshot, authoringTasks: [], extensions: [] })
    try {
      await expect(page.getByText('让智能体为你做新能力')).toBeVisible()
      const list = page.getByRole('complementary', { name: '工坊' })
      await expect(list.getByText('还没有创造任务')).toBeVisible()
      await expect(list.getByText(/还没有扩展/u)).toBeVisible()
      await expect(page.locator('main').getByRole('button', { name: '资料员', exact: true })).toBeVisible()
      await page.getByRole('button', { name: /让智能体多一项本领/u }).click()
      await expect(page).toHaveURL(new RegExp(`/channels/${targetChannelId}$`, 'u'))
      await expect(page.getByRole('textbox', { name: '消息' })).toHaveValue(/帮我做一个工具/u)
    } finally {
      await page.close()
    }
  })
})
