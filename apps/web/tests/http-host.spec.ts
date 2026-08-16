import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpProductHost } from '../src/http-host.ts'

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
}

const stubResponse = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: () => Promise.resolve(body),
})

const snapshotBody = () => ({
  agents: [
    {
      id: 'agent-1',
      displayName: '小奈',
      model: { provider: 'deepseek', model: 'deepseek-chat' },
      capabilities: { dynamicCreation: true, developmentShell: false, fullFileAccess: false },
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
    const listener = vi.fn()
    const unsubscribe = host.subscribe(listener)
    await flush()

    const snapshot = host.getSnapshot()
    expect(snapshot.agents).toHaveLength(1)
    expect(snapshot.agents[0]).toMatchObject({
      id: 'agent-1',
      name: '小奈',
      model: 'deepseek-chat',
      capabilities: { dynamicCreation: true, developmentShell: false, fullFileAccess: false },
      channels: ['channel-1'],
    })
    expect(snapshot.channels[0]).toMatchObject({
      id: 'channel-1',
      name: '小奈的网页频道',
      kind: 'web',
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
    expect(snapshot.connections[0]).toMatchObject({ id: 'connection-web', adapter: 'web', state: '已连接' })
    expect(listener).toHaveBeenCalledTimes(1)
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

    const result = await host.execute('agents.create', { displayName: '资料员', modelLabel: 'deepseek-chat' })
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
      model: { provider: 'deepseek', model: 'deepseek-chat' },
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

  it('routes connections.create to POST /api/connections with a credential reference', async () => {
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

    await host.execute('connections.create', { appId: 'app-1', credentialRef: 'credential:qq-1' })
    const createCall = requests.find((request) => request.url === '/api/connections' && request.init?.method === 'POST')
    expect(createCall?.init?.method).toBe('POST')
    expect(JSON.parse(createCall?.init?.body as string)).toEqual({ appId: 'app-1', credentialRef: 'credential:qq-1' })
    unsubscribe()
  })

  it('routes connections.test to the diagnostic endpoint', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    fetchMock = vi.fn((input: string, init?: RequestInit) => {
      requests.push({ url: input, ...(init === undefined ? {} : { init }) })
      if (input === '/api/snapshot') return Promise.resolve(stubResponse(200, snapshotBody()))
      if (input === '/api/connections/connection-qq/test' && init?.method === 'POST') {
        return Promise.resolve(
          stubResponse(200, { status: 'needs-credentials', message: '已配置该连接；真实收发需平台 Client Secret。' }),
        )
      }
      return Promise.resolve(stubResponse(404, { error: { code: 'not-found', message: 'x' } }))
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('EventSource', FakeEventSource)

    const host = new HttpProductHost()
    const unsubscribe = host.subscribe(() => undefined)
    await flush()

    const result = await host.execute('connections.test', { connectionId: 'connection-qq', direction: 'send' })
    expect(result).toMatchObject({ status: 'needs-credentials' })
    const testCall = requests.find(
      (request) => request.url === '/api/connections/connection-qq/test' && request.init?.method === 'POST',
    )
    expect(testCall?.init?.method).toBe('POST')
    expect(JSON.parse(testCall?.init?.body as string)).toEqual({ direction: 'send' })
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

  it('degrades silently when the Server is unreachable and keeps the last snapshot', async () => {
    fetchMock = vi.fn((input: string) => Promise.reject(new Error(`network down: ${input}`)))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('EventSource', FakeEventSource)

    const host = new HttpProductHost()
    const listener = vi.fn()
    const unsubscribe = host.subscribe(listener)
    await flush()

    expect(listener).not.toHaveBeenCalled()
    expect(host.getSnapshot().agents).toEqual([])
    expect(await host.execute('agents.create', { displayName: 'x' })).toBeNull()
    unsubscribe()
  })
})
