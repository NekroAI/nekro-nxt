import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, expect as playwrightExpect, type Browser, type Page } from '@playwright/test'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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
} from '@nekro-nxt/contracts'
import { hostPresentation, NekroNxtApp } from '../src/app.js'
import { runHostRefresh } from '../src/components/product-feedback.js'
import { ProductHostCoordinator, type ProductSnapshot } from '../src/product-port.js'
import { setActiveProductHost, useProductStore } from '../src/product-store.js'

const renderRoute = (route: string): string =>
  renderToStaticMarkup(
    <MemoryRouter initialEntries={[route]}>
      <NekroNxtApp />
    </MemoryRouter>,
  )

const browserAgentId = AgentIdSchema.parse('agt_verylongtechnicalid')
const browserRevisionId = AgentRevisionIdSchema.parse('arev_technicalid')
const browserChannelId = ChannelIdSchema.parse('chn_webmain')
const emptyChannelId = ChannelIdSchema.parse('chn_empty')
const qqChannelId = ChannelIdSchema.parse('chn_qqinternal')
const browserConnectionId = ConnectionIdSchema.parse('con_webinternal')
const qqConnectionId = ConnectionIdSchema.parse('con_qqinternal')
const browserExtensionId = ExtensionIdSchema.parse('ext_internal')
const browserExtensionRevisionId = ExtensionRevisionIdSchema.parse('xrv_internal')
const browserEpisodeId = EpisodeIdSchema.parse('eps_browser')
const browserEventId = ChannelEventIdSchema.parse('evt_current')
const otherEventId = ChannelEventIdSchema.parse('evt_other')
const browserSnapshot = HostApiContracts.snapshot.response.parse({
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
      displayName: '内置频道',
      description: '内置频道',
      userCreatable: false,
      aliasEditable: false,
      channelDiscovery: 'host-created',
      diagnostics: { receive: false, send: false },
      configSchema: { schemaVersion: 1, type: 'object', required: [], properties: {} },
    },
    {
      key: 'qq-openclaw',
      displayName: 'QQ 开放平台',
      description: '连接 QQ 机器人账号',
      userCreatable: true,
      aliasEditable: true,
      channelDiscovery: 'adapter-observed',
      diagnostics: { receive: true, send: true },
      configSchema: { schemaVersion: 1, type: 'object', required: [], properties: {} },
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
      platformChannelId: 'web-main-platform-id',
      kind: 'web',
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
      kind: 'web',
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
      id: qqChannelId,
      connectionId: qqConnectionId,
      platformChannelId: 'qq-platform-channel-1234',
      kind: 'group',
      displayName: '产品讨论群',
      boundAgentId: browserAgentId,
      bindings: [
        {
          channelId: qqChannelId,
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
      channelId: qqChannelId,
      role: 'member',
      parts: [{ type: 'text', text: '不能混入当前频道' }],
      occurredAt: 1_725_000_001_000,
    },
  ],
  connections: [
    {
      id: browserConnectionId,
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
      appId: '1234567890',
      credentialConfigured: true,
      proactiveSend: true,
      channelCount: 1,
      knownChannels: [{ id: qqChannelId, name: '产品讨论群', kind: 'group' }],
      gateway: { state: 'connected', resumed: true },
      receiveTest: { status: 'received', channelId: qqChannelId, platformMessageId: 'qq-received' },
    },
  ],
  extensions: [
    {
      id: browserExtensionId,
      slug: 'document-review',
      displayName: '文档复核',
      description: '检查文档中的遗漏',
      createdByAgentId: browserAgentId,
      revisions: [
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
            renderedSlots: [],
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
    },
  ],
} as const

beforeEach(() => {
  setActiveProductHost(null)
  useProductStore.setState({
    host: { status: 'initializing', error: null, lastSuccessfulAt: null },
    connectionAdapters: [],
    models: [],
    agents: [],
    channels: [],
    messages: [],
    connections: [],
    extensions: [],
    approvals: [],
    dynamic: [],
    diagnosticNote: '',
    theme: 'light',
    reducedMotion: false,
  })
})

afterEach(() => setActiveProductHost(null))

describe('NekroNxt product shell', () => {
  it.each([
    ['initializing', '正在连接', 'info'],
    ['ready', '运行正常', 'success'],
    ['stale', '连接不稳定', 'warning'],
    ['error', '无法连接', 'error'],
  ] as const)('maps Host %s state to an explicit product status', (status, label, tone) => {
    expect(hostPresentation(status)).toEqual({ label, tone })
  })

  it('uses the product navigation order and keeps creator and runtime out of primary navigation', () => {
    const markup = renderRoute('/work/agents/new')
    const navigation = markup.slice(markup.indexOf('<nav'), markup.indexOf('</nav>'))
    expect(navigation.indexOf('工作')).toBeLessThan(navigation.indexOf('连接'))
    expect(navigation.indexOf('连接')).toBeLessThan(navigation.indexOf('扩展'))
    expect(navigation.indexOf('扩展')).toBeLessThan(navigation.indexOf('设置'))
    expect(navigation).not.toContain('Collection')
    expect(navigation).not.toContain('Workbench')
    expect(navigation).not.toContain('Conversation')
    expect(navigation).not.toContain('Configuration')
    expect(navigation).not.toContain('href="/creator"')
    expect(navigation).not.toContain('href="/runtime"')
  })

  it('keeps the local service-instance control out of an ordinary browser shell', () => {
    const markup = renderRoute('/work/agents/new')
    expect(markup).toContain('主题：浅色；切换为深色')
    expect(markup).not.toContain('管理并添加远程服务实例：')
  })

  it('renders the initial intelligent-agent loading state without demo identities or hard-coded health', () => {
    const markup = renderRoute('/work/agents/new')
    expect(markup).toContain('创建智能体')
    expect(markup).toContain('新智能体草稿')
    expect(markup).toContain('正在连接')
    expect(markup).not.toContain('小奈')
    expect(markup).not.toContain('Local Node')
    expect(markup).not.toContain('v0.1')
  })

  it('distinguishes loading across the priority product routes', () => {
    expect(renderRoute('/work/channels/chn_loading')).toContain('正在读取频道')
    expect(renderRoute('/connections')).toContain('正在读取连接')
    expect(renderRoute('/extensions')).toContain('正在读取扩展')
    expect(renderRoute('/settings')).toContain('正在读取模型供应商')
  })

  it('keeps domain-page chrome stable around local content regions', () => {
    const users = renderRoute('/users')
    const userMarkers = [
      'data-page-header=""',
      'data-page-toolbar=""',
      'data-table-header=""',
      'data-table-scroll-region=""',
      'data-table-pagination=""',
    ]
    for (const marker of userMarkers) expect(users).toContain(marker)
    for (let index = 1; index < userMarkers.length; index += 1) {
      expect(users.indexOf(userMarkers[index - 1] ?? '')).toBeLessThan(users.indexOf(userMarkers[index] ?? ''))
    }
    expect(users).toContain('data-empty-state=""')

    for (const [route, page] of [
      ['/extensions', 'extensions'],
      ['/settings', 'settings'],
    ] as const) {
      const markup = renderRoute(route)
      expect(markup).toContain(`data-product-page="${page}"`)
      expect(markup).toContain('data-page-header=""')
      expect(markup).toContain('data-route-transition=""')
      expect(markup.indexOf('data-page-header=""')).toBeLessThan(markup.indexOf('data-route-transition=""'))
    }
    expect(renderRoute('/extensions')).toContain('data-empty-state=""')
  })

  it('keeps direct creator and runtime routes honest when no snapshot data is available', () => {
    const creator = renderRoute('/work/creator')
    const runtime = renderRoute('/runtime')
    expect(creator).toContain('正在读取动态状态')
    expect(runtime).toContain('正在读取')
    expect(runtime).not.toContain('12:45:08')
    expect(runtime).not.toContain('最近备份')
    expect(runtime).not.toContain('SQLite')
  })

  it('keeps model settings product-facing while exposing the separate DSH extension surface', () => {
    const markup = renderRoute('/settings')
    expect(markup).toContain('模型供应商')
    expect(markup).toContain('DSH 扩展')
    expect(markup).not.toContain('Provider ID')
    expect(markup).not.toContain('Revision')
  })

  it('settles reconnect pending state and exposes a rejected refresh as local feedback', async () => {
    const pendingStates: boolean[] = []
    const errors: string[] = []

    await expect(
      runHostRefresh(
        vi.fn(() => Promise.reject(new Error('连接仍不可用'))),
        (pending) => pendingStates.push(pending),
        (message) => errors.push(message),
      ),
    ).resolves.toBeUndefined()

    expect(pendingStates).toEqual([true, false])
    expect(errors).toEqual(['', '连接仍不可用'])
  })

  it('settles reconnect pending state after a successful refresh', async () => {
    const pendingStates: boolean[] = []
    const errors: string[] = []

    await runHostRefresh(
      vi.fn(() => Promise.resolve()),
      (pending) => pendingStates.push(pending),
      (message) => errors.push(message),
    )

    expect(pendingStates).toEqual([true, false])
    expect(errors).toEqual([''])
  })

  it('subscribes the Shell to authoritative Host projections through a narrow Port', () => {
    const state = useProductStore.getState()
    let snapshot: ProductSnapshot = {
      host: state.host,
      connectionAdapters: state.connectionAdapters,
      capabilityAvailability: state.capabilityAvailability,
      models: state.models,
      agents: state.agents,
      channels: state.channels,
      messages: state.messages,
      channelRuntimes: state.channelRuntimes,
      connections: state.connections,
      extensions: state.extensions,
      platformUsersRevision: state.platformUsersRevision,
      approvals: state.approvals,
      dynamic: state.dynamic,
      notificationSettings: state.notificationSettings,
      diagnosticNote: 'projection-v1',
      workTreeOrder: state.workTreeOrder,
    }
    let listener: (() => void) | undefined
    const coordinator = new ProductHostCoordinator({
      getSnapshot: () => snapshot,
      subscribe: (next) => {
        listener = next
        return () => {
          listener = undefined
        }
      },
      execute: () => Promise.resolve(null),
    })
    coordinator.start()
    expect(useProductStore.getState().diagnosticNote).toBe('projection-v1')
    snapshot = { ...snapshot, diagnosticNote: 'projection-v2' }
    listener?.()
    expect(useProductStore.getState().diagnosticNote).toBe('projection-v2')
    coordinator.dispose()
    expect(listener).toBeUndefined()
  })

  it('propagates a Host send failure so the composer can preserve its draft', async () => {
    const failure = new Error('模型凭据不可用')
    setActiveProductHost({
      getSnapshot: () => {
        const state = useProductStore.getState()
        return {
          host: state.host,
          connectionAdapters: state.connectionAdapters,
          capabilityAvailability: state.capabilityAvailability,
          models: state.models,
          agents: state.agents,
          channels: state.channels,
          messages: state.messages,
          channelRuntimes: state.channelRuntimes,
          connections: state.connections,
          extensions: state.extensions,
          platformUsersRevision: state.platformUsersRevision,
          approvals: state.approvals,
          dynamic: state.dynamic,
          notificationSettings: state.notificationSettings,
          diagnosticNote: state.diagnosticNote,
          workTreeOrder: state.workTreeOrder,
        }
      },
      subscribe: () => () => undefined,
      execute: (command) => (command === 'channels.sendMessage' ? Promise.reject(failure) : Promise.resolve(null)),
    })

    await expect(useProductStore.getState().sendMessage(browserChannelId, '保留这段草稿')).rejects.toBe(failure)
  })
})

describe.sequential('NekroNxt browser projections', { timeout: 30_000 }, () => {
  let server: ViteDevServer
  let browser: Browser
  let baseUrl: string
  let cacheDirectory: string

  beforeAll(async () => {
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
  }, 30_000)

  afterAll(async () => {
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
      if (message.type() === 'error') runtimeErrors.push(message.text())
    })
    const parsedSnapshot = HostApiContracts.snapshot.response.parse(snapshot)
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
                    state: 'completed',
                    producedReply: true,
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
                    state: 'completed',
                    producedReply: false,
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
        body: JSON.stringify({ messages, hasMore: false }),
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
    await page.route('**/api/platform-users*', (request) =>
      request.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          total: 0,
          items: [],
          facets: { adapters: [], connections: [] },
        }),
      }),
    )
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

  it('keeps the Desktop service-instance entry available across redirects and navigation when the bridge exists', async () => {
    await withProductPage(
      '/',
      async (page) => {
        const instanceButton = page.getByRole('button', { name: /^管理并添加远程服务实例：远程开发环境/u })
        await playwrightExpect(page).toHaveURL(new RegExp(`/work/channels/${browserChannelId}$`, 'u'))
        await playwrightExpect(instanceButton).toBeVisible()
        await playwrightExpect(instanceButton).toHaveAccessibleName('管理并添加远程服务实例：远程开发环境 · 运行正常')

        await page.getByRole('link', { name: '用户' }).click()
        await playwrightExpect(page).toHaveURL(/\/users$/u)
        await playwrightExpect(instanceButton).toBeVisible()

        await page.getByRole('link', { name: '设置' }).click()
        await playwrightExpect(page).toHaveURL(/\/settings$/u)
        await playwrightExpect(instanceButton).toBeVisible()
        await instanceButton.click()
        await playwrightExpect
          .poll(() =>
            page.evaluate(
              () => (window as Window & { __instanceSwitcherOpenCount?: number }).__instanceSwitcherOpenCount,
            ),
          )
          .toBe(1)
        await playwrightExpect(instanceButton).toHaveAttribute('aria-expanded', 'true')
        await instanceButton.click()
        await playwrightExpect(instanceButton).toHaveAttribute('aria-expanded', 'false')
        await playwrightExpect
          .poll(() =>
            page.evaluate(
              () => (window as Window & { __instanceSwitcherCloseCount?: number }).__instanceSwitcherCloseCount,
            ),
          )
          .toBe(1)
        await playwrightExpect
          .poll(() =>
            page.evaluate(
              () => (window as Window & { __instanceSwitcherOpenCount?: number }).__instanceSwitcherOpenCount,
            ),
          )
          .toBe(1)
      },
      browserSnapshot,
      async (page) => {
        await page.addInitScript(() => {
          const testWindow = window as Window & {
            __instanceSwitcherOpenCount?: number
            __instanceSwitcherCloseCount?: number
            __resolveInstanceSwitcher?: () => void
          }
          testWindow.__instanceSwitcherOpenCount = 0
          testWindow.__instanceSwitcherCloseCount = 0
          Object.defineProperty(window, 'nekroDesktopShell', {
            configurable: true,
            value: {
              getCurrentInstancePresentation: () =>
                Promise.resolve({ revision: 1, displayName: '远程开发环境', status: 'ready' as const }),
              openInstanceSwitcher: () => {
                testWindow.__instanceSwitcherOpenCount = (testWindow.__instanceSwitcherOpenCount ?? 0) + 1
                return new Promise<void>((resolve) => {
                  testWindow.__resolveInstanceSwitcher = resolve
                })
              },
              closeInstanceSwitcher: () => {
                testWindow.__instanceSwitcherCloseCount = (testWindow.__instanceSwitcherCloseCount ?? 0) + 1
                testWindow.__resolveInstanceSwitcher?.()
                return Promise.resolve()
              },
              subscribeCurrentInstanceStatus: () => () => undefined,
            },
          })
        })
      },
    )
  })

  it('does not let an older Desktop presentation request overwrite a newer subscribed event', async () => {
    await withProductPage(
      '/',
      async (page) => {
        const entry = page.getByRole('button', { name: /^管理并添加远程服务实例：北辰实例/u })
        await playwrightExpect(entry).toHaveAccessibleName('管理并添加远程服务实例：北辰实例 · 无法连接')
        await page.evaluate(() => {
          ;(
            window as Window & {
              __resolveInitialDesktopPresentation?: (state: {
                revision: number
                displayName: string
                status: 'ready'
              }) => void
            }
          ).__resolveInitialDesktopPresentation?.({ revision: 4, displayName: '旧实例名称', status: 'ready' })
        })
        await page.waitForTimeout(20)
        await playwrightExpect(entry).toHaveAccessibleName('管理并添加远程服务实例：北辰实例 · 无法连接')
      },
      browserSnapshot,
      async (page) => {
        await page.addInitScript(() => {
          const testWindow = window as Window & {
            __resolveInitialDesktopPresentation?: (state: {
              revision: number
              displayName: string
              status: 'ready'
            }) => void
          }
          Object.defineProperty(window, 'nekroDesktopShell', {
            configurable: true,
            value: {
              getCurrentInstancePresentation: () =>
                new Promise((resolve) => {
                  testWindow.__resolveInitialDesktopPresentation = resolve
                }),
              openInstanceSwitcher: () => Promise.resolve(),
              closeInstanceSwitcher: () => Promise.resolve(),
              subscribeCurrentInstanceStatus: (listener: (state: unknown) => void) => {
                queueMicrotask(() => listener({ revision: 5, displayName: '北辰实例', status: 'offline' as const }))
                return () => undefined
              },
            },
          })
        })
      },
    )
  })

  it('accepts protocol-1 Desktop shapes without revision and keeps subscription arrival order', async () => {
    await withProductPage(
      '/',
      async (page) => {
        const entry = page.getByRole('button', { name: /^管理并添加远程服务实例：旧版远程实例/u })
        await playwrightExpect(entry).toHaveAccessibleName('管理并添加远程服务实例：旧版远程实例 · 无法连接')
        await page.evaluate(() => {
          ;(
            window as Window & {
              __publishLegacyDesktopPresentation?: (state: { displayName: string; status: 'ready' | 'offline' }) => void
            }
          ).__publishLegacyDesktopPresentation?.({ displayName: '旧版远程实例', status: 'ready' })
        })
        await playwrightExpect(entry).toHaveAccessibleName('管理并添加远程服务实例：旧版远程实例 · 运行正常')
        await page.evaluate(() => {
          ;(
            window as Window & {
              __resolveLegacyInitialDesktopPresentation?: (state: { displayName: string; status: 'ready' }) => void
            }
          ).__resolveLegacyInitialDesktopPresentation?.({ displayName: '迟到初始实例', status: 'ready' })
        })
        await page.waitForTimeout(20)
        await playwrightExpect(entry).toHaveAccessibleName('管理并添加远程服务实例：旧版远程实例 · 运行正常')
      },
      browserSnapshot,
      async (page) => {
        await page.addInitScript(() => {
          const testWindow = window as Window & {
            __publishLegacyDesktopPresentation?: (state: unknown) => void
            __resolveLegacyInitialDesktopPresentation?: (state: unknown) => void
          }
          Object.defineProperty(window, 'nekroDesktopShell', {
            configurable: true,
            value: {
              getCurrentInstancePresentation: () =>
                new Promise((resolve) => {
                  testWindow.__resolveLegacyInitialDesktopPresentation = resolve
                }),
              openInstanceSwitcher: () => Promise.resolve(),
              closeInstanceSwitcher: () => Promise.resolve(),
              subscribeCurrentInstanceStatus: (listener: (state: unknown) => void) => {
                testWindow.__publishLegacyDesktopPresentation = listener
                queueMicrotask(() => listener({ displayName: '旧版远程实例', status: 'offline' as const }))
                return () => undefined
              },
            },
          })
        })
      },
    )
  })

  it('keeps model provider setup inside the create page when no models exist', async () => {
    const snapshot = {
      ...browserSnapshot,
      models: [],
    }
    await withProductPage(
      '/work/agents/new',
      async (page) => {
        await playwrightExpect(page.getByRole('dialog')).toHaveCount(0)
        await playwrightExpect(page.getByRole('heading', { name: '创建智能体' })).toBeVisible()
        await page.getByLabel('名称').fill('临时智能体')
        await playwrightExpect(page.getByText('当前没有可用模型。请先保存一个供应商。', { exact: true })).toBeVisible()
        await playwrightExpect(page.getByRole('button', { name: '保存供应商' })).toBeVisible()
        await playwrightExpect(page.locator('body')).not.toContainText('请先在设置中配置模型供应商')
      },
      snapshot,
      async (page) => {
        await page.route('**/api/llm/providers', (request) =>
          request.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
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
                },
              ],
            }),
          }),
        )
      },
    )
  })

  it('edits structured persona references with keyboard-safe chips and a 10–20 line viewport', async () => {
    await withProductPage(
      '/work/agents/new',
      async (page) => {
        const editor = page.getByRole('textbox', { name: '人设' })
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
      },
      browserSnapshot,
      async (page) => {
        await page.route('**/api/platform-users*', (request) =>
          request.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              total: 1,
              items: [
                {
                  identityId: 'pid_membera',
                  displayName: '成员甲',
                  adapter: { key: 'qq-openclaw', displayName: 'QQ 开放平台' },
                  connection: { id: browserConnectionId, displayName: '测试账号' },
                  activeChannelCount: 1,
                  channelPreview: [{ id: browserChannelId, displayName: '资料讨论组', kind: 'group' }],
                  historicalOnly: false,
                },
              ],
              facets: {
                adapters: [{ key: 'qq-openclaw', displayName: 'QQ 开放平台', userCount: 1 }],
                connections: [
                  { id: browserConnectionId, adapterKey: 'qq-openclaw', displayName: '测试账号', userCount: 1 },
                ],
              },
            }),
          }),
        )
      },
    )
  })

  it('renders authoritative intelligent-agent and extension data without technical identifiers', async () => {
    await withProductPage('/work', async (page) => {
      await playwrightExpect(page.getByRole('link', { name: /资料员/u }).first()).toBeVisible()
      await playwrightExpect(page.getByRole('link', { name: '工作' })).toBeVisible()
      await playwrightExpect(page.locator('body')).not.toContainText(browserAgentId)
      await playwrightExpect(page.locator('body')).not.toContainText(browserRevisionId)
    })

    await withProductPage('/extensions', async (page) => {
      await playwrightExpect(page.getByRole('link', { name: /文档复核/u })).toBeVisible()
      await playwrightExpect(page.getByText('已启用', { exact: true }).first()).toBeVisible()
      await playwrightExpect(page.locator('body')).not.toContainText(browserExtensionRevisionId)
      await playwrightExpect(page.locator('body')).not.toContainText('Revision')
    })
  })

  it('shows the platform-user directory and keeps filters in the URL', async () => {
    await withProductPage(
      '/users',
      async (page) => {
        await playwrightExpect(page.getByRole('heading', { name: '平台用户' })).toBeVisible()
        await playwrightExpect(page.getByText('成员甲', { exact: true })).toBeVisible()
        await playwrightExpect(page.locator('body')).not.toContainText('pid_membera')
        await page.getByLabel('搜索名称').fill('成员甲')
        await playwrightExpect(page).toHaveURL(/\/users\?query=/u)
        await page.getByRole('button', { name: '清除筛选' }).click()
        await playwrightExpect(page).toHaveURL(/\/users$/u)
      },
      browserSnapshot,
      async (page) => {
        await page.route('**/api/platform-users*', (request) =>
          request.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              total: 1,
              items: [
                {
                  identityId: 'pid_membera',
                  displayName: '成员甲',
                  adapter: { key: 'qq-openclaw', displayName: 'QQ 开放平台' },
                  connection: { id: browserConnectionId, displayName: '测试账号' },
                  activeChannelCount: 1,
                  channelPreview: [{ id: browserChannelId, displayName: '资料讨论组', kind: 'group' }],
                  historicalOnly: false,
                },
              ],
              facets: {
                adapters: [{ key: 'qq-openclaw', displayName: 'QQ 开放平台', userCount: 1 }],
                connections: [
                  { id: browserConnectionId, adapterKey: 'qq-openclaw', displayName: '测试账号', userCount: 1 },
                ],
              },
            }),
          }),
        )
      },
    )
  })

  it('keeps intelligent-agent configuration on the workbench instead of sending users away', async () => {
    await withProductPage(`/work/agents/${browserAgentId}?tab=capabilities`, async (page) => {
      await playwrightExpect(page.getByRole('button', { name: '保存凭据' })).toBeVisible()
      await playwrightExpect(page.getByRole('button', { name: '前往频道提出需求' })).toHaveCount(0)
      await playwrightExpect(page.getByRole('button', { name: '查看创造进度' }).first()).toBeVisible()
      await playwrightExpect(page.locator('body')).not.toContainText('设置 → DSH 扩展')
    })

    await withProductPage(`/work/agents/${browserAgentId}?tab=channels`, async (page) => {
      await playwrightExpect(page.getByLabel('响应方式').first()).toBeVisible()
      await playwrightExpect(page.getByRole('button', { name: '绑定频道' })).toBeVisible()
    })

    await withProductPage(`/work/agents/${browserAgentId}?tab=extensions`, async (page) => {
      await playwrightExpect(page.getByRole('switch', { name: '停用“文档复核”' })).toBeChecked()
      await playwrightExpect(page.locator('body')).not.toContainText('可在扩展页面查看已保存的扩展和启用状态。')
    })
  })

  it('tracks system-access dragging continuously and previews the nearest snap stop before commit', async () => {
    const capabilityRequests: unknown[] = []
    await withProductPage(
      `/work/agents/${browserAgentId}?tab=capabilities`,
      async (page) => {
        const range = page.getByLabel('系统访问等级')
        await playwrightExpect(range).toBeVisible()
        const geometry = await page.locator('[data-access-level-stop]').evaluateAll((stops) => {
          const track = stops[0]?.parentElement?.previousElementSibling?.getBoundingClientRect()
          const stopRects = stops.map((stop) => stop.getBoundingClientRect())
          const labels = stops[0]?.parentElement?.parentElement?.querySelectorAll('[data-access-level-label]') ?? []
          const labelRects = Array.from(labels).map((label) => label.getBoundingClientRect())
          return {
            trackCenterY: track ? track.top + track.height / 2 : 0,
            trackLeft: track?.left ?? 0,
            trackWidth: track?.width ?? 0,
            stopCentersY: stopRects.map((rect) => rect.top + rect.height / 2),
            stopCentersX: stopRects.map((rect) => rect.left + rect.width / 2),
            labelTops: labelRects.map((rect) => rect.top),
            labelLeft: labelRects[0]?.left ?? 0,
            middleLabelCentersX: labelRects.slice(1, 3).map((rect) => rect.left + rect.width / 2),
            labelRight: labelRects[3]?.right ?? 0,
          }
        })
        const stopOffsets = geometry.stopCentersY.map((center) => center - geometry.trackCenterY)
        expect(
          stopOffsets.every((offset) => Math.abs(offset) < 0.75),
          JSON.stringify(stopOffsets),
        ).toBe(true)
        const expectedStopCenters = Array.from(
          { length: 4 },
          (_, index) => geometry.trackLeft + (geometry.trackWidth * index) / 3,
        )
        expect(
          geometry.stopCentersX.every((center, index) => Math.abs(center - expectedStopCenters[index]!) < 0.75),
        ).toBe(true)
        expect(Math.abs(geometry.labelLeft - geometry.stopCentersX[0]!) < 0.75).toBe(true)
        expect(Math.abs(geometry.middleLabelCentersX[0]! - geometry.stopCentersX[1]!) < 0.75).toBe(true)
        expect(Math.abs(geometry.middleLabelCentersX[1]! - geometry.stopCentersX[2]!) < 0.75).toBe(true)
        expect(Math.abs(geometry.labelRight - geometry.stopCentersX[3]!) < 0.75).toBe(true)
        expect(Math.max(...geometry.labelTops) - Math.min(...geometry.labelTops)).toBeLessThan(0.75)

        await range.scrollIntoViewIfNeeded()
        const box = await range.boundingBox()
        if (!box) throw new Error('系统访问等级滑块没有可用几何尺寸。')
        const y = box.y + box.height / 2
        const hitTarget = await page.evaluate(
          ({ x, y: targetY }) => {
            const element = document.elementFromPoint(x, targetY)
            return {
              tag: element?.tagName,
              type: element instanceof HTMLInputElement ? element.type : undefined,
              disabled: element instanceof HTMLInputElement ? element.disabled : undefined,
              pointerEvents: element ? getComputedStyle(element).pointerEvents : undefined,
            }
          },
          { x: box.x + box.width * 0.54, y },
        )
        expect(hitTarget).toMatchObject({ tag: 'INPUT', type: 'range', disabled: false, pointerEvents: 'auto' })
        await page.mouse.move(box.x + box.width * 0.54, y)
        await page.mouse.down()
        await page.mouse.move(box.x + box.width * 0.58, y, { steps: 8 })

        const continuousValue = Number(await range.inputValue())
        expect(continuousValue).toBeGreaterThan(1.5)
        expect(continuousValue).toBeLessThan(2)
        await playwrightExpect(page.locator('[data-access-level-stop="2"]')).toHaveAttribute('data-snap-target', '')
        expect(capabilityRequests).toHaveLength(0)

        await page.mouse.up()
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
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              currentRevisionId: browserRevisionId,
              capabilities: {
                subagents: false,
                fileTools: true,
                webSearch: false,
                dynamicCreation: true,
                developmentShell: true,
                unrestrictedFileAccess: false,
              },
            }),
          })
        })
      },
    )
  })

  it('renders platform accounts with product labels and binds without leaving the connection page', async () => {
    await withProductPage('/connections', async (page) => {
      await page.getByRole('link', { name: /QQ 开放平台/u }).click()
      await playwrightExpect(page.getByText('尾号 7890', { exact: true })).toBeVisible()
      await playwrightExpect(page.locator('body')).toContainText('内置频道')
      await playwrightExpect(page.getByRole('button', { name: '绑定智能体' })).toBeVisible()
      await playwrightExpect(page.locator('body')).not.toContainText('前往绑定频道')
      await playwrightExpect(page.locator('body')).not.toContainText('1234567890')
      await playwrightExpect(page.locator('body')).not.toContainText('websocket-resumed-internal-enum')
      await playwrightExpect(page.locator('body')).not.toContainText('adapterKey')
    })
  })

  it('creates a Connection with an alias and edits the alias without changing platform identity', async () => {
    let createRequestBody: unknown
    await withProductPage(`/connections/${browserConnectionId}?create=1`, async (page) => {
      await page.route('**/api/connections', async (request) => {
        createRequestBody = request.request().postDataJSON()
        await request.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ connectionId: qqConnectionId, adapterKey: 'qq-openclaw' }),
        })
      })
      const dialog = page.getByRole('dialog')
      await dialog.getByLabel('平台').click()
      await page.getByRole('option', { name: 'QQ 开放平台' }).click()
      await page.getByRole('button', { name: '填写连接信息' }).click()
      await page.getByLabel('连接别名').fill('项目机器人')
      await page.getByRole('button', { name: '创建连接' }).click()
      await playwrightExpect(page.getByRole('dialog')).toBeHidden()
    })
    expect(createRequestBody).toMatchObject({ alias: '项目机器人', adapterKey: 'qq-openclaw' })

    const aliasedSnapshot = {
      ...browserSnapshot,
      connections: browserSnapshot.connections.map((connection) =>
        connection.id === qqConnectionId ? { ...connection, alias: '项目机器人' } : connection,
      ),
    }
    let currentAlias = '项目机器人'
    await withProductPage(
      `/connections/${qqConnectionId}`,
      async (page) => {
        await page.route('**/api/snapshot', async (request) => {
          await request.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              ...aliasedSnapshot,
              connections: aliasedSnapshot.connections.map((connection) =>
                connection.id === qqConnectionId ? { ...connection, alias: currentAlias } : connection,
              ),
            }),
          })
        })
        await page.route(`**/api/connections/${qqConnectionId}/alias`, async (request) => {
          currentAlias = HostApiContracts.updateConnectionAlias.parseRequest(request.request().postDataJSON()).alias
          await request.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ connectionId: qqConnectionId, ...(currentAlias ? { alias: currentAlias } : {}) }),
          })
        })
        await playwrightExpect(page.getByText('项目机器人', { exact: true }).first()).toBeVisible()
        await page.getByLabel('辨识名').fill('研发机器人')
        await page.getByRole('button', { name: '保存别名' }).click()
        await playwrightExpect(page.getByText('研发机器人', { exact: true }).first()).toBeVisible()
        await page.getByRole('button', { name: '清除' }).click()
        await playwrightExpect(page.getByText('QQ 开放平台', { exact: true }).first()).toBeVisible()
        await playwrightExpect(page.getByLabel('辨识名')).toHaveValue('')
      },
      aliasedSnapshot,
    )
  })

  it('isolates Channel messages, renders a true empty state, and names the send target', async () => {
    await withProductPage(`/work/channels/${browserChannelId}`, async (page) => {
      await playwrightExpect(page.getByText('只属于当前频道', { exact: true })).toBeVisible()
      await playwrightExpect(page.locator('body')).not.toContainText('不能混入当前频道')
      await playwrightExpect(page.getByText('发给智能体', { exact: true })).toBeVisible()
      await playwrightExpect(page.locator('[data-conversation-title]').getByText('空闲', { exact: true })).toBeVisible()
      await playwrightExpect(page.getByLabel('空闲状态说明')).toHaveCount(0)
      await playwrightExpect(page.getByLabel('上下文占用')).toContainText('已用 3.2k')
      await playwrightExpect(page.getByLabel('上下文组成')).toContainText('对话 1.9k')
      const generationPerformance = page.getByLabel('生成表现')
      await playwrightExpect(generationPerformance).toContainText('最近请求首 Token')
      await playwrightExpect(generationPerformance).toContainText('400ms')
      await playwrightExpect(generationPerformance).toContainText('50')
      await playwrightExpect(generationPerformance).toContainText('会话平均首 Token')
      await playwrightExpect(generationPerformance).toContainText('生成速度 2/2')
      const cacheAnalysis = page.getByLabel('缓存分析')
      for (const kind of ['cache', 'performance']) {
        const frame = page.locator(`[data-runtime-data-surface="${kind}"]`)
        await playwrightExpect(frame).toBeVisible()
        expect(
          await frame.evaluate((element) => {
            const style = getComputedStyle(element)
            return [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth]
          }),
        ).toEqual(['0px', '0px', '0px', '0px'])
      }
      const cacheBox = await cacheAnalysis.boundingBox()
      const performanceBox = await generationPerformance.boundingBox()
      expect(cacheBox?.y).toBeLessThan(performanceBox?.y ?? 0)
      await playwrightExpect(cacheAnalysis).toContainText('最近一次输入缓存覆盖')
      await playwrightExpect(cacheAnalysis).toContainText('会话加权覆盖')
      await playwrightExpect(cacheAnalysis).toContainText('累计读取 1.8k')
      await playwrightExpect(cacheAnalysis).toContainText('数据覆盖 2/2 次请求')
      const captureDirectory = process.env['NEKRO_VISUAL_CAPTURE']
      if (captureDirectory) {
        await mkdir(captureDirectory, { recursive: true })
        await page.screenshot({ path: join(captureDirectory, 'channel-runtime-light-1440.png'), fullPage: true })
        await page.evaluate(() => window.localStorage.setItem('nekro-nxt.theme', 'dark'))
        await page.reload()
        await page.screenshot({ path: join(captureDirectory, 'channel-runtime-dark-1440.png'), fullPage: true })
        await page.evaluate(() => window.localStorage.setItem('nekro-nxt.theme', 'light'))
        await page.reload()
        await generationPerformance.scrollIntoViewIfNeeded()
        await page.screenshot({ path: join(captureDirectory, 'channel-performance-light-1440.png'), fullPage: true })
        await page.evaluate(() => window.localStorage.setItem('nekro-nxt.theme', 'dark'))
        await page.reload()
        await generationPerformance.scrollIntoViewIfNeeded()
        await page.screenshot({ path: join(captureDirectory, 'channel-performance-dark-1440.png'), fullPage: true })
        await page.evaluate(() => window.localStorage.setItem('nekro-nxt.theme', 'light'))
        await page.reload()
      }
      await playwrightExpect(page.getByRole('link', { name: /资料员/u }).first()).toBeVisible()
      const chatTab = page.getByRole('tab', { name: '会话' })
      const trajectoryTab = page.getByRole('tab', { name: '工作轨迹' })
      await playwrightExpect(chatTab).toBeVisible()
      await playwrightExpect(trajectoryTab).toBeVisible()
      await playwrightExpect(chatTab).toHaveAttribute('aria-selected', 'true')
      await playwrightExpect(page.getByLabel('响应方式')).toBeVisible()
      await playwrightExpect(page.getByRole('button', { name: '更换' })).toBeVisible()
      await playwrightExpect(page.getByRole('button', { name: '管理' })).toBeVisible()
      await playwrightExpect(page.getByLabel('工作轨迹时间轴')).toHaveCount(0)
      await chatTab.focus()
      await page.keyboard.press('ArrowRight')
      await playwrightExpect(trajectoryTab).toHaveAttribute('aria-selected', 'true')
      await playwrightExpect(page.getByLabel('消息内容')).toHaveCount(0)
      await playwrightExpect(page.getByRole('columnheader', { name: '事件' })).toBeVisible()
      await playwrightExpect(page.getByLabel('工作轨迹时间轴')).toBeVisible()
      await playwrightExpect(page.getByLabel('工作轨迹时间轴')).toContainText('内部')
      await playwrightExpect(page.getByLabel('工作轨迹时间轴')).toContainText('发送')
      const turnBoundary = page.getByRole('button', { name: 'Turn 2', exact: true })
      await playwrightExpect(turnBoundary).toBeVisible()
      const turnBox = await turnBoundary.boundingBox()
      expect(turnBox?.width).toBeGreaterThanOrEqual(28)
      expect(turnBox?.height).toBeGreaterThanOrEqual(80)
      const sendMark = page.getByRole('button', { name: /发送频道消息/u })
      const sendBox = await sendMark.boundingBox()
      expect(sendBox?.width).toBeGreaterThanOrEqual(27.9)
      expect(sendBox?.height).toBeGreaterThanOrEqual(27.9)
      await sendMark.click()
      const trajectoryInspector = page.locator('aside[aria-label="工作轨迹"]')
      await playwrightExpect(trajectoryInspector.getByRole('heading', { name: '发出的内容' })).toBeVisible()
      await playwrightExpect(trajectoryInspector.getByText('活动改到 19:30。')).toBeVisible()
      const readRow = page.getByRole('row').filter({ hasText: '读取文件' })
      await readRow.focus()
      await page.keyboard.press('Enter')
      await playwrightExpect(readRow).toHaveAttribute('aria-current', 'true')
      await page.keyboard.press('ArrowDown')
      const sendRow = page.getByRole('row').filter({ hasText: '发送频道消息' })
      await playwrightExpect(sendRow).toBeFocused()
      await playwrightExpect(sendRow).toHaveAttribute('aria-current', 'true')
      await playwrightExpect(page.getByRole('button', { name: '摘要' })).toHaveCount(0)
      await trajectoryTab.focus()
      await page.keyboard.press('ArrowLeft')
      await playwrightExpect(chatTab).toHaveAttribute('aria-selected', 'true')
      await playwrightExpect(page.getByLabel('工作轨迹时间轴')).toHaveCount(0)
      await playwrightExpect(page.getByLabel('响应方式')).toBeVisible()
      await playwrightExpect(page.locator('body')).not.toContainText('管理绑定')
      await playwrightExpect(page.locator('body')).not.toContainText('编辑频道绑定')
      await playwrightExpect(page.locator('body')).not.toContainText('正在使用工具')
    })

    await withProductPage(`/work/channels/${emptyChannelId}`, async (page) => {
      await playwrightExpect(page.getByText('还没有消息', { exact: true })).toBeVisible()
      await playwrightExpect(page.getByText('发给智能体', { exact: true })).toBeVisible()
    })
  })

  it('shows real dynamic state without displaying package or approval identifiers', async () => {
    await withProductPage('/work/creator', async (page) => {
      await playwrightExpect(page.getByRole('button', { name: /技术探针/u })).toBeVisible()
      await playwrightExpect(page.getByText('等待确认', { exact: true }).first()).toBeVisible()
      await playwrightExpect(page.locator('body')).not.toContainText('technical-plugin-id')
      await playwrightExpect(page.locator('body')).not.toContainText('technical-package-id')
      await playwrightExpect(page.locator('body')).not.toContainText('approval-internal-id')
    })
  })

  it('loads the official DSH settings surface through the shared Client Runtime and theme bridge', async () => {
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
      await page.goto(`${baseUrl}/settings?tab=dsh-extensions`)
      await playwrightExpect(page.getByText('DeepSeek 网页搜索', { exact: true }).first()).toBeVisible()
      await playwrightExpect(page.getByText('内置', { exact: true }).first()).toBeVisible()
      await playwrightExpect(page.getByText('用户安装', { exact: true }).first()).toBeVisible()
      await playwrightExpect(page.getByText('加载失败', { exact: true }).first()).toBeVisible()
      await playwrightExpect(page.locator('body')).not.toContainText('已验证支持')
      await playwrightExpect(page.locator('body')).not.toContainText('未完整验证')
      await page.getByText('@example/dsh-broken-extension', { exact: true }).click()
      await playwrightExpect(page.getByText('缺少运行所需的测试服务。', { exact: true })).toBeVisible()
      await page.getByText('DeepSeek 网页搜索', { exact: true }).first().click()
      await playwrightExpect(page.getByText('DSH 原生界面', { exact: true }).first()).toBeVisible()
      await playwrightExpect(page.locator('[data-dsh-native-surface]')).toBeVisible()
      await playwrightExpect(page.locator('[data-dsh-native-surface]')).toContainText(/Web search|网页搜索/, {
        timeout: 8_000,
      })
      const mappedColor = await page
        .locator('[data-dsh-native-surface]')
        .evaluate((element) => getComputedStyle(element).getPropertyValue('--dsw-alias-brand-primary').trim())
      expect(mappedColor).not.toBe('')

      await page.getByRole('tab', { name: '通用配置' }).click()
      await page.getByLabel('maxUses').fill('4')
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
      const clearDialog = page.getByRole('alertdialog')
      await playwrightExpect(clearDialog.getByRole('heading', { name: '清除“DEEPSEEK_API_KEY”' })).toBeVisible()
      expect(credentialDeleteAttempts).toBe(0)
      await clearDialog.getByRole('button', { name: '保留凭据' }).click()
      await playwrightExpect(clearDialog).toBeHidden()
      await playwrightExpect(clearTrigger).toBeFocused()
      expect(credentialDeleteAttempts).toBe(0)

      await clearTrigger.click()
      await clearDialog.getByRole('button', { name: '清除该凭据' }).click()
      await playwrightExpect.poll(() => credentialDeleteAttempts).toBe(1)
      await playwrightExpect(clearDialog.getByRole('button', { name: '正在清除…' })).toBeDisabled()
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

      await page.getByLabel('maxTokens').fill('2048')
      await page.getByRole('button', { name: '保存扩展配置' }).click()
      await playwrightExpect(page.getByText('配置已在其他位置更新；当前草稿已保留，请核对后重新保存。')).toBeVisible()
      await playwrightExpect(page.getByLabel('maxTokens')).toHaveValue('2048')
      expect(runtimeErrors.filter((message) => !message.includes('status of 500'))).toEqual([])
    } finally {
      await page.close()
    }
  }, 20_000)

  it('renders every safe generic Schema family for an unowned live Settings namespace', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    const runtimeErrors: string[] = []
    page.on('pageerror', (error) => runtimeErrors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') runtimeErrors.push(message.text())
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
    try {
      await page.goto(`${baseUrl}/settings?tab=dsh-extensions`)
      await playwrightExpect(page.getByText('runtime-extra', { exact: true }).first()).toBeVisible()
      await playwrightExpect(page.getByText('其他扩展', { exact: true }).first()).toBeVisible()
      await playwrightExpect(page.getByText(/当前 DSH Host 运行时注册/)).toBeVisible()
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
  }, 15_000)

  it('keeps the last successful data visible when the live connection becomes stale', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    const pageErrors: string[] = []
    let snapshotRequests = 0
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.route('**/api/snapshot', (request) => {
      snapshotRequests += 1
      if (snapshotRequests === 1) {
        return request.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(browserSnapshot),
        })
      }
      return request.abort('failed')
    })
    await page.route('**/api/events', (request) =>
      request.fulfill({ status: 200, contentType: 'text/event-stream', body: '' }),
    )
    try {
      await page.goto(`${baseUrl}/work`)
      await playwrightExpect(page.getByRole('link', { name: /资料员/u }).first()).toBeVisible()
      await playwrightExpect(page.getByText('连接不稳定', { exact: true }).first()).toBeVisible({ timeout: 8_000 })
      await playwrightExpect(page.getByText('当前显示最近一次同步的数据。', { exact: true })).toBeVisible()
      await playwrightExpect(page.getByRole('link', { name: /资料员/u }).first()).toBeVisible()
      expect(pageErrors).toEqual([])
    } finally {
      await page.close()
    }
  }, 12_000)

  it('keeps priority layouts within the desktop viewport at 1100, 1440, and 1920 pixels', async () => {
    const cases = [
      { width: 1100, height: 720, route: '/connections', name: 'connections-1100', marker: 'QQ 开放平台' },
      {
        width: 1440,
        height: 900,
        route: `/work/channels/${browserChannelId}`,
        name: 'channel-1440',
        marker: '只属于当前频道',
      },
      {
        width: 1440,
        height: 900,
        route: `/work/channels/${browserChannelId}`,
        name: 'channel-dark-1440',
        marker: '只属于当前频道',
        colorScheme: 'dark',
      },
      { width: 1920, height: 1080, route: '/work', name: 'agents-1920', marker: '资料员' },
      {
        width: 1440,
        height: 900,
        route: '/work',
        name: 'agents-dark-reduced-motion-1440',
        marker: '资料员',
        colorScheme: 'dark',
        reducedMotion: 'reduce',
      },
      { width: 1440, height: 900, route: '/settings', name: 'settings-1440', marker: 'API 密钥已保存' },
    ] as const
    const captureDirectory = process.env['NEKRO_VISUAL_CAPTURE']
    if (captureDirectory) await mkdir(captureDirectory, { recursive: true })

    for (const scenario of cases) {
      const page = await browser.newPage({
        viewport: { width: scenario.width, height: scenario.height },
        colorScheme: 'colorScheme' in scenario ? scenario.colorScheme : 'light',
        reducedMotion: 'reducedMotion' in scenario ? scenario.reducedMotion : 'no-preference',
      })
      await page.route('**/api/snapshot', (request) =>
        request.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(browserSnapshot) }),
      )
      await page.route('**/api/events', (request) =>
        request.fulfill({ status: 200, contentType: 'text/event-stream', body: '' }),
      )
      await page.route('**/api/llm/providers', (request) =>
        request.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(providerSettingsSnapshot),
        }),
      )
      try {
        await page.goto(`${baseUrl}${scenario.route}`)
        await playwrightExpect(page.getByText(scenario.marker, { exact: true }).first()).toBeVisible()
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
        expect(overflow).toBeLessThanOrEqual(0)
        if (captureDirectory) {
          await page.screenshot({ path: join(captureDirectory, `${scenario.name}.png`), fullPage: true })
        }
      } finally {
        await page.close()
      }
    }
  }, 20_000)
})
