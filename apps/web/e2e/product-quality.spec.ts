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
const sentEventId = ChannelEventIdSchema.parse('evt_sent')
const resourceIntentId = OutboundIntentIdSchema.parse('out_resources')
const senderMemberId = ChannelMemberIdSchema.parse('mbr_sender')
const targetMemberId = ChannelMemberIdSchema.parse('mbr_target')
const imageAssetId = AssetIdSchema.parse('ast_image')
const fileAssetId = AssetIdSchema.parse('ast_file')

const productSnapshot = HostApiContracts.snapshot.response.parse({
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
  connectionAdapters: [
    {
      key: 'web',
      displayName: '网页聊天',
      description: '网页聊天',
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
  models: [{ provider: 'deepseek', providerName: 'deepseek', id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }],
  agents: [
    {
      id: targetAgentId,
      displayName: '资料员',
      persona: '严谨、简洁',
      currentRevisionId: targetRevisionId,
      createdAt: 1_725_000_000_000,
      runtimeStatus: 'running',
      runtimePhase: 'thinking',
      model: { provider: 'deepseek', model: 'deepseek-v4-flash' },
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
      currentRevisionId: sourceRevisionId,
      createdAt: 1_725_000_000_100,
      runtimeStatus: 'idle',
      model: { provider: 'deepseek', model: 'deepseek-v4-flash' },
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
      displayName: '资料员的网页频道',
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
      displayName: '记录员的网页频道',
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
      revisions: [{ id: summaryRevisionId, revisionNumber: 2, createdAt: 1_725_000_000_000 }],
      activations: [
        {
          agentId: targetAgentId,
          extensionRevisionId: summaryRevisionId,
          config: {},
          activatedAt: 1_725_000_000_000,
        },
      ],
    },
  ],
  dynamic: [
    {
      agentId: targetAgentId,
      episodeId: targetEpisodeId,
      pluginId: 'dynamic-plugin-internal-id',
      packageId: 'dynamic-package-internal-id',
      status: 'running',
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
        },
      ],
      occurredAt: 1_725_000_015_000,
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
                cacheReadTokens: 12_400,
                breakdown: { systemTokens: 8_200, toolsTokens: 12_120, messageTokens: 26_000 },
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
  await page.route(`**/api/channels/${targetChannelId}/assets/${imageAssetId}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'image/svg+xml',
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="180" viewBox="0 0 360 180">
        <rect width="360" height="180" rx="16" fill="#dff6fc"/>
        <rect x="24" y="24" width="312" height="32" rx="8" fill="#0cadd8" opacity=".22"/>
        <rect x="24" y="76" width="196" height="16" rx="8" fill="#007fa6" opacity=".42"/>
        <rect x="24" y="108" width="268" height="12" rx="6" fill="#007fa6" opacity=".2"/>
        <rect x="24" y="136" width="232" height="12" rx="6" fill="#007fa6" opacity=".2"/>
      </svg>`,
    }),
  )
  await page.route(`**/api/channels/${targetChannelId}/assets/${fileAssetId}`, (route) =>
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

const dragHorizontally = async (page: Page, handle: Locator, deltaX: number): Promise<void> => {
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

  for (const viewport of [
    { width: 1100, height: 720 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
  ]) {
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.setViewportSize(viewport)
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
      await page.goto(`/work/channels/${targetChannelId}`)
      await expect(page.getByRole('heading', { name: '资料员的网页频道' })).toBeVisible()
      const headerActionsBox = await page.locator('[data-conversation-header-actions]').boundingBox()
      expect(headerActionsBox?.height ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(36)
      await expect(page.getByText('请复核今天的记录。')).toBeVisible()
      await expect(page.getByRole('img', { name: '界面预览图' })).toBeVisible()
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
        const parent = parentName?.parentElement?.parentElement
        const child = [...document.querySelectorAll('a')].find((node) => node.textContent?.includes('资料员的网页频道'))
        const group = child?.closest('section')
        return {
          parentLeft: parent?.getBoundingClientRect().left ?? 0,
          childLeft: child?.getBoundingClientRect().left ?? 0,
          guide: group ? getComputedStyle(group, '::before').content : 'none',
        }
      })
      expect(hierarchy.childLeft).toBeGreaterThan(hierarchy.parentLeft)
      expect(hierarchy.guide).not.toBe('none')
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
  await page.addInitScript(() => window.localStorage.setItem('nekro-nxt.reduced-motion', 'true'))
  const runtimeReady = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return url.pathname === `/api/channels/${targetChannelId}/runtime` && response.ok()
  })
  await page.goto(`/work/channels/${targetChannelId}`)
  await runtimeReady
  await expect(page.getByRole('heading', { name: '资料员的网页频道' })).toBeVisible()
  await expect(page.locator('[data-conversation-header-actions]').getByText('空闲', { exact: true })).toBeVisible()
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
  await sourceAgentLink.hover()
  await expect(stateIndicator).toHaveCSS('opacity', '0')
  await dragHandle.hover()
  await expect(dragHandle).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await capture(page, testInfo, 'channel-tree-drag-hover')
  await page.mouse.move(700, 700)

  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'no-preference' })
  await page.goto('/settings?tab=appearance')
  await expect(page.getByRole('heading', { name: '外观' })).toBeVisible()
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
    await expect(page.getByRole('heading', { name: '资料员的网页频道' })).toBeVisible()
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
  expect(runningBox?.width ?? 0).toBeLessThan(streamBox?.width ?? Number.POSITIVE_INFINITY)
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
  await expect(inspectorSplitter).toHaveAttribute('aria-valuenow', '360')
  await dragHorizontally(page, inspectorSplitter, -40)
  await expect(inspectorSplitter).toHaveAttribute('aria-valuenow', '400')
  await dragHorizontally(page, inspectorSplitter, 60)
  await expect(inspectorSplitter).toHaveAttribute('aria-valuenow', '340')
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
  await expect(page.getByRole('separator', { name: '调整检查器宽度' })).toHaveAttribute('aria-valuenow', '360')
  await page.getByRole('button', { name: '收起检查器' }).click()
  await expect(page.locator('[class*="inspectorPane"]')).toHaveAttribute('aria-hidden', 'true')
  await expect(page.getByRole('complementary', { name: '频道', includeHidden: true })).toBeHidden()
  await page.reload()
  await expect(page.getByRole('button', { name: '展开检查器' })).toBeVisible()
  await page.getByRole('button', { name: '展开检查器' }).click()
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
  await capture(page, testInfo, 'appearance-reduced-transparency-high-contrast')

  await page.getByRole('button', { name: '恢复默认分栏' }).click()
  await page.goto(`/work/channels/${targetChannelId}`)
  await expect(page.getByRole('separator', { name: '调整对象列宽度' })).toHaveAttribute('aria-valuenow', '240')
  await expect(page.getByRole('separator', { name: '调整检查器宽度' })).toHaveAttribute('aria-valuenow', '360')
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
      await expect(page.getByText('DeepSeek 网页搜索', { exact: true }).first()).toBeVisible()
      await expect(page.locator('[data-dsh-native-surface]')).toBeVisible()
      await expect(page.locator('[data-dsh-native-surface]')).toContainText(/Web search|网页搜索/u)
      await assertViewportIntegrity(page)
      await capture(page, testInfo, `dsh-native-${viewport.width}x${viewport.height}-${colorScheme}`)

      await page.getByRole('tab', { name: '通用配置' }).click()
      await expect(page.getByText('Namespace：web-search-deepseek', { exact: true })).toBeVisible()
      await expect(page.getByLabel('新的凭据值')).toBeVisible()
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
  await expect(page.locator('article[data-side="left"]').first()).toContainText('请和')
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
      text: '完整文件访问',
      width: 1100,
      height: 720,
      colorScheme: 'dark',
    },
    {
      route: '/connections',
      text: '网页聊天由当前设备管理，不需要配置账号凭据。',
      width: 1440,
      height: 900,
      colorScheme: 'light',
    },
    { route: '/work/creator', text: '与资料员协作创造', width: 1920, height: 1080, colorScheme: 'dark' },
    { route: '/extensions', text: '贡献能力', width: 1920, height: 1080, colorScheme: 'light' },
  ] as const

  for (const scene of scenes) {
    await page.setViewportSize({ width: scene.width, height: scene.height })
    await page.emulateMedia({ colorScheme: scene.colorScheme, reducedMotion: 'reduce' })
    await page.goto(scene.route)
    await expect(page.getByText(scene.text).first()).toBeVisible()
    if (scene.route === '/connections') {
      await expect(page.getByText('平台账号', { exact: true })).toBeVisible()
      await expect(page.getByRole('heading', { name: '网页聊天' })).toBeVisible()
      await expect(page.getByText('连接', { exact: true })).toHaveCount(0)
    }
    if (scene.route === '/extensions') {
      await expect(page.getByText('本地扩展', { exact: true })).toBeVisible()
      await expect(page.getByRole('heading', { name: '群聊摘要' })).toBeVisible()
      await expect(page.getByText('扩展', { exact: true })).toHaveCount(0)
    }
    if (scene.route.startsWith('/work/agents/')) {
      const sectionWidths = await page
        .locator('section[id^="agent-"]')
        .evaluateAll((sections) => sections.map((section) => section.getBoundingClientRect().width))
      expect(Math.max(...sectionWidths) - Math.min(...sectionWidths)).toBeLessThanOrEqual(1)
    }
    await assertViewportIntegrity(page)
    await capture(
      page,
      testInfo,
      `redesign-${scene.route.split(/[/?]/u).filter(Boolean).join('-')}-${scene.colorScheme}`,
    )
  }

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
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await page.goto('/extensions')
  await expect(page.getByText('本地扩展', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: '扩展库' })).toBeVisible()
  await expect(page.getByText('从一次动态运行开始')).toBeVisible()
  await expect(page.getByText('还没有本地扩展', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '打开创造工作台' })).toBeVisible()
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
              { name: 'root' },
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

  await page.goto('/work/creator')
  await page.getByRole('button', { name: '审查界面预览' }).click()
  await page.getByRole('dialog').getByRole('button', { name: '允许本次预览' }).click()
  await expect(page.getByText('即时界面已真实加载')).toBeVisible()
  expect(calls).toEqual(['run-host-half', 'get-client-code', 'approve'])

  phase = 'stopped'
  releaseStatus()
  await expect(page.getByText('即时界面已真实加载')).toBeHidden()
  await expect(page.getByText('已停止', { exact: true }).first()).toBeVisible()
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
  await page.getByRole('switch', { name: '动态创造' }).click()
  await page.getByRole('switch', { name: '开发命令' }).click()
  await capture(page, testInfo, 'agent-create-confirmation')
  await page.getByRole('button', { name: '创建智能体' }).click()
  await expect(page).toHaveURL(new RegExp(`/work/channels/${targetChannelId}$`, 'u'))
  expect(submitted).toEqual({
    displayName: '研究员',
    persona: '先核对证据，再给出结论。',
    model: { provider: 'deepseek', model: 'deepseek-v4-flash' },
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
  await installProductRoutes(page)
  await page.setViewportSize({ width: 1100, height: 720 })
  await page.goto('/work')

  const topBar = page.locator('[data-window-top-bar]')
  const pane = page.locator('aside[aria-label="对象列"]')
  expect((await topBar.boundingBox())?.height).toBe(48)
  await expect(topBar).toHaveText('NekroNxt')
  await expect(pane).toBeVisible()
  await expect(page.getByRole('button', { name: /收起对象列|展开对象列/u })).toHaveCount(0)
  await expect(page.getByRole('separator', { name: '调整对象列宽度' })).toBeVisible()
  const themeButton = page.getByRole('button', { name: /^主题：/u })
  await expect(themeButton).toBeVisible()
  await themeButton.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await themeButton.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await themeButton.click()
  await expect(page.locator('html')).not.toHaveAttribute('data-theme')
  await expect(page.locator('[class*="railHostDot"]')).toHaveCount(0)
  await capture(page, testInfo, 'desktop-object-pane-stable')

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
  await palette.getByLabel('搜索命令').fill('资料员的网页频道')
  await palette.getByLabel('搜索命令').press('ArrowDown')
  await expect(palette.getByRole('button', { name: /资料员的网页频道/u })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(new RegExp(`/work/channels/${targetChannelId}$`, 'u'))
  expect(failures, failures.join('\n')).toEqual([])
})

test('an initial Host failure is explicit and can recover without reloading', async ({ page }) => {
  const failures = installRuntimeFailureGate(page)
  let healthy = false
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
  await page.goto('/work')
  await expect(page.getByText('无法连接', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('还没有智能体', { exact: true }).first()).toBeVisible()
  healthy = true
  await page.getByRole('button', { name: '重新连接' }).last().click()
  await expect(page.getByText('无法连接', { exact: true }).first()).toBeHidden()
  await expect(page.getByRole('link', { name: /资料员/u }).first()).toBeVisible()
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
  const longMessages = HostApiContracts.listChannelMessages.response.parse({
    messages: Array.from({ length: 32 }, (_, index) => ({
      id: ChannelEventIdSchema.parse(`evt_longhistory${String(index).padStart(2, '0')}`),
      channelId: targetChannelId,
      role: index % 2 === 0 ? ('member' as const) : ('agent' as const),
      parts: [
        {
          type: 'text' as const,
          text:
            index === 30
              ? '长记录 31：这是一段较长的后台用户消息，用于检查右侧消息面在连续中文、多行换行和较宽桌面画布中仍然贴合内容，不会扩成横贯画布的大卡片。'
              : `长记录 ${index + 1}：用于验证消息列表底部不会被输入框遮挡。`,
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
  await page.getByRole('link', { name: /记录员的网页频道/u }).click()
  await expect(page.getByRole('heading', { name: '记录员的网页频道' })).toBeVisible()
  await expect(page.locator('[data-stage-layer="out"]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '回到底部' })).toHaveCount(0)
  await page.getByRole('link', { name: /资料员的网页频道/u }).click()
  await expect(page.getByRole('heading', { name: '资料员的网页频道' })).toBeVisible()
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
