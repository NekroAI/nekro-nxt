import {
  messagePartAssetIds,
  messagePartsSearchText,
  type AssetId,
  type ChannelContextPolicy,
} from '@nekro-nxt/contracts'
import type { ChannelEventRecord } from '@nekro-nxt/core'

/** The newest messages of a backlog are always read one by one, whatever the text budget. */
export const BACKLOG_MIN_SHOWN = 20

/** Header and separators each message costs in context besides its own text. */
const MESSAGE_OVERHEAD_CHARS = 40

export interface BacklogSelection {
  /** Read one by one, oldest first. */
  readonly shown: readonly ChannelEventRecord[]
  /** Older messages that only appear as one summary line, oldest first. */
  readonly folded: readonly ChannelEventRecord[]
  /** Images of shown messages that go in as pictures; others stay references. */
  readonly pictures: ReadonlySet<AssetId>
}

const imageAssetIds = (event: ChannelEventRecord): AssetId[] =>
  event.parts.flatMap((part) =>
    part.type === 'image' ? [part.assetId] : part.type === 'rich' ? messagePartAssetIds(part) : [],
  )

/**
 * Splits one admission's events by the channel's budget. Newest messages are kept first so whatever the agent is
 * answering is always there; text beyond the budget folds into a summary the agent can expand with history tools,
 * and only the newest images are sent as pictures, since every picture is re-sent on each later request.
 */
export const selectBacklog = (
  events: readonly ChannelEventRecord[],
  policy: Pick<ChannelContextPolicy, 'backlogTextChars' | 'backlogImages'>,
): BacklogSelection => {
  let cut = 0
  if (policy.backlogTextChars > 0) {
    let used = 0
    cut = events.length
    for (let index = events.length - 1; index >= 0; index -= 1) {
      used += messagePartsSearchText(events[index]!.parts).length + MESSAGE_OVERHEAD_CHARS
      if (used > policy.backlogTextChars && events.length - index > BACKLOG_MIN_SHOWN) break
      cut = index
    }
  }
  const shown = events.slice(cut)
  const pictures = new Set<AssetId>()
  for (let index = shown.length - 1; index >= 0 && pictures.size < policy.backlogImages; index -= 1) {
    for (const assetId of imageAssetIds(shown[index]!).reverse()) {
      if (pictures.size >= policy.backlogImages) break
      pictures.add(assetId)
    }
  }
  return { shown, folded: events.slice(0, cut), pictures }
}

export const backlogImageCount = (events: readonly ChannelEventRecord[]): number =>
  events.reduce((count, event) => count + imageAssetIds(event).length, 0)

/** One line standing for the folded messages: when, how many, who talked most, and how to read them. */
export const foldedBacklogNotice = (
  folded: readonly ChannelEventRecord[],
  input: {
    readonly formatTime: (epoch: number, previous?: number) => string
    readonly senderName: (event: ChannelEventRecord) => string | undefined
  },
): string => {
  const first = folded[0]!
  const last = folded.at(-1)!
  const counts = new Map<string, number>()
  for (const event of folded) {
    const name = input.senderName(event)
    if (name !== undefined) counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const talkers = [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 5)
    .map(([name]) => name)
  const images = backlogImageCount(folded)
  const facts = [
    `${input.formatTime(first.receivedAt)} 到 ${input.formatTime(last.receivedAt, first.receivedAt)}`,
    ...(images > 0 ? [`含 ${images} 张图片`] : []),
    ...(talkers.length > 0 ? [`说话多的有 ${talkers.join('、')}`] : []),
  ]
  return [
    `〔下面这些消息之前，还有 ${folded.length} 条更早的没有逐条放进来（${facts.join('；')}）。`,
    '要看细节就用 conversation_history_read 或 conversation_history_search，可以按时间段和发言人筛选。〕',
  ].join('')
}
