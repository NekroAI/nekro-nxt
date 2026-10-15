import {
  CommunityFeedbackDiagnosticsSchema,
  CommunityFeedbackExcerptSchema,
  type CommunityFeedbackDiagnostics,
  type CommunityFeedbackExcerpt,
  type MessagePart,
} from '@nekro-nxt/contracts'

export interface FeedbackRedactionContext {
  readonly members: readonly { readonly key: string; readonly aliases: readonly string[] }[]
  readonly channels: readonly { readonly key: string; readonly aliases: readonly string[] }[]
  readonly accounts: readonly { readonly key: string; readonly aliases: readonly string[] }[]
  readonly homeDirectory: string
  readonly dataDirectory: string
}
const escapePattern = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
const memberNames = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸']
const replacements = (context: FeedbackRedactionContext): Map<string, string> => {
  const result = new Map<string, string>()
  for (const [entries, label] of [
    [context.members, (index: number) => `成员${memberNames[index] ?? index + 1}`],
    [context.channels, (index: number) => `群 ${index < 26 ? String.fromCharCode(65 + index) : index + 1}`],
    [context.accounts, (index: number) => `账号 ${index + 1}`],
  ] as const) {
    for (const [index, entry] of [...entries].sort((a, b) => a.key.localeCompare(b.key)).entries()) {
      for (const alias of [entry.key, ...entry.aliases]) {
        if (alias && !result.has(alias)) result.set(alias, label(index))
      }
    }
  }
  return result
}

/** Deterministic, channel-independent redaction; all fields in one payload receive the same identity mapping. */
export const redactFeedbackText = (text: string, context: FeedbackRedactionContext): string => {
  let result = text
    .replace(
      /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z ]+ )?PRIVATE KEY-----|$)/gu,
      '<已移除密钥>',
    )
    .replace(/authorization\s*[:=]\s*(?:bearer|basic)\s+[^\s,;]+/giu, '<已移除密钥>')
    .replace(
      /(?:sk-[A-Za-z0-9_-]{12,}|(?:gh[pousr]_|github_pat_|nxtc_(?:at|rt|ops|pub)_)[A-Za-z0-9_-]{12,})/gu,
      '<已移除密钥>',
    )
    .replace(
      /(?=[A-Za-z0-9_+/=-]{40,}(?:\s|$))(?=[A-Za-z0-9_+/=-]*[A-Za-z])(?=[A-Za-z0-9_+/=-]*[0-9])[A-Za-z0-9_+/=-]{40,}/gu,
      '<已移除密钥>',
    )
  const directories = [
    [context.dataDirectory, '<data>'],
    [context.homeDirectory, '<home>'],
  ] as const
  for (const [directory, label] of [...directories].sort((a, b) => b[0].length - a[0].length)) {
    if (directory)
      result = result.replace(
        new RegExp(`${escapePattern(directory.replace(/[\\/]$/u, ''))}(?=[\\\\/]|$|[\\s"'])`, 'gu'),
        label,
      )
  }
  result = result
    .replace(/file:\/\/[^\s<>"']+/giu, '<本机路径>')
    .replace(
      /(^|[\s("'`=])(?:\/(?:Users|home|root|data|tmp|var|etc|opt|private|mnt|Volumes|workspace|workspaces)\/[^\s<>"']*|[A-Za-z]:[\\/][^\s<>"']*|\\\\[^\s\\]+\\[^\s<>"']*)/gu,
      '$1<本机路径>',
    )
  const aliases = replacements(context)
  if (aliases.size > 0) {
    const pattern = [...aliases.keys()]
      .sort((a, b) => b.length - a.length)
      .map((alias) => {
        const escaped = escapePattern(alias)
        return /^[A-Za-z0-9_-]+$/u.test(alias) ? `(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])` : escaped
      })
      .join('|')
    result = result.replace(new RegExp(pattern, 'gu'), (alias) => aliases.get(alias) ?? alias)
  }
  return result
}

/** Attachments contribute no names, URLs, hashes or content to the excerpt. */
export const feedbackMessageText = (parts: readonly MessagePart[]): string =>
  parts
    .map((part) =>
      part.type === 'text' ? part.text : part.type === 'image' || part.type === 'file' ? '附件一份' : '非文本消息',
    )
    .join('\n')

export const redactFeedbackExcerpt = (
  excerpt: CommunityFeedbackExcerpt,
  context: FeedbackRedactionContext,
): CommunityFeedbackExcerpt =>
  CommunityFeedbackExcerptSchema.parse(
    excerpt.map((entry) => ({
      speaker: redactFeedbackText(entry.speaker, context),
      text: redactFeedbackText(entry.text, context),
    })),
  )

export const collectFeedbackDiagnostics = (
  input: CommunityFeedbackDiagnostics,
  context: FeedbackRedactionContext,
): CommunityFeedbackDiagnostics => {
  const parsed = CommunityFeedbackDiagnosticsSchema.parse(input)
  return CommunityFeedbackDiagnosticsSchema.parse({
    ...parsed,
    ...(parsed.entries === undefined
      ? {}
      : {
          entries: parsed.entries.map((entry) => ({ ...entry, summary: redactFeedbackText(entry.summary, context) })),
        }),
  })
}

export const feedbackRedactions = (value: unknown): string[] => {
  const text = JSON.stringify(value)
  return [
    ...(text.includes('<已移除密钥>') ? ['疑似密钥'] : []),
    ...(/<(?:home|data|本机路径)>/u.test(text) ? ['本机路径'] : []),
    ...(text.includes('成员') ? ['成员标识'] : []),
    ...(text.includes('附件一份') ? ['附件内容'] : []),
  ]
}
