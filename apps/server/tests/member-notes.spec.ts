import {
  ChannelEventIdSchema,
  ChannelIdSchema,
  ChannelMemberIdSchema,
  LogicalMessageIdSchema,
  type ChannelMemberId,
  type MessagePart,
} from '@nekro-nxt/contracts'
import type { ChannelEventRecord } from '@nekro-nxt/core'
import { createAssistantMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { MEMBER_NOTE_MARKER, memberNoteAttachments, visibleMemberNotes } from '../src/member-notes.ts'

const channelId = ChannelIdSchema.parse('chn_bigroom')
const self = ChannelMemberIdSchema.parse('mbr_self')
const guang = ChannelMemberIdSchema.parse('mbr_guang')
const xiaoman = ChannelMemberIdSchema.parse('mbr_xiaoman')
const crowd = ChannelMemberIdSchema.parse('mbr_crowd')

let sequence = 0
const event = (
  sender: ChannelMemberId,
  parts: readonly MessagePart[],
  extra: Partial<Pick<ChannelEventRecord, 'facts' | 'targetLogicalMessageId'>> = {},
): ChannelEventRecord => {
  sequence += 1
  return {
    id: ChannelEventIdSchema.parse(`evt_${sequence}`),
    logicalMessageId: LogicalMessageIdSchema.parse(`msg_${sequence}`),
    channelId,
    kind: 'message-created',
    senderMemberId: sender,
    parts,
    sourceTimestamp: sequence,
    receivedAt: sequence,
    dedupeKey: `key_${sequence}`,
    searchText: '',
    ...extra,
  }
}
const text = (value: string): MessagePart => ({ type: 'text', text: value })

const notes: Record<string, string> = {
  [guang]: '希望叫他阿光；在学摄影',
  [xiaoman]: '在学手冲咖啡',
  [crowd]: '常发表情包',
}
const attach = (events: readonly ChannelEventRecord[], visible: ReadonlySet<string> = new Set(), direct = false) =>
  memberNoteAttachments({
    events,
    direct,
    isSelf: (memberId) => memberId === self,
    repliesToAgent: (messageId) => messageId === 'msg_agent',
    notes: (memberIds) =>
      memberIds.flatMap((memberId) => (notes[memberId] ? [{ memberId, text: notes[memberId] }] : [])),
    visible: () => visible,
    label: (memberId) => `${memberId === guang ? '林思青' : '某人'}（${memberId}）`,
  })

describe('member notes', () => {
  it('come with people who talk to the agent, once, after their first such message', () => {
    const mention = event(guang, [{ type: 'mention', memberId: self }, text('又来了')])
    const again = event(guang, [{ type: 'mention', memberId: self }, text('还在吗')])
    const reply = event(xiaoman, [text('接着上次')], {
      targetLogicalMessageId: LogicalMessageIdSchema.parse('msg_agent'),
    })
    const chatter = event(crowd, [text('哈哈哈')])

    const result = attach([chatter, mention, again, reply])

    expect([...result.keys()]).toEqual([mention.id, reply.id])
    expect(result.get(mention.id)).toBe(`${MEMBER_NOTE_MARKER}林思青（${guang}）：希望叫他阿光；在学摄影〕`)
  })

  it('skip notes the agent can already see and treat every private message as addressed', () => {
    const plain = event(guang, [text('在吗')])

    expect(attach([plain]).size).toBe(0)
    expect(attach([plain], new Set(), true).size).toBe(1)
    expect(attach([plain], new Set([guang]), true).size).toBe(0)
  })

  it('find notes already in the conversation, shown to the agent or written by it', () => {
    const messages = [
      createUserMessage({
        content: [{ type: 'text', text: `${MEMBER_NOTE_MARKER}林思青（${guang}）：希望叫他阿光〕` }],
        source: { kind: 'nekro-nxt-memory-review' },
      }),
      createAssistantMessage({
        content: [
          {
            type: 'tool-call',
            id: ToolCallId('call-1'),
            name: 'notes_update',
            arguments: JSON.stringify({ about: xiaoman, content: '在学手冲咖啡', reason: '自我介绍' }),
          },
        ],
        source: { provider: 'test', model: 'test' },
      }),
    ]

    expect([...visibleMemberNotes(messages)].sort()).toEqual([guang, xiaoman].sort())
  })
})
