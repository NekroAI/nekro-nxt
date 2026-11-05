import { clampCompactionThreshold, COMPACTION_THRESHOLD } from '@nekro-nxt/contracts'

/** Where the threshold in force came from: this conversation's override, the agent's setting, or the default. */
export type CompactionThresholdSource = 'session' | 'agent' | 'default'

export interface EffectiveCompactionThreshold {
  readonly ratio: number
  readonly source: CompactionThresholdSource
  /** The chosen value lay outside what this window allows and was held to this bound. */
  readonly clamped?: 'min' | 'max'
}

/**
 * The threshold one conversation compacts at: its own override first, then the agent's setting, each held to what the
 * current model's window allows. With neither, the default applies unchanged, exactly as before thresholds could be
 * chosen.
 */
export const effectiveCompactionThreshold = (input: {
  readonly override?: number | undefined
  readonly setting?: number | undefined
  readonly contextWindow?: number | undefined
}): EffectiveCompactionThreshold => {
  const chosen =
    input.override !== undefined
      ? { ratio: input.override, source: 'session' as const }
      : input.setting !== undefined
        ? { ratio: input.setting, source: 'agent' as const }
        : undefined
  if (chosen === undefined) return { ratio: COMPACTION_THRESHOLD.default, source: 'default' }
  const held = clampCompactionThreshold(chosen.ratio, input.contextWindow)
  return { ratio: held.ratio, source: chosen.source, ...(held.clamped === undefined ? {} : { clamped: held.clamped }) }
}

/**
 * Thresholds set by `/threshold` for one conversation, keyed by DSH session id. An override lasts until that session
 * next compacts; a new session never has one. Kept in memory only: a restart returns to the agent's setting.
 */
export class CompactionThresholdOverrides {
  readonly #ratios = new Map<string, number>()

  get(sessionId: string): number | undefined {
    return this.#ratios.get(sessionId)
  }

  set(sessionId: string, ratio: number | undefined): void {
    if (ratio === undefined) this.#ratios.delete(sessionId)
    else this.#ratios.set(sessionId, ratio)
  }
}
