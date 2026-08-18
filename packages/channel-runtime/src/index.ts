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
  DeliveryReceiptId,
  EpisodeId,
  EpisodeHandoffId,
  JsonValue,
  LogicalMessageId,
  MessagePart,
  OutboundIntentId,
  PhysicalDeliveryId,
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

export type EpisodeStatus = 'opening' | 'active' | 'rolling-over' | 'closed' | 'failed'

export interface EpisodeRecord {
  readonly id: EpisodeId
  readonly channelId: ChannelId
  readonly agentId: AgentId
  readonly agentRevisionId: AgentRevisionId
  readonly bindingId: BindingRecord['id']
  readonly bindingRevision: number
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
  | 'idle-timeout'
  | 'incompatible-revision'
  | 'incompatible-activation'
  | 'unrecoverable-session'
  | 'permission-revoked'
  | 'stopped'

export interface EpisodeHandoffRecord {
  readonly id: EpisodeHandoffId
  readonly fromEpisodeId: EpisodeId
  readonly toEpisodeId: EpisodeId
  readonly sourceEventIds: readonly ChannelEventId[]
  readonly summary: string
  readonly provider: string
  readonly model: string
  readonly createdAt: number
}

export type AdmissionState = 'pending' | 'claimed' | 'logged-to-session' | 'rejected'

export interface AdmissionRecord {
  readonly id: AdmissionId
  readonly episodeId: EpisodeId
  readonly channelEventIds: readonly ChannelEventId[]
  readonly reason: 'trigger' | 'running-injection' | 'recovery'
  readonly state: AdmissionState
  readonly dshMessageId?: string
  readonly createdAt: number
  readonly claimedAt?: number
  readonly loggedAt?: number
}

export type OutboundState = 'planned' | 'sending' | 'sent' | 'partially-sent' | 'failed' | 'unknown'

export interface OutboundIntentRecord {
  readonly id: OutboundIntentId
  readonly logicalMessageId: LogicalMessageId
  readonly agentId: AgentId
  readonly agentRevisionId: AgentRevisionId
  readonly episodeId: EpisodeId
  readonly sourceTurnId?: string
  readonly channelId: ChannelId
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
  readonly attemptCount: number
}

export interface DeliveryReceiptRecord {
  readonly id: DeliveryReceiptId
  readonly physicalDeliveryId: PhysicalDeliveryId
  readonly attempt: number
  readonly receipt: AdapterDeliveryReceipt
  readonly createdAt: number
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
    }

export interface ChannelHistorySearchHit {
  readonly entry: ChannelHistoryEntry
  readonly rank: number
}

/** Read-only, Channel-scoped history seam; callers never receive database handles or cross-channel rows. */
export interface ChannelHistoryRepository {
  listChannelHistory(
    channelId: ChannelId,
    options?: { readonly before?: ChannelHistoryCursor; readonly limit?: number },
  ): readonly ChannelHistoryEntry[]
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
  beginEpisodeRollover(id: EpisodeId): EpisodeRecord
  cancelEpisodeRollover(id: EpisodeId): EpisodeRecord
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
  claimAdmission(id: AdmissionId, claimedAt: number): void
  completeAdmission(id: AdmissionId, dshMessageId: string, eventId: ChannelEventId, loggedAt: number): void
  findOutboundByClientRequest(
    agentId: AgentId,
    channelId: ChannelId,
    clientRequestId: string,
  ): OutboundSnapshot | undefined
  createOutboundPlan(intent: OutboundIntentRecord, deliveries: readonly PhysicalDeliveryRecord[]): void
  markIntentSending(id: OutboundIntentId): void
  markDeliverySending(id: PhysicalDeliveryId, attempt: number): void
  recordDeliveryReceipt(record: DeliveryReceiptRecord): void
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
      readonly summary: string
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
  }): Promise<{ readonly summary: string; readonly provider: string; readonly model: string }>
  cancelSession(dshSessionId: string, reason: EpisodeCloseReason): Promise<void>
  admit(input: {
    readonly dshSessionId: string
    readonly admissionId: AdmissionId
    readonly events: readonly ChannelEventRecord[]
    readonly mode: 'followup' | 'inject'
  }): Promise<{ readonly dshMessageId: string }>
}

export interface ChannelRuntimeOptions {
  readonly now?: () => number
  readonly nextUlid?: () => string
  readonly resolveAdapter: (connectionId: ConnectionId) => AdapterConnectionRuntime | undefined
  readonly idleRolloverMs?: number | false
}

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
  switch (binding.triggerPolicy) {
    case 'always':
      return true
    case 'observe-only':
      return false
    case 'mentioned-or-replied':
      return event.facts?.mentionedBot === true || event.facts?.replyToBot === true
    case 'command':
      return typeof event.facts?.command === 'string' && event.facts.command.length > 0
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
  }
}

/** Only display-name changes are model/runtime neutral in M1; every other change requires M2 rollover. */
export const isSessionCompatibleRevision = (previous: AgentRevisionRecord, target: AgentRevisionRecord): boolean =>
  previous.agentId === target.agentId &&
  previous.persona === target.persona &&
  previous.model.provider === target.model.provider &&
  previous.model.model === target.model.model &&
  previous.model.reasoningEffort === target.model.reasoningEffort &&
  canonicalJson(previous.capabilities as unknown as JsonValue) ===
    canonicalJson(target.capabilities as unknown as JsonValue) &&
  canonicalJson(previous.settings ?? null) === canonicalJson(target.settings ?? null)

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
      await Promise.all(
        this.#coreRepository
          .listBindings(event.channelId)
          .filter((binding) => isTriggered(binding, commit.event))
          .map((binding) =>
            this.#withLane(binding.channelId, binding.agentId, () => this.#admit(binding, commit.event)),
          ),
      )
    }
    return {
      channelEventId: commit.event.id,
      inserted: commit.inserted,
      checkpointCommitted: commit.checkpointCommitted,
    }
  }

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    const episode = this.#runtimeRepository.getEpisode(input.episodeId)
    if (!episode || episode.status !== 'active') throw new Error(`Unknown or inactive Episode: ${input.episodeId}`)
    const channel = this.#coreRepository.getChannel(episode.channelId)
    if (!channel) throw new Error(`Episode channel no longer exists: ${episode.channelId}`)
    const adapter = this.#resolveAdapter(channel.connectionId)
    if (!adapter) throw new Error(`Connection adapter is not running: ${channel.connectionId}`)
    if (input.parts.length === 0) throw new Error('send_message requires at least one content part.')
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

    const intentId = this.#id<OutboundIntentId>('out')
    const logicalMessageId = this.#id<LogicalMessageId>('msg')
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
      agentId: episode.agentId,
      agentRevisionId: episode.agentRevisionId,
      episodeId: episode.id,
      ...(input.sourceTurnId === undefined ? {} : { sourceTurnId: input.sourceTurnId }),
      channelId: episode.channelId,
      parts: input.parts,
      ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
      ...(input.clientRequestId === undefined ? {} : { clientRequestId: input.clientRequestId }),
      state: 'planned',
      createdAt: this.#timestamp(),
    }
    const deliveries: PhysicalDeliveryRecord[] = plans.map(({ parts, adapterContext }, sequence) => ({
      id: this.#id<PhysicalDeliveryId>('phy'),
      intentId,
      sequence,
      parts,
      ...(adapterContext === undefined ? {} : { adapterContext }),
      state: 'planned',
      attemptCount: 0,
    }))
    this.#runtimeRepository.createOutboundPlan(intent, deliveries)
    const settled = await this.#dispatchOutbound(intent.id, input.signal ?? new AbortController().signal)
    return this.#sendResult(settled.snapshot)
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
                  summary: handoff.summary,
                },
              }),
        })
        if (episode.status === 'opening') episode = this.#runtimeRepository.activateEpisode(episode.id, dshSessionId)
        else if (episode.dshSessionId !== dshSessionId) {
          throw new Error(`Recovered DSH Session identity changed for Episode ${episode.id}.`)
        }
        report.resumedEpisodes += 1

        for (const admission of this.#runtimeRepository.listRecoverableAdmissions(episode.id)) {
          if (admission.state === 'pending') this.#runtimeRepository.claimAdmission(admission.id, this.#timestamp())
          const existing = this.#sessionDriver.findAdmissionMessage(dshSessionId, admission.id)
          const lastEventId = admission.channelEventIds.at(-1)
          if (!lastEventId) throw new Error(`Recoverable Admission has no Channel Events: ${admission.id}`)
          if (existing) {
            this.#runtimeRepository.completeAdmission(admission.id, existing, lastEventId, this.#timestamp())
            report.recoveredAdmissions += 1
            continue
          }
          const events = admission.channelEventIds.map((id) => {
            const event = this.#coreRepository.getChannelEvent(id)
            if (!event) throw new Error(`Admission references a missing Channel Event: ${id}`)
            return event
          })
          const mode = this.#sessionDriver.sessionStatus(dshSessionId) === 'running' ? 'inject' : 'followup'
          const result = await this.#sessionDriver.admit({
            dshSessionId,
            admissionId: admission.id,
            events,
            mode,
          })
          this.#runtimeRepository.completeAdmission(admission.id, result.dshMessageId, lastEventId, this.#timestamp())
          report.recoveredAdmissions += 1
        }
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
      const binding = this.#coreRepository.getBinding(episode.channelId, episode.agentId)
      if (!binding) throw new Error(`Episode Binding no longer exists: ${episode.bindingId}`)
      const anchorId = episode.lastAdmittedEventId ?? episode.openedAtEventId
      const anchor = this.#coreRepository.getChannelEvent(anchorId)
      if (!anchor) throw new Error(`Episode anchor Event no longer exists: ${anchorId}`)
      return this.#rolloverIfNeeded(binding, episode, anchor, reason)
    })
  }

  async #admit(binding: BindingRecord, event: ChannelEventRecord): Promise<void> {
    let episode = this.#runtimeRepository.getActiveEpisode(binding.channelId, binding.agentId)
    if (!episode) {
      const agent = this.#coreRepository.getAgent(binding.agentId)
      if (!agent) throw new Error(`Binding agent no longer exists: ${binding.agentId}`)
      const opening: EpisodeRecord = {
        id: this.#id<EpisodeId>('eps'),
        channelId: binding.channelId,
        agentId: binding.agentId,
        agentRevisionId: agent.revision.id,
        bindingId: binding.id,
        bindingRevision: binding.revision,
        status: 'opening',
        openedAtEventId: event.id,
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
        episode = this.#runtimeRepository.activateEpisode(opening.id, dshSessionId)
      } catch (error) {
        this.#runtimeRepository.failEpisode(opening.id)
        throw error
      }
    }
    if (episode.status !== 'active' || episode.dshSessionId === undefined) {
      throw new Error(`Episode is not ready for admission: ${episode.id}`)
    }
    episode = await this.#rolloverIfNeeded(binding, episode, event)
    episode = await this.#applyCurrentCompatibleRevision(episode)
    const dshSessionId = episode.dshSessionId
    if (dshSessionId === undefined) throw new Error(`Episode has no DSH Session after revision switch: ${episode.id}`)

    const admission: AdmissionRecord = {
      id: this.#id<AdmissionId>('adm'),
      episodeId: episode.id,
      channelEventIds: [event.id],
      reason: this.#sessionDriver.sessionStatus(dshSessionId) === 'running' ? 'running-injection' : 'trigger',
      state: 'pending',
      createdAt: this.#timestamp(),
    }
    this.#runtimeRepository.createAdmission(admission)
    this.#runtimeRepository.claimAdmission(admission.id, this.#timestamp())
    const result = await this.#sessionDriver.admit({
      dshSessionId,
      admissionId: admission.id,
      events: [event],
      mode: admission.reason === 'running-injection' ? 'inject' : 'followup',
    })
    this.#runtimeRepository.completeAdmission(admission.id, result.dshMessageId, event.id, this.#timestamp())
  }

  async #rolloverIfNeeded(
    binding: BindingRecord,
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

    this.#runtimeRepository.beginEpisodeRollover(episode.id)
    const sourceEvents = [
      this.#coreRepository.getChannelEvent(episode.openedAtEventId),
      episode.lastAdmittedEventId === undefined
        ? undefined
        : this.#coreRepository.getChannelEvent(episode.lastAdmittedEventId),
    ].filter((sourceEvent): sourceEvent is ChannelEventRecord => sourceEvent !== undefined)
    let summary: Awaited<ReturnType<AgentSessionDriver['createHandoffSummary']>>
    try {
      summary = await this.#sessionDriver.createHandoffSummary({
        dshSessionId: episode.dshSessionId,
        episode,
        revision: previousRevision,
        sourceEvents,
      })
    } catch (error) {
      this.#runtimeRepository.cancelEpisodeRollover(episode.id)
      throw error
    }

    const nextEpisode: EpisodeRecord = {
      id: this.#id<EpisodeId>('eps'),
      channelId: episode.channelId,
      agentId: episode.agentId,
      agentRevisionId: current.revision.id,
      bindingId: binding.id,
      bindingRevision: binding.revision,
      status: 'opening',
      openedAtEventId: event.id,
      createdAt: this.#timestamp(),
    }
    const handoff: EpisodeHandoffRecord = {
      id: this.#id<EpisodeHandoffId>('hof'),
      fromEpisodeId: episode.id,
      toEpisodeId: nextEpisode.id,
      sourceEventIds: sourceEvents.map(({ id }) => id),
      summary: summary.summary,
      provider: summary.provider,
      model: summary.model,
      createdAt: this.#timestamp(),
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
        summary: handoff.summary,
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
    const channel = this.#coreRepository.getChannel(snapshot.intent.channelId)
    if (!channel) throw new Error(`Outbound channel no longer exists: ${snapshot.intent.channelId}`)
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
        this.#runtimeRepository.recordDeliveryReceipt({
          id: this.#id<DeliveryReceiptId>('rcp'),
          physicalDeliveryId: delivery.id,
          attempt: delivery.attemptCount,
          receipt: {
            status: 'unknown',
            message: 'Host restarted after dispatch began and before an authoritative receipt was committed.',
          },
          createdAt: this.#timestamp(),
        })
        unknownDeliveries += 1
        continue
      }
      if (delivery.state !== 'planned') continue
      const attempt = delivery.attemptCount + 1
      this.#runtimeRepository.markDeliverySending(delivery.id, attempt)
      let receipt: AdapterDeliveryReceipt
      try {
        const request: PhysicalDeliveryRequest = {
          deliveryId: delivery.id,
          logicalMessageId: snapshot.intent.logicalMessageId,
          connectionId: channel.connectionId,
          channelId: channel.id,
          parts: delivery.parts,
          ...(snapshot.intent.replyTo === undefined ? {} : { replyTo: snapshot.intent.replyTo }),
          attempt,
          ...(delivery.adapterContext === undefined ? {} : { adapterContext: delivery.adapterContext }),
        }
        receipt = await adapter.deliver(request, signal)
      } catch (error) {
        receipt = {
          status: 'unknown',
          message: `Adapter delivery threw before an authoritative receipt: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
      this.#runtimeRepository.recordDeliveryReceipt({
        id: this.#id<DeliveryReceiptId>('rcp'),
        physicalDeliveryId: delivery.id,
        attempt,
        receipt,
        createdAt: this.#timestamp(),
      })
    }
    const state = this.#aggregate(this.#runtimeRepository.getOutbound(id).receipts)
    this.#runtimeRepository.completeOutboundIntent(id, state)
    return { snapshot: this.#runtimeRepository.getOutbound(id), unknownDeliveries }
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
    if (!['sent', 'partially-sent', 'failed', 'unknown'].includes(status)) {
      throw new Error(`Outbound intent has not settled: ${snapshot.intent.id}`)
    }
    return {
      logicalMessageId: snapshot.intent.logicalMessageId,
      status: status as SendMessageResult['status'],
      receipts: snapshot.receipts,
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

  #id<T extends string>(prefix: string): T {
    return `${prefix}_${this.#nextUlid()}` as T
  }

  #timestamp(): number {
    const value = this.#now()
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Clock must return a non-negative integer.')
    return value
  }
}

export { isTriggered }
