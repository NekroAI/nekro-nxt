import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpProductHost, renderConversationBody } from '../src/http-host.ts'

/** Minimal EventSource stand-in: captures registered listeners and lets tests emit events. */
class FakeEventSource {
  static instances: FakeEventSource[] = []
  readonly listeners = new Map<string, Set<(event: unknown) => void>>()
  onerror: (() => void) | null = null

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(listener)
  }

  close(): void {
    FakeEventSource.instances = FakeEventSource.instances.filter((instance) => instance !== this)
  }

  emit(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data: JSON.stringify(data) })
  }

  fail(): void {
    this.onerror?.()
  }
}

const stubResponse = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: () => Promise.resolve(body),
})

const snapshotBody = () => ({
  connectionAdapters: [
    {
      key: 'web',
      displayName: '本地 Web',
      description: '系统托管',
      userCreatable: false,
      configSchema: { schemaVersion: 1, type: 'object', required: [], properties: {} },
    },
    {
      key: 'qq-openclaw',
      displayName: 'QQ 官方机器人',
      description: '连接 QQ 官方机器人账号',
      userCreatable: true,
      configSchema: {
        schemaVersion: 1,
        type: 'object',
        required: ['appId', 'clientSecretCredentialRef'],
        properties: {
          appId: { type: 'string', title: 'App ID' },
          clientSecretCredentialRef: { type: 'credential-reference', title: 'Client Secret' },
        },
      },
    },
  ],
  models: [
    {
      provider: 'test-provider',
      providerName: '测试供应商',
      id: 'chat-model',
      name: 'Chat Model',
    },
  ],
  agents: [
    {
      id: 'agent-1',
      displayName: '小奈',
      persona: '谨慎复核证据。',
      currentRevisionId: 'agent-revision-1',
      runtimeStatus: 'running',
      model: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' },
      capabilities: {
        subagents: false,
        fileTools: false,
        webSearch: false,
        dynamicCreation: true,
        developmentShell: false,
        unrestrictedFileAccess: false,
      },
      channels: ['channel-1'],
    },
  ],
  channels: [
    {
      id: 'channel-1',
      connectionId: 'connection-web',
      platformChannelId: 'web-agent-1',
      kind: 'web',
      displayName: '小奈的网页频道',
      boundAgentId: 'agent-1',
      bindings: [{ id: 'binding-1', agentId: 'agent-1', triggerPolicy: 'always', revision: 1 }],
    },
  ],
  messages: [
    {
      id: 'event-1',
      channelId: 'channel-1',
      role: 'member',
      parts: [{ type: 'text', text: '你好' }],
      occurredAt: 1_700_000_000_000,
    },
    {
      id: 'intent-1',
      channelId: 'channel-1',
      role: 'agent',
      parts: [{ type: 'text', text: '这是通信工具确认发送的回复。' }],
      occurredAt: 1_700_000_001_000,
      deliveryState: 'sent',
    },
  ],
  connections: [{ id: 'connection-web', adapterKey: 'web', status: 'active' }],
  extensions: [],
  dynamic: [],
})

const snapshotBodyWithExtension = () => ({
  ...snapshotBody(),
  extensions: [
    {
      id: 'extension-1',
      slug: 'channel-summary',
      displayName: '频道摘要',
      description: '生成结构化阶段摘要。',
      revisionNumber: 1,
      revisionId: 'revision-1',
      activation: 'active',
      agentId: 'agent-1',
    },
  ],
})

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('HttpProductHost', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  afterEach(() => {
    vi.unstubAllGlobals()
    FakeEventSource.instances = []
  })

  it('projects the authoritative Server snapshot onto the Shell product shape', async () => {
    fetchMock = vi.fn((input: string) => {
      if (input === '/api/snapshot') return Promise.resolve(stubResponse(200, snapshotBody()))
      return Promise.resolve(stubResponse(404, { error: { code: 'not-found', message: 'x' } }))
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('EventSource', FakeEventSource)

    const host = new HttpProductHost()
    expect(host.getSnapshot().host).toEqual({ status: 'initializing', error: null, lastSuccessfulAt: null })
    const listener = vi.fn()
    const unsubscribe = host.subscribe(listener)
    await flush()

    const snapshot = host.getSnapshot()
    expect(snapshot.host).toMatchObject({ status: 'ready', error: null })
    expect(snapshot.host.lastSuccessfulAt).toBeTypeOf('number')
    expect(snapshot.diagnosticNote).toContain('服务连接正常')
    expect(snapshot.diagnosticNote).not.toContain('Server')
    expect(snapshot.agents).toHaveLength(1)
    expect(snapshot.agents[0]).toMatchObject({
      id: 'agent-1',
      name: '小奈',
      model: '未命名模型',
      modelRef: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' },
      persona: '谨慎复核证据。',
      currentRevisionId: 'agent-revision-1',
      state: '思考中',
      capabilities: {
        subagents: false,
        fileTools: false,
        webSearch: false,
        dynamicCreation: true,
        developmentShell: false,
        unrestrictedFileAccess: false,
      },
      channels: ['channel-1'],
    })
    expect(snapshot.channels[0]).toMatchObject({
      id: 'channel-1',
      name: '小奈的网页频道',
      kind: 'web',
      connectionName: '网页聊天',
      agentId: 'agent-1',
      trigger: '始终响应',
    })
    expect(snapshot.messages).toHaveLength(2)
    expect(snapshot.messages[0]).toMatchObject({ role: 'member', author: '你', body: '你好' })
    expect(snapshot.messages[1]).toMatchObject({
      role: 'agent',
      author: '小奈',
      body: '这是通信工具确认发送的回复。',
      delivery: '已发送',
    })
    expect(snapshot.connections[0]).toMatchObject({
      id: 'connection-web',
      adapter: '网页聊天',
      adapterKey: 'web',
      state: '已连接',
    })
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('shows external group senders and Mention names without leaking member IDs or QQ markup', async () => {
    const base = snapshotBody()
    const body = {
      ...base,
      channels: [
        {
          ...base.channels[0]!,
          connectionId: 'connection-qq',
          platformChannelId: 'group:opaque-platform-id',
          kind: 'group',
          displayName: '研发群',
        },
      ],
      messages: [
        {
          id: 'event-group-1',
          channelId: 'channel-1',
          role: 'member',
          sender: { memberId: 'mbr_sender-internal', displayName: '成员甲' },
          mentionedConnectionAccount: true,
          parts: [
            { type: 'text', text: '<faceType=6,faceId="0",ext="encoded"> 请看' },
            { type: 'mention', memberId: 'mbr_target-internal', displayName: '成员乙' },
          ],
          occurredAt: 1_700_000_000_000,
        },
      ],
      connections: [{ id: 'connection-qq', adapterKey: 'qq-openclaw', status: 'active' }],
    }
    fetchMock = vi.fn((input: string) =>
      Promise.resolve(
        input === '/api/snapshot'
          ? stubResponse(200, body)
          : stubResponse(404, { error: { code: 'not-found', message: 'x' } }),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('EventSource', FakeEventSource)

    const host = new HttpProductHost()
    const unsubscribe = host.subscribe(() => {})
    await flush()

    expect(host.getSnapshot().messages[0]).toMatchObject({
      author: '成员甲',
      body: '@机器人账号 [QQ 表情] 请看 @成员乙',
    })
    expect(host.getSnapshot().messages[0]?.body).not.toContain('mbr_')
    expect(host.getSnapshot().messages[0]?.body).not.toContain('faceType')
    unsubscribe()
  })

  it('renders a safe fallback for unresolved Mention labels', () => {
    expect(renderConversationBody([{ type: 'mention', memberId: 'mbr_internal' }])).toBe('@群成员')
  })

  it('loads one Channel history page on demand and projects controlled media URLs', async () => {
    fetchMock = vi.fn((input: string, init?: RequestInit) => {
      if (input === '/api/snapshot') return Promise.resolve(stubResponse(200, { ...snapshotBody(), messages: [] }))
      if (input === '/api/channels/channel-1/messages?limit=40' && init?.method === 'GET') {
        return Promise.resolve(
          stubResponse(200, {
            hasMore: true,
            messages: [
              {
                id: 'event-media',
                channelId: 'channel-1',
                role: 'member',
                parts: [
                  { type: 'text', text: '附件如下' },
                  { type: 'image', assetId: 'asset-image', alt: '现场照片' },
                  { type: 'file', assetId: 'asset-file', name: '说明.pdf' },
                ],
                occurredAt: 1_700_000_000_000,
              },
            ],
          }),
        )
      }
      return Promise.resolve(stubResponse(404, { error: { code: 'not-found', message: 'x' } }))
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('EventSource', FakeEventSource)
    const host = new HttpProductHost()
    const unsubscribe = host.subscribe(() => undefined)
    await flush()

    const page = await host.execute('channels.listMessages', { channelId: 'channel-1', mode: 'initial', limit: 40 })
    expect(page).toMatchObject({ hasMore: true })
    expect(host.getSnapshot().messages[0]).toMatchObject({
      body: '附件如下',
      resources: [
        {
          kind: 'image',
          name: '现场照片',
          url: '/api/channels/channel-1/assets/asset-image',
        },
        {
          kind: 'file',
          name: '说明.pdf',
          url: '/api/channels/channel-1/assets/asset-file',
        },
      ],
    })
    unsubscribe()
  })

  it('routes a local Channel display name without changing the platform identity', async () => {
    fetchMock = vi.fn((input: string, init?: RequestInit) => {
      if (input === '/api/channels/channel-1/display-name' && init?.method === 'POST') {
        return Promise.resolve(stubResponse(200, { channelId: 'channel-1', displayName: '研发讨论群' }))
      }
      if (input === '/api/snapshot') return Promise.resolve(stubResponse(200, snapshotBody()))
      return Promise.resolve(stubResponse(404, { error: { code: 'not-found', message: 'x' } }))
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('EventSource', FakeEventSource)
    const host = new HttpProductHost()
    const unsubscribe = host.subscribe(() => undefined)
    await flush()
    await host.execute('channels.rename', { channelId: 'channel-1', displayName: '研发讨论群' })
    const call = fetchMock.mock.calls.find(([input]) => input === '/api/channels/channel-1/display-name')
    const request = call?.[1] as RequestInit | undefined
    expect(JSON.parse(request?.body as string)).toEqual({ displayName: '研发讨论群' })
    unsubscribe()
  })

  it('routes agents.create to POST /api/agents with the domain request body', async () => {
    fetchMock = vi.fn((input: string, init?: RequestInit) => {
      if (input === '/api/agents' && init?.method === 'POST') {
        return Promise.resolve(stubResponse(201, { agentId: 'agent-2', channelId: 'channel-2', connectionId: 'conn' }))
      }
      if (input === '/api/snapshot') return Promise.resolve(stubResponse(200, snapshotBody()))
      return Promise.resolve(stubResponse(404, { error: { code: 'not-found', message: 'x' } }))
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('EventSource', FakeEventSource)

    const host = new HttpProductHost()
    const unsubscribe = host.subscribe(() => undefined)
    await flush()

    const result = await host.execute('agents.create', {
      displayName: '资料员',
      model: { provider: 'test-provider', model: 'chat-model' },
    })
    expect(result).toEqual({ agentId: 'agent-2', channelId: 'channel-2', connectionId: 'conn' })

    const createCall = fetchMock.mock.calls.find(([input]) => input === '/api/agents')
    expect(createCall).toBeDefined()
    const createInit = createCall?.[1] as RequestInit | undefined
    expect(createInit?.method).toBe('POST')
    const rawBody = createInit?.body
    expect(rawBody).toBeTypeOf('string')
    expect(JSON.parse(rawBody as string)).toEqual({
      displayName: '资料员',
      persona: '',
      model: { provider: 'test-provider', model: 'chat-model' },
      capabilities: {
        subagents: false,
        fileTools: false,
        webSearch: false,
        dynamicCreation: false,
        developmentShell: false,
        unrestrictedFileAccess: false,
      },
    })
    unsubscribe()
  })

  it('routes agents.revise with the current immutable revision id and exact DSH model selection', async () => {
    fetchMock = vi.fn((input: string, init?: RequestInit) => {
      if (input === '/api/agents/agent-1/revision' && init?.method === 'POST') {
        return Promise.resolve(stubResponse(200, { currentRevisionId: 'agent-revision-2' }))
      }
      if (input === '/api/snapshot') return Promise.resolve(stubResponse(200, snapshotBody()))
      return Promise.resolve(stubResponse(404, { error: { code: 'not-found', message: 'x' } }))
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('EventSource', FakeEventSource)

    const host = new HttpProductHost()
    const unsubscribe = host.subscribe(() => undefined)
    await flush()
    await host.execute('agents.revise', {
      agentId: 'agent-1',
      expectedCurrentRevisionId: 'agent-revision-1',
      displayName: '新小奈',
      persona: '新人设',
      model: { provider: 'test-provider', model: 'chat-model' },
    })

    const call = fetchMock.mock.calls.find(([input]) => input === '/api/agents/agent-1/revision')
    expect(call).toBeDefined()
    expect(JSON.parse((call?.[1] as RequestInit).body as string)).toEqual({
      expectedCurrentRevisionId: 'agent-revision-1',
      displayName: '新小奈',
      persona: '新人设',
      model: { provider: 'test-provider', model: 'chat-model' },
    })
    unsubscribe()
  })

  it('routes extension activate/deactivate to the activation endpoints', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    fetchMock = vi.fn((input: string, init?: RequestInit) => {
      requests.push({ url: input, ...(init === undefined ? {} : { init }) })
      if (input === '/api/snapshot') return Promise.resolve(stubResponse(200, snapshotBody()))
      if (input.startsWith('/api/extensions/') && init?.method === 'POST') {
        return Promise.resolve(stubResponse(200, { activation: { id: 'act-1', state: 'active' } }))
      }
      if (input.startsWith('/api/extensions/') && init?.method === 'DELETE') {
        return Promise.resolve(stubResponse(200, { disabled: true }))
      }
      return Promise.resolve(stubResponse(404, { error: { code: 'not-found', message: 'x' } }))
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('EventSource', FakeEventSource)

    const host = new HttpProductHost()
    const unsubscribe = host.subscribe(() => undefined)
    await flush()

    await host.execute('extensions.activate', {
      extensionId: 'extension-1',
      agentId: 'agent-1',
      revisionId: 'revision-1',
    })
    const activateCall = requests.find(
      (request) => request.url === '/api/extensions/extension-1/activation' && request.init?.method === 'POST',
    )
    expect(activateCall?.init?.method).toBe('POST')
    expect(JSON.parse(activateCall?.init?.body as string)).toEqual({
      agentId: 'agent-1',
      revisionId: 'revision-1',
    })

    await host.execute('extensions.deactivate', { extensionId: 'extension-1' })
    const deactivateCall = requests.find(
      (request) => request.url === '/api/extensions/extension-1/activation' && request.init?.method === 'DELETE',
    )
    expect(deactivateCall?.init?.method).toBe('DELETE')
    unsubscribe()
  })

  it('routes connections.create to POST /api/connections with a one-time Secret submission', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    fetchMock = vi.fn((input: string, init?: RequestInit) => {
      requests.push({ url: input, ...(init === undefined ? {} : { init }) })
      if (input === '/api/snapshot') return Promise.resolve(stubResponse(200, snapshotBody()))
      if (input === '/api/connections' && init?.method === 'POST') {
        return Promise.resolve(stubResponse(201, { connectionId: 'connection-qq', status: 'configured' }))
      }
      return Promise.resolve(stubResponse(404, { error: { code: 'not-found', message: 'x' } }))
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('EventSource', FakeEventSource)

    const host = new HttpProductHost()
    const unsubscribe = host.subscribe(() => undefined)
    await flush()

    await host.execute('connections.create', {
      adapterKey: 'qq-openclaw',
      configuration: { appId: 'app-1', proactiveSend: true },
      credentials: { clientSecretCredentialRef: 'secret-qq-1' },
    })
    const createCall = requests.find((request) => request.url === '/api/connections' && request.init?.method === 'POST')
    expect(createCall?.init?.method).toBe('POST')
    expect(JSON.parse(createCall?.init?.body as string)).toEqual({
      adapterKey: 'qq-openclaw',
      configuration: { appId: 'app-1', proactiveSend: true },
      credentials: { clientSecretCredentialRef: 'secret-qq-1' },
    })
    unsubscribe()
  })

  it('creates a channel Binding through the generic product Host command', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    fetchMock = vi.fn((input: string, init?: RequestInit) => {
      requests.push({ url: input, ...(init === undefined ? {} : { init }) })
      if (input === '/api/bindings' && init?.method === 'POST') {
        return Promise.resolve(stubResponse(201, { id: 'binding-2' }))
      }
      return Promise.resolve(stubResponse(200, snapshotBody()))
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('EventSource', FakeEventSource)

    const host = new HttpProductHost()
    await host.execute('bindings.create', {
      agentId: 'agent-1',
      channelId: 'channel-2',
      triggerPolicy: 'mentioned-or-replied',
    })
    const request = requests.find((candidate) => candidate.url === '/api/bindings')
    expect(JSON.parse(request?.init?.body as string)).toEqual({
      agentId: 'agent-1',
      channelId: 'channel-2',
      triggerPolicy: 'mentioned-or-replied',
    })
  })

  it('routes agents.updateCapabilities to the capabilities endpoint', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    fetchMock = vi.fn((input: string, init?: RequestInit) => {
      requests.push({ url: input, ...(init === undefined ? {} : { init }) })
      if (input === '/api/snapshot') return Promise.resolve(stubResponse(200, snapshotBody()))
      if (input === '/api/agents/agent-1/capabilities' && init?.method === 'POST') {
        return Promise.resolve(
          stubResponse(200, { currentRevisionId: 'revision-2', capabilities: { dynamicCreation: true } }),
        )
      }
      return Promise.resolve(stubResponse(404, { error: { code: 'not-found', message: 'x' } }))
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('EventSource', FakeEventSource)

    const host = new HttpProductHost()
    const unsubscribe = host.subscribe(() => undefined)
    await flush()

    await host.execute('agents.updateCapabilities', { agentId: 'agent-1', dynamicCreation: true })
    const capCall = requests.find(
      (request) => request.url === '/api/agents/agent-1/capabilities' && request.init?.method === 'POST',
    )
    expect(capCall?.init?.method).toBe('POST')
    expect(JSON.parse(capCall?.init?.body as string)).toEqual({ dynamicCreation: true })
    unsubscribe()
  })

  it('routes connections.test to the diagnostic endpoint', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    fetchMock = vi.fn((input: string, init?: RequestInit) => {
      requests.push({ url: input, ...(init === undefined ? {} : { init }) })
      if (input === '/api/snapshot') return Promise.resolve(stubResponse(200, snapshotBody()))
      if (input === '/api/connections/connection-qq/test' && init?.method === 'POST') {
        return Promise.resolve(stubResponse(200, { status: 'sent', platformMessageId: 'qq-message-1' }))
      }
      return Promise.resolve(stubResponse(404, { error: { code: 'not-found', message: 'x' } }))
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('EventSource', FakeEventSource)

    const host = new HttpProductHost()
    const unsubscribe = host.subscribe(() => undefined)
    await flush()

    const result = await host.execute('connections.test', {
      connectionId: 'connection-qq',
      direction: 'send',
      channelId: 'channel-qq',
    })
    expect(result).toMatchObject({ status: 'sent', platformMessageId: 'qq-message-1' })
    const testCall = requests.find(
      (request) => request.url === '/api/connections/connection-qq/test' && request.init?.method === 'POST',
    )
    expect(testCall?.init?.method).toBe('POST')
    expect(JSON.parse(testCall?.init?.body as string)).toEqual({ direction: 'send', channelId: 'channel-qq' })
    unsubscribe()
  })

  it('routes dynamic.approve to the Agent approval endpoint', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    fetchMock = vi.fn((input: string, init?: RequestInit) => {
      requests.push({ url: input, ...(init === undefined ? {} : { init }) })
      if (input === '/api/snapshot') return Promise.resolve(stubResponse(200, snapshotBody()))
      if (input === '/api/dynamic/agent-1/approve' && init?.method === 'POST') {
        return Promise.resolve(stubResponse(200, { accepted: true }))
      }
      return Promise.resolve(stubResponse(404, { error: { code: 'not-found', message: 'x' } }))
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('EventSource', FakeEventSource)

    const host = new HttpProductHost()
    const unsubscribe = host.subscribe(() => undefined)
    await flush()

    const result = await host.execute('dynamic.approve', {
      agentId: 'agent-1',
      requestId: 'approval-1',
      pluginRunId: 'run-1',
    })
    expect(result).toEqual({ accepted: true })
    const approveCall = requests.find(
      (request) => request.url === '/api/dynamic/agent-1/approve' && request.init?.method === 'POST',
    )
    expect(approveCall?.init?.method).toBe('POST')
    expect(JSON.parse(approveCall?.init?.body as string)).toEqual({ requestId: 'approval-1', pluginRunId: 'run-1' })
    unsubscribe()
  })

  it('routes extensions.saveFromDynamic to the save endpoint', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    fetchMock = vi.fn((input: string, init?: RequestInit) => {
      requests.push({ url: input, ...(init === undefined ? {} : { init }) })
      if (input === '/api/snapshot') return Promise.resolve(stubResponse(200, snapshotBody()))
      if (input === '/api/extensions/save-from-dynamic' && init?.method === 'POST') {
        return Promise.resolve(
          stubResponse(200, { extensionId: 'extension-saved', revisionId: 'revision-saved', activation: 'inactive' }),
        )
      }
      return Promise.resolve(stubResponse(404, { error: { code: 'not-found', message: 'x' } }))
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('EventSource', FakeEventSource)

    const host = new HttpProductHost()
    const unsubscribe = host.subscribe(() => undefined)
    await flush()

    const result = await host.execute('extensions.saveFromDynamic', {
      agentId: 'agent-1',
      name: '保存探针',
      slug: 'saved-probe',
    })
    expect(result).toEqual({ extensionId: 'extension-saved', revisionId: 'revision-saved', activation: 'inactive' })
    const saveCall = requests.find(
      (request) => request.url === '/api/extensions/save-from-dynamic' && request.init?.method === 'POST',
    )
    expect(saveCall?.init?.method).toBe('POST')
    const body = JSON.parse(saveCall?.init?.body as string) as { agentId: string; slug: string; displayName: string }
    expect(body.agentId).toBe('agent-1')
    expect(body.slug).toBe('saved-probe')
    expect(body.displayName).toBe('保存探针')
    unsubscribe()
  })

  it('refreshes the projection when a channel-fact SSE event arrives', async () => {
    let snapshotCalls = 0
    fetchMock = vi.fn((input: string) => {
      if (input === '/api/snapshot') {
        snapshotCalls += 1
        // 第二次快照（SSE 事件后刷新）携带新的 agent 回复。
        if (snapshotCalls >= 2) {
          return Promise.resolve(
            stubResponse(200, {
              ...snapshotBody(),
              messages: [
                ...snapshotBody().messages,
                {
                  id: 'intent-2',
                  channelId: 'channel-1',
                  role: 'agent',
                  parts: [{ type: 'text', text: '第二条回复。' }],
                  occurredAt: 1_700_000_002_000,
                  deliveryState: 'sent',
                },
              ],
            }),
          )
        }
        return Promise.resolve(stubResponse(200, snapshotBody()))
      }
      return Promise.resolve(stubResponse(404, { error: { code: 'not-found', message: 'x' } }))
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('EventSource', FakeEventSource)

    const host = new HttpProductHost()
    const listener = vi.fn()
    const unsubscribe = host.subscribe(listener)
    await flush()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(host.getSnapshot().messages).toHaveLength(2)

    const source = FakeEventSource.instances[0]
    expect(source).toBeDefined()
    source?.emit('channel-fact', {
      channelId: 'channel-1',
      message: {
        id: 'intent-2',
        channelId: 'channel-1',
        role: 'agent',
        parts: [{ type: 'text', text: '第二条回复。' }],
        occurredAt: 1_700_000_002_000,
        deliveryState: 'sent',
      },
    })
    await flush()

    expect(listener).toHaveBeenCalledTimes(2)
    expect(host.getSnapshot().messages).toHaveLength(3)
    expect(host.getSnapshot().messages.at(-1)).toMatchObject({ role: 'agent', body: '第二条回复。' })
    unsubscribe()
  })

  it('refreshes the projection when an extensions-changed SSE event arrives after Activation', async () => {
    let withExtension = false
    fetchMock = vi.fn((input: string) => {
      if (input === '/api/snapshot') {
        return Promise.resolve(stubResponse(200, withExtension ? snapshotBodyWithExtension() : snapshotBody()))
      }
      return Promise.resolve(stubResponse(404, { error: { code: 'not-found', message: 'x' } }))
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('EventSource', FakeEventSource)

    const host = new HttpProductHost()
    const listener = vi.fn()
    const unsubscribe = host.subscribe(listener)
    await flush()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(host.getSnapshot().extensions).toHaveLength(0)

    // The Server broadcasts extensions-changed after an Activation change.
    withExtension = true
    const source = FakeEventSource.instances[0]
    source?.emit('extensions-changed', { changed: true })
    await flush()

    expect(listener).toHaveBeenCalledTimes(2)
    const extension = host.getSnapshot().extensions[0]
    expect(extension).toMatchObject({
      name: '频道摘要',
      revision: 1,
      activation: '已激活',
      targetAgent: '小奈',
    })
    unsubscribe()
  })

  it('publishes an explicit error when the initial load fails and rejects mutations', async () => {
    fetchMock = vi.fn((input: string) => Promise.reject(new Error(`network down: ${input}`)))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('EventSource', FakeEventSource)

    const host = new HttpProductHost()
    const listener = vi.fn()
    const unsubscribe = host.subscribe(listener)
    await flush()

    expect(listener).toHaveBeenCalledTimes(1)
    expect(host.getSnapshot().host).toEqual({
      status: 'error',
      error: { code: 'network', message: 'network down: /api/snapshot' },
      lastSuccessfulAt: null,
    })
    expect(host.getSnapshot().agents).toEqual([])
    await expect(
      host.execute('agents.create', {
        displayName: 'x',
        model: { provider: 'test-provider', model: 'chat-model' },
      }),
    ).rejects.toThrow('network down: /api/agents')
    expect(host.getSnapshot().host).toMatchObject({
      status: 'error',
      error: { code: 'network', message: 'network down: /api/agents' },
    })
    unsubscribe()
  })

  it('keeps the last good data as stale on non-2xx and returns to ready after recovery', async () => {
    let snapshotMode: 'ready' | 'failed' = 'ready'
    fetchMock = vi.fn((input: string) => {
      if (input !== '/api/snapshot') return Promise.resolve(stubResponse(404, null))
      return Promise.resolve(
        snapshotMode === 'ready'
          ? stubResponse(200, snapshotBody())
          : stubResponse(503, { error: { code: 'unavailable', message: 'Server 正在升级。' } }),
      )
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('EventSource', FakeEventSource)

    const host = new HttpProductHost()
    const listener = vi.fn()
    const unsubscribe = host.subscribe(listener)
    await flush()
    const firstSuccessfulAt = host.getSnapshot().host.lastSuccessfulAt
    expect(host.getSnapshot().agents).toHaveLength(1)

    snapshotMode = 'failed'
    await expect(host.execute('host.refresh')).rejects.toThrow('Server 正在升级。')
    expect(host.getSnapshot().host).toEqual({
      status: 'stale',
      error: { code: 'http', message: 'Server 正在升级。' },
      lastSuccessfulAt: firstSuccessfulAt,
    })
    expect(host.getSnapshot().agents).toHaveLength(1)

    snapshotMode = 'ready'
    FakeEventSource.instances[0]?.emit('status', { connected: true })
    await flush()
    expect(host.getSnapshot().host).toMatchObject({ status: 'ready', error: null })
    expect(host.getSnapshot().agents).toHaveLength(1)
    expect(listener).toHaveBeenCalledTimes(3)
    unsubscribe()
  })

  it('publishes invalid snapshots and SSE failures without discarding good data', async () => {
    let validSnapshot = true
    fetchMock = vi.fn((input: string) =>
      Promise.resolve(
        input === '/api/snapshot'
          ? stubResponse(200, validSnapshot ? snapshotBody() : { agents: 'not-an-array' })
          : stubResponse(404, null),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('EventSource', FakeEventSource)

    const host = new HttpProductHost()
    const listener = vi.fn()
    const unsubscribe = host.subscribe(listener)
    await flush()

    validSnapshot = false
    await expect(host.execute('host.refresh')).rejects.toThrow('数据格式无效')
    expect(host.getSnapshot().host).toMatchObject({
      status: 'stale',
      error: { code: 'invalid-snapshot' },
    })
    expect(host.getSnapshot().agents[0]?.name).toBe('小奈')

    FakeEventSource.instances[0]?.fail()
    expect(host.getSnapshot().host).toMatchObject({ status: 'stale', error: { code: 'sse' } })
    expect(host.getSnapshot().agents[0]?.name).toBe('小奈')
    expect(listener).toHaveBeenCalledTimes(3)
    unsubscribe()
  })

  it('rejects invalid input for supported and unknown commands instead of returning null', async () => {
    vi.stubGlobal('fetch', vi.fn())
    vi.stubGlobal('EventSource', FakeEventSource)
    const host = new HttpProductHost()

    await expect(host.execute('channels.sendMessage', { channelId: '', body: 'hello' })).rejects.toThrow('缺少目标频道')
    await expect(host.execute('agents.updateCapabilities', { agentId: 'agent-1' })).rejects.toThrow('至少一项')
    await expect(host.execute('extensions.activate', { extensionId: 'extension-1' })).rejects.toThrow('缺少目标智能体')
    await expect(host.execute('unknown.command')).rejects.toThrow('不支持操作')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('uses safe display placeholders instead of raw identifiers', async () => {
    const raw = snapshotBody()
    fetchMock = vi.fn(() =>
      Promise.resolve(
        stubResponse(200, {
          ...raw,
          connectionAdapters: [],
          agents: raw.agents.map((agent) => ({ ...agent, displayName: '' })),
          channels: [
            {
              ...raw.channels[0],
              connectionId: 'secret-connection-id',
              platformChannelId: 'qq-group-9876',
              kind: 'group',
              displayName: '',
            },
          ],
          connections: [{ id: 'secret-connection-id', adapterKey: 'private-adapter-key', status: 'active' }],
          extensions: [],
        }),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('EventSource', FakeEventSource)

    const host = new HttpProductHost()
    const unsubscribe = host.subscribe(() => undefined)
    await flush()
    const snapshot = host.getSnapshot()
    expect(snapshot.agents[0]?.name).toBe('未命名智能体')
    expect(snapshot.agents[0]?.model).toBe('未命名模型')
    expect(snapshot.messages.find((message) => message.role === 'agent')?.author).toBe('未命名智能体')
    expect(snapshot.channels[0]).toMatchObject({
      name: 'QQ 群聊（尾号 9876）',
      connectionName: '未命名连接',
    })
    expect(snapshot.connections[0]).toMatchObject({
      name: '未命名连接平台',
      adapter: '未命名连接平台',
      adapterKey: 'private-adapter-key',
    })
    expect(snapshot.channels[0]?.name).not.toContain('secret-connection-id')
    expect(snapshot.channels[0]?.connectionName).not.toContain('secret-connection-id')
    unsubscribe()
  })

  it('accepts QQ direct channels and projects them as private conversations', async () => {
    const raw = snapshotBody()
    fetchMock = vi.fn(() =>
      Promise.resolve(
        stubResponse(200, {
          ...raw,
          channels: [
            {
              ...raw.channels[0],
              connectionId: 'connection-qq',
              platformChannelId: 'c2c:private-4321',
              kind: 'direct',
              displayName: '',
            },
          ],
          connections: [
            {
              id: 'connection-qq',
              adapterKey: 'qq-openclaw',
              status: 'active',
              knownChannels: [{ id: 'channel-1', name: 'c2c:private-4321', kind: 'direct' }],
            },
          ],
        }),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('EventSource', FakeEventSource)

    const host = new HttpProductHost()
    const unsubscribe = host.subscribe(() => undefined)
    await flush()

    expect(host.getSnapshot().channels[0]).toMatchObject({ kind: 'qq-direct', name: 'QQ 私聊（尾号 4321）' })
    expect(host.getSnapshot().connections[0]?.knownChannels[0]?.name).toBe('QQ 私聊（尾号 4321）')
    unsubscribe()
  })

  it('propagates the Server domain error message for a failed Connection action', async () => {
    fetchMock = vi.fn((input: string, init?: RequestInit) => {
      if (input === '/api/connections' && init?.method === 'POST') {
        return Promise.resolve(
          stubResponse(400, { error: { code: 'connection-failed', message: 'Client Secret 无法使用。' } }),
        )
      }
      return Promise.resolve(stubResponse(200, snapshotBody()))
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('EventSource', FakeEventSource)

    const host = new HttpProductHost()
    await expect(
      host.execute('connections.create', {
        adapterKey: 'qq-openclaw',
        configuration: { appId: 'app-1', proactiveSend: false },
        credentials: { clientSecretCredentialRef: 'bad-secret' },
      }),
    ).rejects.toThrow('Client Secret 无法使用。')
  })
})
