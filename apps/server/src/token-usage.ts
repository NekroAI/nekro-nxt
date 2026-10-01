import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { ChannelRuntimeUsage } from '@nekro-nxt/contracts'

const OPTIONAL_USAGE_KEYS = ['totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const

/**
 * Project DSH usage onto the product contract. Provider extensions must not leak onto the wire, and
 * `totalTokens` is only carried when DSH supplied it: `inputTokens` excludes cache reads and writes.
 */
export const projectTokenUsage = (usage: TokenUsage): ChannelRuntimeUsage => {
  const projected: { -readonly [Key in keyof ChannelRuntimeUsage]: ChannelRuntimeUsage[Key] } = {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  }
  for (const key of OPTIONAL_USAGE_KEYS) {
    const value = usage[key]
    if (value !== undefined) projected[key] = value
  }
  return projected
}

/** Sum two model calls. An exact total survives only when both calls reported one. */
export const mergeTokenUsage = (
  left: TokenUsage | undefined,
  right: TokenUsage | undefined,
): TokenUsage | undefined => {
  if (left === undefined) return right
  if (right === undefined) return left
  const merged: TokenUsage = {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
  }
  if (left.totalTokens !== undefined && right.totalTokens !== undefined) {
    merged.totalTokens = left.totalTokens + right.totalTokens
  }
  for (const key of ['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const) {
    if (left[key] !== undefined || right[key] !== undefined) merged[key] = (left[key] ?? 0) + (right[key] ?? 0)
  }
  return merged
}
