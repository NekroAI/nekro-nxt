import { chromium, expect, test, type Browser, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, type ViteDevServer } from 'vite'
import { installSnapshotHealthRoutes } from '../e2e/fixtures/host-release.js'
import {
  externalChannelId,
  externalConnectionId,
  productSnapshot,
  sourceChannelId,
  targetChannelId,
} from '../e2e/fixtures/product-quality.js'

type Snapshot = typeof productSnapshot

const attentionItem = (id: string, severity: 'critical' | 'warning', title: string) => ({
  id,
  kind: severity === 'critical' ? 'connection-unhealthy' : 'turn-failed',
  severity,
  subject: { kind: 'connection', id: externalConnectionId },
  related: { connectionId: externalConnectionId },
  title,
  detail: '示例说明',
  action: { kind: 'open-connection', label: '查看' },
  occurredAt: 1_725_000_000_000,
})

/** Shell, channels, live and palette journeys against a stubbed Host; nothing reaches a real service. */
test.describe('shell, channels and live', () => {
  test.describe.configure({ mode: 'default', timeout: 30_000 })
  let server: ViteDevServer
  let browser: Browser
  let baseUrl: string
  let cacheDirectory: string

  test.beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), 'nekro-shell-spec-'))
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
    options: {
      readonly snapshot?: Snapshot
      readonly width?: number
      readonly attention?: readonly ReturnType<typeof attentionItem>[]
      readonly before?: (page: Page) => Promise<void>
    } = {},
  ): Promise<{ page: Page; errors: string[] }> => {
    const snapshot = options.snapshot ?? productSnapshot
    const page = await browser.newPage({ viewport: { width: options.width ?? 1440, height: 900 } })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(String(error)))
    await page.route('**/api/**', (request) =>
      request.fulfill({ status: 501, json: { error: { code: 'unstubbed', message: 'unstubbed' } } }),
    )
    await page.route('**/api/attention', (request) =>
      request.fulfill({ json: { revision: 'fixture', items: options.attention ?? [] } }),
    )
    await page.route('**/api/activity*', (request) =>
      request.fulfill({
        json: {
          from: 0,
          to: 7_200_000,
          bucketMs: 300_000,
          channels: [
            { channelId: targetChannelId, counts: [0, 2, 4, 1, 3], total: 10 },
            { channelId: sourceChannelId, counts: [1, 0, 2, 2, 1], total: 6 },
          ],
        },
      }),
    )
    await page.route('**/api/channels/*/messages?*', (request) =>
      request.fulfill({ json: { cursor: { epoch: 'fixture', sequence: 0 }, messages: [], hasMore: false } }),
    )
    await page.route('**/api/channels/*/runtime', (request) => {
      const channelId = new URL(request.request().url()).pathname.split('/')[3]
      return request.fulfill({
        json: {
          cursor: { epoch: 'fixture', sequence: 0 },
          channelId,
          phase: 'idle',
          summary: '',
          pendingInjectCount: 0,
          turns: [],
        },
      })
    })
    await page.route('**/api/platform-users*', (request) =>
      request.fulfill({ json: { total: 0, items: [], facets: { adapters: [], connections: [] } } }),
    )
    await installSnapshotHealthRoutes(page, snapshot)
    await page.route('**/api/snapshot', (request) => request.fulfill({ json: snapshot }))
    await page.route('**/api/events', (request) =>
      request.fulfill({ status: 200, contentType: 'text/event-stream', body: '' }),
    )
    await options.before?.(page)
    await page.goto(`${baseUrl}${route}`)
    return { page, errors }
  }

  test('keeps top-bar controls clear of the native window-control insets', async () => {
    const left = 84
    const right = 138
    const gutter = 8
    const { page, errors } = await open('/live')
    // Desktop injects the insets as a stylesheet (insertCSS); do the same here.
    await page.addStyleTag({
      content: `:root { --window-controls-left: ${left}px; --window-controls-right: ${right}px; }`,
    })
    try {
      const bar = page.locator('header').first()
      await expect(bar).toBeVisible()
      const height = await bar.evaluate((element) => element.getBoundingClientRect().height)
      expect(height).toBe(48)
      const brand = await bar.getByText('NekroNXT', { exact: true }).boundingBox()
      expect(brand?.x ?? 0).toBeGreaterThanOrEqual(left + gutter)
      const viewport = page.viewportSize()?.width ?? 1440
      const controls = await bar
        .locator('a, button')
        .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().right))
      expect(Math.max(...controls)).toBeLessThanOrEqual(viewport - right - gutter)
      // Interactive children never inherit the window drag region.
      const regions = await bar
        .locator('a, button')
        .evaluateAll((elements) =>
          elements.map((element) => getComputedStyle(element).getPropertyValue('-webkit-app-region')),
        )
      expect(regions.filter((region) => region && region !== 'no-drag')).toEqual([])
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  test('the top bar shows a path only below the space, with the space as the way back', async () => {
    const { page } = await open(`/channels/${targetChannelId}`)
    try {
      const path = page.getByRole('navigation', { name: '位置' })
      await expect(path.getByRole('link', { name: '频道' })).toBeVisible()
      await expect(path).toContainText('资料员的内置频道')
      await page.getByRole('link', { name: '概览' }).first().click()
      await expect(page).toHaveURL(/\/live$/u)
      await expect(path).toHaveText('')
    } finally {
      await page.close()
    }
  })

  test('searches and filters channels into a flat result list', async () => {
    const { page } = await open(`/channels/${targetChannelId}`)
    try {
      const list = page.getByRole('complementary', { name: '频道' })
      await list.getByRole('searchbox', { name: '搜索频道' }).fill('产品')
      await expect(list.getByRole('link', { name: /产品讨论群/u })).toBeVisible()
      await expect(list.getByRole('link', { name: /资料员的内置频道/u })).toHaveCount(0)
      await list.getByRole('searchbox', { name: '搜索频道' }).fill('不存在的频道')
      await expect(list.getByText('没有符合条件的频道')).toBeVisible()
      await list.getByRole('searchbox', { name: '搜索频道' }).press('Escape')
      await list.getByRole('combobox', { name: '筛选频道' }).click()
      await page.getByRole('option', { name: '示例群聊平台', exact: true }).click()
      await expect(list.getByRole('link', { name: /产品讨论群/u })).toBeVisible()
      await expect(list.getByRole('link', { name: /资料员的内置频道/u })).toHaveCount(0)
    } finally {
      await page.close()
    }
  })

  test('the channel detail groups response, source and diagnostics, and an empty channel explains itself', async () => {
    const { page, errors } = await open(`/channels/${externalChannelId}`)
    try {
      const detail = page.getByRole('complementary', { name: '频道信息' })
      await expect(detail.getByRole('region', { name: '响应' })).toBeVisible()
      await expect(detail.getByRole('region', { name: '来源' })).toBeVisible()
      await expect(detail.getByRole('button', { name: '修改频道名称' })).toBeVisible()
      await expect(detail.getByRole('button', { name: '诊断信息' })).toHaveAttribute('aria-expanded', 'false')
      await expect(page.getByRole('log', { name: '消息记录' }).getByText('还没有消息')).toBeVisible()
      await detail.getByRole('button', { name: '关闭详情' }).click()
      await expect(detail).toHaveCount(0)
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  test('live colours channels apart, toggles them from the legend and puts the most severe item first', async () => {
    const { page } = await open('/live', {
      attention: [attentionItem('att-warn', 'warning', '一条提醒'), attentionItem('att-bad', 'critical', '一处故障')],
    })
    try {
      const legend = page.getByRole('group', { name: '显示的频道' })
      const first = legend.getByRole('button').first()
      await expect(first).toHaveAttribute('aria-pressed', 'true')
      const colors = await legend
        .locator('i')
        .evaluateAll((items) => items.map((item) => getComputedStyle(item).backgroundColor))
      expect(new Set(colors).size).toBe(colors.length)
      await first.click()
      await expect(first).toHaveAttribute('aria-pressed', 'false')
      const titles = page.locator('#live-attention').getByText(/一处故障|一条提醒/u)
      await expect(titles.first()).toHaveText('一处故障')
    } finally {
      await page.close()
    }
  })

  test('the bell opens the attention list on every page, including the overview', async () => {
    const { page } = await open('/live', { attention: [attentionItem('att-bad', 'critical', '一处故障')] })
    try {
      await page.getByRole('button', { name: '1 项需要关注' }).click()
      const panel = page.getByRole('dialog', { name: '需要关注' })
      await expect(panel.getByText('一处故障')).toBeVisible()
      // Already on the overview: no link back to it.
      await expect(panel.getByRole('link', { name: '打开概览' })).toHaveCount(0)
      await page.keyboard.press('Escape')
      await expect(panel).toHaveCount(0)
    } finally {
      await page.close()
    }
  })

  test('the palette remembers recent commands and switches density', async () => {
    const { page } = await open('/live')
    try {
      await page.keyboard.press('Control+k')
      const palette = page.getByRole('dialog')
      await palette.getByRole('combobox', { name: '搜索' }).fill('紧凑')
      await palette.getByRole('option', { name: /切换到紧凑密度/u }).click()
      await expect(page.locator('html')).toHaveAttribute('data-density', 'compact')
      await page.keyboard.press('Control+k')
      await expect(palette.getByText('最近使用')).toBeVisible()
      await expect(palette.getByRole('option').first()).toContainText('切换到标准密度')
    } finally {
      await page.close()
    }
  })
})
