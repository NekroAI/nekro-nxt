import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, expect as playwrightExpect, type Browser, type Page } from '@playwright/test'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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

const browserSnapshot = {
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
      id: 'agent-very-long-technical-id',
      displayName: '资料员',
      persona: '严谨、简洁',
      currentRevisionId: 'revision-technical-id',
      model: { provider: 'openai', model: 'gpt-5' },
      capabilities: { dynamicCreation: true, developmentShell: false, fullFileAccess: false },
      channels: ['web-main', 'empty-channel'],
    },
  ],
  channels: [
    {
      id: 'web-main',
      connectionId: 'connection-web-internal-id',
      platformChannelId: 'web-main-platform-id',
      kind: 'web',
      displayName: '资料员对话',
      boundAgentId: 'agent-very-long-technical-id',
      bindings: [
        {
          id: 'binding-internal-id',
          agentId: 'agent-very-long-technical-id',
          triggerPolicy: 'always',
        },
      ],
    },
    {
      id: 'empty-channel',
      connectionId: 'connection-web-internal-id',
      platformChannelId: 'empty-platform-id',
      kind: 'web',
      displayName: '空频道',
      boundAgentId: 'agent-very-long-technical-id',
      bindings: [
        {
          id: 'binding-empty-id',
          agentId: 'agent-very-long-technical-id',
          triggerPolicy: 'always',
        },
      ],
    },
    {
      id: 'qq-channel-internal-id',
      connectionId: 'connection-qq-internal-id',
      platformChannelId: 'qq-platform-channel-1234',
      kind: 'group',
      displayName: '产品讨论群',
      boundAgentId: 'agent-very-long-technical-id',
      bindings: [
        {
          id: 'binding-qq-id',
          agentId: 'agent-very-long-technical-id',
          triggerPolicy: 'mentioned-or-replied',
        },
      ],
    },
  ],
  messages: [
    {
      id: 'message-current-id',
      channelId: 'web-main',
      role: 'member',
      parts: [{ type: 'text', text: '只属于当前频道' }],
      occurredAt: 1_725_000_000_000,
    },
    {
      id: 'message-other-id',
      channelId: 'qq-channel-internal-id',
      role: 'member',
      parts: [{ type: 'text', text: '不能混入当前频道' }],
      occurredAt: 1_725_000_001_000,
    },
  ],
  connections: [
    {
      id: 'connection-web-internal-id',
      adapterKey: 'web',
      status: 'active',
      credentialConfigured: true,
      channelCount: 2,
      knownChannels: [],
    },
    {
      id: 'connection-qq-internal-id',
      adapterKey: 'qq-openclaw',
      status: 'active',
      appId: '1234567890',
      credentialConfigured: true,
      proactiveSend: true,
      channelCount: 1,
      knownChannels: [{ id: 'qq-channel-internal-id', name: '产品讨论群', kind: 'group' }],
      gateway: { state: 'websocket-resumed-internal-enum' },
      receiveTest: { status: 'received' },
      sendTest: { status: 'not-run' },
    },
  ],
  extensions: [
    {
      id: 'extension-internal-id',
      slug: 'document-review',
      displayName: '文档复核',
      description: '检查文档中的遗漏',
      revisionNumber: 3,
      revisionId: 'extension-revision-internal-id',
      activation: 'active',
      agentId: 'agent-very-long-technical-id',
    },
  ],
  dynamic: [
    {
      agentId: 'agent-very-long-technical-id',
      pluginId: 'technical-plugin-id',
      packageId: 'technical-package-id',
      approvalRequestId: 'approval-internal-id',
      status: 'awaiting-approval',
    },
  ],
} as const

const providerSettingsSnapshot = {
  writable: true,
  protocols: ['openai-completions'],
  providers: [
    {
      provider: 'openai',
      displayName: 'OpenAI',
      settingsNs: 'llm-pi-ai',
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

  it('does not expose implementation provenance in model settings', () => {
    const markup = renderRoute('/settings')
    expect(markup).toContain('模型供应商')
    expect(markup).not.toContain('DSH')
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

    await expect(useProductStore.getState().sendMessage('web-main', '保留这段草稿')).rejects.toBe(failure)
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
    await page.route('**/api/snapshot', (request) =>
      request.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot) }),
    )
    await page.route('**/api/events', (request) =>
      request.fulfill({ status: 200, contentType: 'text/event-stream', body: '' }),
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
      await playwrightExpect(page.locator('body')).not.toContainText('agent-very-long-technical-id')
      await playwrightExpect(page.locator('body')).not.toContainText('revision-technical-id')
    })

    await withProductPage('/extensions', async (page) => {
      await playwrightExpect(page.getByText('文档复核', { exact: true })).toBeVisible()
      await playwrightExpect(page.getByText('已启用', { exact: true })).toBeVisible()
      await playwrightExpect(page.locator('body')).not.toContainText('extension-revision-internal-id')
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
    await withProductPage('/channels/web-main', async (page) => {
      await playwrightExpect(page.getByText('只属于当前频道', { exact: true })).toBeVisible()
      await playwrightExpect(page.locator('body')).not.toContainText('不能混入当前频道')
      await playwrightExpect(page.getByText('发送给：资料员', { exact: true })).toBeVisible()
      await playwrightExpect(page.getByText('智能体当前空闲。', { exact: true })).toBeVisible()
      await playwrightExpect(page.locator('body')).not.toContainText('正在使用工具')
    })

    await withProductPage('/channels/empty-channel', async (page) => {
      await playwrightExpect(page.getByText('还没有消息', { exact: true })).toBeVisible()
      await playwrightExpect(page.getByText('发送给：资料员', { exact: true })).toBeVisible()
    })
  })

  it('shows real dynamic state without displaying package or approval identifiers', async () => {
    await withProductPage('/creator', async (page) => {
      await playwrightExpect(page.getByText('等待确认', { exact: true })).toBeVisible()
      await playwrightExpect(page.getByText('资料员的临时扩展', { exact: true })).toBeVisible()
      await playwrightExpect(page.locator('body')).not.toContainText('technical-plugin-id')
      await playwrightExpect(page.locator('body')).not.toContainText('technical-package-id')
      await playwrightExpect(page.locator('body')).not.toContainText('approval-internal-id')
    })
  })

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
      { width: 1440, height: 900, route: '/channels/web-main', name: 'channel-1440', marker: '只属于当前频道' },
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
    const captureDirectory = process.env.NEKRO_VISUAL_CAPTURE
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
