import { sessionEvents } from './session-event-history.js'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'

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
  }
}

export const SEND_CHANNEL_MESSAGE_TOOL = 'send_channel_message'
export const FINISH_CHANNEL_TURN_TOOL = 'finish_channel_turn'
export const MAX_RESPONSE_CORRECTIONS = 2

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

const previousStepAttemptedToStop = (events: readonly SessionEvent[], turn: number, step: number): boolean => {
  const assistant = currentTurnEvents(events, turn).findLast(
    (event) => event.type === 'assistant/message' && event.data.turn === turn && event.data.step === step,
  )
  return (
    assistant?.type === 'assistant/message' &&
    !assistant.data.message.content.some((block) => block.type === 'tool-call')
  )
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
    if (
      decision.kind === 'reject' ||
      step <= 1 ||
      !previousStepAttemptedToStop(sessionEvents(agent.session), turn, step - 1)
    ) {
      return decision
    }
    return {
      ...decision,
      messages: [
        ...withReminder(
          agent,
          turn,
          decision.messages,
          resolverFor(agent),
          correctionResolverFor(agent),
          recordCorrectionFor(agent),
        ),
      ],
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
    },
  }
}
