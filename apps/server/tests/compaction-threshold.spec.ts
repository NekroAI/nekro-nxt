import { describe, expect, it } from 'vitest'
import { effectiveCompactionThreshold } from '../src/compaction-threshold.js'
import { parseThresholdRequest, runThresholdRequest } from '../src/commands/threshold.js'
import type { CompactionThresholdCall, CompactionThresholdState } from '../src/commands/types.js'

describe('effective compaction threshold', () => {
  it('prefers the conversation override, then the agent setting, then the default', () => {
    expect(effectiveCompactionThreshold({ contextWindow: 1_000_000 })).toEqual({ ratio: 0.8, source: 'default' })
    expect(effectiveCompactionThreshold({ setting: 0.5, contextWindow: 1_000_000 })).toEqual({
      ratio: 0.5,
      source: 'agent',
    })
    expect(effectiveCompactionThreshold({ override: 0.3, setting: 0.5, contextWindow: 1_000_000 })).toEqual({
      ratio: 0.3,
      source: 'session',
    })
  })

  it('holds a saved setting to the window of the model in use, which may have changed since', () => {
    expect(effectiveCompactionThreshold({ setting: 0.2, contextWindow: 128_000 })).toEqual({
      ratio: 0.5,
      source: 'agent',
      clamped: 'min',
    })
    // The default is never narrowed, so agents without a setting behave as before.
    expect(effectiveCompactionThreshold({ contextWindow: 64_000 })).toEqual({ ratio: 0.8, source: 'default' })
  })
})

describe('/threshold', () => {
  it('reads percentages, keywords and nothing, and rejects anything else', () => {
    expect(parseThresholdRequest(undefined)).toEqual({ kind: 'show' })
    expect(parseThresholdRequest('40%')).toEqual({ kind: 'set', ratio: 0.4 })
    expect(parseThresholdRequest('40')).toEqual({ kind: 'set', ratio: 0.4 })
    expect(parseThresholdRequest('45％')).toEqual({ kind: 'set', ratio: 0.45 })
    expect(parseThresholdRequest('MAX')).toEqual({ kind: 'max' })
    expect(parseThresholdRequest('min')).toEqual({ kind: 'min' })
    expect(parseThresholdRequest('reset')).toEqual({ kind: 'reset' })
    for (const bad of ['abc', '0', '150%', '-5'])
      expect(() => parseThresholdRequest(bad)).toThrow('可以写百分比（如 40%）、max、min 或 reset')
  })

  const call = (state: Omit<CompactionThresholdState, 'hasConversation'>) => {
    const sets: (number | undefined)[] = []
    const value: CompactionThresholdCall = {
      read: () => Promise.resolve({ ...state, hasConversation: true }),
      set: (ratio) => {
        sets.push(ratio)
      },
    }
    return { value, sets }
  }

  it('sets the conversation threshold and says when it returns', async () => {
    const c = call({ contextWindow: 1_280_000 })
    expect(await runThresholdRequest({ kind: 'set', ratio: 0.4 }, c.value)).toBe(
      '这次对话改为上下文的 40%（约 51 万 token）时压缩，下次压缩后恢复为 80%。',
    )
    expect(c.sets).toEqual([0.4])
  })

  it('tells the user when a value was held to a bound', async () => {
    const c = call({ contextWindow: 200_000, setting: 0.6 })
    expect(await runThresholdRequest({ kind: 'set', ratio: 0.2 }, c.value)).toBe(
      '当前模型最低只能设到 35%。这次对话改为上下文的 35%（约 7 万 token）时压缩，下次压缩后恢复为 60%。',
    )
    expect(await runThresholdRequest({ kind: 'set', ratio: 0.95 }, c.value)).toBe(
      '最高只能设到 90%。这次对话改为上下文的 90%（约 18 万 token）时压缩，下次压缩后恢复为 60%。',
    )
    await runThresholdRequest({ kind: 'min' }, c.value)
    await runThresholdRequest({ kind: 'max' }, c.value)
    expect(c.sets).toEqual([0.35, 0.9, 0.35, 0.9])
  })

  it('shows the threshold in force, the agent setting and the range, and resets to the setting', async () => {
    expect(await runThresholdRequest({ kind: 'show' }, call({ contextWindow: 1_000_000 }).value)).toBe(
      '这次对话按智能体设置（默认的 80%），在上下文的 80%（约 80 万 token）时压缩；可调范围 20%–90%。',
    )
    expect(
      await runThresholdRequest(
        { kind: 'show' },
        call({ contextWindow: 1_000_000, setting: 0.5, override: 0.3 }).value,
      ),
    ).toBe('这次对话在上下文的 30%（约 30 万 token）时压缩，下次压缩后恢复为智能体设置的 50%；可调范围 20%–90%。')
    const c = call({ setting: 0.5 })
    expect(await runThresholdRequest({ kind: 'reset' }, c.value)).toBe(
      '这次对话恢复为智能体设置，在上下文的 50% 时压缩。',
    )
    expect(c.sets).toEqual([undefined])
  })
})
