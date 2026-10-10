import type { ChannelEventId, ChannelMemberId, LogicalMessageId } from '@nekro-nxt/contracts'
import type { ChannelEventRecord } from '@nekro-nxt/core'
import type { Message } from '@deepseek-ai/dsh-llm'

/** Opens the line that carries a member note into the conversation; also how the host finds it there again. */
export const MEMBER_NOTE_MARKER = '〔你之前记下的关于 '

/** Members whose note the agent can already see: shown with an earlier message, or written in this session. */
export const visibleMemberNotes = (messages: readonly Message[]): Set<string> => {
  const visible = new Set<string>()
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'text' && block.text.startsWith(MEMBER_NOTE_MARKER)) {
        const id = /(mbr_[0-9A-Za-z]+)）：/u.exec(block.text)?.[1]
        if (id !== undefined) visible.add(id)
      } else if (block.type === 'tool-call' && block.name === 'notes_update') {
        const about = /"about"\s*:\s*"(mbr_[0-9A-Za-z]+)"/u.exec(block.arguments)?.[1]
        if (about !== undefined) visible.add(about)
      }
    }
  }
  return visible
}

/**
 * What the agent kept about each person who talks to it in one admission, placed after that person's first such
 * message. Everyone follows the same rule: a person without a note gets nothing, and a note the agent can already see
 * is not repeated. People chatting among themselves are left out, so a busy group's backlog brings no pile of notes.
 */
export const memberNoteAttachments = (input: {
  readonly events: readonly ChannelEventRecord[]
  /** In a private chat every message is addressed to the agent. */
  readonly direct: boolean
  readonly isSelf: (memberId: ChannelMemberId) => boolean
  readonly repliesToAgent: (messageId: LogicalMessageId) => boolean
  readonly notes: (memberIds: readonly ChannelMemberId[]) => readonly {
    readonly memberId: ChannelMemberId
    readonly text: string
  }[]
  readonly visible: () => ReadonlySet<string>
  readonly label: (memberId: ChannelMemberId) => string
}): ReadonlyMap<ChannelEventId, string> => {
  const addressing = new Map<ChannelMemberId, ChannelEventId>()
  for (const event of input.events) {
    const sender = event.senderMemberId
    if (sender === undefined || addressing.has(sender) || input.isSelf(sender)) continue
    const addressesAgent =
      input.direct ||
      event.facts?.['mentionedBot'] === true ||
      event.parts.some((part) => part.type === 'mention' && input.isSelf(part.memberId)) ||
      (event.targetLogicalMessageId !== undefined && input.repliesToAgent(event.targetLogicalMessageId))
    if (addressesAgent) addressing.set(sender, event.id)
  }
  const result = new Map<ChannelEventId, string>()
  if (addressing.size === 0) return result
  const notes = input.notes([...addressing.keys()])
  if (notes.length === 0) return result
  const visible = input.visible()
  for (const note of notes) {
    const eventId = addressing.get(note.memberId)
    if (eventId === undefined || visible.has(note.memberId)) continue
    result.set(eventId, `${MEMBER_NOTE_MARKER}${input.label(note.memberId)}：${note.text}〕`)
  }
  return result
}
