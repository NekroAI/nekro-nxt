import { z } from 'zod'

/**
 * When a conversation compacts, as a fraction of the model's context window. Below `minTokens` the summary and the
 * fixed prompt can already fill the threshold right after compacting, so compaction would run again at once.
 */
export const COMPACTION_THRESHOLD = {
  default: 0.8,
  max: 0.9,
  floor: 0.2,
  minTokens: 64_000,
  step: 0.05,
} as const

/** A stored threshold; the current model's window narrows it further when it is used. */
export const CompactionThresholdRatioSchema = z.number().min(COMPACTION_THRESHOLD.floor).max(COMPACTION_THRESHOLD.max)

const steps = (ratio: number): number => Math.round(ratio / COMPACTION_THRESHOLD.step)

/**
 * The thresholds one context window allows, on whole steps. A window too small for the token minimum allows only the
 * maximum.
 */
export const compactionThresholdBounds = (
  contextWindow: number | undefined,
): { readonly min: number; readonly max: number } => {
  const max = COMPACTION_THRESHOLD.max
  const wanted =
    contextWindow === undefined || contextWindow <= 0
      ? COMPACTION_THRESHOLD.floor
      : Math.max(COMPACTION_THRESHOLD.floor, COMPACTION_THRESHOLD.minTokens / contextWindow)
  // Up to the next whole step, without floating-point dust pushing an exact step one further.
  const min = Math.ceil(wanted / COMPACTION_THRESHOLD.step - 1e-9) * COMPACTION_THRESHOLD.step
  return { min: Math.min(max, roundRatio(min)), max }
}

/** Two decimals: thresholds move in 5 % steps, so anything finer is floating-point dust. */
export const roundRatio = (ratio: number): number => Math.round(ratio * 100) / 100

/** A threshold held to what the window allows, and which bound it hit, if any. */
export const clampCompactionThreshold = (
  ratio: number,
  contextWindow: number | undefined,
): { readonly ratio: number; readonly clamped?: 'min' | 'max' } => {
  const { min, max } = compactionThresholdBounds(contextWindow)
  if (ratio < min - 1e-9) return { ratio: min, clamped: 'min' }
  if (ratio > max + 1e-9) return { ratio: max, clamped: 'max' }
  return { ratio: roundRatio(ratio) }
}

/** Every selectable threshold for a window, smallest first. */
export const compactionThresholdSteps = (contextWindow: number | undefined): readonly number[] => {
  const { min, max } = compactionThresholdBounds(contextWindow)
  const out: number[] = []
  for (let step = steps(min); step <= steps(max); step += 1) out.push(roundRatio(step * COMPACTION_THRESHOLD.step))
  return out
}

/** A token count in 万, the unit thresholds are shown in: whole from 10 万 up, one decimal below. */
export const formatTokensInWan = (tokens: number): string => {
  const wan = tokens / 10_000
  return wan >= 10 ? String(Math.round(wan)) : String(Math.round(wan * 10) / 10)
}

/** A threshold as the percentage people read and type. */
export const formatThresholdPercent = (ratio: number): string => `${Math.round(ratio * 100)}%`
