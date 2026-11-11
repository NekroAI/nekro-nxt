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

/** The bottom bar's edges once it has come to rest (it may still be sliding in). */
const barRest = async (page: Page): Promise<{ top: number; bottom: number }> => {
  const nav = page.getByRole('navigation', { name: '主导航' })
  const edges = async () => {
    const box = await nav.boundingBox()
    return { top: box?.y ?? 0, bottom: (box?.y ?? 0) + (box?.height ?? 0) }
  }
  let last = await edges()
  await expect
    .poll(async () => {
      const next = await edges()
      const still = next.top === last.top
      last = next
      return still
    })
    .toBe(true)
  return last
}

/**
 * The lowest control inside the page that can be seen, cut to the scroll areas around it: its bottom edge and name.
 * Controls under a hidden level or scrolled out of their area do not count.
 */
const lowestControl = (page: Page) =>
  page.locator('main').evaluate((root) => {
    let lowest = { bottom: 0, name: '' }
    const controls = root.querySelectorAll<HTMLElement>(
      'a[href], button, input, textarea, [role="switch"], [role="tab"], [role="combobox"]',
    )
    for (const node of controls) {
      if (!node.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue
      let { top, bottom } = node.getBoundingClientRect()
      for (let parent = node.parentElement; parent && parent !== root.parentElement; parent = parent.parentElement) {
        if (getComputedStyle(parent).overflowY === 'visible') continue
        const clip = parent.getBoundingClientRect()
        top = Math.max(top, clip.top)
        bottom = Math.min(bottom, clip.bottom)
      }
      if (bottom - top < 1 || bottom <= lowest.bottom) continue
      lowest = {
        bottom,
        name: node.getAttribute('aria-label') ?? node.textContent?.trim().slice(0, 16) ?? node.tagName,
      }
    }
    return lowest
  })

/** `base` with unread messages in 记录员's channel (3) and the unbound one (4), arranged as `view`. */
const arrangedSnapshot = (view: ListView, base: Snapshot = productSnapshot): Snapshot => ({
  ...base,
  channels: base.channels.map((channel) => ({
    ...channel,
    activity: {
      ...channel.activity,
      unreadCount: channel.id === sourceChannelId ? 3 : channel.id === externalChannelId ? 4 : 0,
    },
  })),
  channelListView: view,
})

type WorkTreeOrder = Snapshot['workTreeOrder']

/**
 * Serves the channel list arrangement and the group order like the host: a save comes back in the next snapshot.
 * `writes` records every other mutating request, so a test can show the arrangement never touched bindings.
 */
const serveArrangement = async (page: Page, initial: ListView = emptyView, base: Snapshot = productSnapshot) => {
  let view = initial
  let order = base.workTreeOrder
  const saved: ListView[] = []
  const orders: WorkTreeOrder[] = []
  const writes: string[] = []
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    const arrangement = path === '/api/channel-list-view' || path === '/api/work-tree-order'
    if (request.method() !== 'GET' && !arrangement && !path.endsWith('/read')) {
      writes.push(`${request.method()} ${path}`)
    }
  })
  await page.route('**/api/snapshot', (route) =>
    route.fulfill({ json: arrangedSnapshot(view, { ...base, workTreeOrder: order }) }),
  )
  await page.route('**/api/channel-list-view', (route) => {
    view = HostApiContracts.updateChannelListView.request.parse(route.request().postDataJSON())
    saved.push(view)
    return route.fulfill({ json: view })
  })
  await page.route('**/api/work-tree-order', (route) => {
    order = HostApiContracts.putWorkTreeOrder.request.parse(route.request().postDataJSON())
    orders.push(order)
    return route.fulfill({ json: order })
  })
  return { saved, orders, writes }
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
        const list = page.getByRole('complementary', { name: '频道', exact: true })
        await expect(list.getByText('示例群 24')).toBeVisible()
        await scrollToEnd(list)
        await expectClearOfChrome(page, list.getByText('示例群 24'))
        expect(errors).toEqual([])
      } finally {
        await page.close()
      }
    }
  })

  test('on a phone pages run on under the floating bottom bar and every page’s end scrolls clear of it', async () => {
    // Long pages end near the bar once scrolled; short ones (and the contained log page) end wherever they end.
    for (const [route, long] of [
      ['/live', true],
      ['/channels', true],
      [`/agents/${targetAgentId}`, true],
      ['/logs', false],
      ['/settings/notifications', true],
      ['/wiring', true],
      ['/workshop', false],
    ] as const) {
      const { page, errors } = await open(route, {
        snapshot: crowdedSnapshot,
        width: 393,
        touch: true,
        before: notched,
      })
      try {
        const nav = page.getByRole('navigation', { name: '主导航' })
        await expect(nav).toBeVisible()
        await expect.poll(async () => (await lowestControl(page)).bottom).toBeGreaterThan(0)
        await page.waitForTimeout(300)
        // The bar floats over the page: the page reaches the screen edge and the bar lies inside it.
        const main = await page.locator('main').boundingBox()
        const bar = await barRest(page)
        expect(Math.round((main?.y ?? 0) + (main?.height ?? 0)), route).toBe(852)
        expect(bar.top, route).toBeGreaterThan(main?.y ?? 0)
        expect(bar.bottom, route).toBeLessThanOrEqual(852 - 34)
        await scrollToEnd(page.locator('main'))
        const lowest = await lowestControl(page)
        if (long) expect(lowest.bottom, `${route} ${lowest.name}`).toBeGreaterThan(bar.top - 160)
        expect(lowest.bottom, `${route} ${lowest.name}`).toBeLessThanOrEqual(bar.top)
        expect(errors, route).toEqual([])
      } finally {
        await page.close()
      }
    }
  })

  test('on a phone toasts and a page’s save bar stay above the floating bottom bar', async () => {
    const { page } = await open('/settings/notifications', { width: 393, touch: true })
    try {
      const nav = page.getByRole('navigation', { name: '主导航' })
      await expect(nav).toBeVisible()
      const bar = await barRest(page)
      await page.getByRole('switch', { name: '扩展通知' }).click()
      const save = page.getByRole('region', { name: '未保存的修改' })
      await expect(save).toBeVisible()
      // At the top of the page the save bar holds to the bottom of the view, clear of the bar.
      await page.locator('main').evaluate((root) => {
        for (const node of root.querySelectorAll<HTMLElement>('*')) node.scrollTop = 0
      })
      const saveBox = await save.boundingBox()
      expect((saveBox?.y ?? 0) + (saveBox?.height ?? 0)).toBeLessThanOrEqual(bar.top)
      await page.getByRole('button', { name: '保存' }).click()
      // The unstubbed host refuses the save; its toast rises above the bar.
      const toast = page.getByText('操作失败', { exact: false }).last()
      await expect(toast).toBeVisible()
      const toastBox = await toast.boundingBox()
      expect((toastBox?.y ?? 0) + (toastBox?.height ?? 0)).toBeLessThanOrEqual(bar.top)
    } finally {
      await page.close()
    }
  })

  test('back from a conversation the list keeps its place while the bottom bar slides back over it', async () => {
    const { page, errors } = await open(`/channels/${externalChannelId}`, { width: 393, touch: true })
    try {
      await expect(page.getByRole('textbox', { name: '消息' })).toBeVisible()
      await page.getByRole('button', { name: '返回频道列表' }).click()
      const row = page.getByRole('complementary', { name: '频道', exact: true }).getByRole('link').first()
      await expect(row).toBeVisible()
      const at = async () => {
        const box = await row.boundingBox()
        return { y: box?.y ?? 0, height: box?.height ?? 0 }
      }
      const first = await at()
      // The page keeps its height a little after the bar is back; the list must not move when it lets go.
      await page.waitForTimeout(700)
      expect(await at()).toEqual(first)
      const main = await page.locator('main').boundingBox()
      expect(Math.round((main?.y ?? 0) + (main?.height ?? 0))).toBe(852)
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  test('computers keep the page between the top bar and the status bar, with nothing floating over it', async () => {
    const { page, errors } = await open('/live', { snapshot: crowdedSnapshot })
    try {
      const status = page.getByRole('contentinfo')
      await expect(status).toBeVisible()
      const main = await page.locator('main').boundingBox()
      const footer = await status.boundingBox()
      expect(Math.round((main?.y ?? 0) + (main?.height ?? 0))).toBe(Math.round(footer?.y ?? 0))
      expect(
        await page.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue('--content-inset-bottom').trim(),
        ),
      ).toBe('0px')
      await scrollToEnd(page.locator('main'))
      const lowest = await lowestControl(page)
      expect(lowest.bottom).toBeLessThanOrEqual(footer?.y ?? 0)
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  test('on a touch phone fields take 16px text and the document stays put; computers keep their sizes', async () => {
    const { page, errors } = await open(`/channels/${externalChannelId}`, { width: 393, touch: true })
    try {
      await expect(page.getByRole('textbox', { name: '消息' })).toBeVisible()
      await expectPinnedDocument(page)
      expect(await fieldFonts(page)).toContainEqual({ field: '消息', size: 16 })
      await page.getByRole('button', { name: '返回频道列表' }).click()
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

  test('on a phone the top bar and the channel list cut long names with an ellipsis, never into vertical text', async () => {
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
      // The conversation's name and state head the top bar, each on one line within its 48px.
      const bar = page.locator('header').first()
      const title = bar.getByText(/一个非常非常长的群聊名称/u)
      await expect(title).toBeVisible()
      expect(await cutOnOneLine(title)).toBe(true)
      expect((await title.boundingBox())?.width ?? 0).toBeGreaterThan(160)
      const status = bar.getByText(/一个名字特别特别长/u)
      expect(await cutOnOneLine(status)).toBe(true)
      expect((await bar.boundingBox())?.height ?? 0).toBe(48)

      await bar.getByRole('button', { name: '返回频道列表' }).click()
      const list = page.getByRole('complementary', { name: '频道', exact: true })
      const group = list.locator('button[class*="groupHead"]', { hasText: '一个名字特别特别长' })
      await expect(group).toBeVisible()
      expect(await cutOnOneLine(group.getByText(/一个名字特别特别长/u))).toBe(true)
      const state = group.getByText('空闲', { exact: true })
      expect(await cutOnOneLine(state)).toBe(true)
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  test('the keyboard takes the page’s lower part and the composer stays right above it', async () => {
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
      // The row is add, field, send: who sends it is not a mark a finger could never read.
      await expect(composer.getByRole('img', { name: /发出$/u })).toHaveCount(0)
      // A phone with a home indicator: the keyboard covers it, so no room is kept for it.
      await page.evaluate(() => document.documentElement.style.setProperty('--safe-bottom', '34px'))
      const before = await log.boundingBox()
      await raiseKeyboard(page, 336)
      await expect(page.locator('html')).toHaveAttribute('data-keyboard', 'open')
      const visible = 852 - 336
      const box = await composer.boundingBox()
      const after = await log.boundingBox()
      const bottom = (box?.y ?? 0) + (box?.height ?? 0)
      expect(bottom).toBeLessThanOrEqual(visible)
      expect(bottom).toBeGreaterThan(visible - 16)
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
      // Back to the full height: a conversation has no bottom bar, so the composer returns to the screen edge.
      await expect(page.getByRole('navigation', { name: '主导航' })).toBeHidden()
      const rested = await composer.boundingBox()
      const restedBottom = (rested?.y ?? 0) + (rested?.height ?? 0)
      expect(restedBottom).toBeLessThanOrEqual(852 - 34)
      // Back above the home indicator.
      expect(restedBottom).toBeGreaterThan(852 - 34 - 24)
      expect(await page.evaluate(() => window.scrollY)).toBe(0)

      // The bottom bar comes back with the channel list, where the keyboard left it.
      await page.getByRole('button', { name: '返回频道列表' }).click()
      const nav = page.getByRole('navigation', { name: '主导航' })
      await expect(nav).toBeVisible()
      // It slides back up; measure where it lands.
      const barBottom = async () => {
        const bar = await nav.boundingBox()
        return (bar?.y ?? 0) + (bar?.height ?? 0)
      }
      await expect.poll(barBottom).toBeLessThanOrEqual(852 - 34 + 0.5)
      expect(await barBottom()).toBeGreaterThan(852 - 34 - 24)
      await expect(nav.locator('> span[aria-hidden="true"]').first()).toHaveCSS('opacity', '1')
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
      const nav = page.locator('nav[aria-label="主导航"]')
      expect(await select(nav.getByRole('link', { name: '频道', includeHidden: true }))).toBe('none')
      expect(await select(page.getByRole('button', { name: '返回频道列表' }))).toBe('none')
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
        const navigated: string[] = []
        Object.assign(window, { navigatedForTest: navigated })
        // Entries the app writes with an address; the shell's own notes on an entry pass none.
        for (const method of ['pushState', 'replaceState'] as const) {
          const original = history[method].bind(history)
          history[method] = (...args: Parameters<History['pushState']>) => {
            if (args[2] !== undefined) navigated.push(`${method} ${String(args[2])}`)
            original(...args)
          }
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
      // One switch, in place of the overview's entry (05 §6.2: the bottom bar adds no history).
      expect(await page.evaluate(() => (window as Window & { navigatedForTest?: string[] }).navigatedForTest)).toEqual([
        'replaceState /workshop',
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

  /** The phone's top bar: its title, the back arrow when the page has one, and the bar itself. */
  const topBar = (page: Page) => {
    const bar = page.locator('header').first()
    return { bar, back: (name: string) => bar.getByRole('button', { name }) }
  }

  test('on a phone the channel list is a page of its own and a conversation the level above it', async () => {
    const { page, errors } = await open('/channels', { width: 393, touch: true })
    try {
      const { bar, back } = topBar(page)
      const nav = page.getByRole('navigation', { name: '主导航' })
      const list = page.getByRole('complementary', { name: '频道', exact: true })
      // The list is the first level: no conversation opens by itself. A finger does not drag, so rows stay links.
      const sortable = list.getByRole('link', { name: /^资料员的内置频道 内置频道/u })
      await expect(sortable).toBeVisible()
      await page.waitForTimeout(300)
      await expect(page).toHaveURL(/\/channels$/u)
      await expect(bar).toContainText('频道')
      await expect(nav).toBeVisible()
      await expect(nav.getByRole('link', { name: '频道', exact: true })).toHaveAttribute('aria-current', 'page')
      await expect(page.getByRole('button', { name: '全部频道' })).toBeHidden()
      // A whole page: rows run to the page margin and are a fingertip tall.
      const row = await sortable.boundingBox()
      expect(row?.x ?? 0).toBe(0)
      expect(row?.height ?? 0).toBeGreaterThanOrEqual(56)

      await list.getByRole('searchbox', { name: '搜索频道' }).fill('资料员')
      await list.getByRole('link', { name: /资料员的内置频道/u }).click()
      await expect(page).toHaveURL(new RegExp(`/channels/${targetChannelId}$`, 'u'))
      await expect(bar).toContainText('资料员的内置频道')
      await expect(bar).toContainText('空闲 · 资料员')
      await expect(back('返回频道列表')).toBeVisible()
      // The conversation takes the whole height: no bottom bar, no instance, search or bell in the top bar.
      await expect(nav).toBeHidden()
      await expect(bar.getByRole('button', { name: '搜索' })).toHaveCount(0)
      await expect(bar.getByRole('button', { name: '透视' })).toBeVisible()
      await expect(bar.getByRole('button', { name: '频道信息' })).toBeVisible()
      const backBox = await back('返回频道列表').boundingBox()
      expect(backBox?.width ?? 0).toBeGreaterThanOrEqual(44)
      expect(backBox?.height ?? 0).toBeGreaterThanOrEqual(44)
      // Only one level-1 heading, read out but not drawn twice.
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
      await expect(page.getByRole('heading', { level: 1 })).toContainText('资料员的内置频道')

      // One row: add, the field, send; no taller than 60px around it.
      const input = page.getByRole('textbox', { name: '消息' })
      await expect(input).toHaveAttribute('placeholder', '发消息')
      await expect(input).toHaveAttribute('enterkeyhint', 'send')
      await expect(page.getByRole('button', { name: '添加图片' })).toHaveCount(0)
      const add = page.getByRole('button', { name: '添加附件' })
      const send = page.getByRole('button', { name: '发送' })
      const [addBox, inputBox, sendBox] = await Promise.all([
        add.boundingBox(),
        input.boundingBox(),
        send.boundingBox(),
      ])
      expect(
        Math.abs((addBox?.y ?? 0) + (addBox?.height ?? 0) - ((sendBox?.y ?? 0) + (sendBox?.height ?? 0))),
      ).toBeLessThan(4)
      expect(inputBox?.x ?? 0).toBeGreaterThan((addBox?.x ?? 0) + (addBox?.width ?? 0))
      expect(inputBox?.x ?? 0).toBeLessThan(sendBox?.x ?? 0)
      const dock = await page.getByRole('form', { name: '消息输入' }).evaluate((form) => {
        const box = form.parentElement?.getBoundingClientRect()
        return { height: box?.height ?? 0, bottom: box?.bottom ?? 0 }
      })
      expect(dock.height).toBeLessThanOrEqual(60)
      expect(dock.bottom).toBeGreaterThan(852 - 2)
      const log = await page.getByRole('log', { name: '消息记录' }).boundingBox()
      expect(log?.height ?? 0).toBeGreaterThanOrEqual(700)

      // “添加” goes straight to the system's chooser, which offers the photo library, camera and files itself.
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), add.click()])
      expect(chooser.isMultiple()).toBe(true)
      await expect(page.getByRole('dialog', { name: /添加附件/u })).toHaveCount(0)

      // Back is a real history step to the list, which kept its search.
      await back('返回频道列表').click()
      await expect(page).toHaveURL(/\/channels$/u)
      await expect(nav).toBeVisible()
      await expect(list.getByRole('searchbox', { name: '搜索频道' })).toHaveValue('资料员')
      await expect(bar.getByRole('button', { name: '搜索' })).toBeVisible()
      await page.goForward()
      await expect(page).toHaveURL(new RegExp(`/channels/${targetChannelId}$`, 'u'))
      await page.goBack()
      await expect(page).toHaveURL(/\/channels$/u)
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  /** A finger on the page through CDP touch events: Playwright's tap cannot hold still or slide. */
  const finger = async (page: Page) => {
    const session = await page.context().newCDPSession(page)
    const send = (type: 'touchStart' | 'touchMove' | 'touchEnd', point?: { x: number; y: number }) =>
      session.send('Input.dispatchTouchEvent', { type, touchPoints: point ? [point] : [] })
    const centre = async (target: Locator) => {
      const box = await target.boundingBox()
      if (!box) throw new Error('The touch target has no box.')
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    }
    // The open one: a sheet just chosen from is still leaving while the next press begins.
    const sheet = page.locator('[role="dialog"][data-state="open"]')
    return {
      sheet,
      /** Slides up from `target`'s centre by `distance` in small steps, then lifts. */
      swipe: async (target: Locator, distance: number) => {
        const { x, y } = await centre(target)
        await send('touchStart', { x, y })
        for (let step = 1; step <= 8; step++) await send('touchMove', { x, y: y - (step * distance) / 8 })
        await send('touchEnd')
      },
      /**
       * Rests on `target` until its actions sheet is up, then lifts. Waiting for the sheet rather than a fixed time
       * keeps the hold long enough however busy the machine is.
       */
      hold: async (target: Locator) => {
        // A sheet just chosen from still dims the page as it leaves and would take the press.
        await expect(page.getByRole('dialog')).toHaveCount(0)
        await send('touchStart', await centre(target))
        await expect(sheet).toBeVisible()
        await send('touchEnd')
      },
    }
  }

  /** The channel ids of the rows inside `scope`, in order. */
  const rowIds = (scope: Locator) =>
    scope
      .locator('a[href^="/channels/"]')
      .evaluateAll((links) => links.map((link) => link.getAttribute('href')?.split('/').at(-1) ?? ''))

  test('on a phone a finger scrolls the channel list, and a held row opens its actions instead of the conversation', async () => {
    const { page, errors } = await open('/channels', { width: 393, touch: true, snapshot: crowdedSnapshot })
    try {
      const list = page.getByRole('complementary', { name: '频道', exact: true })
      const row = list.locator('a[href^="/channels/"]').filter({ hasText: /^示例群 3(?!\d)/u })
      await expect(row).toBeVisible()
      // A finger never drags, so the rows do not offer it.
      await expect(list.locator('[aria-roledescription]')).toHaveCount(0)
      const touch = await finger(page)
      const scrolled = () =>
        list.evaluate((node) => Math.max(...[node, ...node.querySelectorAll('*')].map((item) => item.scrollTop)))

      // Resting on a row opens its actions; letting go stays on the list.
      await touch.hold(row)
      await expect(touch.sheet).toHaveAccessibleName('示例群 3')
      await page.waitForTimeout(300)
      await expect(touch.sheet).toBeVisible()
      await expect(page).toHaveURL(/\/channels$/u)
      // Android's long-press menu for the link does not open.
      expect(
        await row.evaluate(
          (node) => !node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })),
        ),
      ).toBe(true)
      // An unbound row: it moves within 未接线, pins, and can be given to an agent; there is nothing to unbind.
      await expect(touch.sheet.getByRole('button')).toHaveText(['上移', '下移', '置顶', '接到智能体…'])
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog')).toHaveCount(0)

      // A swipe that starts on a row moves the list and opens nothing, even after a hold's worth of waiting.
      await touch.swipe(row, 160)
      await expect.poll(scrolled).toBeGreaterThan(40)
      await page.waitForTimeout(800)
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(page).toHaveURL(/\/channels$/u)
      // A tap still opens the conversation.
      await row.tap()
      await expect(page).toHaveURL(/\/channels\/chn_crowd02$/u)
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  test('on a phone the actions sheet moves rows and groups one step and saves like a drag', async () => {
    let arrangement: Awaited<ReturnType<typeof serveArrangement>> | undefined
    const { page, errors } = await open('/channels', {
      width: 393,
      touch: true,
      snapshot: crowdedSnapshot,
      before: async (target) => {
        arrangement = await serveArrangement(target, emptyView, crowdedSnapshot)
      },
    })
    try {
      const list = page.getByRole('complementary', { name: '频道', exact: true })
      const touch = await finger(page)
      const unbound = list.getByRole('button', { name: '收起「未接线」' }).locator('../..')
      await expect(list.getByText('示例群 1', { exact: true })).toBeVisible()
      const firstThree = async () => (await rowIds(unbound)).slice(0, 3)
      const [one, two] = ['chn_crowd00', 'chn_crowd01']
      expect(await firstThree()).toEqual([externalChannelId, one, two])

      // The first row of a group cannot move up.
      await touch.hold(list.locator('a[href^="/channels/"]', { hasText: '产品讨论群' }))
      await expect(touch.sheet.getByRole('button', { name: '上移' })).toHaveCount(0)
      await touch.sheet.getByRole('button', { name: '下移' }).click()
      await expect(touch.sheet).toHaveCount(0)
      await expect.poll(firstThree).toEqual([one, externalChannelId, two])
      await expect
        .poll(() => arrangement?.orders.at(-1)?.unboundChannelIds.slice(0, 2))
        .toEqual([one, externalChannelId])

      await touch.hold(list.locator('a[href^="/channels/"]', { hasText: /^示例群 2(?!\d)/u }))
      await touch.sheet.getByRole('button', { name: '上移' }).click()
      await expect.poll(firstThree).toEqual([one, two, externalChannelId])

      // A held agent name offers moving its group; the last group cannot move down.
      const groupHead = (name: string) => list.locator('button[class*="groupHead"]', { hasText: name })
      const groupOrder = () =>
        list
          .locator('button[class*="groupHead"] [class*="groupName"]')
          .evaluateAll((nodes) => nodes.map((node) => node.textContent))
      const before = await groupOrder()
      expect(before).toHaveLength(2)
      await touch.hold(groupHead(before[0] ?? ''))
      await expect(touch.sheet).toHaveAccessibleName(before[0] ?? '')
      await expect(touch.sheet.getByRole('button')).toHaveText(['下移'])
      await touch.sheet.getByRole('button', { name: '下移' }).click()
      await expect.poll(groupOrder).toEqual([before[1], before[0]])
      await expect
        .poll(() => arrangement?.orders.at(-1)?.agentIds)
        .toEqual(
          [...before].reverse().map((name) => crowdedSnapshot.agents.find((agent) => agent.displayName === name)?.id),
        )
      // Letting go of the held name did not open the agent, and a tap still does.
      await expect(page).toHaveURL(/\/channels$/u)
      await groupHead('资料员').tap()
      await expect(page).toHaveURL(new RegExp(`/agents/${targetAgentId}`, 'u'))
      expect(arrangement?.writes).toEqual([])
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  test('on a phone the actions sheet gives a channel to another agent or unbinds it through the confirmation', async () => {
    const { page, errors } = await open('/channels', { width: 393, touch: true })
    try {
      const list = page.getByRole('complementary', { name: '频道', exact: true })
      const touch = await finger(page)
      const row = list.locator(`a[href="/channels/${sourceChannelId}"]`)
      await touch.hold(row)
      // One channel in its group: nothing to move it past.
      await expect(touch.sheet.getByRole('button')).toHaveText(['置顶', '移到其他智能体…', '解除接线'])
      await touch.sheet.getByRole('button', { name: '移到其他智能体…' }).click()
      // The same panel lists the other agents, with a way back.
      await expect(touch.sheet).toHaveAccessibleName('移到其他智能体')
      await expect(touch.sheet.getByRole('button', { name: '资料员' })).toBeVisible()
      await expect(touch.sheet.getByRole('button', { name: '记录员' })).toHaveCount(0)
      await touch.sheet.getByRole('button', { name: '返回' }).click()
      await expect(touch.sheet).toHaveAccessibleName('记录员的内置频道')
      await touch.sheet.getByRole('button', { name: '移到其他智能体…' }).click()
      await touch.sheet.getByRole('button', { name: '资料员' }).click()
      const rebind = page.getByRole('dialog', { name: '让资料员响应「记录员的内置频道」' })
      await expect(rebind).toBeVisible()
      await rebind.getByRole('button', { name: '取消' }).click()
      await expect(page.getByRole('dialog')).toHaveCount(0)

      // The more button opens the same sheet, for one tap and for screen readers.
      await list.getByRole('button', { name: '记录员的内置频道 的更多操作' }).tap()
      await expect(touch.sheet).toHaveAccessibleName('记录员的内置频道')
      await touch.sheet.getByRole('button', { name: '解除接线' }).click()
      const unbind = page.getByRole('dialog', { name: '断开「记录员的内置频道」与记录员？' })
      await expect(unbind).toBeVisible()
      await unbind.getByRole('button', { name: '取消' }).click()
      await expect(page).toHaveURL(/\/channels$/u)
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  test('on a phone the actions sheet pins, reorders pins and unpins, also from search results', async () => {
    let arrangement: Awaited<ReturnType<typeof serveArrangement>> | undefined
    const { page, errors } = await open('/channels', {
      width: 393,
      touch: true,
      before: async (target) => {
        arrangement = await serveArrangement(target)
      },
    })
    try {
      const list = page.getByRole('complementary', { name: '频道', exact: true })
      const pinned = list.getByRole('group', { name: '置顶' })
      const touch = await finger(page)
      const row = (scope: Locator, id: string) => scope.locator(`a[href="/channels/${id}"]`)

      await touch.hold(row(list, sourceChannelId))
      await touch.sheet.getByRole('button', { name: '置顶', exact: true }).click()
      await expect(row(pinned, sourceChannelId)).toBeVisible()

      // A search result offers the same, for whatever applies to it there.
      const search = list.getByRole('searchbox', { name: '搜索频道' })
      await search.fill('产品')
      await touch.hold(row(list, externalChannelId))
      await expect(touch.sheet.getByRole('button')).toHaveText(['置顶', '接到智能体…'])
      await touch.sheet.getByRole('button', { name: '置顶', exact: true }).click()
      await search.fill('')
      await expect.poll(() => rowIds(pinned)).toEqual([sourceChannelId, externalChannelId])

      // Pinned rows move among the pins only.
      await touch.hold(row(pinned, externalChannelId))
      await expect(touch.sheet.getByRole('button', { name: '下移' })).toHaveCount(0)
      await touch.sheet.getByRole('button', { name: '上移' }).click()
      await expect.poll(() => rowIds(pinned)).toEqual([externalChannelId, sourceChannelId])
      await expect
        .poll(() => arrangement?.saved.at(-1))
        .toEqual({ pinnedChannelIds: [externalChannelId, sourceChannelId], collapsedGroupIds: [] })

      await touch.hold(row(pinned, sourceChannelId))
      await touch.sheet.getByRole('button', { name: '取消置顶' }).click()
      await touch.hold(row(pinned, externalChannelId))
      await touch.sheet.getByRole('button', { name: '取消置顶' }).click()
      await expect(pinned).toHaveCount(0)
      await expect.poll(() => arrangement?.saved.at(-1)).toEqual(emptyView)
      await expect(page).toHaveURL(/\/channels$/u)
      expect(arrangement?.writes).toEqual([])
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  test('on a phone a second tap on an open select closes it and it stays closed', async () => {
    const { page } = await open('/settings/appearance', { width: 393, touch: true })
    try {
      const select = page.getByRole('combobox', { name: '设置分节' })
      await expect(select).toBeVisible()
      const box = await select.boundingBox()
      if (!box) throw new Error('The section select has no box.')
      const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
      await page.touchscreen.tap(at.x, at.y)
      const list = page.getByRole('listbox')
      await expect(list).toBeVisible()
      await page.waitForTimeout(500)
      await page.touchscreen.tap(at.x, at.y)
      await expect(list).toBeHidden()
      await page.waitForTimeout(500)
      await expect(list).toBeHidden()
      // A later tap opens it again.
      await page.touchscreen.tap(at.x, at.y)
      await expect(list).toBeVisible()
    } finally {
      await page.close()
    }
  })

  test('on a phone a conversation opened by its address goes back to the channel list in place', async () => {
    const { page, errors } = await open('/live', { width: 393, touch: true })
    try {
      await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible()
      // Like a notification: the conversation is the next entry, with no list in between.
      await page.evaluate((path) => {
        const state: unknown = history.state
        const index = typeof state === 'object' && state !== null && 'idx' in state ? Number(state.idx) : 0
        history.pushState({ usr: null, key: 'fromlink', idx: index + 1 }, '', path)
        dispatchEvent(new PopStateEvent('popstate'))
      }, `/channels/${externalChannelId}`)
      await expect(page.getByRole('textbox', { name: '消息' })).toBeVisible()
      const length = await page.evaluate(() => history.length)
      await topBar(page).back('返回频道列表').click()
      await expect(page).toHaveURL(/\/channels$/u)
      await expect(page.getByRole('complementary', { name: '频道', exact: true })).toBeVisible()
      // The list took the conversation's place: nothing was added, and back from the list leaves the channels.
      expect(await page.evaluate(() => history.length)).toBe(length)
      await page.goBack()
      await expect(page).toHaveURL(/\/live$/u)
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  test('on a phone the agent list is a page of its own and an agent the level above it', async () => {
    const { page, errors } = await open('/agents', { width: 393, touch: true })
    try {
      const { bar, back } = topBar(page)
      const nav = page.getByRole('navigation', { name: '主导航' })
      const list = page.getByRole('complementary', { name: '智能体', exact: true })
      await expect(list.getByRole('link', { name: /资料员/u })).toBeVisible()
      await page.waitForTimeout(300)
      await expect(page).toHaveURL(/\/agents$/u)
      await expect(bar).toContainText('智能体')
      await expect(page.getByRole('button', { name: '全部智能体' })).toBeHidden()
      await list.getByRole('link', { name: /资料员/u }).click()
      await expect(page).toHaveURL(new RegExp(`/agents/${targetAgentId}$`, 'u'))
      await expect(bar).toContainText('资料员')
      // Other second-level pages keep the bottom bar, with the agents space still selected.
      await expect(nav).toBeVisible()
      await expect(nav.getByRole('link', { name: '智能体', exact: true })).toHaveAttribute('aria-current', 'page')
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
      await back('返回智能体列表').click()
      await expect(page).toHaveURL(/\/agents$/u)
      await expect(list.getByRole('link', { name: /资料员/u })).toBeVisible()
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  test('on a phone a first-level page names its space in the top bar and does not draw the title twice', async () => {
    const { page } = await open('/live', { width: 393, touch: true })
    try {
      const { bar } = topBar(page)
      await expect(bar).toContainText('概览')
      await expect(bar).not.toContainText('NekroNXT')
      await expect(bar.getByRole('button', { name: '搜索' })).toBeVisible()
      const heading = page.getByRole('heading', { level: 1, name: '概览' })
      await expect(heading).toHaveCount(1)
      // Read out, not drawn: clipped to nothing.
      expect(await heading.evaluate((node) => node.getBoundingClientRect().width)).toBeLessThanOrEqual(1)
    } finally {
      await page.close()
    }
  })

  /** The router's index of the entry on screen and how many entries the tab's history holds. */
  const place = (page: Page) =>
    page.evaluate(() => {
      const state: unknown = history.state
      return {
        index: typeof state === 'object' && state !== null && 'idx' in state ? Number(state.idx) : -1,
        length: history.length,
      }
    })

  /**
   * From now on, notes each frame's selected tab, the workbench level it shows and any level transition, and counts
   * the history steps that reach the page's own listeners.
   */
  const watchFrames = (page: Page) =>
    page.evaluate(() => {
      const probe = { frames: [] as string[], pops: 0 }
      Object.assign(window, { framesForTest: probe })
      addEventListener('popstate', () => (probe.pops += 1))
      const sample = () => {
        const tab = document.querySelector('nav[aria-label="主导航"] [aria-current="page"]')?.textContent ?? '-'
        const bench = document.querySelector<HTMLElement>('[data-layout="workbench"]')
        probe.frames.push(
          `${tab} ${bench?.dataset['phonePane'] ?? '-'} ${bench?.dataset['phoneMotion'] ?? '-'} ${location.pathname}`,
        )
        requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
    })
  const watched = (page: Page) =>
    page.evaluate(() => {
      const probe = (window as Window & { framesForTest?: { frames: string[]; pops: number } }).framesForTest
      return { frames: [...new Set(probe?.frames ?? [])], pops: probe?.pops ?? 0 }
    })

  const tap = async (page: Page, name: string) => {
    const point = await bottomBar(page).center(name)
    await page.touchscreen.tap(point.x, point.y)
  }

  test('on a phone the bottom bar switches between tabs without adding history', async () => {
    const { page, errors } = await open('/live', { width: 393, touch: true })
    try {
      const bar = bottomBar(page)
      await expect(bar.item('概览')).toHaveAttribute('aria-current', 'page')
      const start = await place(page)
      for (const [name, path] of [
        ['频道', /\/channels$/u],
        ['智能体', /\/agents$/u],
        ['工坊', /\/workshop$/u],
      ] as const) {
        await tap(page, name)
        await expect(page).toHaveURL(path)
        await expect(bar.item(name)).toHaveAttribute('aria-current', 'page')
      }
      expect(await place(page)).toEqual(start)
      // Nothing of the app's lies behind the first level: back leaves the app instead of returning to a tab.
      await page.goBack()
      await expect(page).toHaveURL('about:blank')
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  test('on a phone a tab switch from an opened agent steps back past it without showing the list', async () => {
    const { page, errors } = await open('/agents', { width: 393, touch: true })
    try {
      const bar = bottomBar(page)
      const list = page.getByRole('complementary', { name: '智能体', exact: true })
      await list.getByRole('link', { name: /资料员/u }).click()
      await expect(page).toHaveURL(new RegExp(`/agents/${targetAgentId}$`, 'u'))
      // Past the push transition and its fallback timer, so the frames below only see the switch.
      await page.waitForTimeout(700)
      await expect(page.locator('[data-layout="workbench"]')).not.toHaveAttribute('data-phone-motion')
      const opened = await place(page)
      expect(opened.index).toBe(1)
      await watchFrames(page)
      await tap(page, '频道')
      await expect(page).toHaveURL(/\/channels$/u)
      await expect(bar.item('频道')).toHaveAttribute('aria-current', 'page')
      await expect(page.getByRole('complementary', { name: '频道', exact: true })).toBeVisible()
      await page.waitForTimeout(200)
      // The channel list took the agent list's entry; the agent stays only as a forward step.
      expect(await place(page)).toEqual({ index: 0, length: opened.length })
      const { frames, pops } = await watched(page)
      // Every frame shows the agent or the channel list, never the agent list in between, and no level slides.
      expect(frames.filter((frame) => frame.startsWith('智能体 list'))).toEqual([])
      expect(frames.filter((frame) => frame.split(' ')[2] !== '-')).toEqual([])
      expect(frames.every((frame) => frame.startsWith('智能体 main - ') || frame.startsWith('频道 list - '))).toBe(true)
      // The step back never reached the router.
      expect(pops).toBe(0)
      await page.goBack()
      await expect(page).toHaveURL('about:blank')
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  test('on a phone a tab switch two pages deep into a tab still lands on one entry', async () => {
    const { page, errors } = await open('/agents', { width: 393, touch: true })
    try {
      const list = page.getByRole('complementary', { name: '智能体', exact: true })
      await list.getByRole('link', { name: /资料员/u }).click()
      await expect(page).toHaveURL(new RegExp(`/agents/${targetAgentId}$`, 'u'))
      // Another agent from the palette: a second page inside the same tab.
      await page.keyboard.press('Control+k')
      const palette = page.getByRole('dialog')
      await palette.getByRole('combobox', { name: '搜索' }).fill('记录员')
      await palette
        .getByRole('option', { name: /记录员/u })
        .filter({ hasNotText: '内置频道' })
        .first()
        .click()
      await expect(page).toHaveURL(new RegExp(`/agents/${sourceAgentId}$`, 'u'))
      await expect(page.getByRole('dialog')).toHaveCount(0)
      expect((await place(page)).index).toBe(2)
      // The palette's scrim fades out after the dialog has gone and would take the tap.
      await expect(page.locator('[class*="scrim"]')).toHaveCount(0)
      await watchFrames(page)
      await tap(page, '工坊')
      await expect(page).toHaveURL(/\/workshop$/u)
      await expect(bottomBar(page).item('工坊')).toHaveAttribute('aria-current', 'page')
      await page.waitForTimeout(200)
      expect((await place(page)).index).toBe(0)
      const { frames, pops } = await watched(page)
      expect(frames.filter((frame) => frame.startsWith('智能体 list'))).toEqual([])
      expect(pops).toBe(0)
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  test('on a phone a drag along the bottom bar and the “更多” menu switch tabs in place as well', async () => {
    const { page, errors } = await open('/agents', { width: 393, touch: true })
    try {
      const bar = bottomBar(page)
      const list = page.getByRole('complementary', { name: '智能体', exact: true })
      await list.getByRole('link', { name: /资料员/u }).click()
      await expect(page).toHaveURL(new RegExp(`/agents/${targetAgentId}$`, 'u'))
      await bar.drag('智能体', await bar.center('工坊'))
      await page.mouse.up()
      await expect(page).toHaveURL(/\/workshop$/u)
      expect((await place(page)).index).toBe(0)

      await tap(page, '更多')
      const menu = page.getByRole('menu', { name: '更多' })
      await menu.getByRole('menuitem', { name: '接线' }).click()
      await expect(page).toHaveURL(/\/wiring/u)
      await expect(bar.item('更多')).toHaveAttribute('aria-current', 'page')
      expect((await place(page)).index).toBe(0)
      await tap(page, '更多')
      await menu.getByRole('menuitem', { name: '设置' }).click()
      // 设置 redirects to its first section; that is still the tab's first level.
      await expect(page).toHaveURL(/\/settings\/models$/u)
      expect((await place(page)).index).toBe(0)
      await tap(page, '概览')
      await expect(page).toHaveURL(/\/live$/u)
      expect((await place(page)).index).toBe(0)
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  test('on a phone the selected tab takes an opened page back to its list', async () => {
    const { page, errors } = await open('/agents', { width: 393, touch: true })
    try {
      const list = page.getByRole('complementary', { name: '智能体', exact: true })
      await list.getByRole('link', { name: /资料员/u }).click()
      await expect(page).toHaveURL(new RegExp(`/agents/${targetAgentId}$`, 'u'))
      const opened = await place(page)
      await tap(page, '智能体')
      await expect(page).toHaveURL(/\/agents$/u)
      await expect(list.getByRole('link', { name: /资料员/u })).toBeVisible()
      // A step back, like the top bar's arrow: the agent is the next entry again, nothing was added.
      expect(await place(page)).toEqual({ index: opened.index - 1, length: opened.length })
      await page.goForward()
      await expect(page).toHaveURL(new RegExp(`/agents/${targetAgentId}$`, 'u'))
      await page.goBack()
      // On the list itself it stays where it is.
      await tap(page, '智能体')
      await page.waitForTimeout(200)
      await expect(page).toHaveURL(/\/agents$/u)
      expect(await place(page)).toEqual({ index: opened.index - 1, length: opened.length })
      // A tap that lands before the opened page is drawn still goes back instead of replacing the page.
      await list.getByRole('link', { name: /资料员/u }).click()
      await tap(page, '智能体')
      await expect(page).toHaveURL(/\/agents$/u)
      await page.waitForTimeout(200)
      expect(await place(page)).toEqual({ index: opened.index - 1, length: opened.length })
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  test('on a phone an agent opened by its address switches tabs in place', async () => {
    for (const [name, path] of [
      ['频道', /\/channels$/u],
      ['智能体', /\/agents$/u],
    ] as const) {
      const { page, errors } = await open(`/agents/${targetAgentId}`, { width: 393, touch: true })
      try {
        await expect(topBar(page).back('返回智能体列表')).toBeVisible()
        const start = await place(page)
        await tap(page, name)
        await expect(page).toHaveURL(path)
        expect(await place(page)).toEqual(start)
        expect(errors).toEqual([])
      } finally {
        await page.close()
      }
    }
  })

  test('on a phone a link into another tab is a step that back returns from', async () => {
    const { page, errors } = await open('/agents', { width: 393, touch: true })
    try {
      const list = page.getByRole('complementary', { name: '智能体', exact: true })
      await list.getByRole('link', { name: /资料员/u }).click()
      await expect(page).toHaveURL(new RegExp(`/agents/${targetAgentId}$`, 'u'))
      await page.getByRole('button', { name: '在频道中对话' }).click()
      await expect(page).toHaveURL(new RegExp(`/channels/${targetChannelId}$`, 'u'))
      expect((await place(page)).index).toBe(2)
      await page.goBack()
      await expect(page).toHaveURL(new RegExp(`/agents/${targetAgentId}$`, 'u'))
      await page.getByRole('button', { name: '查看日志' }).click()
      await expect(page).toHaveURL(/\/logs/u)
      expect((await place(page)).index).toBe(2)
      await page.goBack()
      await expect(page).toHaveURL(new RegExp(`/agents/${targetAgentId}$`, 'u'))
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  test('computers keep each rail switch as a history step', async () => {
    const { page, errors } = await open('/live')
    try {
      const nav = page.getByRole('navigation', { name: '主导航' })
      await expect(nav.getByRole('link', { name: '概览', exact: true })).toHaveAttribute('aria-current', 'page')
      await nav.getByRole('link', { name: '工坊', exact: true }).click()
      await expect(page).toHaveURL(/\/workshop/u)
      await nav.getByRole('link', { name: '接线', exact: true }).click()
      await expect(page).toHaveURL(/\/wiring/u)
      expect((await place(page)).index).toBe(2)
      await page.goBack()
      await expect(page).toHaveURL(/\/workshop/u)
      await page.goBack()
      await expect(page).toHaveURL(/\/live$/u)
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  test('computers keep the channel drawer, header and placeholder', async () => {
    const { page, errors } = await open('/channels', { width: 900 })
    try {
      // The last channel opens by itself; the list is a drawer at this width.
      await expect(page).toHaveURL(/\/channels\/chn_/u)
      await expect(page.getByRole('button', { name: '全部频道' })).toBeVisible()
      const heading = page.getByRole('heading', { level: 1 })
      await expect(heading).toBeVisible()
      expect((await heading.boundingBox())?.width ?? 0).toBeGreaterThan(40)
      await expect(page.getByRole('main').getByRole('button', { name: /透视/u })).toBeVisible()
      await expect(page.getByRole('textbox', { name: '消息' })).toHaveAttribute('placeholder', /，或输入 \/ 执行命令$/u)
      await expect(page.getByRole('button', { name: '添加附件' })).toBeVisible()
      await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible()
      await expect(page.locator('header').first()).toContainText('NekroNXT')
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
