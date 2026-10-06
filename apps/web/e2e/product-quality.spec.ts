import { installSnapshotHealthRoutes } from './fixtures/host-release.js'
import { installWorkspaceRoutes } from './fixtures/workspace.js'
import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { AxeBuilder } from '@axe-core/playwright'
import {
  AuthoringAttemptIdSchema,
  AuthoringTaskIdSchema,
  ExtensionIdSchema,
  ExtensionRevisionIdSchema,
  HostApiContracts,
  type HostApiResponse,
} from '@nekro-nxt/contracts'
import {
  targetAgentId,
  targetChannelId,
  externalChannelId,
  externalConnectionId,
  targetEpisodeId,
  imageAssetId,
  fileAssetId,
  connectionEvents,
  productSnapshot,
  channelMessages,
  internalConnectionId,
  sourceChannelId,
} from './fixtures/product-quality.js'

type Snapshot = HostApiResponse<'snapshot'>

// Every scenario replaces productMetadata; the health endpoint must represent the same synthetic Host.
test.beforeEach(async ({ page }) => {
  await installSnapshotHealthRoutes(page, productSnapshot)
})

const installRuntimeFailureGate = (page: Page): string[] => {
  const failures: string[] = []
  page.on('pageerror', (error) => failures.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(`console.error: ${message.text()}`)
  })
  return failures
}

const installProductRoutes = async (page: Page, snapshot: () => Snapshot = () => productSnapshot): Promise<void> => {
  if (process.env['NEKRO_UI_PERF_CONTENT_VISIBILITY'] === '1') {
    await page.addInitScript(() => {
      document.addEventListener(
        'DOMContentLoaded',
        () => {
          const style = document.createElement('style')
          style.textContent =
            '[data-channel-message-list] [data-nxt-enter-kind="object"] { content-visibility: auto; contain-intrinsic-size: auto 120px; }'
          document.head.append(style)
        },
        { once: true },
      )
    })
  }
  await page.route('**/api/snapshot', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot()) }),
  )
  await installWorkspaceRoutes(page, snapshot)
  await page.route('**/api/channels/*/runtime', (route) => {
    const channelId = new URL(route.request().url()).pathname.split('/')[3]
    const channel = snapshot().channels.find((item) => item.id === channelId)
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        cursor: { epoch: 'fixture', sequence: 0 },
        channelId,
        ...(channel?.boundAgentId === undefined ? {} : { agentId: channel.boundAgentId }),
        phase: channel?.runtimePhase ?? 'idle',
        summary: channel?.boundAgentId ? '智能体当前空闲。' : '尚未绑定智能体。',
        pendingInjectCount: 0,
        ...(channelId === targetChannelId
          ? {
              occupancy: {
                projectedTokens: 46_320,
                contextWindow: 128_000,
                breakdown: { systemTokens: 8_200, toolsTokens: 12_120, messageTokens: 26_000 },
              },
              cache: {
                scope: 'episode',
                aggregate: {
                  usageRequestCount: 4,
                  observedRequestCount: 4,
                  shareRequestCount: 4,
                  hitRequestCount: 3,
                  uncachedInputTokens: 16_600,
                  cacheReadTokens: 46_400,
                  cacheWriteTokens: 1_000,
                  averageRequestReadShare: 0.68,
                },
                recent: {
                  windowSize: 12,
                  samples: [
                    { turn: 1, step: 1, uncachedInputTokens: 4_000, cacheReadTokens: 6_000 },
                    { turn: 2, step: 1, uncachedInputTokens: 2_400, cacheReadTokens: 12_400 },
                    { turn: 3, step: 1, uncachedInputTokens: 9_000, cacheReadTokens: 0, cacheWriteTokens: 1_000 },
                    { turn: 4, step: 1, uncachedInputTokens: 1_200, cacheReadTokens: 28_000 },
                  ],
                },
              },
            }
          : {}),
        turns: [],
      }),
    })
  })
  await page.route('**/api/channels/*/messages?*', (route) => {
    const channelId = new URL(route.request().url()).pathname.split('/').at(-2)
    const messages = channelMessages.filter((message) => message.channelId === channelId)
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ cursor: { epoch: 'fixture', sequence: 0 }, messages, hasMore: false }),
    })
  })
  await page.route('**/api/connections/*/events?*', (route) => {
    const url = new URL(route.request().url())
    const connectionId = url.pathname.split('/')[3]
    const older = url.searchParams.has('beforeId')
    const events = connectionId === externalConnectionId ? connectionEvents.slice(older ? 30 : 0, older ? 35 : 30) : []
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ events, hasMore: connectionId === externalConnectionId && !older }),
    })
  })
  await page.route('**/api/dynamic/*/inventory', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ rows: [] }) }),
  )
  await page.route('**/api/platform-users*', (route) => {
    const url = new URL(route.request().url())
    const query = (url.searchParams.get('query') ?? '').toLocaleLowerCase('zh-CN')
    const adapterKey = url.searchParams.get('adapterKey') ?? ''
    const connectionId = url.searchParams.get('connectionId') ?? ''
    const allItems = Array.from({ length: 12 }, (_, index) => ({
      identityId: `pid_visualmember${index + 1}`,
      displayName:
        index === 0 ? '成员甲' : index === 1 ? '一位名称很长但仍需要保持行布局稳定的平台成员' : `示例成员 ${index + 1}`,
      adapter: {
        key: index < 9 ? 'fixture-beta' : 'fixture-alpha',
        displayName: index < 9 ? '示例群聊平台' : '内置频道',
      },
      connection: {
        id: index < 9 ? externalConnectionId : internalConnectionId,
        displayName: index < 9 ? '社群运营账号' : '当前设备',
      },
      activeChannelCount: index === 11 ? 0 : (index % 4) + 1,
      channelPreview:
        index === 11
          ? []
          : [
              { id: externalChannelId, displayName: '产品讨论群', kind: 'group' as const },
              ...(index % 2 === 0
                ? [{ id: targetChannelId, displayName: '资料员的内置频道', kind: 'internal' as const }]
                : []),
            ],
      historicalOnly: index === 11,
    }))
    const items = allItems.filter(
      (item) =>
        (!query || item.displayName.toLocaleLowerCase('zh-CN').includes(query)) &&
        (!adapterKey || item.adapter.key === adapterKey) &&
        (!connectionId || item.connection.id === connectionId),
    )
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        total: items.length,
        items,
        facets: {
          adapters: [
            { key: 'fixture-beta', displayName: '示例群聊平台', userCount: 9 },
            { key: 'fixture-alpha', displayName: '内置频道', userCount: 3 },
          ],
          connections: [
            { id: externalConnectionId, adapterKey: 'fixture-beta', displayName: '社群运营账号', userCount: 9 },
            { id: internalConnectionId, adapterKey: 'fixture-alpha', displayName: '当前设备', userCount: 3 },
          ],
        },
      }),
    })
  })
  await page.route(`**/api/channels/*/assets/${imageAssetId}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'image/svg+xml',
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="180" viewBox="0 0 360 180">
        <rect width="360" height="180" rx="16" fill="#e2e8f2"/>
        <rect x="24" y="24" width="312" height="32" rx="8" fill="#3fb1ea" opacity=".22"/>
        <rect x="24" y="76" width="196" height="16" rx="8" fill="#466394" opacity=".42"/>
        <rect x="24" y="108" width="268" height="12" rx="6" fill="#466394" opacity=".2"/>
        <rect x="24" y="136" width="232" height="12" rx="6" fill="#b98c4a" opacity=".24"/>
      </svg>`,
    }),
  )
  await page.route(`**/api/channels/*/assets/${fileAssetId}`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/plain; charset=utf-8', body: '资源下载正常' }),
  )
}

const SPACES = [
  { path: '/live', heading: '现场' },
  { path: `/channels/${targetChannelId}`, heading: '资料员的内置频道' },
  { path: `/agents/${targetAgentId}`, heading: '资料员' },
  { path: '/workshop', heading: null },
  { path: `/wiring/connections/${externalConnectionId}`, heading: '接线' },
  { path: '/settings/adapters', heading: '平台适配器' },
] as const

/** No horizontal page scroll, the shell fills the viewport, and the primary navigation is reachable. */
const assertViewportIntegrity = async (page: Page): Promise<void> => {
  const geometry = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
  }))
  expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth)
  expect(geometry.bodyWidth).toBeLessThanOrEqual(geometry.viewportWidth)
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible()
  await expect(page.getByRole('button', { name: '搜索' })).toBeVisible()
}

/** Masks for values that change with the wall clock. */
const clockMasks = (page: Page) => [page.locator('[class*="statusClock"]')]

const settle = async (page: Page): Promise<void> => {
  await page.evaluate(() => document.fonts.ready)
  // Theme cross-fades and entry animations change computed colors while they run.
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every((animation) => animation.playState !== 'running' || animation.effect?.getTiming().iterations === Infinity),
  )
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      }),
  )
}

const capture = async (page: Page, testInfo: TestInfo, name: string): Promise<void> => {
  const path = testInfo.outputPath(`${name}.png`)
  await page.screenshot({ path, animations: 'disabled' })
  await testInfo.attach(name, { path, contentType: 'image/png' })
}

const taskId = AuthoringTaskIdSchema.parse('aut_QUALITYTASK')
const firstAttemptId = AuthoringAttemptIdSchema.parse('aua_QUALITYFIRST')
const secondAttemptId = AuthoringAttemptIdSchema.parse('aua_QUALITYSECOND')
const savedExtensionId = ExtensionIdSchema.parse('ext_qualitysaved')
const savedRevisionId = ExtensionRevisionIdSchema.parse('xrv_qualitysaved')

const attempt = (id: string, ordinal: number, state: string, extra: Record<string, unknown> = {}) => ({
  id,
  ordinal,
  name: '群聊摘要卡片',
  purpose: '把当前讨论整理成可继续跟进的摘要。',
  state,
  riskDigest: 'a'.repeat(64),
  host: { status: 'running', waitingFor: [] },
  client: { status: 'absent', waitingFor: [] },
  createdAt: 1_725_000_000_000 + ordinal * 1_000,
  ...extra,
})

/** A creation task whose candidate passed verification, plus an earlier verified attempt that can be restored. */
const authoringSnapshot = (status: 'ready' | 'repairing' | 'completed'): Snapshot =>
  HostApiContracts.snapshot.parseResponse({
    ...productSnapshot,
    // An agent still settling its turn blocks save and restore; this scenario starts after it went idle.
    agents: productSnapshot.agents.map((agent) => ({ ...agent, runtimeStatus: 'idle', runtimePhase: 'idle' })),
    authoringTasks: [
      {
        id: taskId,
        agentId: targetAgentId,
        channelId: targetChannelId,
        episodeId: targetEpisodeId,
        title: '群聊摘要卡片',
        requirementSummary: '在频道里把讨论整理成摘要卡片。',
        status,
        approvalPolicy: 'risk-stable',
        // The Host bumps the revision on every change; the page refetches task detail when it moves.
        revision: status === 'repairing' ? 3 : status === 'ready' ? 4 : 5,
        candidateAttempt:
          status === 'repairing'
            ? attempt(secondAttemptId, 2, 'failed', {
                error: { phase: 'verification', message: '摘要结果缺少标题。', repairable: true },
              })
            : attempt(firstAttemptId, 1, 'active'),
        activeAttempt: attempt(firstAttemptId, 1, 'active'),
        verifiedAttempt: attempt(firstAttemptId, 1, 'active'),
        createdAt: 1_725_000_000_000,
        updatedAt: 1_725_000_005_000,
      },
    ],
    extensions:
      status === 'completed'
        ? [
            ...productSnapshot.extensions,
            {
              id: savedExtensionId,
              slug: 'group-digest-card',
              displayName: '群聊摘要卡片',
              description: '',
              createdByAgentId: targetAgentId,
              scope: 'agent',
              revisions: [
                {
                  id: savedRevisionId,
                  revisionNumber: 1,
                  createdAt: 1_725_000_006_000,
                  scope: 'agent',
                  contributions: [],
                },
              ],
              activations: [],
              clientDiagnostics: [],
            },
          ]
        : productSnapshot.extensions,
  })

test('writes the four public product screenshots from fictional production data', async ({ page }) => {
  const outputDirectory = process.env['NEKRO_BRAND_SCREENSHOT_DIR']
  test.skip(!outputDirectory, 'Only runs when refreshing committed public screenshots.')
  const failures = installRuntimeFailureGate(page)
  let snapshot = productSnapshot
  await installProductRoutes(page, () => snapshot)
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 1440, height: 900 })

  await page.goto(`/channels/${targetChannelId}`)
  await expect(page.getByRole('heading', { name: '资料员的内置频道' })).toBeVisible()
  await settle(page)
  await page.screenshot({ path: `${outputDirectory}/channel-conversation.png`, animations: 'disabled' })

  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto(`/agents/${targetAgentId}`)
  await expect(page.getByRole('heading', { name: '资料员', exact: true })).toBeVisible()
  await settle(page)
  await page.screenshot({ path: `${outputDirectory}/agent-workbench.png`, animations: 'disabled' })

  await page.goto(`/wiring/connections/${externalConnectionId}`)
  await expect(page.getByRole('heading', { name: '接线', level: 1 })).toBeVisible()
  await settle(page)
  await page.screenshot({ path: `${outputDirectory}/connections.png`, animations: 'disabled' })

  snapshot = authoringSnapshot('ready')
  await page.route(`**/api/authoring/tasks/${taskId}`, (route) =>
    route.fulfill({
      json: { task: snapshot.authoringTasks[0], attempts: [attempt(firstAttemptId, 1, 'active')], events: [] },
    }),
  )
  await page.goto(`/workshop/tasks/${taskId}`)
  await expect(page.getByRole('heading', { name: '群聊摘要卡片', level: 1 })).toBeVisible()
  await settle(page)
  await page.screenshot({ path: `${outputDirectory}/creator-workbench.png`, animations: 'disabled' })
  expect(failures, failures.join('\n')).toEqual([])
})

test('three desktop viewports keep every space usable in both themes and with reduced motion', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000)
  const failures = installRuntimeFailureGate(page)
  await installProductRoutes(page)
  for (const viewport of [
    { width: 1100, height: 720 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
  ]) {
    for (const theme of ['light', 'dark'] as const) {
      await page.setViewportSize(viewport)
      await page.emulateMedia({
        colorScheme: theme,
        reducedMotion: viewport.width === 1440 ? 'reduce' : 'no-preference',
      })
      await page.addInitScript((value) => window.localStorage.setItem('nekro-nxt.theme', value), theme)
      for (const space of SPACES) {
        await page.goto(space.path)
        if (space.heading) await expect(page.getByRole('heading', { name: space.heading, level: 1 })).toBeVisible()
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
        await assertViewportIntegrity(page)
      }
      await capture(page, testInfo, `settings-${viewport.width}-${theme}`)
    }
  }
  expect(failures, failures.join('\n')).toEqual([])
})

test('representative product surfaces match committed visual baselines', async ({ page }) => {
  test.setTimeout(120_000)
  const failures = installRuntimeFailureGate(page)
  let snapshot = productSnapshot
  await installProductRoutes(page, () => snapshot)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 1440, height: 900 })
  // Fixed wall clock: relative times and the activity window render identically on every run.
  await page.clock.setFixedTime(new Date(1_725_000_060_000))
  const shoot = async (name: string, path: string, theme: 'light' | 'dark', ready: () => Promise<void>) => {
    await page.addInitScript((value) => window.localStorage.setItem('nekro-nxt.theme', value), theme)
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
    await page.goto(path)
    await ready()
    await settle(page)
    await expect(page).toHaveScreenshot(`${name}-${theme}-1440.png`, {
      animations: 'disabled',
      caret: 'hide',
      mask: clockMasks(page),
      maxDiffPixelRatio: 0.01,
    })
  }
  await shoot('live', '/live', 'light', () => expect(page.getByRole('heading', { name: '现场' })).toBeVisible())
  await shoot('channel-conversation', `/channels/${targetChannelId}`, 'light', async () => {
    await expect(page.getByText('这是本次交付的资源。')).toBeVisible()
    await expect(page.getByRole('img', { name: '界面预览图' })).toBeVisible()
  })
  await shoot('group-conversation', `/channels/${externalChannelId}`, 'dark', () =>
    expect(page.getByText('一起复核。')).toBeVisible(),
  )
  await shoot('agent-profile', `/agents/${targetAgentId}`, 'light', () =>
    expect(page.getByRole('heading', { name: '资料员', exact: true })).toBeVisible(),
  )
  await shoot('wiring', `/wiring/connections/${externalConnectionId}`, 'dark', () =>
    expect(
      page.getByRole('complementary', { name: '详情' }).getByRole('heading', { name: '示例群聊平台' }),
    ).toBeVisible(),
  )
  snapshot = authoringSnapshot('ready')
  await page.route(`**/api/authoring/tasks/${taskId}`, (route) =>
    route.fulfill({
      json: { task: snapshot.authoringTasks[0], attempts: [attempt(firstAttemptId, 1, 'active')], events: [] },
    }),
  )
  await shoot('workshop-task', `/workshop/tasks/${taskId}`, 'dark', () =>
    expect(page.getByRole('heading', { name: '群聊摘要卡片', level: 1 })).toBeVisible(),
  )
  await shoot('settings-notifications', '/settings/notifications', 'light', () =>
    expect(page.getByRole('switch', { name: '系统通知' })).toBeVisible(),
  )
  expect(failures, failures.join('\n')).toEqual([])
})

test('every space and the command palette have no serious accessibility violations', async ({ page }) => {
  test.setTimeout(120_000)
  const failures = installRuntimeFailureGate(page)
  await installProductRoutes(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  const audit = async (label: string) => {
    await settle(page)
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
    const serious = result.violations
      .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
      .map(
        (violation) => `${label}: ${violation.id} ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
      )
    expect(serious, serious.join('\n')).toEqual([])
  }
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
    await page.addInitScript((value) => window.localStorage.setItem('nekro-nxt.theme', value), theme)
    for (const space of SPACES) {
      await page.goto(space.path)
      if (space.heading) await expect(page.getByRole('heading', { name: space.heading, level: 1 })).toBeVisible()
      await audit(`${theme} ${space.path}`)
    }
  }
  await page.keyboard.press('ControlOrMeta+k')
  await expect(page.getByRole('combobox', { name: '搜索' })).toBeFocused()
  await audit('palette')
  expect(failures, failures.join('\n')).toEqual([])
})

test('the command palette searches and navigates by keyboard and returns focus on Escape', async ({ page }) => {
  const failures = installRuntimeFailureGate(page)
  await installProductRoutes(page)
  await page.goto('/live')
  const trigger = page.getByRole('button', { name: '搜索' })
  await trigger.click()
  const input = page.getByRole('combobox', { name: '搜索' })
  await expect(input).toBeFocused()
  await input.fill('产品讨论')
  await expect(page.getByRole('option', { name: /产品讨论群/u })).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(new RegExp(`/channels/${externalChannelId}$`, 'u'))
  await expect(input).toHaveCount(0)

  await page.keyboard.press('ControlOrMeta+k')
  await input.fill('资料员')
  const options = page.getByRole('option')
  await expect(options.first()).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ArrowDown')
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Escape')
  await expect(input).toHaveCount(0)
  await expect(page).toHaveURL(new RegExp(`/channels/${externalChannelId}$`, 'u'))

  await trigger.click()
  await page.keyboard.press('Escape')
  await expect(trigger).toBeFocused()
  expect(failures, failures.join('\n')).toEqual([])
})

test('the composer sends with Enter, keeps Shift+Enter for a new line and binds a pending send to its channel', async ({
  page,
}) => {
  const failures = installRuntimeFailureGate(page)
  await installProductRoutes(page)
  const sent: { channelId: string; body: unknown }[] = []
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/channels/*/messages', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    const channelId = new URL(route.request().url()).pathname.split('/')[3]!
    sent.push({ channelId, body: route.request().postDataJSON() })
    if (sent.length === 2) await held
    return route.fulfill({ json: { inserted: true } })
  })
  await page.goto(`/channels/${targetChannelId}`)
  const input = page.getByRole('textbox', { name: '消息' })
  await input.fill('第一行')
  await input.press('Shift+Enter')
  await input.pressSequentially('第二行')
  await expect(input).toHaveValue('第一行\n第二行')
  await input.press('Enter')
  await expect.poll(() => sent.length).toBe(1)
  await expect(input).toHaveValue('')

  await input.fill('慢速发送的草稿')
  await input.press('Enter')
  await expect.poll(() => sent.length).toBe(2)
  // Switch channels inside the app while the send is still in flight.
  const list = page.getByRole('complementary', { name: '频道', exact: true })
  await list.getByRole('button', { name: /记录员的内置频道/u }).click()
  await expect(page).toHaveURL(new RegExp(`/channels/${sourceChannelId}$`, 'u'))
  await expect(page.getByRole('textbox', { name: '消息' })).toHaveValue('')
  release()
  await list.getByRole('button', { name: /资料员的内置频道/u }).click()
  await expect(page).toHaveURL(new RegExp(`/channels/${targetChannelId}$`, 'u'))
  await expect(page.getByRole('textbox', { name: '消息' })).toHaveValue('')
  expect(sent.map((item) => item.channelId)).toEqual([targetChannelId, targetChannelId])
  expect(failures, failures.join('\n')).toEqual([])
})

test('long history stays above a growing multiline composer and an empty channel says so', async ({ page }) => {
  const failures = installRuntimeFailureGate(page)
  await installProductRoutes(page)
  const history = Array.from({ length: 80 }, (_, index) => ({
    id: `evt_history${index}`,
    channelId: targetChannelId,
    role: 'member',
    parts: [{ type: 'text', text: `虚构历史消息 ${index}` }],
    occurredAt: 1_725_000_000_000 + index * 1_000,
  }))
  await page.route(`**/api/channels/${targetChannelId}/messages?*`, (route) =>
    route.fulfill({ json: { cursor: { epoch: 'fixture', sequence: 0 }, messages: history, hasMore: false } }),
  )
  await page.setViewportSize({ width: 1100, height: 720 })
  await page.goto(`/channels/${targetChannelId}`)
  const last = page.getByText('虚构历史消息 79', { exact: true })
  await expect(last).toBeInViewport()
  const input = page.getByRole('textbox', { name: '消息' })
  await input.fill(Array.from({ length: 6 }, (_, index) => `第 ${index + 1} 行`).join('\n'))
  await expect(last).toBeInViewport()
  const lastBox = await last.boundingBox()
  const inputBox = await input.boundingBox()
  expect(lastBox!.y + lastBox!.height).toBeLessThanOrEqual(inputBox!.y)

  await page.route(`**/api/channels/${externalChannelId}/messages?*`, (route) =>
    route.fulfill({ json: { cursor: { epoch: 'fixture', sequence: 0 }, messages: [], hasMore: false } }),
  )
  await page.goto(`/channels/${externalChannelId}`)
  await expect(page.getByText('还没有消息', { exact: true })).toBeVisible()
  expect(failures, failures.join('\n')).toEqual([])
})

test('group conversations keep sender and mention semantics without exposing internal identities', async ({ page }) => {
  const failures = installRuntimeFailureGate(page)
  await installProductRoutes(page)
  await page.goto(`/channels/${externalChannelId}`)
  const log = page.getByRole('log', { name: '消息记录' })
  await expect(log.getByText('成员甲').first()).toBeVisible()
  await expect(log).toContainText('成员乙')
  await expect(log).toContainText('一起复核。')
  await expect(log.getByRole('img', { name: '讨论截图' })).toBeVisible()
  const text = await page.locator('body').innerText()
  for (const prefix of ['mbr_', 'pid_', 'chn_', 'con_', 'agt_', 'evt_']) expect(text).not.toContain(prefix)
  expect(failures, failures.join('\n')).toEqual([])
})

test('an initial Host failure is explicit and recovers without reloading the page', async ({ page }) => {
  let available = false
  await installProductRoutes(page)
  await page.route('**/api/snapshot', (route) =>
    available
      ? route.fulfill({ json: productSnapshot })
      : route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: '宿主正在启动。' } } }),
  )
  await page.goto('/live')
  const banner = page.locator('[data-host-connection]')
  await expect(banner).toContainText('无法连接')
  await page.evaluate(() => {
    document.documentElement.dataset['hostRecovery'] = 'same-document'
  })
  available = true
  await banner.getByRole('button', { name: '重新连接' }).click()
  await expect(banner).toHaveCount(0)
  await expect(page.getByRole('heading', { name: '现场', level: 1 })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.dataset['hostRecovery'])).toBe('same-document')
})

test('a failed space chunk keeps the shell and the draft and recovers through retry', async ({ page }) => {
  await installProductRoutes(page)
  let failChunks = true
  await page.route('**/assets/agents-space-*.js', (route) => (failChunks ? route.abort('failed') : route.fallback()))
  await page.goto(`/channels/${targetChannelId}`)
  const input = page.getByRole('textbox', { name: '消息' })
  await input.fill('加载失败时保留的草稿')
  await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '智能体' }).click()
  const failure = page.getByRole('alert').filter({ hasText: '这个页面没能加载' })
  await expect(failure).toBeVisible()
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible()
  await expect(page.getByRole('banner')).toContainText('页面未加载')
  failChunks = false
  // A browser keeps a failed module import: the in-place retry fails once more, then the page reloads.
  await failure.getByRole('button', { name: '重试' }).click()
  const reloadButton = page.getByRole('button', { name: '重新加载页面' })
  const heading = page.getByRole('heading', { name: '资料员', exact: true })
  await expect(reloadButton.or(heading)).toBeVisible()
  if (await reloadButton.isVisible()) await reloadButton.click()
  await expect(heading).toBeVisible()
  await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '频道' }).click()
  await expect(page.getByRole('textbox', { name: '消息' })).toHaveValue('加载失败时保留的草稿')
})

test('the minimum window stays reachable at 125% and 150% effective zoom', async ({ page }) => {
  const failures = installRuntimeFailureGate(page)
  await installProductRoutes(page)
  for (const zoom of [1.25, 1.5]) {
    await page.setViewportSize({ width: Math.round(1100 / zoom), height: Math.round(720 / zoom) })
    for (const space of SPACES) {
      await page.goto(space.path)
      await assertViewportIntegrity(page)
    }
    await page.goto(`/channels/${targetChannelId}`)
    await expect(page.getByRole('textbox', { name: '消息' })).toBeInViewport()
  }
  expect(failures, failures.join('\n')).toEqual([])
})

test('long and English object names keep the top bar on one line', async ({ page }) => {
  const failures = installRuntimeFailureGate(page)
  const longName = 'Quarterly Planning Assistant for the Extended Operations Review Group'
  const snapshot = HostApiContracts.snapshot.parseResponse({
    ...productSnapshot,
    agents: productSnapshot.agents.map((agent) =>
      agent.id === targetAgentId ? { ...agent, displayName: longName } : agent,
    ),
    channels: productSnapshot.channels.map((channel) =>
      channel.id === targetChannelId ? { ...channel, displayName: `${longName} 的内置频道` } : channel,
    ),
  })
  await installProductRoutes(page, () => snapshot)
  await page.setViewportSize({ width: 1100, height: 720 })
  const top = page.getByRole('banner')
  await page.goto('/live')
  const height = (await top.boundingBox())!.height
  for (const path of [`/channels/${targetChannelId}`, `/agents/${targetAgentId}`]) {
    await page.goto(path)
    await expect(top).toContainText(longName)
    expect((await top.boundingBox())!.height).toBe(height)
    await assertViewportIntegrity(page)
  }
  expect(failures, failures.join('\n')).toEqual([])
})

test('透视 opens turn details by keyboard and keeps tool input readable', async ({ page }, testInfo) => {
  const failures = installRuntimeFailureGate(page)
  await installProductRoutes(page)
  await page.route(`**/api/channels/${targetChannelId}/runtime`, (route) =>
    route.fulfill({
      json: {
        cursor: { epoch: 'fixture', sequence: 0 },
        channelId: targetChannelId,
        agentId: targetAgentId,
        episodeId: targetEpisodeId,
        phase: 'idle',
        summary: '智能体当前空闲。',
        pendingInjectCount: 0,
        turns: [
          {
            turn: 1,
            state: 'completed',
            producedReply: true,
            responseState: 'sent',
            startedAt: 1_725_000_001_000,
            endedAt: 1_725_000_004_000,
            durationMs: 3_000,
            steps: [
              {
                step: 1,
                tools: [
                  {
                    callId: 'call_quality1',
                    name: 'lookup_records',
                    displayName: '查找记录',
                    state: 'succeeded',
                    durationMs: 820,
                    inputPreview: JSON.stringify({ keyword: '今日记录', limit: 3 }),
                    resultPreview: '找到 3 条虚构记录。',
                  },
                ],
              },
            ],
          },
        ],
      },
    }),
  )
  await page.goto(`/channels/${targetChannelId}`)
  await expect(page.getByText('查找记录').first()).toBeVisible()
  const xray = page.getByRole('button', { name: /透视/u })
  await expect(xray).toHaveAttribute('aria-pressed', 'false')
  await xray.focus()
  await page.keyboard.press('Space')
  await expect(xray).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByText('找到 3 条虚构记录。')).toBeVisible()
  await expect(page.getByText('今日记录')).toBeVisible()
  await expect(page.locator('body')).not.toContainText('"keyword"')
  await capture(page, testInfo, 'xray-open')
  await page.keyboard.press('Enter')
  await expect(xray).toHaveAttribute('aria-pressed', 'false')
  expect(failures, failures.join('\n')).toEqual([])
})

test('dialogs close with Escape, return focus and keep a failed action open with its reason', async ({ page }) => {
  await installProductRoutes(page)
  let fail = true
  await page.route(`**/api/channels/${externalChannelId}`, (route) => {
    if (route.request().method() !== 'DELETE') return route.fallback()
    return fail
      ? route.fulfill({
          status: 409,
          json: { error: { code: 'binding-conflict', message: '频道的响应智能体刚刚变化。' } },
        })
      : route.fulfill({ json: { channelId: externalChannelId, deleted: true } })
  })
  await page.goto(`/channels/${externalChannelId}`)
  const inspector = page.getByRole('complementary', { name: '频道信息' })
  const remove = inspector.getByRole('button', { name: '移除频道' })
  await remove.click()
  const dialog = page.getByRole('dialog', { name: '移除「产品讨论群」？' })
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(remove).toBeFocused()

  await remove.click()
  await dialog.getByRole('button', { name: '移除', exact: true }).click()
  await expect(dialog).toContainText('频道的响应智能体刚刚变化。')
  await expect(dialog).toBeVisible()
  fail = false
  await dialog.getByRole('button', { name: '移除', exact: true }).click()
  await expect(dialog).toBeHidden()
})

test('the trusted Desktop bridge renders the instance entry across sizes and themes', async ({ page }, testInfo) => {
  const failures = installRuntimeFailureGate(page)
  await installProductRoutes(page)
  await page.addInitScript(() => {
    const testWindow = window as Window & { __switcherOpened?: number }
    testWindow.__switcherOpened = 0
    Object.defineProperty(window, 'nekroDesktopShell', {
      configurable: true,
      value: {
        getCurrentInstancePresentation: () =>
          Promise.resolve({ revision: 1, displayName: '远程开发环境', status: 'ready' as const }),
        openInstanceSwitcher: () => {
          testWindow.__switcherOpened = (testWindow.__switcherOpened ?? 0) + 1
          return Promise.resolve()
        },
        closeInstanceSwitcher: () => Promise.resolve(),
        subscribeCurrentInstanceStatus: () => () => undefined,
      },
    })
  })
  for (const scene of [
    { width: 1440, height: 900, theme: 'light' },
    { width: 1100, height: 720, theme: 'dark' },
  ] as const) {
    await page.setViewportSize({ width: scene.width, height: scene.height })
    await page.emulateMedia({ colorScheme: scene.theme, reducedMotion: 'reduce' })
    await page.addInitScript((value) => window.localStorage.setItem('nekro-nxt.theme', value), scene.theme)
    await page.goto('/')
    await expect(page).toHaveURL(/\/live$/u)
    const entry = page.getByRole('button', { name: '管理并添加远程服务实例：远程开发环境 · 运行正常' })
    await expect(entry).toBeVisible()
    await assertViewportIntegrity(page)
    await capture(page, testInfo, `desktop-instance-${scene.width}-${scene.theme}`)
  }
  await page.getByRole('button', { name: /^管理并添加远程服务实例/u }).click()
  await expect
    .poll(() => page.evaluate(() => (window as Window & { __switcherOpened?: number }).__switcherOpened))
    .toBe(1)
  expect(failures, failures.join('\n')).toEqual([])
})

test('the workshop saves the verified candidate, enables it for its agent and can return to an earlier verified attempt', async ({
  page,
}, testInfo) => {
  const failures = installRuntimeFailureGate(page)
  let snapshot = authoringSnapshot('repairing')
  await installProductRoutes(page, () => snapshot)
  const detail = (status: Parameters<typeof authoringSnapshot>[0]) => {
    const task = authoringSnapshot(status).authoringTasks[0]!
    return {
      task,
      attempts: [attempt(firstAttemptId, 1, 'active'), ...(status === 'repairing' ? [task.candidateAttempt] : [])],
      events:
        status === 'completed'
          ? [
              {
                sequence: 4,
                kind: 'task-completed',
                attemptId: firstAttemptId,
                payload: { extensionId: savedExtensionId, revisionId: savedRevisionId },
                createdAt: 1_725_000_006_000,
              },
            ]
          : [],
    }
  }
  let status: Parameters<typeof authoringSnapshot>[0] = 'repairing'
  await page.route(`**/api/authoring/tasks/${taskId}`, (route) => route.fulfill({ json: detail(status) }))
  const restores: unknown[] = []
  await page.route(`**/api/authoring/tasks/${taskId}/attempts/*/restore`, (route) => {
    restores.push({
      attempt: new URL(route.request().url()).pathname.split('/')[6],
      body: HostApiContracts.restoreAuthoringAttempt.parseRequest(route.request().postDataJSON()),
    })
    status = 'ready'
    snapshot = authoringSnapshot('ready')
    return route.fulfill({ json: snapshot.authoringTasks[0] })
  })
  const saves: unknown[] = []
  await page.route('**/api/extensions/save-from-dynamic', (route) => {
    saves.push(route.request().postDataJSON())
    status = 'completed'
    snapshot = authoringSnapshot('completed')
    return route.fulfill({
      status: 201,
      json: { extensionId: savedExtensionId, revisionId: savedRevisionId, activation: 'inactive' },
    })
  })
  const activations: unknown[] = []
  await page.route(`**/api/agents/${targetAgentId}/extensions/${savedExtensionId}/activation`, (route) => {
    activations.push(route.request().postDataJSON())
    snapshot = HostApiContracts.snapshot.parseResponse({
      ...snapshot,
      extensions: snapshot.extensions.map((extension) =>
        extension.id === savedExtensionId
          ? {
              ...extension,
              activations: [
                {
                  agentId: targetAgentId,
                  extensionRevisionId: savedRevisionId,
                  config: {},
                  activatedAt: 1_725_000_007_000,
                },
              ],
            }
          : extension,
      ),
    })
    return route.fulfill({
      json: {
        activation: {
          agentId: targetAgentId,
          extensionId: savedExtensionId,
          extensionRevisionId: savedRevisionId,
          config: {},
          activatedAt: 1_725_000_007_000,
        },
      },
    })
  })

  await page.goto(`/workshop/tasks/${taskId}`)
  await expect(page.getByRole('heading', { name: '群聊摘要卡片', level: 1 })).toBeVisible()
  await expect(page.getByText('结果验证未通过')).toBeVisible()
  await expect(page.getByText('摘要结果缺少标题。').first()).toBeVisible()
  await page.getByRole('button', { name: '回到第 1 次' }).click()
  await expect.poll(() => restores).toEqual([{ attempt: firstAttemptId, body: { expectedRevision: 3 } }])
  await expect(page.getByText('第 1 次候选已通过验证')).toBeVisible()

  await page.getByRole('button', { name: '保存为扩展' }).click()
  const dialog = page.getByRole('dialog', { name: '保存为本地扩展' })
  await expect(dialog.getByLabel('名称')).toHaveValue('群聊摘要卡片')
  await dialog.getByLabel('标识').fill('group-digest-card')
  await capture(page, testInfo, 'workshop-save')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect
    .poll(() => saves)
    .toEqual([
      expect.objectContaining({
        taskId,
        attemptId: firstAttemptId,
        displayName: '群聊摘要卡片',
        slug: 'group-digest-card',
      }),
    ])
  await expect(page.getByText('已保存为「群聊摘要卡片」')).toBeVisible()
  await page.getByRole('button', { name: '给资料员启用' }).click()
  await expect.poll(() => activations.length).toBe(1)
  await expect(page.getByText('资料员正在使用')).toBeVisible()
  await page.getByRole('button', { name: '查看扩展' }).click()
  await expect(page).toHaveURL(new RegExp(`/workshop/extensions/${savedExtensionId}$`, 'u'))
  await expect(page.getByRole('switch', { name: '资料员使用「群聊摘要卡片」' })).toBeChecked()
  expect(failures, failures.join('\n')).toEqual([])
})

test('model settings keep unconfigured providers behind the add flow', async ({ page }) => {
  const failures = installRuntimeFailureGate(page)
  await installProductRoutes(page)
  await page.route('**/api/llm/providers', (route) =>
    route.fulfill({
      json: {
        writable: true,
        protocols: ['openai-completions'],
        providers: [
          {
            provider: 'deepseek',
            displayName: 'deepseek',
            settingsNs: 'llm-pi-ai',
            settingsPath: ['providers', 'deepseek'],
            settingsRevision: 1,
            declared: false,
            active: true,
            configured: true,
            credential: { configured: true, writable: true },
            models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }],
            modelsCustomized: false,
            discoverable: true,
          },
          {
            provider: 'idle-provider',
            displayName: '未配置供应商',
            settingsNs: 'llm-pi-ai',
            settingsPath: ['providers', 'idle-provider'],
            settingsRevision: 1,
            declared: false,
            active: false,
            configured: false,
            credential: { configured: false, writable: true },
            models: [],
            modelsCustomized: false,
            discoverable: true,
          },
        ],
      },
    }),
  )
  await page.goto('/settings/models')
  await expect(page.getByRole('link', { name: /DeepSeek/u })).toBeVisible()
  await expect(page.getByRole('link', { name: /未配置供应商/u })).toHaveCount(0)
  await page.getByRole('button', { name: '添加供应商' }).first().click()
  await expect(page.getByRole('dialog')).toContainText('未配置供应商')
  expect(failures, failures.join('\n')).toEqual([])
})

test('model settings edit a fixed catalog with vision models and restore its defaults', async ({ page }, testInfo) => {
  const failures = installRuntimeFailureGate(page)
  await installProductRoutes(page)
  let saveRequest: unknown
  let restoreRequested = false
  const provider = (customized: boolean) => ({
    provider: 'synthetic-fixed',
    displayName: '固定目录供应商',
    settingsNs: 'llm-deepseek',
    settingsPath: [],
    settingsRevision: 4,
    declared: false,
    active: true,
    configured: true,
    credential: { configured: true, writable: true },
    models: [
      { id: 'synthetic-flash', name: 'Synthetic Flash', contextWindow: 1_000_000, inputModalities: ['text', 'image'] },
      { id: 'synthetic-pro', name: 'Synthetic Pro', contextWindow: 1_000_000, inputModalities: ['text'] },
      ...(customized ? [{ id: 'synthetic-next', name: 'synthetic-next', inputModalities: ['text', 'image'] }] : []),
    ],
    modelsCustomized: customized,
    discoverable: false,
  })
  const body = (customized: boolean) =>
    JSON.stringify({ writable: true, protocols: ['openai-completions'], providers: [provider(customized)] })
  await page.route('**/api/llm/providers', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: body(false) }),
  )
  await page.route('**/api/llm/providers/synthetic-fixed', (route) => {
    saveRequest = route.request().postDataJSON()
    return route.fulfill({ status: 200, contentType: 'application/json', body: body(true) })
  })
  await page.route('**/api/llm/providers/synthetic-fixed/restore-models', (route) => {
    restoreRequested = true
    return route.fulfill({ status: 200, contentType: 'application/json', body: body(false) })
  })

  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/settings/models')
  const table = page.getByRole('table', { name: '模型列表' })
  await expect(table.getByRole('row')).toHaveCount(3)
  await expect(page.getByRole('switch', { name: 'synthetic-flash支持图片输入' })).toBeChecked()
  await expect(page.getByRole('switch', { name: 'synthetic-pro支持图片输入' })).not.toBeChecked()
  await expect(page.getByRole('button', { name: '获取可用模型' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '恢复默认模型' })).toHaveCount(0)

  await page.getByRole('button', { name: '添加模型' }).click()
  await table.getByRole('textbox', { name: '模型 ID' }).last().fill('synthetic-next')
  await page.getByRole('switch', { name: 'synthetic-next支持图片输入' }).click()
  await assertViewportIntegrity(page)
  await capture(page, testInfo, 'model-catalog-editor')
  await page.getByRole('button', { name: '保存供应商' }).click()
  await expect.poll(() => saveRequest).toBeDefined()
  expect(HostApiContracts.llmSaveProvider.request.parse(saveRequest).models).toEqual([
    { id: 'synthetic-flash', name: 'Synthetic Flash', contextWindow: 1_000_000, inputModalities: ['text', 'image'] },
    { id: 'synthetic-pro', name: 'Synthetic Pro', contextWindow: 1_000_000, inputModalities: ['text'] },
    { id: 'synthetic-next', inputModalities: ['text', 'image'] },
  ])

  await expect(page.getByText('已自定义', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '恢复默认模型' }).click()
  await page.getByRole('dialog').getByRole('button', { name: '恢复默认模型' }).click()
  await expect.poll(() => restoreRequested).toBe(true)
  await expect(table.getByRole('row')).toHaveCount(3)
  expect(failures, failures.join('\n')).toEqual([])
})
