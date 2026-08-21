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

  it('opens images with an in-app preview trigger instead of a new window', () => {
    const markup = renderToStaticMarkup(
      <MessageContent
        message={message([
          { type: 'image', assetId: 'ast_image', alt: '示意图', url: '/api/channels/chn_markdown/assets/ast_image' },
        ])}
      />,
    )
    expect(markup).toContain('type="button"')
    expect(markup).toContain('示意图')
    expect(markup).not.toContain('target="_blank"')
  })

  it('renders forwarded chat records as a preview card instead of raw dump text', () => {
    const markup = renderToStaticMarkup(
      <MessageContent
        message={message([
          {
            type: 'rich',
            adapterKey: 'qq-openclaw',
            kind: 'forward',
            summary: '群聊的聊天记录（3 条）',
            title: '群聊的聊天记录',
            items: [
              { sender: '成员甲', text: '你好' },
              {
                sender: '成员甲',
                card: { summary: '示例来源 · 示例分享', title: '示例分享', source: '示例来源' },
              },
            ],
          },
        ])}
      />,
    )
    expect(markup).toContain('群聊的聊天记录 · 2 条')
    expect(markup).toContain('你好')
    expect(markup).toContain('示例来源')
    expect(markup).not.toContain('群聊的聊天记录（3 条）')
    expect(markup).not.toContain('[群聊的聊天记录]')
    expect(markup).not.toContain('=== 消息')
  })

  it('renders a host fallback card for rich parts', () => {
    const markup = renderToStaticMarkup(
      <MessageContent
        message={message([
          {
            type: 'rich',
            adapterKey: 'qq-openclaw',
            kind: 'miniapp',
            summary: '示例来源 · 示例分享',
            title: '示例分享',
            source: '示例来源',
            previewUrl: '/api/channels/chn_markdown/assets/ast_preview',
          },
        ])}
      />,
    )
    expect(markup).toContain('示例来源')
    expect(markup).toContain('示例分享')
    expect(markup).toContain('/api/channels/chn_markdown/assets/ast_preview')
    expect(markup).not.toContain('source_logo')
    expect(markup).not.toContain('https://')
  })

  it('drops unsafe Markdown link protocols', () => {
    const markup = renderToStaticMarkup(
      <MessageContent message={message([{ type: 'text', text: '[危险链接](javascript:alert(1))' }])} />,
    )
    expect(markup).not.toContain('javascript:')
  })

  it('renders preview and file triggers as accessible ui-kit buttons', () => {
    const markup = renderToStaticMarkup(
      <MessageContent
        message={message([
          {
            type: 'rich',
            adapterKey: 'qq-openclaw',
            kind: 'miniapp',
            summary: '示例来源 · 示例分享',
            title: '示例分享',
            source: '示例来源',
            previewUrl: '/api/channels/chn_markdown/assets/ast_preview',
          },
          { type: 'image', assetId: 'ast_pic', alt: '现场照片', url: '/api/channels/chn_markdown/assets/ast_pic' },
          { type: 'file', assetId: 'ast_file', name: '报告.pdf', url: '/api/channels/chn_markdown/assets/ast_file' },
        ])}
      />,
    )

    const buttons = markup.split('<button').length - 1
    expect(buttons).toBe(3)
    expect(markup).toContain('type="button"')
    expect(markup).toContain('<button')
    expect(markup).toContain('现场照片')
    expect(markup).toContain('报告.pdf')
    expect(markup.indexOf('示例分享')).toBeLessThan(markup.indexOf('现场照片'))
    expect(markup.indexOf('现场照片')).toBeLessThan(markup.indexOf('报告.pdf'))
  })
})
