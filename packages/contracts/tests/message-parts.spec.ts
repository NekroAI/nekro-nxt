import { describe, expect, it } from 'vitest'
import { messagePartsSearchText, NonEmptyMessagePartsSchema, parseMessageParts } from '../src/index.ts'

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
})
