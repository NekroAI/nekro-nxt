import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { appendedMessageIds, ChannelMessageList, isBubblelessMessage, MessageRow } from '../src/pages/channel-page.js'
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

  it('MessageRow renders perspective without a redundant sent confirmation', () => {
    const markup = renderToStaticMarkup(
      <MessageRow
        message={message({ id: 'msg_a', role: 'agent', author: '小奈', delivery: '已发送' })}
        side="left"
        incoming={false}
      />,
    )
    expect(markup).toContain('data-side="left"')
    expect(markup).toContain('<strong>小奈</strong>')
    expect(markup).not.toContain('已发送')
  })

  it('uses the same safe Markdown renderer for left and right message text', () => {
    const left = renderToStaticMarkup(
      <MessageRow
        message={message({ id: 'msg_left', parts: [{ type: 'text', text: '**统一 Markdown**' }] })}
        side="left"
        incoming={false}
      />,
    )
    const right = renderToStaticMarkup(
      <MessageRow
        message={message({ id: 'msg_right', parts: [{ type: 'text', text: '**统一 Markdown**' }] })}
        side="right"
        incoming={false}
      />,
    )
    expect(left).toContain('<strong>统一 Markdown</strong>')
    expect(right).toContain('<strong>统一 Markdown</strong>')
  })

  it('renders channel activities as compact system rows instead of member messages', () => {
    const markup = renderToStaticMarkup(
      <MessageRow
        message={message({
          id: 'msg_joined',
          role: 'system',
          author: '频道事件',
          activityType: 'member-joined',
          parts: [
            { type: 'mention', memberId: 'member_a', displayName: '新成员' },
            { type: 'text', text: ' 受 ' },
            { type: 'mention', memberId: 'member_b', displayName: '邀请人' },
            { type: 'text', text: ' 邀请加入了频道。' },
          ],
        })}
        side="system"
        incoming={false}
      />,
    )

    expect(markup).toContain('data-side="system"')
    expect(markup).toContain('data-activity-type="member-joined"')
    expect(markup).toContain('data-system-event-content')
    expect(markup).toContain('新成员')
    expect(markup).toContain('邀请人')
    expect(markup).not.toContain('19:30')
    expect(markup).toContain('<svg')
    expect(markup).not.toContain('<article')
    expect(markup).not.toContain('data-message-bubble')
    expect(markup).not.toContain('频道事件')
  })

  it('removes the outer bubble only for one standalone rendered block', () => {
    expect(
      isBubblelessMessage(message({ parts: [{ type: 'image', assetId: 'asset_a', alt: '图片', url: '/a.png' }] })),
    ).toBe(true)
    expect(
      isBubblelessMessage(
        message({ parts: [{ type: 'rich', adapterKey: 'sample', kind: 'card', summary: '卡片摘要' }] }),
      ),
    ).toBe(true)
    expect(
      isBubblelessMessage(message({ parts: [{ type: 'mention', memberId: 'member_a', displayName: '成员甲' }] })),
    ).toBe(false)
    expect(
      isBubblelessMessage(
        message({
          parts: [
            { type: 'text', text: '请看' },
            { type: 'image', assetId: 'asset_a', alt: '图片', url: '/a.png' },
          ],
        }),
      ),
    ).toBe(false)
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
