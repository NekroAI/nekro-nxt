import {
  DEFAULT_MESSAGE_PACING,
  MessagePacingSchema,
  type JsonValue,
  type MessagePacing,
  type MessagePart,
} from '@nekro-nxt/contracts'

const SETTING_KEY = 'channel.messagePacing'

/** Faster than typing on purpose: the pause only keeps a burst of messages from landing at once. */
const PRESETS: Readonly<
  Record<MessagePacing, { readonly baseMs: number; readonly perCharMs: number; readonly maxMs: number }>
> = {
  off: { baseMs: 0, perCharMs: 0, maxMs: 0 },
  fast: { baseMs: 300, perCharMs: 10, maxMs: 1500 },
  normal: { baseMs: 500, perCharMs: 25, maxMs: 3000 },
  slow: { baseMs: 800, perCharMs: 50, maxMs: 5000 },
}

/** Varies each pause by ±30% so a run of messages does not tick like a metronome. */
const JITTER = 0.3

export const messageGapMs = (
  pacing: MessagePacing,
  parts: readonly MessagePart[],
  random: () => number = Math.random,
): number => {
  const preset = PRESETS[pacing]
  if (preset.maxMs === 0) return 0
  const chars = parts.reduce((total, part) => total + (part.type === 'text' ? [...part.text].length : 0), 0)
  const base = Math.min(preset.maxMs, preset.baseMs + chars * preset.perCharMs)
  return Math.round(base * (1 - JITTER + random() * 2 * JITTER))
}

export interface MessagePacingSettingsStore {
  get(key: string): { readonly value: JsonValue; readonly revision: number } | undefined
  put(key: string, value: JsonValue, expectedRevision: number | undefined): void
}

export const readMessagePacing = (settings: Pick<MessagePacingSettingsStore, 'get'>): MessagePacing => {
  const value = settings.get(SETTING_KEY)?.value
  const stored = typeof value === 'object' && value !== null && !Array.isArray(value) ? value['pacing'] : undefined
  const parsed = MessagePacingSchema.safeParse(stored)
  return parsed.success ? parsed.data : DEFAULT_MESSAGE_PACING
}

export const writeMessagePacing = (settings: MessagePacingSettingsStore, pacing: MessagePacing): MessagePacing => {
  settings.put(SETTING_KEY, { pacing }, settings.get(SETTING_KEY)?.revision)
  return pacing
}
