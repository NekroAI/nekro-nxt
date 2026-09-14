import type { ConversationMessage } from './product-model.js'

export const EMPTY_CHANNEL_MESSAGES: readonly ConversationMessage[] = Object.freeze([])
export type ChannelMessages = Readonly<Record<string, readonly ConversationMessage[]>>

export function groupChannelMessages(messages: readonly ConversationMessage[]): ChannelMessages {
  const groups: Record<string, ConversationMessage[]> = {}
  for (const message of messages) (groups[message.channelId] ??= []).push(message)
  return groups
}

/** Reuse unchanged rows; ordinary appends avoid sorting the historical window. */
export function mergeChannelMessages(
  current: readonly ConversationMessage[],
  incoming: readonly ConversationMessage[],
  replace = false,
): readonly ConversationMessage[] {
  if (!incoming.length && !replace) return current
  const previous = new Map(current.map((message) => [message.id, message]))
  const projected = incoming.map((message) => {
    const old = previous.get(message.id)
    return old && JSON.stringify(old) === JSON.stringify(message) ? old : message
  })
  let last = current.at(-1)?.occurredAt ?? -Infinity
  const seen = new Set(previous.keys())
  const append =
    !replace &&
    projected.every((message) => {
      const time = message.occurredAt ?? 0
      if (seen.has(message.id) || time < last) return false
      seen.add(message.id)
      last = time
      return true
    })
  const next = append
    ? [...current, ...projected]
    : [...new Map([...(replace ? [] : current), ...projected].map((message) => [message.id, message])).values()].sort(
        (a, b) => (a.occurredAt ?? 0) - (b.occurredAt ?? 0),
      )
  return next.length === current.length && next.every((message, index) => message === current[index]) ? current : next
}
