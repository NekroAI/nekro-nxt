import type { ChannelRuntimeUsage } from '@nekro-nxt/contracts'

/** Full-call tokens. DSH `inputTokens` excludes cache reads and writes, so add them back when no total is reported. */
export const usageTotalTokens = (usage: ChannelRuntimeUsage): number =>
  usage.totalTokens ??
  usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) + usage.outputTokens
