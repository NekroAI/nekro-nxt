/** Names and one-line meanings for the thinking levels DSH offers, least to most; an unknown level keeps its own id. */
export const THINKING_LEVELS: Readonly<Record<string, { readonly name: string; readonly hint: string }>> = {
  off: { name: '关闭', hint: '不思考，直接回答' },
  minimal: { name: '最少', hint: '只做最必要的思考' },
  low: { name: '低', hint: '回答快，思考较少' },
  medium: { name: '中', hint: '兼顾速度和深度' },
  high: { name: '高', hint: '复杂问题想得更深' },
  xhigh: { name: '很高', hint: '适合很复杂的问题，回答更慢' },
  max: { name: '最高', hint: '想得最深，回答最慢，用量最多' },
}

/** Every level DSH knows, least to most. */
export const THINKING_LEVEL_IDS: readonly string[] = Object.keys(THINKING_LEVELS)

export const thinkingLevelName = (level: string): string => THINKING_LEVELS[level]?.name ?? level

/** Levels least to most without repeats; unknown levels follow the known ones in their given order. */
export const sortThinkingLevels = (levels: readonly string[]): string[] => {
  const rank = (level: string): number => {
    const index = THINKING_LEVEL_IDS.indexOf(level)
    return index === -1 ? THINKING_LEVEL_IDS.length : index
  }
  return [...new Set(levels)].sort((a, b) => rank(a) - rank(b))
}
