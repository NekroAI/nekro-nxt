import { chromium, expect, test, type Browser, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, type ViteDevServer } from 'vite'
import { ChannelIdSchema } from '@nekro-nxt/contracts'
import { installSnapshotHealthRoutes } from '../e2e/fixtures/host-release.js'
import {
  externalChannelId,
  externalConnectionId,
  productSnapshot,
  targetAgentId,
  targetChannelId,
} from '../e2e/fixtures/product-quality.js'

type Snapshot = typeof productSnapshot

/** An account with many fictional channels, so groups fold by default. */
const crowded = (): Snapshot => {
  const extra = Array.from({ length: 14 }, (_, index) => ({
    id: ChannelIdSchema.parse(`chn_crowd${String(index).padStart(2, '0')}`),
    connectionId: externalConnectionId,
    platformChannelId: `opaque-crowd-${index}`,
    kind: 'group' as const,
    runtimePhase: 'idle' as const,
    activity: { unreadCount: 0, unreadCapped: false },
    displayName: `示例群 ${index + 1}`,
    bindings: [],
  }))
  return {
    ...productSnapshot,
    channels: [...productSnapshot.channels, ...extra],
    connections: productSnapshot.connections.map((connection) =>
      connection.id === externalConnectionId
        ? {
            ...connection,
            status: { ...connection.status, message: '引用未解析：platform-reference-unresolved' },
          }
        : connection,
    ),
  }
}

/** Wiring journeys against a stubbed Host: every `/api` call is answered here, never by a real service. */
test.describe('wiring', () => {
  test.describe.configure({ mode: 'default', timeout: 30_000 })
  let server: ViteDevServer
  let browser: Browser
  let baseUrl: string
  let cacheDirectory: string

  test.beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), 'nekro-wiring-spec-'))
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

  const open = async (
    route: string,
    snapshot: Snapshot,
    options: { readonly width?: number; readonly colorScheme?: 'light' | 'dark' } = {},
  ): Promise<{ page: Page; errors: string[] }> => {
    const page = await browser.newPage({
      viewport: { width: options.width ?? 1440, height: 900 },
      colorScheme: options.colorScheme ?? 'light',
    })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(String(error)))
    // Lowest priority: anything not stubbed below fails loudly instead of leaking to a real service.
    await page.route('**/api/**', (request) =>
      request.fulfill({ status: 501, json: { error: { code: 'unstubbed', message: 'unstubbed' } } }),
    )
    await page.route('**/api/attention', (request) => request.fulfill({ json: { revision: 'fixture', items: [] } }))
    await page.route('**/api/platform-users*', (request) =>
      request.fulfill({ json: { total: 0, items: [], facets: { adapters: [], connections: [] } } }),
    )
    await installSnapshotHealthRoutes(page, snapshot)
    await page.route('**/api/snapshot', (request) => request.fulfill({ json: snapshot }))
    await page.route('**/api/events', (request) =>
      request.fulfill({ status: 200, contentType: 'text/event-stream', body: '' }),
    )
    if (options.colorScheme === 'dark')
      await page.addInitScript(() => window.localStorage.setItem('nekro-nxt.theme', 'dark'))
    await page.goto(`${baseUrl}${route}`)
    return { page, errors }
  }

  test('every node only selects and shows its detail; opening is explicit', async () => {
    const { page, errors } = await open(`/wiring/connections/${externalConnectionId}`, productSnapshot)
    try {
      const detail = page.getByRole('complementary', { name: '详情' })
      await expect(detail.getByRole('heading', { name: '示例群聊平台' })).toBeVisible()

      await page.locator(`[data-agent-node="${targetAgentId}"]`).click()
      await expect(page).toHaveURL(new RegExp(`/wiring/agents/${targetAgentId}$`, 'u'))
      await expect(detail.getByRole('heading', { name: '资料员' })).toBeVisible()
      await expect(detail).toContainText('资料员的内置频道')

      await detail.getByRole('button', { name: /资料员的内置频道/u }).click()
      await expect(page).toHaveURL(new RegExp(`/wiring/channels/${targetChannelId}$`, 'u'))
      await expect(detail.getByRole('heading', { name: '资料员的内置频道' })).toBeVisible()
      await expect(detail.getByRole('combobox', { name: '资料员的内置频道 的响应智能体' })).toHaveText('资料员')

      await page.getByRole('button', { name: /^产品讨论群/u }).click()
      await expect(page).toHaveURL(new RegExp(`/wiring/channels/${externalChannelId}$`, 'u'))
      await expect(detail.getByText('未接线', { exact: true }).first()).toBeVisible()

      await page.locator(`[data-agent-node="${targetAgentId}"]`).click()
      await detail.getByRole('button', { name: '打开智能体' }).click()
      await expect(page).toHaveURL(new RegExp(`/agents/${targetAgentId}$`, 'u'))
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  test('folds crowded accounts, searches, and filters to unwired channels', async () => {
    const { page } = await open(`/wiring/channels/${targetChannelId}`, crowded())
    try {
      const external = page.locator('[aria-expanded]').filter({ hasText: '示例群聊平台' })
      await expect(external).toHaveAttribute('aria-expanded', 'false')
      await expect(page.getByRole('button', { name: /^示例群 3/u })).toHaveCount(0)
      await external.click()
      await expect(external).toHaveAttribute('aria-expanded', 'true')
      await expect(page.getByRole('button', { name: /^示例群 3/u })).toBeVisible()

      await page.getByRole('searchbox', { name: '搜索频道' }).fill('示例群 1')
      await expect(page.getByRole('button', { name: /^示例群 12/u })).toBeVisible()
      await expect(page.getByRole('button', { name: /^资料员的内置频道/u })).toHaveCount(0)
      await page.getByRole('searchbox', { name: '搜索频道' }).fill('')

      await page.getByRole('radio', { name: '只看未接线' }).click()
      await expect(page.getByRole('button', { name: /^资料员的内置频道/u })).toHaveCount(0)
      await expect(page.getByRole('button', { name: /^产品讨论群/u })).toBeVisible()
    } finally {
      await page.close()
    }
  })

  test('explains platform codes in words and keeps the code in diagnostics', async () => {
    const { page } = await open(`/wiring/connections/${externalConnectionId}`, crowded())
    try {
      const detail = page.getByRole('complementary', { name: '详情' })
      const state = detail.getByRole('region', { name: '状态' })
      await expect(state).toContainText('收到的消息引用了一条平台未能提供的原消息')
      await expect(state).not.toContainText('platform-reference-unresolved')
      await detail.getByRole('button', { name: '诊断信息' }).click()
      await expect(detail.getByText('引用未解析：platform-reference-unresolved')).toBeVisible()
    } finally {
      await page.close()
    }
  })

  for (const width of [1100, 1280, 1440, 1920]) {
    for (const colorScheme of ['light', 'dark'] as const) {
      test(`stays within the window at ${width}px in ${colorScheme}`, async ({ browserName }, testInfo) => {
        expect(browserName).toBe('chromium')
        const { page, errors } = await open(`/wiring/connections/${externalConnectionId}`, crowded(), {
          width,
          colorScheme,
        })
        try {
          await expect(page.getByRole('heading', { name: '接线', level: 1 })).toBeVisible()
          await expect(page.getByRole('complementary', { name: '详情' })).toBeVisible()
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
          )
          expect(overflow).toBe(false)
          const path = testInfo.outputPath(`wiring-${width}-${colorScheme}.png`)
          await page.screenshot({ path, animations: 'disabled' })
          await testInfo.attach(`wiring-${width}-${colorScheme}`, { path, contentType: 'image/png' })
          expect(errors).toEqual([])
        } finally {
          await page.close()
        }
      })
    }
  }
})
