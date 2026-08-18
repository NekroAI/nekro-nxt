import { describe, expect, it } from 'vitest'
import { NonEmptyMessagePartsSchema, parseMessageParts } from '../src/index.ts'

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
})
