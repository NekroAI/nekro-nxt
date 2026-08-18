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
      displayName: '网页聊天',
      description: '网页聊天',
      userCreatable: false,
      configSchema: { schemaVersion: 1, type: 'object', required: [], properties: {} },
    },
    {
      key: 'qq-openclaw',
      displayName: 'QQ 开放平台',
      description: '连接 QQ 机器人账号',
      userCreatable: true,
      configSchema: { schemaVersion: 1, type: 'object', required: [], properties: {} },
    },
  ],
  models: [{ provider: 'openai', providerName: 'OpenAI', id: 'gpt-5', name: 'GPT-5' }],
  agents: [
    {
      id: browserAgentId,
      displayName: '资料员',
      persona: '严谨、简洁',
      currentRevisionId: browserRevisionId,
      createdAt: 1_725_000_000_000,
      runtimeStatus: 'idle',
      model: { provider: 'openai', model: 'gpt-5' },
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
      revisions: [{ id: browserExtensionRevisionId, revisionNumber: 3, createdAt: 1_725_000_000_000 }],
      activations: [
        {
          agentId: browserAgentId,
          extensionRevisionId: browserExtensionRevisionId,
          config: {},
          activatedAt: 1_725_000_000_000,
        },
      ],
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
    theme: 'system',
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
    const markup = renderRoute('/agents')
    const navigation = markup.slice(markup.indexOf('<nav'), markup.indexOf('</nav>'))
    expect(navigation.indexOf('智能体')).toBeLessThan(navigation.indexOf('消息'))
    expect(navigation.indexOf('消息')).toBeLessThan(navigation.indexOf('连接'))
    expect(navigation.indexOf('连接')).toBeLessThan(navigation.indexOf('扩展'))
    expect(navigation.indexOf('扩展')).toBeLessThan(navigation.indexOf('设置'))
    expect(navigation).not.toContain('Collection')
    expect(navigation).not.toContain('Workbench')
    expect(navigation).not.toContain('Conversation')
    expect(navigation).not.toContain('Configuration')
    expect(navigation).not.toContain('href="/creator"')
    expect(navigation).not.toContain('href="/runtime"')
  })

  it('renders the initial intelligent-agent loading state without demo identities or hard-coded health', () => {
    const markup = renderRoute('/agents')
    expect(markup).toContain('正在读取智能体')
    expect(markup).toContain('正在连接')
    expect(markup).not.toContain('小奈')
    expect(markup).not.toContain('Local Node')
    expect(markup).not.toContain('v0.1')
  })

  it('distinguishes loading across the priority product routes', () => {
    expect(renderRoute('/channels')).toContain('正在读取频道')
    expect(renderRoute('/connections')).toContain('正在读取连接')
    expect(renderRoute('/extensions')).toContain('正在读取扩展')
    expect(renderRoute('/settings')).toContain('正在读取模型供应商')
  })

  it('keeps direct creator and runtime routes honest when no snapshot data is available', () => {
    const creator = renderRoute('/creator')
    const runtime = renderRoute('/runtime')
    expect(creator).toContain('正在读取动态状态')
    expect(runtime).toContain('正在读取运行状态')
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
      connections: state.connections,
      extensions: state.extensions,
      approvals: state.approvals,
      dynamic: state.dynamic,
      diagnosticNote: 'projection-v1',
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
          connections: state.connections,
          extensions: state.extensions,
          approvals: state.approvals,
          dynamic: state.dynamic,
          diagnosticNote: state.diagnosticNote,
        }
      },
      subscribe: () => () => undefined,
      execute: (command) => (command === 'channels.sendMessage' ? Promise.reject(failure) : Promise.resolve(null)),
    })

    await expect(useProductStore.getState().sendMessage(browserChannelId, '保留这段草稿')).rejects.toBe(failure)
  })
})

describe.sequential('NekroNxt browser projections', () => {
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
      server: { host: '127.0.0.1', port: 0 },
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
    try {
      await page.goto(`${baseUrl}${route}`)
      await page.locator('#root').waitFor({ state: 'visible' })
      await verify(page)
      expect(runtimeErrors).toEqual([])
    } finally {
      await page.close()
    }
  }

  it('renders authoritative intelligent-agent and extension data without technical identifiers', async () => {
    await withProductPage('/agents', async (page) => {
      await playwrightExpect(page.getByText('资料员', { exact: true })).toBeVisible()
      await playwrightExpect(page.getByText('GPT-5', { exact: true })).toBeVisible()
      await playwrightExpect(page.locator('body')).not.toContainText(browserAgentId)
      await playwrightExpect(page.locator('body')).not.toContainText(browserRevisionId)
    })

    await withProductPage('/extensions', async (page) => {
      await playwrightExpect(page.getByRole('button', { name: /文档复核/u })).toBeVisible()
      await playwrightExpect(page.getByText('已启用', { exact: true }).first()).toBeVisible()
      await playwrightExpect(page.locator('body')).not.toContainText(browserExtensionRevisionId)
      await playwrightExpect(page.locator('body')).not.toContainText('Revision')
    })
  })

  it('renders platform accounts with product labels and masks the full account identifier', async () => {
    await withProductPage('/connections', async (page) => {
      await page.getByRole('button', { name: /QQ 机器人账号/u }).click()
      await playwrightExpect(page.getByText('尾号 7890', { exact: true })).toBeVisible()
      await playwrightExpect(page.locator('body')).toContainText('网页聊天')
      await playwrightExpect(page.locator('body')).not.toContainText('1234567890')
      await playwrightExpect(page.locator('body')).not.toContainText('websocket-resumed-internal-enum')
      await playwrightExpect(page.locator('body')).not.toContainText('adapterKey')
    })
  })

  it('isolates Channel messages, renders a true empty state, and names the send target', async () => {
    await withProductPage(`/channels/${browserChannelId}`, async (page) => {
      await playwrightExpect(page.getByText('只属于当前频道', { exact: true })).toBeVisible()
      await playwrightExpect(page.locator('body')).not.toContainText('不能混入当前频道')
      await playwrightExpect(page.getByText('发送给：资料员', { exact: true })).toBeVisible()
      await playwrightExpect(page.getByText('智能体当前空闲。', { exact: true })).toBeVisible()
      await playwrightExpect(page.locator('body')).not.toContainText('正在使用工具')
    })

    await withProductPage(`/channels/${emptyChannelId}`, async (page) => {
      await playwrightExpect(page.getByText('还没有消息', { exact: true })).toBeVisible()
      await playwrightExpect(page.getByText('发送给：资料员', { exact: true })).toBeVisible()
    })
  })

  it('shows real dynamic state without displaying package or approval identifiers', async () => {
    await withProductPage('/creator', async (page) => {
      await playwrightExpect(page.getByRole('button', { name: /资料员的临时扩展/u })).toBeVisible()
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
      owner: { packageName: '@deepseek-ai/dsh-web-search-deepseek', packageVersion: '0.1.0-rc.6' },
    }
    const mutations: unknown[] = []
    const credentialWrites: unknown[] = []
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
              packageVersion: '0.1.0-rc.6',
              dshVersion: '0.1.0-rc.6',
              origin: 'builtin',
              overall: 'verified',
              settingsNamespaces: ['web-search-deepseek'],
              facets: [
                { facet: 'host-load', status: 'supported', evidence: [] },
                { facet: 'settings', status: 'supported', evidence: [] },
                { facet: 'client-ui', status: 'supported', evidence: [] },
              ],
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

      await page.getByLabel('maxTokens').fill('2048')
      await page.getByRole('button', { name: '保存扩展配置' }).click()
      await playwrightExpect(page.getByText('配置已在其他位置更新；草稿仍保留，请核对后重新保存。')).toBeVisible()
      await playwrightExpect(page.getByLabel('maxTokens')).toHaveValue('2048')
      expect(runtimeErrors).toEqual([])
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
      await playwrightExpect(page.getByText(/尚未识别所属插件/)).toBeVisible()
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
      await page.goto(`${baseUrl}/agents`)
      await playwrightExpect(page.getByText('资料员', { exact: true })).toBeVisible()
      await playwrightExpect(page.getByText('连接不稳定', { exact: true }).first()).toBeVisible({ timeout: 8_000 })
      await playwrightExpect(
        page.getByText('连接不稳定，当前仍显示最近一次同步的数据。', { exact: true }),
      ).toBeVisible()
      await playwrightExpect(page.getByText('资料员', { exact: true })).toBeVisible()
      expect(pageErrors).toEqual([])
    } finally {
      await page.close()
    }
  }, 12_000)

  it('keeps priority layouts within the desktop viewport at 1100, 1440, and 1920 pixels', async () => {
    const cases = [
      { width: 1100, height: 720, route: '/connections', name: 'connections-1100', marker: 'QQ 机器人账号' },
      {
        width: 1440,
        height: 900,
        route: `/channels/${browserChannelId}`,
        name: 'channel-1440',
        marker: '只属于当前频道',
      },
      { width: 1920, height: 1080, route: '/agents', name: 'agents-1920', marker: '资料员' },
      {
        width: 1440,
        height: 900,
        route: '/agents',
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
