import { afterEach, describe, expect, it, vi } from 'vitest'
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
import { HttpProductHost, renderConversationBody } from '../src/http-host.ts'
import { connectionDisplayName } from '../src/product-store.ts'

/** Minimal EventSource stand-in: captures registered listeners and lets tests emit events. */
class FakeEventSource {
  static instances: FakeEventSource[] = []
  readonly listeners = new Map<string, Set<(event: unknown) => void>>()
  readyState = 0

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(listener)
  }

  close(): void {
    this.readyState = 2
    FakeEventSource.instances = FakeEventSource.instances.filter((instance) => instance !== this)
  }

  open(): void {
    this.readyState = 1
    for (const listener of this.listeners.get('open') ?? []) listener(new Event('open'))
  }

  emit(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data: JSON.stringify(data) })
  }

  fail(): void {
    this.readyState = 2
    for (const listener of this.listeners.get('error') ?? []) listener(new Event('error'))
  }
}

const stubResponse = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: () => Promise.resolve(body),
})

const webAgentId = AgentIdSchema.parse('agt_webagent')
const createdAgentId = AgentIdSchema.parse('agt_createdagent')
const webAgentRevisionId = AgentRevisionIdSchema.parse('arev_webagent')
const nextAgentRevisionId = AgentRevisionIdSchema.parse('arev_nextagent')
const webChannelId = ChannelIdSchema.parse('chn_webchannel')
const createdChannelId = ChannelIdSchema.parse('chn_createdchannel')
const qqChannelId = ChannelIdSchema.parse('chn_qqchannel')
const webConnectionId = ConnectionIdSchema.parse('con_webconnection')
const qqConnectionId = ConnectionIdSchema.parse('con_qqconnection')
const secretConnectionId = ConnectionIdSchema.parse('con_secretconnection')
const summaryExtensionId = ExtensionIdSchema.parse('ext_channelsummary')
const savedExtensionId = ExtensionIdSchema.parse('ext_savedprobe')
const summaryRevisionId = ExtensionRevisionIdSchema.parse('xrv_channelsummary')
const savedRevisionId = ExtensionRevisionIdSchema.parse('xrv_savedprobe')
const webEpisodeId = EpisodeIdSchema.parse('eps_websession')
const senderMemberId = ChannelMemberIdSchema.parse('mbr_sender')
const targetMemberId = ChannelMemberIdSchema.parse('mbr_target')
const initialEventId = ChannelEventIdSchema.parse('evt_initial')
const replyIntentId = OutboundIntentIdSchema.parse('out_reply')
const groupEventId = ChannelEventIdSchema.parse('evt_group')
const mediaEventId = ChannelEventIdSchema.parse('evt_media')
const secondReplyIntentId = OutboundIntentIdSchema.parse('out_secondreply')
const imageAssetId = AssetIdSchema.parse('ast_image')
const fileAssetId = AssetIdSchema.parse('ast_file')

const snapshotBody = () =>
  HostApiContracts.snapshot.response.parse({
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
        description: '系统托管',
        userCreatable: false,
        aliasEditable: false,
        channelDiscovery: 'host-created',
        diagnostics: { receive: false, send: false },
        configSchema: { schemaVersion: 1, type: 'object', required: [], properties: {} },
      },
      {
        key: 'qq-openclaw',
        displayName: 'QQ 官方机器人',
        description: '连接 QQ 官方机器人账号',
        userCreatable: true,
        aliasEditable: true,
        channelDiscovery: 'adapter-observed',
        diagnostics: { receive: true, send: true },
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
    notificationSettings: {
      system: { enabled: true },
      bark: { enabled: false, serverUrl: 'https://api.day.app', deviceKeyConfigured: false },
      events: { 'dynamic-client-approval-requested': true },
    },
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
        id: webAgentId,
        displayName: '小奈',
        persona: '谨慎复核证据。',
        personaDocument: { version: 1, segments: [{ type: 'text', text: '谨慎复核证据。' }] },
        currentRevisionId: webAgentRevisionId,
        runtimeStatus: 'running',
        runtimePhase: 'thinking',
        createdAt: 1_700_000_000_000,
        model: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' },
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
        channels: [webChannelId],
      },
    ],
    channels: [
      {
        id: webChannelId,
        connectionId: webConnectionId,
        platformChannelId: 'web-agent-1',
        kind: 'web',
        displayName: '小奈的内置频道',
        boundAgentId: webAgentId,
        bindings: [
          { channelId: webChannelId, agentId: webAgentId, triggerPolicy: 'always', boundAt: 1_700_000_000_000 },
        ],
      },
    ],
    messages: [
      {
        id: initialEventId,
        channelId: webChannelId,
        role: 'member',
        parts: [{ type: 'text', text: '你好' }],
        occurredAt: 1_700_000_000_000,
      },
      {
        id: replyIntentId,
        channelId: webChannelId,
        role: 'agent',
        parts: [{ type: 'text', text: '这是通信工具确认发送的回复。' }],
        occurredAt: 1_700_000_001_000,
        deliveryState: 'sent',
      },
    ],
    connections: [
      {
        id: webConnectionId,
        adapterKey: 'web',
        appId: '',
        proactiveSend: false,
        credentialConfigured: true,
        channelCount: 1,
        knownChannels: [],
        gateway: { state: 'connected' },
      },
    ],
    extensions: [],
    dynamic: [],
  })

const snapshotBodyWithExtension = () => {
  const base = snapshotBody()
  const sourceAgent = base.agents[0]
  if (!sourceAgent) throw new Error('测试快照缺少基础智能体。')
  return HostApiContracts.snapshot.response.parse({
    ...base,
    agents: [
      ...base.agents,
      {
        ...sourceAgent,
        id: createdAgentId,
        displayName: '资料员',
        currentRevisionId: nextAgentRevisionId,
        createdAt: 1_700_000_000_100,
        runtimeStatus: 'idle',
        channels: [],
      },
    ],
    extensions: [
      {
        id: summaryExtensionId,
        scope: 'agent',
        slug: 'channel-summary',
        displayName: '频道摘要',
        description: '生成结构化阶段摘要。',
        createdByAgentId: webAgentId,
        revisions: [
          {
            id: summaryRevisionId,
            revisionNumber: 1,
            createdAt: 1_700_000_000_000,
            scope: 'agent',
            contributions: [],
          },
        ],
        activations: [
          { agentId: webAgentId, extensionRevisionId: summaryRevisionId, config: {}, activatedAt: 1_700_000_000_000 },
          {
            agentId: createdAgentId,
            extensionRevisionId: summaryRevisionId,
            config: {},
            activatedAt: 1_700_000_000_100,
          },
        ],
        clientDiagnostics: [],
      },
    ],
  })
}

const snapshotBodyWithDynamic = () =>
  HostApiContracts.snapshot.response.parse({
    ...snapshotBody(),
    dynamic: [
      {
        agentId: webAgentId,
        episodeId: webEpisodeId,
        pluginId: 'plugin-save',
        packageId: 'package-save',
        status: 'running',
        packages: [
          {
            packageId: 'package-save',
            name: '保存探针',
            purpose: '验证精确保存。',
            hasHostHalf: true,
            hasClientHalf: false,
          },
        ],
        policy: { turn: 1, consecutiveFailures: 0, repeatedFingerprintCount: 0 },
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
      id: webAgentId,
      name: '小奈',
      model: '未命名模型',
      modelRef: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' },
      persona: '谨慎复核证据。',
      currentRevisionId: webAgentRevisionId,
      state: '思考中',
      capabilities: {
        subagents: false,
        fileTools: false,
        webSearch: false,
        dynamicCreation: true,
        developmentShell: false,
        unrestrictedFileAccess: false,
      },
      channels: [webChannelId],
    })
    expect(snapshot.channels[0]).toMatchObject({
      id: webChannelId,
      name: '小奈的内置频道',
      kind: 'web',
      connectionName: '内置频道',
      agentId: webAgentId,
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
      id: webConnectionId,
      adapter: '内置频道',
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
          connectionId: qqConnectionId,
          platformChannelId: 'group:opaque-platform-id',
          kind: 'group',
          displayName: '研发群',
        },
      ],
      messages: [
        {
          id: groupEventId,
          channelId: webChannelId,
          role: 'member',
          sender: { memberId: senderMemberId, displayName: '成员甲' },
          mentionedConnectionAccount: true,
          parts: [
            { type: 'mention', memberId: ChannelMemberIdSchema.parse('mbr_bot'), displayName: '机器人账号' },
            { type: 'text', text: '<faceType=6,faceId="0",ext="encoded"> 请看' },
            { type: 'mention', memberId: targetMemberId, displayName: '成员乙' },
          ],
          occurredAt: 1_700_000_000_000,
        },
      ],
      connections: [
        {
          id: qqConnectionId,
          adapterKey: 'qq-openclaw',
          alias: '项目机器人',
          appId: '12345678',
          proactiveSend: false,
          credentialConfigured: true,
          channelCount: 1,
          knownChannels: [{ id: webChannelId, name: 'group:opaque-platform-id', kind: 'group' }],
          gateway: { state: 'connected' },
        },
      ],
    }
    const parsedBody = HostApiContracts.snapshot.response.parse(body)
    fetchMock = vi.fn((input: string) =>
      Promise.resolve(
        input === '/api/snapshot'
          ? stubResponse(200, parsedBody)
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
      body: '@机器人账号 [表情] 请看 @成员乙',
    })
    expect(host.getSnapshot().messages[0]?.body).not.toContain('mbr_')
    expect(host.getSnapshot().messages[0]?.body).not.toContain('faceType')
    expect(host.getSnapshot().channels[0]?.connectionName).toBe('项目机器人')
    expect(connectionDisplayName(host.getSnapshot().connections[0]!)).toBe('项目机器人')
    unsubscribe()
  })

  it('renders a safe fallback for unresolved Mention labels', () => {
    expect(renderConversationBody([{ type: 'mention', memberId: targetMemberId }])).toBe('@群成员')
    expect(renderConversationBody([{ type: 'rich', title: '示例分享', summary: '示例来源 · 示例分享' }])).toBe(
      '示例分享',
    )
  })

  it('loads one Channel history page on demand and projects controlled media URLs', async () => {
    fetchMock = vi.fn((input: string, init?: RequestInit) => {
      if (input === '/api/snapshot') return Promise.resolve(stubResponse(200, { ...snapshotBody(), messages: [] }))
      if (input === `/api/channels/${webChannelId}/messages?limit=24` && init?.method === 'GET') {
        return Promise.resolve(
          stubResponse(200, {
            hasMore: true,
            messages: [
              {
                id: mediaEventId,
                channelId: webChannelId,
                role: 'member',
                parts: [
                  { type: 'text', text: '附件如下' },
                  { type: 'image', assetId: imageAssetId, alt: '现场照片' },
                  { type: 'file', assetId: fileAssetId, name: '说明.pdf' },
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

    const page = await host.execute('channels.listMessages', { channelId: webChannelId, mode: 'initial', limit: 24 })
    expect(page).toMatchObject({ hasMore: true })
    expect(host.getSnapshot().messages[0]).toMatchObject({
      body: '附件如下',
      resources: [
        {
          kind: 'image',
          name: '现场照片',
          url: `/api/channels/${webChannelId}/assets/${imageAssetId}`,
        },
        {
          kind: 'file',
          name: '说明.pdf',
          url: `/api/channels/${webChannelId}/assets/${fileAssetId}`,
        },
      ],
    })
    unsubscribe()
  })

  it('merges channel facts that arrive while the initial history request is in flight', async () => {
    let releaseHistory: (() => void) | undefined
    const historyGate = new Promise<void>((resolve) => {
      releaseHistory = resolve
    })
    fetchMock = vi.fn((input: string, init?: RequestInit) => {
      if (input === '/api/snapshot') return Promise.resolve(stubResponse(200, { ...snapshotBody(), messages: [] }))
      if (input === `/api/channels/${webChannelId}/messages?limit=24` && init?.method === 'GET') {
        return historyGate.then(() =>
          stubResponse(200, {
            hasMore: false,
            messages: [
              {
                id: initialEventId,
                channelId: webChannelId,
                role: 'member',
                parts: [{ type: 'text', text: '请求开始前的消息。' }],
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

    const loading = host.execute('channels.listMessages', { channelId: webChannelId, mode: 'initial', limit: 24 })
    await flush()
    FakeEventSource.instances[0]?.emit('channel-fact', {
      channelId: webChannelId,
      revision: 1,
      items: [
        {
          kind: 'outbound',
          sourceId: secondReplyIntentId,
          message: {
            id: secondReplyIntentId,
            channelId: webChannelId,
            role: 'agent',
            parts: [{ type: 'text', text: '请求期间发送的回复。' }],
            occurredAt: 1_700_000_001_000,
            deliveryState: 'sent',
          },
        },
      ],
    })
    releaseHistory?.()
    await loading
    await flush()

    expect(host.getSnapshot().messages.map((message) => message.id)).toEqual([initialEventId, secondReplyIntentId])
    expect(host.getSnapshot().messages.at(-1)).toMatchObject({ body: '请求期间发送的回复。', delivery: '已发送' })
    unsubscribe()
  })

  it('routes a local Channel display name without changing the platform identity', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    fetchMock = vi.fn((input: string, init?: RequestInit) => {
      requests.push({ url: input, ...(init === undefined ? {} : { init }) })
      if (input === `/api/channels/${webChannelId}/display-name` && init?.method === 'POST') {
        return Promise.resolve(stubResponse(200, { channelId: webChannelId, displayName: '研发讨论群' }))
      }
      if (input === '/api/snapshot') return Promise.resolve(stubResponse(200, snapshotBody()))
      return Promise.resolve(stubResponse(404, { error: { code: 'not-found', message: 'x' } }))
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('EventSource', FakeEventSource)
    const host = new HttpProductHost()
    const unsubscribe = host.subscribe(() => undefined)
    await flush()
    await host.execute('channels.rename', { channelId: webChannelId, displayName: '研发讨论群' })
    const call = requests.find((request) => request.url === `/api/channels/${webChannelId}/display-name`)
    const body = call?.init?.body
    if (typeof body !== 'string') throw new TypeError('rename request body must be JSON text.')
    expect(HostApiContracts.renameChannel.request.parse(JSON.parse(body))).toEqual({ displayName: '研发讨论群' })
    unsubscribe()
  })

  it('routes agents.create to POST /api/agents with the domain request body', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    fetchMock = vi.fn((input: string, init?: RequestInit) => {
      requests.push({ url: input, ...(init === undefined ? {} : { init }) })
      if (input === '/api/agents' && init?.method === 'POST') {
        return Promise.resolve(
          stubResponse(201, { agentId: createdAgentId, channelId: createdChannelId, connectionId: webConnectionId }),
        )
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
    expect(result).toEqual({ agentId: createdAgentId, channelId: createdChannelId, connectionId: webConnectionId })

    const createCall = requests.find((request) => request.url === '/api/agents')
    expect(createCall).toBeDefined()
    if (createCall?.init?.method !== 'POST') throw new TypeError('create agent request must use POST.')
    const rawBody = createCall.init.body
    if (typeof rawBody !== 'string') throw new TypeError('create agent request body must be JSON text.')
    expect(HostApiContracts.createAgent.request.parse(JSON.parse(rawBody))).toEqual({
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
    const requests: Array<{ url: string; init?: RequestInit }> = []
    fetchMock = vi.fn((input: string, init?: RequestInit) => {
      requests.push({ url: input, ...(init === undefined ? {} : { init }) })
      if (input === `/api/agents/${webAgentId}/revision` && init?.method === 'POST') {
        return Promise.resolve(stubResponse(200, { currentRevisionId: nextAgentRevisionId }))
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
      agentId: webAgentId,
      expectedCurrentRevisionId: webAgentRevisionId,
      displayName: '新小奈',
      persona: '新人设',
      model: { provider: 'test-provider', model: 'chat-model' },
    })

    const call = requests.find((request) => request.url === `/api/agents/${webAgentId}/revision`)
    expect(call).toBeDefined()
    const body = call?.init?.body
    if (typeof body !== 'string') throw new TypeError('revise agent request body must be JSON text.')
    expect(HostApiContracts.reviseAgent.request.parse(JSON.parse(body))).toEqual({
      expectedCurrentRevisionId: webAgentRevisionId,
      displayName: '新小奈',
      persona: '新人设',
      model: { provider: 'test-provider', model: 'chat-model' },
    })
    unsubscribe()
  })

  it('routes context reset and intelligent-agent deletion through their guarded contracts', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    fetchMock = vi.fn((input: string, init?: RequestInit) => {
      requests.push({ url: input, ...(init === undefined ? {} : { init }) })
      if (input === `/api/channels/${webChannelId}/context-reset` && init?.method === 'POST') {
        return Promise.resolve(
          stubResponse(200, {
            mode: 'compact',
            closedEpisodeId: webEpisodeId,
            nextEpisodeId: EpisodeIdSchema.parse('eps_nextsession'),
          }),
        )
      }
      if (input === `/api/agents/${webAgentId}` && init?.method === 'DELETE') {
        return Promise.resolve(
          stubResponse(200, {
            agentId: webAgentId,
            deleted: true,
            unboundChannelIds: [],
            deletedChannelIds: [webChannelId],
          }),
        )
      }
      if (input === `/api/channels/${webChannelId}` && init?.method === 'DELETE') {
        return Promise.resolve(stubResponse(200, { channelId: webChannelId, deleted: true }))
      }
      if (input === '/api/snapshot') return Promise.resolve(stubResponse(200, snapshotBody()))
      return Promise.resolve(stubResponse(404, { error: { code: 'not-found', message: 'x' } }))
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('EventSource', FakeEventSource)

    const host = new HttpProductHost()
    const unsubscribe = host.subscribe(() => undefined)
    await flush()
    await host.execute('channels.resetContext', {
      channelId: webChannelId,
      expectedEpisodeId: webEpisodeId,
      mode: 'compact',
    })
    await host.execute('agents.delete', {
      agentId: webAgentId,
      expectedCurrentRevisionId: webAgentRevisionId,
      confirmationName: '小奈',
    })
    await host.execute('channels.delete', {
      channelId: webChannelId,
      expectedBoundAgentId: webAgentId,
    })

    const resetCall = requests.find((request) => request.url === `/api/channels/${webChannelId}/context-reset`)
    expect(resetCall?.init?.method).toBe('POST')
    if (typeof resetCall?.init?.body !== 'string') throw new TypeError('context reset body must be JSON text.')
    expect(HostApiContracts.resetChannelContext.parseRequest(JSON.parse(resetCall.init.body))).toEqual({
      expectedEpisodeId: webEpisodeId,
      mode: 'compact',
    })
    const deleteCall = requests.find((request) => request.url === `/api/agents/${webAgentId}`)
    expect(deleteCall?.init?.method).toBe('DELETE')
    if (typeof deleteCall?.init?.body !== 'string') throw new TypeError('agent delete body must be JSON text.')
    expect(HostApiContracts.deleteAgent.parseRequest(JSON.parse(deleteCall.init.body))).toEqual({
      expectedCurrentRevisionId: webAgentRevisionId,
      confirmationName: '小奈',
      deleteAutoCreatedBuiltInChannels: true,
    })
    const channelDeleteCall = requests.find(
      (request) => request.url === `/api/channels/${webChannelId}` && request.init?.method === 'DELETE',
    )
    if (typeof channelDeleteCall?.init?.body !== 'string') throw new TypeError('channel delete body must be JSON text.')
    expect(HostApiContracts.deleteChannel.parseRequest(JSON.parse(channelDeleteCall.init.body))).toEqual({
      expectedBoundAgentId: webAgentId,
    })
    unsubscribe()
  })

  it('routes extension activate/deactivate to the activation endpoints', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    fetchMock = vi.fn((input: string, init?: RequestInit) => {
      requests.push({ url: input, ...(init === undefined ? {} : { init }) })
      if (input === '/api/snapshot') return Promise.resolve(stubResponse(200, snapshotBody()))
      if (
        input === `/api/agents/${webAgentId}/extensions/${summaryExtensionId}/activation` &&
        init?.method === 'POST'
      ) {
        return Promise.resolve(
          stubResponse(200, {
            activation: {
              agentId: webAgentId,
              extensionId: summaryExtensionId,
              extensionRevisionId: summaryRevisionId,
              config: {},
              activatedAt: 1_700_000_000_000,
            },
          }),
        )
      }
      if (
        input === `/api/agents/${webAgentId}/extensions/${summaryExtensionId}/activation` &&
        init?.method === 'DELETE'
      ) {
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
      extensionId: summaryExtensionId,
      agentId: webAgentId,
      revisionId: summaryRevisionId,
    })
    const activateCall = requests.find(
      (request) =>
        request.url === `/api/agents/${webAgentId}/extensions/${summaryExtensionId}/activation` &&
        request.init?.method === 'POST',
    )
    expect(activateCall?.init?.method).toBe('POST')
    const activateBody = activateCall?.init?.body
    if (typeof activateBody !== 'string') throw new TypeError('activate request body must be JSON text.')
    expect(HostApiContracts.activateExtension.request.parse(JSON.parse(activateBody))).toEqual({
      revisionId: summaryRevisionId,
    })

    await host.execute('extensions.deactivate', { extensionId: summaryExtensionId, agentId: webAgentId })
    const deactivateCall = requests.find(
      (request) =>
        request.url === `/api/agents/${webAgentId}/extensions/${summaryExtensionId}/activation` &&
        request.init?.method === 'DELETE',
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
        return Promise.resolve(stubResponse(201, { connectionId: qqConnectionId, adapterKey: 'qq-openclaw' }))
      }
      if (input === `/api/connections/${qqConnectionId}/alias` && init?.method === 'POST') {
        return Promise.resolve(stubResponse(200, { connectionId: qqConnectionId, alias: '新主群机器人' }))
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
      alias: '主群机器人',
      configuration: { appId: 'app-1', proactiveSend: true },
      credentials: { clientSecretCredentialRef: 'secret-qq-1' },
    })
    const createCall = requests.find((request) => request.url === '/api/connections' && request.init?.method === 'POST')
    expect(createCall?.init?.method).toBe('POST')
    const createBody = createCall?.init?.body
    if (typeof createBody !== 'string') throw new TypeError('connection request body must be JSON text.')
    expect(HostApiContracts.createConnection.request.parse(JSON.parse(createBody))).toEqual({
      adapterKey: 'qq-openclaw',
      alias: '主群机器人',
      configuration: { appId: 'app-1', proactiveSend: true },
      credentials: { clientSecretCredentialRef: 'secret-qq-1' },
    })
    await host.execute('connections.updateAlias', { connectionId: qqConnectionId, alias: '新主群机器人' })
    const aliasCall = requests.find(
      (request) => request.url === `/api/connections/${qqConnectionId}/alias` && request.init?.method === 'POST',
    )
    expect(aliasCall?.init?.method).toBe('POST')
    const aliasBody = aliasCall?.init?.body
    if (typeof aliasBody !== 'string') throw new TypeError('connection alias request body must be JSON text.')
    expect(HostApiContracts.updateConnectionAlias.request.parse(JSON.parse(aliasBody))).toEqual({
      alias: '新主群机器人',
    })
    unsubscribe()
  })

  it('creates a channel Binding through the generic product Host command', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    fetchMock = vi.fn((input: string, init?: RequestInit) => {
      requests.push({ url: input, ...(init === undefined ? {} : { init }) })
      if (input === '/api/bindings' && init?.method === 'POST') {
        return Promise.resolve(
          stubResponse(201, {
            channelId: createdChannelId,
            agentId: webAgentId,
            triggerPolicy: 'mentioned-or-replied',
            boundAt: 1_700_000_000_000,
          }),
        )
      }
      return Promise.resolve(stubResponse(200, snapshotBody()))
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('EventSource', FakeEventSource)

    const host = new HttpProductHost()
    await host.execute('bindings.create', {
      agentId: webAgentId,
      channelId: createdChannelId,
      triggerPolicy: 'mentioned-or-replied',
    })
    const request = requests.find((candidate) => candidate.url === '/api/bindings')
    const bindingBody = request?.init?.body
    if (typeof bindingBody !== 'string') throw new TypeError('binding request body must be JSON text.')
    expect(HostApiContracts.createBinding.request.parse(JSON.parse(bindingBody))).toEqual({
      agentId: webAgentId,
      channelId: createdChannelId,
      triggerPolicy: 'mentioned-or-replied',
    })
  })

  it('routes agents.updateCapabilities to the capabilities endpoint', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    fetchMock = vi.fn((input: string, init?: RequestInit) => {
      requests.push({ url: input, ...(init === undefined ? {} : { init }) })
      if (input === '/api/snapshot') return Promise.resolve(stubResponse(200, snapshotBody()))
      if (input === `/api/agents/${webAgentId}/capabilities` && init?.method === 'POST') {
        return Promise.resolve(
          stubResponse(200, {
            currentRevisionId: nextAgentRevisionId,
            capabilities: {
              subagents: false,
              fileTools: false,
              webSearch: false,
              dynamicCreation: true,
              developmentShell: false,
              unrestrictedFileAccess: false,
            },
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

    await host.execute('agents.updateCapabilities', { agentId: webAgentId, dynamicCreation: true })
    const capCall = requests.find(
      (request) => request.url === `/api/agents/${webAgentId}/capabilities` && request.init?.method === 'POST',
    )
    expect(capCall?.init?.method).toBe('POST')
    const capBody = capCall?.init?.body
    if (typeof capBody !== 'string') throw new TypeError('capabilities request body must be JSON text.')
    expect(HostApiContracts.updateAgentCapabilities.request.parse(JSON.parse(capBody))).toEqual({
      dynamicCreation: true,
    })
    unsubscribe()
  })

  it('routes connections.test to the diagnostic endpoint', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    fetchMock = vi.fn((input: string, init?: RequestInit) => {
      requests.push({ url: input, ...(init === undefined ? {} : { init }) })
      if (input === '/api/snapshot') return Promise.resolve(stubResponse(200, snapshotBody()))
      if (input === `/api/connections/${qqConnectionId}/test` && init?.method === 'POST') {
        return Promise.resolve(
          stubResponse(200, { status: 'sent', channelId: qqChannelId, platformMessageId: 'qq-message-1' }),
        )
      }
      return Promise.resolve(stubResponse(404, { error: { code: 'not-found', message: 'x' } }))
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('EventSource', FakeEventSource)

    const host = new HttpProductHost()
    const unsubscribe = host.subscribe(() => undefined)
    await flush()

    const result = await host.execute('connections.test', {
      connectionId: qqConnectionId,
      direction: 'send',
      channelId: qqChannelId,
    })
    expect(result).toMatchObject({ status: 'sent', platformMessageId: 'qq-message-1' })
    const testCall = requests.find(
      (request) => request.url === `/api/connections/${qqConnectionId}/test` && request.init?.method === 'POST',
    )
    expect(testCall?.init?.method).toBe('POST')
    const testBody = testCall?.init?.body
    if (typeof testBody !== 'string') throw new TypeError('connection test request body must be JSON text.')
    expect(HostApiContracts.testConnection.request.parse(JSON.parse(testBody))).toEqual({
      direction: 'send',
      channelId: qqChannelId,
    })
    unsubscribe()
  })

  it('routes dynamic.approve to the Agent approval endpoint', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    fetchMock = vi.fn((input: string, init?: RequestInit) => {
      requests.push({ url: input, ...(init === undefined ? {} : { init }) })
      if (input === '/api/snapshot') return Promise.resolve(stubResponse(200, snapshotBody()))
      if (input === `/api/dynamic/${webAgentId}/approve` && init?.method === 'POST') {
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
      agentId: webAgentId,
      episodeId: webEpisodeId,
      requestId: 'approval-1',
      pluginRunId: 'run-1',
    })
    expect(result).toEqual({ accepted: true })
    const approveCall = requests.find(
      (request) => request.url === `/api/dynamic/${webAgentId}/approve` && request.init?.method === 'POST',
    )
    expect(approveCall?.init?.method).toBe('POST')
    const approveBody = approveCall?.init?.body
    if (typeof approveBody !== 'string') throw new TypeError('dynamic approval request body must be JSON text.')
    expect(HostApiContracts.dynamicApprove.request.parse(JSON.parse(approveBody))).toEqual({
      episodeId: webEpisodeId,
      requestId: 'approval-1',
      pluginRunId: 'run-1',
    })
    unsubscribe()
  })

  it('routes extensions.saveFromDynamic to the save endpoint', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    fetchMock = vi.fn((input: string, init?: RequestInit) => {
      requests.push({ url: input, ...(init === undefined ? {} : { init }) })
      if (input === '/api/snapshot') return Promise.resolve(stubResponse(200, snapshotBodyWithDynamic()))
      if (input === '/api/extensions/save-from-dynamic' && init?.method === 'POST') {
        return Promise.resolve(
          stubResponse(200, { extensionId: savedExtensionId, revisionId: savedRevisionId, activation: 'inactive' }),
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
      agentId: webAgentId,
      episodeId: webEpisodeId,
      pluginId: 'plugin-save',
      packageId: 'package-save',
      name: '保存探针',
      slug: 'saved-probe',
    })
    expect(result).toEqual({ extensionId: savedExtensionId, revisionId: savedRevisionId, activation: 'inactive' })
    const saveCall = requests.find(
      (request) => request.url === '/api/extensions/save-from-dynamic' && request.init?.method === 'POST',
    )
    expect(saveCall?.init?.method).toBe('POST')
    const saveBody = saveCall?.init?.body
    if (typeof saveBody !== 'string') throw new TypeError('save extension request body must be JSON text.')
    const body = HostApiContracts.saveExtensionFromDynamic.request.parse(JSON.parse(saveBody))
    expect(body.agentId).toBe(webAgentId)
    expect(body.episodeId).toBe(webEpisodeId)
    expect(body.pluginId).toBe('plugin-save')
    expect(body.packageId).toBe('package-save')
    expect(body.slug).toBe('saved-probe')
    expect(body.displayName).toBe('保存探针')
    unsubscribe()
  })

  it('applies a channel-fact SSE payload without pulling latest messages', async () => {
    const requests: string[] = []
    fetchMock = vi.fn((input: string) => {
      requests.push(String(input))
      if (input === '/api/snapshot') return Promise.resolve(stubResponse(200, snapshotBody()))
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
      channelId: webChannelId,
      revision: 1,
      items: [
        {
          kind: 'outbound',
          sourceId: secondReplyIntentId,
          message: {
            id: secondReplyIntentId,
            channelId: webChannelId,
            role: 'agent',
            parts: [{ type: 'text', text: '第二条回复。' }],
            occurredAt: 1_700_000_002_000,
            deliveryState: 'sent',
          },
        },
      ],
    })
    await flush()

    expect(listener).toHaveBeenCalledTimes(2)
    expect(host.getSnapshot().messages).toHaveLength(3)
    expect(host.getSnapshot().messages.at(-1)).toMatchObject({ role: 'agent', body: '第二条回复。' })
    expect(requests.filter((url) => url.includes('/messages'))).toEqual([])
    unsubscribe()
  })

  it('updates delivery state when the same outbound fact is pushed again', async () => {
    fetchMock = vi.fn((input: string) => {
      if (input === '/api/snapshot') return Promise.resolve(stubResponse(200, snapshotBody()))
      return Promise.resolve(stubResponse(404, { error: { code: 'not-found', message: 'x' } }))
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('EventSource', FakeEventSource)

    const host = new HttpProductHost()
    const unsubscribe = host.subscribe(() => undefined)
    await flush()
    const source = FakeEventSource.instances[0]
    source?.emit('channel-fact', {
      channelId: webChannelId,
      revision: 1,
      items: [
        {
          kind: 'outbound',
          sourceId: secondReplyIntentId,
          message: {
            id: secondReplyIntentId,
            channelId: webChannelId,
            role: 'agent',
            parts: [{ type: 'text', text: '发送中的回复。' }],
            occurredAt: 1_700_000_002_000,
            deliveryState: 'planned',
          },
        },
      ],
    })
    source?.emit('channel-fact', {
      channelId: webChannelId,
      revision: 2,
      items: [
        {
          kind: 'outbound',
          sourceId: secondReplyIntentId,
          message: {
            id: secondReplyIntentId,
            channelId: webChannelId,
            role: 'agent',
            parts: [{ type: 'text', text: '发送中的回复。' }],
            occurredAt: 1_700_000_002_000,
            deliveryState: 'sent',
          },
        },
      ],
    })
    await flush()
    const pushed = host.getSnapshot().messages.filter((message) => message.id === secondReplyIntentId)
    expect(pushed).toHaveLength(1)
    expect(pushed[0]?.delivery).toBe('已发送')
    unsubscribe()
  })

  it('does not refetch runtime or snapshot when runtime frames arrive in a burst', async () => {
    const requests: string[] = []
    fetchMock = vi.fn((input: string) => {
      requests.push(input)
      if (input === '/api/snapshot') return Promise.resolve(stubResponse(200, snapshotBody()))
      if (input.startsWith(`/api/channels/${webChannelId}/runtime`)) {
        return Promise.resolve(
          stubResponse(200, {
            channelId: webChannelId,
            agentId: webAgentId,
            phase: 'thinking',
            summary: '智能体正在处理当前消息。',
            pendingInjectCount: 0,
            turns: [],
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
    const snapshotCallsAfterSubscribe = requests.filter((url) => url === '/api/snapshot').length
    const source = FakeEventSource.instances[0]
    for (let index = 0; index < 40; index += 1) {
      source?.emit('runtime', {
        channelId: webChannelId,
        agentId: webAgentId,
        phase: index % 2 === 0 ? 'thinking' : 'using-tool',
        summary: index % 2 === 0 ? '智能体正在处理当前消息。' : '智能体正在使用发送频道消息。',
        pendingInjectCount: 0,
        turns: [],
        revision: index + 1,
      })
    }
    await flush()
    expect(requests.filter((url) => url === '/api/snapshot')).toHaveLength(snapshotCallsAfterSubscribe)
    expect(requests.filter((url) => url.startsWith(`/api/channels/${webChannelId}/runtime`))).toEqual([])
    expect(host.getSnapshot().channels.find((channel) => channel.id === webChannelId)?.runtimePhase).toBe('使用工具')
    unsubscribe()
  })

  it('replaces loaded trajectory turns from a runtime SSE frame', async () => {
    const requests: string[] = []
    fetchMock = vi.fn((input: string) => {
      requests.push(String(input))
      if (input === '/api/snapshot') return Promise.resolve(stubResponse(200, snapshotBody()))
      if (String(input).startsWith(`/api/channels/${webChannelId}/runtime`)) {
        return Promise.resolve(
          stubResponse(200, {
            channelId: webChannelId,
            agentId: webAgentId,
            phase: 'thinking',
            summary: '智能体正在处理当前消息。',
            pendingInjectCount: 0,
            turns: [],
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
    await host.execute('channels.getRuntime', { channelId: webChannelId })
    const runtimeCallsAfterLoad = requests.filter((url) => String(url).includes('/runtime')).length
    FakeEventSource.instances[0]?.emit('runtime', {
      channelId: webChannelId,
      agentId: webAgentId,
      phase: 'using-tool',
      summary: '智能体正在使用发送频道消息。',
      pendingInjectCount: 0,
      revision: 1,
      turns: [
        {
          turn: 1,
          state: 'in-progress',
          producedReply: false,
          steps: [
            {
              step: 1,
              tools: [
                {
                  callId: 'call_send',
                  name: 'send_channel_message',
                  displayName: '发送频道消息',
                  state: 'running',
                  wroteToChannel: false,
                },
              ],
            },
          ],
        },
      ],
    })
    await flush()
    expect(requests.filter((url) => String(url).includes('/runtime'))).toHaveLength(runtimeCallsAfterLoad)
    expect(host.getSnapshot().channelRuntimes[webChannelId]?.turns).toHaveLength(1)
    expect(host.getSnapshot().channels.find((channel) => channel.id === webChannelId)?.runtimePhase).toBe('使用工具')
    unsubscribe()
  })
  it('keeps channels and agents projections stable across phase-constant runtime frames', async () => {
    const requests: string[] = []
    fetchMock = vi.fn((input: string) => {
      requests.push(String(input))
      if (input === '/api/snapshot') return Promise.resolve(stubResponse(200, snapshotBody()))
      if (String(input).startsWith(`/api/channels/${webChannelId}/runtime`)) {
        return Promise.resolve(
          stubResponse(200, {
            channelId: webChannelId,
            agentId: webAgentId,
            phase: 'thinking',
            summary: '智能体正在处理当前消息。',
            pendingInjectCount: 0,
            turns: [],
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
    await host.execute('channels.getRuntime', { channelId: webChannelId })
    const runtimeCallsAfterLoad = requests.filter((url) => String(url).includes('/runtime')).length
    const source = FakeEventSource.instances[0]
    // The first frame flips the projected phase onto the channel/agent arrays.
    source?.emit('runtime', {
      channelId: webChannelId,
      agentId: webAgentId,
      phase: 'using-tool',
      summary: '智能体正在使用发送频道消息。',
      pendingInjectCount: 0,
      revision: 1,
      turns: [],
    })
    await flush()
    const phaseStableChannels = host.getSnapshot().channels
    const phaseStableAgents = host.getSnapshot().agents
    expect(host.getSnapshot().channels.find((channel) => channel.id === webChannelId)?.runtimePhase).toBe('使用工具')

    // Phase-constant frames keep the whole channels/agents array references
    // stable, so narrow selectors / memoized consumers are not re-cloned on
    // every summary/turn tick.
    for (let index = 0; index < 25; index += 1) {
      source?.emit('runtime', {
        channelId: webChannelId,
        agentId: webAgentId,
        phase: 'using-tool',
        summary: `摘要更新 ${index + 2}`,
        pendingInjectCount: index,
        revision: index + 2,
        turns: [],
      })
    }
    await flush()
    expect(host.getSnapshot().channels).toBe(phaseStableChannels)
    expect(host.getSnapshot().agents).toBe(phaseStableAgents)
    expect(host.getSnapshot().channelRuntimes[webChannelId]?.phase).toBe('使用工具')
    expect(host.getSnapshot().channelRuntimes[webChannelId]?.summary).toBe('摘要更新 26')
    expect(requests.filter((url) => String(url).includes('/runtime'))).toHaveLength(runtimeCallsAfterLoad)

    // A real phase flip still re-projects both slices.
    source?.emit('runtime', {
      channelId: webChannelId,
      agentId: webAgentId,
      phase: 'thinking',
      summary: '智能体正在处理当前消息。',
      pendingInjectCount: 0,
      revision: 27,
      turns: [],
    })
    await flush()
    expect(host.getSnapshot().channels).not.toBe(phaseStableChannels)
    expect(host.getSnapshot().agents).not.toBe(phaseStableAgents)
    expect(host.getSnapshot().channels.find((channel) => channel.id === webChannelId)?.runtimePhase).toBe('思考中')
    unsubscribe()
  })

  it('reconciles loaded messages when SSE reports an expired replay', async () => {
    const requests: string[] = []
    fetchMock = vi.fn((input: string) => {
      requests.push(String(input))
      if (input === '/api/snapshot') return Promise.resolve(stubResponse(200, snapshotBody()))
      if (String(input).startsWith(`/api/channels/${webChannelId}/messages`)) {
        return Promise.resolve(stubResponse(200, { messages: snapshotBody().messages, hasMore: false }))
      }
      return Promise.resolve(stubResponse(404, { error: { code: 'not-found', message: 'x' } }))
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('EventSource', FakeEventSource)

    const host = new HttpProductHost()
    const unsubscribe = host.subscribe(() => undefined)
    await flush()
    FakeEventSource.instances[0]?.emit('status', { ok: true, message: '已连接', replay: 'expired' })
    await flush()
    expect(requests.some((url) => url.includes(`/api/channels/${webChannelId}/messages`))).toBe(true)
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
      createdByAgentId: webAgentId,
      createdByAgent: '小奈',
      activations: [
        {
          agentId: webAgentId,
          agentName: '小奈',
          revisionId: summaryRevisionId,
          revision: 1,
        },
        {
          agentId: createdAgentId,
          agentName: '资料员',
          revisionId: summaryRevisionId,
          revision: 1,
        },
      ],
    })
    unsubscribe()
  })

  it('refreshes pending dynamic approvals when a dynamic-changed SSE event arrives', async () => {
    let awaitingApproval = false
    fetchMock = vi.fn((input: string) => {
      if (input === '/api/snapshot') {
        const snapshot = snapshotBody()
        return Promise.resolve(
          stubResponse(200, {
            ...snapshot,
            dynamic: awaitingApproval
              ? [
                  {
                    agentId: webAgentId,
                    episodeId: webEpisodeId,
                    pluginId: 'plugin-sse-probe',
                    packageId: 'package-sse-probe',
                    approvalRequestId: 'approval-sse-probe',
                    status: 'awaiting-approval',
                    packages: [
                      {
                        packageId: 'package-sse-probe',
                        name: 'SSE 预览探针',
                        purpose: '验证待确认状态实时刷新。',
                        hasHostHalf: false,
                        hasClientHalf: true,
                      },
                    ],
                    policy: { turn: 1, consecutiveFailures: 0, repeatedFingerprintCount: 0 },
                  },
                ]
              : [],
          }),
        )
      }
      return Promise.resolve(stubResponse(404, { error: { code: 'not-found', message: 'x' } }))
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('EventSource', FakeEventSource)

    const host = new HttpProductHost()
    const listener = vi.fn()
    const unsubscribe = host.subscribe(listener)
    await flush()
    expect(host.getSnapshot().dynamic).toEqual([])

    awaitingApproval = true
    FakeEventSource.instances[0]?.emit('dynamic-changed', { agentId: webAgentId })
    await flush()

    expect(listener).toHaveBeenCalledTimes(2)
    expect(host.getSnapshot().dynamic).toEqual([
      expect.objectContaining({ agentId: webAgentId, status: 'awaiting-approval' }),
    ])
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

  it('makes host.refresh replace the realtime stream and reconciles loaded channels after open', async () => {
    const requests: string[] = []
    fetchMock = vi.fn((input: string) => {
      requests.push(String(input))
      if (input === '/api/snapshot') return Promise.resolve(stubResponse(200, snapshotBody()))
      if (String(input).startsWith(`/api/channels/${webChannelId}/messages`)) {
        return Promise.resolve(stubResponse(200, { messages: snapshotBody().messages, hasMore: false }))
      }
      return Promise.resolve(stubResponse(404, { error: { code: 'not-found', message: 'x' } }))
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('EventSource', FakeEventSource)

    const host = new HttpProductHost()
    const unsubscribe = host.subscribe(() => undefined)
    await flush()
    const firstSource = FakeEventSource.instances[0]
    if (!firstSource) throw new Error('测试缺少初始 EventSource。')

    await host.execute('host.refresh')
    const replacement = FakeEventSource.instances[0]
    expect(replacement).toBeDefined()
    expect(replacement).not.toBe(firstSource)
    expect(firstSource.readyState).toBe(2)

    requests.length = 0
    replacement?.open()
    await flush()
    expect(requests).toContain('/api/snapshot')
    expect(requests.some((url) => url.includes(`/api/channels/${webChannelId}/messages`))).toBe(true)
    expect(host.getSnapshot().host).toMatchObject({ status: 'ready', error: null })

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
    await expect(host.execute('agents.updateCapabilities', { agentId: webAgentId })).rejects.toThrow('至少一项')
    await expect(host.execute('extensions.activate', { extensionId: summaryExtensionId })).rejects.toThrow(
      '缺少目标智能体',
    )
    await expect(host.execute('unknown.command')).rejects.toThrow('不支持操作')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('uses safe display placeholders instead of raw identifiers', async () => {
    const raw = snapshotBody()
    const [rawChannel] = raw.channels
    if (!rawChannel) throw new Error('Snapshot fixture must contain a channel.')
    fetchMock = vi.fn(() =>
      Promise.resolve(
        stubResponse(
          200,
          HostApiContracts.snapshot.response.parse({
            ...raw,
            connectionAdapters: [],
            agents: raw.agents.map((agent) => ({ ...agent, displayName: '' })),
            channels: [
              {
                ...rawChannel,
                connectionId: secretConnectionId,
                platformChannelId: 'qq-group-9876',
                kind: 'group',
                displayName: '',
              },
            ],
            connections: [
              {
                id: secretConnectionId,
                adapterKey: 'private-adapter-key',
                appId: '',
                proactiveSend: false,
                credentialConfigured: false,
                channelCount: 1,
                knownChannels: [],
                gateway: { state: 'stopped' },
              },
            ],
            extensions: [],
          }),
        ),
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
      name: '群聊（尾号 9876）',
      connectionName: '未命名连接',
    })
    expect(snapshot.connections[0]).toMatchObject({
      name: '未命名连接平台',
      adapter: '未命名连接平台',
      adapterKey: 'private-adapter-key',
    })
    expect(snapshot.channels[0]?.name).not.toContain(secretConnectionId)
    expect(snapshot.channels[0]?.connectionName).not.toContain(secretConnectionId)
    unsubscribe()
  })

  it('accepts QQ direct channels and projects them as private conversations', async () => {
    const raw = snapshotBody()
    const [rawChannel] = raw.channels
    if (!rawChannel) throw new Error('Snapshot fixture must contain a channel.')
    fetchMock = vi.fn(() =>
      Promise.resolve(
        stubResponse(
          200,
          HostApiContracts.snapshot.response.parse({
            ...raw,
            channels: [
              {
                ...rawChannel,
                connectionId: qqConnectionId,
                platformChannelId: 'c2c:private-4321',
                kind: 'direct',
                displayName: '',
              },
            ],
            connections: [
              {
                id: qqConnectionId,
                adapterKey: 'qq-openclaw',
                appId: '12345678',
                proactiveSend: false,
                credentialConfigured: true,
                channelCount: 1,
                knownChannels: [{ id: webChannelId, name: 'c2c:private-4321', kind: 'direct' }],
                gateway: { state: 'connected' },
              },
            ],
          }),
        ),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('EventSource', FakeEventSource)

    const host = new HttpProductHost()
    const unsubscribe = host.subscribe(() => undefined)
    await flush()

    expect(host.getSnapshot().channels[0]).toMatchObject({ kind: 'qq-direct', name: '私聊（尾号 4321）' })
    expect(host.getSnapshot().connections[0]?.knownChannels[0]?.name).toBe('私聊（尾号 4321）')
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
