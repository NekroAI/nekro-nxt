import { z } from 'zod'

/** Bounds of the numeric response timing settings; the host rejects values outside them. */
export const RESPONSE_TIMING_LIMITS = {
  waitMaxQuietSeconds: { min: 5, max: 300 },
  waitMaxTotalSeconds: { min: 10, max: 900 },
  debounceSeconds: { min: 0, max: 30 },
  debounceMaxSeconds: { min: 1, max: 120 },
  debounceMaxMessages: { min: 1, max: 20 },
  attentionSeconds: { min: 5, max: 600 },
  midWakesPerMinute: { min: 1, max: 30 },
} as const

const bounded = (key: keyof typeof RESPONSE_TIMING_LIMITS) =>
  z.number().int().min(RESPONSE_TIMING_LIMITS[key].min).max(RESPONSE_TIMING_LIMITS[key].max).optional()

/**
 * Per-binding timing of when the agent speaks (Decision 2026-10-31 响应时机与智能响应). Every field is optional: an
 * omitted one uses {@link RESPONSE_TIMING_DEFAULTS}. Waiting applies to every policy that answers messages; the rest
 * only to `smart`.
 */
export const ResponseTimingSettingsSchema = z
  .object({
    /** The agent may end a turn with `waiting-for-more` and be woken when the speaker goes quiet. */
    waitEnabled: z.boolean().optional(),
    /** Longest quiet period one wait may ask for. */
    waitMaxQuietSeconds: bounded('waitMaxQuietSeconds'),
    /** Longest the agent may keep waiting for one person, counted from the first wait. */
    waitMaxTotalSeconds: bounded('waitMaxTotalSeconds'),
    /** Smart: wait for the speaker to stay quiet this long before a turn starts; 0 starts at once. */
    debounceSeconds: bounded('debounceSeconds'),
    /** Smart: start anyway once this long has passed since the first message. */
    debounceMaxSeconds: bounded('debounceMaxSeconds'),
    /** Smart: start anyway once this many messages from the speaker are collected. */
    debounceMaxMessages: bounded('debounceMaxMessages'),
    /** Smart: a message that contains the agent's name or an alias wakes it. */
    nameWake: z.boolean().optional(),
    /** Smart: after someone talks with the agent, their next messages wake it for a while. */
    attentionWake: z.boolean().optional(),
    attentionSeconds: bounded('attentionSeconds'),
    /** Smart: name and attention wakes per channel per minute; strong signals are never limited. */
    midWakesPerMinute: bounded('midWakesPerMinute'),
  })
  .strict()

export type ResponseTimingSettings = z.infer<typeof ResponseTimingSettingsSchema>

export type ResolvedResponseTiming = {
  readonly [K in keyof ResponseTimingSettings]-?: NonNullable<ResponseTimingSettings[K]>
}

export const RESPONSE_TIMING_DEFAULTS: ResolvedResponseTiming = {
  waitEnabled: true,
  waitMaxQuietSeconds: 60,
  waitMaxTotalSeconds: 120,
  debounceSeconds: 3,
  debounceMaxSeconds: 30,
  debounceMaxMessages: 5,
  nameWake: true,
  attentionWake: true,
  attentionSeconds: 60,
  midWakesPerMinute: 3,
}

/** Shortest quiet period a wait may ask for, whatever the channel allows. */
export const RESPONSE_WAIT_MIN_QUIET_SECONDS = 5

export const resolveResponseTiming = (settings: ResponseTimingSettings | undefined): ResolvedResponseTiming => ({
  ...RESPONSE_TIMING_DEFAULTS,
  ...Object.fromEntries(Object.entries(settings ?? {}).filter(([, value]) => value !== undefined)),
})

/** Extra names that wake the agent in smart mode; the display name always counts too. */
export const AgentAliasesSchema = z
  .array(z.string().trim().min(1).max(32))
  .max(16)
  .transform((aliases) => [...new Set(aliases)])
