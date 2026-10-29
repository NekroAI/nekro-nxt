import { HostApiContracts } from '@nekro-nxt/contracts'
import { chromium, expect, test, type Browser, type Locator, type Page } from '@playwright/test'
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
  sourceAgentId,
  sourceChannelId,
  targetAgentId,
  targetChannelId,
} from '../e2e/fixtures/product-quality.js'

type Snapshot = typeof productSnapshot
type ListView = Snapshot['channelListView']

const emptyView: ListView = { pinnedChannelIds: [], collapsedGroupIds: [] }

/** The product snapshot with unread messages in 记录员's channel (3) and the unbound one (4), arranged as `view`. */
const arrangedSnapshot = (view: ListView): Snapshot => ({
  ...productSnapshot,
  channels: productSnapshot.channels.map((channel) => ({
    ...channel,
    activity: {
      ...channel.activity,
      unreadCount: channel.id === sourceChannelId ? 3 : channel.id === externalChannelId ? 4 : 0,
    },
  })),
  channelListView: view,
})

/**
 * Serves the channel list arrangement like the host: a save comes back in the next snapshot. `writes` records every
 * other mutating request, so a test can show the list arrangement never touched bindings.
 */
const serveArrangement = async (page: Page, initial: ListView = emptyView) => {
  let view = initial
  const saved: ListView[] = []
  const writes: string[] = []
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (request.method() !== 'GET' && path !== '/api/channel-list-view' && !path.endsWith('/read')) {
      writes.push(`${request.method()} ${path}`)
    }
  })
  await page.route('**/api/snapshot', (route) => route.fulfill({ json: arrangedSnapshot(view) }))
  await page.route('**/api/channel-list-view', (route) => {
    view = HostApiContracts.updateChannelListView.request.parse(route.request().postDataJSON())
    saved.push(view)
    return route.fulfill({ json: view })
  })
  return { saved, writes }
}

const dragTo = async (page: Page, source: Locator, target: Locator): Promise<void> => {
  const from = await source.boundingBox()
  const to = await target.boundingBox()
  if (!from || !to) throw new Error('拖拽目标没有几何尺寸。')
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2 + 8, { steps: 6 })
  // Aim at the target's leading edge: sortable rows shift away from the pointer while they make room.
  const y = to.y + (to.y < from.y ? to.height * 0.25 : to.height * 0.75)
  await page.mouse.move(to.x + to.width / 2, y, { steps: 12 })
  await page.mouse.up()
  await page.mouse.move(8, 8)
}

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
    await page.route('**/api/channel-list-view', (request) => request.fulfill({ json: snapshot.channelListView }))
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

  test('the top bar shows where you are as text, and the rail is the way between spaces', async () => {
    const { page } = await open(`/channels/${targetChannelId}`)
    try {
      const path = page.getByRole('group', { name: '位置' })
      await expect(path).toContainText('频道')
      await expect(path).toContainText('资料员的内置频道')
      // The path does not navigate: going back to a space root would reset its selection.
      await expect(path.getByRole('link')).toHaveCount(0)
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
      const list = page.getByRole('complementary', { name: '频道', exact: true })
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

  test('pins channels above the groups, reorders them by menu and drag, and unpins them', async () => {
    let arrangement: Awaited<ReturnType<typeof serveArrangement>> | undefined
    const { page, errors } = await open(`/channels/${targetChannelId}`, {
      before: async (page) => {
        arrangement = await serveArrangement(page)
      },
    })
    try {
      const list = page.getByRole('complementary', { name: '频道', exact: true })
      const pinned = list.getByRole('group', { name: '置顶' })
      const openRowMenu = async (name: string) => {
        await list.locator('a[href^="/channels/"]', { hasText: name }).hover()
        await list.getByRole('button', { name: `${name} 的更多操作` }).click()
      }
      const pinnedOrder = () =>
        pinned.locator('a[href^="/channels/"]').evaluateAll((links) => links.map((link) => link.getAttribute('href')))

      await openRowMenu('记录员的内置频道')
      await page.getByRole('menuitem', { name: '置顶', exact: true }).click()
      await expect(pinned.locator(`a[href="/channels/${sourceChannelId}"]`)).toBeVisible()
      // The channel leaves its group instead of showing twice.
      await expect(list.locator(`a[href="/channels/${sourceChannelId}"]`)).toHaveCount(1)
      await openRowMenu('产品讨论群')
      await page.getByRole('menuitem', { name: '置顶', exact: true }).click()
      await expect.poll(pinnedOrder).toEqual([`/channels/${sourceChannelId}`, `/channels/${externalChannelId}`])
      expect(arrangement?.saved.at(-1)).toEqual({
        pinnedChannelIds: [sourceChannelId, externalChannelId],
        collapsedGroupIds: [],
      })

      await openRowMenu('产品讨论群')
      await expect(page.getByRole('menuitem', { name: '下移' })).toHaveCount(0)
      await page.getByRole('menuitem', { name: '上移' }).click()
      await expect.poll(pinnedOrder).toEqual([`/channels/${externalChannelId}`, `/channels/${sourceChannelId}`])

      // A press during the menu's closing animation does not reach the row.
      await expect(page.getByRole('menu')).toHaveCount(0)
      await dragTo(
        page,
        pinned.locator(`a[href="/channels/${sourceChannelId}"]`),
        pinned.locator(`a[href="/channels/${externalChannelId}"]`),
      )
      await expect.poll(pinnedOrder).toEqual([`/channels/${sourceChannelId}`, `/channels/${externalChannelId}`])
      await expect(page).toHaveURL(new RegExp(`/channels/${targetChannelId}$`, 'u'))

      await openRowMenu('产品讨论群')
      await page.getByRole('menuitem', { name: '取消置顶' }).click()
      await expect.poll(pinnedOrder).toEqual([`/channels/${sourceChannelId}`])
      await expect(list.locator(`a[href="/channels/${externalChannelId}"]`)).toHaveCount(1)
      await openRowMenu('记录员的内置频道')
      await page.getByRole('menuitem', { name: '取消置顶' }).click()
      await expect(pinned).toHaveCount(0)
      expect(arrangement?.saved.at(-1)).toEqual(emptyView)
      expect(arrangement?.writes).toEqual([])
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  test('collapses groups behind their unread totals and searches inside them without expanding them', async () => {
    let arrangement: Awaited<ReturnType<typeof serveArrangement>> | undefined
    const { page, errors } = await open(`/channels/${targetChannelId}`, {
      before: async (page) => {
        arrangement = await serveArrangement(page)
      },
    })
    try {
      const list = page.getByRole('complementary', { name: '频道', exact: true })
      await list.getByRole('button', { name: '收起「记录员」' }).click()
      await expect(list.getByRole('button', { name: '展开「记录员」' })).toHaveAttribute('aria-expanded', 'false')
      await expect(list.locator(`a[href="/channels/${sourceChannelId}"]`)).toHaveCount(0)
      await expect(list.getByTitle('3 条未读')).toBeVisible()
      await list.getByRole('button', { name: '收起「未接线」' }).click()
      await expect(list.locator(`a[href="/channels/${externalChannelId}"]`)).toHaveCount(0)
      await expect(list.getByTitle('4 条未读')).toBeVisible()
      expect(arrangement?.saved.at(-1)).toEqual({ pinnedChannelIds: [], collapsedGroupIds: [sourceAgentId, 'unbound'] })

      const search = list.getByRole('searchbox', { name: '搜索频道' })
      await search.fill('记录员')
      await expect(list.getByRole('link', { name: /记录员的内置频道/u })).toBeVisible()
      await search.fill('产品')
      await expect(list.getByRole('link', { name: /产品讨论群/u })).toBeVisible()
      await search.fill('')
      await expect(list.locator(`a[href="/channels/${sourceChannelId}"]`)).toHaveCount(0)
      await expect(list.getByRole('button', { name: '展开「记录员」' })).toBeVisible()
      expect(arrangement?.saved).toHaveLength(2)

      await list.getByRole('button', { name: '展开「记录员」' }).click()
      await expect(list.locator(`a[href="/channels/${sourceChannelId}"]`)).toBeVisible()
      await expect(list.getByTitle('3 条未读')).toHaveCount(0)
      // The group name still opens the agent.
      await list.locator('[aria-roledescription="可拖动的智能体分组"]', { hasText: '资料员' }).click()
      await expect(page).toHaveURL(new RegExp(`/agents/${targetAgentId}`, 'u'))
      expect(arrangement?.writes).toEqual([])
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  test('drops a channel onto a collapsed group to bind or unbind it', async () => {
    const { page, errors } = await open(`/channels/${targetChannelId}`, {
      before: async (page) => {
        await serveArrangement(page, { pinnedChannelIds: [], collapsedGroupIds: [targetAgentId, 'unbound'] })
      },
    })
    try {
      const list = page.getByRole('complementary', { name: '频道', exact: true })
      const row = list.locator(`a[href="/channels/${sourceChannelId}"]`)
      await dragTo(page, row, list.getByRole('button', { name: '展开「资料员」' }).locator('..'))
      await expect(page.getByRole('dialog', { name: '让资料员响应「记录员的内置频道」' })).toBeVisible()
      await page.getByRole('button', { name: '取消' }).click()
      await dragTo(page, row, list.getByRole('button', { name: '展开「未接线」' }).locator('..'))
      await expect(page.getByRole('dialog', { name: '断开「记录员的内置频道」与记录员？' })).toBeVisible()
      await page.getByRole('button', { name: '取消' }).click()
      // Dropping never opens the group.
      await expect(list.getByRole('button', { name: '展开「资料员」' })).toBeVisible()
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  test('the channel detail groups who replies, source and diagnostics, and an empty channel explains itself', async () => {
    const { page, errors } = await open(`/channels/${externalChannelId}`)
    try {
      const detail = page.getByRole('complementary', { name: '频道信息' })
      await expect(detail.getByRole('region', { name: '谁来回复' })).toBeVisible()
      await expect(detail.getByRole('region', { name: '来源' })).toBeVisible()
      // Removal sits in the pane footer, apart from the settings above it.
      await expect(detail.getByRole('button', { name: '移除频道' })).toBeVisible()
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
