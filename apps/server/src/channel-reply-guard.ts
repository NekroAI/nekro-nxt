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
  const block = event.data.message.content[0]
  if (block?.type !== 'tool-result' || block.isError === true) return undefined
  return { callId: String(block.toolCallId) }
}

export const deliveryStateFromToolResult = (event: SessionEvent): ChannelDeliveryState | undefined => {
  if (event.type !== 'tool/result' || !isRecord(event.data.meta)) return undefined
  const value = event.data.meta['deliveryState']
  return value === 'sent' || value === 'partially-sent' || value === 'failed' || value === 'unknown' ? value : undefined
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
    const result = successfulToolResult(event)
    if (!result) continue
    const name = toolNames.get(result.callId)
    if (name === SEND_CHANNEL_MESSAGE_TOOL) {
      const deliveryState = deliveryStateFromToolResult(event)
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
          '自最新待回应消息之后，你尚未成功发送频道消息，也没有调用 finish_channel_turn。',
          '普通 text/reasoning 仍只保存在内部运行轨迹中，频道成员看不到。',
          '现在必须二选一：调用 send_channel_message 发送频道可见回应，或调用 finish_channel_turn 明确结束本轮处理。',
          '不要再用普通文本回答本提示。send_channel_message 返回 failed 或 unknown 时仍未确认送达；unknown 不得盲目重发，应使用 finish_channel_turn 明确收口。',
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
  const before = responseObligationState(agent.session.events, turn, [], replyRequired, correctionCount)
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
    if (decision.kind === 'reject' || step <= 1 || !previousStepAttemptedToStop(agent.session.events, turn, step - 1)) {
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
      agent.session.events,
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
      return responseObligationState(agent.session.events, turn, [], resolverFor(agent), correctionResolverFor(agent))
    },
    dispose() {
      offPreStep()
      offStopping()
    },
  }
}
