import {
  COMPACTION_THRESHOLD,
  clampCompactionThreshold,
  compactionThresholdBounds,
  formatThresholdPercent,
  formatTokensInWan,
} from '@nekro-nxt/contracts'
import { effectiveCompactionThreshold } from '../compaction-threshold.js'
import type { CompactionThresholdCall, CompactionThresholdState } from './types.js'

/** What `/threshold` was asked to do. */
export type ThresholdRequest =
  | { readonly kind: 'show' }
  | { readonly kind: 'reset' }
  | { readonly kind: 'min' }
  | { readonly kind: 'max' }
  | { readonly kind: 'set'; readonly ratio: number }

/** `40%`, `40`, `max`, `min`, `reset`, or nothing to show the current value. */
export const parseThresholdRequest = (value: string | undefined): ThresholdRequest => {
  const text = value?.trim().toLowerCase() ?? ''
  if (text === '') return { kind: 'show' }
  if (text === 'reset' || text === 'min' || text === 'max') return { kind: text }
  const match = /^(\d+(?:\.\d+)?)\s*[%％]?$/u.exec(text)
  const percent = match?.[1] === undefined ? Number.NaN : Number(match[1])
  if (!Number.isFinite(percent) || percent <= 0 || percent > 100)
    throw new Error('看不懂这个值。可以写百分比（如 40%）、max、min 或 reset。')
  return { kind: 'set', ratio: percent / 100 }
}

const at = (ratio: number, contextWindow: number | undefined): string =>
  contextWindow === undefined
    ? `上下文的 ${formatThresholdPercent(ratio)} `
    : `上下文的 ${formatThresholdPercent(ratio)}（约 ${formatTokensInWan(contextWindow * ratio)} 万 token）`

/** The agent's setting, held to the current window, which the conversation returns to. */
const settingOf = (state: CompactionThresholdState): number =>
  effectiveCompactionThreshold({ setting: state.setting, contextWindow: state.contextWindow }).ratio

const rangeOf = (contextWindow: number | undefined): string => {
  const { min, max } = compactionThresholdBounds(contextWindow)
  return `${formatThresholdPercent(min)}–${formatThresholdPercent(max)}`
}

/** Runs one `/threshold` request and words the reply. */
export const runThresholdRequest = async (
  request: ThresholdRequest,
  call: CompactionThresholdCall,
): Promise<string> => {
  const state = await call.read()
  const window = state.contextWindow
  const setting = settingOf(state)
  if (request.kind === 'show') {
    const settingText =
      state.setting === undefined ? `默认的 ${formatThresholdPercent(setting)}` : formatThresholdPercent(setting)
    if (state.override === undefined)
      return `这次对话按智能体设置（${settingText}），在${at(setting, window)}时压缩；可调范围 ${rangeOf(window)}。`
    const current = effectiveCompactionThreshold({ override: state.override, contextWindow: window }).ratio
    return `这次对话在${at(current, window)}时压缩，下次压缩后恢复为智能体设置的 ${settingText}；可调范围 ${rangeOf(window)}。`
  }
  if (request.kind === 'reset') {
    call.set(undefined)
    return `这次对话恢复为智能体设置，在${at(setting, window)}时压缩。`
  }
  const { min, max } = compactionThresholdBounds(window)
  const wanted = request.kind === 'min' ? min : request.kind === 'max' ? max : request.ratio
  const held = clampCompactionThreshold(wanted, window)
  call.set(held.ratio)
  const note =
    held.clamped === 'min'
      ? `当前模型最低只能设到 ${formatThresholdPercent(min)}。`
      : held.clamped === 'max'
        ? `最高只能设到 ${formatThresholdPercent(COMPACTION_THRESHOLD.max)}。`
        : ''
  return `${note}这次对话改为${at(held.ratio, window)}时压缩，下次压缩后恢复为 ${formatThresholdPercent(setting)}。`
}
