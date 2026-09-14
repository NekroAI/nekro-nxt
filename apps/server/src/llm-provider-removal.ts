import type { HostApiResponse } from '@nekro-nxt/contracts'
import type { AgentRevisionRecord, CoreRepository } from '@nekro-nxt/core'
import type { RuntimeRepository } from '@nekro-nxt/channel-runtime'
import type { LlmProviderSettingsView } from './host-model-settings.js'

export type RemovalImpact = HostApiResponse<'llmProviderRemovalImpact'>

type ReferenceRepository = Pick<CoreRepository, 'listAgents' | 'getAgentRevision' | 'getChannel'> &
  Pick<RuntimeRepository, 'listRecoverableEpisodes'>

export class LlmProviderRemovalConflict extends Error {
  readonly code = 'SETTINGS_CONFLICT'
}

/** One host owns the gate; repository reference commits are synchronous and cannot cross it. */
export class LlmProviderRemovalCoordinator {
  readonly #pending = new Set<string>()
  readonly #observed = new Map<string, () => boolean>()

  constructor(readonly repository: ReferenceRepository) {}

  assertReference(revision: AgentRevisionRecord): void {
    const providers = [revision.model.provider]
    if (revision.imagePolicy.textModel.mode === 'auxiliary') {
      providers.push(revision.imagePolicy.textModel.model.provider)
    }
    for (const provider of providers) {
      if (this.#pending.has(provider) || this.#observed.get(provider)?.() === false) {
        throw new LlmProviderRemovalConflict(`供应商 ${provider} 正在移除或已移除，请刷新后选择模型。`)
      }
    }
  }

  async run<T>(provider: string, configured: () => boolean, operation: () => Promise<T>): Promise<T> {
    if (this.#pending.has(provider)) throw new LlmProviderRemovalConflict('此供应商正在移除，请稍后刷新。')
    this.#pending.add(provider)
    try {
      return await operation()
    } finally {
      // Retain the guard only when the configuration is actually gone, including a lost response.
      // A rejected/rolled-back removal must leave previous observation state untouched.
      this.#pending.delete(provider)
      if (!configured()) this.#observed.set(provider, configured)
    }
  }
}

/** The caller performs the asynchronous settings read before this synchronous reference scan. */
export function getLlmProviderRemovalImpact(
  repository: ReferenceRepository,
  settings: LlmProviderSettingsView,
  provider: string,
  removalBlockedReason: string,
): RemovalImpact {
  const selected = settings.providers.find((entry) => entry.provider === provider && entry.configured)
  if (!selected) throw new LlmProviderRemovalConflict('供应商配置已不存在，请刷新列表。')
  const references: RemovalImpact['references'] = []
  const addReferences = (
    revision: AgentRevisionRecord,
    location: Pick<RemovalImpact['references'][number], 'scope' | 'channelId' | 'channelName' | 'episodeStatus'>,
  ): void => {
    const add = (model: string, role: 'primary' | 'vision'): void => {
      references.push({ agentId: revision.agentId, displayName: revision.displayName, model, role, ...location })
    }
    if (revision.model.provider === provider) add(revision.model.model, 'primary')
    const auxiliary = revision.imagePolicy.textModel
    if (auxiliary.mode === 'auxiliary' && auxiliary.model.provider === provider) add(auxiliary.model.model, 'vision')
  }
  for (const { revision } of repository.listAgents()) addReferences(revision, { scope: 'configuration' })
  for (const episode of repository.listRecoverableEpisodes()) {
    if (episode.status !== 'active' && episode.status !== 'opening') continue
    const revision = repository.getAgentRevision(episode.agentRevisionId)
    if (!revision) throw new Error('无法解析频道上下文的智能体配置，暂不能确认移除影响。')
    addReferences(revision, {
      scope: 'context',
      channelId: episode.channelId,
      channelName: repository.getChannel(episode.channelId)?.displayName ?? '未命名频道',
      episodeStatus: episode.status,
    })
  }
  return {
    provider,
    displayName: selected.displayName,
    declared: selected.declared,
    expectedRevision: selected.settingsRevision,
    models: selected.models.map((model) => model.id),
    references,
    blockedReason: !settings.writable
      ? '当前宿主的模型设置只读。'
      : removalBlockedReason
        ? removalBlockedReason
        : references.length > 0
          ? '仍有智能体或频道上下文使用此供应商。请先切换主模型或辅助视觉模型，并更新相关频道上下文，再重新检查影响。'
          : '',
  }
}
