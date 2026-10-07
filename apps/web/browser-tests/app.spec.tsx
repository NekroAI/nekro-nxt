import { recordLabels } from '../src/app/workshop/workshop-model.js'
import { fixtureReleaseId, installSnapshotHealthRoutes } from '../e2e/fixtures/host-release.js'
import {
  AgentIdSchema,
  AgentRevisionIdSchema,
  ChannelEventIdSchema,
  ChannelIdSchema,
  ConnectionIdSchema,
  EpisodeIdSchema,
  ExtensionIdSchema,
  ExtensionRevisionIdSchema,
  HostApiContracts,
  HostUiPageEntrySchema,
} from '@nekro-nxt/contracts'
import { chromium, expect, expect as playwrightExpect, test, type Browser, type Page } from '@playwright/test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, type ViteDevServer } from 'vite'
const wechatConnectionId = ConnectionIdSchema.parse('con_wechatilink')
const wechatIlinkConfigSchema = {
  type: 'object',
  dict: {
    enableInboundMedia: {
      type: 'boolean',
      meta: {
        description: '入站媒体接收',
        hint: '开启后，收到的图片和文件会下载并导入为频道资源。',
        default: true,
      },
    },
  },
} as const

const browserAgentId = AgentIdSchema.parse('agt_verylongtechnicalid')
const browserRevisionId = AgentRevisionIdSchema.parse('arev_technicalid')
const browserChannelId = ChannelIdSchema.parse('chn_webmain')
const emptyChannelId = ChannelIdSchema.parse('chn_empty')
const externalChannelId = ChannelIdSchema.parse('chn_external')
const browserConnectionId = ConnectionIdSchema.parse('con_webinternal')
const externalConnectionId = ConnectionIdSchema.parse('con_external')
const browserExtensionId = ExtensionIdSchema.parse('ext_internal')
const browserExtensionRevisionId = ExtensionRevisionIdSchema.parse('xrv_internal')
const browserExtensionPreviousRevisionId = ExtensionRevisionIdSchema.parse('xrv_previous')
const browserEpisodeId = EpisodeIdSchema.parse('eps_browser')
const browserEventId = ChannelEventIdSchema.parse('evt_current')
const otherEventId = ChannelEventIdSchema.parse('evt_other')
const hostUiPage = (id: string, visible = true) =>
  HostUiPageEntrySchema.parse({
    pageInstanceId: `hup_${id}`,
    owner: { kind: 'extension', extensionId: browserExtensionId, revisionId: browserExtensionRevisionId },
    entryId: id,
    title: id,
    icon: { kind: 'host-icon', name: 'puzzle' },
    objectPane: 'hidden',
    startPath: '',
    visible,
    sortOrder: 0,
    routeBase: `/apps/hup_${id}`,
    client: { moduleUrl: `/host-ui/${id}.mjs`, buildKey: 'a'.repeat(64) },
    createdAt: 1,
    updatedAt: 1,
  })
const browserSnapshot = HostApiContracts.snapshot.response.parse({
  cursor: { epoch: 'fixture', sequence: 0 },
  diagnosticsSampledAt: 0,
  productMetadata: {
    displayName: 'NekroNXT',
    organizationName: 'NekroAI',
    version: '0.0.0',
    releaseId: fixtureReleaseId,
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
  connectionAdapters: [
    {
      key: 'fixture-alpha',
      displayName: '内置频道',
      description: '内置频道',
      provisioning: 'system-singleton',
      channelKinds: ['internal'],
      activities: [],
      features: {},
      aliasEditable: false,
      channelDiscovery: 'host-created',
      diagnostics: { receive: false, send: false },
      configSchema: { type: 'object', dict: {} },
    },
    {
      key: 'fixture-beta',
      displayName: '示例群聊平台',
      description: '连接示例群聊平台账号',
      provisioning: 'user-created',
      channelKinds: ['direct', 'group'],
      activities: [],
      features: {},
      aliasEditable: true,
      channelDiscovery: 'adapter-observed',
      diagnostics: { receive: true, send: true },
      configSchema: { type: 'object', dict: {} },
    },
  ],
  notificationSettings: {
    system: { enabled: true },
    bark: { enabled: false, serverUrl: 'https://api.day.app', deviceKeyConfigured: false },
    events: { 'dynamic-client-approval-requested': true },
  },
  models: [{ provider: 'openai', providerName: 'OpenAI', id: 'gpt-5', name: 'GPT-5' }],
  agents: [
    {
      id: browserAgentId,
      displayName: '资料员',
      persona: '严谨、简洁',
      personaDocument: { version: 1, segments: [{ type: 'text', text: '严谨、简洁' }] },
      currentRevisionId: browserRevisionId,
      createdAt: 1_725_000_000_000,
      runtimeStatus: 'idle',
      model: { provider: 'openai', model: 'gpt-5' },
      dynamicClientApprovalPolicy: 'manual',
      imagePolicy: {
        history: {
          mode: 'persistent-distinct',
          detail: 'auto',
          restoreAfterCompaction: { recentMessages: 32, maxImages: 20 },
        },
        textModel: { mode: 'disabled' },
      },
      imageDiagnostics: {
        route: { mode: 'unavailable' },
        activeSessions: 0,
        residentImages: 0,
        duplicateImagesSkipped: 0,
        blockers: ['主模型没有声明图片输入能力，且未配置辅助视觉模型。'],
      },
      capabilities: {
        subagents: false,
        fileTools: false,
        webSearch: false,
        dynamicCreation: true,
        developmentShell: false,
        unrestrictedFileAccess: false,
      },
      channels: [browserChannelId, emptyChannelId],
    },
  ],
  channels: [
    {
      id: browserChannelId,
      connectionId: browserConnectionId,
      platformChannelId: 'internal-main-platform-id',
      kind: 'internal',
      displayName: '资料员对话',
      boundAgentId: browserAgentId,
      bindings: [
        {
          channelId: browserChannelId,
          agentId: browserAgentId,
          triggerPolicy: 'always',
          boundAt: 1_725_000_000_000,
        },
      ],
    },
    {
      id: emptyChannelId,
      connectionId: browserConnectionId,
      platformChannelId: 'empty-platform-id',
      kind: 'internal',
      displayName: '空频道',
      boundAgentId: browserAgentId,
      bindings: [
        {
          channelId: emptyChannelId,
          agentId: browserAgentId,
          triggerPolicy: 'always',
          boundAt: 1_725_000_000_100,
        },
      ],
    },
    {
      id: externalChannelId,
      connectionId: externalConnectionId,
      platformChannelId: 'opaque-group-alpha',
      kind: 'group',
      displayName: '产品讨论群',
      boundAgentId: browserAgentId,
      bindings: [
        {
          channelId: externalChannelId,
          agentId: browserAgentId,
          triggerPolicy: 'mentioned-or-replied',
          boundAt: 1_725_000_000_200,
        },
      ],
    },
  ],
  messages: [
    {
      id: browserEventId,
      channelId: browserChannelId,
      role: 'member',
      parts: [{ type: 'text', text: '只属于当前频道' }],
      occurredAt: 1_725_000_000_000,
    },
    {
      id: otherEventId,
      channelId: externalChannelId,
      role: 'member',
      parts: [{ type: 'text', text: '不能混入当前频道' }],
      occurredAt: 1_725_000_001_000,
    },
  ],
  connections: [
    {
      id: browserConnectionId,
      adapterKey: 'fixture-alpha',
      status: { state: 'connected', proactiveSend: false, credentialConfigured: true, activities: {} },
      channelCount: 2,
      knownChannels: [],
    },
    {
      id: externalConnectionId,
      adapterKey: 'fixture-beta',
      status: {
        state: 'connected',
        proactiveSend: true,
        credentialConfigured: true,
        accountReference: '1234567890',
        activities: {},
      },
      channelCount: 1,
      knownChannels: [{ id: externalChannelId, name: '产品讨论群', kind: 'group' }],
      receiveTest: { status: 'received', channelId: externalChannelId, platformMessageId: 'fixture-received' },
    },
  ],
  extensions: [
    {
      id: browserExtensionId,
      slug: 'document-review',
      displayName: '文档复核',
      description: '检查文档中的遗漏',
      createdByAgentId: browserAgentId,
      scope: 'agent',
      revisions: [
        {
          id: browserExtensionPreviousRevisionId,
          revisionNumber: 2,
          createdAt: 1_724_000_000_000,
          scope: 'agent',
          contributions: ['工具：legacy_review'],
          verification: {
            verifiedAt: 1_724_000_000_000,
            dshVersion: '0.1.1-rc.2',
            contractVersion: 'nekro-nxt-extension-v1',
            hostBuilt: true,
            clientBuilt: false,
            buildKey: 'b'.repeat(64),
            toolInvocationCount: 0,
            rpcMethods: [],
            renderedPanels: [],
            renderedToolViews: [],
            renderedMessageRenderers: [],
          },
        },
        {
          id: browserExtensionRevisionId,
          revisionNumber: 3,
          createdAt: 1_725_000_000_000,
          scope: 'agent',
          contributions: ['工具：document_review'],
          verification: {
            verifiedAt: 1_725_000_000_000,
            dshVersion: '0.1.1-rc.2',
            contractVersion: 'nekro-nxt-extension-v1',
            hostBuilt: true,
            clientBuilt: false,
            buildKey: 'a'.repeat(64),
            toolInvocationCount: 1,
            rpcMethods: [],
            renderedPanels: [],
            renderedToolViews: [],
            renderedMessageRenderers: [],
          },
        },
      ],
      activations: [
        {
          agentId: browserAgentId,
          extensionRevisionId: browserExtensionRevisionId,
          config: {},
          activatedAt: 1_725_000_000_000,
        },
      ],
      clientDiagnostics: [],
    },
  ],
  dynamic: [
    {
      agentId: browserAgentId,
      episodeId: browserEpisodeId,
      pluginId: 'technical-plugin-id',
      packageId: 'technical-package-id',
      approvalRequestId: 'approval-internal-id',
      status: 'awaiting-approval',
      packages: [
        {
          packageId: 'technical-package-id',
          name: '技术探针',
          purpose: '验证动态界面审批。',
          hasHostHalf: false,
          hasClientHalf: true,
        },
      ],
      policy: { turn: 1, consecutiveFailures: 0, repeatedFingerprintCount: 0 },
    },
  ],
})
const providerSettingsSnapshot = {
  writable: true,
  protocols: ['openai-completions'],
  providers: [
    {
      provider: 'openai',
      displayName: 'OpenAI',
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'openai'],
      settingsRevision: 2,
      declared: false,
      active: true,
      configured: true,
      credential: { configured: true, writable: true },
      models: [{ id: 'gpt-5', name: 'GPT-5' }],
      modelsCustomized: false,
      discoverable: true,
    },
  ],
} as const

const memberDirectory = {
  total: 1,
  items: [
    {
      identityId: 'pid_membera',
      displayName: '成员甲',
      adapter: { key: 'fixture-beta', displayName: '示例群聊平台' },
      connection: { id: externalConnectionId, displayName: '示例群聊平台' },
      activeChannelCount: 1,
      channelPreview: [{ id: externalChannelId, displayName: '产品讨论群', kind: 'group' }],
      historicalOnly: false,
    },
  ],
  facets: {
    adapters: [{ key: 'fixture-beta', displayName: '示例群聊平台', userCount: 1 }],
    connections: [{ id: externalConnectionId, adapterKey: 'fixture-beta', displayName: '示例群聊平台', userCount: 1 }],
  },
} as const

/**
 * Workspace read models every space may load. Anything not stubbed fails the test instead of falling through the
 * Vite proxy to a developer's real Host.
 */
const installWorkspaceStubs = async (page: Page): Promise<void> => {
  await page.route('**/api/**', (route) =>
    route.fulfill({
      status: 501,
      contentType: 'application/json',
      body: JSON.stringify({
        error: {
          code: 'unstubbed',
          message: `未模拟的接口：${route.request().method()} ${new URL(route.request().url()).pathname}`,
        },
      }),
    }),
  )
  await page.route('**/api/attention', (route) => route.fulfill({ json: { revision: 'fixture', items: [] } }))
  await page.route('**/api/activity*', (route) =>
    route.fulfill({ json: { from: 0, to: 7_200_000, bucketMs: 300_000, channels: [] } }),
  )
  await page.route('**/api/channels/*/read', (route) => {
    const channelId = new URL(route.request().url()).pathname.split('/')[3]
    return route.fulfill({ json: { channelId, activity: { unreadCount: 0, unreadCapped: false } } })
  })
  await page.route('**/api/channels/*/pending', (route) => {
    const channelId = new URL(route.request().url()).pathname.split('/')[3]
    return route.fulfill({ json: { channelId, items: [] } })
  })
  await page.route('**/api/agents/*/revisions', (route) =>
    route.fulfill({
      json: {
        agentId: browserAgentId,
        currentRevisionId: browserRevisionId,
        revisions: [
          {
            id: browserRevisionId,
            revision: 1,
            createdAt: 1_725_000_000_000,
            displayName: '资料员',
            model: { provider: 'openai', model: 'gpt-5' },
            changedFields: [],
            current: true,
          },
        ],
      },
    }),
  )
  await page.route('**/api/authoring/tasks/*', (route) =>
    route.fulfill({ json: { task: workshopTask, attempts: [workshopTask.candidateAttempt], events: [] } }),
  )
  await page.route('**/api/channels/*/messages?*', (route) =>
    route.fulfill({ json: { cursor: { epoch: 'fixture', sequence: 0 }, messages: [], hasMore: false } }),
  )
  await page.route('**/api/channels/*/runtime', (route) => {
    const channelId = new URL(route.request().url()).pathname.split('/')[3]
    return route.fulfill({
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
  await page.route('**/api/dsh/plugins', (route) => route.fulfill({ json: { plugins: [] } }))
  await page.route('**/api/dsh/settings', (route) => route.fulfill({ json: { namespaces: [] } }))
}

const workshopTask = {
  id: 'aut_fixturetask',
  agentId: browserAgentId,
  channelId: browserChannelId,
  episodeId: browserEpisodeId,
  title: '技术探针',
  requirementSummary: '验证动态界面审批。',
  status: 'awaiting-approval',
  approvalPolicy: 'risk-stable',
  revision: 2,
  candidateAttempt: {
    id: 'aua_fixtureattempt',
    ordinal: 1,
    name: '技术探针',
    purpose: '验证动态界面审批。',
    state: 'awaiting-approval',
    riskDigest: 'e'.repeat(64),
    host: { status: 'absent', waitingFor: [] },
    client: { status: 'pending', waitingFor: [] },
    createdAt: 1_725_000_000_000,
  },
  createdAt: 1_725_000_000_000,
  updatedAt: 1_725_000_000_000,
} as const

const wechatAdapter = {
  key: 'wechat-ilink',
  displayName: '微信 iLink',
  description: '接收微信私聊文本消息',
  provisioning: 'user-created',
  aliasEditable: true,
  channelDiscovery: 'adapter-observed',
  channelKinds: ['direct'],
  activities: [],
  features: {},
  diagnostics: { receive: true, send: true },
  creation: { mode: 'qr-login', actionLabel: '扫码登录', pendingLabel: '等待扫码确认…' },
  configSchema: wechatIlinkConfigSchema,
} as const

const wechatLogin = {
  loginId: 'login-fixture',
  adapterKey: 'wechat-ilink',
  status: 'pending',
  qrCodeUrl: 'https://qr.example.invalid/login-fixture',
  message: '请使用平台应用扫码并确认登录。',
} as const

test.describe('NekroNxt browser projections', () => {
  test.describe.configure({ mode: 'default', timeout: 30_000 })
  let server: ViteDevServer
  let browser: Browser
  let baseUrl: string
  let cacheDirectory: string

  test.beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), 'nekro-app-spec-'))
    server = await createServer({
      root: fileURLToPath(new URL('..', import.meta.url)),
      configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
      cacheDir: cacheDirectory,
      logLevel: 'silent',
      // Vite treats `port: 0` as unset and falls back to 5173; inherit the product
      // config's `strictPort: true` would then fail when another local Vite is up.
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

  const withProductPage = async (
    route: string,
    verify: (page: Page) => Promise<void>,
    snapshot: unknown = browserSnapshot,
    setup?: (page: Page) => Promise<void>,
  ): Promise<void> => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    const runtimeErrors: string[] = []
    page.on('pageerror', (error) => runtimeErrors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') {
        const location = message.location().url
        runtimeErrors.push(location ? `${message.text()} (${location})` : message.text())
      }
    })
    const parsedSnapshot = HostApiContracts.snapshot.response.parse(snapshot)
    await installWorkspaceStubs(page)
    await installSnapshotHealthRoutes(page, parsedSnapshot)
    await page.route('**/api/snapshot', (request) =>
      request.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(parsedSnapshot) }),
    )
    await page.route('**/api/events', (request) =>
      request.fulfill({ status: 200, contentType: 'text/event-stream', body: '' }),
    )
    await page.route('**/api/channels/*/runtime', (request) => {
      const channelId = new URL(request.request().url()).pathname.split('/')[3]
      const channel = parsedSnapshot.channels.find((item) => item.id === channelId)
      return request.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          cursor: { epoch: 'fixture', sequence: 0 },
          channelId,
          ...(channel?.boundAgentId === undefined ? {} : { agentId: channel.boundAgentId }),
          phase: channel?.runtimePhase ?? 'idle',
          summary: channel?.boundAgentId ? '智能体当前空闲。' : '尚未绑定智能体。',
          pendingInjectCount: 0,
          occupancy:
            channelId === browserChannelId
              ? {
                  projectedTokens: 3200,
                  contextWindow: 128_000,
                  breakdown: { systemTokens: 400, toolsTokens: 900, messageTokens: 1900 },
                }
              : undefined,
          cache:
            channelId === browserChannelId
              ? {
                  scope: 'episode',
                  aggregate: {
                    usageRequestCount: 2,
                    observedRequestCount: 2,
                    shareRequestCount: 2,
                    hitRequestCount: 2,
                    uncachedInputTokens: 1400,
                    cacheReadTokens: 1800,
                    cacheWriteTokens: 0,
                    averageRequestReadShare: 0.55,
                  },
                  recent: {
                    windowSize: 12,
                    samples: [
                      { turn: 1, step: 0, uncachedInputTokens: 800, cacheReadTokens: 800 },
                      { turn: 1, step: 1, uncachedInputTokens: 600, cacheReadTokens: 1000 },
                    ],
                  },
                }
              : undefined,
          performance:
            channelId === browserChannelId
              ? {
                  scope: 'episode',
                  aggregate: {
                    steps: 2,
                    llmMs: 4200,
                    toolMs: 900,
                    ttftMs: 1100,
                    ttftSteps: 2,
                    decodeMs: 3000,
                    decodeTokens: 120,
                    decodeSteps: 2,
                    retryCount: 1,
                    retryDelayMs: 500,
                  },
                  recent: {
                    windowSize: 12,
                    samples: [
                      { turn: 1, step: 0, firstTokenMs: 700, decodeMs: 2000, outputTokens: 70 },
                      { turn: 1, step: 1, firstTokenMs: 400, decodeMs: 1000, outputTokens: 50 },
                    ],
                  },
                }
              : undefined,
          turns:
            channelId === browserChannelId
              ? [
                  {
                    turn: 1,
                    startedAt: 1_725_000_000_500,
                    endedAt: 1_725_000_003_000,
                    state: 'completed',
                    producedReply: true,
                    responseState: 'sent',
                    steps: [
                      {
                        step: 1,
                        internalOutput: { kind: 'internal-output', text: '先核对公告。' },
                        tools: [
                          {
                            callId: 'call_read',
                            name: 'read_file',
                            displayName: '读取文件',
                            state: 'succeeded',
                            inputPreview: '活动公告.docx',
                            resultPreview: '19:30',
                          },
                          {
                            callId: 'call_send',
                            name: 'send_channel_message',
                            displayName: '发送频道消息',
                            state: 'succeeded',
                            wroteToChannel: true,
                            inputPreview: '活动改到 19:30。',
                            resultPreview: 'sent',
                          },
                        ],
                      },
                    ],
                  },
                  {
                    turn: 2,
                    startedAt: 1_725_000_004_000,
                    endedAt: 1_725_000_005_000,
                    state: 'completed',
                    producedReply: false,
                    responseState: 'not-required',
                    steps: [
                      {
                        step: 1,
                        internalOutput: { kind: 'internal-output', text: '继续核对下一则公告。' },
                        tools: [],
                      },
                    ],
                  },
                ]
              : [],
        }),
      })
    })
    await page.route('**/api/channels/*/messages?*', (request) => {
      const channelId = new URL(request.request().url()).pathname.split('/')[3]
      const messages = parsedSnapshot.messages.filter((message) => message.channelId === channelId)
      return request.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ cursor: { epoch: 'fixture', sequence: 0 }, messages, hasMore: false }),
      })
    })
    await page.route('**/api/dynamic/*/inventory', (request) =>
      request.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ rows: [] }) }),
    )
    // Product pages can preload these directories even when a scenario does
    // not interact with them. Keep the browser fixture self-contained instead
    // of falling through to Vite's local-development proxy. Scenario routes
    // registered by `setup` run first and can still override these defaults.
    await page.route('**/api/llm/providers', (request) =>
      request.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(providerSettingsSnapshot),
      }),
    )
    await page.route('**/api/platform-users*', (request) => {
      const query = new URL(request.request().url()).searchParams.get('query') ?? ''
      return request.fulfill({
        json:
          query && !'成员甲'.includes(query)
            ? { total: 0, items: [], facets: memberDirectory.facets }
            : memberDirectory,
      })
    })
    await setup?.(page)
    try {
      await page.goto(`${baseUrl}${route}`)
      await page.locator('#root').waitFor({ state: 'visible' })
      await verify(page)
      expect(runtimeErrors).toEqual([])
    } finally {
      await page.close()
    }
  }

  /** Reads a value the page's init script left on `window`. */
  const windowValue = (page: Page, name: string): Promise<unknown> =>
    page.evaluate((key): unknown => Reflect.get(window, key), name)
  /** Calls a callback the page's init script left on `window`. */
  const callWindow = (page: Page, name: string, argument: unknown): Promise<void> =>
    page.evaluate(
      ([key, value]) => {
        const callback: unknown = Reflect.get(window, key)
        if (typeof callback === 'function') Reflect.apply(callback, undefined, [value])
      },
      [name, argument] as const,
    )

  const desktopShell = async (page: Page, script: string): Promise<void> => {
    await page.addInitScript(script)
  }

  test('keeps the Desktop service-instance entry in the top bar across spaces and toggles the switcher', async () => {
    await withProductPage(
      '/',
      async (page) => {
        const instanceButton = page.getByRole('button', { name: /^管理并添加远程服务实例：远程开发环境/u })
        await playwrightExpect(page).toHaveURL(/\/live$/u)
        await playwrightExpect(instanceButton).toHaveAccessibleName('管理并添加远程服务实例：远程开发环境 · 运行正常')

        await page.getByRole('link', { name: '接线' }).click()
        await playwrightExpect(page).toHaveURL(/\/wiring/u)
        await playwrightExpect(instanceButton).toBeVisible()

        await page.getByRole('link', { name: '设置' }).click()
        await playwrightExpect(page).toHaveURL(/\/settings\/models$/u)
        await playwrightExpect(instanceButton).toBeVisible()
        await instanceButton.click()
        await playwrightExpect.poll(() => windowValue(page, '__instanceSwitcherOpenCount')).toBe(1)
        await playwrightExpect(instanceButton).toHaveAttribute('aria-expanded', 'true')
        await instanceButton.click()
        await playwrightExpect(instanceButton).toHaveAttribute('aria-expanded', 'false')
        await playwrightExpect.poll(() => windowValue(page, '__instanceSwitcherCloseCount')).toBe(1)
        await playwrightExpect.poll(() => windowValue(page, '__instanceSwitcherOpenCount')).toBe(1)
      },
      browserSnapshot,
      (page) =>
        desktopShell(
          page,
          `(() => {
            window.__instanceSwitcherOpenCount = 0
            window.__instanceSwitcherCloseCount = 0
            Object.defineProperty(window, 'nekroDesktopShell', {
              configurable: true,
              value: {
                getCurrentInstancePresentation: () =>
                  Promise.resolve({ revision: 1, displayName: '远程开发环境', status: 'ready' }),
                openInstanceSwitcher: () => {
                  window.__instanceSwitcherOpenCount += 1
                  return new Promise((resolve) => { window.__resolveInstanceSwitcher = resolve })
                },
                closeInstanceSwitcher: () => {
                  window.__instanceSwitcherCloseCount += 1
                  window.__resolveInstanceSwitcher?.()
                  return Promise.resolve()
                },
                subscribeCurrentInstanceStatus: () => () => undefined,
              },
            })
          })()`,
        ),
    )
  })

  test('does not let an older Desktop presentation request overwrite a newer subscribed event', async () => {
    await withProductPage(
      '/live',
      async (page) => {
        const entry = page.getByRole('button', { name: /^管理并添加远程服务实例：北辰实例/u })
        await playwrightExpect(entry).toHaveAccessibleName('管理并添加远程服务实例：北辰实例 · 无法连接')
        await callWindow(page, '__resolveInitialDesktopPresentation', {
          revision: 4,
          displayName: '旧实例名称',
          status: 'ready',
        })
        await page.waitForTimeout(20)
        await playwrightExpect(entry).toHaveAccessibleName('管理并添加远程服务实例：北辰实例 · 无法连接')
      },
      browserSnapshot,
      (page) =>
        desktopShell(
          page,
          `Object.defineProperty(window, 'nekroDesktopShell', {
            configurable: true,
            value: {
              getCurrentInstancePresentation: () =>
                new Promise((resolve) => { window.__resolveInitialDesktopPresentation = resolve }),
              openInstanceSwitcher: () => Promise.resolve(),
              closeInstanceSwitcher: () => Promise.resolve(),
              subscribeCurrentInstanceStatus: (listener) => {
                queueMicrotask(() => listener({ revision: 5, displayName: '北辰实例', status: 'offline' }))
                return () => undefined
              },
            },
          })`,
        ),
    )
  })

  test('accepts protocol-1 Desktop shapes without revision and keeps subscription arrival order', async () => {
    await withProductPage(
      '/live',
      async (page) => {
        const entry = page.getByRole('button', { name: /^管理并添加远程服务实例：旧版远程实例/u })
        await playwrightExpect(entry).toHaveAccessibleName('管理并添加远程服务实例：旧版远程实例 · 无法连接')
        await callWindow(page, '__publishLegacyDesktopPresentation', {
          displayName: '旧版远程实例',
          status: 'ready',
        })
        await playwrightExpect(entry).toHaveAccessibleName('管理并添加远程服务实例：旧版远程实例 · 运行正常')
        await callWindow(page, '__resolveLegacyInitialDesktopPresentation', {
          displayName: '迟到初始实例',
          status: 'ready',
        })
        await page.waitForTimeout(20)
        await playwrightExpect(entry).toHaveAccessibleName('管理并添加远程服务实例：旧版远程实例 · 运行正常')
      },
      browserSnapshot,
      (page) =>
        desktopShell(
          page,
          `Object.defineProperty(window, 'nekroDesktopShell', {
            configurable: true,
            value: {
              getCurrentInstancePresentation: () =>
                new Promise((resolve) => { window.__resolveLegacyInitialDesktopPresentation = resolve }),
              openInstanceSwitcher: () => Promise.resolve(),
              closeInstanceSwitcher: () => Promise.resolve(),
              subscribeCurrentInstanceStatus: (listener) => {
                window.__publishLegacyDesktopPresentation = listener
                queueMicrotask(() => listener({ displayName: '旧版远程实例', status: 'offline' }))
                return () => undefined
              },
            },
          })`,
        ),
    )
  })

  test('keeps model provider setup inside the create page when no models exist', async () => {
    await withProductPage(
      '/agents/new',
      async (page) => {
        await playwrightExpect(page.getByRole('dialog')).toHaveCount(0)
        await playwrightExpect(page.getByRole('heading', { name: '新建智能体' })).toBeVisible()
        await page.getByLabel('名称').fill('临时智能体')
        await playwrightExpect(page.getByText('当前没有可用模型。请先保存一个供应商。', { exact: true })).toBeVisible()
        await playwrightExpect(page.getByRole('button', { name: '保存供应商' })).toBeVisible()
        await playwrightExpect(page).toHaveURL(/\/agents\/new$/u)
        await playwrightExpect(page.getByLabel('名称')).toHaveValue('临时智能体')
      },
      { ...browserSnapshot, models: [] },
      async (page) => {
        await page.route('**/api/llm/providers', (request) =>
          request.fulfill({
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
      },
    )
  })

  test('edits structured persona references with keyboard-safe chips and a 10–20 line viewport', async () => {
    await withProductPage('/agents/new', async (page) => {
      const editor = page.getByRole('textbox', { name: '设定' })
      await playwrightExpect(editor).toBeVisible()
      const initialHeight = await editor.evaluate((element) => element.getBoundingClientRect().height)
      expect(initialHeight).toBeGreaterThanOrEqual(240)

      await editor.fill('优先参考 @成员')
      const member = page.getByRole('option', { name: /成员甲/u })
      await playwrightExpect(member).toBeVisible()
      await member.click()
      await playwrightExpect(editor.getByText('@成员甲')).toBeVisible()

      await editor.press('Backspace')
      await editor.press('Backspace')
      await playwrightExpect(editor.getByText('@成员甲')).toHaveCount(0)

      await editor.fill(Array.from({ length: 25 }, (_, index) => `第 ${index + 1} 行`).join('\n'))
      const cappedHeight = await editor.evaluate((element) => element.getBoundingClientRect().height)
      expect(cappedHeight).toBeGreaterThan(initialHeight)
      expect(cappedHeight).toBeLessThanOrEqual(466)
    })
  })

  test('preserves intelligent-agent drafts and the persona cursor across an authoritative Host refresh', async () => {
    let snapshotRequests = 0
    await withProductPage(
      `/agents/${browserAgentId}`,
      async (page) => {
        await page.getByRole('button', { name: '修改名称' }).click()
        const name = page.getByLabel('名称', { exact: true })
        await playwrightExpect(name).toHaveValue('资料员')
        await name.fill('资料员草稿')
        await name.press('Enter')
        await page.getByRole('button', { name: '编辑设定' }).click()
        const editor = page.getByRole('textbox', { name: '设定' })
        await playwrightExpect(editor).toHaveText('严谨、简洁')
        await editor.fill('草稿内容保持在这里')
        const selectionBefore = await editor.evaluate((element) => {
          element.focus()
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
          const text = walker.nextNode()
          if (!(text instanceof Text)) throw new Error('设定草稿缺少文本节点。')
          const offset = Math.max(1, text.data.length - 2)
          const range = document.createRange()
          range.setStart(text, offset)
          range.collapse(true)
          const selection = window.getSelection()
          if (!selection) throw new Error('浏览器没有可用选区。')
          selection.removeAllRanges()
          selection.addRange(range)
          return { text: text.data, offset }
        })
        const requestsBeforeRefresh = snapshotRequests

        await page.evaluate(() => window.dispatchEvent(new Event('online')))
        await playwrightExpect.poll(() => snapshotRequests).toBeGreaterThan(requestsBeforeRefresh)

        await playwrightExpect(page.getByRole('heading', { name: '资料员草稿' })).toBeVisible()
        await playwrightExpect(editor).toHaveText('草稿内容保持在这里')
        const saveBar = page.getByRole('region', { name: '未保存的修改' })
        await playwrightExpect(saveBar).toContainText('2 项未保存的修改')
        await playwrightExpect(saveBar.getByRole('button', { name: '保存' })).toBeEnabled()
        expect(
          await editor.evaluate(() => {
            const selection = window.getSelection()
            return { text: selection?.anchorNode?.textContent ?? '', offset: selection?.anchorOffset ?? -1 }
          }),
        ).toEqual(selectionBefore)
      },
      browserSnapshot,
      async (page) => {
        await page.route('**/api/snapshot', async (request) => {
          snapshotRequests += 1
          await request.fulfill({ json: browserSnapshot })
        })
      },
    )
  })

  test('renders authoritative intelligent-agent and extension data without technical identifiers', async () => {
    await withProductPage('/agents', async (page) => {
      await playwrightExpect(page).toHaveURL(new RegExp(`/agents/${browserAgentId}$`, 'u'))
      await playwrightExpect(page.getByRole('heading', { name: '资料员' })).toBeVisible()
      await playwrightExpect(page.getByRole('heading', { name: '设定' })).toBeVisible()
      await playwrightExpect(page.locator('main')).not.toContainText('版本')
      await playwrightExpect(page.locator('main')).not.toContainText(browserAgentId)
      await playwrightExpect(page.locator('main')).not.toContainText(browserRevisionId)
    })
  })

  test('renders extension data with save-time records instead of technical identifiers', async () => {
    await withProductPage(`/workshop/extensions/${browserExtensionId}`, async (page) => {
      await playwrightExpect(page.getByRole('heading', { name: '文档复核' })).toBeVisible()
      await playwrightExpect(page.getByText('1 个智能体使用', { exact: true }).first()).toBeVisible()
      await playwrightExpect(page.getByRole('listitem').filter({ hasText: 'document_review' })).toBeVisible()
      // Saved records are labelled by save time, never by an internal r-number.
      const olderRecord = recordLabels([{ id: 'older', createdAt: 1_724_000_000_000 }]).get('older') ?? ''
      await page.getByRole('button', { name: new RegExp(`^${olderRecord}`, 'u') }).click()
      await playwrightExpect(page.getByRole('listitem').filter({ hasText: 'legacy_review' })).toBeVisible()
      await playwrightExpect(page.locator('main')).not.toContainText(/(?:^|[^a-z_])r\d+(?:[^\d]|$)/u)
      await playwrightExpect(page.locator('main')).not.toContainText('Revision')
      // Internal identifiers stay in the collapsed diagnostics until asked for.
      await playwrightExpect(page.getByText(browserExtensionRevisionId, { exact: false })).toBeHidden()
      await page.getByRole('button', { name: '诊断信息' }).click()
      await playwrightExpect(page.getByText(browserExtensionRevisionId, { exact: false })).toBeVisible()
      await page.getByRole('button', { name: '更多' }).click()
      await playwrightExpect(page.getByRole('menuitem', { name: '删除扩展' })).toBeVisible()
      await page.keyboard.press('Escape')
      await playwrightExpect(page.getByRole('button', { name: '导入扩展' })).toBeVisible()
    })
  })

  test('keeps Host UI content inside Host-owned page insets for navigation and full-width modes', async () => {
    const navigationPage = HostUiPageEntrySchema.parse({
      ...hostUiPage('geometrynavigation'),
      title: '交付检查台',
      objectPane: 'navigation',
      startPath: 'overview',
      routeBase: '/apps/hup_geometrynavigation',
      client: { moduleUrl: '/host-ui/geometrynavigation.mjs', buildKey: 'c'.repeat(64) },
    })
    const fullWidthPage = HostUiPageEntrySchema.parse({
      ...hostUiPage('geometryfull'),
      title: '全宽检查台',
      objectPane: 'hidden',
      startPath: 'overview',
      routeBase: '/apps/hup_geometryfull',
      client: { moduleUrl: '/host-ui/geometryfull.mjs', buildKey: 'd'.repeat(64) },
    })
    const snapshot = {
      ...browserSnapshot,
      hostUi: { preferencesRevision: 1, pages: [navigationPage, fullWidthPage] },
    }
    const moduleSource = (entry: typeof navigationPage): string => `
      export default function (environment) {
        const { React } = environment
        return {
          apply(ctx) {
            const ui = ctx.ui
            const page = ${JSON.stringify({
              kind: 'host-page',
              entryId: entry.entryId,
              title: entry.title,
              icon: entry.icon,
              objectPane: entry.objectPane,
              startPath: entry.startPath,
            })}
            const navigation = {
              getSnapshot: () => ({ revision: 1, groups: [{ id: 'main', items: [{ id: 'overview', label: '本周概览', path: 'overview' }] }] }),
              subscribe: () => () => undefined
            }
            return ctx.pages.register(
              { page, ...(page.objectPane === 'navigation' ? { navigation } : {}) },
              () => React.createElement(
                ui.Stack,
                null,
                React.createElement(ui.PageHeader, { title: '本周概览', meta: '检查页面标准内容轴。' }),
                React.createElement(ui.Section, null, React.createElement('h2', null, '当前进展'), React.createElement('p', null, '两项检查正在进行。'))
              )
            )
          }
        }
      }
    `
    const assertGeometry = async (page: Page, expectedInline: number): Promise<void> => {
      const geometry = await page.locator('[data-host-ui-viewport]').evaluate((viewport) => {
        const frame = viewport.querySelector('[data-host-ui-frame]')
        const content = viewport.querySelector('[data-host-ui-content]')
        const header = viewport.querySelector('[data-page-header]')
        const section = viewport.querySelector('[data-nxt-ui-component="Section"]')
        if (!(frame instanceof HTMLElement) || !(content instanceof HTMLElement)) throw new Error('missing frame')
        if (!(header instanceof HTMLElement) || !(section instanceof HTMLElement)) throw new Error('missing content')
        const style = getComputedStyle(frame)
        const contentRect = content.getBoundingClientRect()
        const headerRect = header.getBoundingClientRect()
        const sectionRect = section.getBoundingClientRect()
        return {
          insets: {
            top: Number.parseFloat(style.paddingTop),
            right: Number.parseFloat(style.paddingRight),
            bottom: Number.parseFloat(style.paddingBottom),
            left: Number.parseFloat(style.paddingLeft),
          },
          contentLeft: contentRect.left,
          headerLeft: headerRect.left,
          headerRight: headerRect.right,
          sectionLeft: sectionRect.left,
          sectionRight: sectionRect.right,
          horizontalOverflow: viewport.scrollWidth > viewport.clientWidth + 1,
        }
      })
      expect(geometry.insets).toEqual({ top: 24, right: expectedInline, bottom: 40, left: expectedInline })
      expect(Math.abs(geometry.contentLeft - geometry.headerLeft)).toBeLessThanOrEqual(1)
      expect(Math.abs(geometry.headerLeft - geometry.sectionLeft)).toBeLessThanOrEqual(1)
      expect(Math.abs(geometry.headerRight - geometry.sectionRight)).toBeLessThanOrEqual(1)
      expect(geometry.horizontalOverflow).toBe(false)
    }
    await withProductPage(
      '/apps/hup_geometrynavigation/overview',
      async (page) => {
        await playwrightExpect(page.getByRole('heading', { name: '本周概览', exact: true })).toBeVisible()
        const navigation = page.getByRole('complementary', { name: '交付检查台导航' })
        await playwrightExpect(navigation.getByRole('button', { name: '本周概览', exact: true })).toHaveAttribute(
          'aria-current',
          'page',
        )
        await playwrightExpect(page.getByText('扩展页面', { exact: true }).first()).toBeVisible()
        await assertGeometry(page, 32)
        await page.setViewportSize({ width: 1920, height: 1080 })
        await page.goto(`${baseUrl}/apps/hup_geometryfull/overview`)
        await playwrightExpect(page.getByRole('heading', { name: '本周概览', exact: true })).toBeVisible()
        await playwrightExpect(page.getByRole('complementary', { name: /导航$/u })).toHaveCount(0)
        await assertGeometry(page, 40)
      },
      snapshot,
      async (page) => {
        await page.route('**/host-ui/*.css*', (request) =>
          request.fulfill({ status: 200, contentType: 'text/css', body: '' }),
        )
        await page.route('**/host-ui/*.mjs*', (request) => {
          const source = request.request().url().includes('geometryfull') ? fullWidthPage : navigationPage
          return request.fulfill({ status: 200, contentType: 'text/javascript', body: moduleSource(source) })
        })
        await page.route('**/api/host-ui/pages/*/diagnostic', (request) => request.fulfill({ json: { ok: true } }))
      },
    )
  })

  test('inspects an extension dropped onto the workshop list', async () => {
    let inspectRequests = 0
    await withProductPage(
      `/workshop/extensions/${browserExtensionId}`,
      async (page) => {
        const dropZone = page.locator('[data-extension-drop-zone]')
        await playwrightExpect(dropZone).toBeVisible()
        await dropZone.evaluate((element) => {
          const transfer = new DataTransfer()
          transfer.items.add(
            new File(['shared-extension'], 'shared.nxt-extension', {
              type: 'application/vnd.nekro-nxt.extension+zip',
            }),
          )
          element.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: transfer }))
          element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
        })
        const dialog = page.getByRole('dialog', { name: '导入「共享扩展」' })
        await playwrightExpect(dialog).toBeVisible()
        await playwrightExpect(dialog.getByRole('button', { name: '导入' })).toBeVisible()
        expect(inspectRequests).toBe(1)
      },
      browserSnapshot,
      async (page) => {
        await page.route('**/api/extensions/imports/inspect', async (request) => {
          inspectRequests += 1
          expect(request.request().postDataBuffer()?.byteLength).toBeGreaterThan(0)
          await request.fulfill({
            json: {
              token: 'import-token',
              extensionId: 'ext_shared',
              revisionId: 'xrv_shared',
              slug: 'shared-extension',
              displayName: '共享扩展',
              scope: 'agent',
              idempotent: false,
              slugConflict: false,
            },
          })
        })
      },
    )
  })

  test('finds platform members in the account detail and through the command palette', async () => {
    const queries: string[] = []
    await withProductPage(
      `/wiring/connections/${externalConnectionId}`,
      async (page) => {
        const members = page.locator('section').filter({ has: page.getByRole('heading', { name: /^成员/u }) })
        await playwrightExpect(members).toContainText('成员甲')
        await page.getByLabel('查找成员').fill('成员甲')
        await playwrightExpect.poll(() => queries.includes('成员甲')).toBe(true)
        await playwrightExpect(members).toContainText('成员甲')
        await playwrightExpect(page.locator('body')).not.toContainText('pid_membera')

        await page.keyboard.press('ControlOrMeta+k')
        const palette = page.getByRole('dialog')
        await palette.getByRole('combobox', { name: '搜索' }).fill('成员甲')
        const option = palette.getByRole('option', { name: /成员甲/u })
        await playwrightExpect(option).toBeVisible()
        await option.click()
        await playwrightExpect(page).toHaveURL(new RegExp(`/channels/${externalChannelId}$`, 'u'))
      },
      browserSnapshot,
      async (page) => {
        await page.route('**/api/platform-users*', (request) => {
          const query = new URL(request.request().url()).searchParams.get('query') ?? ''
          queries.push(query)
          return request.fulfill({ json: memberDirectory })
        })
      },
    )
  })

  test('pages through account members and refreshes the loaded rows when the directory changes', async () => {
    let generation = 1
    const requests: URLSearchParams[] = []
    let releaseEvent: (() => void) | undefined
    const eventReleased = new Promise<void>((resolve) => {
      releaseEvent = resolve
    })
    const memberRow = (index: number) => ({
      identityId: `pid_member${index}`,
      displayName: generation > 1 && index === 0 ? '改名后的成员' : `成员${index}`,
      adapter: { key: 'fixture-beta', displayName: '示例群聊平台' },
      connection: { id: externalConnectionId, displayName: '示例群聊平台' },
      activeChannelCount: 1,
      channelPreview: [],
      historicalOnly: false,
    })
    await withProductPage(
      `/wiring/connections/${externalConnectionId}`,
      async (page) => {
        const members = page.locator('section').filter({ has: page.getByRole('heading', { name: /^成员/u }) })
        await playwrightExpect(members.getByText('已显示 30 / 45', { exact: true })).toBeVisible()
        await members.getByRole('button', { name: '加载更多' }).click()
        await playwrightExpect(members.getByText('已显示 45 / 45', { exact: true })).toBeVisible()
        await playwrightExpect(members.getByRole('button', { name: '加载更多' })).toHaveCount(0)
        expect(requests.at(-1)?.get('cursor')).toBe('pid_member29')

        const scroller = page.locator('aside').last()
        await scroller.evaluate((element) => {
          element.scrollTop = 160
        })
        const scrolledTo = await scroller.evaluate((element) => element.scrollTop)
        generation = 2
        releaseEvent?.()
        await playwrightExpect(members).toContainText('改名后的成员')
        await playwrightExpect(members.getByText('已显示 45 / 45', { exact: true })).toBeVisible()
        expect(requests.at(-1)?.get('limit')).toBe('45')
        expect(await scroller.evaluate((element) => element.scrollTop)).toBe(scrolledTo)

        await page.getByLabel('查找成员').fill('成员1')
        await playwrightExpect.poll(() => requests.at(-1)?.get('query')).toBe('成员1')
        expect(requests.at(-1)?.get('cursor')).toBeNull()
        expect(requests.at(-1)?.get('limit')).toBe('30')
      },
      browserSnapshot,
      async (page) => {
        await page.route('**/api/platform-users*', (request) => {
          const params = new URL(request.request().url()).searchParams
          requests.push(params)
          const total = 45
          const cursor = params.get('cursor')
          const start = cursor ? Number(cursor.slice('pid_member'.length)) + 1 : 0
          const limit = Number(params.get('limit') ?? 30)
          const items = Array.from({ length: Math.max(0, Math.min(limit, total - start)) }, (_, offset) =>
            memberRow(start + offset),
          )
          const end = start + items.length
          return request.fulfill({
            json: {
              total,
              items,
              facets: memberDirectory.facets,
              ...(end < total ? { nextCursor: `pid_member${end - 1}` } : {}),
            },
          })
        })
        // One schema-valid channel fact, released by the test, marks the member directory as changed.
        await page.route('**/api/events', async (request) => {
          await eventReleased
          const fact = {
            channelId: externalChannelId,
            revision: 2,
            items: [
              {
                kind: 'inbound',
                sourceId: 'evt_directorychange',
                message: {
                  id: 'evt_directorychange',
                  channelId: externalChannelId,
                  role: 'member',
                  parts: [{ type: 'text', text: '新的成员发言' }],
                  occurredAt: 1_725_000_002_000,
                },
              },
            ],
          }
          await request.fulfill({
            status: 200,
            contentType: 'text/event-stream',
            body: `id: fixture:1\nevent: channel-fact\ndata: ${JSON.stringify(fact)}\n\n`,
          })
        })
      },
    )
  })

  test('keeps intelligent-agent configuration on its own page', async () => {
    await withProductPage(`/agents/${browserAgentId}`, async (page) => {
      await playwrightExpect(page.getByLabel('DeepSeek API 密钥')).toBeVisible()
      await playwrightExpect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled()
      await playwrightExpect(page.getByLabel('资料员对话 的触发方式')).toBeVisible()
      await playwrightExpect(page.getByRole('switch', { name: '为资料员启用文档复核' })).toBeChecked()
      await playwrightExpect(page.locator('body')).not.toContainText('设置 → DSH 扩展')
    })
  })

  test('shows scheduled tasks on the agent page and in the channel inspector and acts on them', async () => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const now = Date.now()
    const task = (id: string, overrides: Record<string, unknown>) => ({
      id,
      agentId: browserAgentId,
      channelId: browserChannelId,
      source: 'chat',
      label: '示例任务',
      schedule: { kind: 'cron', cron: '0 8 * * 1-5', timezone: zone },
      state: 'scheduled',
      nextRunAt: now + 2 * 60 * 60 * 1000,
      createdAt: now - 1000,
      ...overrides,
    })
    const snapshot = {
      ...browserSnapshot,
      scheduledTasks: [
        task('job_morning', { label: '工作日早报' }),
        task('job_digest', {
          source: 'declared',
          extensionId: browserExtensionId,
          extensionName: '文档复核',
          label: '每晚汇总',
          schedule: { kind: 'cron', cron: '30 21 * * *', timezone: zone },
          state: 'paused',
          nextRunAt: now + 10 * 60 * 60 * 1000,
        }),
        task('job_water', {
          label: '提醒喝水',
          schedule: { kind: 'once', at: now - 60 * 60 * 1000 },
          state: 'finished',
          nextRunAt: undefined,
          lastFiredAt: now - 60 * 60 * 1000,
        }),
      ],
    }
    const calls: string[] = []
    await withProductPage(
      `/agents/${browserAgentId}`,
      async (page) => {
        const section = page.locator('#profile-schedules')
        await section.scrollIntoViewIfNeeded()
        const table = section.getByRole('table', { name: '资料员的定时任务' })
        await playwrightExpect(table).toContainText('工作日早报')
        await playwrightExpect(table).toContainText('工作日 08:00')
        await playwrightExpect(table).toContainText('文档复核固定计划')
        await playwrightExpect(table).toContainText('已暂停')
        await playwrightExpect(table).toContainText('已触发')
        // Declared plans cannot be deleted; finished tasks can only be cleared.
        await playwrightExpect(page.getByRole('button', { name: '删除「每晚汇总」' })).toHaveCount(0)
        await playwrightExpect(page.getByRole('button', { name: '暂停「提醒喝水」' })).toHaveCount(0)
        await page.screenshot({ path: '.local/browser-test-results/agent-scheduled-tasks.png', fullPage: true })

        await page.getByRole('button', { name: '暂停「工作日早报」' }).click()
        await page.getByRole('button', { name: '恢复「每晚汇总」' }).click()
        await page.getByRole('button', { name: '删除「提醒喝水」' }).click()
        await page.getByRole('dialog', { name: '删除「提醒喝水」？' }).getByRole('button', { name: '删除' }).click()
        await playwrightExpect
          .poll(() => [...calls].sort())
          .toEqual(['DELETE job_water', 'POST job_digest/resume', 'POST job_morning/pause'])

        await page.goto(`${baseUrl}/channels/${browserChannelId}`)
        const inspector = page.getByRole('complementary', { name: '频道信息' })
        await playwrightExpect(inspector).toContainText('定时任务')
        await playwrightExpect(inspector).toContainText('工作日早报')
        await playwrightExpect(inspector).not.toContainText('提醒喝水')
        await inspector.getByRole('button', { name: '立即执行「工作日早报」' }).click()
        await playwrightExpect.poll(() => calls).toContain('POST job_morning/run')
        await page.screenshot({ path: '.local/browser-test-results/channel-scheduled-tasks.png' })
      },
      snapshot,
      async (page) => {
        await page.route('**/api/scheduled-tasks/**', async (request) => {
          const url = new URL(request.request().url())
          const [, , , taskId, action] = url.pathname.split('/')
          calls.push(`${request.request().method()} ${taskId}${action ? `/${action}` : ''}`)
          const current = snapshot.scheduledTasks.find((item) => item.id === taskId)
          await request.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(action === undefined ? { deleted: true } : current),
          })
        })
      },
    )
  })

  test('asks before granting a higher system-access level and sends the matching capabilities', async () => {
    const capabilityRequests: unknown[] = []
    await withProductPage(
      `/agents/${browserAgentId}`,
      async (page) => {
        const levels = page.getByRole('radiogroup', { name: '系统访问' })
        await playwrightExpect(levels.getByRole('radio', { name: '基础权限' })).toHaveAttribute('aria-checked', 'true')
        await levels.getByRole('radio', { name: '运行命令' }).click()
        const confirm = page.getByRole('dialog', { name: '允许资料员运行命令？' })
        await playwrightExpect(confirm).toBeVisible()
        expect(capabilityRequests).toHaveLength(0)
        await confirm.getByRole('button', { name: '允许' }).click()
        // Capabilities are saved together with the rest of the configuration.
        expect(capabilityRequests).toHaveLength(0)
        await page.getByRole('region', { name: '未保存的修改' }).getByRole('button', { name: '保存' }).click()
        await playwrightExpect.poll(() => capabilityRequests.length).toBe(1)
        expect(capabilityRequests[0]).toMatchObject({
          fileTools: true,
          developmentShell: true,
          unrestrictedFileAccess: false,
        })
      },
      browserSnapshot,
      async (page) => {
        await page.route('**/api/agents/*/capabilities', async (request) => {
          capabilityRequests.push(request.request().postDataJSON())
          await request.fulfill({
            json: {
              currentRevisionId: browserRevisionId,
              capabilities: {
                subagents: false,
                fileTools: true,
                webSearch: false,
                dynamicCreation: true,
                developmentShell: true,
                unrestrictedFileAccess: false,
              },
            },
          })
        })
      },
    )
  })

  test('renders platform accounts with product labels and a masked account', async () => {
    await withProductPage('/wiring', async (page) => {
      // The account node itself; a name match could also hit its channel group's fold toggle.
      await page.locator(`[data-node="connection:${externalConnectionId}"]`).click()
      await playwrightExpect(page).toHaveURL(new RegExp(`/wiring/connections/${externalConnectionId}$`, 'u'))
      const detail = page.locator('aside').last()
      await playwrightExpect(detail.getByText('尾号 7890', { exact: true })).toBeVisible()
      await playwrightExpect(detail).toContainText('产品讨论群')
      await playwrightExpect(page.locator('body')).not.toContainText('1234567890')
      await playwrightExpect(page.locator('body')).not.toContainText('adapterKey')
      await playwrightExpect(page.locator('body')).not.toContainText('opaque-group-alpha')
    })
  })

  test('creates a Connection with an alias and edits the alias without changing platform identity', async () => {
    let createRequestBody: unknown
    await withProductPage(
      '/wiring/new',
      async (page) => {
        await page
          .getByRole('main')
          .getByRole('button', { name: /^示例群聊平台/u })
          .click()
        await page.getByLabel('名称').fill('项目机器人')
        await page.getByRole('button', { name: '添加账号' }).click()
        await playwrightExpect(page).toHaveURL(/\/wiring/u)
        await playwrightExpect
          .poll(() => createRequestBody)
          .toMatchObject({
            alias: '项目机器人',
            adapterKey: 'fixture-beta',
          })
      },
      browserSnapshot,
      async (page) => {
        await page.route('**/api/connections', async (request) => {
          createRequestBody = request.request().postDataJSON()
          await request.fulfill({
            status: 201,
            json: { connectionId: externalConnectionId, adapterKey: 'fixture-beta' },
          })
        })
      },
    )

    let currentAlias = '项目机器人'
    const aliased = () => ({
      ...browserSnapshot,
      connections: browserSnapshot.connections.map((connection) =>
        connection.id === externalConnectionId
          ? { ...connection, ...(currentAlias ? { alias: currentAlias } : {}) }
          : connection,
      ),
    })
    await withProductPage(
      `/wiring/connections/${externalConnectionId}`,
      async (page) => {
        const detail = page.locator('aside').last()
        await playwrightExpect(detail.getByRole('heading', { name: '项目机器人' })).toBeVisible()
        await detail.getByRole('button', { name: '修改名称' }).click()
        await detail.getByRole('textbox', { name: '名称' }).fill('研发机器人')
        await detail.getByRole('textbox', { name: '名称' }).press('Enter')
        await playwrightExpect(detail.getByRole('heading', { name: '研发机器人' })).toBeVisible()
        await detail.getByRole('button', { name: '修改名称' }).click()
        await detail.getByRole('textbox', { name: '名称' }).fill('')
        await detail.getByRole('textbox', { name: '名称' }).press('Enter')
        await playwrightExpect(detail.getByRole('heading', { name: '示例群聊平台' })).toBeVisible()
        await playwrightExpect(detail.getByRole('button', { name: '修改名称' })).toBeVisible()
      },
      aliased(),
      async (page) => {
        await page.route('**/api/snapshot', (request) => request.fulfill({ json: aliased() }))
        await page.route(`**/api/connections/${externalConnectionId}/alias`, async (request) => {
          currentAlias =
            HostApiContracts.updateConnectionAlias.parseRequest(request.request().postDataJSON()).alias ?? ''
          await request.fulfill({
            json: { connectionId: externalConnectionId, ...(currentAlias ? { alias: currentAlias } : {}) },
          })
        })
      },
    )
  })

  test('commits only the Composer while typing a channel draft', async () => {
    await withProductPage(
      `/channels/${browserChannelId}`,
      async (page) => {
        const input = page.getByRole('textbox', { name: '消息' })
        await playwrightExpect(input).toBeVisible()
        await playwrightExpect(page.getByText('只属于当前频道', { exact: true })).toBeVisible()
        await page.evaluate(() => window.dispatchEvent(new Event('reset-ui-render-counts')))
        await input.pressSequentially('连续输入测试')
        const counts = await windowValue(page, '__nxtRenderCounts')
        expect(counts, JSON.stringify(counts)).toMatchObject({
          Composer: 6,
          Conversation: 0,
          MessageRow: 0,
          TurnRow: 0,
          ChannelInspector: 0,
          ChannelList: 0,
        })
      },
      browserSnapshot,
      async (page) => {
        await page.route('**/api/events', () => undefined)
        await page.addInitScript(() => {
          type Fiber = {
            type?: { name?: string; type?: { name?: string } }
            flags: number
            child?: Fiber
            sibling?: Fiber
            alternate?: Fiber | null
          }
          const counts: Record<string, number> = {
            Composer: 0,
            Conversation: 0,
            MessageRow: 0,
            TurnRow: 0,
            ChannelInspector: 0,
            ChannelList: 0,
          }
          window.addEventListener('reset-ui-render-counts', () => {
            for (const name of Object.keys(counts)) counts[name] = 0
          })
          Object.assign(window, {
            __nxtRenderCounts: counts,
            __REACT_DEVTOOLS_GLOBAL_HOOK__: {
              supportsFiber: true,
              renderers: new Map(),
              inject: () => 1,
              onCommitFiberRoot: (_id: number, root: { current: Fiber }) => {
                // As React DevTools does: a subtree whose child list was reused did not render in this commit.
                const visit = (fiber: Fiber | undefined): void => {
                  if (!fiber) return
                  const name = (fiber.type?.name ?? fiber.type?.type?.name)?.replace(/\d+$/u, '')
                  if (name && Object.hasOwn(counts, name) && (fiber.flags & 1) !== 0)
                    counts[name] = (counts[name] ?? 0) + 1
                  if (!fiber.alternate || fiber.child !== fiber.alternate.child) visit(fiber.child)
                  visit(fiber.sibling)
                }
                visit(root.current)
              },
              onCommitFiberUnmount: () => undefined,
            },
          })
        })
      },
    )
  })

  test('retains independent channel drafts across channel switches and navigation', async () => {
    await withProductPage(`/channels/${browserChannelId}`, async (page) => {
      const input = page.getByRole('textbox', { name: '消息' })
      const message = await page.getByText('只属于当前频道', { exact: true }).elementHandle()
      await input.fill('频道甲的草稿')
      expect(await message?.evaluate((element) => element.isConnected)).toBe(true)
      await page.getByRole('button', { name: '透视' }).click()
      await page.getByRole('button', { name: '透视' }).click()
      await playwrightExpect(input).toHaveValue('频道甲的草稿')
      await page.locator(`a[href="/channels/${externalChannelId}"]`).first().click()
      await playwrightExpect(page).toHaveURL(new RegExp(`/channels/${externalChannelId}$`, 'u'))
      await playwrightExpect(input).toHaveValue('')
      await input.fill('频道乙的草稿')
      await page.locator(`a[href="/channels/${browserChannelId}"]`).first().click()
      await playwrightExpect(input).toHaveValue('频道甲的草稿')
      await page.getByRole('link', { name: '设置' }).click()
      await playwrightExpect(page).toHaveURL(/\/settings\/models$/u)
      await page.goBack()
      await playwrightExpect(page.getByRole('textbox', { name: '消息' })).toHaveValue('频道甲的草稿')
    })
  })

  test('isolates Channel messages, names the send target and reveals tool work with x-ray', async () => {
    await withProductPage(`/channels/${browserChannelId}`, async (page) => {
      await playwrightExpect(page.getByText('只属于当前频道', { exact: true })).toBeVisible()
      await playwrightExpect(page.locator('body')).not.toContainText('不能混入当前频道')
      await playwrightExpect(page.getByRole('textbox', { name: '消息' })).toHaveAttribute(
        'placeholder',
        '给 资料员 发消息',
      )
      const inspector = page.getByRole('complementary', { name: '频道信息' })
      await playwrightExpect(inspector.getByText('资料员', { exact: true }).first()).toBeVisible()
      await playwrightExpect(inspector.getByRole('heading', { name: '上下文' })).toBeVisible()

      // Without x-ray a turn is a summary: tool chips, no internal reasoning.
      await playwrightExpect(page.getByText('读取文件', { exact: true }).first()).toBeVisible()
      await playwrightExpect(page.getByText('先核对公告。', { exact: true })).toHaveCount(0)
      await page.getByRole('button', { name: '透视' }).click()
      await playwrightExpect(page.getByRole('button', { name: '透视' })).toHaveAttribute('aria-pressed', 'true')

      await playwrightExpect(page.getByText('读取文件', { exact: true }).first()).toBeVisible()
      await playwrightExpect(page.getByText('活动改到 19:30。', { exact: true })).toBeVisible()
      await playwrightExpect(page.getByText('先核对公告。', { exact: true })).toBeVisible()
      await playwrightExpect(page.locator('body')).not.toContainText('call_read')
      await playwrightExpect(page.locator('body')).not.toContainText('internal-main-platform-id')
    })

    await withProductPage(`/channels/${emptyChannelId}`, async (page) => {
      await playwrightExpect(page.getByRole('textbox', { name: '消息' })).toHaveAttribute(
        'placeholder',
        '给 资料员 发消息',
      )
      await playwrightExpect(page.locator('body')).not.toContainText('只属于当前频道')
    })
  })

  test('shows real creation state without displaying package or approval identifiers', async () => {
    await withProductPage(
      `/workshop/tasks/${workshopTask.id}`,
      async (page) => {
        await playwrightExpect(page.getByRole('heading', { name: '技术探针' })).toBeVisible()
        await playwrightExpect(page.getByText('等待确认', { exact: true }).first()).toBeVisible()
        await playwrightExpect(page.getByRole('button', { name: '允许运行' })).toBeVisible()
        await playwrightExpect(page.locator('body')).not.toContainText('technical-plugin-id')
        await playwrightExpect(page.locator('body')).not.toContainText('technical-package-id')
        await playwrightExpect(page.locator('body')).not.toContainText('approval-internal-id')
        await playwrightExpect(page.locator('body')).not.toContainText(workshopTask.candidateAttempt.id)
      },
      { ...browserSnapshot, authoringTasks: [workshopTask] },
    )
  })

  test('uses the NekroNXT settings surface without mounting the DSH native WebUI', async () => {
    test.setTimeout(20_000)

    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    const runtimeErrors: string[] = []
    page.on('pageerror', (error) => runtimeErrors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error' && !message.text().includes('status of 409')) runtimeErrors.push(message.text())
    })
    const schema = {
      uid: 47,
      refs: {
        30: { type: 'string', meta: { role: 'secret' } },
        33: { type: 'string', meta: { role: 'credential-ref', default: 'DEEPSEEK_API_KEY' } },
        34: { type: 'string', meta: {} },
        36: { type: 'string', meta: { default: 'deepseek-v4-flash' } },
        38: { type: 'string', meta: { default: '2023-06-01' } },
        42: { type: 'number', meta: { step: 1, min: 1, default: 1024 } },
        46: { type: 'number', meta: { step: 1, min: 1, default: 2 } },
        47: {
          type: 'object',
          meta: { default: {} },
          dict: { apiKey: 30, apiKeyEnv: 33, baseURL: 34, model: 36, apiVersion: 38, maxTokens: 42, maxUses: 46 },
        },
      },
    }
    const namespace = {
      ns: 'web-search-deepseek',
      schema,
      resolved: {
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        baseURL: 'https://api.deepseek.com/anthropic/v1',
        model: 'deepseek-v4-flash',
        apiVersion: '2023-06-01',
        maxTokens: 1024,
        maxUses: 2,
      },
      base: {
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        baseURL: 'https://api.deepseek.com/anthropic/v1',
        model: 'deepseek-v4-flash',
        apiVersion: '2023-06-01',
        maxTokens: 1024,
        maxUses: 2,
      },
      user: {},
      applies: 'live',
      secrets: [{ path: ['apiKey'], set: false }],
      revision: 0,
      writable: true,
      owner: { packageName: '@deepseek-ai/dsh-web-search-deepseek', packageVersion: '0.1.1-rc.2' },
    }
    const mutations: unknown[] = []
    const credentialWrites: unknown[] = []
    let credentialDeleteAttempts = 0
    let releaseFirstCredentialDelete: (() => void) | undefined
    const firstCredentialDelete = new Promise<void>((resolve) => {
      releaseFirstCredentialDelete = resolve
    })
    await installWorkspaceStubs(page)
    await installSnapshotHealthRoutes(page, browserSnapshot)
    await page.route('**/api/snapshot', (request) =>
      request.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(browserSnapshot) }),
    )
    await page.route('**/api/events', (request) =>
      request.fulfill({ status: 200, contentType: 'text/event-stream', body: '' }),
    )
    await page.route('**/api/dsh/plugins', (request) =>
      request.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          plugins: [
            {
              packageName: '@deepseek-ai/dsh-web-search-deepseek',
              packageVersion: '0.1.1-rc.2',
              origin: 'builtin',
              settingsNamespaces: ['web-search-deepseek'],
            },
            {
              packageName: '@example/dsh-user-extension',
              packageVersion: '1.0.0',
              origin: 'profile',
              settingsNamespaces: [],
            },
            {
              packageName: '@example/dsh-broken-extension',
              packageVersion: '1.0.0',
              origin: 'profile',
              settingsNamespaces: [],
              loadError: { code: 'missing-dependency', message: '缺少运行所需的测试服务。' },
            },
          ],
        }),
      }),
    )
    await page.route('**/api/dsh/settings', (request) =>
      request.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ namespaces: [namespace] }),
      }),
    )
    await page.route('**/api/dsh/credentials/describe', (request) =>
      request.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ credentials: { DEEPSEEK_API_KEY: { configured: false, writable: true } } }),
      }),
    )
    await page.route('**/api/dsh/settings/web-search-deepseek/mutate', async (route) => {
      const body: unknown = route.request().postDataJSON()
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw new TypeError('DSH Settings mutation body must be a JSON object.')
      }
      mutations.push(body)
      if (mutations.length > 1) {
        return route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'dsh-settings-conflict', message: '配置版本已变化。' } }),
        })
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...namespace,
          revision: 1,
          resolved: { ...namespace.resolved, maxUses: 4 },
          user: { maxUses: 4 },
        }),
      })
    })
    await page.route('**/api/dsh/credentials/DEEPSEEK_API_KEY', async (route) => {
      if (route.request().method() === 'DELETE') {
        credentialDeleteAttempts += 1
        if (credentialDeleteAttempts === 1) {
          await firstCredentialDelete
          return route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ error: { code: 'credential-delete-failed', message: '凭据存储暂时不可用。' } }),
          })
        }
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ configured: false, writable: true }),
        })
      }
      const body: unknown = route.request().postDataJSON()
      credentialWrites.push(body)
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ configured: true, source: 'file', writable: true }),
      })
    })
    try {
      await page.goto(`${baseUrl}/settings/dsh`)
      await playwrightExpect(page.getByText('DeepSeek 网页搜索', { exact: true }).first()).toBeVisible()
      await playwrightExpect(page.getByText('内置', { exact: true }).first()).toBeVisible()
      await playwrightExpect(page.getByText('用户安装', { exact: true }).first()).toBeVisible()
      await playwrightExpect(page.getByText('加载失败', { exact: true }).first()).toBeVisible()
      await playwrightExpect(page.locator('body')).not.toContainText('已验证支持')
      await playwrightExpect(page.locator('body')).not.toContainText('未完整验证')
      await page.getByText('@example/dsh-broken-extension', { exact: true }).click()
      await playwrightExpect(page.getByText('缺少运行所需的测试服务。', { exact: true })).toBeVisible()
      // An item page leads back to the plugin overview.
      await page.getByRole('button', { name: '全部插件' }).click()
      await page.getByText('DeepSeek 网页搜索', { exact: true }).first().click()
      await playwrightExpect(page.locator('[data-dsh-native-surface]')).toHaveCount(0)
      await page.getByLabel('每次请求最多搜索次数').fill('4')
      await page.getByRole('button', { name: '保存扩展配置' }).click()
      await playwrightExpect.poll(() => mutations.length).toBe(1)
      expect(mutations[0]).toMatchObject({
        expectedRevision: 0,
        ops: [{ op: 'set', path: ['maxUses'], value: 4 }],
      })
      await playwrightExpect(page.getByText('已保存并实时生效。')).toBeVisible()

      const writeOnlyValue = 'browser-write-only-fixture'
      await page.getByLabel('新的凭据值').fill(writeOnlyValue)
      await page.getByRole('button', { name: '保存凭据' }).click()
      await playwrightExpect.poll(() => credentialWrites.length).toBe(1)
      expect(credentialWrites[0]).toEqual({ value: writeOnlyValue })
      await playwrightExpect(page.getByLabel('新的凭据值')).toHaveValue('')
      await playwrightExpect(page.locator('body')).not.toContainText(writeOnlyValue)
      await page.getByLabel('新的凭据值').fill('unsaved-replacement')

      const clearTrigger = page.getByRole('button', { name: '清除凭据' })
      await clearTrigger.click()
      const clearDialog = page.getByRole('dialog')
      await playwrightExpect(clearDialog.getByRole('heading', { name: '清除凭据“DEEPSEEK_API_KEY”？' })).toBeVisible()
      expect(credentialDeleteAttempts).toBe(0)
      await clearDialog.getByRole('button', { name: '取消' }).click()
      await playwrightExpect(clearDialog).toBeHidden()
      await playwrightExpect(clearTrigger).toBeFocused()
      expect(credentialDeleteAttempts).toBe(0)

      await clearTrigger.click()
      await clearDialog.getByRole('button', { name: '清除该凭据' }).click()
      await playwrightExpect.poll(() => credentialDeleteAttempts).toBe(1)
      await playwrightExpect(clearDialog.getByRole('button', { name: '清除该凭据' })).toBeDisabled()
      await page.keyboard.press('Escape')
      await playwrightExpect(clearDialog).toBeVisible()
      expect(credentialDeleteAttempts).toBe(1)
      releaseFirstCredentialDelete?.()
      await playwrightExpect(clearDialog.getByText('清除失败：凭据存储暂时不可用。')).toBeVisible()
      await clearDialog.getByRole('button', { name: '清除该凭据' }).click()
      await playwrightExpect.poll(() => credentialDeleteAttempts).toBe(2)
      await playwrightExpect(clearDialog).toBeHidden()
      await playwrightExpect(page.getByText('凭据已清除。', { exact: true })).toBeVisible()
      await playwrightExpect(page.getByLabel('新的凭据值')).toHaveValue('')
      await playwrightExpect(page.getByLabel('新的凭据值')).toBeFocused()

      await page.getByLabel('单次生成上限').fill('2048')
      await page.getByRole('button', { name: '保存扩展配置' }).click()
      await playwrightExpect(page.getByText('配置已在其他位置更新；当前草稿已保留，请核对后重新保存。')).toBeVisible()
      await playwrightExpect(page.getByLabel('单次生成上限')).toHaveValue('2048')
      expect(runtimeErrors.filter((message) => !message.includes('status of 500'))).toEqual([])
    } finally {
      await page.close()
    }
  })

  test('renders every safe generic Schema family for an unowned live Settings namespace', async () => {
    test.setTimeout(15_000)

    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    const runtimeErrors: string[] = []
    page.on('pageerror', (error) => runtimeErrors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') {
        const location = message.location().url
        runtimeErrors.push(location ? `${message.text()} (${location})` : message.text())
      }
    })
    const schema = {
      uid: 20,
      refs: {
        1: { type: 'string', meta: { description: '普通字符串' } },
        2: { type: 'number', meta: { min: 0, max: 10, step: 1 } },
        3: { type: 'boolean', meta: {} },
        4: { type: 'const', value: 'compact', meta: {} },
        5: { type: 'const', value: 'comfortable', meta: {} },
        6: { type: 'array', inner: 1, meta: {} },
        7: { type: 'dict', inner: 2, meta: {} },
        8: { type: 'tuple', list: [1, 3], meta: {} },
        9: { type: 'union', list: [4, 5], meta: {} },
        10: { type: 'object', dict: { left: 1 }, meta: {} },
        11: { type: 'object', dict: { right: 2 }, meta: {} },
        12: { type: 'intersect', list: [10, 11], meta: {} },
        13: { type: 'custom-fixture', meta: {} },
        14: { type: 'string', meta: { role: 'secret' } },
        15: { type: 'transform', inner: 14, meta: {} },
        20: {
          type: 'object',
          dict: {
            title: 1,
            count: 2,
            enabled: 3,
            rows: 6,
            labels: 7,
            pair: 8,
            mode: 9,
            merged: 12,
            advanced: 13,
            unsafe: 15,
          },
          meta: {},
        },
      },
    }
    const namespace = {
      ns: 'runtime-extra',
      schema,
      resolved: {
        title: '示例',
        count: 2,
        enabled: true,
        rows: ['第一项'],
        labels: { alpha: 1 },
        pair: ['固定', false],
        mode: 'compact',
        merged: { left: 'A', right: 2 },
        advanced: { raw: true },
      },
      base: {},
      user: {},
      applies: 'restart',
      secrets: [],
      revision: 3,
      writable: true,
    }
    await installWorkspaceStubs(page)
    await installSnapshotHealthRoutes(page, browserSnapshot)
    await page.route('**/api/snapshot', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(browserSnapshot) }),
    )
    await page.route('**/api/events', (route) =>
      route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' }),
    )
    await page.route('**/api/dsh/plugins', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ plugins: [] }) }),
    )
    await page.route('**/api/dsh/settings', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ namespaces: [namespace] }),
      }),
    )
    await page.route('**/api/channels/*/messages?*', (route) => {
      const channelId = new URL(route.request().url()).pathname.split('/')[3]
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          messages: browserSnapshot.messages.filter((message) => message.channelId === channelId),
          hasMore: false,
          cursor: { epoch: 'fixture', sequence: 0 },
        }),
      })
    })
    try {
      await page.goto(`${baseUrl}/settings/dsh`)
      await playwrightExpect(page.getByText('runtime-extra', { exact: true }).first()).toBeVisible()
      await playwrightExpect(page.getByText('其他扩展', { exact: true }).first()).toBeVisible()
      await page.getByText('runtime-extra', { exact: true }).first().click()
      await playwrightExpect(page.getByText(/由运行环境注册/)).toBeVisible()
      await playwrightExpect(page.locator('body')).not.toContainText('未评估归属')
      await playwrightExpect(page.getByText('保存后需要重启')).toBeVisible()
      await playwrightExpect(page.getByRole('button', { name: '添加一项' })).toBeVisible()
      await playwrightExpect(page.getByRole('button', { name: '添加键值' })).toBeVisible()
      await playwrightExpect(page.getByLabel('mode的配置类型')).toBeVisible()
      await playwrightExpect(page.getByText(/Schema 类型“custom-fixture”使用高级 JSON 配置/)).toBeVisible()
      await playwrightExpect(page.getByText(/包含只写 Secret/)).toBeVisible()
      expect(runtimeErrors).toEqual([])
    } finally {
      await page.close()
    }
  })

  test('keeps the last successful data visible when the live connection becomes stale', async () => {
    test.setTimeout(12_000)

    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    const pageErrors: string[] = []
    let snapshotRequests = 0
    await installWorkspaceStubs(page)
    await installSnapshotHealthRoutes(page, browserSnapshot)
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.route('**/api/snapshot', (request) => {
      snapshotRequests += 1
      if (snapshotRequests === 1) return request.fulfill({ json: browserSnapshot })
      return request.abort('failed')
    })
    await page.route('**/api/events', (request) =>
      request.fulfill({ status: 200, contentType: 'text/event-stream', body: '' }),
    )
    try {
      await page.goto(`${baseUrl}/agents/${browserAgentId}`)
      await playwrightExpect(page.getByRole('heading', { name: '资料员' })).toBeVisible()
      await playwrightExpect(page.getByText(/连接不稳定/u).first()).toBeVisible({ timeout: 8_000 })
      await playwrightExpect(page.getByRole('heading', { name: '资料员' })).toBeVisible()
      expect(pageErrors).toEqual([])
    } finally {
      await page.close()
    }
  })

  test('keeps priority layouts within the desktop viewport at 1100, 1440, and 1920 pixels', async () => {
    test.setTimeout(30_000)

    const cases = [
      { width: 1100, height: 720, route: '/wiring', name: 'wiring-1100', marker: '示例群聊平台' },
      {
        width: 1440,
        height: 900,
        route: `/channels/${browserChannelId}`,
        name: 'channel-1440',
        marker: '只属于当前频道',
      },
      {
        width: 1440,
        height: 900,
        route: `/channels/${browserChannelId}`,
        name: 'channel-dark-1440',
        marker: '只属于当前频道',
        colorScheme: 'dark',
      },
      { width: 1920, height: 1080, route: `/agents/${browserAgentId}`, name: 'agents-1920', marker: '资料员' },
      {
        width: 1440,
        height: 900,
        route: `/agents/${browserAgentId}`,
        name: 'agents-dark-reduced-motion-1440',
        marker: '资料员',
        colorScheme: 'dark',
        reducedMotion: 'reduce',
      },
      {
        width: 1440,
        height: 900,
        route: '/settings/models?provider=openai',
        name: 'settings-1440',
        marker: 'API 密钥已保存',
      },
      { width: 1440, height: 900, route: '/live', name: 'live-1440', marker: '概览' },
      {
        width: 1100,
        height: 720,
        route: `/workshop/extensions/${browserExtensionId}`,
        name: 'workshop-1100',
        marker: '文档复核',
      },
    ] as const
    const captureDirectory = process.env['NEKRO_VISUAL_CAPTURE']
    if (captureDirectory) await mkdir(captureDirectory, { recursive: true })

    for (const scenario of cases) {
      const page = await browser.newPage({
        viewport: { width: scenario.width, height: scenario.height },
        colorScheme: 'colorScheme' in scenario ? scenario.colorScheme : 'light',
        reducedMotion: 'reducedMotion' in scenario ? scenario.reducedMotion : 'no-preference',
      })
      await installWorkspaceStubs(page)
      await installSnapshotHealthRoutes(page, browserSnapshot)
      await page.route('**/api/snapshot', (request) => request.fulfill({ json: browserSnapshot }))
      await page.route('**/api/channels/*/messages?*', (request) => {
        const channelId = new URL(request.request().url()).pathname.split('/')[3]
        return request.fulfill({
          json: {
            cursor: { epoch: 'fixture', sequence: 0 },
            messages: browserSnapshot.messages.filter((message) => message.channelId === channelId),
            hasMore: false,
          },
        })
      })
      await page.route('**/api/channels/*/runtime', (request) => {
        const channelId = new URL(request.request().url()).pathname.split('/')[3]
        return request.fulfill({
          json: {
            cursor: { epoch: 'fixture', sequence: 0 },
            channelId,
            agentId: browserAgentId,
            phase: 'idle',
            summary: '智能体当前空闲。',
            pendingInjectCount: 0,
            turns: [],
          },
        })
      })
      await page.route('**/api/events', (request) =>
        request.fulfill({ status: 200, contentType: 'text/event-stream', body: '' }),
      )
      await page.route('**/api/llm/providers', (request) => request.fulfill({ json: providerSettingsSnapshot }))
      await page.route('**/api/platform-users*', (request) => request.fulfill({ json: memberDirectory }))
      try {
        await page.goto(`${baseUrl}${scenario.route}`)
        await playwrightExpect(page.getByText(scenario.marker, { exact: true }).first()).toBeVisible()
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
        expect(overflow, scenario.name).toBeLessThanOrEqual(0)
        if (captureDirectory) {
          await page.screenshot({ path: join(captureDirectory, `${scenario.name}.png`), fullPage: true })
        }
      } finally {
        await page.close()
      }
    }
  })

  test('lets a system-managed account selection still add a QR-login account', async () => {
    const snapshot = HostApiContracts.snapshot.response.parse({
      ...browserSnapshot,
      connectionAdapters: [...browserSnapshot.connectionAdapters, wechatAdapter],
    })

    await withProductPage(
      `/wiring/connections/${browserConnectionId}`,
      async (page) => {
        const add = page.getByRole('button', { name: '添加账号' })
        await playwrightExpect(add).toBeVisible()
        await add.click()
        await playwrightExpect(page).toHaveURL(/\/wiring\/new$/u)
        await page
          .getByRole('main')
          .getByRole('button', { name: /^微信 iLink/u })
          .click()
        await page.getByRole('button', { name: '扫码登录' }).click()

        const qrImage = page.getByRole('img', { name: '微信 iLink登录二维码' })
        await playwrightExpect(qrImage).toBeVisible()
        await playwrightExpect(qrImage).toHaveAttribute('src', /^data:image\/svg\+xml;charset=UTF-8,/u)
        await playwrightExpect(page.locator('main')).not.toContainText('https://qr.example.invalid/login-fixture')
        await playwrightExpect(page.locator('main')).not.toContainText('机器人账号 ID')
        await playwrightExpect(page.locator('main')).not.toContainText('访问令牌')
      },
      snapshot,
      async (page) => {
        await page.route('**/api/connection-logins', (request) => request.fulfill({ status: 201, json: wechatLogin }))
        await page.route('**/api/connection-logins/login-fixture', (request) => request.fulfill({ json: wechatLogin }))
      },
    )
  })

  test('keeps the wechat iLink QR login open across host refreshes', async () => {
    const snapshot = HostApiContracts.snapshot.response.parse({
      ...browserSnapshot,
      connectionAdapters: [...browserSnapshot.connectionAdapters, wechatAdapter],
    })

    let snapshotRequests = 0
    await withProductPage(
      '/wiring/new?adapter=wechat-ilink',
      async (page) => {
        await playwrightExpect(page.getByRole('heading', { name: '添加微信 iLink账号' })).toBeVisible()
        await page.getByRole('button', { name: '扫码登录' }).click()
        const qrImage = page.getByRole('img', { name: '微信 iLink登录二维码' })
        await playwrightExpect(qrImage).toBeVisible()
        const requestsBeforeRefresh = snapshotRequests
        await page.evaluate(() => window.dispatchEvent(new Event('online')))
        await playwrightExpect.poll(() => snapshotRequests).toBeGreaterThan(requestsBeforeRefresh)
        await playwrightExpect(page.getByRole('heading', { name: '添加微信 iLink账号' })).toBeVisible()
        await playwrightExpect(qrImage).toBeVisible()
        await playwrightExpect(page.getByRole('heading', { name: '添加平台账号' })).toHaveCount(0)
      },
      snapshot,
      async (page) => {
        await page.route('**/api/snapshot', async (request) => {
          snapshotRequests += 1
          await request.fulfill({ json: snapshot })
        })
        await page.route('**/api/connection-logins', (request) => request.fulfill({ status: 201, json: wechatLogin }))
        await page.route('**/api/connection-logins/login-fixture', (request) => request.fulfill({ json: wechatLogin }))
      },
    )
  })

  test('renders and updates the wechat iLink inbound media setting from account details', async () => {
    const wechatSnapshot = HostApiContracts.snapshot.response.parse({
      ...browserSnapshot,
      connectionAdapters: [...browserSnapshot.connectionAdapters, wechatAdapter],
      connections: [
        ...browserSnapshot.connections,
        {
          id: wechatConnectionId,
          adapterKey: 'wechat-ilink',
          activityTriggerDefaults: [],
          status: { state: 'connected', credentialConfigured: true, proactiveSend: false, activities: {} },
          channelCount: 0,
          knownChannels: [],
          configuration: { enableInboundMedia: false },
        },
      ],
    })
    let inboundMediaEnabled = false
    let updateRequestBody: unknown

    await withProductPage(
      `/wiring/connections/${wechatConnectionId}`,
      async (page) => {
        await playwrightExpect(page.getByRole('heading', { name: '连接设置' })).toBeVisible()
        const toggle = page.getByRole('switch', { name: '入站媒体接收' })
        await playwrightExpect(toggle).toHaveAttribute('aria-checked', 'false')
        await toggle.click()
        await playwrightExpect(toggle).toHaveAttribute('aria-checked', 'true')
      },
      wechatSnapshot,
      async (page) => {
        await page.route('**/api/snapshot', (request) =>
          request.fulfill({
            json: {
              ...wechatSnapshot,
              connections: wechatSnapshot.connections.map((connection) =>
                connection.id === wechatConnectionId
                  ? { ...connection, configuration: { enableInboundMedia: inboundMediaEnabled } }
                  : connection,
              ),
            },
          }),
        )
        await page.route(`**/api/connections/${wechatConnectionId}/configuration`, async (request) => {
          updateRequestBody = request.request().postDataJSON()
          const value =
            HostApiContracts.updateConnectionConfiguration.parseRequest(updateRequestBody).configuration[
              'enableInboundMedia'
            ]
          if (typeof value !== 'boolean') throw new Error('Expected a boolean inbound-media setting.')
          inboundMediaEnabled = value
          await request.fulfill({
            json: { connectionId: wechatConnectionId, configuration: { enableInboundMedia: inboundMediaEnabled } },
          })
        })
      },
    )
    expect(updateRequestBody).toEqual({ configuration: { enableInboundMedia: true } })
  })
})
