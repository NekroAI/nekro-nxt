import { describe, expect, it } from 'vitest'
import { parseMessageParts } from '../src/index.ts'

describe('MessagePart boundary', () => {
  it('preserves ordered structured content', () => {
    expect(
      parseMessageParts([
        { type: 'text', text: '你好 ' },
        { type: 'mention', memberId: 'member-1' },
        { type: 'file', assetId: 'asset-video', name: 'clip.mp4' },
      ]),
    ).toEqual([
      { type: 'text', text: '你好 ' },
      { type: 'mention', memberId: 'member-1' },
      { type: 'file', assetId: 'asset-video', name: 'clip.mp4' },
    ])
  })

  it('rejects empty messages, unknown parts and path-shaped media fields', () => {
    expect(() => parseMessageParts([])).toThrow()
    expect(() => parseMessageParts([{ type: 'video', assetId: 'asset-1' }])).toThrow()
    expect(() => parseMessageParts([{ type: 'image', path: '/tmp/image.png' }])).toThrow()
  })
})
