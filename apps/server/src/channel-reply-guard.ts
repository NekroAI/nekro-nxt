import { sessionEvents } from './session-event-history.js'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'nekro-nxt-channel-reply-guard': {
      readonly kind: 'nekro-nxt-channel-reply-guard'
      readonly turn: number
    }
    'nekro-nxt-console-outbound': {
      readonly kind: 'nekro-nxt-console-outbound'
      readonly logicalMessageId: string
    }
    'nekro-nxt-channel-processing-reminder': {
      readonly kind: 'nekro-nxt-channel-processing-reminder'
      readonly turn: number
    }
  }
}

export const SEND_CHANNEL_MESSAGE_TOOL = 'send_channel_message'
export const FINISH_CHANNEL_TURN_TOOL = 'finish_channel_turn'
export const MAX_RESPONSE_CORRECTIONS = 2
export const CHANNEL_PROCESSING_REMINDER_THRESHOLD_MS = 60_000

export type ChannelDeliveryState = 'sent' | 'partially-sent' | 'failed' | 'unknown'
export type ChannelResponseState = 'not-required' | 'pending' | 'sent' | 'finished' | 'protocol-failed' | 'interrupted'

export interface ResponseObligationState {
  readonly latestRequiredAdmissionId?: string
  readonly responseState: ChannelResponseState
  readonly correctionCount: number
  readonly producedReply: boolean
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const currentTurnEvents = (events: readonly SessionEvent[], turn: number): readonly SessionEvent[] => {
  const start = events.findIndex((event) => event.type === 'turn/start' && event.data.turn === turn)
  if (start < 0) return []
  const end = events.findIndex((event, index) => index > start && event.type === 'turn/end' && event.data.turn === turn)
  if (end >= 0) return events.slice(start, end + 1)
  const nextStart = events.findIndex((event, index) => index > start && event.type === 'turn/start')
  return nextStart < 0 ? events.slice(start) : events.slice(start, nextStart)
}

const channelAdmissionId = (message: UserMessage): string | undefined => {
  if (message.source.kind !== 'nekro-nxt-channel') return undefined
  if (message.source.admissionId.startsWith('console:')) return undefined
  return message.source.admissionId
}

export type ReplyRequiredResolver = (admissionId: string) => boolean
export type CorrectionCountResolver = (admissionId: string) => number

const successfulToolResult = (event: SessionEvent): { readonly callId: string } | undefined => {
  if (event.type !== 'tool/result' || event.data.error !== undefined) return undefined
  const message = event.data.message
  if (message.isError) return undefined
  return { callId: String(message.toolCallId) }
}

const deliveryStateFromMeta = (meta: unknown): ChannelDeliveryState | undefined => {
  if (!isRecord(meta)) return undefined
  const value = meta['deliveryState']
  return value === 'sent' || value === 'partially-sent' || value === 'failed' || value === 'unknown' ? value : undefined
}

export const deliveryStateFromToolResult = (event: SessionEvent): ChannelDeliveryState | undefined =>
  event.type === 'tool/result' || event.type === 'tool/ptc-dispatch'
    ? deliveryStateFromMeta(event.data.meta)
    : undefined

/** A tool that settled without error, called directly or from a `run_code` program. */
const settledTool = (
  event: SessionEvent,
  toolNames: ReadonlyMap<string, string>,
): { readonly name: string | undefined; readonly deliveryState: ChannelDeliveryState | undefined } | undefined => {
  if (event.type === 'tool/ptc-dispatch') {
    return event.data.isError ? undefined : { name: event.data.name, deliveryState: deliveryStateFromToolResult(event) }
  }
  const result = successfulToolResult(event)
  return result === undefined
    ? undefined
    : { name: toolNames.get(result.callId), deliveryState: deliveryStateFromToolResult(event) }
}

const targetsCurrentChannel = (args: unknown): boolean =>
  isRecord(args) && isRecord(args['target']) && args['target']['type'] === 'current'

const parseCallArguments = (args: string): unknown => {
  try {
    return JSON.parse(args)
  } catch {
    return undefined
  }
}

/** Disposable projection of committed events, bounded to one turn and its in-flight root calls. */
export class ChannelProcessingReminderProjection {
  #seq = -1
  #turn: number | undefined
  #startedAt = 0
  #hasAdmission = false
  #sent = false
  #reminded = false
  #returnedAt: number | undefined
  #lastAssistant: { readonly step: number; readonly stopped: boolean } | undefined
  readonly #calls = new Map<string, { readonly name: string; readonly args: unknown }>()

  append(event: SessionEvent): void {
    if (event.seq <= this.#seq) return
    this.#seq = event.seq
    if (event.type === 'turn/start') {
      this.#turn = event.data.turn
      this.#startedAt = event.time
      this.#hasAdmission = false
      this.#sent = false
      this.#reminded = false
      this.#returnedAt = undefined
      this.#lastAssistant = undefined
      this.#calls.clear()
      return
    }
    if (this.#turn === undefined) return
    if (event.type === 'turn/end' && event.data.turn === this.#turn) {
      this.#turn = undefined
      this.#calls.clear()
    } else if (event.type === 'user/message') {
      if (channelAdmissionId(event.data) !== undefined) this.#hasAdmission = true
      if (event.data.source.kind === 'nekro-nxt-channel-processing-reminder' && event.data.source.turn === this.#turn)
        this.#reminded = true
    } else if (event.type === 'assistant/message' && event.data.turn === this.#turn) {
      this.#returnedAt = undefined
      this.#lastAssistant = {
        step: event.data.step,
        stopped: !event.data.message.content.some((block) => block.type === 'tool-call'),
      }
    } else if (event.type === 'tool/call' && event.data.turn === this.#turn) {
      this.#calls.set(String(event.data.callId), {
        name: event.data.name,
        args: parseCallArguments(event.data.arguments),
      })
    } else if (event.type === 'tool/ptc-dispatch') {
      // A nested result is not a model boundary. The root may still be running (or ultimately fail).
      if (!this.#calls.has(String(event.data.rootCallId))) return
      if (!event.data.isError && event.data.error === undefined) {
        this.#recordSend(event.data.name, event.data.arguments, deliveryStateFromToolResult(event))
      }
    } else if (event.type === 'tool/result' && event.data.turn === this.#turn) {
      const callId = String(event.data.message.toolCallId)
      const call = this.#calls.get(callId)
      if (call === undefined) return
      this.#calls.delete(callId)
      this.#returnedAt = event.time
      if (successfulToolResult(event)) this.#recordSend(call.name, call.args, deliveryStateFromToolResult(event))
    }
  }

  #recordSend(name: string, args: unknown, delivery: ChannelDeliveryState | undefined): void {
    if (
      name === SEND_CHANNEL_MESSAGE_TOOL &&
      targetsCurrentChannel(args) &&
      (delivery === 'sent' || delivery === 'partially-sent')
    )
      this.#sent = true
  }

  previousStepAttemptedToStop(turn: number, step: number): boolean {
    return this.#turn === turn && this.#lastAssistant?.step === step && this.#lastAssistant.stopped
  }

  shouldRemind(turn: number): boolean {
    return (
      this.#turn === turn &&
      this.#hasAdmission &&
      !this.#sent &&
      !this.#reminded &&
      this.#calls.size === 0 &&
      this.#returnedAt !== undefined &&
      this.#returnedAt - this.#startedAt >= CHANNEL_PROCESSING_REMINDER_THRESHOLD_MS
    )
  }
}

const processingReminder = (turn: number): UserMessage =>
  createUserMessage({
    content: [
      {
        type: 'text',
        text: [
          '〔提醒〕这一轮已经处理了至少 60 秒，频道里还没有收到你的回复。',
          '如果还需要继续处理，可以先用 send_channel_message 告诉频道目前的进展，再继续使用工具。',
          '如果发送结果是 unknown，先确认是否已经送达，不要重复发送。',
        ].join('\n'),
      },
    ],
    source: {
      kind: 'nekro-nxt-channel-processing-reminder',
      turn,
    },
  })

const completedReasonKind = (events: readonly SessionEvent[], turn: number): string | undefined => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'turn/end' && event.data.turn === turn) return event.data.reason.kind
  }
  return undefined
}

const foldMessages = (
  initial: ResponseObligationState,
  messages: readonly UserMessage[],
  replyRequired: ReplyRequiredResolver,
): ResponseObligationState => {
  let state = initial
  for (const message of messages) {
    const admissionId = channelAdmissionId(message)
    if (admissionId === undefined || !replyRequired(admissionId)) continue
    state = {
      ...state,
      latestRequiredAdmissionId: admissionId,
      responseState: 'pending',
      correctionCount: 0,
    }
  }
  return state
}

export const responseObligationState = (
  events: readonly SessionEvent[],
  turn: number,
  proposedMessages: readonly UserMessage[] = [],
  replyRequired: ReplyRequiredResolver = () => false,
  correctionCount: CorrectionCountResolver = () => 0,
): ResponseObligationState => {
  const turnEvents = currentTurnEvents(events, turn)
  const toolNames = new Map<string, string>()
  let state: ResponseObligationState = {
    responseState: 'not-required',
    correctionCount: 0,
    producedReply: false,
  }

  for (const event of turnEvents) {
    if (event.type === 'user/message') {
      const admissionId = channelAdmissionId(event.data)
      if (admissionId !== undefined && replyRequired(admissionId)) {
        state = {
          ...state,
          latestRequiredAdmissionId: admissionId,
          responseState: 'pending',
          correctionCount: 0,
        }
        continue
      }
      continue
    }
    if (event.type === 'tool/call') {
      toolNames.set(String(event.data.callId), event.data.name)
      continue
    }
    const settled = settledTool(event, toolNames)
    if (!settled) continue
    const { name, deliveryState } = settled
    if (name === SEND_CHANNEL_MESSAGE_TOOL) {
      // Missing metadata belongs to older successful tool results and preserves their historical meaning.
      const confirmed = deliveryState === undefined || deliveryState === 'sent' || deliveryState === 'partially-sent'
      if (!confirmed) continue
      state = {
        ...state,
        responseState: 'sent',
        correctionCount: 0,
        producedReply: true,
      }
      continue
    }
    if (name === FINISH_CHANNEL_TURN_TOOL) {
      state = {
        ...state,
        responseState: 'finished',
        correctionCount: 0,
      }
    }
  }

  state = foldMessages(state, proposedMessages, replyRequired)
  if (state.responseState === 'pending' && state.latestRequiredAdmissionId !== undefined) {
    state = { ...state, correctionCount: correctionCount(state.latestRequiredAdmissionId) }
  }
  if (state.responseState !== 'pending') return state
  const reasonKind = completedReasonKind(turnEvents, turn)
  if (reasonKind === undefined) return state
  if (reasonKind === 'completed') return { ...state, responseState: 'protocol-failed' }
  return { ...state, responseState: 'interrupted' }
}

const responseReminder = (turn: number): UserMessage =>
  createUserMessage({
    content: [
      {
        type: 'text',
        text: [
          '〔提醒〕最新的消息你还没回，刚才写的文字大家看不到。',
          '要回就用 send_channel_message；不用回就调用 finish_channel_turn 写明原因。',
          '如果刚才的发送结果是 unknown，可能已经发出去了，别重发，直接结束。',
        ].join('\n'),
      },
    ],
    source: {
      kind: 'nekro-nxt-channel-reply-guard',
      turn,
    },
  })

const withReminder = (
  agent: Agent,
  turn: number,
  messages: readonly UserMessage[],
  replyRequired: ReplyRequiredResolver,
  correctionCount: CorrectionCountResolver,
  recordCorrection: (admissionId: string) => void,
): readonly UserMessage[] => {
  const before = responseObligationState(sessionEvents(agent.session), turn, [], replyRequired, correctionCount)
  const includesCurrentReminder = messages.some((message) => message.source.kind === 'nekro-nxt-channel-reply-guard')
  const includesNewRequiredAdmission = messages.some((message) => {
    const admissionId = channelAdmissionId(message)
    return admissionId !== undefined && replyRequired(admissionId)
  })
  if (
    before.responseState !== 'pending' ||
    includesCurrentReminder ||
    includesNewRequiredAdmission ||
    before.correctionCount >= MAX_RESPONSE_CORRECTIONS
  ) {
    return messages
  }
  if (before.latestRequiredAdmissionId !== undefined) recordCorrection(before.latestRequiredAdmissionId)
  return [...messages, responseReminder(turn)]
}

export interface ChannelReplyGuardController {
  rememberAdmission(agent: Agent, admissionId: string, replyRequired: boolean): void
  responseState(agent: Agent, turn: number): ResponseObligationState
  /** Whether a message that needs a reply is still unanswered in the agent's open turn. */
  awaitingReply(agent: Agent): boolean
  dispose(): void
}

export const mountChannelReplyGuard = (context: Context): ChannelReplyGuardController => {
  let processingBySession = new WeakMap<Session, ChannelProcessingReminderProjection>()
  const processingFor = (session: Session): ChannelProcessingReminderProjection => {
    let projection = processingBySession.get(session)
    if (projection === undefined) {
      projection = new ChannelProcessingReminderProjection()
      for (const event of sessionEvents(session)) projection.append(event)
      processingBySession.set(session, projection)
    }
    return projection
  }
  const offEvent = context.on('session/event', (session, event) => processingBySession.get(session)?.append(event))
  const offSessionDisposed = context.on('session/disposed', (session) => processingBySession.delete(session))
  const admissionsByAgent = new WeakMap<Agent, Map<string, boolean>>()
  const correctionsByAgent = new WeakMap<Agent, Map<string, number>>()
  const resolverFor =
    (agent: Agent): ReplyRequiredResolver =>
    (admissionId) =>
      admissionsByAgent.get(agent)?.get(admissionId) === true
  const correctionResolverFor =
    (agent: Agent): CorrectionCountResolver =>
    (admissionId) =>
      correctionsByAgent.get(agent)?.get(admissionId) ?? 0
  const recordCorrectionFor =
    (agent: Agent) =>
    (admissionId: string): void => {
      const corrections = correctionsByAgent.get(agent) ?? new Map<string, number>()
      corrections.set(admissionId, (corrections.get(admissionId) ?? 0) + 1)
      correctionsByAgent.set(agent, corrections)
    }
  const offPreStep = context.on('agent/pre-step', async ({ agent, turn, step }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const processing = processingFor(agent.session)
    let messages: UserMessage[] = decision.messages
    if (step > 1 && processing.previousStepAttemptedToStop(turn, step - 1)) {
      messages = [
        ...withReminder(
          agent,
          turn,
          messages,
          resolverFor(agent),
          correctionResolverFor(agent),
          recordCorrectionFor(agent),
        ),
      ]
    }
    if (
      processing.shouldRemind(turn) &&
      !messages.some(
        (message) => message.source.kind === 'nekro-nxt-channel-processing-reminder' && message.source.turn === turn,
      )
    )
      messages = [...messages, processingReminder(turn)]
    return {
      ...decision,
      messages,
    }
  })
  const offStopping = context.on('agent/turn-stopping', ({ agent, turn, signal }) => {
    signal.throwIfAborted()
    const state = responseObligationState(
      sessionEvents(agent.session),
      turn,
      [],
      resolverFor(agent),
      correctionResolverFor(agent),
    )
    if (state.responseState !== 'pending' || state.correctionCount >= MAX_RESPONSE_CORRECTIONS) return
    if (state.latestRequiredAdmissionId !== undefined) recordCorrectionFor(agent)(state.latestRequiredAdmissionId)
    agent.steer(responseReminder(turn))
  })
  return {
    rememberAdmission(agent, admissionId, replyRequired) {
      const admissions = admissionsByAgent.get(agent) ?? new Map<string, boolean>()
      admissions.set(admissionId, replyRequired)
      admissionsByAgent.set(agent, admissions)
      const corrections = correctionsByAgent.get(agent) ?? new Map<string, number>()
      corrections.set(admissionId, 0)
      correctionsByAgent.set(agent, corrections)
    },
    responseState(agent, turn) {
      return responseObligationState(
        sessionEvents(agent.session),
        turn,
        [],
        resolverFor(agent),
        correctionResolverFor(agent),
      )
    },
    awaitingReply(agent) {
      const events = sessionEvents(agent.session)
      const open = events.findLast((event) => event.type === 'turn/start')
      if (open?.type !== 'turn/start') return false
      return (
        responseObligationState(events, open.data.turn, [], resolverFor(agent), correctionResolverFor(agent))
          .responseState === 'pending'
      )
    },
    dispose() {
      offPreStep()
      offStopping()
      offEvent()
      offSessionDisposed()
      processingBySession = new WeakMap()
    },
  }
}
