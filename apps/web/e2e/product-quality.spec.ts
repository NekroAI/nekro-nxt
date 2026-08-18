import { expect, test, type Page, type TestInfo } from '@playwright/test'
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
      platformChannelId: 'group:9CC4F6A7D6FE',
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
      knownChannels: [{ id: qqChannelId, name: 'group:9CC4F6A7D6FE', kind: 'group' }],
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
        { type: 'text', text: '请和' },
        { type: 'mention', memberId: targetMemberId, displayName: '成员乙' },
        { type: 'text', text: '一起复核。' },
      ],
      occurredAt: 1_725_000_010_000,
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
    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      mainHeight: main?.height ?? 0,
      overlaps: sidebar && main ? sidebar.right > main.left + 1 : false,
    }
  })
  expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth)
  expect(geometry.bodyWidth).toBeLessThanOrEqual(geometry.viewportWidth)
  expect(geometry.mainHeight).toBeGreaterThanOrEqual(geometry.viewportHeight - 1)
  expect(geometry.overlaps).toBe(false)
}

const capture = async (page: Page, testInfo: TestInfo, name: string): Promise<void> => {
  const path = testInfo.outputPath(`${name}.png`)
  await page.screenshot({ path, animations: 'disabled' })
  await testInfo.attach(name, { path, contentType: 'image/png' })
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
      await page.goto(`/channels/${targetChannelId}`)
      await expect(page.getByRole('heading', { name: '资料员的网页频道' })).toBeVisible()
      await expect(page.getByText('请复核今天的记录。')).toBeVisible()
      await expect(page.getByRole('img', { name: '界面预览图' })).toBeVisible()
      await expect
        .poll(() =>
          page.getByRole('img', { name: '界面预览图' }).evaluate((image: HTMLImageElement) => image.naturalWidth),
        )
        .toBeGreaterThan(0)
      await expect(page.getByRole('link', { name: /验收记录\.txt/u })).toBeVisible()
      await expect(page.getByLabel('消息内容')).toBeVisible()
      const hierarchy = await page.evaluate(() => {
        const parentName = [...document.querySelectorAll('strong')].find((node) => node.textContent === '资料员')
        const parent = parentName?.parentElement?.parentElement
        const child = [...document.querySelectorAll('a')].find((node) => node.textContent?.includes('资料员的网页频道'))
        const group = parent?.parentElement
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
      await capture(page, testInfo, `channel-${viewport.width}x${viewport.height}-${colorScheme}`)
    }
  }

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

test('group conversations preserve sender and Mention semantics without exposing internal identities', async ({
  page,
}, testInfo) => {
  const failures = installRuntimeFailureGate(page)
  await installProductRoutes(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/channels/${qqChannelId}`)

  await expect(page.getByText('成员甲', { exact: true })).toBeVisible()
  await expect(page.getByText('@机器人账号 请和 @成员乙 一起复核。', { exact: true })).toBeVisible()
  const visibleText = await page.locator('body').innerText()
  expect(visibleText).not.toContain(senderMemberId)
  expect(visibleText).not.toContain(targetMemberId)
  expect(visibleText).not.toContain('group:9CC4F6A7D6FE')
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
    { route: '/agents', text: '当前概览', width: 1440, height: 900, colorScheme: 'light' },
    {
      route: `/agents/${targetAgentId}?tab=capabilities`,
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
    { route: '/creator', text: '与资料员协作创造', width: 1920, height: 1080, colorScheme: 'dark' },
    { route: '/extensions', text: '贡献能力', width: 1920, height: 1080, colorScheme: 'light' },
  ] as const

  for (const scene of scenes) {
    await page.setViewportSize({ width: scene.width, height: scene.height })
    await page.emulateMedia({ colorScheme: scene.colorScheme, reducedMotion: 'reduce' })
    await page.goto(scene.route)
    await expect(page.getByText(scene.text).first()).toBeVisible()
    await assertViewportIntegrity(page)
    await capture(
      page,
      testInfo,
      `redesign-${scene.route.split(/[/?]/u).filter(Boolean).join('-')}-${scene.colorScheme}`,
    )
  }

  await page.goto('/connections')
  await page
    .getByRole('button', { name: /QQ 机器人账号/u })
    .first()
    .click()
  await expect(page.getByText('QQ 群聊（尾号 D6FE）')).toBeVisible()
  const connectionText = await page.locator('body').innerText()
  expect(connectionText).not.toContain('group:9CC4F6A7D6FE')
  expect(connectionText).not.toContain('QQ 群聊（尾号 D6FE） · 群聊')
  await capture(page, testInfo, 'redesign-connection-qq-light')
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

  await page.goto('/creator')
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

test('the four-step creation wizard submits identity, model, and explicit capabilities', async ({ page }, testInfo) => {
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
  await page.goto('/agents')
  await page.getByRole('button', { name: '创建智能体' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('名称').fill('研究员')
  await dialog.getByLabel('人设').fill('先核对证据，再给出结论。')
  await dialog.getByRole('button', { name: '下一步' }).click()
  await expect(dialog.getByText('DeepSeek V4 Flash')).toBeVisible()
  await dialog.getByRole('button', { name: '下一步' }).click()
  await dialog.getByRole('switch', { name: '动态创造' }).click()
  await dialog.getByRole('switch', { name: '开发命令' }).click()
  await dialog.getByRole('button', { name: '下一步' }).click()
  await expect(dialog.getByText('子智能体、动态创造、开发命令', { exact: true })).toBeVisible()
  await capture(page, testInfo, 'agent-create-confirmation')
  await dialog.getByRole('button', { name: '创建并打开频道' }).click()
  await expect(page).toHaveURL(new RegExp(`/channels/${targetChannelId}$`, 'u'))
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
  await page.goto('/agents')
  await expect(page.getByText('无法连接', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('还没有智能体', { exact: true })).toBeVisible()
  healthy = true
  await page.getByRole('button', { name: '重新连接' }).last().click()
  await expect(page.getByText('运行正常', { exact: true })).toBeVisible()
  await expect(page.getByText('资料员', { exact: true })).toBeVisible()
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

  const opener = page.getByRole('button', { name: '添加连接' }).first()
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

  await page.goto(`/agents/${targetAgentId}`)
  await page.getByRole('tab', { name: '频道' }).click()
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

  await page.goto(`/channels/${targetChannelId}`)
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
