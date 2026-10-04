import { describe, expect, it } from 'vitest'
import { buildTimeline, dayLabel, presentToolInput, relativeTime } from '../src/app/channels/timeline-model.js'
import type { ConversationMessage } from '../src/product-runtime.js'

const NOW = new Date(2026, 9, 4, 12, 0).getTime()
const message = (id: string, author: string, occurredAt: number, role: ConversationMessage['role'] = 'member'): ConversationMessage => ({
  id,
  channelId: 'chn_fixture',
  author,
  role,
  body: id,
  parts: [{ type: 'text', text: id }],
  mentionedConnectionAccount: false,
  time: '',
  occurredAt,
  resources: [],
})
const turn = (n: number, extra: Record<string, unknown> = {}) =>
  ({ turn: n, state: 'completed', producedReply: true, responseState: 'sent', steps: [], ...extra }) as never

describe('buildTimeline', () => {
  it('groups consecutive messages from the same author and inserts day separators', () => {
    const items = buildTimeline(
      [message('a', '阿青', NOW - 86_400_000), message('b', '阿青', NOW - 60_000), message('c', '阿青', NOW - 30_000), message('d', '柚子', NOW - 10_000)],
      [],
      NOW,
    )
    expect(items.map((item) => (item.kind === 'message' ? `${item.key}:${item.continued}` : item.kind === 'day' ? item.label : 'turn'))).toEqual([
      '昨天',
      'a:false',
      '今天',
      'b:false',
      'c:true',
      'd:false',
    ])
  })

  it('places timed turns after the last earlier message', () => {
    const items = buildTimeline([message('a', '阿青', NOW - 3000), message('b', '小奈', NOW - 1000, 'agent')], [turn(1, { startedAt: NOW - 2000 })], NOW)
    expect(items.filter((item) => item.kind !== 'day').map((item) => item.key)).toEqual(['a', 'turn:1', 'b'])
  })

  it('shows only the latest turn at the end when turns carry no timing', () => {
    const items = buildTimeline([message('a', '阿青', NOW - 3000)], [turn(1), turn(2)], NOW)
    expect(items.at(-1)).toMatchObject({ kind: 'turn', key: 'turn:2', latest: true })
    expect(items.filter((item) => item.kind === 'turn')).toHaveLength(1)
  })
})

describe('presentToolInput', () => {
  it('shows the text a messaging tool sent, even from a truncated preview', () => {
    const preview = '{"target":{"type":"current"},"parts":[{"type":"text","text":"诶？\\n我在的"}],"replyTo":"msg_01…'
    expect(presentToolInput(preview, true)).toEqual({ message: '诶？\n我在的' })
  })

  it('turns JSON objects into fields and keeps other text', () => {
    expect(presentToolInput('{"query":"暗色仪表盘","limit":5}', false)).toEqual({ fields: [['query', '暗色仪表盘'], ['limit', '5']] })
    expect(presentToolInput('example.com/notes', false)).toEqual({ raw: 'example.com/notes' })
    expect(presentToolInput(undefined, false)).toBeUndefined()
  })
})

describe('relative time labels', () => {
  it('uses short relative labels', () => {
    expect(relativeTime(NOW - 30_000, NOW)).toBe('刚刚')
    expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe('5 分钟前')
    expect(relativeTime(NOW - 86_400_000, NOW)).toBe('昨天')
    expect(dayLabel(NOW, NOW)).toBe('今天')
  })
})
