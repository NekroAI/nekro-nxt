import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { turnIsUnreplied } from './channel-reply-guard.js'
import type { RuntimeProjectionEvent } from './channel-runtime-projection.js'

/** Session log types that change the product runtime projection. Streaming chunks do not. */
export const CHANNEL_RUNTIME_SSE_EVENT_TYPES = new Set([
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'tool/call',
  'tool/result',
  'assistant/message',
  'user/message',
  'request/header',
  'request/context',
])

export const shouldBroadcastChannelRuntime = (eventType: string | undefined): boolean =>
  eventType !== undefined && CHANNEL_RUNTIME_SSE_EVENT_TYPES.has(eventType)

const textFromBlocks = (blocks: readonly { readonly type: string; readonly text?: string }[]): string | undefined => {
  const text = blocks
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text ?? '')
    .join('\n')
    .trim()
  return text.length > 0 ? text : undefined
}

const reasoningFromBlocks = (
  blocks: readonly { readonly type: string; readonly text?: string }[],
): string | undefined => {
  const text = blocks
    .filter((block) => block.type === 'reasoning' && typeof block.text === 'string')
    .map((block) => block.text ?? '')
    .join('\n')
    .trim()
  return text.length > 0 ? text : undefined
}

export const normalizeSessionEvents = (events: readonly SessionEvent[]): RuntimeProjectionEvent[] => {
  const result: RuntimeProjectionEvent[] = []
  const firstTokenKeys = new Set<string>()
  for (const event of events) {
    const at = event.time
    if (event.type === 'turn/start') {
      result.push({ type: 'turn/start', turn: event.data.turn, at })
      continue
    }
    if (event.type === 'turn/end') {
      const reason = event.data.reason
      result.push({
        type: 'turn/end',
        turn: event.data.turn,
        reasonKind: reason.kind,
        at,
        ...(reason.kind === 'error' ? { errorCode: reason.error.code, errorMessage: reason.error.message } : {}),
      })
      if (turnIsUnreplied(events, event.data.turn)) {
        result.push({ type: 'channel/reply-missing', turn: event.data.turn, at })
      }
      continue
    }
    if (event.type === 'step/start' || event.type === 'step/end') {
      result.push({ type: event.type, turn: event.data.turn, step: event.data.step, at })
      continue
    }
    if (event.type === 'tool/call') {
      result.push({
        type: 'tool/call',
        turn: event.data.turn,
        step: event.data.step,
        callId: String(event.data.callId),
        name: event.data.name,
        arguments: event.data.arguments,
        at,
      })
      continue
    }
    if (event.type === 'tool/result') {
      const block = event.data.message.content[0]
      const callId = block?.type === 'tool-result' ? String(block.toolCallId) : ''
      if (!callId) continue
      const nested = block.type === 'tool-result' ? block.content : []
      const resultPreview = textFromBlocks(nested)
      result.push({
        type: 'tool/result',
        turn: event.data.turn,
        step: event.data.step,
        callId,
        failed: event.data.error !== undefined || (block.type === 'tool-result' && block.isError === true),
        at,
        ...(resultPreview === undefined ? {} : { resultPreview }),
      })
      continue
    }
    if (event.type === 'assistant/chunk') {
      const key = `${event.data.turn}:${event.data.step}`
      if (firstTokenKeys.has(key)) continue
      firstTokenKeys.add(key)
      result.push({
        type: 'assistant/first-token',
        turn: event.data.turn,
        step: event.data.step,
        at,
      })
      continue
    }
    if (event.type === 'assistant/message') {
      const blocks = event.data.message.content
      const text = textFromBlocks(blocks)
      const reasoning = reasoningFromBlocks(blocks)
      const usage = event.data.usage
      if (text === undefined && reasoning === undefined && usage === undefined) continue
      result.push({
        type: 'assistant/message',
        turn: event.data.turn,
        step: event.data.step,
        at,
        ...(text === undefined ? {} : { text }),
        ...(reasoning === undefined ? {} : { reasoning }),
        ...(usage === undefined ? {} : { usage }),
      })
    }
  }
  return result
}
