import { describe, expect, it } from 'vitest'
import { groupChannelMessages, mergeChannelMessages } from '../src/channel-messages.js'
import type { ConversationMessage } from '../src/product-model.js'
const message = (id: string, time: number, channelId = 'a'): ConversationMessage => ({
  id,
  channelId,
  occurredAt: time,
  author: '成员甲',
  role: 'member',
  body: id,
  parts: [{ type: 'text', text: id }],
  mentionedConnectionAccount: false,
  resources: [],
  time: '12:00',
})
describe('channel message projections', () => {
  it('keeps unchanged rows and arrays stable through append, replay and edits', () => {
    const old = [message('a', 2), message('b', 3)]
    expect(
      mergeChannelMessages(
        old,
        old.map((row) => ({ ...row })),
      ),
    ).toBe(old)
    const appended = mergeChannelMessages(old, [message('c', 4)])
    expect(appended[0]).toBe(old[0])
    expect(appended.map((row) => row.id)).toEqual(['a', 'b', 'c'])
    const edited = mergeChannelMessages(appended, [{ ...appended[1]!, delivery: '失败' }])
    expect(edited[0]).toBe(old[0])
    expect(edited[1]?.delivery).toBe('失败')
    expect(mergeChannelMessages(edited, [message('older', 1)]).map((row) => row.id)).toEqual(['older', 'a', 'b', 'c'])
  })
  it('updates one channel without touching another', () => {
    const before = groupChannelMessages([message('a', 1), message('b', 1, 'b')])
    const after: typeof before = { ...before, b: mergeChannelMessages(before['b']!, [message('b2', 2, 'b')]) }
    expect(after['a']).toBe(before['a'])
    expect(after['b']).not.toBe(before['b'])
  })
})
