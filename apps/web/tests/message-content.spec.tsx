import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MessageContent, resolveMessageSide } from '../src/pages/message-content.js'
import type { ConversationMessage } from '../src/product-store.js'

const message = (parts: ConversationMessage['parts']): ConversationMessage => ({
  id: 'msg_markdown',
  channelId: 'chn_markdown',
  author: '成员甲',
  role: 'member',
  body: '',
  parts,
  mentionedConnectionAccount: false,
  time: '19:30',
  resources: [],
})

describe('message perspective', () => {
  it('keeps the two channel perspectives explicit', () => {
    expect(resolveMessageSide({ channelKind: 'web', role: 'member' })).toBe('right')
    expect(resolveMessageSide({ channelKind: 'web', role: 'agent' })).toBe('left')
    expect(resolveMessageSide({ channelKind: 'qq-group', role: 'member' })).toBe('left')
    expect(resolveMessageSide({ channelKind: 'qq-direct', role: 'agent' })).toBe('right')
    expect(resolveMessageSide({ channelKind: 'qq-group', role: 'agent', origin: 'admin-console' })).toBe('right')
    expect(resolveMessageSide({ channelKind: 'web', role: 'system' })).toBe('system')
  })
})

describe('MessageContent', () => {
  it('renders GFM safely and preserves structured part order', () => {
    const markup = renderToStaticMarkup(
      <MessageContent
        message={message([
          {
            type: 'text',
            text: '# 标题\n\n- 项目\n\n| 名称 | 值 |\n| --- | --- |\n| A | 1 |\n\n[外链](https://example.com)',
          },
          { type: 'image', assetId: 'ast_image', alt: '示意图', url: '/api/channels/chn_markdown/assets/ast_image' },
          { type: 'text', text: '**结束**\n\n<script>alert(1)</script>' },
        ])}
      />,
    )

    expect(markup).toContain('<h1>标题</h1>')
    expect(markup).toContain('<table>')
    expect(markup).toContain('target="_blank"')
    expect(markup).toContain('rel="noopener noreferrer"')
    expect(markup).not.toContain('<script>')
    expect(markup).not.toContain('alert(1)')
    expect(markup.indexOf('示意图')).toBeLessThan(markup.indexOf('<strong>结束</strong>'))
  })

  it('renders Mention chips inline with surrounding text and does not prefix the connection account', () => {
    const markup = renderToStaticMarkup(
      <MessageContent
        message={{
          ...message([
            { type: 'mention', memberId: 'mbr_bot', displayName: '机器人账号' },
            { type: 'text', text: '请和' },
            { type: 'mention', memberId: 'member_b', displayName: '成员乙' },
            { type: 'text', text: '一起复核。' },
            { type: 'image', assetId: 'ast_image', alt: '示意图', url: '/api/channels/chn_markdown/assets/ast_image' },
          ]),
          mentionedConnectionAccount: true,
        }}
      />,
    )

    expect(markup.split('机器人账号')).toHaveLength(2)
    expect(markup.indexOf('机器人账号')).toBeLessThan(markup.indexOf('请和'))
    expect(markup.indexOf('请和')).toBeLessThan(markup.indexOf('成员乙'))
    expect(markup.indexOf('成员乙')).toBeLessThan(markup.indexOf('一起复核'))
    expect(markup.indexOf('一起复核')).toBeLessThan(markup.indexOf('示意图'))
  })

  it('drops unsafe Markdown link protocols', () => {
    const markup = renderToStaticMarkup(
      <MessageContent message={message([{ type: 'text', text: '[危险链接](javascript:alert(1))' }])} />,
    )
    expect(markup).not.toContain('javascript:')
  })
})
