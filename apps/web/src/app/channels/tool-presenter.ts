/**
 * Reading a tool call as a person would: what the agent asked for and what came back. Inputs arrive either as the
 * full argument JSON (opened detail) or as a 160-character preview that is often cut mid-string, so parsing is
 * lenient and every presenter falls back to plain text instead of showing JSON punctuation.
 */

export type ToolKind = 'search' | 'command' | 'fetch' | 'message' | 'finish' | 'other'

export const toolKind = (name: string): ToolKind => {
  if (/search/iu.test(name)) return 'search'
  if (/^(?:bash|shell|exec|run_command|command)/iu.test(name)) return 'command'
  if (/fetch|browse|read_url/iu.test(name)) return 'fetch'
  if (name === 'send_channel_message' || /send.*message/iu.test(name)) return 'message'
  if (name === 'finish_channel_turn') return 'finish'
  return 'other'
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const unescapeLoosely = (value: string): string =>
  value.replace(/\\n/gu, '\n').replace(/\\"/gu, '"').replace(/\\\\/gu, '\\')

const unescape = (value: string): string => {
  try {
    const parsed: unknown = JSON.parse(`"${value.replace(/\\$/u, '')}"`)
    return typeof parsed === 'string' ? parsed : unescapeLoosely(value)
  } catch {
    return unescapeLoosely(value)
  }
}

/** Parses the argument text into an object; for a cut-off preview, recovers the string fields that are readable. */
export function readArguments(text: string | undefined): Readonly<Record<string, unknown>> | undefined {
  if (!text) return undefined
  const trimmed = text.trim()
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (isRecord(parsed)) return parsed
    if (Array.isArray(parsed)) return { items: parsed }
  } catch {
    // A preview cut mid-string: recover what is there.
  }
  if (!trimmed.startsWith('{')) return undefined
  const fields: Record<string, unknown> = {}
  for (const match of trimmed.matchAll(
    /"([\w-]+)"\s*:\s*(\[[^\]]*\]?|"(?:[^"\\]|\\.)*"?|-?\d+(?:\.\d+)?|true|false)/gu,
  )) {
    const key = match[1] ?? ''
    const raw = match[2] ?? ''
    if (raw.startsWith('[')) {
      fields[key] = [...raw.matchAll(/"((?:[^"\\]|\\.)*)"?/gu)].map((item) => unescape(item[1] ?? ''))
    } else if (raw.startsWith('"')) {
      fields[key] = unescape(raw.slice(1).replace(/"$/u, ''))
    } else fields[key] = raw === 'true' ? true : raw === 'false' ? false : Number(raw)
  }
  return Object.keys(fields).length ? fields : undefined
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

const strings = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '') : []

/** Search queries, whichever key the tool uses. */
export const searchQueries = (args: Readonly<Record<string, unknown>> | undefined): readonly string[] => {
  if (!args) return []
  const list = strings(args['queries'] ?? args['items'])
  if (list.length) return list
  const single = text(args['query']) ?? text(args['q'])
  return single ? [single] : []
}

/** The text a messaging tool sent, joined from its parts. */
export const messageText = (args: Readonly<Record<string, unknown>> | undefined, raw?: string): string | undefined => {
  const parts = args?.['parts']
  if (Array.isArray(parts)) {
    const joined = parts
      .map((part) => (isRecord(part) ? text(part['text']) : undefined))
      .filter(Boolean)
      .join('')
    if (joined) return joined
  }
  const direct = text(args?.['text']) ?? text(args?.['message']) ?? text(args?.['content'])
  if (direct) return direct
  if (!raw) return undefined
  // Plain text: the tool's input already is the message.
  if (!raw.trim().startsWith('{')) return raw.trim() || undefined
  // A cut preview: the first "text" value, possibly unterminated.
  const match = /"text"\s*:\s*"((?:[^"\\]|\\.)*)/u.exec(raw)
  return match?.[1] ? unescape(match[1]) : undefined
}

/** The outcomes `finish_channel_turn` accepts (apps/server finish tool schema). */
const FINISH_OUTCOME: Readonly<Record<string, string>> = {
  'response-complete': '已回复完毕',
  'no-response-needed': '无需回复',
  'cannot-respond': '无法回复',
}

export const finishOutcome = (value: unknown): string | undefined => {
  const outcome = text(value)
  return outcome ? (FINISH_OUTCOME[outcome] ?? outcome) : undefined
}

const firstLine = (value: string): string =>
  value
    .split('\n')
    .find((line) => line.trim())
    ?.trim() ?? value

/** One readable line for the collapsed step: never JSON punctuation. */
export function toolSummary(name: string, input: string | undefined, writesToChannel: boolean): string | undefined {
  const args = readArguments(input)
  const kind = writesToChannel ? 'message' : toolKind(name)
  if (kind === 'search') {
    const queries = searchQueries(args)
    return queries.length ? queries.join(' / ') : undefined
  }
  if (kind === 'command') {
    const description = text(args?.['description'])
    const command = text(args?.['command']) ?? text(args?.['cmd'])
    return description ?? (command ? firstLine(command) : undefined)
  }
  if (kind === 'fetch') return text(args?.['url']) ?? text(args?.['href'])
  if (kind === 'message') return messageText(args, input)
  if (kind === 'finish') return text(args?.['reason']) ?? finishOutcome(args?.['outcome'])
  if (!args) return input?.trim() || undefined
  const values = Object.values(args)
    .map((value) => (typeof value === 'string' ? value : Array.isArray(value) ? strings(value).join('、') : undefined))
    .filter((value): value is string => Boolean(value && value.trim()))
  return values.length ? values.slice(0, 2).join(' · ') : undefined
}

export interface ToolSource {
  readonly title: string
  readonly url: string
  readonly host: string
}

/** `- [title](url)` lines from a search result. */
export function searchSources(result: string | undefined): readonly ToolSource[] {
  if (!result) return []
  const sources: ToolSource[] = []
  for (const match of result.matchAll(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/gu)) {
    const url = match[2] ?? ''
    let host = url
    try {
      host = new URL(url).hostname.replace(/^www\./u, '')
    } catch {
      // Keep the raw address.
    }
    const title = (match[1] ?? '').replace(/\s+-\s+Skip to content$/u, '').trim()
    if (!sources.some((source) => source.url === url)) sources.push({ title, url, host })
  }
  return sources
}

/** Command output as shown to a person: the empty marker becomes words. */
export const commandOutput = (result: string | undefined): string | undefined => {
  const trimmed = result?.trim()
  if (!trimmed) return undefined
  return trimmed === '(no output)' ? '' : trimmed
}
