import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { appendedMessageIds, ChannelMessageList, MessageRow } from '../src/pages/channel-page.js'
import type { ChannelHistoryState, ConversationMessage } from '../src/product-store.js'

const message = (overrides: Partial<ConversationMessage> = {}): ConversationMessage => ({
  id: 'msg_1',
  channelId: 'chn_web',
  author: '成员甲',
  role: 'member',
  body: '你好',
  parts: [{ type: 'text', text: '你好' }],
  mentionedConnectionAccount: false,
  time: '19:30',
  resources: [],
  ...overrides,
})

const loadedHistory: ChannelHistoryState = {
  loaded: true,
  loading: false,
  loadingMore: false,
  hasMore: false,
  error: '',
}

const memoType = Symbol.for('react.memo')

describe('channel message memoization boundary', () => {
  it('animates appended messages but treats prepended history as already read', () => {
    const known = new Set(['msg_2', 'msg_3'])
    expect([...appendedMessageIds([{ id: 'msg_1' }, { id: 'msg_2' }, { id: 'msg_3' }], known)]).toEqual([])
    expect([...appendedMessageIds([{ id: 'msg_2' }, { id: 'msg_3' }, { id: 'msg_4' }], known)]).toEqual(['msg_4'])
  })

  it('wraps the list and each row in React.memo so stale rows skip re-rendering', () => {
    expect((MessageRow as { $$typeof: symbol }).$$typeof).toBe(memoType)
    expect((ChannelMessageList as { $$typeof: symbol }).$$typeof).toBe(memoType)
  })

  it('MessageRow renders one message with its perspective and delivery', () => {
    const markup = renderToStaticMarkup(
      <MessageRow
        message={message({ id: 'msg_a', role: 'agent', author: '小奈', delivery: '已发送' })}
        side="left"
        incoming={false}
      />,
    )
    expect(markup).toContain('data-side="left"')
    expect(markup).toContain('<strong>小奈</strong>')
    expect(markup).toContain('已发送')
  })

  it('ChannelMessageList renders channel messages in order without history notices', () => {
    const markup = renderToStaticMarkup(
      <ChannelMessageList
        channelId="chn_web"
        channelKind="web"
        history={loadedHistory}
        messages={[
          message({ id: 'msg_1', role: 'member', author: '成员甲', body: '你好' }),
          message({ id: 'msg_2', role: 'agent', author: '小奈', body: '收到', delivery: '已发送' }),
        ]}
      />,
    )
    expect(markup).toContain('成员甲')
    expect(markup.indexOf('成员甲')).toBeLessThan(markup.indexOf('小奈'))
    expect(markup).not.toContain('正在读取最近消息')
    expect(markup).not.toContain('还没有消息')
  })

  it('shows the empty state before any message exists', () => {
    const markup = renderToStaticMarkup(
      <ChannelMessageList channelId="chn_web" channelKind="web" history={loadedHistory} messages={[]} />,
    )
    expect(markup).toContain('还没有消息')
  })
})
