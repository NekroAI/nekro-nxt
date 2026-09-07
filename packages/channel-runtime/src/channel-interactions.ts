import type { AdapterRuntimeStateStore } from '@nekro-nxt/adapter-sdk'
import type {
  AgentId,
  ChannelId,
  ChannelMemberId,
  ConnectionId,
  EpisodeId,
  JsonValue,
  LogicalMessageId,
} from '@nekro-nxt/contracts'
import {
  AgentIdSchema,
  ChannelIdSchema,
  ConnectionIdSchema,
  EpisodeIdSchema,
  JsonValueSchema,
  parseJsonValue,
} from '@nekro-nxt/contracts'
import type { CoreRepository, CoreService } from '@nekro-nxt/core'
import type { ChannelInteractionResult, ChannelRuntimeOptions, EpisodeRecord, RuntimeRepository } from './index.js'
type ChannelInteractionStatus = ChannelInteractionResult['status']

const INTERACTION_STATE_KEY = 'host/interaction-intents'

interface DurableInteractionIntent {
  readonly id: string
  readonly connectionId: ConnectionId
  readonly channelId: ChannelId
  readonly episodeId: EpisodeId
  readonly agentId: AgentId
  readonly clientRequestId: string
  readonly kind: 'retract-message' | 'nudge-member'
  readonly targetId: string
  readonly state: 'planned' | 'sending' | ChannelInteractionStatus
  readonly result?: JsonValue
  readonly createdAt: number
  readonly updatedAt: number
}

const parseChannelInteractionResult = (candidate: JsonValue | undefined): ChannelInteractionResult | undefined => {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return undefined
  const status = candidate['status']
  if (
    typeof candidate['intentId'] !== 'string' ||
    (status !== 'succeeded' && status !== 'partially-succeeded' && status !== 'failed' && status !== 'unknown') ||
    typeof candidate['message'] !== 'string'
  )
    return undefined
  const rawOutcomes = candidate['outcomes']
  const outcomes = Array.isArray(rawOutcomes)
    ? rawOutcomes.flatMap((outcome) => {
        if (
          typeof outcome !== 'object' ||
          outcome === null ||
          Array.isArray(outcome) ||
          typeof outcome['platformMessageId'] !== 'string' ||
          typeof outcome['status'] !== 'string'
        )
          return []
        const message = outcome['message']
        return [
          {
            platformMessageId: outcome['platformMessageId'],
            status: outcome['status'],
            ...(typeof message === 'string' ? { message } : {}),
          },
        ]
      })
    : undefined
  return {
    intentId: candidate['intentId'],
    status,
    message: candidate['message'],
    ...(outcomes === undefined ? {} : { outcomes }),
  }
}

const parseInteractionIntent = (candidate: unknown): DurableInteractionIntent | undefined => {
  const parsed = JsonValueSchema.safeParse(candidate)
  if (!parsed.success || typeof parsed.data !== 'object' || parsed.data === null || Array.isArray(parsed.data))
    return undefined
  const row = parsed.data
  const connectionId = ConnectionIdSchema.safeParse(row['connectionId'])
  const channelId = ChannelIdSchema.safeParse(row['channelId'])
  const episodeId = EpisodeIdSchema.safeParse(row['episodeId'])
  const agentId = AgentIdSchema.safeParse(row['agentId'])
  const kind = row['kind']
  const state = row['state']
  if (
    typeof row['id'] !== 'string' ||
    !connectionId.success ||
    !channelId.success ||
    !episodeId.success ||
    !agentId.success ||
    typeof row['clientRequestId'] !== 'string' ||
    (kind !== 'retract-message' && kind !== 'nudge-member') ||
    typeof row['targetId'] !== 'string' ||
    (state !== 'planned' &&
      state !== 'sending' &&
      state !== 'succeeded' &&
      state !== 'partially-succeeded' &&
      state !== 'failed' &&
      state !== 'unknown') ||
    typeof row['createdAt'] !== 'number' ||
    typeof row['updatedAt'] !== 'number'
  )
    return undefined
  return {
    id: row['id'],
    connectionId: connectionId.data,
    channelId: channelId.data,
    episodeId: episodeId.data,
    agentId: agentId.data,
    clientRequestId: row['clientRequestId'],
    kind,
    targetId: row['targetId'],
    state,
    ...(row['result'] === undefined ? {} : { result: parseJsonValue(row['result']) }),
    createdAt: row['createdAt'],
    updatedAt: row['updatedAt'],
  }
}
export class ChannelInteractions {
  readonly #core: CoreService
  readonly #coreRepository: CoreRepository
  readonly #runtimeRepository: RuntimeRepository
  readonly #resolveAdapter: ChannelRuntimeOptions['resolveAdapter']
  readonly #adapterState: AdapterRuntimeStateStore | undefined
  readonly #timestamp: () => number
  readonly #nextUlid: () => string
  constructor(
    core: CoreService,
    repository: CoreRepository,
    runtime: RuntimeRepository,
    resolveAdapter: ChannelRuntimeOptions['resolveAdapter'],
    state: AdapterRuntimeStateStore | undefined,
    timestamp: () => number,
    nextUlid: () => string,
  ) {
    this.#core = core
    this.#coreRepository = repository
    this.#runtimeRepository = runtime
    this.#resolveAdapter = resolveAdapter
    this.#adapterState = state
    this.#timestamp = timestamp
    this.#nextUlid = nextUlid
  }
  readonly #operations = new Map<ChannelId, Promise<void>>()
  readonly #loading = new Map<ConnectionId, Promise<void>>()
  readonly #interactionIntents = new Map<string, DurableInteractionIntent>()
  readonly #interactionLoadedConnections = new Set<ConnectionId>()
  readonly #interactionPersistence = new Map<ConnectionId, Promise<void>>()
  async retractChannelMessage(input: {
    readonly episodeId: EpisodeId
    readonly logicalMessageId: LogicalMessageId
    readonly clientRequestId: string
  }): Promise<ChannelInteractionResult> {
    const episode = this.#requireInteractionEpisode(input.episodeId)
    return this.#withChannel(episode.channelId, () => this.#retractChannelMessage(input))
  }

  async #retractChannelMessage(input: {
    readonly episodeId: EpisodeId
    readonly logicalMessageId: LogicalMessageId
    readonly clientRequestId: string
  }): Promise<ChannelInteractionResult> {
    const episode = this.#requireInteractionEpisode(input.episodeId)
    const channel = this.#coreRepository.getChannel(episode.channelId)!
    await this.ensureInteractionsLoaded(channel.connectionId)
    const existing = this.#findInteraction(episode, input.clientRequestId)
    if (existing) return this.#interactionResult(existing)
    const outbound = this.#runtimeRepository.findOutboundByLogicalMessageId(channel.id, input.logicalMessageId)
    if (!outbound) throw new Error('当前频道找不到这条智能体消息。')
    const sourceEpisode = this.#runtimeRepository.getEpisode(outbound.intent.episodeId)
    if (!sourceEpisode || sourceEpisode.channelId !== channel.id || sourceEpisode.agentId !== episode.agentId) {
      throw new Error('只能撤回当前频道中该智能体自己发送的消息。')
    }
    const adapter = this.#resolveAdapter(channel.connectionId)
    if (!adapter?.interactions?.retractOwnMessage) throw new Error('当前连接不支持消息撤回。')
    const intent = await this.#planInteraction({
      episode,
      connectionId: channel.connectionId,
      clientRequestId: input.clientRequestId,
      kind: 'retract-message',
      targetId: input.logicalMessageId,
    })
    const deliveries = outbound.deliveries.flatMap((delivery) =>
      delivery.receipt?.status === 'sent' && delivery.receipt.platformMessageId !== undefined
        ? [{ deliveryId: delivery.id, platformMessageId: delivery.receipt.platformMessageId }]
        : [],
    )
    if (deliveries.length === 0) {
      return this.#settleInteraction(intent, 'failed', '这条消息没有可撤回的已确认平台投递。')
    }
    const outcomes = [] as Array<{ platformMessageId: string; status: string; message?: string }>
    for (const delivery of deliveries) {
      const outcome = await adapter.interactions
        .retractOwnMessage({
          channelId: channel.id,
          platformMessageId: delivery.platformMessageId,
          clientRequestId: `${input.clientRequestId}:${delivery.deliveryId}`,
        })
        .catch((error: unknown) => ({
          status: 'failed' as const,
          message: error instanceof Error ? error.message : String(error),
        }))
      outcomes.push({
        platformMessageId: delivery.platformMessageId,
        status: outcome.status,
        ...('message' in outcome ? { message: outcome.message } : {}),
      })
      if (outcome.status === 'succeeded') {
        this.#core.appendInbound({
          connectionId: channel.connectionId,
          channelId: channel.id,
          adapterKey: this.#coreRepository.getConnection(channel.connectionId)!.adapterKey,
          kind: 'message-deleted',
          activityKey: 'message-recalled',
          targetPlatformMessageId: delivery.platformMessageId,
          parts: [
            {
              type: 'rich',
              adapterKey: this.#coreRepository.getConnection(channel.connectionId)!.adapterKey,
              kind: 'message-recalled',
              summary: '智能体撤回了自己发送的一条消息。',
            },
          ],
          platformTimestamp: this.#timestamp(),
          receivedAt: this.#timestamp(),
          dedupeKey: `interaction:${intent.id}:${delivery.deliveryId}`,
          facts: { selfInteraction: true, interactionIntentId: intent.id },
        })
      }
    }
    const succeeded = outcomes.filter(({ status }) => status === 'succeeded').length
    const unknown = outcomes.some(({ status }) => status === 'unknown')
    const status: ChannelInteractionStatus =
      succeeded === outcomes.length
        ? 'succeeded'
        : succeeded > 0
          ? 'partially-succeeded'
          : unknown
            ? 'unknown'
            : 'failed'
    return this.#settleInteraction(
      intent,
      status,
      status === 'succeeded'
        ? '消息已撤回。'
        : status === 'partially-succeeded'
          ? '消息只撤回了部分平台投递。'
          : status === 'unknown'
            ? '平台结果不明确；为避免重复副作用，不会自动重试。'
            : '消息撤回失败。',
      outcomes,
    )
  }

  async nudgeChannelMember(input: {
    readonly episodeId: EpisodeId
    readonly memberId: ChannelMemberId
    readonly clientRequestId: string
  }): Promise<ChannelInteractionResult> {
    const episode = this.#requireInteractionEpisode(input.episodeId)
    return this.#withChannel(episode.channelId, () => this.#nudgeChannelMember(input))
  }

  async #nudgeChannelMember(input: {
    readonly episodeId: EpisodeId
    readonly memberId: ChannelMemberId
    readonly clientRequestId: string
  }): Promise<ChannelInteractionResult> {
    const episode = this.#requireInteractionEpisode(input.episodeId)
    const channel = this.#coreRepository.getChannel(episode.channelId)!
    const member = this.#coreRepository.getChannelMember(input.memberId)
    if (!member || member.channelId !== channel.id) throw new Error('只能戳一戳当前频道中的已知成员。')
    await this.ensureInteractionsLoaded(channel.connectionId)
    const existing = this.#findInteraction(episode, input.clientRequestId)
    if (existing) return this.#interactionResult(existing)
    const now = this.#timestamp()
    const recent = [...this.#interactionIntents.values()].filter(
      (intent) => intent.channelId === channel.id && intent.kind === 'nudge-member' && now - intent.createdAt < 60_000,
    )
    if (recent.some((intent) => intent.targetId === input.memberId && now - intent.createdAt < 30_000)) {
      throw new Error('同一成员 30 秒内只能戳一次。')
    }
    if (recent.length >= 3) throw new Error('当前频道每分钟最多戳三次。')
    const adapter = this.#resolveAdapter(channel.connectionId)
    if (!adapter?.interactions?.nudgeMember) throw new Error('当前连接不支持戳一戳。')
    const intent = await this.#planInteraction({
      episode,
      connectionId: channel.connectionId,
      clientRequestId: input.clientRequestId,
      kind: 'nudge-member',
      targetId: input.memberId,
    })
    const outcome = await adapter.interactions
      .nudgeMember({
        channelId: channel.id,
        memberId: input.memberId,
        clientRequestId: input.clientRequestId,
      })
      .catch((error: unknown) => ({
        status: 'failed' as const,
        message: error instanceof Error ? error.message : String(error),
      }))
    const status = outcome.status === 'succeeded' ? 'succeeded' : outcome.status === 'unknown' ? 'unknown' : 'failed'
    return this.#settleInteraction(
      intent,
      status,
      outcome.status === 'succeeded' ? '已戳一戳该成员。' : 'message' in outcome ? outcome.message : '戳一戳失败。',
    )
  }

  #requireInteractionEpisode(episodeId: EpisodeId): EpisodeRecord {
    const episode = this.#runtimeRepository.getEpisode(episodeId)
    if (!episode || episode.status !== 'active') throw new Error('互动工具需要当前活动频道会话。')
    const binding = this.#coreRepository.getBinding(episode.channelId)
    if (!binding || binding.agentId !== episode.agentId) throw new Error('当前会话已不再拥有这个频道。')
    if (!this.#coreRepository.getChannel(episode.channelId)) throw new Error('当前频道不存在。')
    return episode
  }

  async #planInteraction(input: {
    readonly episode: EpisodeRecord
    readonly connectionId: ConnectionId
    readonly clientRequestId: string
    readonly kind: DurableInteractionIntent['kind']
    readonly targetId: string
  }): Promise<DurableInteractionIntent> {
    if (!input.clientRequestId.trim()) throw new Error('互动请求必须提供 clientRequestId。')
    const now = this.#timestamp()
    const planned: DurableInteractionIntent = {
      id: `interaction:${input.episode.id}:${this.#nextUlid()}`,
      connectionId: input.connectionId,
      channelId: input.episode.channelId,
      episodeId: input.episode.id,
      agentId: input.episode.agentId,
      clientRequestId: input.clientRequestId,
      kind: input.kind,
      targetId: input.targetId,
      state: 'planned',
      createdAt: now,
      updatedAt: now,
    }
    this.#interactionIntents.set(planned.id, planned)
    await this.#persistInteractionIntents(input.connectionId)
    const sending = { ...planned, state: 'sending' as const, updatedAt: this.#timestamp() }
    this.#interactionIntents.set(sending.id, sending)
    await this.#persistInteractionIntents(input.connectionId)
    return sending
  }

  async #settleInteraction(
    intent: DurableInteractionIntent,
    status: ChannelInteractionStatus,
    message: string,
    outcomes?: readonly { readonly platformMessageId: string; readonly status: string; readonly message?: string }[],
  ): Promise<ChannelInteractionResult> {
    const result: ChannelInteractionResult = {
      intentId: intent.id,
      status,
      message,
      ...(outcomes === undefined ? {} : { outcomes }),
    }
    this.#interactionIntents.set(intent.id, {
      ...intent,
      state: status,
      result: parseJsonValue(result),
      updatedAt: this.#timestamp(),
    })
    await this.#persistInteractionIntents(intent.connectionId)
    return result
  }

  #findInteraction(episode: EpisodeRecord, clientRequestId: string): DurableInteractionIntent | undefined {
    return [...this.#interactionIntents.values()].find(
      (intent) =>
        intent.agentId === episode.agentId &&
        intent.channelId === episode.channelId &&
        intent.clientRequestId === clientRequestId,
    )
  }

  #interactionResult(intent: DurableInteractionIntent): ChannelInteractionResult {
    const result = parseChannelInteractionResult(intent.result)
    if (result) return result
    return {
      intentId: intent.id,
      status: 'unknown',
      message: '该互动请求已经提交但尚未得到确定结果；不会重复执行。',
    }
  }

  async ensureInteractionsLoaded(connectionId: ConnectionId): Promise<void> {
    if (this.#interactionLoadedConnections.has(connectionId) || !this.#adapterState) return
    const existing = this.#loading.get(connectionId)
    if (existing) return existing
    const loading = this.#loadInteractions(connectionId)
      .then(() => {
        this.#interactionLoadedConnections.add(connectionId)
      })
      .finally(() => this.#loading.delete(connectionId))
    this.#loading.set(connectionId, loading)
    return loading
  }

  async #loadInteractions(connectionId: ConnectionId): Promise<void> {
    if (!this.#adapterState) return
    const raw = await this.#adapterState.load(connectionId, INTERACTION_STATE_KEY)
    if (!Array.isArray(raw)) return
    let changed = false
    for (const candidate of raw) {
      let intent = parseInteractionIntent(candidate)
      if (!intent || intent.connectionId !== connectionId) continue
      if (intent.state === 'planned' || intent.state === 'sending') {
        const result: ChannelInteractionResult = {
          intentId: intent.id,
          status: 'unknown',
          message: 'NekroNXT 重启时该互动仍未得到确定回执；不会自动重试。',
        }
        intent = {
          ...intent,
          state: 'unknown',
          result: parseJsonValue(result),
          updatedAt: this.#timestamp(),
        }
        changed = true
      }
      this.#interactionIntents.set(intent.id, intent)
    }
    if (changed) await this.#persistInteractionIntents(connectionId)
  }

  async #persistInteractionIntents(connectionId: ConnectionId): Promise<void> {
    if (!this.#adapterState) return
    const previous = this.#interactionPersistence.get(connectionId) ?? Promise.resolve()
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const intents = [...this.#interactionIntents.values()].filter((intent) => intent.connectionId === connectionId)
        if (intents.length === 0) await this.#adapterState!.clear(connectionId, INTERACTION_STATE_KEY)
        else
          await this.#adapterState!.save(
            connectionId,
            INTERACTION_STATE_KEY,
            parseJsonValue(intents),
            this.#timestamp(),
          )
      })
    this.#interactionPersistence.set(connectionId, next)
    try {
      await next
    } finally {
      if (this.#interactionPersistence.get(connectionId) === next) this.#interactionPersistence.delete(connectionId)
    }
  }
  async #withChannel<T>(channelId: ChannelId, operation: () => Promise<T>): Promise<T> {
    const previous = this.#operations.get(channelId) ?? Promise.resolve()
    const result = previous.then(operation)
    const settled = result.then(
      () => undefined,
      () => undefined,
    )
    this.#operations.set(channelId, settled)
    try {
      return await result
    } finally {
      if (this.#operations.get(channelId) === settled) this.#operations.delete(channelId)
    }
  }
}
