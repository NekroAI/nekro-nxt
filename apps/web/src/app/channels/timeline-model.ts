import type { ChannelRuntimeView, ConversationMessage } from '../../product-runtime.js'

export type RuntimeTurn = ChannelRuntimeView['turns'][number]
type TimedTurn = RuntimeTurn & { readonly startedAt?: number; readonly endedAt?: number; readonly triggerEventId?: string }

export type TimelineItem =
  | { readonly kind: 'day'; readonly key: string; readonly label: string }
  | { readonly kind: 'message'; readonly key: string; readonly message: ConversationMessage; readonly continued: boolean }
  | { readonly kind: 'turn'; readonly key: string; readonly turn: RuntimeTurn; readonly latest: boolean }

const GROUP_WINDOW_MS = 5 * 60_000

const dayKey = (time: number): string => {
  const date = new Date(time)
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

export function dayLabel(time: number, now = Date.now()): string {
  const key = dayKey(time)
  if (key === dayKey(now)) return '今天'
  if (key === dayKey(now - 86_400_000)) return '昨天'
  const date = new Date(time)
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  return sameYear ? `${date.getMonth() + 1} 月 ${date.getDate()} 日` : `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日`
}

/** Short relative time for lists: 刚刚 / N 分钟前 / HH:mm / 昨天 / M月D日. */
export function relativeTime(time: number | undefined, now = Date.now()): string {
  if (time === undefined) return ''
  const delta = now - time
  if (delta < 60_000) return '刚刚'
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`
  const date = new Date(time)
  if (dayKey(time) === dayKey(now)) return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (dayKey(time) === dayKey(now - 86_400_000)) return '昨天'
  return `${date.getMonth() + 1}月${date.getDate()}日`
}

/**
 * Merges channel messages with the current Episode's turns. Turns that carry `startedAt` are placed after the last
 * message received before they started; without timing only the latest turn is shown, at the end, so the current work
 * stays visible without inventing an order.
 */
export function buildTimeline(
  messages: readonly ConversationMessage[],
  turns: readonly RuntimeTurn[],
  now = Date.now(),
): readonly TimelineItem[] {
  const timed = (turns as readonly TimedTurn[]).filter((turn) => turn.startedAt !== undefined)
  const untimedLatest = timed.length === 0 ? (turns.at(-1) as TimedTurn | undefined) : undefined
  const latestTurnNumber = turns.at(-1)?.turn
  const queue = [...timed].sort((left, right) => (left.startedAt ?? 0) - (right.startedAt ?? 0))

  const items: TimelineItem[] = []
  let lastDay = ''
  let previous: ConversationMessage | undefined
  const pushTurn = (turn: TimedTurn) => {
    items.push({ kind: 'turn', key: `turn:${turn.turn}`, turn, latest: turn.turn === latestTurnNumber })
    previous = undefined
  }

  for (const message of messages) {
    const at = message.occurredAt ?? 0
    while (queue.length && (queue[0]?.startedAt ?? 0) < at) pushTurn(queue.shift()!)
    const day = message.occurredAt === undefined ? lastDay : dayKey(at)
    if (day && day !== lastDay) {
      items.push({ kind: 'day', key: `day:${day}`, label: dayLabel(at, now) })
      lastDay = day
      previous = undefined
    }
    const continued =
      previous !== undefined &&
      previous.role === message.role &&
      previous.author === message.author &&
      previous.origin === message.origin &&
      at - (previous.occurredAt ?? 0) < GROUP_WINDOW_MS
    items.push({ kind: 'message', key: message.id, message, continued })
    previous = message
  }
  for (const turn of queue) pushTurn(turn)
  if (untimedLatest) pushTurn(untimedLatest)
  return items
}

export const isTurnRunning = (turn: RuntimeTurn): boolean => turn.state === 'in-progress'

export const isUnconfirmed = (message: ConversationMessage): boolean =>
  message.delivery === '结果未知' || message.delivery === '失败' || message.delivery === '部分发送'

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 100_000 ? 0 : 1)}k`
  return String(value)
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return ''
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}
