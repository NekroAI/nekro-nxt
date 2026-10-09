import {
  ChannelEventIdSchema,
  ChannelIdSchema,
  ChannelMemberIdSchema,
  LogicalMessageIdSchema,
  OutboundIntentIdSchema,
  PlatformIdentityIdSchema,
} from '@nekro-nxt/contracts'
import type { ChannelHistoryEntry, ChannelHistoryFilter } from '@nekro-nxt/channel-runtime'
import { describe, expect, it } from 'vitest'
import { readHistoryText, searchHistoryText, type HistoryLookup } from '../src/index.ts'
import type { ChannelMemberRelations } from '../src/session-image-context.ts'

const channelId = ChannelIdSchema.parse('chn_history')
const acheng = ChannelMemberIdSchema.parse('mbr_acheng')
const self = ChannelMemberIdSchema.parse('mbr_self')
const at = (hour: number, minute = 0) =>
  Date.parse(`2026-10-08T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`)

const inbound = (id: string, time: number, text: string): ChannelHistoryEntry => ({
  source: 'channel-event',
  sourceId: ChannelEventIdSchema.parse(`evt_${id}`),
  logicalMessageId: LogicalMessageIdSchema.parse(`msg_${id}`),
  channelId,
  occurredAt: time,
  senderMemberId: acheng,
  parts: [{ type: 'text', text }],
})
const outbound = (id: string, time: number, text: string): ChannelHistoryEntry => ({
  source: 'outbound-intent',
  sourceId: OutboundIntentIdSchema.parse(`out_${id}`),
  logicalMessageId: LogicalMessageIdSchema.parse(`msg_${id}`),
  channelId,
  occurredAt: time,
  state: 'sent',
  parts: [{ type: 'text', text }],
})

const setup = (entries: readonly ChannelHistoryEntry[]) => {
  const calls: { readonly query?: string; readonly options: { limit?: number } & ChannelHistoryFilter }[] = []
  const newestFirst = [...entries].sort((left, right) => right.occurredAt - left.occurredAt)
  const history: HistoryLookup = {
    listChannelHistory: (_channel, options = {}) => {
      calls.push({ options })
      return newestFirst.slice(0, options.limit ?? 50)
    },
    searchChannelHistory: (_channel, query, options = {}) => {
      calls.push({ query, options })
      return newestFirst
        .filter((entry) => JSON.stringify(entry.parts).includes(query))
        .map((entry) => ({ entry, rank: 1 }))
    },
    getChannelMember: (id) =>
      id === acheng
        ? { id, channelId, platformIdentityId: PlatformIdentityIdSchema.parse('pid_acheng'), displayName: '阿澄' }
        : undefined,
  }
  const members: ChannelMemberRelations = {
    describe: (id) => (id === self ? { kind: 'self' } : { kind: 'member' }),
    self: () => ({ memberId: self }),
    localAgents: () => [],
  }
  const input = { channelId, history, members }
  const now = at(18)
  return {
    read: (args: Parameters<typeof readHistoryText>[1]) => readHistoryText(input, args, now),
    search: (args: Parameters<typeof searchHistoryText>[1]) => searchHistoryText(input, args, now).text,
    calls,
  }
}

describe('conversation history tools', () => {
  it('show the agent the messages themselves, oldest first, with who said them', () => {
    const tools = setup([inbound('1', at(14, 3), '我下周三生日，请大家喝奶茶'), outbound('2', at(14, 5), '生日快乐！')])

    const text = tools.search({ query: '生日' })

    expect(text.split('\n')).toEqual([
      expect.stringMatching(
        /^\[2026-10-08 14:03:00 \+08:00 · msg_1\] 阿澄（mbr_acheng）：我下周三生日，请大家喝奶茶$/u,
      ),
      '[14:05:00 · msg_2] 你：生日快乐！',
    ])
  })

  it('say plainly when nothing matched and how to look further', () => {
    const tools = setup([inbound('1', at(9), '早上好')])

    expect(tools.search({ query: '年糕' })).toContain('没有找到包含「年糕」的消息')
  })

  it('pass time and sender filters to the history, and «你» as the agent itself', () => {
    const tools = setup([inbound('1', at(9), '早上好')])

    tools.read({ since: '2026-10-08 08:00', until: '2026-10-08 12:00', sender: '阿澄' })
    tools.search({ query: '早上', sender: '你' })

    expect(tools.calls[0]!.options).toMatchObject({ since: at(8), until: at(12), sender: '阿澄' })
    expect(tools.calls[1]!.options).toMatchObject({ ownOnly: true })
    expect(tools.calls[1]!.options).not.toHaveProperty('sender')
    expect(() => tools.read({ since: '昨天' })).toThrow(/since/u)
  })

  it('tell the agent where to continue when the page is full', () => {
    const entries = Array.from({ length: 5 }, (_, index) => inbound(String(index), at(10, index), `第 ${index} 条`))
    const tools = setup(entries)

    const text = tools.read({ limit: 3 })

    expect(text.split('\n')).toHaveLength(4)
    expect(text).toContain(`beforeOccurredAt=${at(10, 2)}，beforeSourceId=evt_2`)
  })
})
