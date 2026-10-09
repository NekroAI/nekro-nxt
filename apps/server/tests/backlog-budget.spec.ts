import {
  AssetIdSchema,
  ChannelEventIdSchema,
  ChannelIdSchema,
  ChannelMemberIdSchema,
  LogicalMessageIdSchema,
} from '@nekro-nxt/contracts'
import type { ChannelEventRecord } from '@nekro-nxt/core'
import { describe, expect, it } from 'vitest'
import { BACKLOG_MIN_SHOWN, foldedBacklogNotice, selectBacklog } from '../src/backlog-budget.ts'

const channelId = ChannelIdSchema.parse('chn_backlog')

const event = (
  index: number,
  text: string,
  images: readonly string[] = [],
  sender = 'mbr_acheng',
): ChannelEventRecord => {
  const id = String(index).padStart(4, '0')
  return {
    id: ChannelEventIdSchema.parse(`evt_${id}`),
    logicalMessageId: LogicalMessageIdSchema.parse(`msg_${id}`),
    channelId,
    kind: 'message-created',
    senderMemberId: ChannelMemberIdSchema.parse(sender),
    parts: [
      { type: 'text', text },
      ...images.map((assetId) => ({ type: 'image' as const, assetId: AssetIdSchema.parse(assetId) })),
    ],
    sourceTimestamp: 1_000 * index,
    receivedAt: 1_000 * index,
    dedupeKey: `key_${id}`,
    searchText: text,
  }
}

describe('selectBacklog', () => {
  it('keeps the newest messages within the text budget and folds the older ones', () => {
    const events = Array.from({ length: 200 }, (_, index) => event(index, '一'.repeat(60)))
    const selection = selectBacklog(events, { backlogTextChars: 5_000, backlogImages: 6 })

    expect(selection.shown.at(-1)).toBe(events.at(-1))
    expect(selection.shown.length).toBe(50)
    expect(selection.folded).toEqual(events.slice(0, 150))
  })

  it('always reads the newest messages one by one, and everything when the budget is unlimited', () => {
    const long = Array.from({ length: 40 }, (_, index) => event(index, '长'.repeat(2_000)))

    expect(selectBacklog(long, { backlogTextChars: 1_000, backlogImages: 0 }).shown).toHaveLength(BACKLOG_MIN_SHOWN)
    expect(selectBacklog(long, { backlogTextChars: 0, backlogImages: 0 }).folded).toEqual([])
  })

  it('shows only the newest images as pictures', () => {
    const events = [
      event(1, 'a', ['ast_old1', 'ast_old2']),
      event(2, 'b', ['ast_mid1']),
      event(3, 'c', ['ast_new1', 'ast_new2']),
    ]

    expect([...selectBacklog(events, { backlogTextChars: 0, backlogImages: 3 }).pictures].sort()).toEqual([
      'ast_mid1',
      'ast_new1',
      'ast_new2',
    ])
    expect(selectBacklog(events, { backlogTextChars: 0, backlogImages: 0 }).pictures.size).toBe(0)
  })

  it('sums up folded messages with their time span, images and the most active members', () => {
    const folded = [event(1, 'x', ['ast_one'], 'mbr_a'), event(2, 'y', [], 'mbr_b'), event(3, 'z', [], 'mbr_b')]
    const names: Record<string, string> = { mbr_a: '阿澄', mbr_b: '小鹿' }
    const notice = foldedBacklogNotice(folded, {
      formatTime: (epoch) => `t${epoch}`,
      senderName: (item) => names[item.senderMemberId ?? ''],
    })

    expect(notice).toContain('还有 3 条更早的')
    expect(notice).toContain('t1000 到 t3000')
    expect(notice).toContain('含 1 张图片')
    expect(notice).toContain('说话多的有 小鹿、阿澄')
    expect(notice).toContain('conversation_history_search')
  })
})
