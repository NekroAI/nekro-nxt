import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import { AxeBuilder } from '@axe-core/playwright'
import {
  AgentIdSchema,
  AgentRevisionIdSchema,
  AssetIdSchema,
  ChannelEventIdSchema,
  ChannelIdSchema,
  ChannelMemberIdSchema,
  ConnectionIdSchema,
  EpisodeIdSchema,
  ExtensionIdSchema,
  ExtensionRevisionIdSchema,
  HostApiContracts,
  OutboundIntentIdSchema,
} from '@nekro-nxt/contracts'

const targetAgentId = AgentIdSchema.parse('agt_targetinternalid')
const sourceAgentId = AgentIdSchema.parse('agt_sourceinternalid')
const targetRevisionId = AgentRevisionIdSchema.parse('arev_targetinternal')
const sourceRevisionId = AgentRevisionIdSchema.parse('arev_sourceinternal')
const targetChannelId = ChannelIdSchema.parse('chn_target')
const sourceChannelId = ChannelIdSchema.parse('chn_source')
const qqChannelId = ChannelIdSchema.parse('chn_qq')
const webConnectionId = ConnectionIdSchema.parse('con_web')
const qqConnectionId = ConnectionIdSchema.parse('con_qq')
const summaryExtensionId = ExtensionIdSchema.parse('ext_summary')
const summaryRevisionId = ExtensionRevisionIdSchema.parse('xrv_summary')
const targetEpisodeId = EpisodeIdSchema.parse('eps_target')
const visibleEventId = ChannelEventIdSchema.parse('evt_visible')
const qqEventId = ChannelEventIdSchema.parse('evt_qqvisible')
const qqCardEventId = ChannelEventIdSchema.parse('evt_qqcardmsg')
const qqImageEventId = ChannelEventIdSchema.parse('evt_qqimagemsg')
const sentEventId = ChannelEventIdSchema.parse('evt_sent')
const resourceIntentId = OutboundIntentIdSchema.parse('out_resources')
const senderMemberId = ChannelMemberIdSchema.parse('mbr_sender')
const targetMemberId = ChannelMemberIdSchema.parse('mbr_target')
const imageAssetId = AssetIdSchema.parse('ast_image')
const imagePolicy = {
  history: {
    mode: 'persistent-distinct' as const,
    detail: 'auto' as const,
    restoreAfterCompaction: { recentMessages: 32, maxImages: 20 },
  },
  textModel: { mode: 'disabled' as const },
}
const imageDiagnostics = {
  route: { mode: 'direct' as const, provider: 'deepseek', model: 'deepseek-v4-flash' },
  activeSessions: 1,
  residentImages: 6,
  duplicateImagesSkipped: 4,
  lastInspection: {
    mode: 'direct' as const,
    imageCount: 3,
    cacheHit: false,
    usage: { inputTokens: 1280, outputTokens: 220 },
  },
  lastRestoration: {
    compactionId: 'cmp_visual_demo',
    candidateCount: 9,
    restoredCount: 6,
    skippedCount: 3,
  },
  blockers: [],
}
const fileAssetId = AssetIdSchema.parse('ast_file')

const productSnapshot = HostApiContracts.snapshot.response.parse({
  productMetadata: {
    displayName: 'NekroNXT Preview',
    organizationName: 'NekroAI',
    version: '0.0.0-preview',
    releaseId: '0.0.0-visual-review',
    repositoryUrl: 'https://github.com/NekroAI/nekro-nxt',
    licenseSpdx: 'AGPL-3.0-only',
  },
  capabilityAvailability: {
    subagents: { available: true },
    webSearch: {
      provider: 'deepseek-official',
      available: false,
      credentialConfigured: false,
      credentialReference: 'DEEPSEEK_API_KEY',
      maxUsesPerCall: 2,
      maxResultsPerCall: 5,
      timeoutMs: 60_000,
    },
  },
  notificationSettings: {
    system: { enabled: true },
    bark: { enabled: false, serverUrl: 'https://api.day.app', deviceKeyConfigured: false },
    events: { 'dynamic-client-approval-requested': true },
  },
  connectionAdapters: [
    {
      key: 'web',
      displayName: '内置频道',
      description: '内置频道',
      userCreatable: false,
      configSchema: { schemaVersion: 1, type: 'object', required: [], properties: {} },
    },
    {
      key: 'qq-openclaw',
      displayName: 'QQ 官方机器人',
      description: '连接 QQ 机器人账号',
      userCreatable: true,
      configSchema: {
        schemaVersion: 1,
        type: 'object',
        required: ['appId', 'clientSecret'],
        properties: {
          appId: { type: 'string', title: 'App ID' },
          clientSecret: { type: 'credential-reference', title: 'Client Secret' },
          markdown: { type: 'boolean', title: '使用 Markdown', description: '允许发送 Markdown 消息。', default: true },
        },
      },
    },
  ],
  models: [
    {
      provider: 'deepseek',
      providerName: 'deepseek',
      id: 'deepseek-v4-flash',
      name: 'DeepSeek V4 Flash',
      inputModalities: ['text', 'image'],
    },
    {
      provider: 'test-provider',
      providerName: '测试供应商',
      id: 'text-model',
      name: '纯文本模型',
      inputModalities: ['text'],
    },
    {
      provider: 'unknown-provider',
      providerName: '能力未声明供应商',
      id: 'unknown-model',
      name: '能力未声明模型',
    },
  ],
  agents: [
    {
      id: targetAgentId,
      displayName: '资料员',
      persona: '严谨、简洁',
      personaDocument: { version: 1, segments: [{ type: 'text', text: '严谨、简洁' }] },
      currentRevisionId: targetRevisionId,
      createdAt: 1_725_000_000_000,
      runtimeStatus: 'running',
      runtimePhase: 'thinking',
      model: { provider: 'deepseek', model: 'deepseek-v4-flash' },
      dynamicClientApprovalPolicy: 'manual',
      imagePolicy,
      imageDiagnostics,
      capabilities: {
        subagents: false,
        fileTools: false,
        webSearch: false,
        dynamicCreation: true,
        developmentShell: false,
        unrestrictedFileAccess: false,
      },
      channels: [targetChannelId],
    },
    {
      id: sourceAgentId,
      displayName: '记录员',
      persona: '',
      personaDocument: { version: 1, segments: [] },
      currentRevisionId: sourceRevisionId,
      createdAt: 1_725_000_000_100,
      runtimeStatus: 'idle',
      model: { provider: 'deepseek', model: 'deepseek-v4-flash' },
      dynamicClientApprovalPolicy: 'manual',
      imagePolicy,
      imageDiagnostics,
      capabilities: {
        subagents: false,
        fileTools: false,
        webSearch: false,
        dynamicCreation: false,
        developmentShell: false,
        unrestrictedFileAccess: false,
      },
      channels: [sourceChannelId],
    },
  ],
  channels: [
    {
      id: targetChannelId,
      connectionId: webConnectionId,
      platformChannelId: 'platform-target',
      kind: 'web',
      displayName: '资料员的内置频道',
      boundAgentId: targetAgentId,
      bindings: [
        { channelId: targetChannelId, agentId: targetAgentId, triggerPolicy: 'always', boundAt: 1_725_000_000_000 },
      ],
    },
    {
      id: sourceChannelId,
      connectionId: webConnectionId,
      platformChannelId: 'platform-source',
      kind: 'web',
      displayName: '记录员的内置频道',
      boundAgentId: sourceAgentId,
      bindings: [
        { channelId: sourceChannelId, agentId: sourceAgentId, triggerPolicy: 'always', boundAt: 1_725_000_000_100 },
      ],
    },
    {
      id: qqChannelId,
      connectionId: qqConnectionId,
      platformChannelId: 'group:opaqueidab12',
      kind: 'group',
      displayName: '产品讨论群',
      bindings: [],
    },
  ],
  messages: [],
  connections: [
    {
      id: webConnectionId,
      adapterKey: 'web',
      appId: '',
      proactiveSend: false,
      credentialConfigured: true,
      channelCount: 2,
      knownChannels: [],
    },
    {
      id: qqConnectionId,
      adapterKey: 'qq-openclaw',
      appId: '12345678',
      proactiveSend: false,
      credentialConfigured: true,
      channelCount: 1,
      knownChannels: [{ id: qqChannelId, name: 'group:opaqueidab12', kind: 'group' }],
      gateway: { state: 'connected' },
      lastInbound: { channelId: qqChannelId, platformMessageId: 'qq-inbound', receivedAt: 1_725_000_010_000 },
      receiveTest: { status: 'received', channelId: qqChannelId, platformMessageId: 'qq-inbound' },
      sendTest: { status: 'sent', channelId: qqChannelId, platformMessageId: 'qq-outbound' },
    },
  ],
  extensions: [
    {
      id: summaryExtensionId,
      slug: 'group-summary',
      displayName: '群聊摘要',
      description: '把群聊讨论整理为可继续跟进的摘要。',
      createdByAgentId: targetAgentId,
      revisions: [{ id: summaryRevisionId, revisionNumber: 2, createdAt: 1_725_000_000_000, contributions: [] }],
      activations: [
        {
          agentId: targetAgentId,
          extensionRevisionId: summaryRevisionId,
          config: {},
          activatedAt: 1_725_000_000_000,
        },
      ],
      clientDiagnostics: [],
    },
  ],
  dynamic: [
    {
      agentId: targetAgentId,
      episodeId: targetEpisodeId,
      pluginId: 'dynamic-plugin-internal-id',
      packageId: 'dynamic-package-internal-id',
      status: 'running',
      packages: [
        {
          packageId: 'dynamic-package-internal-id',
          name: '动态摘要',
          purpose: '整理当前频道摘要。',
          hasHostHalf: true,
          hasClientHalf: false,
        },
      ],
      policy: { turn: 1, consecutiveFailures: 0, repeatedFingerprintCount: 0 },
    },
  ],
})

const channelMessages = HostApiContracts.listChannelMessages.response.parse({
  messages: [
    {
      id: visibleEventId,
      channelId: targetChannelId,
      role: 'member',
      parts: [{ type: 'text', text: '请复核今天的记录。' }],
      occurredAt: 1_725_000_000_000,
    },
    {
      id: qqEventId,
      channelId: qqChannelId,
      role: 'member',
      sender: { memberId: senderMemberId, displayName: '成员甲' },
      mentionedConnectionAccount: true,
      parts: [
        { type: 'mention', memberId: ChannelMemberIdSchema.parse('mbr_bot'), displayName: '机器人账号' },
        { type: 'text', text: '请和' },
        { type: 'mention', memberId: targetMemberId, displayName: '成员乙' },
        { type: 'text', text: '一起复核。' },
      ],
      occurredAt: 1_725_000_010_000,
    },
    {
      id: qqCardEventId,
      channelId: qqChannelId,
      role: 'member',
      sender: { memberId: senderMemberId, displayName: '成员甲' },
      parts: [
        {
          type: 'rich',
          adapterKey: 'qq-openclaw',
          kind: 'miniapp',
          summary: '示例来源 · 示例分享',
          title: '示例分享',
          source: '示例来源',
          targetUrl: 'https://example.test/share/qq-card',
          previewAssetId: imageAssetId,
        },
      ],
      occurredAt: 1_725_000_015_000,
    },
    {
      id: qqImageEventId,
      channelId: qqChannelId,
      role: 'member',
      sender: { memberId: senderMemberId, displayName: '成员甲' },
      parts: [{ type: 'image', assetId: imageAssetId, alt: '讨论截图' }],
      occurredAt: 1_725_000_016_000,
    },
    {
      id: resourceIntentId,
      channelId: targetChannelId,
      role: 'agent',
      parts: [
        { type: 'text', text: '这是本次交付的资源。' },
        { type: 'image', assetId: imageAssetId, alt: '界面预览图' },
        { type: 'file', assetId: fileAssetId, name: '验收记录.txt' },
      ],
      occurredAt: 1_725_000_020_000,
      deliveryState: 'sent',
    },
  ],
  hasMore: false,
}).messages

const installRuntimeFailureGate = (page: Page): string[] => {
  const failures: string[] = []
  page.on('pageerror', (error) => failures.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(`console.error: ${message.text()}`)
  })
  return failures
}

const installProductRoutes = async (page: Page): Promise<void> => {
  await page.route('**/api/snapshot', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(productSnapshot) }),
  )
  await page.route('**/api/channels/*/runtime', (route) => {
    const channelId = new URL(route.request().url()).pathname.split('/')[3]
    const channel = productSnapshot.channels.find((item) => item.id === channelId)
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
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
      body: JSON.stringify({ messages, hasMore: false }),
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
        key: index < 9 ? 'qq-openclaw' : 'web',
        displayName: index < 9 ? 'QQ 官方机器人' : '内置频道',
      },
      connection: {
        id: index < 9 ? qqConnectionId : webConnectionId,
        displayName: index < 9 ? '社群运营账号' : '当前设备',
      },
      activeChannelCount: index === 11 ? 0 : (index % 4) + 1,
      channelPreview:
        index === 11
          ? []
          : [
              { id: qqChannelId, displayName: '产品讨论群', kind: 'group' as const },
              ...(index % 2 === 0
                ? [{ id: targetChannelId, displayName: '资料员的内置频道', kind: 'web' as const }]
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
            { key: 'qq-openclaw', displayName: 'QQ 官方机器人', userCount: 9 },
            { key: 'web', displayName: '内置频道', userCount: 3 },
          ],
          connections: [
            { id: qqConnectionId, adapterKey: 'qq-openclaw', displayName: '社群运营账号', userCount: 9 },
            { id: webConnectionId, adapterKey: 'web', displayName: '当前设备', userCount: 3 },
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

const assertViewportIntegrity = async (page: Page): Promise<void> => {
  const geometry = await page.evaluate(() => {
    const sidebar = document.querySelector('aside')?.getBoundingClientRect()
    const main = document.querySelector('main')?.getBoundingClientRect()
    const topBar = document.querySelector('[data-window-top-bar]')?.getBoundingClientRect()
    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      mainHeight: main?.height ?? 0,
      topBarHeight: topBar?.height ?? 0,
      overlaps: sidebar && main ? sidebar.right > main.left + 1 : false,
    }
  })
  expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth)
  expect(geometry.bodyWidth).toBeLessThanOrEqual(geometry.viewportWidth)
  expect(geometry.topBarHeight).toBe(48)
  expect(geometry.mainHeight + geometry.topBarHeight).toBeGreaterThanOrEqual(geometry.viewportHeight - 1)
  expect(geometry.overlaps).toBe(false)
}

const capture = async (page: Page, testInfo: TestInfo, name: string): Promise<void> => {
  const path = testInfo.outputPath(`${name}.png`)
  await page.screenshot({ path, animations: 'disabled' })
  await testInfo.attach(name, { path, contentType: 'image/png' })
}

const expectProductMotionSettled = async (page: Page): Promise<void> => {
  await expect(page.locator('html[data-nxt-view-transition]')).toHaveCount(0)
  await expect(page.locator('[data-stage-layer="out"]')).toHaveCount(0)
  const activeLayer = page.locator('[data-stage-layer="in"]').last()
  if ((await activeLayer.count()) > 0) await expect(activeLayer).toHaveCSS('opacity', '1')
}

const expectTabsSettled = async (page: Page): Promise<void> => {
  const indicator = page.locator('[data-nxt-tabs-indicator]').last()
  await expect(indicator).toBeVisible()
  await expect
    .poll(() =>
      indicator.evaluate((element) => element.getAnimations().some((animation) => animation.playState === 'running')),
    )
    .toBe(false)
  await expect
    .poll(() =>
      indicator.evaluate((element) => {
        const activeTab = element.parentElement?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
        if (!activeTab) return Number.POSITIVE_INFINITY
        const indicatorRect = element.getBoundingClientRect()
        const activeRect = activeTab.getBoundingClientRect()
        return Math.max(
          Math.abs(indicatorRect.left - activeRect.left),
          Math.abs(indicatorRect.right - activeRect.right),
        )
      }),
    )
    .toBeLessThanOrEqual(1)
}

test('writes the four public product screenshots from fictional production data', async ({ page }) => {
  const outputDirectory = process.env['NEKRO_BRAND_SCREENSHOT_DIR']
  test.skip(!outputDirectory, 'Only runs when refreshing committed public screenshots.')
  const failures = installRuntimeFailureGate(page)
  await installProductRoutes(page)
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/work/channels/${targetChannelId}`)
  await expect(page.getByRole('heading', { name: '资料员的内置频道' })).toBeVisible()
  await page.screenshot({ path: `${outputDirectory}/channel-conversation.png`, animations: 'disabled' })

  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto(`/work/agents/${targetAgentId}`)
  await expect(page.getByText('主模型原生视觉', { exact: true })).toBeVisible()
  await page.screenshot({ path: `${outputDirectory}/agent-workbench.png`, animations: 'disabled' })

  await page.goto('/connections')
  await page
    .getByRole('link', { name: /QQ 官方机器人/u })
    .first()
    .click()
  await expect(page).toHaveURL(new RegExp(`/connections/${qqConnectionId}$`, 'u'))
  await expectProductMotionSettled(page)
  await expect(page.locator('main').getByRole('heading', { name: 'QQ 官方机器人' })).toBeVisible()
  await page.screenshot({ path: `${outputDirectory}/connections.png`, animations: 'disabled' })

  await page.goto('/work/creator')
  await expect(page.getByText('与资料员协作创造', { exact: true })).toBeVisible()
  await page.screenshot({ path: `${outputDirectory}/creator-workbench.png`, animations: 'disabled' })
  expect(failures, failures.join('\n')).toEqual([])
})

test('about identity stays readable across supported desktop sizes and themes', async ({ page }, testInfo) => {
  const failures = installRuntimeFailureGate(page)
  await installProductRoutes(page)
  for (const viewport of [
    { width: 1100, height: 720 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
  ]) {
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.setViewportSize(viewport)
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
      await page.goto('/settings?tab=about')
      await expect(page.getByRole('heading', { name: 'NekroNXT Preview' })).toBeVisible()
      await expect(page.getByText('0.0.0-visual-review', { exact: true })).toBeVisible()
      await expect(page.getByText('AGPL-3.0-only', { exact: true })).toBeVisible()
      const logo = page.getByRole('img', { name: 'NekroNXT Logo' })
      await expect(logo).toBeVisible()
      await expect.poll(() => logo.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)
      await assertViewportIntegrity(page)
      await capture(page, testInfo, `about-${viewport.width}x${viewport.height}-${colorScheme}`)
    }
  }
  expect(failures, failures.join('\n')).toEqual([])
})

test('notification settings and pending preview states stay legible in the current desktop system', async ({
  page,
}, testInfo) => {
  const failures = installRuntimeFailureGate(page)
  await installProductRoutes(page)
  const pendingDynamic = productSnapshot.dynamic.map((item) => ({
    ...item,
    status: 'awaiting-approval' as const,
    approvalRequestId: 'approval-visual-probe',
  }))
  await page.unroute('**/api/snapshot')
  await page.route('**/api/snapshot', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...productSnapshot, dynamic: pendingDynamic }),
    }),
  )
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })

  await page.goto(`/work/channels/${targetChannelId}`)
  await expect(page.getByText(/正在等待界面预览确认/u)).toBeVisible()
  await expect(page.getByLabel('对象列').getByLabel('有扩展预览等待确认')).toBeVisible()
  await assertViewportIntegrity(page)
  await capture(page, testInfo, 'pending-client-preview-channel-light')

  await page.goto(`/work/agents/${targetAgentId}`)
  const automaticPreviewSwitch = page.getByRole('switch', { name: '自动允许扩展界面预览' })
  await expect(automaticPreviewSwitch).toBeVisible()
  await automaticPreviewSwitch.scrollIntoViewIfNeeded()
  await assertViewportIntegrity(page)
  await capture(page, testInfo, 'automatic-client-preview-policy-light')

  await page.goto('/settings?tab=notifications')
  await expect(page.getByText('系统通知渠道', { exact: true })).toBeVisible()
  await expect(page.getByText('Bark 通知渠道', { exact: true })).toBeVisible()
  await expect(page.getByText('通知项目', { exact: true })).toBeVisible()
  await assertViewportIntegrity(page)
  await capture(page, testInfo, 'notification-settings-light')
  await page.getByText('通知项目', { exact: true }).scrollIntoViewIfNeeded()
  await capture(page, testInfo, 'notification-events-light')

  await page.evaluate(() => window.localStorage.setItem('nekro-nxt.theme', 'dark'))
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await page.reload()
  await expect(page.getByText('系统通知渠道', { exact: true })).toBeVisible()
  await assertViewportIntegrity(page)
  await capture(page, testInfo, 'notification-settings-dark')
  expect(failures, failures.join('\n')).toEqual([])
})

const dragHorizontally = async (page: Page, handle: Locator, deltaX: number): Promise<void> => {
  await handle.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      }),
  )
  const box = await handle.boundingBox()
  if (!box) throw new Error('分隔条没有几何尺寸。')
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + deltaX, y, { steps: 8 })
  await page.mouse.up()
}

test('three desktop viewports remain usable in both themes and reduced motion', async ({ page }, testInfo) => {
  const failures = installRuntimeFailureGate(page)
  await installProductRoutes(page)
  await page.goto('/work')

  for (const viewport of [
    { width: 1100, height: 720 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
  ]) {
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.evaluate((theme) => window.localStorage.setItem('nekro-nxt.theme', theme), colorScheme)
      await page.setViewportSize(viewport)
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
      await page.goto(`/work/channels/${targetChannelId}`)
      await expect(page.getByRole('heading', { name: '资料员的内置频道' })).toBeVisible()
      const titleStatusGeometry = await page.locator('[data-conversation-title]').evaluate((element) => {
        const chip = element.firstElementChild
        const heading = element.querySelector('h1')
        return {
          chipRight: chip?.getBoundingClientRect().right ?? Number.POSITIVE_INFINITY,
          headingLeft: heading?.getBoundingClientRect().left ?? 0,
        }
      })
      expect(titleStatusGeometry.chipRight).toBeLessThan(titleStatusGeometry.headingLeft)
      await expect(page.locator('[data-conversation-header-actions]').getByText('空闲', { exact: true })).toHaveCount(0)
      await expect(page.locator('aside[aria-label="频道"]').getByText('空闲', { exact: true })).toHaveCount(0)
      const headerActionsBox = await page.locator('[data-conversation-header-actions]').boundingBox()
      expect(headerActionsBox?.height ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(36)
      await expect(page.locator('[data-conversation-header-actions] > *').last()).toContainText('会话')
      await expect(page.getByText('请复核今天的记录。')).toBeVisible()
      await expect(page.getByRole('img', { name: '界面预览图' })).toBeVisible()
      await expect(page.getByText('界面预览图', { exact: true })).toHaveCount(0)
      await expect
        .poll(() =>
          page.getByRole('img', { name: '界面预览图' }).evaluate((image: HTMLImageElement) => image.naturalWidth),
        )
        .toBeGreaterThan(0)
      await expect(page.getByText('验收记录.txt', { exact: true })).toBeVisible()
      await expect(page.getByLabel('消息内容')).toBeVisible()
      await expect(page.locator('[role="tabpanel"][data-state="inactive"]')).toHaveCount(0)
      await expect(page.locator('[data-stage-layer="out"]')).toHaveCount(0)
      await expect(page.locator('[data-stage-layer="in"]').last()).toHaveCSS('opacity', '1')
      await expect
        .poll(async () => {
          const canvasBox = await page.locator('[data-channel-canvas-stage]').boundingBox()
          const messageListBox = await page.locator('[data-channel-message-list]').boundingBox()
          return Math.abs((canvasBox?.y ?? 0) - (messageListBox?.y ?? Number.POSITIVE_INFINITY))
        })
        .toBeLessThanOrEqual(1)
      const composerFrame = await page
        .locator('[data-channel-composer]')
        .first()
        .evaluate((element) => {
          const formStyle = getComputedStyle(element)
          const inputStyle = getComputedStyle(element.querySelector('textarea')!)
          return {
            formBorder: Number.parseFloat(formStyle.borderTopWidth),
            inputBorder: Number.parseFloat(inputStyle.borderTopWidth),
            inputBackground: inputStyle.backgroundColor,
            formBackground: formStyle.backgroundColor,
          }
        })
      expect(composerFrame.formBorder).toBeGreaterThan(0)
      expect(composerFrame.inputBorder).toBe(0)
      expect(composerFrame.inputBackground).toBe('rgba(0, 0, 0, 0)')
      await expect(page.getByText('发给智能体', { exact: true })).toHaveCount(1)
      const sendButton = page.getByRole('button', { name: '发送给智能体' })
      expect(await sendButton.innerText()).toBe('')
      const composerBox = await page.locator('[data-channel-composer]').first().boundingBox()
      const infoBox = await page.getByRole('img', { name: '发送方式说明' }).boundingBox()
      const modeBox = await page.getByText('发给智能体', { exact: true }).boundingBox()
      const sendBox = await sendButton.boundingBox()
      expect(infoBox?.x ?? Number.POSITIVE_INFINITY).toBeLessThan(modeBox?.x ?? 0)
      expect(sendBox?.width ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(30.5)
      expect(
        (composerBox?.x ?? 0) + (composerBox?.width ?? 0) - ((sendBox?.x ?? 0) + (sendBox?.width ?? 0)),
      ).toBeLessThanOrEqual(16)
      const memberContent = page
        .locator('article[data-side="right"]')
        .filter({ hasText: '请复核今天的记录。' })
        .locator(':scope > div')
        .last()
      const agentContent = page
        .locator('article[data-side="left"]')
        .filter({ hasText: '这是本次交付的资源。' })
        .locator(':scope > div')
        .last()
      expect((await memberContent.boundingBox())?.x).toBeGreaterThan((await agentContent.boundingBox())?.x ?? 0)
      const bubbleSurfaces = await Promise.all(
        [memberContent, agentContent].map((content) =>
          content.locator('[data-message-bubble]').evaluate((element) => {
            const style = getComputedStyle(element)
            return {
              background: style.backgroundColor,
              border: style.borderTopColor,
              radius: style.borderRadius,
              padding: style.padding,
              marginTop: style.marginTop,
              fontSize: style.fontSize,
              lineHeight: style.lineHeight,
            }
          }),
        ),
      )
      expect(bubbleSurfaces[0]).toEqual(bubbleSurfaces[1])
      const lastMessage = page.locator('article').last()
      const composer = page.locator('[data-channel-composer]').first()
      await lastMessage.scrollIntoViewIfNeeded()
      const lastMessageBox = await lastMessage.boundingBox()
      const composerBoxAfterScroll = await composer.boundingBox()
      expect((lastMessageBox?.y ?? 0) + (lastMessageBox?.height ?? 0)).toBeLessThanOrEqual(
        (composerBoxAfterScroll?.y ?? 0) - 24,
      )
      const hierarchy = await page.evaluate(() => {
        const parentName = [...document.querySelectorAll('strong')].find((node) => node.textContent === '资料员')
        const parent = parentName?.closest('a')
        const child = [...document.querySelectorAll('a')].find((node) => node.textContent?.includes('资料员的内置频道'))
        const group = child?.closest('section')
        return {
          parentLeft: parent?.getBoundingClientRect().left ?? 0,
          childLeft: child?.getBoundingClientRect().left ?? 0,
          guide: group ? getComputedStyle(group, '::before').content : 'none',
        }
      })
      expect(hierarchy.childLeft).toBeGreaterThan(hierarchy.parentLeft)
      expect(hierarchy.guide).not.toBe('none')
      const cacheAnalysis = page.getByLabel('缓存分析')
      await expect(cacheAnalysis).toBeVisible()
      await expect(cacheAnalysis).toContainText('最近一次输入缓存覆盖')
      await expect(cacheAnalysis).toContainText('96%')
      await expect(cacheAnalysis).toContainText('会话加权覆盖')
      await expect(cacheAnalysis).toContainText('数据覆盖 4/4 次请求')
      await expect(page.getByLabel('最近 4 次模型请求的缓存读取趋势')).toBeVisible()
      const cacheFrame = page.locator('[data-runtime-data-surface="cache"]')
      await expect(cacheFrame).toBeVisible()
      expect(
        await cacheFrame.evaluate((element) => {
          const style = getComputedStyle(element)
          return [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth]
        }),
      ).toEqual(['0px', '0px', '0px', '0px'])
      await assertViewportIntegrity(page)
      if (colorScheme === 'dark') {
        const semanticTokens = await page.evaluate(() => {
          const styles = getComputedStyle(document.documentElement)
          return {
            warning: styles.getPropertyValue('--nxt-warning-soft').trim(),
            success: styles.getPropertyValue('--nxt-success-soft').trim(),
            danger: styles.getPropertyValue('--nxt-danger-soft').trim(),
          }
        })
        expect(semanticTokens).toEqual({ warning: '#332711', success: '#112d22', danger: '#35191c' })
      }
      if (viewport.width === 1440 && colorScheme === 'dark') {
        await page.getByRole('img', { name: '发送方式说明' }).hover()
        const composerTooltip = page.getByRole('tooltip')
        await expect(composerTooltip).toBeVisible()
        const floatingLayers = await page.evaluate(() => ({
          composer: Number(getComputedStyle(document.querySelector('[data-channel-composer]')!).zIndex),
          tooltip: Number(getComputedStyle(document.querySelector('[role="tooltip"]')!).zIndex),
        }))
        expect(floatingLayers.tooltip).toBeGreaterThan(floatingLayers.composer)

        const ring = page.locator('figure[aria-label="上下文占用"] svg')
        const ringBox = await ring.boundingBox()
        if (!ringBox) throw new Error('上下文环图没有几何尺寸。')
        await page.mouse.move(ringBox.x + 76, ringBox.y + 21)
        const chartTooltip = page.locator('figure[aria-label="上下文占用"] [role="tooltip"]')
        await expect(chartTooltip).toBeVisible()
        await expect(chartTooltip).toContainText(/36%|64%/u)
        await expect(chartTooltip).toHaveAttribute('data-pointer-x', '76')
        await page.mouse.move(ringBox.x + 94, ringBox.y + 40)
        await expect(chartTooltip).toHaveAttribute('data-pointer-x', '94')
        await expect(chartTooltip).toHaveCSS('left', '94px')
        const chartSurface = await chartTooltip.evaluate((element) => {
          const style = getComputedStyle(element)
          return { background: style.backgroundColor, radius: Number.parseFloat(style.borderRadius) }
        })
        expect(chartSurface.background).not.toBe('rgb(255, 255, 255)')
        expect(chartSurface.radius).toBeGreaterThanOrEqual(8)
        await expect(page.locator('figure[aria-label="上下文占用"] [class*="contextSectorActive"]')).toHaveCount(1)
        expect(await ring.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe('none')
      }
      await capture(page, testInfo, `channel-${viewport.width}x${viewport.height}-${colorScheme}`)
    }
  }

  expect(failures, failures.join('\n')).toEqual([])
})

test('platform-user directory and persona references remain legible across desktop states', async ({
  page,
}, testInfo) => {
  const failures = installRuntimeFailureGate(page)
  await installProductRoutes(page)
  await page.addInitScript(() => window.localStorage.setItem('nekro-nxt.reduced-motion', 'true'))
  await page.goto('/users')
  for (const viewport of [
    { width: 1100, height: 720 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
  ]) {
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.evaluate((theme) => window.localStorage.setItem('nekro-nxt.theme', theme), colorScheme)
      await page.setViewportSize(viewport)
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
      await page.goto('/users')
      await expect(page.getByRole('heading', { name: '平台用户' })).toBeVisible()
      await expect(page.getByText('成员甲', { exact: true })).toBeVisible()
      const workspaceGeometry = await page.evaluate(() => {
        const stage = document.querySelector<HTMLElement>('main')
        const root = document.querySelector<HTMLElement>('[data-product-page="users"]')
        const toolbar = document.querySelector<HTMLElement>('[data-page-toolbar]')
        const header = document.querySelector<HTMLElement>('[data-table-header]')
        const body = document.querySelector<HTMLElement>('[data-table-scroll-region]')
        const pagination = document.querySelector<HTMLElement>('[data-table-pagination]')
        if (!stage || !root || !toolbar || !header || !body || !pagination) {
          throw new Error('用户目录缺少桌面工作区结构。')
        }
        const stageRect = stage.getBoundingClientRect()
        const rootRect = root.getBoundingClientRect()
        const toolbarRect = toolbar.getBoundingClientRect()
        const headerRect = header.getBoundingClientRect()
        const paginationRect = pagination.getBoundingClientRect()
        body.scrollTop = body.scrollHeight
        return new Promise<{
          rootWidthRatio: number
          toolbarWidthRatio: number
          bodyScrolled: boolean
          paginationVisible: boolean
          pageScrollTop: number
          toolbarY: number
          headerY: number
          paginationY: number
        }>((resolve) => {
          requestAnimationFrame(() => {
            const bodyScrolled = body.scrollTop > 0
            body.scrollTop = 0
            resolve({
              rootWidthRatio: rootRect.width / stageRect.width,
              toolbarWidthRatio: toolbarRect.width / rootRect.width,
              bodyScrolled,
              paginationVisible: paginationRect.top >= rootRect.top - 1 && paginationRect.bottom <= rootRect.bottom + 1,
              pageScrollTop: root.scrollTop,
              toolbarY: Math.abs(toolbar.getBoundingClientRect().y - toolbarRect.y),
              headerY: Math.abs(header.getBoundingClientRect().y - headerRect.y),
              paginationY: Math.abs(pagination.getBoundingClientRect().y - paginationRect.y),
            })
          })
        })
      })
      expect(workspaceGeometry.rootWidthRatio).toBeGreaterThan(0.9)
      expect(workspaceGeometry.toolbarWidthRatio).toBeGreaterThan(0.9)
      if (viewport.height === 720) expect(workspaceGeometry.bodyScrolled).toBe(true)
      expect(workspaceGeometry.paginationVisible).toBe(true)
      expect(workspaceGeometry.pageScrollTop).toBe(0)
      expect(workspaceGeometry.toolbarY).toBeLessThanOrEqual(1)
      expect(workspaceGeometry.headerY).toBeLessThanOrEqual(1)
      expect(workspaceGeometry.paginationY).toBeLessThanOrEqual(1)
      await assertViewportIntegrity(page)
      await capture(page, testInfo, `platform-users-${viewport.width}x${viewport.height}-${colorScheme}`)
    }
  }

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await page.goto('/users')
  await expect(page.getByText('成员甲', { exact: true })).toBeVisible()
  await page.getByLabel('搜索名称').fill('不存在的成员')
  const userEmpty = page.locator('[data-product-page="users"] [data-empty-state]')
  await expect(userEmpty.getByText('当前筛选无结果', { exact: true })).toBeVisible()
  const userEmptyGeometry = await userEmpty.evaluate((element) => {
    const body = element.parentElement
    if (!body) throw new Error('用户空态缺少表体区域。')
    const style = getComputedStyle(element)
    const bodyRect = body.getBoundingClientRect()
    const emptyRect = element.getBoundingClientRect()
    const bodyCenterX = bodyRect.left + body.clientLeft + body.clientWidth / 2
    const bodyCenterY = bodyRect.top + body.clientTop + body.clientHeight / 2
    return {
      widthRatio: emptyRect.width / bodyRect.width,
      heightRatio: emptyRect.height / bodyRect.height,
      centerOffset: Math.hypot(
        bodyCenterX - (emptyRect.left + emptyRect.width / 2),
        bodyCenterY - (emptyRect.top + emptyRect.height / 2),
      ),
      background: style.backgroundColor,
      borderWidth: style.borderTopWidth,
      shadow: style.boxShadow,
    }
  })
  expect(userEmptyGeometry.widthRatio).toBeGreaterThan(0.95)
  expect(userEmptyGeometry.heightRatio).toBeGreaterThan(0.95)
  expect(userEmptyGeometry.centerOffset).toBeLessThanOrEqual(1)
  expect(userEmptyGeometry.background).toBe('rgba(0, 0, 0, 0)')
  expect(userEmptyGeometry.borderWidth).toBe('0px')
  expect(userEmptyGeometry.shadow).toBe('none')
  await capture(page, testInfo, 'platform-users-empty-light')
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await capture(page, testInfo, 'platform-users-empty-dark')

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await page.goto(`/work/agents/${targetAgentId}`)
  const editor = page.getByRole('textbox', { name: '人设' })
  await editor.focus()
  const editorFocusMetrics = await editor.evaluate((element) => ({
    editorOutline: getComputedStyle(element).outlineStyle,
    frameShadow: element.parentElement ? getComputedStyle(element.parentElement).boxShadow : 'none',
  }))
  expect(editorFocusMetrics.editorOutline).toBe('none')
  expect(editorFocusMetrics.frameShadow).not.toBe('none')
  await editor.fill(`${Array.from({ length: 19 }, (_, index) => `工作边界 ${index + 1}`).join('\n')}\n引用 @成员`)
  const referenceMenu = page.getByRole('listbox', { name: '可引用对象' })
  await expect(referenceMenu).toBeVisible()
  await expect(referenceMenu).toHaveAttribute('data-reference-menu-placement', 'above')
  expect(await referenceMenu.evaluate((element) => getComputedStyle(element).transformOrigin)).toMatch(
    /px\s+\d+(?:\.\d+)?px$/u,
  )
  await expect(page.getByRole('option', { name: /成员甲/u })).toBeVisible()
  await capture(page, testInfo, 'persona-reference-candidates-20-lines-light')
  await page.getByRole('option', { name: /成员甲/u }).click()
  const referenceChip = editor.getByText('@成员甲')
  await expect(referenceChip).toBeVisible()
  const chipLineMetrics = await referenceChip.evaluate((element) => {
    const paragraph = element.closest('p')
    const editorElement = element.closest('[role="textbox"]')
    return {
      chipHeight: element.getBoundingClientRect().height,
      paragraphHeight: paragraph?.getBoundingClientRect().height ?? 0,
      lineHeight: editorElement ? Number.parseFloat(getComputedStyle(editorElement).lineHeight) : 0,
    }
  })
  expect(chipLineMetrics.chipHeight).toBeLessThanOrEqual(chipLineMetrics.lineHeight)
  expect(chipLineMetrics.paragraphHeight).toBe(chipLineMetrics.lineHeight * 20)
  await assertViewportIntegrity(page)
  await capture(page, testInfo, 'persona-reference-editor-20-lines-light')
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await capture(page, testInfo, 'persona-reference-editor-20-lines-dark')
  expect(failures, failures.join('\n')).toEqual([])
})

test('platform-user updates stay local while persona references use the shared motion system', async ({ page }) => {
  const failures = installRuntimeFailureGate(page)
  await installProductRoutes(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/users')
  await expect(page.getByRole('heading', { name: '平台用户' })).toBeVisible()
  await expect(page.getByText('成员甲', { exact: true })).toBeVisible()
  await expect(page.getByText('正在连接', { exact: true })).toHaveCount(0)

  const stableChromeBefore = await page.evaluate(() => {
    const toolbar = document.querySelector<HTMLElement>('[data-page-toolbar]')!
    const header = document.querySelector<HTMLElement>('[data-table-header]')!
    const pagination = document.querySelector<HTMLElement>('[data-table-pagination]')!
    return [toolbar, header, pagination].map((element) => {
      const rect = element.getBoundingClientRect()
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    })
  })
  await page.getByRole('link', { name: /QQ 官方机器人/u }).click()
  await expect(page.getByText('QQ 官方机器人 · 9 位用户', { exact: true })).toBeVisible()
  await expect(page.locator('[data-product-page="users"] [data-stage-layer]')).toHaveCount(0)
  const stableChromeAfter = await page.evaluate(() => {
    const toolbar = document.querySelector<HTMLElement>('[data-page-toolbar]')!
    const header = document.querySelector<HTMLElement>('[data-table-header]')!
    const pagination = document.querySelector<HTMLElement>('[data-table-pagination]')!
    return [toolbar, header, pagination].map((element) => {
      const rect = element.getBoundingClientRect()
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    })
  })
  expect(stableChromeAfter).toEqual(stableChromeBefore)

  await page.goto(`/work/agents/${targetAgentId}`)
  const editor = page.getByRole('textbox', { name: '人设' })
  await editor.fill('引用 ')
  await editor.press('End')
  const menuSamplesPromise = page.evaluate(
    () =>
      new Promise<number[]>((resolve) => {
        const samples: number[] = []
        const deadline = performance.now() + 1_000
        const sample = (): void => {
          const menu = document.querySelector<HTMLElement>('[role="listbox"][aria-label="可引用对象"]')
          if (menu) samples.push(Number(getComputedStyle(menu).opacity))
          if (samples.length >= 20 || performance.now() >= deadline) {
            resolve(samples)
            return
          }
          requestAnimationFrame(sample)
        }
        requestAnimationFrame(sample)
      }),
  )
  await editor.type('@')
  const menu = page.getByRole('listbox', { name: '可引用对象' })
  const menuSamples = await menuSamplesPromise
  await expect(menu).toHaveAttribute('data-reference-menu-placement', 'below')
  expect(menuSamples.some((opacity) => opacity > 0.02 && opacity < 0.98)).toBe(true)

  await page.evaluate(() => window.localStorage.setItem('nekro-nxt.reduced-motion', 'true'))
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-nxt-motion', 'off')
  const reducedEditor = page.getByRole('textbox', { name: '人设' })
  await reducedEditor.fill('引用 @')
  const reducedMenu = page.getByRole('listbox', { name: '可引用对象' })
  await expect(reducedMenu).toBeVisible()
  expect(await reducedMenu.evaluate((element) => getComputedStyle(element).opacity)).toBe('1')
  expect(failures, failures.join('\n')).toEqual([])
})

test('representative product surfaces match committed visual baselines', async ({ page }, testInfo) => {
  const failures = installRuntimeFailureGate(page)
  await installProductRoutes(page)
  await page.unroute('**/api/snapshot')
  await page.route('**/api/snapshot', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...productSnapshot,
        agents: productSnapshot.agents.map((agent) => {
          if (agent.id === sourceAgentId) {
            return { ...agent, runtimeStatus: 'running' as const, runtimePhase: 'thinking' as const }
          }
          if (agent.id === targetAgentId) {
            return { ...agent, runtimeStatus: 'idle' as const, runtimePhase: 'idle' as const }
          }
          return agent
        }),
      }),
    }),
  )
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' })
  await page.addInitScript(() => {
    if (window.localStorage.getItem('nekro-nxt.theme') === null) {
      window.localStorage.setItem('nekro-nxt.theme', 'light')
    }
    window.localStorage.setItem('nekro-nxt.reduced-motion', 'true')
  })
  const runtimeReady = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return url.pathname === `/api/channels/${targetChannelId}/runtime` && response.ok()
  })
  await page.goto(`/work/channels/${targetChannelId}`)
  await runtimeReady
  await expect(page.getByRole('heading', { name: '资料员的内置频道' })).toBeVisible()
  await expect(page.locator('[data-conversation-title]').getByText('空闲', { exact: true })).toBeVisible()
  const objectPane = page.getByLabel('对象列')
  const targetAgentLink = objectPane.locator(`a[href="/work/agents/${targetAgentId}"]`)
  const sourceAgentLink = objectPane.locator(`a[href="/work/agents/${sourceAgentId}"]`)
  await expect(targetAgentLink.locator('[data-tree-state-indicator]')).toHaveCount(0)
  await expect(objectPane.getByText('思考中', { exact: true })).toHaveCount(0)
  await expect(sourceAgentLink.locator('[aria-label="运行状态：思考中"]')).toBeVisible()
  await expect(page).toHaveScreenshot('channel-conversation-light-1440.png', {
    animations: 'disabled',
    maxDiffPixelRatio: 0.005,
  })
  const dragHandle = page.getByRole('button', { name: '拖动“记录员”及其频道排序' })
  const stateIndicator = sourceAgentLink.locator('[data-tree-state-indicator]')
  await expect(stateIndicator).toHaveCSS('opacity', '1')
  await page.locator('html').evaluate((root) => root.setAttribute('data-reduced-motion', 'false'))
  expect(
    await stateIndicator
      .locator('[data-runtime-state="思考中"]')
      .evaluate((element) => getComputedStyle(element, '::after').animationName),
  ).toMatch(/treeActivityOrbit/u)
  await page.locator('html').evaluate((root) => root.setAttribute('data-reduced-motion', 'true'))
  await sourceAgentLink.hover()
  await expect(stateIndicator).toHaveCSS('opacity', '0')
  await dragHandle.hover()
  await expect(dragHandle).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await capture(page, testInfo, 'channel-tree-drag-hover')
  await page.mouse.move(700, 700)

  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'no-preference' })
  await page.evaluate(() => window.localStorage.setItem('nekro-nxt.theme', 'dark'))
  await page.goto('/settings?tab=appearance')
  await expect(page.getByRole('heading', { name: '外观' })).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(page.getByRole('combobox', { name: '主题' })).toHaveText('深色')
  await expect(page).toHaveScreenshot('appearance-settings-dark-1440.png', {
    animations: 'disabled',
    maxDiffPixelRatio: 0.005,
  })
  expect(failures, failures.join('\n')).toEqual([])
})

test('representative pages and the command palette have no serious accessibility violations', async ({ page }) => {
  const failures = installRuntimeFailureGate(page)
  await installProductRoutes(page)
  for (const route of [`/work/channels/${targetChannelId}`, '/connections', '/settings?tab=appearance']) {
    await page.goto(route)
    await expect(page.locator('main')).toBeVisible()
    await expect(page.getByText('正在连接', { exact: true })).toHaveCount(0)
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
    expect(
      result.violations.filter((violation) => violation.impact === 'critical' || violation.impact === 'serious'),
      `${route} 存在严重无障碍问题`,
    ).toEqual([])
  }

  await page.keyboard.press('Control+K')
  await expect(page.getByRole('dialog', { name: '命令面板' })).toBeVisible()
  const paletteResult = await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  expect(
    paletteResult.violations.filter((violation) => violation.impact === 'critical' || violation.impact === 'serious'),
  ).toEqual([])
  expect(failures, failures.join('\n')).toEqual([])
})

test('minimum desktop window remains reachable at 125% and 150% effective zoom', async ({ page }) => {
  const failures = installRuntimeFailureGate(page)
  await installProductRoutes(page)
  for (const effectiveViewport of [
    { width: 880, height: 576, zoom: '125%' },
    { width: 733, height: 480, zoom: '150%' },
  ]) {
    await page.setViewportSize(effectiveViewport)
    await page.goto(`/work/channels/${targetChannelId}`)
    await expect(page.getByRole('heading', { name: '资料员的内置频道' })).toBeVisible()
    const geometry = await page.evaluate(() => ({
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      bodyOverflow: getComputedStyle(document.body).overflow,
    }))
    expect(geometry.scrollWidth, `${effectiveViewport.zoom} 必须保留横向到达路径`).toBeGreaterThanOrEqual(1100)
    expect(geometry.scrollHeight, `${effectiveViewport.zoom} 必须保留纵向到达路径`).toBeGreaterThanOrEqual(720)
    expect(geometry.bodyOverflow).toBe('auto')
    await page.evaluate(() =>
      window.scrollTo(document.documentElement.scrollWidth, document.documentElement.scrollHeight),
    )
    expect(await page.evaluate(() => window.scrollX > 0 && window.scrollY > 0)).toBe(true)
  }
  expect(failures, failures.join('\n')).toEqual([])
})

test('English and long object names keep the desktop header on one line', async ({ page }) => {
  const failures = installRuntimeFailureGate(page)
  await installProductRoutes(page)
  const longChannelName = 'Documentation & Research Coordination Channel — International Release Readiness Review'
  await page.unroute('**/api/snapshot')
  await page.route('**/api/snapshot', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...productSnapshot,
        channels: productSnapshot.channels.map((channel) =>
          channel.id === targetChannelId ? { ...channel, displayName: longChannelName } : channel,
        ),
      }),
    }),
  )
  await page.setViewportSize({ width: 1100, height: 720 })
  await page.goto(`/work/channels/${targetChannelId}`)
  const heading = page.getByRole('heading', { name: longChannelName })
  await expect(heading).toBeVisible()
  const headingBox = await heading.boundingBox()
  expect(headingBox?.height).toBeLessThanOrEqual(24)
  const actionsBox = await page.locator('[data-conversation-header-actions]').boundingBox()
  expect(actionsBox?.height).toBeLessThanOrEqual(36)
  await assertViewportIntegrity(page)
  expect(failures, failures.join('\n')).toEqual([])
})

test('channel tabs, running tools, and trajectory rows remain keyboard operable', async ({ page }, testInfo) => {
  const failures = installRuntimeFailureGate(page)
  await installProductRoutes(page)
  await page.unroute('**/api/channels/*/runtime')
  await page.route('**/api/channels/*/runtime', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        channelId: targetChannelId,
        agentId: targetAgentId,
        phase: 'using-tool',
        summary: '智能体正在核对发布资料。',
        pendingInjectCount: 0,
        turns: [
          {
            turn: 1,
            state: 'in-progress',
            producedReply: false,
            steps: [
              {
                step: 1,
                internalOutput: { kind: 'internal-output', text: '先核对版本，再检查发布记录。' },
                tools: [
                  {
                    callId: 'call_read_release',
                    name: 'read_file',
                    displayName: '读取发布记录',
                    state: 'succeeded',
                    inputPreview: '发布记录.md',
                    resultPreview: '版本 0.8.0',
                  },
                  {
                    callId: 'call_verify_release',
                    name: 'verify_release',
                    displayName: '核对发布资料',
                    state: 'running',
                    inputPreview: '版本 0.8.0 · 生产构建',
                  },
                  {
                    callId: 'call_send_release',
                    name: 'send_channel_message',
                    displayName: '发送频道消息',
                    state: 'succeeded',
                    wroteToChannel: true,
                    inputPreview: '发布资料已核对。',
                    resultPreview: 'sent',
                  },
                ],
              },
            ],
          },
        ],
      }),
    }),
  )

  await page.setViewportSize({ width: 1100, height: 720 })
  await page.goto(`/work/channels/${targetChannelId}`)

  const streamSummary = page.getByRole('button', { name: /内部输出.*核对发布资料.*2 个工具/u })
  await expect(streamSummary).toHaveAttribute('aria-expanded', 'false')
  await streamSummary.click()
  await expect(streamSummary).toHaveAttribute('aria-expanded', 'true')
  const runningTool = page.getByRole('button', { name: /^核对发布资料/u })
  await expect(runningTool).toHaveAttribute('aria-expanded', 'true')
  const controlledId = await runningTool.getAttribute('aria-controls')
  expect(controlledId).toBeTruthy()
  const controlledRegion = page.locator(`[id="${controlledId}"]`)
  await expect(controlledRegion).toBeVisible()
  const dotPositions = await page
    .locator('[data-work-status-dot]')
    .evaluateAll((dots) => dots.map((dot) => dot.getBoundingClientRect().left))
  expect(Math.max(...dotPositions) - Math.min(...dotPositions)).toBeLessThanOrEqual(1)
  const runningBox = await runningTool.boundingBox()
  const streamBox = await page.locator('[data-work-stream]').boundingBox()
  expect(runningBox?.width ?? 0).toBeLessThanOrEqual(streamBox?.width ?? Number.POSITIVE_INFINITY)
  await capture(page, testInfo, 'channel-running-tool-expanded')
  await runningTool.click()
  await expect(runningTool).toHaveAttribute('aria-expanded', 'false')
  await expect(controlledRegion).toHaveCount(0)
  await streamSummary.click()
  await expect(streamSummary).toHaveAttribute('aria-expanded', 'false')
  await expect(runningTool).toBeHidden()

  const chatTab = page.getByRole('tab', { name: '会话' })
  const trajectoryTab = page.getByRole('tab', { name: '工作轨迹' })
  await chatTab.focus()
  await page.keyboard.press('ArrowRight')
  await expect(trajectoryTab).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByLabel('工作轨迹记录')).toBeVisible()
  await expect(page.getByLabel('消息内容')).toHaveCount(0)
  const trajectoryGeometry = await page.evaluate(() => {
    const canvas = document.querySelector('[data-channel-canvas-stage]')!
    const ledger = document.querySelector('[aria-label="工作轨迹记录"]')!
    return {
      canvasRight: canvas.getBoundingClientRect().right,
      ledgerRight: ledger.getBoundingClientRect().right,
      scrollWidth: ledger.scrollWidth,
      clientWidth: ledger.clientWidth,
    }
  })
  expect(trajectoryGeometry.ledgerRight).toBeLessThanOrEqual(trajectoryGeometry.canvasRight + 1)
  expect(trajectoryGeometry.scrollWidth).toBeGreaterThan(trajectoryGeometry.clientWidth)

  const readRow = page.getByRole('row').filter({ hasText: '读取发布记录' })
  await readRow.focus()
  await page.keyboard.press('Enter')
  await expect(readRow).toHaveAttribute('aria-current', 'true')
  await page.keyboard.press('ArrowDown')
  const runningRow = page.getByRole('row').filter({ hasText: '核对发布资料' })
  await expect(runningRow).toBeFocused()
  await expect(runningRow).toHaveAttribute('aria-current', 'true')
  await expect(page.locator('aside[aria-label="工作轨迹"]').getByRole('heading', { name: '输入' })).toBeVisible()
  await capture(page, testInfo, 'channel-trajectory-keyboard-selection')

  expect(failures, failures.join('\n')).toEqual([])
})

test('desktop splitters and appearance preferences persist and recover defaults', async ({ page }, testInfo) => {
  const failures = installRuntimeFailureGate(page)
  await installProductRoutes(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/work/channels/${targetChannelId}`)

  const objectSplitter = page.getByRole('separator', { name: '调整对象列宽度' })
  await expect(objectSplitter).toHaveAttribute('aria-valuenow', '240')
  await objectSplitter.focus()
  await page.keyboard.press('End')
  await expect(objectSplitter).toHaveAttribute('aria-valuenow', '304')

  const inspectorSplitter = page.getByRole('separator', { name: '调整检查器宽度' })
  await expect(inspectorSplitter).toHaveAttribute('aria-valuenow', '344')
  const inspectorDividerGeometry = await inspectorSplitter.evaluate((element) => {
    const previous = element.previousElementSibling
    const next = element.nextElementSibling
    if (!(previous instanceof HTMLElement) || !(next instanceof HTMLElement)) {
      throw new Error('检查器分隔条缺少相邻画布。')
    }
    const previousRect = previous.getBoundingClientRect()
    const nextRect = next.getBoundingClientRect()
    const splitterRect = element.getBoundingClientRect()
    const line = getComputedStyle(element, '::after')
    return {
      gap: nextRect.left - previousRect.right,
      centerOffset: Math.abs(splitterRect.left + splitterRect.width / 2 - (previousRect.right + 0.5)),
      hitWidth: splitterRect.width,
      lineLeft: Number.parseFloat(line.left),
      lineWidth: Number.parseFloat(line.width),
    }
  })
  expect(inspectorDividerGeometry.gap).toBe(1)
  expect(inspectorDividerGeometry.centerOffset).toBeLessThanOrEqual(0.5)
  expect(inspectorDividerGeometry.hitWidth).toBe(9)
  expect(inspectorDividerGeometry.lineLeft).toBe(4.5)
  expect(inspectorDividerGeometry.lineWidth).toBe(1)
  await dragHorizontally(page, inspectorSplitter, -40)
  await expect(inspectorSplitter).toHaveAttribute('aria-valuenow', '384')
  await dragHorizontally(page, inspectorSplitter, 60)
  await expect(inspectorSplitter).toHaveAttribute('aria-valuenow', '324')
  await inspectorSplitter.focus()
  await page.keyboard.press('Home')
  await expect(inspectorSplitter).toHaveAttribute('aria-valuenow', '320')
  await page.keyboard.press('ArrowLeft')
  await expect(inspectorSplitter).toHaveAttribute('aria-valuenow', '321')
  await page.keyboard.press('ArrowRight')
  await expect(inspectorSplitter).toHaveAttribute('aria-valuenow', '320')
  await page.reload()
  await expect(page.getByRole('separator', { name: '调整对象列宽度' })).toHaveAttribute('aria-valuenow', '304')
  await expect(page.getByRole('separator', { name: '调整检查器宽度' })).toHaveAttribute('aria-valuenow', '320')
  await capture(page, testInfo, 'desktop-splitters-persisted')

  await page.getByRole('separator', { name: '调整检查器宽度' }).dblclick()
  await expect(page.getByRole('separator', { name: '调整检查器宽度' })).toHaveAttribute('aria-valuenow', '344')
  await page.getByRole('button', { name: '收起频道检查器' }).click()
  await expect(page.locator('div[class*="inspectorPane"]')).toHaveAttribute('aria-hidden', 'true')
  await expect(page.getByRole('complementary', { name: '频道', includeHidden: true })).toBeHidden()
  await page.reload()
  await expect(page.getByRole('button', { name: '展开频道检查器' })).toBeVisible()
  await page.getByRole('button', { name: '展开频道检查器' }).click()
  await expect(page.getByRole('complementary', { name: '频道' })).toBeVisible()

  await page.goto('/settings?tab=appearance')
  await page.getByRole('switch', { name: '减少动态效果' }).click()
  await page.getByRole('switch', { name: '减少透明效果' }).click()
  await page.getByLabel('对比度').click()
  await page.getByRole('option', { name: '更高对比度' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-reduced-motion', 'true')
  await expect(page.locator('html')).toHaveAttribute('data-reduced-transparency', 'true')
  await expect(page.locator('html')).toHaveAttribute('data-contrast', 'more')
  await page.reload()
  await expect(page.getByRole('switch', { name: '减少动态效果' })).toBeChecked()
  await expect(page.getByRole('switch', { name: '减少透明效果' })).toBeChecked()
  await expect(page.getByLabel('对比度')).toContainText('更高对比度')
  await expect(page.locator('[data-route-transition] > [data-stage-layer="in"]')).toHaveCount(1)
  const reducedMotionAlignment = await page.evaluate(() => {
    const stage = document.querySelector<HTMLElement>('[data-product-page="settings"] [data-stage-layer="in"]')
    const content = document.querySelector<HTMLElement>('[data-settings-content]')
    if (!stage || !content) throw new Error('减少动效后的设置页缺少内容中心轴。')
    const stageRect = stage.getBoundingClientRect()
    const contentRect = content.getBoundingClientRect()
    const stageCenter = stageRect.left + stage.clientLeft + stage.clientWidth / 2
    return Math.abs(stageCenter - (contentRect.left + contentRect.width / 2))
  })
  expect(reducedMotionAlignment).toBeLessThanOrEqual(1)
  await capture(page, testInfo, 'appearance-reduced-transparency-high-contrast')

  await page.getByRole('button', { name: '恢复默认分栏' }).click()
  await page.goto(`/work/channels/${targetChannelId}`)
  await expect(page.getByRole('separator', { name: '调整对象列宽度' })).toHaveAttribute('aria-valuenow', '240')
  await expect(page.getByRole('separator', { name: '调整检查器宽度' })).toHaveAttribute('aria-valuenow', '344')
  expect(failures, failures.join('\n')).toEqual([])
})

test('DSH native and generic settings remain legible across desktop themes and viewports', async ({
  page,
}, testInfo) => {
  const failures = installRuntimeFailureGate(page)
  for (const viewport of [
    { width: 1100, height: 720 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
  ]) {
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.setViewportSize(viewport)
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
      await page.goto('/settings?tab=dsh-extensions')
      await page.evaluate((theme) => window.localStorage.setItem('nekro-nxt.theme', theme), colorScheme)
      await page.reload()
      await expect(page.getByText('DeepSeek 网页搜索', { exact: true }).first()).toBeVisible()
      await expect(page.locator('[data-dsh-native-surface]')).toBeVisible()
      await expect(page.locator('[data-dsh-native-surface]')).toContainText(/Web search|网页搜索/u)
      await assertViewportIntegrity(page)
      await capture(page, testInfo, `dsh-native-${viewport.width}x${viewport.height}-${colorScheme}`)

      await page.getByRole('tab', { name: '通用配置' }).click()
      await expect(page.getByText('Namespace：web-search-deepseek', { exact: true })).toBeVisible()
      await expect(page.getByLabel('新的凭据值')).toBeVisible()
      await expectTabsSettled(page)
      await assertViewportIntegrity(page)
      await capture(page, testInfo, `dsh-generic-${viewport.width}x${viewport.height}-${colorScheme}`)
    }
  }
  expect(failures, failures.join('\n')).toEqual([])
})

test('clearing a DSH credential requires an explicit dangerous confirmation', async ({ page }, testInfo) => {
  const failures = installRuntimeFailureGate(page)
  await page.route('**/api/dsh/credentials/describe', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ credentials: { DEEPSEEK_API_KEY: { configured: true, source: 'file', writable: true } } }),
    }),
  )
  await page.setViewportSize({ width: 1100, height: 720 })
  await page.goto('/settings?tab=dsh-extensions')
  await page.getByRole('tab', { name: '通用配置' }).click()
  await expectTabsSettled(page)

  const trigger = page.getByRole('button', { name: '清除凭据' })
  await trigger.click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog.getByRole('heading', { name: '清除“DEEPSEEK_API_KEY”' })).toBeVisible()
  await expect(dialog.getByText(/已保存值无法从浏览器恢复/u)).toBeVisible()
  await expect(dialog.getByRole('button', { name: '保留凭据' })).toBeVisible()
  await expect(dialog.getByRole('button', { name: '清除该凭据' })).toBeVisible()
  await capture(page, testInfo, 'dsh-credential-clear-confirmation')

  await dialog.getByRole('button', { name: '保留凭据' }).click()
  await expect(dialog).toBeHidden()
  await expect(trigger).toBeFocused()
  expect(failures, failures.join('\n')).toEqual([])
})

test('group conversations preserve sender and Mention semantics without exposing internal identities', async ({
  page,
}, testInfo) => {
  const failures = installRuntimeFailureGate(page)
  await installProductRoutes(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/work/channels/${qqChannelId}`)

  await expect(page.getByText('成员甲', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('@机器人账号', { exact: true })).toBeVisible()
  await expect(page.getByText('@成员乙', { exact: true })).toBeVisible()
  await expect(page.getByText('示例来源', { exact: true })).toBeVisible()
  await expect(page.getByText('示例分享', { exact: true })).toBeVisible()
  const mentionMessage = page.locator('article[data-side="left"]').filter({ hasText: '请和' })
  const richMessage = page.locator('article[data-side="left"]').filter({ hasText: '示例分享' })
  const richCardLink = richMessage.getByRole('link', { name: '打开卡片：示例分享' })
  const imageMessage = page
    .locator('article[data-side="left"]')
    .filter({ has: page.getByRole('img', { name: '讨论截图' }) })
  await expect(mentionMessage).not.toHaveAttribute('data-bubbleless', '')
  await expect(richMessage).toHaveAttribute('data-bubbleless', '')
  await expect(richCardLink).toHaveAttribute('href', 'https://example.test/share/qq-card')
  await expect(richCardLink).toHaveAttribute('target', '_blank')
  await expect(richCardLink.getByRole('img', { name: '示例分享' })).toBeVisible()
  await expect(richMessage.getByRole('button')).toHaveCount(0)
  await expect(page.getByRole('dialog', { name: '示例分享' })).toHaveCount(0)
  await expect(imageMessage).toHaveAttribute('data-bubbleless', '')
  await expect(mentionMessage).toContainText('请和')
  await expect(page.getByText('请先绑定智能体', { exact: true })).toHaveCount(1)
  const sendButton = page.getByRole('button', { name: '发到频道' })
  await expect(sendButton).toBeVisible()
  expect(await sendButton.innerText()).toBe('')
  const visibleText = await page.locator('body').innerText()
  expect(visibleText).not.toContain(senderMemberId)
  expect(visibleText).not.toContain(targetMemberId)
  expect(visibleText).not.toContain('group:opaqueidab12')
  await assertViewportIntegrity(page)
  await capture(page, testInfo, 'qq-group-member-mentions')
  expect(failures, failures.join('\n')).toEqual([])
})

test('redesigned relationship and lifecycle pages stay legible across representative themes', async ({
  page,
}, testInfo) => {
  const failures = installRuntimeFailureGate(page)
  await installProductRoutes(page)
  const scenes = [
    { route: '/work', text: '资料员', width: 1440, height: 900, colorScheme: 'light' },
    {
      route: `/work/agents/${targetAgentId}?tab=capabilities`,
      text: '系统访问等级',
      width: 1100,
      height: 720,
      colorScheme: 'dark',
    },
    {
      route: '/connections',
      text: '内置频道由 NekroNXT 直接提供。',
      width: 1440,
      height: 900,
      colorScheme: 'light',
    },
    { route: '/work/creator', text: '与资料员协作创造', width: 1920, height: 1080, colorScheme: 'dark' },
    { route: '/extensions', text: '包含内容', width: 1920, height: 1080, colorScheme: 'light' },
    { route: '/extensions', text: '包含内容', width: 1920, height: 900, colorScheme: 'dark' },
    { route: '/settings?tab=models', text: '供应商配置', width: 1440, height: 900, colorScheme: 'light' },
    { route: '/settings?tab=models', text: '供应商配置', width: 1920, height: 900, colorScheme: 'dark' },
    {
      route: '/connections',
      text: '内置频道由 NekroNXT 直接提供。',
      width: 1920,
      height: 900,
      colorScheme: 'dark',
    },
    {
      route: '/settings?tab=system-extensions',
      text: '已安装适配器',
      width: 1440,
      height: 900,
      colorScheme: 'dark',
    },
    { route: '/settings?tab=appearance', text: '月潮观测所', width: 1440, height: 900, colorScheme: 'light' },
    { route: '/settings?tab=appearance', text: '月潮观测所', width: 1440, height: 900, colorScheme: 'dark' },
    { route: '/settings?tab=about', text: '版权与品牌', width: 1440, height: 900, colorScheme: 'dark' },
    { route: '/work/agents/new', text: '创建智能体', width: 1440, height: 900, colorScheme: 'dark' },
    {
      route: `/work/agents/${targetAgentId}`,
      text: '主模型原生视觉',
      width: 1920,
      height: 1080,
      colorScheme: 'light',
    },
  ] as const

  for (const scene of scenes) {
    await page.setViewportSize({ width: scene.width, height: scene.height })
    await page.emulateMedia({ colorScheme: scene.colorScheme, reducedMotion: 'reduce' })
    await page.goto(scene.route)
    await expect(page.getByText(scene.text).first()).toBeVisible()
    if (scene.route === '/connections' || scene.route === '/extensions' || scene.route === '/settings?tab=models') {
      await expect(page.locator('[data-stage-layer="in"]').last()).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    }
    if (scene.route === '/work') {
      const accessChip = page.locator('[aria-label="系统访问：Lv.0，基础权限"]').first()
      await expect(accessChip).toBeVisible()
      await expect(accessChip).toHaveText('Lv.0')
      await accessChip.hover()
      await expect(page.getByRole('tooltip').getByText('Lv.0 · 基础权限')).toBeVisible()
      await expect(page.getByRole('tooltip').getByText('不授予文件读写、命令运行或完整访问。')).toBeVisible()
    }
    if (scene.route === '/connections') {
      await expect(page.getByText('平台账号', { exact: true })).toBeVisible()
      await expect(page.getByRole('heading', { name: '内置频道' })).toBeVisible()
      await expect(page.getByText('连接', { exact: true })).toHaveCount(0)
    }
    if (scene.route === '/extensions') {
      await expect(page.getByText('本地扩展', { exact: true })).toBeVisible()
      await expect(page.getByRole('heading', { name: '群聊摘要' })).toBeVisible()
      await expect(page.getByText('扩展', { exact: true })).toHaveCount(0)
    }
    if (scene.route === '/settings?tab=appearance') {
      const alignment = await page.evaluate(() => {
        const stage = document.querySelector<HTMLElement>('[data-product-page="settings"] [data-stage-layer="in"]')
        const content = document.querySelector<HTMLElement>('[data-settings-content]')
        if (!stage || !content) throw new Error('设置页缺少内容中心轴。')
        const stageRect = stage.getBoundingClientRect()
        const contentRect = content.getBoundingClientRect()
        const stageCenter = stageRect.left + stage.clientLeft + stage.clientWidth / 2
        return Math.abs(stageCenter - (contentRect.left + contentRect.width / 2))
      })
      expect(alignment).toBeLessThanOrEqual(1)
    }
    if (scene.route.startsWith('/work/agents/')) {
      const sectionWidths = await page
        .locator('section[id^="agent-"]')
        .evaluateAll((sections) => sections.map((section) => section.getBoundingClientRect().width))
      expect(Math.max(...sectionWidths) - Math.min(...sectionWidths)).toBeLessThanOrEqual(1)
      if (scene.route.includes('tab=capabilities')) {
        await page.locator('#agent-capabilities').scrollIntoViewIfNeeded()
      }
    }
    await assertViewportIntegrity(page)
    await capture(
      page,
      testInfo,
      `redesign-${scene.route.split(/[/?]/u).filter(Boolean).join('-')}-${scene.colorScheme}`,
    )
  }

  await page.unroute('**/api/snapshot')
  await page.route('**/api/snapshot', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...productSnapshot, dynamic: [] }),
    }),
  )
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await page.goto(`/work/agents/${targetAgentId}?tab=capabilities`)
  const creatorSection = page.locator('#agent-creator')
  await creatorSection.scrollIntoViewIfNeeded()
  const creatorChannel = page.getByRole('combobox', { name: '沟通频道' })
  const creatorAction = page.getByRole('button', { name: '前往频道提出需求' })
  await expect(creatorChannel).toBeVisible()
  await expect(creatorAction).toBeVisible()
  const creatorAlignment = await Promise.all([creatorChannel.boundingBox(), creatorAction.boundingBox()])
  expect(
    Math.abs((creatorAlignment[0]?.y ?? 0) - (creatorAlignment[1]?.y ?? Number.POSITIVE_INFINITY)),
  ).toBeLessThanOrEqual(2)
  await capture(page, testInfo, 'redesign-agent-capabilities-no-run-dark')

  await page.goto('/connections')
  await page
    .getByRole('link', { name: /QQ 官方机器人/u })
    .first()
    .click()
  await expect(page.locator('[data-stage-layer="out"]')).toHaveCount(0)
  await expect(page.locator('[data-stage-layer="in"]').last()).toHaveCSS('opacity', '1')
  const optionalTests = page.getByRole('button', { name: '收发测试' })
  await expect(optionalTests).toHaveAttribute('aria-expanded', 'false')
  const aliasInput = page.getByLabel('辨识名')
  const saveAliasButton = page.getByRole('button', { name: '保存别名' })
  await expect
    .poll(async () => {
      const aliasBox = await aliasInput.boundingBox()
      const saveAliasBox = await saveAliasButton.boundingBox()
      return Math.abs(
        (aliasBox?.y ?? 0) + (aliasBox?.height ?? 0) - ((saveAliasBox?.y ?? 0) + (saveAliasBox?.height ?? 0)),
      )
    })
    .toBeLessThanOrEqual(1)
  const saveAliasBox = await saveAliasButton.boundingBox()
  expect(saveAliasBox?.width ?? Number.POSITIVE_INFINITY).toBeLessThan(180)
  const scrollGeometry = await page.evaluate(() => {
    const root = document.querySelector('[data-connection-page-scroll-root]')!
    const stage = document.querySelector('main')!
    return {
      rootRight: root.getBoundingClientRect().right,
      stageRight: stage.getBoundingClientRect().right,
      overflowY: getComputedStyle(root).overflowY,
    }
  })
  expect(Math.abs(scrollGeometry.rootRight - scrollGeometry.stageRight)).toBeLessThanOrEqual(1)
  expect(scrollGeometry.overflowY).toBe('auto')
  await capture(page, testInfo, 'redesign-connection-qq-tests-collapsed-light')
  await optionalTests.click()
  await expect(page.getByText('群聊（尾号 ab12）')).toBeVisible()
  const connectionText = await page.locator('body').innerText()
  expect(connectionText).not.toContain('group:opaqueidab12')
  expect(connectionText).not.toContain('群聊（尾号 ab12） · 群聊')
  await capture(page, testInfo, 'redesign-connection-qq-light')

  await page.unroute('**/api/snapshot')
  await page.route('**/api/snapshot', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...productSnapshot, extensions: [] }),
    }),
  )
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await page.goto('/extensions')
  await expect(page.getByText('本地扩展', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: '扩展库' })).toBeVisible()
  await expect(page.getByText('从一次动态运行开始')).toBeVisible()
  await expect(page.getByText('还没有本地扩展', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '打开创造工作台' })).toBeVisible()
  const emptySurfaceGeometry = await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('[data-product-page="extensions"]')
    const header = document.querySelector<HTMLElement>('[data-product-page="extensions"] [data-page-header]')
    const empty = document.querySelector<HTMLElement>('[data-product-page="extensions"] [data-empty-state]')
    const transition = root?.querySelector<HTMLElement>(':scope > [data-route-transition]')
    const stage = transition?.querySelector<HTMLElement>('[data-stage-layer="in"]')
    if (!root || !header || !empty || !transition || !stage) throw new Error('扩展空态缺少必要区域。')
    const rootRect = root.getBoundingClientRect()
    const headerRect = header.getBoundingClientRect()
    const emptyRect = empty.getBoundingClientRect()
    const transitionRect = transition.getBoundingClientRect()
    const stageRect = stage.getBoundingClientRect()
    const emptyStyle = getComputedStyle(empty)
    const rootCenter = rootRect.left + rootRect.width / 2
    const stageCenter = stageRect.left + stage.clientLeft + stage.clientWidth / 2
    return {
      emptyCenterOffset: Math.abs(stageCenter - (emptyRect.left + emptyRect.width / 2)),
      emptyWidthRatio: emptyRect.width / transitionRect.width,
      headerCenterOffset: Math.abs(rootCenter - (headerRect.left + headerRect.width / 2)),
      transitionOverflow: getComputedStyle(transition).overflow,
      background: emptyStyle.backgroundColor,
      borderWidth: emptyStyle.borderTopWidth,
      shadow: emptyStyle.boxShadow,
    }
  })
  expect(emptySurfaceGeometry.emptyCenterOffset).toBeLessThanOrEqual(1)
  expect(emptySurfaceGeometry.emptyWidthRatio).toBeGreaterThan(0.95)
  expect(emptySurfaceGeometry.headerCenterOffset).toBeLessThanOrEqual(1)
  expect(emptySurfaceGeometry.transitionOverflow).toBe('hidden')
  expect(emptySurfaceGeometry.background).toBe('rgba(0, 0, 0, 0)')
  expect(emptySurfaceGeometry.borderWidth).toBe('0px')
  expect(emptySurfaceGeometry.shadow).toBe('none')
  await capture(page, testInfo, 'redesign-extension-empty-light')
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await capture(page, testInfo, 'redesign-extension-empty-dark')
  expect(failures, failures.join('\n')).toEqual([])
})

test('the product Client runtime approves, renders, and retracts a live DSH interface without reloading', async ({
  page,
}) => {
  const failures = installRuntimeFailureGate(page)
  let phase: 'pending' | 'active' | 'stopped' = 'pending'
  let releaseStatus!: () => void
  const statusGate = new Promise<void>((resolve) => {
    releaseStatus = resolve
  })
  const calls: string[] = []
  const dynamicSummary = () => [
    {
      agentId: targetAgentId,
      episodeId: targetEpisodeId,
      pluginId: 'client-probe-1',
      ...(phase === 'pending' ? { approvalRequestId: 'approval-1' } : { packageId: 'package-1' }),
      status: phase === 'pending' ? 'awaiting-approval' : phase === 'active' ? 'running' : 'stopped',
      packages: [
        {
          packageId: 'package-1',
          name: '即时界面探针',
          purpose: '验证产品中的 DSH Client 装卸链路。',
          hasHostHalf: false,
          hasClientHalf: true,
        },
      ],
      policy: { turn: 1, consecutiveFailures: 0, repeatedFingerprintCount: 0 },
    },
  ]
  const inventoryRows = () => [
    {
      pluginId: 'client-probe-1',
      agentId: targetAgentId,
      packages: [
        {
          packageId: 'package-1',
          name: '即时界面探针',
          purpose: '验证产品中的 DSH Client 装卸链路。',
          hasHostHalf: false,
          hasClientHalf: true,
        },
      ],
      ...(phase === 'active' ? { activeRun: { pluginRunId: 'run-1', packageId: 'package-1' } } : {}),
      latestRun: {
        pluginRunId: 'run-1',
        packageId: 'package-1',
        mode: 'run',
        status: phase === 'pending' ? 'awaiting-approval' : phase === 'active' ? 'running' : 'stopped',
        host: {
          status: phase === 'pending' ? 'absent' : phase === 'active' ? 'running' : 'stopped',
          waitingFor: [],
        },
        client: {
          status: phase === 'pending' ? 'pending' : phase === 'active' ? 'running' : 'stopped',
          waitingFor: [],
        },
        ...(phase === 'pending' ? { approvalRequestId: 'approval-1', requiresApproval: true } : {}),
      },
    },
  ]

  await page.route('**/api/snapshot', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...productSnapshot, dynamic: dynamicSummary() }),
    }),
  )
  await page.route('**/api/events', async (route) => {
    await statusGate
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: 'event: status\ndata: {}\n\n',
    })
  })
  await page.route('**/api/dynamic/*/inventory', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ rows: inventoryRows() }) }),
  )
  await page.route('**/api/channels/*/runtime', (route) => {
    const channelId = new URL(route.request().url()).pathname.split('/')[3]
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        channelId,
        phase: 'idle',
        summary: '智能体当前空闲。',
        pendingInjectCount: 0,
        turns: [],
      }),
    })
  })
  await page.route('**/api/dynamic/*/run-host-half', (route) => {
    calls.push('run-host-half')
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        pluginId: 'client-probe-1',
        packageId: 'package-1',
        pluginRunId: 'run-1',
        waitingFor: [],
        startedHere: true,
      }),
    })
  })
  await page.route('**/api/dynamic/*/get-client-code', (route) => {
    calls.push('get-client-code')
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        pluginId: 'client-probe-1',
        packageId: 'package-1',
        pluginRunId: 'run-1',
        name: '即时界面探针',
        code: `return {
          inject: ['slots'],
          apply(ctx) {
            ctx.slots.register(
              { name: 'agent.workbench.sections', id: 'main' },
              () => React.createElement('section', { 'data-live-client': 'probe' }, '即时界面已真实加载')
            )
          }
        }`,
      }),
    })
  })
  await page.route('**/api/dynamic/*/approve', (route) => {
    calls.push('approve')
    phase = 'active'
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ accepted: true }) })
  })
  await page.route('**/api/dynamic/*/report-client-verification', (route) => {
    calls.push('report-client-verification')
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
  })

  await page.goto('/work/creator')
  await page.getByRole('button', { name: '审查界面预览' }).click()
  await page.getByRole('dialog').getByRole('button', { name: '允许本次预览' }).click()
  await expect(page.getByText('即时界面已真实加载')).toBeVisible()
  await expect.poll(() => calls).toContain('report-client-verification')
  expect(calls).toEqual(['run-host-half', 'get-client-code', 'approve', 'report-client-verification'])

  phase = 'stopped'
  releaseStatus()
  await expect(page.getByText('即时界面已真实加载')).toBeHidden()
  await expect(page.getByText('已停止', { exact: true }).first()).toBeVisible()
  expect(failures, failures.join('\n')).toEqual([])
})

test('the creator saves the exact running Package and selects the resulting extension', async ({ page }) => {
  const failures = installRuntimeFailureGate(page)
  const savedExtensionId = ExtensionIdSchema.parse('ext_savedprobe')
  const savedRevisionId = ExtensionRevisionIdSchema.parse('xrv_savedprobe')
  let saved = false
  let saveRequest: unknown
  let clientCodeRequests = 0
  page.on('request', (request) => {
    if (request.url().includes('/get-client-code')) clientCodeRequests += 1
  })
  const dynamic = [
    {
      agentId: targetAgentId,
      episodeId: targetEpisodeId,
      pluginId: 'plugin-save-probe',
      packageId: 'package-save-probe',
      currentPackageId: 'package-save-probe',
      status: 'running',
      packages: [
        {
          packageId: 'package-save-probe',
          name: '待保存摘要工具',
          purpose: '验证创造工作台的精确保存。',
          hasHostHalf: true,
          hasClientHalf: false,
        },
      ],
      policy: { turn: 1, consecutiveFailures: 0, repeatedFingerprintCount: 0 },
    },
  ]
  const snapshot = () =>
    HostApiContracts.snapshot.response.parse({
      ...productSnapshot,
      dynamic,
      extensions: saved
        ? [
            ...productSnapshot.extensions,
            {
              id: savedExtensionId,
              slug: 'saved-summary-probe',
              displayName: '持久摘要探针',
              description: '验证创造工作台保存结果。',
              createdByAgentId: targetAgentId,
              revisions: [
                {
                  id: savedRevisionId,
                  revisionNumber: 1,
                  createdAt: 1_725_000_000_500,
                  contributions: ['工具：saved_summary_probe'],
                  verification: {
                    verifiedAt: 1_725_000_000_500,
                    dshVersion: '0.1.1-rc.2',
                    contractVersion: 'nekro-nxt-extension-v1',
                    hostBuilt: true,
                    clientBuilt: false,
                    buildKey: 'e'.repeat(64),
                    toolInvocationCount: 1,
                    rpcMethods: [],
                    renderedSlots: [],
                  },
                },
              ],
              activations: [],
              clientDiagnostics: [],
            },
          ]
        : productSnapshot.extensions,
    })

  await page.route('**/api/snapshot', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot()) }),
  )
  await page.route('**/api/dynamic/*/inventory', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        rows: [
          {
            pluginId: 'plugin-save-probe',
            agentId: targetAgentId,
            packages: dynamic[0]!.packages,
            activeRun: { pluginRunId: 'run-save-probe', packageId: 'package-save-probe' },
            latestRun: {
              pluginRunId: 'run-save-probe',
              packageId: 'package-save-probe',
              mode: 'run',
              status: 'running',
              host: { status: 'running', waitingFor: [] },
              client: { status: 'absent', waitingFor: [] },
            },
          },
        ],
      }),
    }),
  )
  await page.route('**/api/extensions/save-from-dynamic', async (route) => {
    saveRequest = route.request().postDataJSON()
    saved = true
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ extensionId: savedExtensionId, revisionId: savedRevisionId, activation: 'inactive' }),
    })
  })

  await page.goto('/work/creator')
  await page.getByRole('button', { name: '保存为本地扩展', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('扩展名称').fill('持久摘要探针')
  await dialog.getByLabel('本地标识').fill('saved-summary-probe')
  await dialog.getByLabel('说明').fill('验证创造工作台保存结果。')
  await dialog.getByRole('button', { name: '保存本地版本', exact: true }).click()

  await expect(page).toHaveURL(new RegExp(`/extensions/${savedExtensionId}$`, 'u'))
  await expect(page.getByRole('heading', { name: '持久摘要探针' })).toBeVisible()
  await expect(page.getByText('智能体工具 · saved_summary_probe', { exact: true })).toBeVisible()
  expect(HostApiContracts.saveExtensionFromDynamic.request.parse(saveRequest)).toEqual({
    agentId: targetAgentId,
    episodeId: targetEpisodeId,
    pluginId: 'plugin-save-probe',
    packageId: 'package-save-probe',
    displayName: '持久摘要探针',
    slug: 'saved-summary-probe',
    description: '验证创造工作台保存结果。',
  })
  expect(clientCodeRequests).toBe(0)
  expect(failures, failures.join('\n')).toEqual([])
})

test('a verified Client extension restores across product pages and retracts when disabled', async ({
  page,
}, testInfo) => {
  const failures = installRuntimeFailureGate(page)
  const buildKey = 'f'.repeat(64)
  const activeAgentIds = new Set<string>([targetAgentId])
  let artifactLoads = 0
  const rpcCalls: unknown[] = []
  const diagnostics: unknown[] = []
  const snapshot = () =>
    HostApiContracts.snapshot.response.parse({
      ...productSnapshot,
      dynamic: [],
      extensions: [
        {
          ...productSnapshot.extensions[0],
          revisions: [
            {
              id: summaryRevisionId,
              revisionNumber: 2,
              createdAt: 1_725_000_000_000,
              contributions: ['工具：summary_tool', 'RPC：summary.status', '界面：智能体工作台', '界面：扩展详情'],
              verification: {
                verifiedAt: 1_725_000_000_000,
                dshVersion: '0.1.1-rc.2',
                contractVersion: 'nekro-nxt-extension-v1',
                hostBuilt: true,
                clientBuilt: true,
                buildKey,
                toolInvocationCount: 1,
                rpcMethods: ['summary.status'],
                renderedSlots: ['agent.workbench.sections', 'extension.details.panels'],
              },
            },
          ],
          activations: [...activeAgentIds].map((agentId) => ({
            agentId,
            extensionRevisionId: summaryRevisionId,
            config: {},
            activatedAt: 1_725_000_000_000,
          })),
          clientDiagnostics: [],
        },
      ],
    })

  await page.route('**/api/snapshot', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot()) }),
  )
  await page.route('**/api/channels/*/runtime', (route) => {
    const channelId = new URL(route.request().url()).pathname.split('/')[3]
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        channelId,
        agentId: targetAgentId,
        phase: 'idle',
        summary: '智能体当前空闲。',
        pendingInjectCount: 0,
        turns: [],
      }),
    })
  })
  await page.route(`**/api/extensions/${summaryExtensionId}/revisions/${summaryRevisionId}/client/*.mjs*`, (route) => {
    artifactLoads += 1
    return route.fulfill({
      status: 200,
      contentType: 'text/javascript; charset=utf-8',
      body: `export default ({ React, host, styles }) => ({
          inject: ['slots'],
          apply(ctx) {
            ctx.slots.register(
              { name: 'agent.workbench.sections', id: 'workbench' },
              function SummaryWorkbench(props) {
                const [status, setStatus] = React.useState('正在调用持久 RPC')
                React.useEffect(() => {
                  let mounted = true
                  host.call('summary.status', { agentId: props.agentId }).then((value) => {
                    if (mounted) setStatus(value.label)
                  }, (error) => {
                    if (mounted) setStatus(error instanceof Error ? error.message : String(error))
                  })
                  return () => { mounted = false }
                }, [props.agentId])
                return React.createElement('section', { className: styles.section, 'data-persistent-client': 'agent' },
                  React.createElement('h3', { className: styles.sectionHeading }, '智能体摘要面板'),
                  React.createElement('p', { className: styles.secondaryText }, props.displayName + ' · ' + status)
                )
              }
            )
            ctx.slots.register(
              { name: 'extension.details.panels', id: 'details' },
              (props) => React.createElement('section', { className: styles.section, 'data-persistent-client': 'details' },
                React.createElement('h3', { className: styles.sectionHeading }, '扩展验证面板'),
                React.createElement('span', { className: styles.badge }, props.activation === 'active' ? '已接入产品 Slot' : '未启用')
              )
            )
          }
        })`,
    })
  })
  await page.route(`**/api/extensions/${summaryExtensionId}/revisions/${summaryRevisionId}/call`, async (route) => {
    rpcCalls.push(route.request().postDataJSON())
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ value: { label: '持久 RPC 已调用' } }),
    })
  })
  await page.route(
    `**/api/extensions/${summaryExtensionId}/revisions/${summaryRevisionId}/client-diagnostic`,
    async (route) => {
      diagnostics.push(route.request().postDataJSON())
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ accepted: true }),
      })
    },
  )
  await page.route(`**/api/agents/*/extensions/${summaryExtensionId}/activation`, (route) => {
    const agentId = new URL(route.request().url()).pathname.split('/')[3]
    if (!agentId) throw new Error('启用请求缺少智能体 ID。')
    if (route.request().method() === 'POST') {
      activeAgentIds.add(agentId)
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          activation: {
            agentId,
            extensionId: summaryExtensionId,
            extensionRevisionId: summaryRevisionId,
            config: {},
            activatedAt: 1_725_000_000_000,
          },
        }),
      })
    }
    expect(route.request().method()).toBe('DELETE')
    activeAgentIds.delete(agentId)
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ disabled: true }),
    })
  })

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await page.goto(`/extensions/${summaryExtensionId}`)
  await expect(page.getByText('选择使用这个扩展的智能体。', { exact: true })).toBeVisible()
  await expect(page.getByText('界面数据接口 · summary.status', { exact: true })).toBeVisible()
  await expect(page.getByText('DSH 版本').locator('..')).toContainText('0.1.1-rc.2')
  await expect(page.getByText('扩展验证面板', { exact: true })).toBeVisible()
  await expect(page.getByText('已接入产品 Slot', { exact: true })).toBeVisible()
  await expect(page.getByRole('switch', { name: '停止让资料员使用“群聊摘要”', exact: true })).toBeChecked()
  await expect(page.getByRole('switch', { name: '允许记录员使用“群聊摘要”', exact: true })).not.toBeChecked()
  await expect.poll(() => diagnostics.length).toBeGreaterThanOrEqual(1)
  expect(diagnostics[0]).toEqual({ agentId: targetAgentId, status: 'loaded' })
  await assertViewportIntegrity(page)
  await capture(page, testInfo, 'persistent-extension-details-light-1440')

  await page.setViewportSize({ width: 1280, height: 800 })
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await expect(page.getByText('包含内容', { exact: true })).toBeVisible()
  await assertViewportIntegrity(page)
  await capture(page, testInfo, 'persistent-extension-details-dark-1280')

  await page.setViewportSize({ width: 1100, height: 720 })
  await page.getByText('使用范围', { exact: true }).scrollIntoViewIfNeeded()
  await assertViewportIntegrity(page)
  await capture(page, testInfo, 'persistent-extension-usage-dark-1100')

  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.getByRole('heading', { name: '群聊摘要', exact: true }).scrollIntoViewIfNeeded()
  await assertViewportIntegrity(page)
  await capture(page, testInfo, 'persistent-extension-details-dark-1920')

  await page.setViewportSize({ width: 1280, height: 800 })

  await page.goto(`/work/agents/${targetAgentId}`)
  await expect(page.getByText('智能体摘要面板', { exact: true })).toBeVisible()
  await expect(page.getByText('资料员 · 持久 RPC 已调用', { exact: true })).toBeVisible()
  expect(rpcCalls[0]).toEqual({
    agentId: targetAgentId,
    method: 'summary.status',
    input: { agentId: targetAgentId },
  })
  await assertViewportIntegrity(page)
  await page.locator('[data-persistent-client="agent"]').scrollIntoViewIfNeeded()
  await capture(page, testInfo, 'persistent-agent-panel-dark-1280')

  await page.reload()
  await expect(page.getByText('资料员 · 持久 RPC 已调用', { exact: true })).toBeVisible()
  await expect.poll(() => artifactLoads).toBeGreaterThanOrEqual(2)
  await expect.poll(() => rpcCalls.length).toBeGreaterThanOrEqual(2)

  await page.goto(`/extensions/${summaryExtensionId}`)
  await page.getByRole('switch', { name: '允许记录员使用“群聊摘要”', exact: true }).click()
  await expect(page.getByRole('switch', { name: '停止让记录员使用“群聊摘要”', exact: true })).toBeChecked()
  await expect(page.getByText('2 个智能体正在使用', { exact: true })).toBeVisible()

  await page.goto(`/work/agents/${sourceAgentId}`)
  await expect(page.getByText('选择这个智能体可以使用的扩展。', { exact: true })).toBeVisible()
  await expect(page.locator('body')).not.toContainText('不需要逐个进入扩展详情')
  const sourceExtensionSwitch = page.getByRole('switch', { name: '停用“群聊摘要”', exact: true })
  await expect(sourceExtensionSwitch).toBeChecked()
  await page.setViewportSize({ width: 1100, height: 720 })
  await sourceExtensionSwitch.scrollIntoViewIfNeeded()
  await assertViewportIntegrity(page)
  await capture(page, testInfo, 'persistent-agent-extensions-dark-1100')
  await sourceExtensionSwitch.click()
  await expect(page.getByRole('switch', { name: '启用“群聊摘要”', exact: true })).not.toBeChecked()

  await page.goto(`/extensions/${summaryExtensionId}`)
  await page.getByRole('switch', { name: '停止让资料员使用“群聊摘要”', exact: true }).click()
  await expect(page.getByText('扩展验证面板', { exact: true })).toBeHidden()
  await expect(page.getByRole('switch', { name: '允许资料员使用“群聊摘要”', exact: true })).not.toBeChecked()
  const loadsAfterDisable = artifactLoads
  await page.goto(`/work/agents/${targetAgentId}`)
  await expect(page.getByText('智能体摘要面板', { exact: true })).toBeHidden()
  expect(artifactLoads).toBe(loadsAfterDisable)
  expect(failures, failures.join('\n')).toEqual([])
})

test('a failed Client factory stays isolated and can be reloaded without disabling Host activation', async ({
  page,
}) => {
  const failures = installRuntimeFailureGate(page)
  const buildKey = 'd'.repeat(64)
  let failedDiagnostic = false
  let artifactLoads = 0
  let deactivationRequests = 0
  const diagnostics: unknown[] = []
  const snapshot = () =>
    HostApiContracts.snapshot.response.parse({
      ...productSnapshot,
      dynamic: [],
      extensions: [
        {
          ...productSnapshot.extensions[0],
          revisions: [
            {
              id: summaryRevisionId,
              revisionNumber: 2,
              createdAt: 1_725_000_000_000,
              contributions: ['工具：summary_tool', '界面：扩展详情'],
              verification: {
                verifiedAt: 1_725_000_000_000,
                dshVersion: '0.1.1-rc.2',
                contractVersion: 'nekro-nxt-extension-v1',
                hostBuilt: true,
                clientBuilt: true,
                buildKey,
                toolInvocationCount: 1,
                rpcMethods: [],
                renderedSlots: ['extension.details.panels'],
              },
            },
          ],
          clientDiagnostics: failedDiagnostic
            ? [
                {
                  agentId: targetAgentId,
                  revisionId: summaryRevisionId,
                  status: 'failed',
                  message: '合成 Client factory 失败',
                  observedAt: 1_725_000_000_900,
                },
              ]
            : [],
        },
      ],
    })

  await page.route('**/api/snapshot', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot()) }),
  )
  await page.route(`**/api/extensions/${summaryExtensionId}/revisions/${summaryRevisionId}/client/*.mjs*`, (route) => {
    artifactLoads += 1
    return route.fulfill({
      status: 200,
      contentType: 'text/javascript; charset=utf-8',
      body: `export default () => { throw new Error('合成 Client factory 失败') }`,
    })
  })
  await page.route(
    `**/api/extensions/${summaryExtensionId}/revisions/${summaryRevisionId}/client-diagnostic`,
    async (route) => {
      const body: unknown = route.request().postDataJSON()
      diagnostics.push(body)
      if (
        typeof body === 'object' &&
        body !== null &&
        !Array.isArray(body) &&
        'status' in body &&
        body.status === 'failed'
      ) {
        failedDiagnostic = true
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ accepted: true }),
      })
    },
  )
  await page.route(`**/api/agents/${targetAgentId}/extensions/${summaryExtensionId}/activation`, (route) => {
    deactivationRequests += 1
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ disabled: true }),
    })
  })

  await page.goto(`/extensions/${summaryExtensionId}`)
  await expect.poll(() => diagnostics.length).toBeGreaterThanOrEqual(1)
  expect(diagnostics[0]).toEqual({
    agentId: targetAgentId,
    status: 'failed',
    message: '合成 Client factory 失败',
  })

  await page.reload()
  await expect(page.getByText('扩展界面加载失败', { exact: true })).toBeVisible()
  await expect(page.getByText('合成 Client factory 失败', { exact: true })).toBeVisible()
  await expect(page.getByRole('switch', { name: '停止让资料员使用“群聊摘要”', exact: true })).toBeChecked()
  await page.getByRole('button', { name: '重新加载界面', exact: true }).click()
  await expect.poll(() => artifactLoads).toBeGreaterThanOrEqual(3)
  expect(deactivationRequests).toBe(0)
  expect(failures, failures.join('\n')).toEqual([])
})

test('the creation page reuses the editor structure and submits explicit capabilities', async ({ page }, testInfo) => {
  const failures = installRuntimeFailureGate(page)
  await installProductRoutes(page)
  let submitted: unknown
  await page.route('**/api/agents', async (route) => {
    submitted = route.request().postDataJSON()
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        agentId: AgentIdSchema.parse('agt_created'),
        channelId: targetChannelId,
        connectionId: webConnectionId,
      }),
    })
  })
  await page.setViewportSize({ width: 1100, height: 720 })
  await page.goto('/work/agents/new')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByLabel('名称').fill('研究员')
  await page.getByLabel('人设').fill('先核对证据，再给出结论。')
  await expect(page.getByRole('combobox', { name: '默认模型' })).toContainText('DeepSeek V4 Flash')
  await expect(
    page.getByText('当前模型支持图片输入。频道原图会按消息顺序进入上下文，重复内容只注入一次，并支持批量主动重看。'),
  ).toBeVisible()
  await page.getByText('图片理解', { exact: true }).scrollIntoViewIfNeeded()
  await capture(page, testInfo, 'agent-create-image-policy-direct')
  await page.getByRole('combobox', { name: '默认模型' }).click()
  await page.getByRole('option', { name: '测试供应商 · 纯文本模型' }).click()
  await expect(page.getByRole('option')).toHaveCount(0)
  await expect(page.getByText('图片会被保存，但当前智能体尚不能理解图片。请选择辅助视觉模型。')).toBeVisible()
  await page.getByText('图片理解', { exact: true }).scrollIntoViewIfNeeded()
  await capture(page, testInfo, 'agent-create-image-policy-text-unavailable')
  await page.getByRole('combobox', { name: '辅助视觉模型' }).click()
  await page.getByRole('option', { name: 'deepseek · DeepSeek V4 Flash' }).click()
  await expect(page.getByRole('option')).toHaveCount(0)
  await expect(page.getByText('当前主模型仅接收文本；图片会由配置的辅助视觉模型批量理解。')).toBeVisible()
  await page.getByText('图片理解', { exact: true }).scrollIntoViewIfNeeded()
  await capture(page, testInfo, 'agent-create-image-policy-delegated')
  await page.getByRole('combobox', { name: '默认模型' }).click()
  await page.getByRole('option', { name: '能力未声明供应商 · 能力未声明模型' }).click()
  await expect(page.getByRole('option')).toHaveCount(0)
  await expect(page.getByText('当前模型没有声明图片输入能力，按文本模型处理。')).toBeVisible()
  await page.getByText('图片理解', { exact: true }).scrollIntoViewIfNeeded()
  await capture(page, testInfo, 'agent-create-image-policy-unknown')
  await page.getByRole('combobox', { name: '辅助视觉模型' }).click()
  await page.getByRole('option', { name: '不启用图片理解' }).click()
  await page.getByRole('combobox', { name: '默认模型' }).click()
  await page.getByRole('option', { name: 'deepseek · DeepSeek V4 Flash' }).click()
  await page.getByRole('switch', { name: '允许动态创造' }).click()
  await page.getByRole('button', { name: '展开逐项设置' }).click()
  await page.getByRole('switch', { name: '运行命令' }).click()
  await expect
    .poll(() =>
      page
        .locator('[data-access-granular]')
        .evaluate((element) => element.parentElement?.getBoundingClientRect().height ?? 0),
    )
    .toBeGreaterThan(170)
  await expect(page.getByRole('slider', { name: '系统访问等级' })).toHaveValue('0')
  await expect(page.getByText('自定义权限（Lv.C）', { exact: true })).toBeVisible()
  await capture(page, testInfo, 'agent-create-confirmation')
  await page.getByRole('button', { name: '创建智能体' }).click()
  await expect(page).toHaveURL(new RegExp(`/work/channels/${targetChannelId}$`, 'u'))
  expect(submitted).toEqual({
    displayName: '研究员',
    persona: '先核对证据，再给出结论。',
    personaDocument: { version: 1, segments: [{ type: 'text', text: '先核对证据，再给出结论。' }] },
    model: { provider: 'deepseek', model: 'deepseek-v4-flash' },
    imagePolicy,
    capabilities: {
      subagents: true,
      fileTools: false,
      webSearch: false,
      dynamicCreation: true,
      developmentShell: true,
      unrestrictedFileAccess: false,
    },
  })
  expect(failures, failures.join('\n')).toEqual([])
})

test('desktop shell keeps a 48px top bar and a permanently available object pane', async ({ page }, testInfo) => {
  const failures = installRuntimeFailureGate(page)
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.addInitScript(() => window.localStorage.removeItem('nekro-nxt.theme'))
  await installProductRoutes(page)
  await page.setViewportSize({ width: 1100, height: 720 })
  await page.goto('/work')

  const topBar = page.locator('[data-window-top-bar]')
  const pane = page.locator('aside[aria-label="对象列"]')
  expect((await topBar.boundingBox())?.height).toBe(48)
  await expect(topBar.getByText('NekroNXT', { exact: true })).toBeVisible()
  await expect(topBar.getByText('月潮观测所', { exact: true })).toBeVisible()
  await expect(topBar.getByText('CALM · PRECISE · ALIVE', { exact: true })).toBeVisible()
  const chromeGeometry = await page.evaluate(() => {
    const brand = document.querySelector<HTMLElement>('[data-window-brand]')
    const dragTitle = document.querySelector<HTMLElement>('[data-window-drag-title]')
    const rail = document.querySelector<HTMLElement>('aside[aria-label="模式"]')
    const tree = document.querySelector<HTMLElement>('aside[aria-label="对象列"]')
    const stage = document.querySelector<HTMLElement>('main')
    if (!brand || !dragTitle || !rail || !tree || !stage) throw new Error('窗口外壳缺少必要表面。')
    const brandStyle = getComputedStyle(brand)
    const dragTitleStyle = getComputedStyle(dragTitle)
    const railStyle = getComputedStyle(rail)
    const treeStyle = getComputedStyle(tree)
    const stageStyle = getComputedStyle(stage)
    return {
      brandBackground: brandStyle.backgroundColor,
      dragTitleBackground: dragTitleStyle.backgroundColor,
      brandRadius: Number.parseFloat(brandStyle.borderTopLeftRadius),
      dragTitleRadius: Number.parseFloat(dragTitleStyle.borderTopLeftRadius),
      railRadii: [
        railStyle.borderTopLeftRadius,
        railStyle.borderTopRightRadius,
        railStyle.borderBottomRightRadius,
        railStyle.borderBottomLeftRadius,
      ],
      treeRadii: [
        treeStyle.borderTopLeftRadius,
        treeStyle.borderTopRightRadius,
        treeStyle.borderBottomRightRadius,
        treeStyle.borderBottomLeftRadius,
      ],
      stageRadii: [
        stageStyle.borderTopLeftRadius,
        stageStyle.borderTopRightRadius,
        stageStyle.borderBottomRightRadius,
        stageStyle.borderBottomLeftRadius,
      ],
    }
  })
  expect(chromeGeometry.brandRadius).toBeGreaterThanOrEqual(10)
  expect(chromeGeometry.dragTitleRadius).toBeGreaterThanOrEqual(10)
  expect(chromeGeometry.brandBackground).toBe('rgba(0, 0, 0, 0)')
  expect(chromeGeometry.dragTitleBackground).toBe('rgba(0, 0, 0, 0)')
  expect(chromeGeometry.railRadii).toEqual(['0px', '0px', '0px', '0px'])
  expect(chromeGeometry.treeRadii).toEqual(['0px', '0px', '0px', '0px'])
  expect(chromeGeometry.stageRadii).toEqual(['0px', '0px', '0px', '0px'])
  const shellEdges = await page.evaluate(() => {
    const body = document.querySelector<HTMLElement>('[data-shell-body]')
    const rail = document.querySelector<HTMLElement>('aside[aria-label="模式"]')
    const tree = document.querySelector<HTMLElement>('aside[aria-label="对象列"]')
    const splitter = document.querySelector<HTMLElement>('[role="separator"][aria-label="调整对象列宽度"]')
    const stage = document.querySelector<HTMLElement>('main')
    if (!body || !rail || !tree || !splitter || !stage) throw new Error('窗口主体缺少必要表面。')
    const bodyRect = body.getBoundingClientRect()
    const railRect = rail.getBoundingClientRect()
    const treeRect = tree.getBoundingClientRect()
    const splitterRect = splitter.getBoundingClientRect()
    const stageRect = stage.getBoundingClientRect()
    const splitterLine = getComputedStyle(splitter, '::after')
    return {
      bodyLeft: bodyRect.left,
      bodyRight: bodyRect.right,
      railLeft: railRect.left,
      dividerGap: stageRect.left - treeRect.right,
      dividerCenterOffset: Math.abs(splitterRect.left + splitterRect.width / 2 - (treeRect.right + 0.5)),
      dividerHitWidth: splitterRect.width,
      dividerLineLeft: Number.parseFloat(splitterLine.left),
      dividerLineWidth: Number.parseFloat(splitterLine.width),
      stageRight: stageRect.right,
      viewportWidth: window.innerWidth,
    }
  })
  expect(shellEdges.bodyLeft).toBe(0)
  expect(shellEdges.railLeft).toBe(0)
  expect(shellEdges.dividerGap).toBe(1)
  expect(shellEdges.dividerCenterOffset).toBeLessThanOrEqual(0.5)
  expect(shellEdges.dividerHitWidth).toBe(9)
  expect(shellEdges.dividerLineLeft).toBe(4.5)
  expect(shellEdges.dividerLineWidth).toBe(1)
  expect(shellEdges.bodyRight).toBe(shellEdges.viewportWidth)
  expect(shellEdges.stageRight).toBe(shellEdges.viewportWidth)
  for (const selector of ['[data-window-brand]', '[data-window-drag-title]']) {
    const chrome = await page.locator(selector).evaluate((element) => {
      const style = getComputedStyle(element)
      return {
        borders: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth],
        shadow: style.boxShadow,
      }
    })
    expect(chrome.borders).toEqual(['0px', '0px', '0px', '0px'])
    expect(chrome.shadow).toBe('none')
  }
  const expectSquareUnframedPerimeter = async (): Promise<void> => {
    const perimeter = await page.evaluate(() => {
      const read = (selector: string) => {
        const element = document.querySelector<HTMLElement>(selector)
        if (!element) throw new Error(`窗口外壳缺少 ${selector}。`)
        const style = getComputedStyle(element)
        return {
          borders: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth],
          radii: [
            style.borderTopLeftRadius,
            style.borderTopRightRadius,
            style.borderBottomRightRadius,
            style.borderBottomLeftRadius,
          ],
          shadow: style.boxShadow,
        }
      }
      return {
        topBar: read('[data-window-top-bar]'),
        rail: read('aside[aria-label="模式"]'),
        tree: read('aside[aria-label="对象列"]'),
        stage: read('main'),
      }
    })
    expect(perimeter.topBar.borders[0]).toBe('0px')
    expect(perimeter.topBar.borders[1]).toBe('0px')
    expect(perimeter.topBar.borders[3]).toBe('0px')
    expect(perimeter.topBar.shadow).toBe('none')
    expect(perimeter.rail.borders[0]).toBe('0px')
    expect(perimeter.rail.borders[2]).toBe('0px')
    expect(perimeter.rail.borders[3]).toBe('0px')
    expect(perimeter.tree.borders[0]).toBe('0px')
    expect(perimeter.tree.borders[2]).toBe('0px')
    expect(perimeter.stage.borders[0]).toBe('0px')
    expect(perimeter.stage.borders[1]).toBe('0px')
    expect(perimeter.stage.borders[2]).toBe('0px')
    for (const panel of [perimeter.rail, perimeter.tree, perimeter.stage]) {
      expect(panel.radii).toEqual(['0px', '0px', '0px', '0px'])
      expect(panel.shadow).toBe('none')
    }
  }
  await expectSquareUnframedPerimeter()
  await page.locator('html').evaluate((root) => root.style.setProperty('--nxt-window-controls-left', '84px'))
  expect(await topBar.evaluate((element) => getComputedStyle(element).paddingLeft)).toBe('98px')
  expect(await topBar.evaluate((element) => getComputedStyle(element, '::after').left)).toBe('0px')
  await capture(page, testInfo, 'desktop-macos-titlebar-safe-area')
  await page.locator('html').evaluate((root) => root.style.removeProperty('--nxt-window-controls-left'))
  await expect(pane).toBeVisible()
  await expect(page.getByRole('button', { name: /收起对象列|展开对象列/u })).toHaveCount(0)
  await expect(page.getByRole('separator', { name: '调整对象列宽度' })).toBeVisible()
  const themeButton = page.getByRole('button', { name: /^主题：/u })
  await expect(themeButton).toBeVisible()
  await expect(themeButton).toHaveAccessibleName('主题：深色；切换为浅色')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  expect(await page.evaluate(() => window.localStorage.getItem('nekro-nxt.theme'))).toBe('dark')
  expect(await themeButton.evaluate((element) => getComputedStyle(element).color)).toBe('rgb(247, 250, 255)')
  await themeButton.hover()
  await page.waitForTimeout(600)
  await expect(page.getByRole('tooltip', { name: /^主题：/u })).toHaveCount(0)
  await expect(page.locator('html')).toHaveAttribute('data-nxt-cursor', 'pointer')
  await expect(themeButton).toHaveCSS('cursor', 'pointer')
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await themeButton.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  expect(await page.evaluate(() => window.localStorage.getItem('nekro-nxt.theme'))).toBe('light')
  await expect(themeButton.locator('svg.lucide-sun')).toBeVisible()
  await expect(themeButton.locator('span')).toHaveCSS('opacity', '1')
  await expectSquareUnframedPerimeter()
  await capture(page, testInfo, 'desktop-theme-light')
  await themeButton.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  expect(await page.evaluate(() => window.localStorage.getItem('nekro-nxt.theme'))).toBe('dark')
  await expect(themeButton.locator('svg.lucide-moon')).toBeVisible()
  await expect(themeButton.locator('span')).toHaveCSS('opacity', '1')
  await expect(page.locator('[class*="railHostDot"]')).toHaveCount(0)
  await capture(page, testInfo, 'desktop-object-pane-stable')

  await page.goto('/settings?tab=appearance')
  await page.getByRole('combobox', { name: '主题' }).click()
  await expect(page.getByRole('option', { name: '浅色' })).toBeVisible()
  await expect(page.getByRole('option', { name: '深色' })).toBeVisible()
  await expect(page.getByRole('option', { name: '跟随系统' })).toHaveCount(0)

  expect(failures, failures.join('\n')).toEqual([])
})

test('primary product pages render semantic Lucide page and object-pane identities', async ({ page }, testInfo) => {
  const failures = installRuntimeFailureGate(page)
  await installProductRoutes(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await page.addInitScript(() => {
    window.localStorage.setItem('nekro-nxt.theme', 'dark')
    window.localStorage.setItem('nekro-nxt.reduced-motion', 'true')
  })

  for (const scenario of [
    { route: '/connections', pageIcon: 'lucide-cable', paneIcon: 'lucide-cable' },
    { route: '/users', pageIcon: 'lucide-users-round', paneIcon: 'lucide-users-round' },
    { route: '/extensions', pageIcon: 'lucide-boxes', paneIcon: 'lucide-package-open' },
    { route: '/settings', pageIcon: 'lucide-settings', paneIcon: 'lucide-settings' },
  ]) {
    await page.goto(scenario.route)
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(page.locator(`[data-page-header] svg.${scenario.pageIcon}`)).toBeVisible()
    await expect(page.locator(`aside[aria-label="对象列"] .${scenario.paneIcon}`).first()).toBeVisible()
    await expect(page.locator('[data-page-header]')).toHaveAttribute('data-has-icon', '')
    await capture(page, testInfo, `semantic-header-${scenario.pageIcon.replace('lucide-', '')}-dark`)
  }

  expect(failures, failures.join('\n')).toEqual([])
})

test('trusted Desktop bridge renders the persistent remote-instance entry across sizes and themes', async ({
  page,
}, testInfo) => {
  const failures = installRuntimeFailureGate(page)
  await installProductRoutes(page)
  await page.addInitScript(() => {
    const testWindow = window as Window & { __desktopSwitcherOpenCount?: number }
    if (window.localStorage.getItem('nekro-nxt.theme') === null) {
      window.localStorage.setItem('nekro-nxt.theme', 'light')
    }
    window.localStorage.setItem('nekro-nxt.reduced-motion', 'true')
    testWindow.__desktopSwitcherOpenCount = 0
    Object.defineProperty(window, 'nekroDesktopShell', {
      configurable: true,
      value: {
        getCurrentInstancePresentation: () =>
          Promise.resolve({ revision: 1, displayName: '远程开发环境', status: 'ready' as const }),
        openInstanceSwitcher: () => {
          testWindow.__desktopSwitcherOpenCount = (testWindow.__desktopSwitcherOpenCount ?? 0) + 1
          return Promise.resolve()
        },
        subscribeCurrentInstanceStatus: () => () => undefined,
      },
    })
  })

  for (const scene of [
    { size: 'default', width: 1440, height: 900, theme: 'light' },
    { size: 'default', width: 1440, height: 900, theme: 'dark' },
    { size: 'minimum', width: 1100, height: 720, theme: 'light' },
    { size: 'minimum', width: 1100, height: 720, theme: 'dark' },
  ] as const) {
    if (page.url() !== 'about:blank') {
      await page.evaluate((theme) => window.localStorage.setItem('nekro-nxt.theme', theme), scene.theme)
    }
    await page.setViewportSize({ width: scene.width, height: scene.height })
    await page.emulateMedia({ colorScheme: scene.theme, reducedMotion: 'reduce' })
    await page.goto('/')
    await expect(page).toHaveURL(new RegExp(`/work/channels/${targetChannelId}$`, 'u'))
    await expect(page.locator('html')).toHaveAttribute('data-theme', scene.theme)

    const entry = page.getByRole('button', { name: /^管理并添加远程服务实例：远程开发环境/u })
    await expect(entry).toBeVisible()
    await expect(entry).toHaveAccessibleName('管理并添加远程服务实例：远程开发环境 · 运行正常')
    await expect(entry).toHaveCSS('cursor', 'pointer')
    if (scene.size === 'default' && scene.theme === 'light') {
      await entry.hover()
      await page.waitForTimeout(600)
      await expect(page.getByRole('tooltip', { name: /^管理并添加远程服务实例：/u })).toHaveCount(0)
      await expect(page.locator('html')).toHaveAttribute('data-nxt-cursor', 'pointer')
    }
    const statusDot = entry.locator('[class*="instanceStatus_ready"]')
    await expect(statusDot).toBeVisible()
    await expect(statusDot).toHaveCSS('width', '7px')
    await expect(statusDot).toHaveCSS('height', '7px')
    const entryGeometry = await entry.evaluate((element) => {
      const entryRect = element.getBoundingClientRect()
      const railRect = element.closest('aside')?.getBoundingClientRect()
      if (!railRect) throw new Error('服务实例入口缺少图标轨。')
      return {
        width: entryRect.width,
        height: entryRect.height,
        horizontalCenterOffset: Math.abs(entryRect.left + entryRect.width / 2 - (railRect.left + railRect.width / 2)),
        bottomInset: railRect.bottom - entryRect.bottom,
      }
    })
    expect(entryGeometry.width).toBe(36)
    expect(entryGeometry.height).toBe(36)
    expect(entryGeometry.horizontalCenterOffset).toBeLessThanOrEqual(0.5)
    expect(entryGeometry.bottomInset).toBeGreaterThanOrEqual(10)
    expect(entryGeometry.bottomInset).toBeLessThanOrEqual(12)

    await page.getByRole('link', { name: '连接' }).click()
    await expect(page).toHaveURL(/\/connections(?:\/[^/?#]+)?$/u)
    await expect(page.getByText('平台账号', { exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: '内置频道' })).toBeVisible()
    await expect(entry).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('data-theme', scene.theme)
    await capture(page, testInfo, `desktop-instance-entry-${scene.size}-${scene.theme}`)
    await entry.click()
    await expect
      .poll(() =>
        page.evaluate(() => (window as Window & { __desktopSwitcherOpenCount?: number }).__desktopSwitcherOpenCount),
      )
      .toBe(1)
  }

  expect(failures, failures.join('\n')).toEqual([])
})

test('global command palette supports keyboard search and navigation', async ({ page }, testInfo) => {
  const failures = installRuntimeFailureGate(page)
  await installProductRoutes(page)
  await page.goto('/work')

  await page.keyboard.press('Control+K')
  const palette = page.getByRole('dialog', { name: '命令面板' })
  await expect(palette).toBeVisible()
  const search = palette.getByLabel('搜索命令')
  await expect(search).toBeFocused()
  await search.fill('外观')
  await expect(palette.getByRole('button', { name: /打开设置/u })).toBeVisible()
  await capture(page, testInfo, 'global-command-palette')
  await search.press('Enter')
  await expect(page).toHaveURL(/\/settings$/u)

  await page.keyboard.press('Control+K')
  await palette.getByLabel('搜索命令').fill('资料员的内置频道')
  await palette.getByLabel('搜索命令').press('ArrowDown')
  await expect(palette.getByRole('button', { name: /资料员的内置频道/u })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(new RegExp(`/work/channels/${targetChannelId}$`, 'u'))
  expect(failures, failures.join('\n')).toEqual([])
})

test('an initial Host failure is explicit and can recover without reloading', async ({ page }, testInfo) => {
  const failures = installRuntimeFailureGate(page)
  let healthy = false
  await page.setViewportSize({ width: 1100, height: 720 })
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await page.route('**/api/snapshot', (route) => {
    if (!healthy) {
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: '测试服务暂不可用' } }),
      })
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(productSnapshot) })
  })
  await page.route('**/api/channels/*/runtime', (route) => {
    const channelId = new URL(route.request().url()).pathname.split('/')[3]
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        channelId,
        phase: 'idle',
        summary: '智能体当前空闲。',
        pendingInjectCount: 0,
        turns: [],
      }),
    })
  })
  await page.route('**/api/channels/*/messages?*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ messages: [], hasMore: false }),
    }),
  )
  await page.goto('/connections')
  await expect(page.getByText('无法连接', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('添加第一个平台连接', { exact: true }).first()).toBeVisible()
  const hostIllustration = page.locator('img[src$="/brand/illustrations/host-unreachable.svg"]')
  await expect(hostIllustration).toBeVisible()
  await expect.poll(() => hostIllustration.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)
  await assertViewportIntegrity(page)
  await capture(page, testInfo, 'brand-host-unreachable-dark-1100')
  healthy = true
  await page.getByRole('button', { name: '重新连接' }).last().click()
  await expect(page.getByText('无法连接', { exact: true }).first()).toBeHidden()
  await expect(page.getByRole('link', { name: /QQ 官方机器人/u }).first()).toBeVisible()
  await page.goto(`/work/channels/${targetChannelId}`)
  const messageEmpty = page.locator('[data-empty-state]').filter({ hasText: '还没有消息' })
  await expect(messageEmpty).toBeVisible()
  const messageEmptySurface = await messageEmpty.evaluate((element) => {
    const style = getComputedStyle(element)
    const region = element.parentElement
    if (!region) throw new Error('消息空态缺少滚动区域。')
    const regionRect = region.getBoundingClientRect()
    const emptyRect = element.getBoundingClientRect()
    return {
      widthRatio: emptyRect.width / regionRect.width,
      centerOffset: Math.abs(regionRect.left + regionRect.width / 2 - (emptyRect.left + emptyRect.width / 2)),
      background: style.backgroundColor,
      borderWidth: style.borderTopWidth,
      shadow: style.boxShadow,
    }
  })
  expect(messageEmptySurface.widthRatio).toBeGreaterThan(0.95)
  expect(messageEmptySurface.centerOffset).toBeLessThanOrEqual(1)
  expect(messageEmptySurface.background).toBe('rgba(0, 0, 0, 0)')
  expect(messageEmptySurface.borderWidth).toBe('0px')
  expect(messageEmptySurface.shadow).toBe('none')
  await capture(page, testInfo, 'channel-empty-dark-1100')
  expect(
    failures.filter((failure) => !failure.includes('503 (Service Unavailable)')),
    failures.join('\n'),
  ).toEqual([])
})

test('dialog floating layers, Escape, focus return, and pending failure recovery work together', async ({
  page,
}, testInfo) => {
  const failures = installRuntimeFailureGate(page)
  await installProductRoutes(page)
  await page.setViewportSize({ width: 1100, height: 720 })
  await page.goto('/connections')

  const opener = page.getByRole('link', { name: '添加平台连接' })
  await opener.click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('平台').click()
  const floating = page.locator('[data-nxt-floating-layer]').last()
  await expect(floating).toBeVisible()
  const layers = await page.evaluate(() => {
    const dialogElement = document.querySelector('[role="dialog"]')
    const floatingElement = document.querySelector('[data-nxt-floating-layer]')
    return {
      dialog: Number(dialogElement ? getComputedStyle(dialogElement).zIndex : 0),
      floating: Number(floatingElement ? getComputedStyle(floatingElement).zIndex : 0),
    }
  })
  expect(layers.floating).toBeGreaterThan(layers.dialog)
  await capture(page, testInfo, 'connection-platform-select-layer')
  await page.keyboard.press('Escape')
  await expect(floating).toBeHidden()
  await page.waitForTimeout(300)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(opener).toBeFocused()

  await page.goto(`/work/agents/${targetAgentId}`)
  await page.getByRole('button', { name: '绑定频道' }).click()
  const bindingDialog = page.getByRole('dialog')
  let attempts = 0
  await page.route('**/api/bindings', async (route) => {
    attempts += 1
    if (attempts === 1) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'binding-test-failure', message: '测试写入失败' } }),
      })
    }
    return route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        channelId: sourceChannelId,
        agentId: targetAgentId,
        triggerPolicy: 'always',
        boundAt: 1_725_000_001_000,
      }),
    })
  })

  const confirm = bindingDialog.getByRole('button', { name: '绑定频道' })
  await confirm.click()
  await expect(bindingDialog.getByRole('button', { name: '处理中…' })).toBeDisabled()
  await expect(page.getByText('测试写入失败')).toBeVisible()
  await expect(confirm).toBeEnabled()
  await confirm.click()
  await expect(bindingDialog).toBeHidden()
  await expect(page.getByText('频道已绑定。')).toBeVisible()
  await capture(page, testInfo, 'binding-toast-success')
  expect(attempts).toBe(2)
  expect(
    failures.filter((failure) => !failure.includes('500 (Internal Server Error)')),
    failures.join('\n'),
  ).toEqual([])
})

test('model settings hide unconfigured providers behind the DSH-backed add flow', async ({ page }, testInfo) => {
  const failures = installRuntimeFailureGate(page)
  await installProductRoutes(page)
  await page.route('**/api/llm/providers', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        writable: true,
        protocols: ['openai-completions'],
        providers: [
          {
            provider: 'configured-provider',
            displayName: '已配置供应商',
            settingsNs: 'llm-pi-ai',
            settingsPath: ['providers', 'configured-provider'],
            settingsRevision: 3,
            declared: false,
            active: true,
            configured: true,
            credential: { configured: true, writable: true },
            models: [{ id: 'model-a', name: '模型 A' }],
          },
          {
            provider: 'catalog-candidate',
            displayName: '目录候选供应商',
            settingsNs: 'llm-pi-ai',
            settingsPath: ['providers', 'catalog-candidate'],
            settingsRevision: 3,
            declared: false,
            active: false,
            configured: false,
            models: [],
          },
        ],
      }),
    }),
  )

  await page.goto('/settings')
  await expect(page.getByRole('button', { name: /已配置供应商/u })).toBeVisible()
  await expect(page.getByRole('button', { name: /目录候选供应商/u })).toHaveCount(0)
  await page.getByRole('button', { name: '添加供应商' }).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('模型供应商').click()
  await expect(page.getByRole('option', { name: '目录候选供应商' })).toBeVisible()
  await expect(page.getByRole('option', { name: '自定义 OpenAI 兼容供应商' })).toBeVisible()
  await capture(page, testInfo, 'provider-add-catalog')
  expect(failures, failures.join('\n')).toEqual([])
})

test('message composer sends with Enter and keeps Shift+Enter for a new line', async ({ page }) => {
  const failures = installRuntimeFailureGate(page)
  await installProductRoutes(page)
  const submitted: string[] = []
  await page.route(`**/api/channels/${targetChannelId}/messages`, async (route) => {
    const body = HostApiContracts.sendChannelMessage.request.parse(route.request().postDataJSON())
    const textPart = body.parts.find((part) => part.type === 'text')
    submitted.push(textPart?.text ?? '')
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ channelEventId: sentEventId, inserted: true }),
    })
  })

  await page.goto(`/work/channels/${targetChannelId}`)
  const composer = page.getByLabel('消息内容')
  await composer.fill('第一行')
  await composer.press('Shift+Enter')
  await expect(composer).toHaveValue('第一行\n')
  expect(submitted).toEqual([])
  await composer.type('第二行')
  await composer.press('Enter')
  await expect.poll(() => submitted).toEqual(['第一行\n第二行'])
  await expect(composer).toHaveValue('')
  expect(failures, failures.join('\n')).toEqual([])
})

test('long message history stays above a growing multiline composer', async ({ page }, testInfo) => {
  const failures = installRuntimeFailureGate(page)
  await installProductRoutes(page)
  const unbroken = 'NekroNxtOverflowGuard'.repeat(80)
  const overflowProbe = [
    `长记录 31：${unbroken}`,
    '',
    `超长路径：/data/workspaces/agt_example/${'nested-directory/'.repeat(40)}artifact.json`,
    '',
    `行内代码：\`${unbroken}\``,
    '',
    `长链接：[查看记录](https://example.test/${'very-long-path/'.repeat(45)}detail)`,
    '',
    '| 项目 | 内容 |',
    '| --- | --- |',
    `| 宽表格 | ${unbroken} |`,
    '',
    '```text',
    unbroken,
    '```',
  ].join('\n')
  const longMessages = HostApiContracts.listChannelMessages.response.parse({
    messages: Array.from({ length: 32 }, (_, index) => ({
      id: ChannelEventIdSchema.parse(`evt_longhistory${String(index).padStart(2, '0')}`),
      channelId: targetChannelId,
      role: index % 2 === 0 ? ('member' as const) : ('agent' as const),
      parts: [
        {
          type: 'text' as const,
          text: index === 30 ? overflowProbe : `长记录 ${index + 1}：用于验证消息列表底部不会被输入框遮挡。`,
        },
      ],
      occurredAt: 1_725_001_000_000 + index * 1_000,
      ...(index % 2 === 0 ? {} : { deliveryState: 'sent' as const }),
    })),
    hasMore: false,
  }).messages
  const requestedLimits: number[] = []
  await page.unroute('**/api/channels/*/messages?*')
  await page.route('**/api/channels/*/messages?*', (route) => {
    const url = new URL(route.request().url())
    const channelId = url.pathname.split('/').at(-2)
    const limit = Number(url.searchParams.get('limit'))
    requestedLimits.push(limit)
    const available = channelId === targetChannelId ? longMessages : []
    const messages = available.slice(-limit)
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ messages, hasMore: available.length > messages.length }),
    })
  })
  await page.setViewportSize({ width: 1100, height: 720 })
  await page.goto(`/work/channels/${targetChannelId}`)
  await expect(page.getByText(/长记录 32/u)).toBeVisible()

  const composer = page.locator('[data-channel-composer]').first()
  const messageList = page.locator('[data-channel-message-list]')
  const input = page.getByLabel('消息内容')
  await expect(page.locator('article[data-side]')).toHaveCount(16)
  expect(requestedLimits[0]).toBe(16)
  await expect(page.getByRole('button', { name: '回到底部' })).toHaveCount(0)

  const overflowGeometry = await page.evaluate(() => {
    const list = document.querySelector<HTMLElement>('[data-channel-message-list]')!
    return {
      listClientWidth: list.clientWidth,
      listScrollWidth: list.scrollWidth,
      documentClientWidth: document.documentElement.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      bodyClientWidth: document.body.clientWidth,
      bodyScrollWidth: document.body.scrollWidth,
    }
  })
  expect(overflowGeometry.listScrollWidth).toBeLessThanOrEqual(overflowGeometry.listClientWidth)
  expect(overflowGeometry.documentScrollWidth).toBeLessThanOrEqual(overflowGeometry.documentClientWidth)
  expect(overflowGeometry.bodyScrollWidth).toBeLessThanOrEqual(overflowGeometry.bodyClientWidth)

  await messageList.evaluate((element) => {
    element.scrollTop = Math.max(120, element.scrollHeight / 3)
  })
  await expect(page.getByRole('button', { name: '回到底部' })).toBeVisible()
  await page.getByRole('button', { name: '回到底部' }).click()
  await expect
    .poll(() => messageList.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop))
    .toBeLessThanOrEqual(1)
  await expect(page.getByRole('button', { name: '回到底部' })).toHaveCount(0)
  await messageList.evaluate((element) => {
    element.scrollTop = Math.max(120, element.scrollHeight / 3)
  })
  await expect(page.getByRole('button', { name: '回到底部' })).toBeVisible()
  const rememberedAwayTop = await messageList.evaluate((element) => element.scrollTop)
  await page.getByRole('link', { name: /记录员的内置频道/u }).click()
  await expect(page.getByRole('heading', { name: '记录员的内置频道' })).toBeVisible()
  await expect(page.locator('[data-stage-layer="out"]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '回到底部' })).toHaveCount(0)
  await page.getByRole('link', { name: /资料员的内置频道/u }).click()
  await expect(page.getByRole('heading', { name: '资料员的内置频道' })).toBeVisible()
  await expect(page.locator('[data-stage-layer="out"]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '回到底部' })).toBeVisible()
  expect(
    await page.getByRole('button', { name: '回到底部' }).evaluate((element) => Boolean(element.closest('[inert]'))),
  ).toBe(false)
  expect(
    await page
      .getByRole('button', { name: '回到底部' })
      .evaluate((element) =>
        Boolean(element.closest('[data-channel-canvas-stage]')?.querySelector('[data-channel-message-list]')),
      ),
  ).toBe(true)
  expect(requestedLimits).toEqual([16, 16])
  await expect.poll(() => messageList.evaluate((element) => element.scrollTop)).toBeCloseTo(rememberedAwayTop, 0)
  await page.getByRole('button', { name: '回到底部' }).click()
  await expect
    .poll(() => messageList.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop))
    .toBeLessThanOrEqual(1)
  await expect(page.getByRole('button', { name: '回到底部' })).toHaveCount(0)

  const initialComposerHeight = (await composer.boundingBox())?.height ?? 0
  await input.fill(Array.from({ length: 5 }, (_, index) => `输入内容第 ${index + 1} 行`).join('\n'))
  await expect.poll(async () => (await composer.boundingBox())?.height ?? 0).toBeGreaterThan(initialComposerHeight + 60)

  const geometry = await page.evaluate(() => {
    const list = document.querySelector<HTMLElement>('[data-channel-message-list]')!
    const composer = document.querySelector<HTMLElement>('[data-channel-composer]')!
    const messages = list.querySelectorAll<HTMLElement>('article[data-side]')
    const lastMessage = messages.item(messages.length - 1)
    const lastRect = lastMessage.getBoundingClientRect()
    const composerRect = composer.getBoundingClientRect()
    const listStyle = getComputedStyle(list)
    return {
      lastBottom: lastRect.bottom,
      listBottom: list.getBoundingClientRect().bottom,
      composerTop: composerRect.top,
      composerHeight: composerRect.height,
      paddingBottom: Number.parseFloat(listStyle.paddingBottom),
      scrollTop: list.scrollTop,
      maxScrollTop: list.scrollHeight - list.clientHeight,
    }
  })
  expect(geometry.paddingBottom).toBeGreaterThanOrEqual(24)
  expect(geometry.listBottom).toBeLessThanOrEqual(geometry.composerTop)
  expect(geometry.maxScrollTop - geometry.scrollTop).toBeLessThanOrEqual(1)
  expect(geometry.lastBottom).toBeLessThanOrEqual(geometry.composerTop - 24)
  await capture(page, testInfo, 'channel-long-history-multiline-composer')

  await messageList.evaluate((element) => {
    element.scrollTop = Math.max(120, element.scrollHeight / 3)
  })
  await expect(page.getByRole('button', { name: '回到底部' })).toBeVisible()
  const awayTop = await messageList.evaluate((element) => element.scrollTop)
  await input.fill(Array.from({ length: 12 }, (_, index) => `继续输入第 ${index + 1} 行`).join('\n'))
  await expect.poll(() => messageList.evaluate((element) => element.scrollTop)).toBeCloseTo(awayTop, 0)
  const jumpBox = await page.getByRole('button', { name: '回到底部' }).boundingBox()
  const grownComposerBox = await composer.boundingBox()
  expect((jumpBox?.y ?? 0) + (jumpBox?.height ?? 0)).toBeLessThan(grownComposerBox?.y ?? 0)
  expect(failures, failures.join('\n')).toEqual([])
})
