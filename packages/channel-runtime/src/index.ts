import type {
  AdapterConnectionRuntime,
  AdapterDeliveryReceipt,
  AdapterInboundEvent,
  InboundCommitResult,
  PhysicalDeliveryRequest,
} from '@nekro-nxt/adapter-sdk'
import type {
  AdmissionId,
  AgentId,
  AgentRevisionId,
  ChannelEventId,
  ChannelId,
  ConnectionId,
  EpisodeId,
  EpisodeHandoffId,
  JsonValue,
  LogicalMessageId,
  MessagePart,
  OutboundIntentId,
  PhysicalDeliveryId,
} from '@nekro-nxt/contracts'
import {
  AdmissionIdSchema,
  EpisodeHandoffIdSchema,
  EpisodeIdSchema,
  LogicalMessageIdSchema,
  OutboundIntentIdSchema,
  PhysicalDeliveryIdSchema,
} from '@nekro-nxt/contracts'
import type {
  AgentRevisionRecord,
  BindingRecord,
  ChannelEventRecord,
  CoreRepository,
  CoreService,
} from '@nekro-nxt/core'
import { canonicalJson } from '@nekro-nxt/core'
import { monotonicFactory } from 'ulid'

export type EpisodeStatus = 'opening' | 'active' | 'closed' | 'failed'

export interface EpisodeRecord {
  readonly id: EpisodeId
  readonly channelId: ChannelId
  readonly agentId: AgentId
  readonly agentRevisionId: AgentRevisionId
  readonly dshSessionId?: string
  readonly status: EpisodeStatus
  readonly openedAtEventId: ChannelEventId
  readonly lastAdmittedEventId?: ChannelEventId
  readonly closedAtEventId?: ChannelEventId
  readonly closedAt?: number
  readonly closeReason?: EpisodeCloseReason
  readonly createdAt: number
}

export type EpisodeCloseReason =
  | 'manual'
  | 'context-cleared'
  | 'context-compacted'
  | 'idle-timeout'
  | 'incompatible-revision'
  | 'incompatible-activation'
  | 'incompatible-session-storage'
  | 'unrecoverable-session'
  | 'permission-revoked'
  | 'binding-replaced'
  | 'channel-deleted'
  | 'stopped'

export interface EpisodeHandoffRecord {
  readonly id: EpisodeHandoffId
  readonly fromEpisodeId: EpisodeId
  readonly toEpisodeId: EpisodeId
  readonly sourceEventIds: readonly ChannelEventId[]
  /** A deterministic verbatim tail carried across Episode boundaries. */
  readonly recentEventIds: readonly ChannelEventId[]
  readonly summary: string
  readonly provider: string
  readonly model: string
  readonly createdAt: number
}

export type AdmissionState = 'pending' | 'claimed' | 'logged-to-session'

export interface AdmissionRecord {
  readonly id: AdmissionId
  readonly episodeId: EpisodeId
  readonly eventIds: readonly ChannelEventId[]
  readonly mode: 'followup' | 'inject'
  readonly state: AdmissionState
  readonly dshMessageId?: string
  readonly createdAt: number
}

export type OutboundState = 'planned' | 'sending' | 'sent' | 'partially-sent' | 'failed' | 'unknown'

export const ADMIN_CONSOLE_SOURCE_TURN = 'admin-console'

export const isAdminConsoleOutbound = (sourceTurnId: string | undefined): boolean =>
  sourceTurnId === ADMIN_CONSOLE_SOURCE_TURN

export interface ChannelFact {
  readonly channelId: ChannelId
  readonly kind: 'inbound' | 'outbound'
  readonly sourceId: ChannelEventId | OutboundIntentId
}

export interface OutboundIntentRecord {
  readonly id: OutboundIntentId
  readonly logicalMessageId: LogicalMessageId
  readonly agentRevisionId: AgentRevisionId
  readonly episodeId: EpisodeId
  readonly sourceTurnId?: string
  readonly parts: readonly MessagePart[]
  readonly replyTo?: string
  readonly clientRequestId?: string
  readonly state: OutboundState
  readonly createdAt: number
}

export interface PhysicalDeliveryRecord {
  readonly id: PhysicalDeliveryId
  readonly intentId: OutboundIntentId
  readonly sequence: number
  readonly parts: readonly MessagePart[]
  readonly adapterContext?: JsonValue
  readonly state: 'planned' | 'sending' | 'sent' | 'failed' | 'unknown'
  readonly receipt?: AdapterDeliveryReceipt
  readonly completedAt?: number
}

export interface DeliveryReceiptRecord {
  readonly physicalDeliveryId: PhysicalDeliveryId
  readonly receipt: AdapterDeliveryReceipt
  readonly completedAt: number
}

export interface OutboundSnapshot {
  readonly intent: OutboundIntentRecord
  readonly deliveries: readonly PhysicalDeliveryRecord[]
  readonly receipts: readonly DeliveryReceiptRecord[]
}

export interface ChannelHistoryCursor {
  readonly occurredAt: number
  readonly sourceId: string
}

export type ChannelHistoryEntry =
  | {
      readonly source: 'channel-event'
      readonly sourceId: ChannelEventId
      readonly logicalMessageId: LogicalMessageId
      readonly channelId: ChannelId
      readonly occurredAt: number
      readonly senderMemberId?: ChannelEventRecord['senderMemberId']
      readonly parts: readonly MessagePart[]
      readonly facts?: ChannelEventRecord['facts']
    }
  | {
      readonly source: 'outbound-intent'
      readonly sourceId: OutboundIntentId
      readonly logicalMessageId: LogicalMessageId
      readonly channelId: ChannelId
      readonly occurredAt: number
      readonly parts: readonly MessagePart[]
      readonly state: OutboundState
      readonly sourceTurnId?: string
    }

export const isConsoleAnchorHistory = (entry: ChannelHistoryEntry): boolean =>
  entry.source === 'channel-event' && entry.facts?.['consoleAnchor'] === true

export interface ChannelHistorySearchHit {
  readonly entry: ChannelHistoryEntry
  readonly rank: number
}

/** Read-only, Channel-scoped history seam; callers never receive database handles or cross-channel rows. */
export interface ChannelHistoryRepository {
  /** Resolve one logical message only inside the supplied Channel. */
  getChannelHistoryEntryByLogicalMessageId(
    channelId: ChannelId,
    logicalMessageId: LogicalMessageId,
  ): ChannelHistoryEntry | undefined
  listChannelHistory(
    channelId: ChannelId,
    options?: { readonly before?: ChannelHistoryCursor; readonly limit?: number },
  ): readonly ChannelHistoryEntry[]
  /** Project only facts that were admitted or sent by one Episode; results are newest-first. */
  listEpisodeHistory(episodeId: EpisodeId, options?: { readonly limit?: number }): readonly ChannelHistoryEntry[]
  searchChannelHistory(
    channelId: ChannelId,
    query: string,
    options?: { readonly limit?: number },
  ): readonly ChannelHistorySearchHit[]
}

export interface RuntimeRepository {
  getEpisode(id: EpisodeId): EpisodeRecord | undefined
  getActiveEpisode(channelId: ChannelId, agentId: AgentId): EpisodeRecord | undefined
  listRecoverableEpisodes(): readonly EpisodeRecord[]
  listActiveEpisodesForAgent(agentId: AgentId): readonly EpisodeRecord[]
  getEpisodeHandoffTo(episodeId: EpisodeId): EpisodeHandoffRecord | undefined
  createEpisode(record: EpisodeRecord): void
  activateEpisode(id: EpisodeId, dshSessionId: string): EpisodeRecord
  updateEpisodeRevision(
    id: EpisodeId,
    expectedRevisionId: AgentRevisionId,
    targetRevisionId: AgentRevisionId,
  ): EpisodeRecord
  closeEpisode(
    id: EpisodeId,
    reason: EpisodeCloseReason,
    closedAtEventId: ChannelEventId,
    closedAt: number,
  ): EpisodeRecord
  commitEpisodeRollover(input: {
    readonly fromEpisodeId: EpisodeId
    readonly reason: EpisodeCloseReason
    readonly closedAtEventId: ChannelEventId
    readonly closedAt: number
    readonly nextEpisode: EpisodeRecord
    readonly handoff: EpisodeHandoffRecord
  }): void
  failEpisode(id: EpisodeId): void
  createAdmission(record: AdmissionRecord): void
  listRecoverableAdmissions(episodeId: EpisodeId): readonly AdmissionRecord[]
  /** Admitted inbound facts for one Episode, oldest-first within the recent limit. */
  listAdmittedEvents(episodeId: EpisodeId, limit: number): readonly ChannelEventRecord[]
  listUnadmittedEvents(channelId: ChannelId, agentId: AgentId, boundAt: number): readonly ChannelEventRecord[]
  claimAdmission(id: AdmissionId): void
  completeAdmission(id: AdmissionId, dshMessageId: string, eventId: ChannelEventId): void
  findOutboundByClientRequest(
    agentId: AgentId,
    channelId: ChannelId,
    clientRequestId: string,
  ): OutboundSnapshot | undefined
  createOutboundPlan(intent: OutboundIntentRecord, deliveries: readonly PhysicalDeliveryRecord[]): void
  markIntentSending(id: OutboundIntentId): void
  markDeliverySending(id: PhysicalDeliveryId): void
  recordDeliveryReceipt(id: PhysicalDeliveryId, receipt: AdapterDeliveryReceipt, completedAt: number): void
  completeOutboundIntent(id: OutboundIntentId, state: OutboundState): void
  getOutbound(id: OutboundIntentId): OutboundSnapshot
  listUnsettledOutboundIds(): readonly OutboundIntentId[]
}

export interface AgentSessionDriver {
  createSession(input: {
    readonly episodeId: EpisodeId
    readonly channelId: ChannelId
    readonly agentId: AgentId
    readonly agentRevisionId: AgentRevisionId
    readonly handoff?: {
      readonly id: EpisodeHandoffId
      readonly fromEpisodeId: EpisodeId
      readonly sourceEventIds: readonly ChannelEventId[]
      readonly createdAt: number
      readonly provider: string
      readonly model: string
      readonly summary: string
      readonly recentEvents: readonly ChannelEventRecord[]
    }
  }): Promise<string>
  applyCompatibleRevision(input: {
    readonly dshSessionId: string
    readonly episodeId: EpisodeId
    readonly previousRevision: AgentRevisionRecord
    readonly targetRevision: AgentRevisionRecord
  }): Promise<void>
  sessionStatus(dshSessionId: string): 'idle' | 'running'
  findAdmissionMessage(dshSessionId: string, admissionId: AdmissionId): string | undefined
  createHandoffSummary(input: {
    readonly dshSessionId: string
    readonly episode: EpisodeRecord
    readonly revision: AgentRevisionRecord
    readonly sourceEvents: readonly ChannelEventRecord[]
    readonly previousHandoff?: EpisodeHandoffRecord
    readonly generatedAt: number
  }): Promise<{ readonly summary: string; readonly provider: string; readonly model: string }>
  cancelSession(dshSessionId: string, reason: EpisodeCloseReason): Promise<void>
  admit(input: {
    readonly dshSessionId: string
    readonly admissionId: AdmissionId
    readonly events: readonly ChannelEventRecord[]
    readonly mode: 'followup' | 'inject'
  }): Promise<{ readonly dshMessageId: string }>
  notifyConsoleOutbound(input: {
    readonly dshSessionId: string
    readonly channelId: ChannelId
    readonly logicalMessageId: LogicalMessageId
    readonly parts: readonly MessagePart[]
  }): Promise<void>
}

export interface ChannelRuntimeOptions {
  readonly now?: () => number
  readonly nextUlid?: () => string
  readonly resolveAdapter: (connectionId: ConnectionId) => AdapterConnectionRuntime | undefined
  readonly idleRolloverMs?: number | false
}

export type ContextResetMode = 'clear' | 'compact'

export interface ContextResetResult {
  readonly mode: ContextResetMode
  readonly closedEpisode: EpisodeRecord
  readonly nextEpisode?: EpisodeRecord
}

const HANDOFF_RECENT_EVENT_LIMIT = 12

const deterministicHandoffFallback = (
  episode: EpisodeRecord,
  revision: AgentRevisionRecord,
  sourceEvents: readonly ChannelEventRecord[],
): Awaited<ReturnType<AgentSessionDriver['createHandoffSummary']>> => ({
  summary: [
    '模型交接摘要不可用；不要假设旧上下文已经完整恢复。',
    `旧 Episode：${episode.id}`,
    `边界锚点：${sourceEvents.map(({ id }) => id).join(' → ') || '无'}`,
    '需要具体细节时，请使用 conversation_history_search 或 conversation_history_read 回查当前频道原文。',
  ].join('\n'),
  provider: revision.model.provider,
  model: revision.model.model,
})

export interface SendMessageInput {
  readonly episodeId: EpisodeId
  readonly parts: readonly MessagePart[]
  readonly replyTo?: string
  readonly sourceTurnId?: string
  readonly clientRequestId?: string
  readonly signal?: AbortSignal
}

export interface SendMessageResult {
  readonly logicalMessageId: LogicalMessageId
  readonly status: 'sent' | 'partially-sent' | 'failed' | 'unknown'
  readonly receipts: readonly DeliveryReceiptRecord[]
}

export interface RuntimeRecoveryReport {
  readonly resumedEpisodes: number
  readonly recoveredAdmissions: number
  readonly recoveredOutbounds: number
  readonly unknownDeliveries: number
}

const isTriggered = (binding: BindingRecord, event: ChannelEventRecord): boolean => {
  if (event.facts?.['consoleAnchor'] === true) return false
  switch (binding.triggerPolicy) {
    case 'always':
      return true
    case 'observe-only':
      return false
    case 'mentioned-or-replied':
      return event.facts?.['mentionedBot'] === true || event.facts?.['replyToBot'] === true
    case 'command':
      return typeof event.facts?.['command'] === 'string' && event.facts['command'].length > 0
  }
}

const supportsPart = (adapter: AdapterConnectionRuntime, part: MessagePart): boolean => {
  switch (part.type) {
    case 'text':
      return adapter.capabilities.text
    case 'mention':
      return adapter.capabilities.mentions
    case 'image':
      return adapter.capabilities.images
    case 'file':
      return adapter.capabilities.files
    case 'audio':
      return adapter.capabilities.audio
    case 'quote':
      return adapter.capabilities.replies
    case 'rich':
      return false
  }
}

/** Only display-name changes are model/runtime neutral in M1; every other change requires M2 rollover. */
export const isSessionCompatibleRevision = (previous: AgentRevisionRecord, target: AgentRevisionRecord): boolean =>
  previous.agentId === target.agentId &&
  previous.persona === target.persona &&
  previous.model.provider === target.model.provider &&
  previous.model.model === target.model.model &&
  previous.model.reasoningEffort === target.model.reasoningEffort &&
  canonicalJson({ ...previous.capabilities }) === canonicalJson({ ...target.capabilities })

/** Single-lane M1 Runtime. M2 extends the same persisted states with injection and recovery. */
export class ChannelRuntime {
  readonly #core: CoreService
  readonly #coreRepository: CoreRepository
  readonly #runtimeRepository: RuntimeRepository
  readonly #sessionDriver: AgentSessionDriver
  readonly #resolveAdapter: ChannelRuntimeOptions['resolveAdapter']
  readonly #now: () => number
  readonly #nextUlid: () => string
  readonly #idleRolloverMs: number | false
  readonly #lanes = new Map<string, Promise<void>>()
  readonly #factListeners = new Set<(fact: ChannelFact) => void>()

  constructor(
    core: CoreService,
    coreRepository: CoreRepository,
    runtimeRepository: RuntimeRepository,
    sessionDriver: AgentSessionDriver,
    options: ChannelRuntimeOptions,
  ) {
    this.#core = core
    this.#coreRepository = coreRepository
    this.#runtimeRepository = runtimeRepository
    this.#sessionDriver = sessionDriver
    this.#resolveAdapter = options.resolveAdapter
    this.#now = options.now ?? Date.now
    this.#nextUlid = options.nextUlid ?? monotonicFactory()
    this.#idleRolloverMs = options.idleRolloverMs ?? 6 * 60 * 60 * 1000
    if (this.#idleRolloverMs !== false && (!Number.isSafeInteger(this.#idleRolloverMs) || this.#idleRolloverMs <= 0)) {
      throw new TypeError('idleRolloverMs must be a positive integer or false.')
    }
  }

  async acceptInbound(event: AdapterInboundEvent): Promise<InboundCommitResult> {
    const commit = this.#core.appendInbound(event)
    if (commit.inserted) {
      this.#publishFact({ channelId: event.channelId, kind: 'inbound', sourceId: commit.event.id })
      await Promise.all(
        this.#coreRepository
          .listBindings(event.channelId)
          .filter((binding) => {
            if (isTriggered(binding, commit.event)) return true
            const episode = this.#runtimeRepository.getActiveEpisode(binding.channelId, binding.agentId)
            return (
              episode?.dshSessionId !== undefined &&
              this.#sessionDriver.sessionStatus(episode.dshSessionId) === 'running'
            )
          })
          .map((binding) =>
            this.#withLane(binding.channelId, binding.agentId, () => this.#admit(binding, commit.event)),
          ),
      )
    }
    return {
      channelEventId: commit.event.id,
      inserted: commit.inserted,
    }
  }

  subscribeFacts(listener: (fact: ChannelFact) => void): () => void {
    this.#factListeners.add(listener)
    return () => this.#factListeners.delete(listener)
  }

  async replaceBinding(input: {
    readonly channelId: ChannelId
    readonly agentId: AgentId
    readonly triggerPolicy: BindingRecord['triggerPolicy']
  }): Promise<BindingRecord> {
    const current = this.#coreRepository.getBinding(input.channelId)
    const laneAgentId = current?.agentId ?? input.agentId
    return this.#withLane(input.channelId, laneAgentId, async () => {
      if (current !== undefined && current.agentId !== input.agentId) {
        const episode = this.#runtimeRepository.getActiveEpisode(input.channelId, current.agentId)
        if (episode?.dshSessionId !== undefined) {
          await this.#sessionDriver.cancelSession(episode.dshSessionId, 'binding-replaced')
          this.#runtimeRepository.closeEpisode(
            episode.id,
            'binding-replaced',
            episode.lastAdmittedEventId ?? episode.openedAtEventId,
            this.#timestamp(),
          )
        }
      }
      return this.#core.replaceBinding(input)
    })
  }

  async clearBinding(channelId: ChannelId): Promise<void> {
    const current = this.#coreRepository.getBinding(channelId)
    if (!current) return
    await this.#withLane(channelId, current.agentId, async () => {
      const episode = this.#runtimeRepository.getActiveEpisode(channelId, current.agentId)
      if (episode?.status === 'active' && episode.dshSessionId !== undefined) {
        await this.#sessionDriver.cancelSession(episode.dshSessionId, 'stopped')
        this.#runtimeRepository.closeEpisode(
          episode.id,
          'stopped',
          episode.lastAdmittedEventId ?? episode.openedAtEventId,
          this.#timestamp(),
        )
      }
      this.#core.clearBinding(channelId)
    })
  }

  /** Stops the live lane before removing a Channel from active product state. */
  async deleteChannel(channelId: ChannelId): Promise<void> {
    if (!this.#coreRepository.getChannel(channelId)) throw new Error(`Unknown channel: ${channelId}`)
    const current = this.#coreRepository.getBinding(channelId)
    if (!current) {
      this.#core.deleteChannel(channelId)
      return
    }
    await this.#withLane(channelId, current.agentId, async () => {
      const episode = this.#runtimeRepository.getActiveEpisode(channelId, current.agentId)
      if (episode?.dshSessionId !== undefined) {
        await this.#sessionDriver.cancelSession(episode.dshSessionId, 'channel-deleted')
      }
      if (episode !== undefined) {
        this.#runtimeRepository.closeEpisode(
          episode.id,
          'channel-deleted',
          episode.lastAdmittedEventId ?? episode.openedAtEventId,
          this.#timestamp(),
        )
      }
      this.#core.deleteChannel(channelId)
    })
  }

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    const episode = this.#runtimeRepository.getEpisode(input.episodeId)
    if (!episode || episode.status !== 'active') throw new Error(`Unknown or inactive Episode: ${input.episodeId}`)
    const channel = this.#coreRepository.getChannel(episode.channelId)
    if (!channel) throw new Error(`Episode channel no longer exists: ${episode.channelId}`)
    const adapter = this.#resolveAdapter(channel.connectionId)
    if (!adapter) throw new Error(`Connection adapter is not running: ${channel.connectionId}`)
    if (input.parts.length === 0) throw new Error('send_channel_message requires at least one content part.')
    for (const part of input.parts) {
      if (!supportsPart(adapter, part)) throw new Error(`Adapter does not support message part: ${part.type}`)
    }

    if (input.clientRequestId !== undefined) {
      const existing = this.#runtimeRepository.findOutboundByClientRequest(
        episode.agentId,
        episode.channelId,
        input.clientRequestId,
      )
      if (existing) return this.#sendResult(existing)
    }

    const intentId = OutboundIntentIdSchema.parse(`out_${this.#nextUlid()}`)
    const logicalMessageId = LogicalMessageIdSchema.parse(`msg_${this.#nextUlid()}`)
    const plans = adapter.planOutbound
      ? await adapter.planOutbound({
          connectionId: channel.connectionId,
          channelId: channel.id,
          parts: input.parts,
          ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
        })
      : adapter.capabilities.mixedContent
        ? [{ parts: input.parts }]
        : input.parts.map((part) => ({ parts: [part] }))
    if (plans.length === 0 || plans.some(({ parts }) => parts.length === 0)) {
      throw new Error('Adapter outbound planner returned an empty PhysicalDelivery.')
    }
    for (const { parts } of plans) {
      for (const part of parts) {
        if (!supportsPart(adapter, part)) throw new Error(`Adapter planner produced an unsupported part: ${part.type}`)
        if (
          part.type === 'text' &&
          adapter.capabilities.maxTextLength !== undefined &&
          [...part.text].length > adapter.capabilities.maxTextLength
        ) {
          throw new Error('Adapter outbound planner produced over-limit text.')
        }
      }
    }
    const intent: OutboundIntentRecord = {
      id: intentId,
      logicalMessageId,
      agentRevisionId: episode.agentRevisionId,
      episodeId: episode.id,
      ...(input.sourceTurnId === undefined ? {} : { sourceTurnId: input.sourceTurnId }),
      parts: input.parts,
      ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
      ...(input.clientRequestId === undefined ? {} : { clientRequestId: input.clientRequestId }),
      state: 'planned',
      createdAt: this.#timestamp(),
    }
    const deliveries: PhysicalDeliveryRecord[] = plans.map(({ parts, adapterContext }, sequence) => ({
      id: PhysicalDeliveryIdSchema.parse(`phy_${this.#nextUlid()}`),
      intentId,
      sequence,
      parts,
      ...(adapterContext === undefined ? {} : { adapterContext }),
      state: 'planned',
    }))
    this.#runtimeRepository.createOutboundPlan(intent, deliveries)
    this.#publishFact({ channelId: channel.id, kind: 'outbound', sourceId: intent.id })
    const settled = await this.#dispatchOutbound(intent.id, input.signal ?? new AbortController().signal)
    return this.#sendResult(settled.snapshot)
  }

  async sendAdminConsoleMessage(input: {
    readonly channelId: ChannelId
    readonly parts: readonly MessagePart[]
    readonly clientRequestId?: string
    readonly signal?: AbortSignal
  }): Promise<SendMessageResult> {
    const channel = this.#coreRepository.getChannel(input.channelId)
    if (!channel) throw new Error(`Unknown channel: ${input.channelId}`)
    if (channel.kind === 'web') {
      throw new Error('Web channels accept inbound conversation, not robot-account delivery.')
    }
    const binding = this.#coreRepository.getBinding(channel.id)
    if (!binding) throw new Error('Channel has no Binding.')
    const adapter = this.#resolveAdapter(channel.connectionId)
    if (!adapter) throw new Error(`Connection adapter is not running: ${channel.connectionId}`)
    if (!adapter.capabilities.proactiveSend) {
      throw new Error('Adapter does not allow proactive send.')
    }
    return this.#withLane(channel.id, binding.agentId, async () => {
      const openedAt = this.#consoleOpenedAtEvent(channel)
      const episode = await this.#ensureActiveEpisode(binding, openedAt)
      const result = await this.sendMessage({
        episodeId: episode.id,
        parts: input.parts,
        sourceTurnId: ADMIN_CONSOLE_SOURCE_TURN,
        ...(input.clientRequestId === undefined ? {} : { clientRequestId: input.clientRequestId }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })
      if (
        episode.dshSessionId &&
        (result.status === 'sent' || result.status === 'partially-sent' || result.status === 'unknown')
      ) {
        await this.#sessionDriver.notifyConsoleOutbound({
          dshSessionId: episode.dshSessionId,
          channelId: channel.id,
          logicalMessageId: result.logicalMessageId,
          parts: input.parts,
        })
      }
      return result
    })
  }

  async recover(): Promise<RuntimeRecoveryReport> {
    const report = {
      resumedEpisodes: 0,
      recoveredAdmissions: 0,
      recoveredOutbounds: 0,
      unknownDeliveries: 0,
    }
    for (const recoverable of this.#runtimeRepository.listRecoverableEpisodes()) {
      await this.#withLane(recoverable.channelId, recoverable.agentId, async () => {
        let episode = recoverable
        const handoff = this.#runtimeRepository.getEpisodeHandoffTo(episode.id)
        const recoverableAdmissions = this.#runtimeRepository.listRecoverableAdmissions(episode.id)
        if (episode.status === 'opening' && handoff !== undefined) {
          const previous = this.#runtimeRepository.getEpisode(handoff.fromEpisodeId)
          if (previous?.dshSessionId !== undefined) {
            await this.#sessionDriver.cancelSession(previous.dshSessionId, previous.closeReason ?? 'manual')
          }
        }
        const recentEvents =
          handoff?.recentEventIds
            .map((eventId) => this.#coreRepository.getChannelEvent(eventId))
            .filter((event): event is ChannelEventRecord => event !== undefined) ?? []
        const dshSessionId = await this.#sessionDriver.createSession({
          episodeId: episode.id,
          channelId: episode.channelId,
          agentId: episode.agentId,
          agentRevisionId: episode.agentRevisionId,
          ...(handoff === undefined
            ? {}
            : {
                handoff: {
                  id: handoff.id,
                  fromEpisodeId: handoff.fromEpisodeId,
                  sourceEventIds: handoff.sourceEventIds,
                  createdAt: handoff.createdAt,
                  provider: handoff.provider,
                  model: handoff.model,
                  summary: handoff.summary,
                  recentEvents,
                },
              }),
        })
        if (episode.status === 'opening') episode = this.#runtimeRepository.activateEpisode(episode.id, dshSessionId)
        else if (episode.dshSessionId !== dshSessionId) {
          throw new Error(`Recovered DSH Session identity changed for Episode ${episode.id}.`)
        }
        report.resumedEpisodes += 1

        for (const admission of recoverableAdmissions) {
          if (admission.state === 'pending') this.#runtimeRepository.claimAdmission(admission.id)
          const existing = this.#sessionDriver.findAdmissionMessage(dshSessionId, admission.id)
          const lastEventId = admission.eventIds.at(-1)
          if (!lastEventId) throw new Error(`Recoverable Admission has no Channel Events: ${admission.id}`)
          if (existing) {
            this.#runtimeRepository.completeAdmission(admission.id, existing, lastEventId)
            report.recoveredAdmissions += 1
            continue
          }
          const events = admission.eventIds.map((id) => {
            const event = this.#coreRepository.getChannelEvent(id)
            if (!event) throw new Error(`Admission references a missing Channel Event: ${id}`)
            return event
          })
          const result = await this.#sessionDriver.admit({
            dshSessionId,
            admissionId: admission.id,
            events,
            mode: admission.mode,
          })
          this.#runtimeRepository.completeAdmission(admission.id, result.dshMessageId, lastEventId)
          report.recoveredAdmissions += 1
        }
        await this.#recoverTriggeredBacklog(episode.channelId, episode.agentId)
      })
    }

    for (const outboundId of this.#runtimeRepository.listUnsettledOutboundIds()) {
      const result = await this.#dispatchOutbound(outboundId, new AbortController().signal)
      report.recoveredOutbounds += 1
      report.unknownDeliveries += result.unknownDeliveries
    }
    return report
  }

  async stopEpisode(
    episodeId: EpisodeId,
    reason: Extract<EpisodeCloseReason, 'permission-revoked' | 'stopped'> = 'stopped',
  ): Promise<EpisodeRecord> {
    const initial = this.#runtimeRepository.getEpisode(episodeId)
    if (!initial) throw new Error(`Unknown Episode: ${episodeId}`)
    return this.#withLane(initial.channelId, initial.agentId, async () => {
      const episode = this.#runtimeRepository.getEpisode(episodeId)
      if (!episode || episode.status !== 'active' || !episode.dshSessionId) {
        throw new Error(`Episode is not active: ${episodeId}`)
      }
      await this.#sessionDriver.cancelSession(episode.dshSessionId, reason)
      return this.#runtimeRepository.closeEpisode(
        episode.id,
        reason,
        episode.lastAdmittedEventId ?? episode.openedAtEventId,
        this.#timestamp(),
      )
    })
  }

  async rolloverEpisode(episodeId: EpisodeId): Promise<EpisodeRecord> {
    return this.#rolloverEpisodeWithReason(episodeId, 'manual')
  }

  /**
   * Immediately cancels the current run, then either closes without handoff or
   * opens a compacted handoff Episode. Channel facts remain durable and future
   * admissions wait behind this lane boundary.
   */
  async resetEpisode(episodeId: EpisodeId, mode: ContextResetMode): Promise<ContextResetResult> {
    const initial = this.#runtimeRepository.getEpisode(episodeId)
    if (!initial) throw new Error(`Unknown Episode: ${episodeId}`)
    return this.#withLane(initial.channelId, initial.agentId, async () => {
      const episode = this.#runtimeRepository.getEpisode(episodeId)
      if (!episode || episode.status !== 'active' || !episode.dshSessionId) {
        throw new Error(`Episode is not active: ${episodeId}`)
      }
      const binding = this.#coreRepository.getBinding(episode.channelId)
      if (!binding || binding.agentId !== episode.agentId) throw new Error('Episode Binding no longer exists.')
      const anchorId = episode.lastAdmittedEventId ?? episode.openedAtEventId
      const anchor = this.#coreRepository.getChannelEvent(anchorId)
      if (!anchor) throw new Error(`Episode anchor Event no longer exists: ${anchorId}`)
      const reason = mode === 'clear' ? 'context-cleared' : 'context-compacted'

      await this.#sessionDriver.cancelSession(episode.dshSessionId, reason)
      if (mode === 'clear') {
        return {
          mode,
          closedEpisode: this.#runtimeRepository.closeEpisode(episode.id, reason, anchorId, this.#timestamp()),
        }
      }

      const sourceEvents = [
        ...new Map(
          [
            this.#coreRepository.getChannelEvent(episode.openedAtEventId),
            episode.lastAdmittedEventId === undefined
              ? undefined
              : this.#coreRepository.getChannelEvent(episode.lastAdmittedEventId),
          ]
            .filter((sourceEvent): sourceEvent is ChannelEventRecord => sourceEvent !== undefined)
            .map((sourceEvent) => [sourceEvent.id, sourceEvent]),
        ).values(),
      ]
      const recentEvents = this.#runtimeRepository.listAdmittedEvents(episode.id, HANDOFF_RECENT_EVENT_LIMIT)
      const previousHandoff = this.#runtimeRepository.getEpisodeHandoffTo(episode.id)
      const handoffCreatedAt = this.#timestamp()
      const previousRevision = this.#coreRepository.getAgentRevision(episode.agentRevisionId)
      if (!previousRevision) throw new Error(`Episode Agent Revision no longer exists: ${episode.agentRevisionId}`)
      let summary = deterministicHandoffFallback(episode, previousRevision, sourceEvents)
      try {
        summary = await this.#sessionDriver.createHandoffSummary({
          dshSessionId: episode.dshSessionId,
          episode,
          revision: previousRevision,
          sourceEvents,
          ...(previousHandoff === undefined ? {} : { previousHandoff }),
          generatedAt: handoffCreatedAt,
        })
      } catch {
        // Reset must recover even when the independent summary request fails.
      }
      const current = this.#coreRepository.getAgent(episode.agentId)
      if (!current) throw new Error(`Episode agent no longer exists: ${episode.agentId}`)
      const nextEpisode: EpisodeRecord = {
        id: EpisodeIdSchema.parse(`eps_${this.#nextUlid()}`),
        channelId: episode.channelId,
        agentId: episode.agentId,
        agentRevisionId: current.revision.id,
        status: 'opening',
        openedAtEventId: anchorId,
        createdAt: this.#timestamp(),
      }
      const handoff: EpisodeHandoffRecord = {
        id: EpisodeHandoffIdSchema.parse(`hof_${this.#nextUlid()}`),
        fromEpisodeId: episode.id,
        toEpisodeId: nextEpisode.id,
        sourceEventIds: sourceEvents.map(({ id }) => id),
        recentEventIds: recentEvents.map(({ id }) => id),
        summary: summary.summary,
        provider: summary.provider,
        model: summary.model,
        createdAt: handoffCreatedAt,
      }
      this.#runtimeRepository.commitEpisodeRollover({
        fromEpisodeId: episode.id,
        reason,
        closedAtEventId: anchorId,
        closedAt: this.#timestamp(),
        nextEpisode,
        handoff,
      })
      const dshSessionId = await this.#sessionDriver.createSession({
        episodeId: nextEpisode.id,
        channelId: nextEpisode.channelId,
        agentId: nextEpisode.agentId,
        agentRevisionId: nextEpisode.agentRevisionId,
        handoff: {
          id: handoff.id,
          fromEpisodeId: handoff.fromEpisodeId,
          sourceEventIds: handoff.sourceEventIds,
          createdAt: handoff.createdAt,
          provider: handoff.provider,
          model: handoff.model,
          summary: handoff.summary,
          recentEvents,
        },
      })
      const closedEpisode = this.#runtimeRepository.getEpisode(episode.id)
      if (!closedEpisode) throw new Error(`Closed Episode no longer exists: ${episode.id}`)
      return {
        mode,
        closedEpisode,
        nextEpisode: this.#runtimeRepository.activateEpisode(nextEpisode.id, dshSessionId),
      }
    })
  }

  async rolloverAgentActivations(agentId: AgentId): Promise<readonly EpisodeRecord[]> {
    const episodeIds = this.#runtimeRepository.listActiveEpisodesForAgent(agentId).map(({ id }) => id)
    return Promise.all(
      episodeIds.map((episodeId) => this.#rolloverEpisodeWithReason(episodeId, 'incompatible-activation')),
    )
  }

  async #rolloverEpisodeWithReason(
    episodeId: EpisodeId,
    reason: 'manual' | 'incompatible-activation',
  ): Promise<EpisodeRecord> {
    const initial = this.#runtimeRepository.getEpisode(episodeId)
    if (!initial) throw new Error(`Unknown Episode: ${episodeId}`)
    return this.#withLane(initial.channelId, initial.agentId, async () => {
      const episode = this.#runtimeRepository.getEpisode(episodeId)
      if (!episode || episode.status !== 'active' || !episode.dshSessionId) {
        throw new Error(`Episode is not active: ${episodeId}`)
      }
      const binding = this.#coreRepository.getBinding(episode.channelId)
      if (!binding || binding.agentId !== episode.agentId) throw new Error(`Episode Binding no longer exists.`)
      const anchorId = episode.lastAdmittedEventId ?? episode.openedAtEventId
      const anchor = this.#coreRepository.getChannelEvent(anchorId)
      if (!anchor) throw new Error(`Episode anchor Event no longer exists: ${anchorId}`)
      return this.#rolloverIfNeeded(episode, anchor, reason)
    })
  }

  #consoleOpenedAtEvent(channel: { readonly id: ChannelId; readonly connectionId: ConnectionId }): ChannelEventRecord {
    const latest = this.#coreRepository.listChannelEvents(channel.id, { limit: 1 })[0]
    if (latest) return latest
    const connection = this.#coreRepository.getConnection(channel.connectionId)
    if (!connection) throw new Error(`Channel connection no longer exists: ${channel.connectionId}`)
    const now = this.#timestamp()
    return this.#core.appendInbound({
      connectionId: channel.connectionId,
      channelId: channel.id,
      adapterKey: connection.adapterKey,
      kind: 'control',
      parts: [],
      platformTimestamp: now,
      receivedAt: now,
      dedupeKey: `console-anchor:${channel.id}:${now}`,
      facts: { consoleAnchor: true },
    }).event
  }

  async #ensureActiveEpisode(binding: BindingRecord, openedAtEvent: ChannelEventRecord): Promise<EpisodeRecord> {
    const current = this.#runtimeRepository.getActiveEpisode(binding.channelId, binding.agentId)
    if (current) {
      if (current.status === 'active' && current.dshSessionId !== undefined) return current
      throw new Error(`Episode is not ready: ${current.id}`)
    }
    const agent = this.#coreRepository.getAgent(binding.agentId)
    if (!agent) throw new Error(`Binding agent no longer exists: ${binding.agentId}`)
    const opening: EpisodeRecord = {
      id: EpisodeIdSchema.parse(`eps_${this.#nextUlid()}`),
      channelId: binding.channelId,
      agentId: binding.agentId,
      agentRevisionId: agent.revision.id,
      status: 'opening',
      openedAtEventId: openedAtEvent.id,
      createdAt: this.#timestamp(),
    }
    this.#runtimeRepository.createEpisode(opening)
    try {
      const dshSessionId = await this.#sessionDriver.createSession({
        episodeId: opening.id,
        channelId: opening.channelId,
        agentId: opening.agentId,
        agentRevisionId: opening.agentRevisionId,
      })
      return this.#runtimeRepository.activateEpisode(opening.id, dshSessionId)
    } catch (error) {
      this.#runtimeRepository.failEpisode(opening.id)
      throw error
    }
  }

  async #admit(binding: BindingRecord, event: ChannelEventRecord): Promise<void> {
    let episode = await this.#ensureActiveEpisode(binding, event)
    if (episode.status !== 'active' || episode.dshSessionId === undefined) {
      throw new Error(`Episode is not ready for admission: ${episode.id}`)
    }
    episode = await this.#rolloverIfNeeded(episode, event)
    episode = await this.#applyCurrentCompatibleRevision(episode)
    const dshSessionId = episode.dshSessionId
    if (dshSessionId === undefined) throw new Error(`Episode has no DSH Session after revision switch: ${episode.id}`)
    const candidateEvents = this.#candidateTriggeredEvents(binding, event)
    const existingAdmission = this.#runtimeRepository
      .listRecoverableAdmissions(episode.id)
      .find((candidate) => candidate.eventIds.includes(event.id))
    const admissionId = existingAdmission?.id ?? AdmissionIdSchema.parse(`adm_${this.#nextUlid()}`)
    if (existingAdmission === undefined) {
      this.#runtimeRepository.createAdmission({
        id: admissionId,
        episodeId: episode.id,
        eventIds: candidateEvents.map(({ id }) => id),
        mode: this.#sessionDriver.sessionStatus(dshSessionId) === 'running' ? 'inject' : 'followup',
        state: 'pending',
        createdAt: this.#timestamp(),
      })
    }
    const admission = this.#runtimeRepository
      .listRecoverableAdmissions(episode.id)
      .find((candidate) => candidate.id === admissionId)
    if (!admission) throw new Error(`Admission was not persisted in target Episode: ${admissionId}`)
    this.#runtimeRepository.claimAdmission(admission.id)
    const result = await this.#sessionDriver.admit({
      dshSessionId,
      admissionId: admission.id,
      events: admission.eventIds.map((eventId) => {
        const candidate = this.#coreRepository.getChannelEvent(eventId)
        if (!candidate) throw new Error(`Admission references a missing Channel Event: ${eventId}`)
        return candidate
      }),
      mode: admission.mode,
    })
    const lastEventId = admission.eventIds.at(-1)
    if (lastEventId === undefined) throw new Error(`Admission has no events: ${admission.id}`)
    this.#runtimeRepository.completeAdmission(admission.id, result.dshMessageId, lastEventId)
  }

  #candidateTriggeredEvents(binding: BindingRecord, current: ChannelEventRecord): readonly ChannelEventRecord[] {
    const candidates = this.#runtimeRepository.listUnadmittedEvents(binding.channelId, binding.agentId, binding.boundAt)
    return candidates.some(({ id }) => id === current.id) ? candidates : [...candidates, current]
  }

  async #recoverTriggeredBacklog(channelId: ChannelId, agentId: AgentId): Promise<void> {
    const binding = this.#coreRepository.getBinding(channelId)
    const episode = this.#runtimeRepository.getActiveEpisode(channelId, agentId)
    if (!binding || !episode) return
    const events = this.#runtimeRepository.listUnadmittedEvents(channelId, agentId, binding.boundAt)
    for (const event of events) {
      if (isTriggered(binding, event)) {
        await this.#admit(binding, event)
      }
    }
  }

  async #rolloverIfNeeded(
    episode: EpisodeRecord,
    event: ChannelEventRecord,
    forcedReason?: EpisodeCloseReason,
  ): Promise<EpisodeRecord> {
    const current = this.#coreRepository.getAgent(episode.agentId)
    if (!current) throw new Error(`Episode agent no longer exists: ${episode.agentId}`)
    const previousRevision = this.#coreRepository.getAgentRevision(episode.agentRevisionId)
    if (!previousRevision) throw new Error(`Episode Agent Revision no longer exists: ${episode.agentRevisionId}`)
    let reason: EpisodeCloseReason | undefined = forcedReason
    if (reason === undefined && !isSessionCompatibleRevision(previousRevision, current.revision)) {
      reason = 'incompatible-revision'
    }
    if (reason === undefined && this.#idleRolloverMs !== false && episode.lastAdmittedEventId !== undefined) {
      const lastEvent = this.#coreRepository.getChannelEvent(episode.lastAdmittedEventId)
      if (!lastEvent) throw new Error(`Episode last admitted Event no longer exists: ${episode.lastAdmittedEventId}`)
      if (event.receivedAt - lastEvent.receivedAt >= this.#idleRolloverMs) reason = 'idle-timeout'
    }
    if (reason === undefined) return episode
    if (!episode.dshSessionId) throw new Error(`Episode has no DSH Session for rollover: ${episode.id}`)

    const sourceEvents = [
      ...new Map(
        [
          this.#coreRepository.getChannelEvent(episode.openedAtEventId),
          episode.lastAdmittedEventId === undefined
            ? undefined
            : this.#coreRepository.getChannelEvent(episode.lastAdmittedEventId),
        ]
          .filter((sourceEvent): sourceEvent is ChannelEventRecord => sourceEvent !== undefined)
          .map((sourceEvent) => [sourceEvent.id, sourceEvent]),
      ).values(),
    ]
    const recentEvents = this.#runtimeRepository.listAdmittedEvents(episode.id, HANDOFF_RECENT_EVENT_LIMIT)
    const previousHandoff = this.#runtimeRepository.getEpisodeHandoffTo(episode.id)
    const handoffCreatedAt = this.#timestamp()
    let summary = deterministicHandoffFallback(episode, previousRevision, sourceEvents)
    try {
      summary = await this.#sessionDriver.createHandoffSummary({
        dshSessionId: episode.dshSessionId,
        episode,
        revision: previousRevision,
        sourceEvents,
        ...(previousHandoff === undefined ? {} : { previousHandoff }),
        generatedAt: handoffCreatedAt,
      })
    } catch {
      // A handoff is advisory. Summary generation and projection failures must not block the Session switch.
    }

    const nextEpisode: EpisodeRecord = {
      id: EpisodeIdSchema.parse(`eps_${this.#nextUlid()}`),
      channelId: episode.channelId,
      agentId: episode.agentId,
      agentRevisionId: current.revision.id,
      status: 'opening',
      openedAtEventId: event.id,
      createdAt: this.#timestamp(),
    }
    const handoff: EpisodeHandoffRecord = {
      id: EpisodeHandoffIdSchema.parse(`hof_${this.#nextUlid()}`),
      fromEpisodeId: episode.id,
      toEpisodeId: nextEpisode.id,
      sourceEventIds: sourceEvents.map(({ id }) => id),
      recentEventIds: recentEvents.map(({ id }) => id),
      summary: summary.summary,
      provider: summary.provider,
      model: summary.model,
      createdAt: handoffCreatedAt,
    }
    const closedAtEventId = episode.lastAdmittedEventId ?? episode.openedAtEventId
    this.#runtimeRepository.commitEpisodeRollover({
      fromEpisodeId: episode.id,
      reason,
      closedAtEventId,
      closedAt: this.#timestamp(),
      nextEpisode,
      handoff,
    })
    await this.#sessionDriver.cancelSession(episode.dshSessionId, reason)
    const dshSessionId = await this.#sessionDriver.createSession({
      episodeId: nextEpisode.id,
      channelId: nextEpisode.channelId,
      agentId: nextEpisode.agentId,
      agentRevisionId: nextEpisode.agentRevisionId,
      handoff: {
        id: handoff.id,
        fromEpisodeId: handoff.fromEpisodeId,
        sourceEventIds: handoff.sourceEventIds,
        createdAt: handoff.createdAt,
        provider: handoff.provider,
        model: handoff.model,
        summary: handoff.summary,
        recentEvents,
      },
    })
    return this.#runtimeRepository.activateEpisode(nextEpisode.id, dshSessionId)
  }

  async #applyCurrentCompatibleRevision(episode: EpisodeRecord): Promise<EpisodeRecord> {
    const current = this.#coreRepository.getAgent(episode.agentId)
    if (!current) throw new Error(`Episode agent no longer exists: ${episode.agentId}`)
    if (current.revision.id === episode.agentRevisionId) return episode
    const previous = this.#coreRepository.getAgentRevision(episode.agentRevisionId)
    if (!previous) throw new Error(`Episode Agent Revision no longer exists: ${episode.agentRevisionId}`)
    if (!isSessionCompatibleRevision(previous, current.revision)) {
      throw new Error(
        `Episode ${episode.id} requires rollover before Agent Revision ${current.revision.id} can be admitted.`,
      )
    }
    if (!episode.dshSessionId) throw new Error(`Episode has no DSH Session: ${episode.id}`)
    await this.#sessionDriver.applyCompatibleRevision({
      dshSessionId: episode.dshSessionId,
      episodeId: episode.id,
      previousRevision: previous,
      targetRevision: current.revision,
    })
    return this.#runtimeRepository.updateEpisodeRevision(episode.id, episode.agentRevisionId, current.revision.id)
  }

  async #dispatchOutbound(
    id: OutboundIntentId,
    signal: AbortSignal,
  ): Promise<{ readonly snapshot: OutboundSnapshot; readonly unknownDeliveries: number }> {
    let snapshot = this.#runtimeRepository.getOutbound(id)
    const episode = this.#runtimeRepository.getEpisode(snapshot.intent.episodeId)
    if (!episode) throw new Error(`Outbound Episode no longer exists: ${snapshot.intent.episodeId}`)
    const channel = this.#coreRepository.getChannel(episode.channelId)
    if (!channel) throw new Error(`Outbound channel no longer exists: ${episode.channelId}`)
    const adapter = this.#resolveAdapter(channel.connectionId)
    if (!adapter) throw new Error(`Connection adapter is not running: ${channel.connectionId}`)
    if (snapshot.intent.state === 'planned') {
      this.#runtimeRepository.markIntentSending(id)
      snapshot = this.#runtimeRepository.getOutbound(id)
    }
    if (snapshot.intent.state !== 'sending') return { snapshot, unknownDeliveries: 0 }

    let unknownDeliveries = 0
    for (const delivery of snapshot.deliveries) {
      if (delivery.state === 'sending') {
        this.#runtimeRepository.recordDeliveryReceipt(
          delivery.id,
          {
            status: 'unknown',
            message: 'Host restarted after dispatch began and before an authoritative receipt was committed.',
          },
          this.#timestamp(),
        )
        unknownDeliveries += 1
        continue
      }
      if (delivery.state !== 'planned') continue
      this.#runtimeRepository.markDeliverySending(delivery.id)
      let receipt: AdapterDeliveryReceipt
      try {
        const request: PhysicalDeliveryRequest = {
          deliveryId: delivery.id,
          logicalMessageId: snapshot.intent.logicalMessageId,
          connectionId: channel.connectionId,
          channelId: channel.id,
          parts: delivery.parts,
          ...(snapshot.intent.replyTo === undefined ? {} : { replyTo: snapshot.intent.replyTo }),
          ...(delivery.adapterContext === undefined ? {} : { adapterContext: delivery.adapterContext }),
        }
        receipt = await adapter.deliver(request, signal)
      } catch (error) {
        receipt = {
          status: 'unknown',
          message: `Adapter delivery threw before an authoritative receipt: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
      this.#runtimeRepository.recordDeliveryReceipt(delivery.id, receipt, this.#timestamp())
    }
    const state = this.#aggregate(this.#runtimeRepository.getOutbound(id).receipts)
    this.#runtimeRepository.completeOutboundIntent(id, state)
    this.#publishFact({ channelId: channel.id, kind: 'outbound', sourceId: id })
    return { snapshot: this.#runtimeRepository.getOutbound(id), unknownDeliveries }
  }

  #publishFact(fact: ChannelFact): void {
    for (const listener of this.#factListeners) {
      try {
        listener(fact)
      } catch {
        // A projection listener must never roll back an already committed fact.
      }
    }
  }

  #aggregate(receipts: readonly DeliveryReceiptRecord[]): OutboundState {
    const statuses = receipts.map(({ receipt }) => receipt.status)
    const sent = statuses.filter((status) => status === 'sent').length
    if (sent === statuses.length) return 'sent'
    if (sent > 0) return 'partially-sent'
    if (statuses.includes('unknown')) return 'unknown'
    return 'failed'
  }

  #sendResult(snapshot: OutboundSnapshot): SendMessageResult {
    const status = snapshot.intent.state
    switch (status) {
      case 'sent':
      case 'partially-sent':
      case 'failed':
      case 'unknown':
        return {
          logicalMessageId: snapshot.intent.logicalMessageId,
          status,
          receipts: snapshot.receipts,
        }
      case 'planned':
      case 'sending':
        throw new Error(`Outbound intent has not settled: ${snapshot.intent.id}`)
    }
  }

  async #withLane<T>(channelId: ChannelId, agentId: AgentId, operation: () => Promise<T>): Promise<T> {
    const key = `${channelId}\u0000${agentId}`
    const previous = this.#lanes.get(key) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.catch(() => undefined).then(() => gate)
    this.#lanes.set(key, tail)
    await previous.catch(() => undefined)
    try {
      return await operation()
    } finally {
      release()
      if (this.#lanes.get(key) === tail) this.#lanes.delete(key)
    }
  }

  #timestamp(): number {
    const value = this.#now()
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Clock must return a non-negative integer.')
    return value
  }
}

export { isTriggered }
