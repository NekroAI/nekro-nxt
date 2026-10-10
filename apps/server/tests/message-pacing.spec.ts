import { AssetIdSchema, type JsonValue, type MessagePart } from '@nekro-nxt/contracts'
import { describe, expect, it } from 'vitest'
import { messageGapMs, readMessagePacing, writeMessagePacing } from '../src/message-pacing.ts'

const text = (value: string): MessagePart[] => [{ type: 'text', text: value }]

describe('message pacing', () => {
  it('grows with the text, stops at the preset cap and varies by ±30%', () => {
    expect(messageGapMs('normal', text(''), () => 0.5)).toBe(500)
    expect(messageGapMs('normal', text('一二三四五六七八九十'), () => 0.5)).toBe(750)
    expect(messageGapMs('normal', text('字'.repeat(500)), () => 0.5)).toBe(3000)
    expect(messageGapMs('normal', text(''), () => 0)).toBe(350)
    expect(messageGapMs('normal', text(''), () => 1)).toBe(650)
    expect(messageGapMs('fast', text('一二三四五六七八九十'), () => 0.5)).toBeLessThan(
      messageGapMs('slow', text('一二三四五六七八九十'), () => 0.5),
    )
    expect(messageGapMs('off', text('字'.repeat(50)), () => 1)).toBe(0)
  })

  it('counts only text toward the length', () => {
    const parts: MessagePart[] = [
      { type: 'text', text: '看这个' },
      { type: 'image', assetId: AssetIdSchema.parse('ast_IMAGE1') },
    ]
    expect(messageGapMs('normal', parts, () => 0.5)).toBe(575)
  })

  it('defaults to normal and keeps what the admin saved', () => {
    const rows = new Map<string, { value: JsonValue; revision: number }>()
    const settings = {
      get: (key: string) => rows.get(key),
      put: (key: string, value: JsonValue) => {
        rows.set(key, { value, revision: (rows.get(key)?.revision ?? 0) + 1 })
      },
    }
    expect(readMessagePacing(settings)).toBe('normal')
    writeMessagePacing(settings, 'off')
    expect(readMessagePacing(settings)).toBe('off')
    rows.set('channel.messagePacing', { value: { pacing: 'unknown' }, revision: 9 })
    expect(readMessagePacing(settings)).toBe('normal')
  })
})
