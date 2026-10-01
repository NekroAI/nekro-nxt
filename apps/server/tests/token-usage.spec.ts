import { ChannelRuntimeUsageSchema } from '@nekro-nxt/contracts'
import { describe, expect, it } from 'vitest'
import { mergeTokenUsage, projectTokenUsage } from '../src/token-usage.ts'

describe('token usage projection', () => {
  it('keeps contract fields and drops provider extensions', () => {
    const usage = { inputTokens: 100, outputTokens: 20, totalTokens: 920, cacheReadTokens: 800, providerExtra: 'x' }
    // Snapshot image diagnostics and runtime steps share this strict contract.
    expect(() => ChannelRuntimeUsageSchema.parse(usage)).toThrow()
    expect(ChannelRuntimeUsageSchema.parse(projectTokenUsage(usage))).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 920,
      cacheReadTokens: 800,
    })
  })

  it('keeps an exact total only when both merged calls reported one', () => {
    expect(
      mergeTokenUsage(
        { inputTokens: 1, outputTokens: 2, totalTokens: 3, cacheReadTokens: 4 },
        { inputTokens: 5, outputTokens: 6, totalTokens: 11 },
      ),
    ).toEqual({ inputTokens: 6, outputTokens: 8, totalTokens: 14, cacheReadTokens: 4 })
    expect(
      mergeTokenUsage({ inputTokens: 1, outputTokens: 2, totalTokens: 3 }, { inputTokens: 5, outputTokens: 6 }),
    ).toEqual({ inputTokens: 6, outputTokens: 8 })
    expect(mergeTokenUsage(undefined, { inputTokens: 1, outputTokens: 1 })).toEqual({ inputTokens: 1, outputTokens: 1 })
  })
})
