import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { assistantStreamFirstTokenTime } from '@deepseek-ai/dsh-llm'
import {
  deliveryStateFromToolResult,
  responseObligationState,
  type ResponseObligationState,
} from './channel-reply-guard.js'
import { boundedDetail, type RuntimeProjectionEvent } from './channel-runtime-projection.js'
import { projectTokenUsage } from './token-usage.js'
import { ChannelEventIdSchema, type ChannelEventId, type ChannelMemoryActivity } from '@nekro-nxt/contracts'
import type { MemoryEventData } from './memory-events.js'

/**
 * Session log types that change the product runtime projection. Streaming chunks do not; request header and route
 * metadata reach the projection through `sessionProjections.onChanged` (context occupancy) instead.
 */
export const CHANNEL_RUNTIME_SSE_EVENT_TYPES = new Set([
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'tool/call',
  'tool/result',
  'assistant/message',
  'user/message',
  'llm/retry',
  'llm/retry-started',
  'nekro-nxt/memory',
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

/** Model-visible text of an input message; an image block keeps its place as a marker. */
export const inputText = (blocks: readonly { readonly type: string; readonly text?: string }[]): string =>
  blocks
    .flatMap((block) =>
      block.type === 'text' && typeof block.text === 'string'
        ? [block.text]
        : block.type === 'image'
          ? ['［图片］']
          : [],
    )
    .join('\n')
    .trim()

/** The full text of one `user/message` in the log, for the runtime input detail. */
export const findInputDetail = (events: readonly SessionEvent[], messageId: string) => {
  for (const event of events) {
    if (event.type !== 'user/message' || String(event.data.id) !== messageId) continue
    const text = boundedDetail(inputText(event.data.content))
    return { messageId, available: true, source: event.data.source.kind, text: text.text, truncated: text.truncated }
  }
  return undefined
}

const memoryActivity = (data: MemoryEventData, at: number | undefined): ChannelMemoryActivity | undefined => {
  const time = at === undefined ? {} : { at }
  switch (data.kind) {
    case 'backlog-folded':
      return {
        kind: data.kind,
        ...time,
        foldedCount: data.foldedCount,
        shownCount: data.shownCount,
        foldedImageCount: data.foldedImageCount,
      }
    case 'history-search':
      return {
        kind: data.kind,
        ...time,
        query: data.query,
        hits: data.hits,
        ...(data.sender === undefined ? {} : { sender: data.sender }),
      }
    case 'notes-updated':
      return { kind: data.kind, ...time, revision: data.revision, chars: data.chars }
    case 'idle-review':
      return { kind: data.kind, ...time, quietMinutes: data.quietMinutes }
  }
}

export const normalizeSessionEvents = (
  events: readonly SessionEvent[],
  responseStateForTurn: (turn: number) => ResponseObligationState = (turn) => responseObligationState(events, turn),
): RuntimeProjectionEvent[] => {
  const result: RuntimeProjectionEvent[] = []
  const firstTokenKeys = new Set<string>()
  const turns = new Set<number>()
  // A channel admission opens a turn when DSH logs it while no turn is open (it waits for the next
  // `turn/start`) or before the open turn's first model output. DSH splices the inbox at step start,
  // so the trigger is logged after `step/start`; input logged after the turn already answered was
  // injected into a running turn and is not that turn's trigger.
  let openTurn: number | undefined
  let openTurnAnswered = false
  let heldTrigger: ChannelEventId | undefined
  // Inputs logged while no turn is open are spliced into the next one.
  let heldInputs: Extract<RuntimeProjectionEvent, { type: 'turn/input' }>[] = []
  const triggered = new Set<number>()
  const assignTrigger = (turn: number, eventId: ChannelEventId): void => {
    if (triggered.has(turn)) return
    triggered.add(turn)
    result.push({ type: 'turn/trigger', turn, eventId })
  }
  for (const event of events) {
    const at = event.time
    if (event.type === 'nekro-nxt/memory') {
      const activity = memoryActivity(event.data, at)
      if (activity !== undefined) result.push({ type: 'memory', activity })
      continue
    }
    if ((event.type === 'assistant/message' || event.type === 'tool/call') && event.data.turn === openTurn) {
      openTurnAnswered = true
    }
    if (event.type === 'turn/start') {
      turns.add(event.data.turn)
      openTurn = event.data.turn
      openTurnAnswered = false
      result.push({ type: 'turn/start', turn: event.data.turn, at })
      if (heldTrigger !== undefined) {
        assignTrigger(event.data.turn, heldTrigger)
        heldTrigger = undefined
      }
      for (const input of heldInputs) result.push({ ...input, turn: event.data.turn })
      heldInputs = []
      continue
    }
    if (event.type === 'user/message') {
      const source = event.data.source
      const text = inputText(event.data.content)
      const input = {
        type: 'turn/input' as const,
        turn: openTurn ?? -1,
        messageId: String(event.data.id),
        source: source.kind,
        at,
        ...(source.kind === 'nekro-nxt-channel' ? { eventCount: source.channelEventIds.length } : {}),
        ...(text ? { text } : {}),
      }
      if (openTurn === undefined) heldInputs.push(input)
      else result.push(input)
      const eventId =
        source.kind === 'nekro-nxt-channel' ? ChannelEventIdSchema.safeParse(source.channelEventIds.at(-1)) : undefined
      if (eventId?.success === true) {
        if (openTurn === undefined) heldTrigger = eventId.data
        else if (!openTurnAnswered) assignTrigger(openTurn, eventId.data)
      }
      continue
    }
    if (event.type === 'turn/end') {
      if (openTurn === event.data.turn) openTurn = undefined
      const reason = event.data.reason
      result.push({
        type: 'turn/end',
        turn: event.data.turn,
        reasonKind: reason.kind,
        at,
        ...(reason.kind === 'error' ? { errorCode: reason.error.code, errorMessage: reason.error.message } : {}),
      })
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
      const message = event.data.message
      const callId = String(message.toolCallId)
      if (!callId) continue
      const resultPreview = textFromBlocks(message.content)
      const deliveryState = deliveryStateFromToolResult(event)
      result.push({
        type: 'tool/result',
        turn: event.data.turn,
        step: event.data.step,
        callId,
        failed: event.data.error !== undefined || message.isError === true,
        at,
        ...(resultPreview === undefined ? {} : { resultPreview }),
        ...(deliveryState === undefined ? {} : { deliveryState }),
      })
      continue
    }
    if (event.type === 'assistant/attempt' || event.type === 'assistant/message') {
      const firstTokenAt = assistantStreamFirstTokenTime(event.data.stream)
      const key = `${event.data.turn}:${event.data.step}`
      if (firstTokenAt !== undefined && !firstTokenKeys.has(key)) {
        firstTokenKeys.add(key)
        result.push({ type: 'assistant/first-token', turn: event.data.turn, step: event.data.step, at: firstTokenAt })
      }
      if (event.type === 'assistant/attempt') continue
    }
    if (event.type === 'llm/retry') {
      result.push({
        type: 'llm/retry',
        retryId: String(event.data.retryId),
        turn: event.data.turn,
        step: event.data.step,
        retry: event.data.retry,
        delayMs: event.data.delayMs,
        at,
      })
      continue
    }
    if (event.type === 'llm/retry-started') {
      result.push({
        type: 'llm/retry-started',
        retryId: String(event.data.retryId),
        turn: event.data.turn,
        step: event.data.step,
        retry: event.data.retry,
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
        ...(usage === undefined ? {} : { usage: projectTokenUsage(usage) }),
      })
    }
  }
  for (const turn of turns) {
    const response = responseStateForTurn(turn)
    result.push({
      type: 'channel/response-state',
      turn,
      responseState: response.responseState,
      producedReply: response.producedReply,
    })
  }
  return result
}
