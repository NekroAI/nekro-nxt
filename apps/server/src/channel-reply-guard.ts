import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

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

const SEND_CHANNEL_MESSAGE_TOOL = 'send_channel_message'

export const currentTurnEvents = (events: readonly SessionEvent[], turn: number): readonly SessionEvent[] => {
  const start = events.findIndex((event) => event.type === 'turn/start' && event.data.turn === turn)
  if (start < 0) return []
  const end = events.findIndex((event, index) => index > start && event.type === 'turn/end' && event.data.turn === turn)
  if (end >= 0) return events.slice(start, end + 1)
  const nextStart = events.findIndex((event, index) => index > start && event.type === 'turn/start')
  return nextStart < 0 ? events.slice(start) : events.slice(start, nextStart)
}

export const turnRequiresChannelReply = (events: readonly SessionEvent[], turn: number): boolean =>
  currentTurnEvents(events, turn).some((event) => {
    if (event.type !== 'user/message' || event.data.source.kind !== 'nekro-nxt-channel') return false
    return !event.data.source.admissionId.startsWith('console:')
  })

export const turnHasReplyGuardReminder = (events: readonly SessionEvent[], turn: number): boolean =>
  currentTurnEvents(events, turn).some(
    (event) =>
      event.type === 'user/message' &&
      event.data.source.kind === 'nekro-nxt-channel-reply-guard' &&
      event.data.source.turn === turn,
  )

export const turnHasSuccessfulChannelReply = (events: readonly SessionEvent[], turn: number): boolean => {
  const turnEvents = currentTurnEvents(events, turn)
  const sendCallIds = new Set(
    turnEvents.flatMap((event) =>
      event.type === 'tool/call' && event.data.name === SEND_CHANNEL_MESSAGE_TOOL ? [String(event.data.callId)] : [],
    ),
  )
  if (sendCallIds.size === 0) return false
  return turnEvents.some((event) => {
    if (event.type !== 'tool/result' || event.data.error !== undefined) return false
    const block = event.data.message.content[0]
    return block?.type === 'tool-result' && sendCallIds.has(String(block.toolCallId)) && block.isError !== true
  })
}

export const turnIsUnreplied = (events: readonly SessionEvent[], turn: number): boolean => {
  const turnEvents = currentTurnEvents(events, turn)
  return (
    turnRequiresChannelReply(turnEvents, turn) &&
    turnHasReplyGuardReminder(turnEvents, turn) &&
    !turnHasSuccessfulChannelReply(turnEvents, turn) &&
    turnEvents.some(
      (event) => event.type === 'turn/end' && event.data.turn === turn && event.data.reason.kind === 'completed',
    )
  )
}

export const mountChannelReplyGuard = (context: Context): (() => boolean) =>
  context.on('agent/turn-stopping', ({ agent, turn, signal }) => {
    signal.throwIfAborted()
    const events = agent.session.events
    if (!turnRequiresChannelReply(events, turn) || turnHasSuccessfulChannelReply(events, turn)) return
    if (turnHasReplyGuardReminder(events, turn)) return
    agent.steer(
      createUserMessage({
        content: [
          {
            type: 'text',
            text: '本轮尚未成功调用 send_channel_message，频道里还看不到你的回复。请立即使用该工具发送用户可见内容；不要只输出普通模型文字。',
          },
        ],
        source: { kind: 'nekro-nxt-channel-reply-guard', turn },
      }),
    )
  })
