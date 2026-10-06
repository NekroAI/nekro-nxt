import type { Page, Route } from '@playwright/test'
import {
  AgentIdSchema,
  AgentRevisionIdSchema,
  AuthoringAttemptIdSchema,
  AuthoringTaskIdSchema,
  ChannelEventIdSchema,
  ChannelIdSchema,
  ConnectionIdSchema,
  EpisodeIdSchema,
  HostApiContracts,
  type HostApiResponse,
} from '@nekro-nxt/contracts'
import { installWorkspaceRoutes } from './workspace.js'
import { imageDiagnostics, imagePolicy, productSnapshot } from './product-quality.js'

/**
 * A realistic-volume, entirely fictional workspace for layout audits (Decision 2026-10-06 §9): 40 models,
 * 200 members, 30 channels, a two-thousand-character persona, long mixed-script names with Emoji and
 * connections in failing states.
 */

type Snapshot = HostApiResponse<'snapshot'>

export const largeAgentIds = ['LONGPERSONA', 'ENGLISHNAME', 'QUIETHELPER', 'EMOJIAGENT'].map((suffix) =>
  AgentIdSchema.parse(`agt_large${suffix}`),
)
const revisionIds = largeAgentIds.map((_, index) => AgentRevisionIdSchema.parse(`arev_large${index}`))
const agentNames = [
  '一个名字特别特别长需要在列表与标题里稳定截断的研究助理智能体',
  'Long-Running International Operations Coordinator',
  '小助手',
  '🌙 夜班值守 · Night Watch 🦉',
]

export const largeConnectionIds = {
  internal: ConnectionIdSchema.parse('con_largeinternal'),
  healthy: ConnectionIdSchema.parse('con_largehealthy'),
  failing: ConnectionIdSchema.parse('con_largefailing'),
  reconnecting: ConnectionIdSchema.parse('con_largereconnect'),
}

const channelNames = [
  '产品讨论群',
  '一个非常非常长的群聊名称用来检查列表行与检查器标题的截断效果是否稳定',
  'Weekly Sync — Platform, Infrastructure & Developer Experience',
  '🎮 周末开黑 🎉🎉',
  '读书会',
  '客服反馈（一线）',
  '设计评审',
  '研发值班',
  'Random 闲聊',
  '新人报到',
]
export const largeChannelIds = Array.from({ length: 30 }, (_, index) =>
  ChannelIdSchema.parse(`chn_large${String(index).padStart(2, '0')}`),
)
const channelConnection = (index: number) =>
  index === 0
    ? largeConnectionIds.internal
    : index < 18
      ? largeConnectionIds.healthy
      : index < 25
        ? largeConnectionIds.failing
        : largeConnectionIds.reconnecting
const channelAgent = (index: number) => (index % 7 === 6 ? undefined : largeAgentIds[index % largeAgentIds.length])
const channelName = (index: number) =>
  index === 0 ? '长设定助理的内置频道' : `${channelNames[index % channelNames.length]}${index >= 10 ? ` ${index}` : ''}`

const personaParagraph =
  '你是一位耐心细致的研究助理，负责整理群聊里出现的问题、资料和待办。遇到含糊的请求时先复述理解再动手；给出结论时附上依据和不确定之处；不替别人做决定，只把选项和取舍讲清楚。说话简洁，避免空话，也不使用夸张的语气。'
export const longPersona = Array.from({ length: 16 }, (_, index) => `第 ${index + 1} 条：${personaParagraph}`).join(
  '\n\n',
)

export const largeModels = Array.from({ length: 40 }, (_, index) => ({
  provider: index < 28 ? 'fixture-gateway' : 'fixture-direct',
  providerName: index < 28 ? '示例聚合网关' : '示例直连供应商',
  id: `fixture-model-${String(index + 1).padStart(2, '0')}${index % 9 === 0 ? '-with-a-much-longer-identifier' : ''}`,
  name: `示例模型 ${index + 1}${index % 9 === 0 ? ' Extended Context Preview Edition' : ''}`,
  ...(index % 3 === 0 ? { inputModalities: ['text', 'image'] as const } : { inputModalities: ['text'] as const }),
}))

const taskId = AuthoringTaskIdSchema.parse('aut_LARGETASK')
const attemptId = AuthoringAttemptIdSchema.parse('aua_LARGEATTEMPT')
export const largeTaskId = taskId
const largeAttempt = {
  id: attemptId,
  ordinal: 1,
  name: '一个用来检查长标题截断效果的群聊摘要卡片扩展',
  purpose: '把当前频道最近的讨论整理成可继续跟进的摘要卡片，并标出未回答的问题。',
  state: 'active',
  riskDigest: 'b'.repeat(64),
  host: { status: 'running', waitingFor: [] },
  client: { status: 'absent', waitingFor: [] },
  createdAt: 1_725_000_001_000,
}

const capabilities = (index: number) => ({
  subagents: index % 2 === 0,
  fileTools: index === 0,
  webSearch: index === 1,
  dynamicCreation: index === 0,
  developmentShell: false,
  unrestrictedFileAccess: false,
})

export const largeSnapshot: Snapshot = HostApiContracts.snapshot.response.parse({
  ...productSnapshot,
  models: largeModels,
  agents: largeAgentIds.map((id, index) => ({
    id,
    displayName: agentNames[index],
    persona: index === 0 ? longPersona : '简洁、可靠',
    personaDocument: {
      version: 1,
      segments: [{ type: 'text', text: index === 0 ? longPersona : '简洁、可靠' }],
    },
    currentRevisionId: revisionIds[index],
    createdAt: 1_725_000_000_000 + index,
    runtimeStatus: index === 1 ? 'running' : 'idle',
    ...(index === 1 ? { runtimePhase: 'thinking' } : {}),
    model: { provider: largeModels[index * 3]!.provider, model: largeModels[index * 3]!.id },
    dynamicClientApprovalPolicy: 'manual',
    imagePolicy,
    imageDiagnostics,
    capabilities: capabilities(index),
    channels: largeChannelIds.filter((_, channelIndex) => channelAgent(channelIndex) === id),
  })),
  channels: largeChannelIds.map((id, index) => {
    const agentId = channelAgent(index)
    return {
      id,
      connectionId: channelConnection(index),
      platformChannelId: `fixture-platform-${index}`,
      kind: index === 0 ? 'internal' : index % 5 === 0 ? 'direct' : 'group',
      displayName: channelName(index),
      ...(agentId ? { boundAgentId: agentId } : {}),
      bindings: agentId
        ? [{ channelId: id, agentId, triggerPolicy: index % 3 === 0 ? 'always' : 'mentioned-or-replied', boundAt: 1 }]
        : [],
    }
  }),
  connections: [
    {
      id: largeConnectionIds.internal,
      adapterKey: 'fixture-alpha',
      status: { state: 'connected', proactiveSend: false, credentialConfigured: true, activities: {} },
      channelCount: 1,
      knownChannels: [],
    },
    ...(
      [
        [largeConnectionIds.healthy, '社群运营账号（主号，长期在线，负责全部公开群聊）', 'connected', undefined],
        [largeConnectionIds.failing, '备用账号 🛟', 'failed', '凭据已失效，需要重新登录后才能收发消息。'],
        [largeConnectionIds.reconnecting, undefined, 'reconnecting', '网络波动，正在重新连接。'],
      ] as const
    ).map(([id, alias, state, message], index) => ({
      id,
      adapterKey: 'fixture-beta',
      ...(alias ? { alias } : {}),
      status: {
        state,
        ...(message ? { message } : {}),
        proactiveSend: false,
        credentialConfigured: true,
        accountReference: `示例账号 ${index + 1}`,
        activities: {},
      },
      channelCount: largeChannelIds.filter((_, channelIndex) => channelConnection(channelIndex) === id).length,
      knownChannels: largeChannelIds
        .map((channelId, channelIndex) => ({ channelId, channelIndex }))
        .filter(({ channelIndex }) => channelConnection(channelIndex) === id)
        .map(({ channelId, channelIndex }) => ({
          id: channelId,
          name: channelName(channelIndex),
          kind: channelIndex % 5 === 0 ? ('direct' as const) : ('group' as const),
        })),
    })),
  ],
  authoringTasks: [
    {
      id: taskId,
      agentId: largeAgentIds[0],
      channelId: largeChannelIds[0],
      episodeId: EpisodeIdSchema.parse('eps_largetask'),
      title: largeAttempt.name,
      requirementSummary: largeAttempt.purpose,
      status: 'ready',
      approvalPolicy: 'risk-stable',
      revision: 3,
      candidateAttempt: largeAttempt,
      activeAttempt: largeAttempt,
      verifiedAttempt: largeAttempt,
      createdAt: 1_725_000_000_000,
      updatedAt: 1_725_000_002_000,
    },
  ],
  dynamic: [],
})

const longMessage =
  '这是一段用于检查长消息排版的示例文字，包含一个很长的不可断行标识 fixture_identifier_without_any_spaces_that_should_wrap_safely_in_the_bubble，以及一段中英文混排 mixed Chinese and English text，确保气泡宽度、换行与时间戳都保持稳定。'

export const largeMessages = (channelId: string) =>
  Array.from({ length: 40 }, (_, index) => ({
    id: ChannelEventIdSchema.parse(`evt_large${channelId.slice(-2)}${String(index).padStart(2, '0')}`),
    channelId,
    role: index % 4 === 3 ? 'agent' : 'member',
    ...(index % 4 === 3
      ? { deliveryState: 'sent' }
      : {
          sender: {
            memberId: `mbr_largemember${index % 6}`,
            displayName: index % 6 === 0 ? '成员甲' : `示例成员 ${index % 6}`,
          },
        }),
    parts: [{ type: 'text', text: index % 5 === 0 ? longMessage : `第 ${index + 1} 条消息。` }],
    occurredAt: 1_725_000_000_000 + index * 60_000,
  }))

const members = Array.from({ length: 200 }, (_, index) => ({
  identityId: `pid_largemember${String(index).padStart(3, '0')}`,
  displayName:
    index === 0
      ? '一位名称很长但仍需要保持行布局稳定的平台成员（管理员）'
      : index % 17 === 0
        ? `Member with an English name ${index} 🌟`
        : `示例成员 ${index}`,
  adapter: { key: 'fixture-beta', displayName: '示例群聊平台' },
  connection: { id: largeConnectionIds.healthy, displayName: '社群运营账号' },
  activeChannelCount: (index % 5) + 1,
  channelPreview: [{ id: largeChannelIds[1], displayName: channelName(1), kind: 'group' as const }],
  historicalOnly: false,
}))

export const largeProviders = {
  writable: true,
  protocols: ['openai-completions'],
  providers: [
    {
      provider: 'fixture-gateway',
      displayName: '示例聚合网关',
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'fixture-gateway'],
      settingsRevision: 2,
      declared: false,
      active: true,
      configured: true,
      credential: { configured: true, writable: true },
      models: largeModels
        .filter((model) => model.provider === 'fixture-gateway')
        .map((model, index) => ({
          id: model.id,
          name: model.name,
          contextWindow: index % 2 === 0 ? 1_000_000 : 128_000,
          ...(index % 4 === 0 ? { maxTokens: 32_768 } : {}),
          inputModalities: [...model.inputModalities],
        })),
      modelsCustomized: true,
      discoverable: true,
    },
    {
      provider: 'fixture-direct',
      displayName: '示例直连供应商',
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'fixture-direct'],
      settingsRevision: 1,
      declared: false,
      active: true,
      configured: true,
      credential: { configured: true, writable: true },
      models: largeModels
        .filter((model) => model.provider === 'fixture-direct')
        .map((model) => ({ id: model.id, name: model.name, inputModalities: [...model.inputModalities] })),
      modelsCustomized: false,
      discoverable: false,
    },
  ],
}

/** Answers every read the redesigned client makes from the large snapshot. */
export async function installLargeWorkspaceRoutes(page: Page): Promise<void> {
  const json = (route: Route, value: unknown) => route.fulfill({ json: value })
  await page.route('**/api/snapshot', (route) => json(route, largeSnapshot))
  await installWorkspaceRoutes(page, () => largeSnapshot)
  await page.route('**/api/channels/*/runtime', (route) => {
    const channelId = new URL(route.request().url()).pathname.split('/')[3]
    const channel = largeSnapshot.channels.find((item) => item.id === channelId)
    return json(route, {
      cursor: { epoch: 'fixture', sequence: 0 },
      channelId,
      ...(channel?.boundAgentId === undefined ? {} : { agentId: channel.boundAgentId }),
      phase: 'idle',
      summary: '智能体当前空闲。',
      pendingInjectCount: 0,
      occupancy: {
        projectedTokens: 96_000,
        contextWindow: 128_000,
        breakdown: { systemTokens: 12_000, toolsTokens: 18_000, messageTokens: 66_000 },
      },
      turns: [],
    })
  })
  await page.route('**/api/channels/*/messages?*', (route) => {
    const channelId = new URL(route.request().url()).pathname.split('/').at(-2) ?? ''
    return json(route, { cursor: { epoch: 'fixture', sequence: 0 }, messages: largeMessages(channelId), hasMore: true })
  })
  await page.route('**/api/connections/*/events?*', (route) => json(route, { events: [], hasMore: false }))
  await page.route('**/api/dynamic/*/inventory', (route) => json(route, { rows: [] }))
  await page.route('**/api/platform-users*', (route) => {
    const url = new URL(route.request().url())
    const query = (url.searchParams.get('query') ?? '').toLocaleLowerCase('zh-CN')
    const limit = Number(url.searchParams.get('limit') ?? '30')
    const cursor = url.searchParams.get('cursor')
    const matched = members.filter((member) => !query || member.displayName.toLocaleLowerCase('zh-CN').includes(query))
    const start = cursor ? matched.findIndex((member) => member.identityId === cursor) + 1 : 0
    const items = matched.slice(start, start + limit)
    const last = items.at(-1)
    return json(route, {
      total: matched.length,
      items,
      facets: {
        adapters: [{ key: 'fixture-beta', displayName: '示例群聊平台', userCount: members.length }],
        connections: [
          {
            id: largeConnectionIds.healthy,
            adapterKey: 'fixture-beta',
            displayName: '社群运营账号',
            userCount: members.length,
          },
        ],
      },
      ...(last && start + limit < matched.length ? { nextCursor: last.identityId } : {}),
    })
  })
  await page.route('**/api/llm/providers', (route) => json(route, largeProviders))
  await page.route(`**/api/authoring/tasks/${taskId}`, (route) =>
    json(route, { task: largeSnapshot.authoringTasks[0], attempts: [largeAttempt], events: [] }),
  )
}
