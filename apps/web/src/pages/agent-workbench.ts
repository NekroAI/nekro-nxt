import { listBindingChannels } from './binding-task.js'
import type { AgentSummary, CapabilityAvailability, ChannelSummary, ModelSummary } from '../product-runtime.js'

export type AgentWorkbenchTab = 'profile' | 'channels' | 'capabilities' | 'extensions' | 'creator'

export interface AgentBlocker {
  readonly kind:
    'no-model' | 'model-missing' | 'no-channel' | 'search-pending' | 'creation-running' | 'unbound-channels'
  readonly label: string
  readonly tab: AgentWorkbenchTab
}

/**
 * The saved default model when its provider no longer lists it (for example a retired model name). The Agent may
 * still run, but its image capability can no longer be confirmed, so the workbench asks for a replacement.
 */
export const missingAgentModel = (
  agent: Pick<AgentSummary, 'modelRef'>,
  models: readonly Pick<ModelSummary, 'provider' | 'id'>[],
): { readonly provider: string; readonly model: string } | undefined => {
  const ref = agent.modelRef
  if (!ref) return undefined
  return models.some((model) => model.provider === ref.provider && model.id === ref.model) ? undefined : ref
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
  } else {
    const missing = missingAgentModel(input.agent, input.models)
    if (missing)
      blockers.push({ kind: 'model-missing', label: `默认模型 ${missing.model} 已不在模型列表中`, tab: 'profile' })
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
