import { describe, expect, it } from 'vitest'
import {
  AssetIdSchema,
  ChannelMemberIdSchema,
  LogicalMessageIdSchema,
  messagePartAssetId,
  messagePartAssetIds,
  messagePartsSearchText,
  NonEmptyMessagePartsSchema,
  parseMessageParts,
  richPartContextText,
} from '../src/index.ts'

describe('MessagePart boundary', () => {
  it('preserves ordered structured content', () => {
    expect(
      parseMessageParts([
        { type: 'text', text: '你好 ' },
        { type: 'mention', memberId: 'mbr_1' },
        { type: 'file', assetId: 'ast_VIDEO', name: 'clip.mp4' },
      ]),
    ).toEqual([
      { type: 'text', text: '你好 ' },
      { type: 'mention', memberId: 'mbr_1' },
      { type: 'file', assetId: 'ast_VIDEO', name: 'clip.mp4' },
    ])
  })

  it('allows empty inbound facts while outbound messages stay non-empty', () => {
    expect(parseMessageParts([])).toEqual([])
    expect(() => NonEmptyMessagePartsSchema.parse([])).toThrow()
  })

  it('rejects unknown parts and path-shaped media fields', () => {
    expect(() => parseMessageParts([{ type: 'video', assetId: 'ast_1' }])).toThrow()
    expect(() => parseMessageParts([{ type: 'image', path: '/tmp/image.png' }])).toThrow()
  })

  it('accepts rich parts with a required summary and rejects oversized extension payloads', () => {
    expect(
      parseMessageParts([
        {
          type: 'rich',
          adapterKey: 'qq-openclaw',
          kind: 'miniapp',
          summary: '示例来源 · 示例分享',
          title: '示例分享',
          source: '示例来源',
          targetUrl: 'https://example.test/share?id=1',
          previewAssetId: 'ast_preview1',
          extension: { preview: 'https://example.test/preview' },
        },
      ]),
    ).toEqual([
      {
        type: 'rich',
        adapterKey: 'qq-openclaw',
        kind: 'miniapp',
        summary: '示例来源 · 示例分享',
        title: '示例分享',
        source: '示例来源',
        targetUrl: 'https://example.test/share?id=1',
        previewAssetId: 'ast_preview1',
        extension: { preview: 'https://example.test/preview' },
      },
    ])
    expect(() =>
      parseMessageParts([
        {
          type: 'rich',
          adapterKey: 'qq-openclaw',
          kind: 'miniapp',
          summary: '摘要',
          extension: { dump: 'x'.repeat(40_000) },
        },
      ]),
    ).toThrow(/32768 bytes/u)
    expect(() =>
      parseMessageParts([
        {
          type: 'rich',
          adapterKey: 'qq-openclaw',
          kind: 'miniapp',
          summary: '摘要',
          targetUrl: 'javascript:alert(1)',
        },
      ]),
    ).toThrow(/HTTP or HTTPS/u)
    expect(
      messagePartsSearchText([
        { type: 'text', text: '你好' },
        { type: 'rich', adapterKey: 'qq-openclaw', kind: 'miniapp', summary: '示例来源 · 标题', title: '标题' },
      ]),
    ).toBe('你好\n示例来源 · 标题\n标题')
    expect(
      messagePartsSearchText([
        {
          type: 'rich',
          adapterKey: 'qq-openclaw',
          kind: 'forward',
          summary: '群聊的聊天记录（2 条）',
          title: '群聊的聊天记录',
          extension: {
            items: [
              { sender: '成员甲', text: '你好' },
              { sender: '成员甲', imageAssetId: 'ast_nested1', imageName: 'photo.png' },
            ],
          },
        },
      ]),
    ).toBe('群聊的聊天记录（2 条）\n群聊的聊天记录\n成员甲：你好\n成员甲：[图片 photo.png]')
  })

  it('collects nested rich assets and flattens every supported rich item shape', () => {
    const [part] = parseMessageParts([
      {
        type: 'rich',
        adapterKey: 'qq-openclaw',
        kind: 'forward',
        summary: '合成转发',
        extension: {
          imageAssetId: 'ast_root',
          ignoredAssetId: 'ast_ignored',
          invalid: { previewAssetId: 'not-an-asset' },
          values: [null, true, 1, 'plain', { previewAssetId: 'ast_nested' }],
          items: [
            null,
            {},
            { text: '无发送者文本' },
            { sender: '成员乙', card: { summary: '卡片摘要' } },
            { sender: '成员丙', card: { title: '卡片标题' } },
            { imageAssetId: 'ast_image' },
          ],
        },
      },
    ])
    if (part?.type !== 'rich') throw new Error('Expected one rich message part.')

    expect(messagePartAssetIds(part)).toEqual(['ast_root', 'ast_nested', 'ast_image'])
    expect(messagePartAssetId(part)).toBe('ast_root')
    expect(richPartContextText(part)).toBe(
      ['合成转发', '无发送者文本', '成员乙：[卡片] 卡片摘要', '成员丙：[卡片] 卡片标题', '[图片]'].join('\n'),
    )
    expect(messagePartAssetId({ type: 'text', text: 'plain' })).toBeUndefined()
    expect(messagePartAssetIds({ type: 'image', assetId: AssetIdSchema.parse('ast_image') })).toEqual(['ast_image'])
    expect(messagePartAssetIds({ type: 'file', assetId: AssetIdSchema.parse('ast_file') })).toEqual(['ast_file'])
    expect(messagePartAssetIds({ type: 'audio', assetId: AssetIdSchema.parse('ast_audio') })).toEqual(['ast_audio'])
    expect(messagePartAssetIds({ type: 'mention', memberId: ChannelMemberIdSchema.parse('mbr_member') })).toEqual([])
    expect(messagePartAssetIds({ type: 'quote', messageId: LogicalMessageIdSchema.parse('msg_quote') })).toEqual([])
  })
})
