import { describe, expect, it } from 'vitest'
import {
  clampCompactionThreshold,
  compactionThresholdBounds,
  compactionThresholdSteps,
  CompactionThresholdRatioSchema,
  formatThresholdPercent,
  formatTokensInWan,
} from '../src/index.js'

describe('compaction threshold bounds', () => {
  it('starts at 20 % on large windows and rises to keep 64k tokens on small ones, on whole steps', () => {
    expect(compactionThresholdBounds(1_000_000)).toEqual({ min: 0.2, max: 0.9 })
    expect(compactionThresholdBounds(320_000)).toEqual({ min: 0.2, max: 0.9 })
    // 64k of 200k is 32 %, rounded up to the next step.
    expect(compactionThresholdBounds(200_000)).toEqual({ min: 0.35, max: 0.9 })
    expect(compactionThresholdBounds(128_000)).toEqual({ min: 0.5, max: 0.9 })
    // A window too small for the minimum allows only the maximum.
    expect(compactionThresholdBounds(64_000)).toEqual({ min: 0.9, max: 0.9 })
    expect(compactionThresholdBounds(undefined)).toEqual({ min: 0.2, max: 0.9 })
  })

  it('holds a value to the bounds of the current window and says which one it hit', () => {
    expect(clampCompactionThreshold(0.4, 1_000_000)).toEqual({ ratio: 0.4 })
    expect(clampCompactionThreshold(0.1, 1_000_000)).toEqual({ ratio: 0.2, clamped: 'min' })
    expect(clampCompactionThreshold(0.3, 200_000)).toEqual({ ratio: 0.35, clamped: 'min' })
    expect(clampCompactionThreshold(0.95, 200_000)).toEqual({ ratio: 0.9, clamped: 'max' })
    expect(clampCompactionThreshold(0.35, 200_000)).toEqual({ ratio: 0.35 })
  })

  it('lists every selectable step and stores only values inside the absolute bounds', () => {
    expect(compactionThresholdSteps(128_000)).toEqual([0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9])
    expect(compactionThresholdSteps(1_000_000)).toHaveLength(15)
    expect(CompactionThresholdRatioSchema.safeParse(0.2).success).toBe(true)
    expect(CompactionThresholdRatioSchema.safeParse(0.15).success).toBe(false)
    expect(CompactionThresholdRatioSchema.safeParse(0.95).success).toBe(false)
  })

  it('reads as a percentage and token counts in 万', () => {
    expect(formatThresholdPercent(0.35)).toBe('35%')
    expect(formatTokensInWan(512_000)).toBe('51')
    expect(formatTokensInWan(64_000)).toBe('6.4')
    expect(formatTokensInWan(1_000_000)).toBe('100')
  })
})
