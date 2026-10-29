import type { OutboundSnapshot, SendMessageInput, SendMessageResult } from '@nekro-nxt/channel-runtime'
import {
  MessagePartSchema,
  type AgentId,
  type ChannelId,
  type EpisodeId,
  type ExtensionCapabilities,
  type ExtensionId,
  type ExtensionRevisionId,
  outboundProcessesBeforeSend,
  type MessagePart,
  type OutboundIntentId,
} from '@nekro-nxt/contracts'
import type {
  NxtHostService,
  NxtOutboundDelivered,
  NxtOutboundDraft,
  NxtOutboundResult,
} from '@nekro-nxt/extension-sdk'
import type { OutboundProcessingRecord } from '@nekro-nxt/storage-sqlite'
import type { PersistentOutboundHandler } from './persistent-extension-mounts.js'

export const OUTBOUND_CANCEL_REASON_MAX_CHARS = 500
/** Messages one extension may append to one message. */
export const OUTBOUND_MAX_FOLLOW_UPS = 5

type Diagnostic = { readonly extensionId: ExtensionId; readonly message: string }

export interface OutboundProcessingStore {
  getOutboundProcessingByRequest(episodeId: EpisodeId, clientRequestId: string): OutboundProcessingRecord | undefined
  saveOutboundProcessing(
    record: Omit<OutboundProcessingRecord, 'outboundIntentId' | 'notifiedAt'>,
  ): OutboundProcessingRecord
  linkOutboundProcessing(id: string, intentId: OutboundIntentId): void
  claimOutboundNotification(intentId: OutboundIntentId, at: number): OutboundProcessingRecord | undefined
}

export interface ExtensionOutboundProcessorOptions {
  /** Every outbound handler attached to the agent, in any order. */
  readonly handlers: (agentId: AgentId) => readonly PersistentOutboundHandler[]
  readonly describe: (handler: PersistentOutboundHandler) => {
    readonly displayName: string
    readonly capabilities: ExtensionCapabilities | undefined
  }
  /** The agent's processing order; extensions missing from it run after the listed ones, in their given order. */
  readonly order: (agentId: AgentId, extensionIds: readonly ExtensionId[]) => readonly ExtensionId[]
  /** `nxt` bound to the message's channel for one handler; no prompt registration. */
  readonly nxtFor: (handler: PersistentOutboundHandler, channelId: ChannelId) => NxtHostService
  readonly channel: (channelId: ChannelId) => NxtOutboundDraft['channel']
  /** The latest message that woke the agent in this episode. */
  readonly triggeredBy: (episodeId: EpisodeId) => string | undefined
  /** Why the channel cannot carry this part, or undefined when it can. */
  readonly unsupported: (channelId: ChannelId, part: MessagePart) => string | undefined
  readonly canUseAsset: (assetId: string, channelId: ChannelId) => boolean
  readonly textOf: (parts: readonly MessagePart[]) => string
  readonly store: OutboundProcessingStore
  readonly now: () => number
  readonly nextId: () => string
  readonly log?: (input: {
    readonly level: 'warn' | 'error'
    readonly handler: PersistentOutboundHandler
    readonly displayName: string
    readonly message: string
    readonly error?: unknown
    readonly channelId: ChannelId
  }) => void
}

export interface AgentSendInput extends SendMessageInput {
  readonly agentId: AgentId
  readonly channelId: ChannelId
}

export interface OutboundProcessingSummary {
  /** Extensions that changed the message or appended to it, by display name, in the order they ran. */
  readonly processedBy: readonly string[]
  readonly rewritten: boolean
  /** The content actually sent, present when an extension changed it. */
  readonly parts?: readonly MessagePart[]
  readonly followUps: readonly {
    readonly extension: string
    readonly logicalMessageId?: string
    readonly status: SendMessageResult['status'] | 'not-sent'
    readonly message?: string
  }[]
}

export type AgentSendResult =
  | (SendMessageResult & { readonly processing?: OutboundProcessingSummary })
  | {
      readonly status: 'cancelled'
      readonly receipts: readonly never[]
      readonly cancel: { readonly extension: string; readonly reason: string }
      readonly processing?: OutboundProcessingSummary
    }

const timeout = <Value>(promise: Promise<Value>, ms: number): Promise<Value> => {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new OutboundTimeoutError(ms)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

class OutboundTimeoutError extends Error {
  constructor(ms: number) {
    super(`出站处理超过 ${ms}ms。`)
    this.name = 'OutboundTimeoutError'
  }
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Outbound processing of the agent's messages (智能体出站处理 O1–O11). Before sending, extensions that may transform
 * or cancel run one after another in the agent's order; after delivery settles, extensions that read are told once.
 * Each handler only exercises the effects it declared; failures follow its `onTimeout` and never throw to the agent.
 */
export class ExtensionOutboundProcessor {
  readonly #options: ExtensionOutboundProcessorOptions

  constructor(options: ExtensionOutboundProcessorOptions) {
    this.#options = options
  }

  /** Pre-send handlers of the agent in their processing order. */
  beforeSendHandlers(agentId: AgentId): readonly PersistentOutboundHandler[] {
    const candidates = this.#options.handlers(agentId).filter((handler) => {
      const declared = this.#options.describe(handler).capabilities?.outbound
      return declared?.transform === true || declared?.cancel === true
    })
    const order = this.#options.order(
      agentId,
      candidates.map((handler) => handler.revision.extensionId),
    )
    const position = new Map(order.map((extensionId, index) => [extensionId, index]))
    return [...candidates].sort(
      (left, right) =>
        (position.get(left.revision.extensionId) ?? Number.MAX_SAFE_INTEGER) -
        (position.get(right.revision.extensionId) ?? Number.MAX_SAFE_INTEGER),
    )
  }

  async send(
    input: AgentSendInput,
    deliver: (input: SendMessageInput) => Promise<SendMessageResult>,
  ): Promise<AgentSendResult> {
    const { agentId, channelId, ...message } = input
    const clientRequestId = message.clientRequestId
    if (clientRequestId !== undefined) {
      const stored = this.#options.store.getOutboundProcessingByRequest(message.episodeId, clientRequestId)
      if (stored !== undefined) return this.#deliver(stored, message, deliver)
    }
    const handlers = this.#options.handlers(agentId)
    // Agents without outbound processors send exactly as before; nothing is recorded.
    if (handlers.length === 0 || clientRequestId === undefined) return deliver(message)
    const record = this.#options.store.saveOutboundProcessing({
      id: `opr_${this.#options.nextId()}`,
      agentId,
      channelId,
      episodeId: message.episodeId,
      clientRequestId,
      ...(await this.#process(agentId, channelId, message)),
      createdAt: this.#options.now(),
    })
    return this.#deliver(record, message, deliver)
  }

  async #process(
    agentId: AgentId,
    channelId: ChannelId,
    message: SendMessageInput,
  ): Promise<
    Pick<
      OutboundProcessingRecord,
      'processedBy' | 'rewritten' | 'draftParts' | 'finalParts' | 'followUps' | 'cancelled' | 'diagnostics'
    >
  > {
    let parts: readonly MessagePart[] = message.parts
    let rewritten = false
    const processedBy: { extensionId: ExtensionId; displayName: string; changed?: true }[] = []
    const followUps: { extensionId: ExtensionId; parts: readonly MessagePart[] }[] = []
    const diagnostics: Diagnostic[] = []
    let cancelled: { extensionId: ExtensionId; reason: string } | undefined
    const channel = this.#options.channel(channelId)
    const triggeredBy = this.#options.triggeredBy(message.episodeId)
    for (const handler of this.beforeSendHandlers(agentId)) {
      const extensionId = handler.revision.extensionId
      const { displayName, capabilities } = this.#options.describe(handler)
      const declared = capabilities?.outbound
      if (declared === undefined) continue
      const note = (text: string, error?: unknown) => {
        diagnostics.push({ extensionId, message: text })
        this.#options.log?.({ level: 'warn', handler, displayName, message: text, error, channelId })
      }
      const draft: NxtOutboundDraft = {
        stage: 'draft',
        channel,
        parts: structuredClone(parts),
        text: this.#options.textOf(parts),
        ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
        ...(triggeredBy === undefined ? {} : { triggeredBy }),
      }
      let answer: unknown
      try {
        answer = await timeout(
          Promise.resolve(handler.handler(draft, this.#options.nxtFor(handler, channelId))),
          declared.timeoutMs,
        )
      } catch (error) {
        const timedOut = error instanceof OutboundTimeoutError
        const reason = error instanceof Error ? error.message : String(error)
        processedBy.push({ extensionId, displayName })
        if (declared.onTimeout === 'cancel') {
          note(`${timedOut ? '处理超时' : '处理出错'}，按声明取消发送：${reason}`, error)
          cancelled = {
            extensionId,
            reason: timedOut ? `「${displayName}」没有及时处理完这条消息` : `「${displayName}」处理这条消息时出错`,
          }
          break
        }
        note(`${timedOut ? '处理超时' : '处理出错'}，照常发出：${reason}`, error)
        continue
      }
      const entry: { extensionId: ExtensionId; displayName: string; changed?: true } = { extensionId, displayName }
      processedBy.push(entry)
      if (answer === undefined || answer === null) continue
      if (!isRecord(answer)) {
        note('返回值不是对象，已忽略。')
        continue
      }
      const result = answer as NxtOutboundResult
      if (result.cancel !== undefined) {
        if (declared.cancel !== true) note('未声明 cancel，忽略取消。')
        else {
          const reason =
            isRecord(result.cancel) && typeof result.cancel.reason === 'string' && result.cancel.reason.trim() !== ''
              ? result.cancel.reason.trim().slice(0, OUTBOUND_CANCEL_REASON_MAX_CHARS)
              : '没有说明原因'
          entry.changed = true
          cancelled = { extensionId, reason }
          break
        }
      }
      if (result.parts !== undefined) {
        if (declared.transform !== true) note('未声明 transform，忽略替换的内容。')
        else {
          const checked = this.#checkParts(result.parts, channelId)
          if (typeof checked === 'string') note(`替换的内容无效，已忽略：${checked}`)
          else {
            parts = checked
            rewritten = true
            entry.changed = true
          }
        }
      }
      if (result.followUps !== undefined) {
        if (declared.transform !== true) note('未声明 transform，忽略追加的消息。')
        else if (!Array.isArray(result.followUps)) note('followUps 不是数组，已忽略。')
        else {
          const items: readonly unknown[] = result.followUps
          if (items.length > OUTBOUND_MAX_FOLLOW_UPS) {
            note(`一次最多追加 ${OUTBOUND_MAX_FOLLOW_UPS} 条消息，多出的已忽略。`)
          }
          for (const item of items.slice(0, OUTBOUND_MAX_FOLLOW_UPS)) {
            const checked = isRecord(item) ? this.#checkParts(item['parts'], channelId) : '追加的消息需要 { parts }。'
            if (typeof checked === 'string') note(`追加的消息无效，已忽略：${checked}`)
            else {
              followUps.push({ extensionId, parts: checked })
              entry.changed = true
            }
          }
        }
      }
    }
    return {
      processedBy,
      rewritten,
      draftParts: message.parts,
      ...(cancelled === undefined ? { finalParts: parts } : { cancelled }),
      followUps: cancelled === undefined ? followUps : [],
      diagnostics,
    }
  }

  /** The parts if the channel can send them, otherwise what is wrong. */
  #checkParts(value: unknown, channelId: ChannelId): readonly MessagePart[] | string {
    if (!Array.isArray(value) || value.length === 0) return 'parts 需要至少一个内容块。'
    const parts: MessagePart[] = []
    for (const [index, item] of (value as readonly unknown[]).entries()) {
      const parsed = MessagePartSchema.safeParse(item)
      if (!parsed.success) return `parts[${index}] 格式不对：${parsed.error.issues[0]?.message ?? ''}`
      const part = parsed.data
      const unsupported = this.#options.unsupported(channelId, part)
      if (unsupported !== undefined) return unsupported
      if (
        (part.type === 'image' || part.type === 'file' || part.type === 'audio') &&
        !this.#options.canUseAsset(part.assetId, channelId)
      ) {
        return `parts[${index}] 的素材 ${part.assetId} 在这个频道不能使用。`
      }
      parts.push(part)
    }
    return parts
  }

  async #deliver(
    record: OutboundProcessingRecord,
    message: SendMessageInput,
    deliver: (input: SendMessageInput) => Promise<SendMessageResult>,
  ): Promise<AgentSendResult> {
    const changed = record.processedBy.filter((entry) => 'changed' in entry && entry.changed === true)
    const names = changed.map(({ displayName }) => displayName)
    const nameOf = (extensionId: ExtensionId) =>
      record.processedBy.find((entry) => entry.extensionId === extensionId)?.displayName ?? '扩展'
    if (record.cancelled !== undefined || record.finalParts === undefined) {
      return {
        status: 'cancelled',
        receipts: [],
        cancel: {
          extension: record.cancelled === undefined ? '扩展' : nameOf(record.cancelled.extensionId),
          reason: record.cancelled?.reason ?? '没有说明原因',
        },
        ...(names.length === 0 ? {} : { processing: { processedBy: names, rewritten: false, followUps: [] } }),
      }
    }
    const primary = await deliver({
      ...message,
      parts: record.finalParts,
      onIntentPlanned: (intent) => this.#options.store.linkOutboundProcessing(record.id, intent.id),
    })
    if (names.length === 0 && record.followUps.length === 0) return primary
    const followUps: OutboundProcessingSummary['followUps'][number][] = []
    for (const [index, followUp] of record.followUps.entries()) {
      const extension = nameOf(followUp.extensionId)
      if (primary.status !== 'sent' && primary.status !== 'partially-sent') {
        followUps.push({ extension, status: 'not-sent', message: '前一条没有发出，追加的消息也没有发。' })
        continue
      }
      const clientRequestId = `${record.clientRequestId}#follow-${index + 1}`
      try {
        const saved =
          this.#options.store.getOutboundProcessingByRequest(record.episodeId, clientRequestId) ??
          this.#options.store.saveOutboundProcessing({
            id: `opr_${this.#options.nextId()}`,
            agentId: record.agentId,
            channelId: record.channelId,
            episodeId: record.episodeId,
            clientRequestId,
            followUpOf: record.id,
            processedBy: [{ extensionId: followUp.extensionId, displayName: extension, changed: true }],
            rewritten: false,
            draftParts: followUp.parts,
            finalParts: followUp.parts,
            followUps: [],
            diagnostics: [],
            createdAt: this.#options.now(),
          })
        const sent = await deliver({
          episodeId: message.episodeId,
          parts: followUp.parts,
          ...(message.sourceTurnId === undefined ? {} : { sourceTurnId: message.sourceTurnId }),
          clientRequestId,
          ...(message.signal === undefined ? {} : { signal: message.signal }),
          onIntentPlanned: (intent) => this.#options.store.linkOutboundProcessing(saved.id, intent.id),
        })
        followUps.push({ extension, logicalMessageId: sent.logicalMessageId, status: sent.status })
      } catch (error) {
        followUps.push({
          extension,
          status: 'not-sent',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return {
      ...primary,
      processing: {
        processedBy: names,
        rewritten: record.rewritten,
        ...(record.rewritten ? { parts: record.finalParts } : {}),
        followUps,
      },
    }
  }

  /**
   * Delivery of an agent message settled. Extensions that read are told once per message: the stored marker is
   * claimed before anyone is called, so recovery and redispatch never notify twice.
   */
  settled(snapshot: OutboundSnapshot): void {
    const intent = snapshot.intent
    if (intent.episodeId === undefined) return
    if (
      intent.state !== 'sent' &&
      intent.state !== 'partially-sent' &&
      intent.state !== 'failed' &&
      intent.state !== 'unknown'
    ) {
      return
    }
    const record = this.#options.store.claimOutboundNotification(intent.id, this.#options.now())
    if (record === undefined) return
    const readers = this.#options
      .handlers(record.agentId)
      .filter((handler) => this.#options.describe(handler).capabilities?.outbound?.read === true)
    if (readers.length === 0) return
    const delivered: NxtOutboundDelivered = {
      stage: 'delivered',
      channel: this.#options.channel(record.channelId),
      logicalMessageId: intent.logicalMessageId,
      parts: intent.parts,
      text: this.#options.textOf(intent.parts),
      deliveryState: intent.state,
      platformMessageIds: snapshot.receipts.flatMap(({ receipt }) =>
        receipt.status === 'sent' && receipt.platformMessageId !== undefined ? [receipt.platformMessageId] : [],
      ),
      ...(record.followUpOf === undefined ? {} : { followUp: true as const }),
    }
    for (const handler of readers) {
      const { displayName, capabilities } = this.#options.describe(handler)
      const timeoutMs = capabilities?.outbound?.timeoutMs ?? 15_000
      void timeout(
        Promise.resolve().then(() =>
          handler.handler(structuredClone(delivered), this.#options.nxtFor(handler, record.channelId)),
        ),
        timeoutMs,
      ).catch((error: unknown) => {
        this.#options.log?.({
          level: 'warn',
          handler,
          displayName,
          message: `发出后的通知处理失败：${error instanceof Error ? error.message : String(error)}`,
          error,
          channelId: record.channelId,
        })
      })
    }
  }
}

/** Saved order first, then enable order, then anything else; only `candidates` appear, each once. */
export const resolveOutboundOrder = (
  saved: readonly ExtensionId[],
  enabled: readonly ExtensionId[],
  candidates: readonly ExtensionId[],
): ExtensionId[] => {
  const wanted = new Set(candidates)
  const result: ExtensionId[] = []
  for (const extensionId of [...saved, ...enabled, ...candidates]) {
    if (wanted.has(extensionId) && !result.includes(extensionId)) result.push(extensionId)
  }
  return result
}

export interface OutboundOrderSource {
  listActivations(agentId: AgentId): readonly {
    readonly extensionId: ExtensionId
    readonly extensionRevisionId: ExtensionRevisionId
    readonly activatedAt: number
  }[]
  getExtensionRevisionVerification(
    revisionId: ExtensionRevisionId,
  ): { readonly permissions?: { readonly agent?: ExtensionCapabilities | undefined } | undefined } | undefined
  readonly outboundProcessing: { getAgentOutboundOrder(agentId: AgentId): readonly ExtensionId[] | undefined }
}

const byEnableTime = (source: OutboundOrderSource, agentId: AgentId) =>
  [...source.listActivations(agentId)].sort((left, right) => left.activatedAt - right.activatedAt)

/** The agent's enabled extensions that process messages before sending, in the order they run. */
export const agentOutboundOrder = (source: OutboundOrderSource, agentId: AgentId): ExtensionId[] => {
  const activations = byEnableTime(source, agentId)
  const candidates = activations
    .filter((activation) =>
      outboundProcessesBeforeSend(
        source.getExtensionRevisionVerification(activation.extensionRevisionId)?.permissions?.agent?.outbound,
      ),
    )
    .map(({ extensionId }) => extensionId)
  return resolveOutboundOrder(
    source.outboundProcessing.getAgentOutboundOrder(agentId) ?? [],
    activations.map(({ extensionId }) => extensionId),
    candidates,
  )
}

/** Order for a set of live handlers: the saved order, then enable order. */
export const outboundOrderFor = (
  source: OutboundOrderSource,
  agentId: AgentId,
  candidates: readonly ExtensionId[],
): ExtensionId[] =>
  resolveOutboundOrder(
    source.outboundProcessing.getAgentOutboundOrder(agentId) ?? [],
    byEnableTime(source, agentId).map(({ extensionId }) => extensionId),
    candidates,
  )

/** Synthetic messages a saved or imported extension's outbound handler is called with once during verification. */
export const OUTBOUND_VERIFICATION_DRAFT: NxtOutboundDraft = {
  stage: 'draft',
  channel: { id: 'chn_VERIFY', kind: 'group', displayName: '验证频道' },
  parts: [{ type: 'text', text: '验证消息' }],
  text: '验证消息',
}

export const OUTBOUND_VERIFICATION_DELIVERED: NxtOutboundDelivered = {
  stage: 'delivered',
  channel: OUTBOUND_VERIFICATION_DRAFT.channel,
  logicalMessageId: 'msg_VERIFY',
  parts: OUTBOUND_VERIFICATION_DRAFT.parts,
  text: OUTBOUND_VERIFICATION_DRAFT.text,
  deliveryState: 'sent',
  platformMessageIds: [],
}

const checkVerificationParts = (value: unknown, field: string): void => {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`出站处理函数返回的 ${field} 需要至少一个内容块。`)
  for (const [index, part] of (value as readonly unknown[]).entries()) {
    const parsed = MessagePartSchema.safeParse(part)
    if (!parsed.success || parsed.data.type === 'rich') {
      throw new Error(`出站处理函数返回的 ${field}[${index}] 不是可发送的内容块。`)
    }
  }
}

/** Rejects a verification answer that is malformed or uses an effect the extension did not declare. */
export const checkOutboundVerificationAnswer = (
  answer: unknown,
  declared: NonNullable<ExtensionCapabilities['outbound']>,
): void => {
  if (answer === undefined || answer === null) return
  if (!isRecord(answer)) throw new Error('出站处理函数应返回 { parts?, followUps?, cancel? } 或不返回。')
  if (answer['cancel'] !== undefined) {
    if (declared.cancel !== true) throw new Error('出站处理函数返回了 cancel，但没有声明 outbound.cancel。')
    const cancel = answer['cancel']
    if (!isRecord(cancel) || typeof cancel['reason'] !== 'string') {
      throw new Error('出站处理函数的 cancel 应写成 { reason: "原因" }。')
    }
  }
  if (answer['parts'] !== undefined) {
    if (declared.transform !== true) throw new Error('出站处理函数返回了 parts，但没有声明 outbound.transform。')
    checkVerificationParts(answer['parts'], 'parts')
  }
  if (answer['followUps'] !== undefined) {
    if (declared.transform !== true) throw new Error('出站处理函数返回了 followUps，但没有声明 outbound.transform。')
    const followUps = answer['followUps']
    if (!Array.isArray(followUps)) throw new Error('出站处理函数的 followUps 应是 [{ parts }] 数组。')
    for (const [index, item] of (followUps as readonly unknown[]).entries()) {
      checkVerificationParts(isRecord(item) ? item['parts'] : undefined, `followUps[${index}].parts`)
    }
  }
}

/** Runs a registered handler once with each message its declaration allows; used by import and save verification. */
export const verifyOutboundHandler = async (
  handler: (message: NxtOutboundDraft | NxtOutboundDelivered) => unknown,
  declared: NonNullable<ExtensionCapabilities['outbound']>,
): Promise<void> => {
  if (outboundProcessesBeforeSend(declared)) {
    checkOutboundVerificationAnswer(await handler(structuredClone(OUTBOUND_VERIFICATION_DRAFT)), declared)
  }
  if (declared.read === true) await handler(structuredClone(OUTBOUND_VERIFICATION_DELIVERED))
}
