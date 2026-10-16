import type { ChannelId, JsonValue } from '@nekro-nxt/contracts'
import { z } from 'zod'

const StoredReasoningSchema = z
  .object({
    version: z.literal(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    effort: z.string().min(1).nullable(),
  })
  .strict()

export interface ReasoningSettingsStore {
  getSystemSetting(key: string): { readonly value: JsonValue; readonly revision: number } | undefined
  putSystemSetting(key: string, value: JsonValue, expectedRevision: number | undefined, updatedAt: number): unknown
}

const settingKey = (channelId: ChannelId) => `channel-reasoning:${channelId}`

export const readChannelReasoning = (
  store: ReasoningSettingsStore,
  channelId: ChannelId,
  provider: string,
  model: string,
) => {
  const record = store.getSystemSetting(settingKey(channelId))
  const stored = record ? StoredReasoningSchema.parse(record.value) : undefined
  return {
    effort: stored?.provider === provider && stored.model === model ? stored.effort : null,
    revision: record?.revision ?? null,
  }
}

export const saveChannelReasoning = (
  store: ReasoningSettingsStore,
  channelId: ChannelId,
  input: {
    readonly provider: string
    readonly model: string
    readonly effort: string | null
    readonly expectedRevision: number | null
  },
): void => {
  store.putSystemSetting(
    settingKey(channelId),
    { version: 1, provider: input.provider, model: input.model, effort: input.effort },
    input.expectedRevision ?? undefined,
    Date.now(),
  )
}

export const supportedReasoningEffort = (
  effort: string | null | undefined,
  reasoning: { readonly efforts: readonly { readonly id: string }[] } | undefined,
): string | undefined => (reasoning?.efforts.some((entry) => entry.id === effort) ? (effort ?? undefined) : undefined)
