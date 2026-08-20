import { listBindingChannels } from './binding-task.js'
import type { AgentSummary, CapabilityAvailability, ChannelSummary, ModelSummary } from '../product-store.js'

export type AgentWorkbenchTab = 'profile' | 'channels' | 'capabilities' | 'extensions' | 'creator'

export interface AgentBlocker {
  readonly kind: 'no-model' | 'no-channel' | 'search-pending' | 'creation-running' | 'unbound-channels'
  readonly label: string
  readonly tab: AgentWorkbenchTab
}

export const listAgentBlockers = (input: {
  readonly agent: AgentSummary
  readonly models: readonly ModelSummary[]
  readonly channels: readonly ChannelSummary[]
  readonly capabilityAvailability: CapabilityAvailability
  readonly dynamic: readonly { readonly agentId: string }[]
}): AgentBlocker[] => {
  const blockers: AgentBlocker[] = []
  const boundCount = input.channels.filter((channel) =>
    channel.bindings.some((binding) => binding.agentId === input.agent.id),
  ).length
  const bindableCount = listBindingChannels({
    channels: input.channels,
    excludeBoundToAgentId: input.agent.id,
  }).length

  if (input.models.length === 0) {
    blockers.push({ kind: 'no-model', label: '还没有可用模型', tab: 'profile' })
  }
  if (boundCount === 0) {
    blockers.push({ kind: 'no-channel', label: '还没有绑定频道', tab: 'channels' })
  }
  if (input.agent.capabilities.webSearch && !input.capabilityAvailability.webSearch.available) {
    blockers.push({ kind: 'search-pending', label: '网页搜索待保存凭据', tab: 'capabilities' })
  }
  if (input.dynamic.some((item) => item.agentId === input.agent.id)) {
    blockers.push({ kind: 'creation-running', label: '动态创造正在运行', tab: 'creator' })
  }
  if (boundCount > 0 && bindableCount > 0) {
    blockers.push({ kind: 'unbound-channels', label: '还有频道可以绑定', tab: 'channels' })
  }
  return blockers
}

export const agentWorkbenchHref = (agentId: string, tab: AgentWorkbenchTab): string => {
  if (tab === 'creator') return `/work/creator?agent=${encodeURIComponent(agentId)}`
  if (tab === 'profile') return `/work/agents/${agentId}`
  return `/work/agents/${agentId}?tab=${tab}`
}
