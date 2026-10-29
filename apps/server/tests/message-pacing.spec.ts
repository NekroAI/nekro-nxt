import {
  AssetIdSchema,
  CompactionSettingsSchema,
  DEFAULT_COMPACTION_SETTINGS,
  type JsonValue,
  type MessagePart,
} from '@nekro-nxt/contracts'
import { describe, expect, it } from 'vitest'
import { readCompactionSettings, writeCompactionSettings } from '../src/compaction-settings.ts'
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

describe('compaction settings', () => {
  it('defaults to the main model and three minutes, and keeps what the admin saved', () => {
    const rows = new Map<string, { value: JsonValue; revision: number }>()
    const settings = {
      get: (key: string) => rows.get(key),
      put: (key: string, value: JsonValue) => {
        rows.set(key, { value, revision: (rows.get(key)?.revision ?? 0) + 1 })
      },
    }
    expect(readCompactionSettings(settings)).toEqual(DEFAULT_COMPACTION_SETTINGS)
    const saved = {
      newSessionModel: {
        mode: 'custom' as const,
        model: { provider: 'fixture', model: 'fast', reasoningEffort: 'low' },
      },
      timeoutSeconds: 300,
      idleThresholdPercent: 60,
    }
    writeCompactionSettings(settings, saved)
    expect(readCompactionSettings(settings)).toEqual(saved)
    const legacy = { newSessionModel: saved.newSessionModel, timeoutSeconds: saved.timeoutSeconds }
    rows.set('channel.compaction', { value: legacy, revision: 8 })
    expect(readCompactionSettings(settings)).toEqual({ ...saved, idleThresholdPercent: 50 })
    rows.set('channel.compaction', { value: { timeoutSeconds: 5 }, revision: 9 })
    expect(readCompactionSettings(settings).timeoutSeconds).toBe(180)
  })

  it('accepts integer percentages outside the recommendation but rejects invalid values', () => {
    for (const idleThresholdPercent of [1, 30, 50, 60, 100]) {
      expect(CompactionSettingsSchema.safeParse({ ...DEFAULT_COMPACTION_SETTINGS, idleThresholdPercent }).success).toBe(
        true,
      )
    }
    for (const idleThresholdPercent of [0, 101, 49.5, '50', null]) {
      expect(CompactionSettingsSchema.safeParse({ ...DEFAULT_COMPACTION_SETTINGS, idleThresholdPercent }).success).toBe(
        false,
      )
    }
  })
})
