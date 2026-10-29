import type { AdapterConnectionRuntime, AdapterDeliveryReceipt, PhysicalDeliveryRequest } from '@nekro-nxt/adapter-sdk'
import { setTimeout as delay } from 'node:timers/promises'
import type { ChannelId, ChannelEventId, MessagePart, OutboundIntentId } from '@nekro-nxt/contracts'
import { LogicalMessageIdSchema, OutboundIntentIdSchema, PhysicalDeliveryIdSchema } from '@nekro-nxt/contracts'
import type { CoreRepository } from '@nekro-nxt/core'
import type {
  ChannelFact,
  ChannelRuntimeOptions,
  DeliveryReceiptRecord,
  EpisodeRecord,
  OutboundIntentRecord,
  OutboundSnapshot,
  OutboundState,
  PhysicalDeliveryRecord,
  RuntimeRepository,
  SendMessageInput,
  SendMessageResult,
} from './index.js'
import type { ProcessingFeedback } from './processing-feedback.js'
/** Whether the connection can send this kind of part; the agent never sends `rich` parts. */
export const supportsPart = (adapter: AdapterConnectionRuntime, part: MessagePart): boolean => {
  switch (part.type) {
    case 'text':
      return adapter.capabilities.outbound.text
    case 'mention':
      return adapter.capabilities.outbound.mentions
    case 'image':
      return adapter.capabilities.outbound.images
    case 'file':
      return adapter.capabilities.outbound.files
    case 'audio':
      return adapter.capabilities.outbound.audio
    case 'quote':
      return adapter.capabilities.outbound.replies
    case 'rich':
      return false
  }
}
/** What the agent reads when a platform cannot carry a part; it says what to do instead. */
export const UNSUPPORTED_PART: Readonly<Record<MessagePart['type'], string>> = {
  text: '这个平台不能发送文字消息。',
  mention: '这个平台不支持在消息里 @ 成员，请直接写对方的名字。',
  image: '这个平台不能发送图片，请改用文字说明。',
  file: '这个平台不能发送文件，请把内容直接写进消息，或者改成图片发送。',
  audio: '这个平台不能发送语音，请改用文字。',
  quote: '这个平台不支持引用回复，请直接发送消息。',
  rich: '这个平台不能发送卡片消息，请改用文字。',
}

export interface DeliveryPacing {
  readonly gapMs: (channelId: ChannelId, parts: readonly MessagePart[]) => number
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}
export class ChannelDelivery {
  readonly #coreRepository: CoreRepository
  readonly #runtimeRepository: RuntimeRepository
  readonly #resolveAdapter: ChannelRuntimeOptions['resolveAdapter']
  readonly #feedback: ProcessingFeedback
  readonly #timestamp: () => number
  readonly #nextUlid: () => string
  readonly #publishFact: (fact: ChannelFact) => void
  readonly #pacing: DeliveryPacing
  readonly #lastSentAt = new Map<ChannelId, number>()
  readonly #settled: ((snapshot: OutboundSnapshot) => void) | undefined
  constructor(
    repository: CoreRepository,
    runtime: RuntimeRepository,
    resolveAdapter: ChannelRuntimeOptions['resolveAdapter'],
    feedback: ProcessingFeedback,
    timestamp: () => number,
    nextUlid: () => string,
    publish: (fact: ChannelFact) => void,
    pacing: DeliveryPacing = { gapMs: () => 0 },
    settled?: (snapshot: OutboundSnapshot) => void,
  ) {
    this.#settled = settled
    this.#coreRepository = repository
    this.#runtimeRepository = runtime
    this.#resolveAdapter = resolveAdapter
    this.#feedback = feedback
    this.#timestamp = timestamp
    this.#nextUlid = nextUlid
    this.#publishFact = publish
    this.#pacing = pacing
  }
  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    const episode = this.#runtimeRepository.getEpisode(input.episodeId)
    if (!episode || episode.status !== 'active') throw new Error(`Unknown or inactive Episode: ${input.episodeId}`)
    if (input.clientRequestId !== undefined) {
      const existing = this.#runtimeRepository.findOutboundByClientRequest(
        episode.agentId,
        episode.channelId,
        input.clientRequestId,
      )
      if (existing) return this.#sendResult(existing)
    }
    return this.#planAndSend(input, episode.channelId, episode)
  }

  /** Uses the same Outbox and Adapter receipts without opening a model Session. */
  sendCommandReply(input: {
    readonly channelId: ChannelId
    readonly executionId: string
    /** Position within the execution's replies; (execution, ordinal) is planned at most once. */
    readonly ordinal: number
    readonly parts: readonly MessagePart[]
    readonly eventId?: ChannelEventId
    /** Persist reply association synchronously with the plan before dispatch starts. */
    readonly onPlanned: (id: OutboundIntentId) => void
    readonly signal?: AbortSignal
  }): Promise<SendMessageResult> {
    return this.#planAndSend(input, input.channelId, undefined, input)
  }

  /**
   * Posts a host notice, such as an extension request asking an administrator to confirm, through the same Outbox.
   * `noticeKey` is unique: a notice is planned at most once even if the caller retries.
   */
  sendHostNotice(input: {
    readonly channelId: ChannelId
    readonly noticeKey: string
    readonly parts: readonly MessagePart[]
    readonly signal?: AbortSignal
  }): Promise<SendMessageResult> {
    const existing = this.#runtimeRepository.findOutboundByNoticeKey?.(input.noticeKey)
    if (existing) return Promise.resolve(this.#sendResult(existing))
    return this.#planAndSend(input, input.channelId, undefined, undefined, input.noticeKey)
  }

  async #planAndSend(
    input: {
      readonly parts: readonly MessagePart[]
      readonly replyTo?: string
      readonly sourceTurnId?: string
      readonly clientRequestId?: string
      readonly signal?: AbortSignal
      readonly onIntentPlanned?: SendMessageInput['onIntentPlanned']
    },
    channelId: ChannelId,
    episode?: EpisodeRecord,
    command?: {
      readonly executionId: string
      readonly ordinal: number
      readonly eventId?: ChannelEventId
      readonly onPlanned: (id: OutboundIntentId) => void
    },
    noticeKey?: string,
  ): Promise<SendMessageResult> {
    const channel = this.#coreRepository.getChannel(channelId)
    if (!channel)
      throw new Error(`${episode === undefined ? 'Outbound' : 'Episode'} channel no longer exists: ${channelId}`)
    const adapter = this.#resolveAdapter(channel.connectionId)
    if (!adapter) throw new Error(`Connection adapter is not running: ${channel.connectionId}`)
    if (input.parts.length === 0) throw new Error('Outbound requires at least one content part.')
    for (const part of input.parts) {
      if (!supportsPart(adapter, part)) throw new Error(UNSUPPORTED_PART[part.type])
    }
    await this.#waitForGap(channel.id, input.parts, input.signal)

    const intentId = OutboundIntentIdSchema.parse(`out_${this.#nextUlid()}`)
    const logicalMessageId = LogicalMessageIdSchema.parse(`msg_${this.#nextUlid()}`)
    const originEvent =
      (command?.eventId ?? episode?.lastAdmittedEventId) === undefined
        ? undefined
        : this.#coreRepository.getChannelEvent((command?.eventId ?? episode?.lastAdmittedEventId)!)
    const activeFeedback = episode === undefined ? undefined : this.#feedback.latestActiveLease(episode.id)
    const plans = adapter.planOutbound
      ? await adapter.planOutbound({
          connectionId: channel.connectionId,
          channelId: channel.id,
          parts: input.parts,
          ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
          ...(originEvent === undefined
            ? {}
            : {
                origin: {
                  ...(originEvent.platformMessageId === undefined
                    ? {}
                    : { platformMessageId: originEvent.platformMessageId }),
                  ...(originEvent.activityKey === undefined ? {} : { activityKey: originEvent.activityKey }),
                  receivedAt: originEvent.receivedAt,
                },
              }),
          ...(activeFeedback === undefined
            ? {}
            : {
                processingFeedback: {
                  leaseId: activeFeedback.id,
                  platformMessageId: activeFeedback.platformMessageId,
                },
              }),
        })
      : adapter.capabilities.outbound.mixedContent
        ? [{ parts: input.parts }]
        : input.parts.map((part) => ({ parts: [part] }))
    if (plans.length === 0 || plans.some(({ parts }) => parts.length === 0)) {
      throw new Error('Adapter outbound planner returned an empty PhysicalDelivery.')
    }
    const feedbackConsumers = plans.filter(({ consumesProcessingFeedback }) => consumesProcessingFeedback === true)
    if (feedbackConsumers.length > 1 || (feedbackConsumers.length === 1 && activeFeedback === undefined)) {
      throw new Error('Adapter outbound planner returned an invalid processing-feedback consumer.')
    }
    for (const { parts } of plans) {
      for (const part of parts) {
        if (!supportsPart(adapter, part)) throw new Error(`Adapter planner produced an unsupported part: ${part.type}`)
        if (
          part.type === 'text' &&
          adapter.capabilities.outbound.maxTextLength !== undefined &&
          [...part.text].length > adapter.capabilities.outbound.maxTextLength
        ) {
          throw new Error('Adapter outbound planner produced over-limit text.')
        }
      }
    }
    const intent: OutboundIntentRecord = {
      id: intentId,
      logicalMessageId,
      ...(episode === undefined ? {} : { agentRevisionId: episode.agentRevisionId, episodeId: episode.id }),
      ...(command === undefined
        ? {}
        : { channelId, commandExecutionId: command.executionId, commandOrdinal: command.ordinal }),
      ...(noticeKey === undefined ? {} : { channelId, noticeKey }),
      ...(input.sourceTurnId === undefined ? {} : { sourceTurnId: input.sourceTurnId }),
      parts: input.parts,
      ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
      ...(input.clientRequestId === undefined ? {} : { clientRequestId: input.clientRequestId }),
      state: 'planned',
      createdAt: this.#timestamp(),
    }
    const deliveries: PhysicalDeliveryRecord[] = plans.map(
      ({ parts, adapterContext, consumesProcessingFeedback }, sequence) => ({
        id: PhysicalDeliveryIdSchema.parse(`phy_${this.#nextUlid()}`),
        intentId,
        sequence,
        parts,
        ...(adapterContext === undefined ? {} : { adapterContext }),
        ...(consumesProcessingFeedback === true && activeFeedback !== undefined
          ? { processingFeedbackLeaseId: activeFeedback.id }
          : {}),
        state: 'planned',
      }),
    )
    this.#runtimeRepository.createOutboundPlan(intent, deliveries)
    command?.onPlanned(intent.id)
    input.onIntentPlanned?.({ id: intent.id, logicalMessageId: intent.logicalMessageId })
    this.#publishFact({ channelId: channel.id, kind: 'outbound', sourceId: intent.id })
    const settled = await this.dispatchOutbound(intent.id, input.signal ?? new AbortController().signal)
    this.#lastSentAt.set(channel.id, this.#timestamp())
    return this.#sendResult(settled.snapshot)
  }

  async #waitForGap(
    channelId: ChannelId,
    parts: readonly MessagePart[],
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const lastSentAt = this.#lastSentAt.get(channelId)
    if (lastSentAt === undefined) return
    const wait = lastSentAt + this.#pacing.gapMs(channelId, parts) - this.#timestamp()
    if (wait <= 0) return
    const sleep = this.#pacing.sleep ?? ((ms: number, abort: AbortSignal) => delay(ms, undefined, { signal: abort }))
    await sleep(wait, signal ?? new AbortController().signal)
  }

  async dispatchOutbound(
    id: OutboundIntentId,
    signal: AbortSignal,
  ): Promise<{ readonly snapshot: OutboundSnapshot; readonly unknownDeliveries: number }> {
    let snapshot = this.#runtimeRepository.getOutbound(id)
    const episode =
      snapshot.intent.episodeId === undefined
        ? undefined
        : this.#runtimeRepository.getEpisode(snapshot.intent.episodeId)
    const channelId = snapshot.intent.channelId ?? episode?.channelId
    const channel = channelId === undefined ? undefined : this.#coreRepository.getChannel(channelId)
    if (!channel) throw new Error('Outbound channel no longer exists.')
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
        if (delivery.processingFeedbackLeaseId !== undefined) {
          await this.#feedback.settleConsumedFeedback(delivery.processingFeedbackLeaseId)
        }
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
          ...(delivery.processingFeedbackLeaseId === undefined
            ? {}
            : (() => {
                const lease = this.#feedback.getLease(delivery.processingFeedbackLeaseId)
                return lease === undefined
                  ? {}
                  : {
                      processingFeedback: {
                        leaseId: lease.id,
                        platformMessageId: lease.platformMessageId,
                      },
                    }
              })()),
        }
        receipt = await adapter.deliver(request, signal)
      } catch (error) {
        receipt = {
          status: 'unknown',
          message: `Adapter delivery threw before an authoritative receipt: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
      this.#runtimeRepository.recordDeliveryReceipt(delivery.id, receipt, this.#timestamp())
      if (delivery.processingFeedbackLeaseId !== undefined) {
        if (receipt.status === 'sent' || receipt.status === 'unknown') {
          await this.#feedback.settleConsumedFeedback(delivery.processingFeedbackLeaseId)
        } else {
          await this.#feedback.cleanupFeedbackLease(delivery.processingFeedbackLeaseId, 'error')
        }
      }
    }
    const state = this.#aggregate(this.#runtimeRepository.getOutbound(id).receipts)
    this.#runtimeRepository.completeOutboundIntent(id, state)
    this.#publishFact({ channelId: channel.id, kind: 'outbound', sourceId: id })
    const completed = this.#runtimeRepository.getOutbound(id)
    try {
      this.#settled?.(completed)
    } catch {
      // Observers keep their own error reporting; a failing one never affects delivery.
    }
    return { snapshot: completed, unknownDeliveries }
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
}
