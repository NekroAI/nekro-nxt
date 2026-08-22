import { describe, expect, it } from 'vitest'
import { AgentIdSchema, ChannelIdSchema, ConnectionIdSchema } from '@nekro-nxt/contracts'
import { agentWorkbenchHref, listAgentBlockers } from '../src/pages/agent-workbench.js'
import {
  defaultImageUnderstandingPolicy,
  type AgentSummary,
  type CapabilityAvailability,
  type ChannelSummary,
} from '../src/product-store.js'

const agentId = AgentIdSchema.parse('agt_workbench')
const availability = (available: boolean): CapabilityAvailability => ({
  subagents: { available: true },
  webSearch: {
    provider: 'deepseek-official',
    available,
    credentialConfigured: available,
    credentialReference: 'DEEPSEEK_API_KEY',
    maxUsesPerCall: 2,
    maxResultsPerCall: 5,
    timeoutMs: 60_000,
  },
})

const agent = (overrides: Partial<AgentSummary> = {}): AgentSummary => ({
  id: agentId,
  name: '资料员',
  description: '',
  state: '空闲',
  model: 'GPT-5',
  personaDocument: { version: 1, segments: [] },
  channels: [],
  extensionCount: 0,
  capabilities: {
    subagents: true,
    fileTools: false,
    webSearch: false,
    dynamicCreation: false,
    developmentShell: false,
    unrestrictedFileAccess: false,
  },
  imagePolicy: defaultImageUnderstandingPolicy(),
  imageDiagnostics: {
    route: { mode: 'unavailable' },
    activeSessions: 0,
    residentImages: 0,
    duplicateImagesSkipped: 0,
    blockers: ['主模型没有声明图片输入能力，且未配置辅助视觉模型。'],
  },
  ...overrides,
})

const channel = (bound: boolean): ChannelSummary => ({
  id: ChannelIdSchema.parse('chn_workbench'),
  connectionId: ConnectionIdSchema.parse('con_workbench'),
  name: '内置频道',
  kind: 'web',
  connectionName: '内置频道',
  agentId: bound ? agentId : '',
  trigger: '始终响应',
  runtimePhase: '空闲',
  bindings: bound ? [{ id: 'binding', agentId, triggerPolicy: 'always' }] : [],
  unread: 0,
})

describe('listAgentBlockers', () => {
  it('asks for a model and a channel before anything else', () => {
    const blockers = listAgentBlockers({
      agent: agent(),
      models: [],
      channels: [channel(false)],
      capabilityAvailability: availability(true),
      dynamic: [],
    })
    expect(blockers.map((item) => item.kind)).toEqual(['no-model', 'no-channel'])
  })

  it('surfaces search credentials and a running creation session', () => {
    const blockers = listAgentBlockers({
      agent: agent({
        capabilities: {
          subagents: true,
          fileTools: false,
          webSearch: true,
          dynamicCreation: true,
          developmentShell: false,
          unrestrictedFileAccess: false,
        },
      }),
      models: [{ provider: 'openai', providerName: 'OpenAI', id: 'gpt-5', name: 'GPT-5' }],
      channels: [channel(true)],
      capabilityAvailability: availability(false),
      dynamic: [{ agentId }],
    })
    expect(blockers.map((item) => item.kind)).toEqual(['search-pending', 'creation-running'])
    expect(agentWorkbenchHref(agentId, 'creator')).toBe(`/work/creator?agent=${agentId}`)
    expect(agentWorkbenchHref(agentId, 'capabilities')).toBe(`/work/agents/${agentId}?tab=capabilities`)
  })
})
