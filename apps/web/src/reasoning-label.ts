const LABELS: Readonly<Record<string, string>> = {
  off: '关闭',
  none: '关闭',
  minimal: '极低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: 'Ultra',
}

export const reasoningLabel = (effort: { readonly id: string; readonly name: string }): string =>
  LABELS[effort.id] ?? effort.name
