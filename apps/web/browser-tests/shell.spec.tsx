import { ChannelIdSchema, HostApiContracts } from '@nekro-nxt/contracts'
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

/** Enough group channels that the overview and the channel list scroll on a phone. */
const crowdedSnapshot: Snapshot = {
  ...productSnapshot,
  channels: [
    ...productSnapshot.channels,
    ...productSnapshot.channels
      .filter((channel) => channel.id === externalChannelId)
      .flatMap((channel) =>
        Array.from({ length: 24 }, (_, index) => ({
          ...channel,
          id: ChannelIdSchema.parse(`chn_crowd${String(index).padStart(2, '0')}`),
          platformChannelId: `opaque-crowd-${index}`,
          displayName: `示例群 ${index + 1}`,
        })),
      ),
  ],
}

/** A notched phone in portrait: the status bar and home indicator, as the shell's safe-area tokens. */
const notched = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      document.documentElement.style.setProperty('--safe-top', '59px')
      document.documentElement.style.setProperty('--safe-bottom', '34px')
    })
  })
}

/** Scrolls every scroll container inside `scope` to its end. */
const scrollToEnd = (scope: Locator) =>
  scope.evaluate((root) => {
    for (const node of [root, ...root.querySelectorAll<HTMLElement>('*')]) {
      if (/auto|scroll/u.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight)
        node.scrollTop = node.scrollHeight
    }
  })

/** Asserts `item` lies wholly between the top bar and the bottom navigation. */
const expectClearOfChrome = async (page: Page, item: Locator) => {
  const box = await item.boundingBox()
  const top = await page.locator('header').first().boundingBox()
  const nav = await page.getByRole('navigation', { name: '主导航' }).boundingBox()
  if (!box || !top || !nav) throw new Error('外壳或列表项没有几何尺寸。')
  expect(box.y).toBeGreaterThanOrEqual(top.y + top.height)
  expect(box.y + box.height).toBeLessThanOrEqual(nav.y)
}

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

/** Every text field on the page with its computed text size. */
const fieldFonts = (page: Page) =>
  page
    .locator(
      'input:not([type="checkbox"], [type="radio"], [type="range"], [type="file"], [type="hidden"]), textarea, [contenteditable="true"]',
    )
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        field: node.getAttribute('aria-label') ?? node.getAttribute('placeholder') ?? node.tagName,
        size: Number.parseFloat(getComputedStyle(node).fontSize),
      })),
    )

/**
 * Controls in view that a fingertip on a 38px square around their centre can miss: one of the square's edge midpoints
 * lands on something else (nothing, or a neighbour). Controls covered at their centre are not in view and skipped.
 */
const missedTargets = (page: Page) =>
  page.evaluate(() => {
    // Just inside 20px: rows whose hit areas meet edge to edge (wrapped pills) are not a miss.
    const reach = 19
    const misses: string[] = []
    const owns = (node: Element, x: number, y: number) => {
      const found = document.elementFromPoint(x, y)
      return found !== null && (found === node || node.contains(found))
    }
    for (const node of document.querySelectorAll('button, a[href], [role="switch"], [role="tab"], [role="radio"]')) {
      const box = node.getBoundingClientRect()
      const x = box.left + box.width / 2
      const y = box.top + box.height / 2
      if (box.width === 0 || x - reach < 0 || x + reach > innerWidth || y - reach < 0 || y + reach > innerHeight)
        continue
      if (!owns(node, x, y)) continue
      const points: [number, number][] = [
        [x, y - reach],
        [x, y + reach],
        [x - reach, y],
        [x + reach, y],
      ]
      // Partly scrolled under the top bar or the bottom navigation: not fully in view.
      const chrome = (px: number, py: number) => {
        const found = document.elementFromPoint(px, py)?.closest('nav, body > div header')
        return found !== null && found !== undefined && !found.contains(node)
      }
      if (points.some(([px, py]) => chrome(px, py))) continue
      const edges = points.map(([px, py]) => owns(node, px, py))
      if (!edges.every(Boolean)) {
        const name = node.getAttribute('aria-label') ?? node.textContent?.trim().slice(0, 16) ?? node.tagName
        misses.push(`${name} ${Math.round(box.width)}×${Math.round(box.height)}`)
      }
    }
    return misses
  })

/** Asserts the document root cannot be scrolled, by content or by script. */
const expectPinnedDocument = async (page: Page) => {
  const root = await page.evaluate(() => {
    window.scrollTo(0, 400)
    const { scrollHeight, clientHeight } = document.documentElement
    return { scrollHeight, clientHeight, scrollY: window.scrollY }
  })
  expect(root.scrollHeight).toBeLessThanOrEqual(root.clientHeight)
  expect(root.scrollY).toBe(0)
}

/**
 * Stands in for the browser's visual viewport so a test can raise an on-screen keyboard over the page: a
 * `test-keyboard` event carries how many pixels the keyboard covers.
 */
const fakeKeyboard = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    const viewport = new EventTarget()
    let height = window.innerHeight
    Object.defineProperties(viewport, {
      height: { get: () => height },
      offsetTop: { get: () => 0 },
      scale: { get: () => 1 },
    })
    Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => viewport })
    window.addEventListener('test-keyboard', (event) => {
      if (!(event instanceof CustomEvent) || typeof event.detail !== 'number') return
      height = document.documentElement.clientHeight - event.detail
      viewport.dispatchEvent(new Event('resize'))
    })
  })
}

const raiseKeyboard = (page: Page, covered: number) =>
  page.evaluate((detail) => window.dispatchEvent(new CustomEvent('test-keyboard', { detail })), covered)

/** Names long enough that a phone has to cut them. */
const longNamesSnapshot: Snapshot = {
  ...productSnapshot,
  agents: productSnapshot.agents.map((agent) =>
    agent.id === sourceAgentId
      ? { ...agent, displayName: '一个名字特别特别长需要在列表与标题里稳定截断的研究助理智能体' }
      : agent,
  ),
  channels: productSnapshot.channels.map((channel) =>
    channel.id === sourceChannelId
      ? { ...channel, displayName: '一个非常非常长的群聊名称用来检查列表行与检查器标题的截断效果' }
      : channel,
  ),
}

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
      /** A phone held in the hand: touch input, a mobile viewport and its height. */
      readonly touch?: boolean
    } = {},
  ): Promise<{ page: Page; errors: string[] }> => {
    const snapshot = options.snapshot ?? productSnapshot
    const page = await browser.newPage({
      viewport: { width: options.width ?? 1440, height: options.touch ? 852 : 900 },
      ...(options.touch ? { hasTouch: true, isMobile: true } : {}),
    })
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

  test('the boot splash covers the page until the shell renders, then leaves the DOM', async () => {
    const { page, errors } = await open('/live', {
      // Keep the app's entry module from loading so the page shows only what index.html paints.
      before: async (held) => {
        await held.route('**/src/main.tsx', (request) => request.abort())
      },
    })
    try {
      const splash = page.locator('#boot-splash')
      await expect(splash).toBeVisible()
      await expect(splash).toHaveAttribute('aria-label', '正在加载 NekroNXT')
      await page.unroute('**/src/main.tsx')
      errors.length = 0
      await page.reload()
      await expect(page.locator('header').first()).toBeVisible()
      await expect(splash).toHaveCount(0)
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

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
      // A save reaches the stub a moment after the list redraws.
      await expect
        .poll(() => arrangement?.saved.at(-1))
        .toEqual({
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
      await expect.poll(() => arrangement?.saved.at(-1)).toEqual(emptyView)
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
      // The second save reaches the stub a moment after the list redraws.
      await expect
        .poll(() => arrangement?.saved.at(-1))
        .toEqual({ pinnedChannelIds: [], collapsedGroupIds: [sourceAgentId, 'unbound'] })

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

  test('one cause shows as one row, and dismissing it or everything keeps those causes quiet', async () => {
    const connectionCause = { key: `connection:${externalConnectionId}`, label: '示例群聊平台' }
    const item = (id: string, kind: string, extra: Record<string, unknown> = {}) => ({
      ...attentionItem(id, 'critical', '示例群'),
      kind,
      cause: connectionCause,
      ...extra,
    })
    const attention = [
      item('att-outage', 'connection-unhealthy'),
      item('att-send-1', 'delivery-failed', { action: { kind: 'resolve-delivery', label: '处理' } }),
      item('att-send-2', 'delivery-failed', { action: { kind: 'resolve-delivery', label: '处理' } }),
      {
        ...attentionItem('att-turn', 'warning', '资料员的内置频道'),
        cause: { key: 'agent:agt_fixture', label: '资料员' },
      },
    ]
    const batches: unknown[] = []
    const { page } = await open('/channels', {
      attention,
      before: async (page) => {
        await page.route('**/api/attention/dismiss', async (request) => {
          batches.push(request.request().postDataJSON())
          await request.fulfill({ json: { dismissed: true, revision: 'fixture-after' } })
        })
      },
    })
    try {
      await page.getByRole('button', { name: /项需要关注/u }).click()
      const panel = page.getByRole('dialog', { name: '需要关注' })
      await expect(panel.getByText('示例群聊平台')).toBeVisible()
      await expect(panel.getByText('1 个连接问题，2 条消息发送失败')).toBeVisible()
      await expect(panel.getByText('忽略后，同一原因恢复前不再提醒')).toBeVisible()
      await page.screenshot({ path: '.local/browser-test-results/attention-causes.png' })
      await panel.getByRole('button', { name: '忽略', exact: true }).first().click()
      await expect
        .poll(() => batches.at(-1))
        .toEqual({ ids: ['att-outage', 'att-send-1', 'att-send-2'], causes: [connectionCause.key] })
      await expect(panel.getByText('示例群聊平台')).toHaveCount(0)
    } finally {
      await page.close()
    }

    const second = await open('/channels', {
      attention,
      before: async (page) => {
        await page.route('**/api/attention/dismiss', async (request) => {
          batches.push(request.request().postDataJSON())
          await request.fulfill({ json: { dismissed: true, revision: 'fixture-after' } })
        })
      },
    })
    try {
      await second.page.getByRole('button', { name: /项需要关注/u }).click()
      await second.page.getByRole('dialog', { name: '需要关注' }).getByRole('button', { name: '全部忽略' }).click()
      await expect
        .poll(() => batches.at(-1))
        .toEqual({
          ids: ['att-outage', 'att-send-1', 'att-send-2', 'att-turn'],
          causes: [connectionCause.key, 'agent:agt_fixture'],
        })
    } finally {
      await second.page.close()
    }
  })

  test('on a phone the last overview and channel-list rows scroll clear of the bottom navigation', async () => {
    for (const withNotch of [false, true]) {
      const { page, errors } = await open('/live', {
        snapshot: crowdedSnapshot,
        width: 393,
        ...(withNotch ? { before: notched } : {}),
      })
      try {
        const nav = page.getByRole('navigation', { name: '主导航' })
        await expect(nav).toBeVisible()
        const overviewRows = page.locator('main').getByRole('link', { name: /示例群/u })
        await expect(overviewRows.first()).toBeVisible()
        await scrollToEnd(page.locator('main'))
        await expectClearOfChrome(page, overviewRows.last())
        if (withNotch) {
          // The bar's controls sit below the status bar and the capsule above the home indicator.
          const search = await page.getByRole('button', { name: '搜索' }).boundingBox()
          const capsule = await nav.boundingBox()
          expect(search?.y).toBeGreaterThanOrEqual(59)
          expect((capsule?.y ?? 0) + (capsule?.height ?? 0)).toBeLessThanOrEqual(
            (page.viewportSize()?.height ?? 0) - 34,
          )
        }

        await page.goto(page.url().replace(/\/live$/u, '/channels'))
        await page.getByRole('button', { name: '全部频道' }).click()
        const drawer = page.locator('[data-list-drawer="open"] > aside')
        await expect(drawer.getByText('示例群 24')).toBeVisible()
        await scrollToEnd(drawer)
        await expectClearOfChrome(page, drawer.getByText('示例群 24'))
        expect(errors).toEqual([])
      } finally {
        await page.close()
      }
    }
  })

  test('on a touch phone fields take 16px text and the document stays put; computers keep their sizes', async () => {
    const { page, errors } = await open(`/channels/${externalChannelId}`, { width: 393, touch: true })
    try {
      await expect(page.getByRole('textbox', { name: '消息' })).toBeVisible()
      await expectPinnedDocument(page)
      await page.getByRole('button', { name: '搜索' }).click()
      await expect(page.getByPlaceholder('搜索频道、智能体或操作')).toBeVisible()
      // Keys mean nothing without a keyboard: the palette lists none.
      await expect(page.locator('kbd', { hasText: 'esc' })).toBeHidden()
      const phone = await fieldFonts(page)
      expect(phone.length).toBeGreaterThanOrEqual(2)
      for (const { field, size } of phone) expect(size, field).toBeGreaterThanOrEqual(16)
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
    const desktop = await open(`/channels/${externalChannelId}`)
    try {
      await expect(desktop.page.getByRole('textbox', { name: '消息' })).toBeVisible()
      expect(await fieldFonts(desktop.page)).toContainEqual({ field: '消息', size: 14 })
      await desktop.page.getByRole('button', { name: '搜索' }).click()
      await expect(desktop.page.locator('kbd', { hasText: 'esc' })).toBeVisible()
    } finally {
      await desktop.page.close()
    }
  })

  test('on a touch phone every control in view answers a 40px fingertip', async () => {
    for (const route of [
      '/live',
      `/channels/${externalChannelId}`,
      '/settings/appearance',
      '/workshop',
      '/wiring',
      '/logs',
    ]) {
      const { page } = await open(route, { width: 393, touch: true })
      try {
        await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible()
        await page.waitForTimeout(300)
        expect(await missedTargets(page), route).toEqual([])
      } finally {
        await page.close()
      }
    }
  })

  test('on a phone the channel header and the drawer cut long names with an ellipsis, never into vertical text', async () => {
    const { page, errors } = await open(`/channels/${sourceChannelId}`, {
      snapshot: longNamesSnapshot,
      width: 393,
      touch: true,
    })
    try {
      /** Whether `locator` is one line tall and, when its text does not fit, ends in an ellipsis. */
      const cutOnOneLine = (locator: Locator) =>
        locator.evaluate((node) => {
          const style = getComputedStyle(node)
          const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.6
          const oneLine = node.getBoundingClientRect().height <= lineHeight + 1
          const fits = node.scrollWidth <= node.clientWidth
          return oneLine && (fits || style.textOverflow === 'ellipsis')
        })
      const header = page.locator('header').filter({ has: page.getByRole('heading', { level: 1 }) })
      const title = header.getByRole('heading', { level: 1 }).locator('span').first()
      await expect(title).toHaveText(/一个非常非常长的群聊名称/u)
      expect(await cutOnOneLine(title)).toBe(true)
      // The name gets the whole first line: nothing else shares it.
      const titleBox = await title.boundingBox()
      expect(titleBox?.width ?? 0).toBeGreaterThan(200)
      expect(await cutOnOneLine(header.getByText(/一个名字特别特别长/u))).toBe(true)

      await page.getByRole('button', { name: '全部频道' }).click()
      const drawer = page.locator('[data-list-drawer="open"] > aside')
      const group = drawer.locator('[aria-roledescription="可拖动的智能体分组"]', { hasText: '一个名字特别特别长' })
      await expect(group).toBeVisible()
      expect(await cutOnOneLine(group.getByText(/一个名字特别特别长/u))).toBe(true)
      const state = group.getByText('空闲', { exact: true })
      expect(await cutOnOneLine(state)).toBe(true)
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  test('the keyboard takes the bottom bar’s place and the composer stays right above it', async () => {
    const { page, errors } = await open(`/channels/${externalChannelId}`, {
      width: 393,
      touch: true,
      before: fakeKeyboard,
    })
    try {
      const composer = page.getByRole('form', { name: '消息输入' })
      const input = page.getByRole('textbox', { name: '消息' })
      const log = page.getByRole('log', { name: '消息记录' })
      await input.fill('示例消息'.repeat(40))
      await input.focus()
      const before = await log.boundingBox()
      await raiseKeyboard(page, 336)
      await expect(page.locator('html')).toHaveAttribute('data-keyboard', 'open')
      await expect(page.getByRole('navigation', { name: '主导航' })).toBeHidden()
      const visible = 852 - 336
      const box = await composer.boundingBox()
      const after = await log.boundingBox()
      const bottom = (box?.y ?? 0) + (box?.height ?? 0)
      expect(bottom).toBeLessThanOrEqual(visible)
      expect(bottom).toBeGreaterThan(visible - 40)
      expect(after?.height ?? 0).toBeLessThan(before?.height ?? 0)
      // Long text stops growing before it crowds out the messages.
      expect(after?.height ?? 0).toBeGreaterThan((await input.boundingBox())?.height ?? 0)
      await expectPinnedDocument(page)

      // iOS scrolls the document to reveal the field and leaves it there; the app puts it back at once.
      const pushed = await page.evaluate(async () => {
        const { style } = document.documentElement
        style.setProperty('overflow', 'visible', 'important')
        document.body.style.setProperty('position', 'static', 'important')
        document.body.style.setProperty('overflow', 'visible', 'important')
        document.body.style.setProperty('height', '3000px', 'important')
        window.scrollTo(0, 300)
        await new Promise((resolve) => requestAnimationFrame(resolve))
        const scrollY = window.scrollY
        for (const name of ['position', 'overflow', 'height']) document.body.style.removeProperty(name)
        style.removeProperty('overflow')
        return scrollY
      })
      expect(pushed).toBe(0)

      await input.blur()
      await raiseKeyboard(page, 0)
      await expect(page.locator('html')).not.toHaveAttribute('data-keyboard', 'open')
      const nav = page.getByRole('navigation', { name: '主导航' })
      await expect(nav).toBeVisible()
      // Back to the full height: the bottom bar sits just above the screen edge again, with nothing left below it.
      const bar = await nav.boundingBox()
      const barBottom = (bar?.y ?? 0) + (bar?.height ?? 0)
      expect(barBottom).toBeLessThanOrEqual(852)
      expect(barBottom).toBeGreaterThan(852 - 24)
      expect(await page.evaluate(() => window.scrollY)).toBe(0)
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  test('a long press on interface controls opens no system menu, while message text stays selectable', async () => {
    const { page } = await open(`/channels/${externalChannelId}`, {
      width: 393,
      touch: true,
      before: async (target) => {
        await target.route('**/api/channels/*/messages?*', (route) =>
          route.fulfill({
            json: {
              cursor: { epoch: 'fixture', sequence: 0 },
              hasMore: false,
              messages: [
                {
                  id: 'evt_touchsample',
                  channelId: externalChannelId,
                  role: 'member',
                  sender: { memberId: 'mbr_touchsample', displayName: '示例成员' },
                  parts: [{ type: 'text', text: '可以长按复制的示例消息' }],
                  occurredAt: 1_725_000_000_000,
                },
              ],
            },
          }),
        )
      },
    })
    try {
      // Chromium has no long-press menu, so it drops -webkit-touch-callout; tokens.css sets it beside user-select
      // (tests/pwa-head.spec.ts), and user-select shows which side of the line each element is on.
      const select = (locator: Locator) => locator.evaluate((node) => getComputedStyle(node).userSelect)
      const nav = page.getByRole('navigation', { name: '主导航' })
      expect(await select(nav.getByRole('link', { name: '频道' }))).toBe('none')
      expect(await select(page.getByRole('button', { name: '搜索' }))).toBe('none')
      const text = page.getByText('可以长按复制的示例消息')
      await expect(text).toBeVisible()
      expect(await select(text)).toBe('text')
      expect(await select(page.getByRole('textbox', { name: '消息' }))).not.toBe('none')
    } finally {
      await page.close()
    }
  })

  /** The bottom bar on a phone, its indicator and where a pointer would press each item. */
  const bottomBar = (page: Page) => {
    // By selector: an open modal menu hides the bar from the accessibility tree.
    const nav = page.locator('nav[aria-label="主导航"]')
    const item = (name: string) =>
      name === '更多' ? nav.getByRole('button', { name: '更多' }) : nav.getByRole('link', { name, exact: true })
    const center = async (name: string) => {
      const box = await item(name).boundingBox()
      if (!box) throw new Error(`${name} is not on the bar`)
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    }
    /** The item's left edge inside the bar's border, where the indicator's transform puts it. */
    const left = (name: string) =>
      item(name).evaluate((node) => {
        const bar = node.parentElement
        if (!bar) throw new Error('the item is outside the bar')
        return node.getBoundingClientRect().left - bar.getBoundingClientRect().left - bar.clientLeft
      })
    const indicator = nav.locator('> span[aria-hidden="true"]').first()
    /** Where the indicator is headed (its inline style) and where it is drawn this frame. */
    const indicatorX = () =>
      indicator.evaluate((node: HTMLElement) => ({
        target: new DOMMatrixReadOnly(node.style.transform).m41,
        shown: new DOMMatrixReadOnly(getComputedStyle(node).transform).m41,
      }))
    const drag = async (from: string, to: { readonly x: number; readonly y: number }, steps = 12) => {
      const start = await center(from)
      await page.mouse.move(start.x, start.y)
      await page.mouse.down()
      await page.mouse.move(to.x, to.y, { steps })
    }
    return { nav, item, center, left, indicatorX, drag }
  }

  test('on a phone a press moves the bottom bar’s selection at once and the tap still switches spaces', async () => {
    const { page, errors } = await open('/live', { width: 393, touch: true })
    try {
      const bar = bottomBar(page)
      await expect(bar.item('概览')).toHaveAttribute('aria-current', 'page')
      await expect.poll(async () => (await bar.indicatorX()).shown).toBeCloseTo(await bar.left('概览'), 0)
      const channels = await bar.center('频道')
      await page.mouse.move(channels.x, channels.y)
      await page.mouse.down()
      // Before any click or route change: the pressed item takes the selection and the indicator is on its way.
      await expect(bar.item('频道')).toHaveAttribute('data-steer', '')
      expect((await bar.indicatorX()).target).toBeCloseTo(await bar.left('频道'), 0)
      await expect(page).toHaveURL(/\/live$/u)
      await page.mouse.up()
      await expect(page).toHaveURL(/\/channels/u)
      await expect(bar.item('频道')).toHaveAttribute('aria-current', 'page')
      await expect(bar.item('频道')).not.toHaveAttribute('data-steer')
      await expect.poll(async () => (await bar.indicatorX()).shown).toBeCloseTo(await bar.left('频道'), 0)

      // A real touch tap goes the same way.
      const agents = await bar.center('智能体')
      await page.touchscreen.tap(agents.x, agents.y)
      await expect(page).toHaveURL(/\/agents/u)
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  test('on a phone dragging along the bottom bar carries the selection and switches once on release', async () => {
    const { page, errors } = await open('/live', { width: 393, touch: true })
    try {
      const bar = bottomBar(page)
      await expect(bar.item('概览')).toHaveAttribute('aria-current', 'page')
      await page.evaluate(() => {
        const original = history.pushState.bind(history)
        const pushed: string[] = []
        Object.assign(window, { pushedForTest: pushed })
        history.pushState = (...args: Parameters<History['pushState']>) => {
          pushed.push(String(args[2]))
          original(...args)
        }
      })
      const workshop = await bar.center('工坊')
      await bar.drag('概览', { x: workshop.x - 6, y: workshop.y })
      // Under the finger, with the item below it brightened; nothing has switched yet.
      await expect(bar.nav).toHaveAttribute('data-dragging', '')
      await expect(bar.item('工坊')).toHaveAttribute('data-steer', '')
      expect(Math.abs((await bar.indicatorX()).shown - ((await bar.left('工坊')) - 6))).toBeLessThan(2)
      await expect(page).toHaveURL(/\/live$/u)
      await page.mouse.up()
      await expect(page).toHaveURL(/\/workshop/u)
      await expect(bar.item('工坊')).toHaveAttribute('aria-current', 'page')
      await expect.poll(async () => (await bar.indicatorX()).shown).toBeCloseTo(await bar.left('工坊'), 0)
      expect(await page.evaluate(() => (window as Window & { pushedForTest?: string[] }).pushedForTest)).toEqual([
        '/workshop',
      ])
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  test('on a phone moving away vertically cancels a drag and the selection returns', async () => {
    const { page } = await open('/live', { width: 393, touch: true })
    try {
      const bar = bottomBar(page)
      await expect(bar.item('概览')).toHaveAttribute('aria-current', 'page')
      const agents = await bar.center('智能体')
      await bar.drag('概览', agents)
      await expect(bar.item('智能体')).toHaveAttribute('data-steer', '')
      await page.mouse.move(agents.x, agents.y - 120, { steps: 6 })
      await expect(bar.nav).not.toHaveAttribute('data-dragging')
      await expect(bar.item('智能体')).not.toHaveAttribute('data-steer')
      expect((await bar.indicatorX()).target).toBeCloseTo(await bar.left('概览'), 0)
      await page.mouse.up()
      await page.waitForTimeout(300)
      await expect(page).toHaveURL(/\/live$/u)
      await expect(bar.item('概览')).toHaveAttribute('aria-current', 'page')
    } finally {
      await page.close()
    }
  })

  test('on a phone a drag released on “更多” opens its menu, as a tap does', async () => {
    const { page } = await open('/live', { width: 393, touch: true })
    try {
      const bar = bottomBar(page)
      await expect(bar.item('概览')).toHaveAttribute('aria-current', 'page')
      // An open menu hides the page from assistive technology, so measure first.
      const overview = await bar.left('概览')
      await bar.drag('频道', await bar.center('更多'))
      await page.mouse.up()
      const menu = page.getByRole('menu', { name: '更多' })
      await expect(menu).toBeVisible()
      await expect(page).toHaveURL(/\/live$/u)
      await expect.poll(async () => (await bar.indicatorX()).shown).toBeCloseTo(overview, 0)
      await page.keyboard.press('Escape')
      await expect(menu).toBeHidden()

      const more = await bar.center('更多')
      await page.touchscreen.tap(more.x, more.y)
      await expect(menu).toBeVisible()
      await menu.getByRole('menuitem', { name: '接线' }).click()
      await expect(page).toHaveURL(/\/wiring/u)
      await expect(bar.item('更多')).toHaveAttribute('aria-current', 'page')
      // “更多” holds the page, so it carries the selection; the hidden 接线 entry does not claim it.
      await expect(bar.nav.locator('[aria-current="page"]')).toHaveCount(1)
      await expect.poll(async () => (await bar.indicatorX()).shown).toBeCloseTo(await bar.left('更多'), 0)
      await expect(bar.nav.locator('> span[aria-hidden="true"]').first()).toHaveCSS('opacity', '1')
    } finally {
      await page.close()
    }
  })

  test('the bottom bar still works from the keyboard', async () => {
    const { page } = await open('/live', { width: 393 })
    try {
      const bar = bottomBar(page)
      await expect(bar.item('概览')).toHaveAttribute('aria-current', 'page')
      await bar.item('频道').focus()
      await page.keyboard.press('Enter')
      await expect(page).toHaveURL(/\/channels/u)
      await expect(bar.item('频道')).toHaveAttribute('aria-current', 'page')
      await expect.poll(async () => (await bar.indicatorX()).shown).toBeCloseTo(await bar.left('频道'), 0)
      await bar.item('更多').focus()
      await page.keyboard.press('Enter')
      const menu = page.getByRole('menu', { name: '更多' })
      await expect(menu).toBeVisible()
      await expect(menu.getByRole('menuitem').first()).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(menu).toBeHidden()
      await expect(page).toHaveURL(/\/(?:community|wiring|apps|logs|settings)/u)
    } finally {
      await page.close()
    }
  })

  test('with reduced motion the bottom bar’s selection lands at once', async () => {
    for (const reduce of ['app', 'system'] as const) {
      const { page } = await open('/live', {
        width: 393,
        touch: true,
        before: async (target) => {
          if (reduce === 'app')
            await target.addInitScript(() => localStorage.setItem('nekro-nxt.reduced-motion', 'true'))
          else await target.emulateMedia({ reducedMotion: 'reduce' })
        },
      })
      try {
        const bar = bottomBar(page)
        await expect(bar.item('概览')).toHaveAttribute('aria-current', 'page')
        await page.waitForTimeout(100)
        const agents = await bar.center('智能体')
        await page.mouse.move(agents.x, agents.y)
        await page.mouse.down()
        await expect(bar.item('智能体')).toHaveAttribute('data-steer', '')
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        expect((await bar.indicatorX()).shown).toBeCloseTo(await bar.left('智能体'), 0)
        await page.mouse.up()
        await expect(page).toHaveURL(/\/agents/u)
      } finally {
        await page.close()
      }
    }
  })

  test('quick taps on the bottom bar end on the last one', async () => {
    const { page, errors } = await open('/live', { width: 393, touch: true })
    try {
      const bar = bottomBar(page)
      await expect(bar.item('概览')).toHaveAttribute('aria-current', 'page')
      const points = await Promise.all(['频道', '智能体', '工坊'].map((name) => bar.center(name)))
      for (const point of points) await page.mouse.click(point.x, point.y)
      await expect(page).toHaveURL(/\/workshop/u)
      await expect(bar.item('工坊')).toHaveAttribute('aria-current', 'page')
      await expect(bar.nav.locator('[data-steer]')).toHaveCount(0)
      await expect.poll(async () => (await bar.indicatorX()).shown).toBeCloseTo(await bar.left('工坊'), 0)
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  test('the status bar colour follows the theme the app shows', async () => {
    const { page } = await open('/settings/appearance', {
      before: async (target) => {
        await target.addInitScript(() => window.localStorage.setItem('nekro-nxt.theme', 'light'))
      },
    })
    try {
      const themeColors = () =>
        page
          .locator('meta[name="theme-color"]')
          .evaluateAll((metas) => [...new Set(metas.map((meta) => meta.getAttribute('content')))])
      const side = () =>
        page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--side').trim())
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
      await expect.poll(themeColors).toEqual([await side()])
      await page.getByRole('radio', { name: '深色' }).click()
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
      const dark = await side()
      expect(dark).not.toBe('')
      await expect.poll(themeColors).toEqual([dark])
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
