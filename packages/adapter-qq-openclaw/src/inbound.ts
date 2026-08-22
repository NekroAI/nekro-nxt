import type { QQInboundAttachment, QQNormalizedInboundMessage } from './index.js'

export const QQ_MESSAGE_EVENT_TYPES = ['C2C_MESSAGE_CREATE', 'GROUP_AT_MESSAGE_CREATE', 'GROUP_MESSAGE_CREATE'] as const

export type QQMessageEventType = (typeof QQ_MESSAGE_EVENT_TYPES)[number]

type UnknownRecord = Readonly<Record<string, unknown>>

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const record = (value: unknown): UnknownRecord => (isRecord(value) ? value : {})

const records = (value: unknown): readonly UnknownRecord[] =>
  Array.isArray(value) ? value.map(record).filter((item) => Object.keys(item).length > 0) : []

const text = (...values: readonly unknown[]): string | undefined => {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return undefined
}

const displayName = (value: UnknownRecord): string | undefined =>
  text(value['username'], value['nickname'], value['nick'], value['name'])

const parseExt = (value: unknown): UnknownRecord => {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return record(value)
  const entries: Record<string, string> = {}
  const values = Array.isArray(value) ? value : [value]
  for (const item of values) {
    if (typeof item !== 'string') continue
    for (const chunk of item.split(/[&;\n]/u)) {
      const separator = chunk.indexOf('=')
      if (separator <= 0) continue
      const key = chunk.slice(0, separator).trim()
      const entryValue = chunk.slice(separator + 1).trim()
      if (key) entries[key] = entryValue
    }
  }
  return entries
}

const parseTimestamp = (value: unknown, fallback: number): number => {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  if (Number.isFinite(numeric) && numeric >= 0) {
    const milliseconds = numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric
    return Math.trunc(milliseconds)
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed) && parsed >= 0) return parsed
  }
  return fallback
}

const inferMediaType = (url: string, voiceUrl: string | undefined): string | undefined => {
  if (voiceUrl) return 'audio/wav'
  const path = url.split(/[?#]/u, 1)[0]?.toLowerCase() ?? ''
  if (/\.(?:jpe?g)$/u.test(path)) return 'image/jpeg'
  if (/\.png$/u.test(path)) return 'image/png'
  if (/\.gif$/u.test(path)) return 'image/gif'
  if (/\.webp$/u.test(path)) return 'image/webp'
  if (/\.mp4$/u.test(path)) return 'video/mp4'
  if (/\.webm$/u.test(path)) return 'video/webm'
  if (/\.mp3$/u.test(path)) return 'audio/mpeg'
  if (/\.wav$/u.test(path)) return 'audio/wav'
  return undefined
}

const parseAttachments = (value: unknown): readonly QQInboundAttachment[] => {
  const attachments: QQInboundAttachment[] = []
  for (const item of records(value)) {
    const voiceUrl = text(item['voice_wav_url'])
    const url = text(item['url'], voiceUrl)
    if (!url) continue
    const mediaType = text(item['content_type']) ?? inferMediaType(url, voiceUrl)
    const fileName = text(item['filename'])
    attachments.push({
      url,
      ...(fileName === undefined ? {} : { fileName }),
      ...(mediaType === undefined ? {} : { mediaType: mediaType.toLowerCase() }),
    })
  }
  return attachments
}

const parseReference = (raw: UnknownRecord): { readonly messageId?: string; readonly reference?: string } => {
  const scene = record(raw['message_scene'])
  const ext = parseExt(scene['ext'])
  const elements = records(raw['msg_elements'])
  const firstElementIndex = text(elements[0]?.['msg_idx'])
  const messageId = text(ext['msg_idx'], ext['msgIdx'], firstElementIndex, raw['id'])
  const extReference = text(ext['ref_msg_idx'], ext['refMsgIdx'], ext['ref_idx'], ext['refIdx'])
  const rawMessageType = raw['message_type']
  const messageType = typeof rawMessageType === 'number' ? rawMessageType : Number(rawMessageType)
  const reference = messageType === 103 && firstElementIndex ? firstElementIndex : extReference
  return {
    ...(messageId === undefined ? {} : { messageId }),
    ...(reference === undefined ? {} : { reference }),
  }
}

const required = (value: string | undefined, description: string): string => {
  if (!value) throw new Error(`QQ ${description} is required.`)
  return value
}

const regexEscape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

export type QQForwardItem = {
  readonly sender?: string
  readonly text?: string
  readonly card?: {
    readonly kind: string
    readonly summary: string
    readonly title?: string
    readonly source?: string
    readonly targetUrl?: string
    readonly previewUrl?: string
  }
  readonly attachmentUrl?: string
  readonly attachmentName?: string
  readonly attachmentMediaType?: string
}

export type QQDecodedRich = {
  readonly kind: string
  readonly summary: string
  readonly title?: string
  readonly source?: string
  readonly targetUrl?: string
  readonly previewUrl?: string
  readonly items?: readonly QQForwardItem[]
  readonly extension?: Readonly<Record<string, string>>
}

const CARD_DUMP_KEYS = ['jump_url', 'source_logo', '摘要', 'title', 'preview', 'source', 'url', '链接', '跳转'] as const

const httpTargetUrl = (...values: readonly unknown[]): string | undefined => {
  const candidate = text(...values)
  if (!candidate || candidate.length > 2048) return undefined
  try {
    const parsed = new URL(candidate)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : undefined
  } catch {
    return undefined
  }
}

const compactExtension = (fields: Readonly<Record<string, string>>): Readonly<Record<string, string>> | undefined => {
  const entries = Object.entries(fields).filter(([, value]) => value.trim().length > 0)
  return entries.length === 0 ? undefined : Object.fromEntries(entries)
}

const richFromFields = (kind: string, fields: Readonly<Record<string, string>>): QQDecodedRich | undefined => {
  const title = fields['title']?.trim()
  const source = fields['source']?.trim()
  const previewUrl = fields['preview']?.trim()
  const targetUrl = httpTargetUrl(fields['jump_url'], fields['url'], fields['链接'], fields['跳转'])
  const dumpSummary = fields['摘要']?.replace(/^\[QQ小程序\]/u, '').trim()
  if (kind === 'forward') {
    const preview = dumpSummary || title
    return {
      kind,
      summary: '转发的聊天记录',
      title: '转发的聊天记录',
      ...(preview ? { extension: { preview: preview.slice(0, 4000) } } : {}),
    }
  }
  const summary = [source, dumpSummary || title].filter(Boolean).join(' · ') || title
  if (!summary) return undefined
  const extension = compactExtension(fields)
  return {
    kind,
    summary,
    ...(title ? { title } : {}),
    ...(source ? { source } : {}),
    ...(targetUrl ? { targetUrl } : {}),
    ...(previewUrl ? { previewUrl } : {}),
    ...(extension === undefined ? {} : { extension }),
  }
}

/** Parse the flattened `[卡片消息]` dump some QQ clients put in `content`. */
export const parseQQCardDump = (content: string): QQDecodedRich | undefined => {
  const header = content.match(/^\[卡片消息\](?:\s+(\S+))?/u)
  if (!header) return undefined
  const rest = content.slice(header[0].length).trim()
  const kindToken = header[1]
  const kind =
    kindToken === '小程序' ? 'miniapp' : kindToken === '转发' || kindToken === '聊天记录' ? 'forward' : 'card'
  const fields: Record<string, string> = {}
  const keyPattern = new RegExp(`(${CARD_DUMP_KEYS.join('|')}):`, 'gu')
  const matches = [...rest.matchAll(keyPattern)]
  if (matches.length === 0) {
    if (rest) fields['摘要'] = rest
    return richFromFields(kind, fields)
  }
  for (const [index, match] of matches.entries()) {
    const key = match[1]
    if (!key || match.index === undefined) continue
    const start = match.index + match[0].length
    const end = matches[index + 1]?.index ?? rest.length
    fields[key] = rest.slice(start, end).trim()
  }
  return richFromFields(kind, fields)
}

const parseQQArk = (value: unknown): QQDecodedRich | undefined => {
  const ark = record(value)
  if (Object.keys(ark).length === 0) return undefined
  const fields: Record<string, string> = {}
  for (const item of records(ark['kv'])) {
    const key = text(item['key'])?.replaceAll('#', '')
    const valueText = text(item['value'])
    if (key && valueText) fields[key.toLowerCase()] = valueText
  }
  const title = text(ark['title'], fields['title'], fields['prompt'])
  const summary = text(fields['desc'], fields['metadesc'], ark['prompt'], title)
  if (title) fields['title'] = title
  if (summary) fields['摘要'] = summary
  const preview = text(fields['preview'], fields['img'], fields['image'])
  const targetUrl = httpTargetUrl(fields['jump_url'], fields['url'], fields['link'])
  if (preview) fields['preview'] = preview
  if (targetUrl) fields['url'] = targetUrl
  return richFromFields('ark', fields)
}

const parseQQEmbed = (value: unknown): QQDecodedRich | undefined => {
  const embed = record(value)
  if (Object.keys(embed).length === 0) return undefined
  const thumbnail = record(embed['thumbnail'])
  const fields: Record<string, string> = {}
  const title = text(embed['title'])
  const summary = text(embed['description'], embed['prompt'], title)
  const preview = text(thumbnail['url'])
  const targetUrl = httpTargetUrl(embed['url'])
  const source = text(embed['source'], record(embed['provider'])['name'])
  if (title) fields['title'] = title
  if (summary) fields['摘要'] = summary
  if (preview) fields['preview'] = preview
  if (targetUrl) fields['url'] = targetUrl
  if (source) fields['source'] = source
  return richFromFields('card', fields)
}

const parseAttachmentDump = (
  value: string,
): Pick<QQForwardItem, 'attachmentUrl' | 'attachmentName' | 'attachmentMediaType'> | undefined => {
  const url = value.match(/\bURL:\s*(\S+)/u)?.[1]
  if (!url) return undefined
  const fileName = value.match(/文件名:\s*(\S+)/u)?.[1]
  const kind = value.match(/类型:\s*(\S+)/u)?.[1]
  const voiceUrl = kind === '语音' || kind === '音频' ? url : undefined
  const mediaType = inferMediaType(fileName ?? url, voiceUrl) ?? (kind === '图片' ? 'image/jpeg' : undefined)
  return {
    attachmentUrl: url,
    ...(fileName === undefined ? {} : { attachmentName: fileName }),
    ...(mediaType === undefined ? {} : { attachmentMediaType: mediaType }),
  }
}

const parseForwardSegment = (segment: string): QQForwardItem | undefined => {
  const fields: Record<string, string> = {}
  const markers = [...segment.matchAll(/\[(消息内容|发送者|消息类型|附件\d+)\]/gu)]
  if (markers.length === 0) {
    const trimmed = segment.trim()
    return trimmed ? { text: trimmed } : undefined
  }
  for (const [index, match] of markers.entries()) {
    const key = match[1]
    if (!key || match.index === undefined) continue
    const start = match.index + match[0].length
    const end = markers[index + 1]?.index ?? segment.length
    fields[key] = segment.slice(start, end).trim()
  }
  const sender = fields['发送者']
  const rawContent = fields['消息内容']
  const card = rawContent ? parseQQCardDump(rawContent) : undefined
  const text = card ? undefined : rawContent
  const attachmentField = Object.entries(fields).find(([key]) => key.startsWith('附件'))?.[1]
  const attachment = attachmentField ? parseAttachmentDump(attachmentField) : undefined
  if (!sender && !text && !card && !attachment) return undefined
  return {
    ...(sender === undefined ? {} : { sender }),
    ...(text === undefined || text.length === 0 ? {} : { text }),
    ...(card === undefined
      ? {}
      : {
          card: {
            kind: card.kind,
            summary: card.summary,
            ...(card.title === undefined ? {} : { title: card.title }),
            ...(card.source === undefined ? {} : { source: card.source }),
            ...(card.targetUrl === undefined ? {} : { targetUrl: card.targetUrl }),
            ...(card.previewUrl === undefined ? {} : { previewUrl: card.previewUrl }),
          },
        }),
    ...(attachment ?? {}),
  }
}

/** Parse flattened `[群聊的聊天记录] === 消息 1 === ...` dumps from QQ inbound text. */
export const parseQQChatRecordDump = (content: string): QQDecodedRich | undefined => {
  const header = content.trim().match(/^\[([^[\]]*聊天记录)\]/u)
  if (!header?.[1]) return undefined
  const title = header[1]
  const body = content.trim().slice(header[0].length)
  if (!/===\s*消息\s*\d+\s*===/u.test(body) && title !== '群聊的聊天记录' && title !== '好友的聊天记录') {
    return undefined
  }
  const items = body
    .split(/===\s*消息\s*\d+\s*===/u)
    .map((segment) => parseForwardSegment(segment))
    .filter((item): item is QQForwardItem => item !== undefined)
  const summary = items.length > 0 ? `${title}（${items.length} 条）` : title
  return {
    kind: 'forward',
    summary,
    title,
    ...(items.length === 0 ? {} : { items }),
  }
}

const parseQQForward = (content: string | undefined): QQDecodedRich | undefined => {
  if (!content) return undefined
  const recordDump = parseQQChatRecordDump(content)
  if (recordDump) return recordDump
  const trimmed = content.trim()
  const head = trimmed.match(/^(?:\[(?:转发(?:的)?聊天记录|聊天记录|转发消息)\]|转发(?:的)?聊天记录)/u)
  if (!head && !/转发(?:的)?聊天记录/.test(trimmed)) return undefined
  const rest = (head ? trimmed.slice(head[0].length) : trimmed).replace(/^\s*\n/u, '').trim()
  return {
    kind: 'forward',
    summary: '转发的聊天记录',
    title: '转发的聊天记录',
    ...(rest.length === 0 ? {} : { extension: { preview: rest.slice(0, 4000) } }),
  }
}

export const parseQQRichPayload = (
  raw: unknown,
  content: string | undefined,
): { readonly rich?: QQDecodedRich; readonly content?: string } => {
  const payload = record(raw)
  const dump = content ? parseQQCardDump(content) : undefined
  const rich = dump ?? parseQQEmbed(payload['embed']) ?? parseQQArk(payload['ark']) ?? parseQQForward(content)
  if (!rich) return content === undefined ? {} : { content }
  const stripContent = dump !== undefined || rich.kind === 'forward'
  return {
    rich,
    ...(stripContent || content === undefined ? {} : { content }),
  }
}

const normalizeQQContent = (value: unknown): string | undefined => {
  const content = text(value)
  if (!content) return undefined
  const normalized = content.replace(/<faceType=\d+,faceId="[^"]*",ext="[^"]*">/gu, '[表情]').trim()
  return normalized || undefined
}

type QQDecodedMention = {
  readonly openId: string
  readonly displayName?: string
  readonly bot?: boolean
}

export type QQContentAtom =
  | { readonly kind: 'text'; readonly value: string }
  | {
      readonly kind: 'mention'
      readonly openId: string
      readonly displayName?: string
      readonly bot?: boolean
    }

const parseMentions = (value: unknown): readonly QQDecodedMention[] =>
  records(value)
    .map((mention) => {
      const openId = text(mention['member_openid'], mention['user_openid'], mention['id'])
      if (!openId) return undefined
      const mentionDisplayName = displayName(mention)
      return {
        openId,
        ...(mentionDisplayName === undefined ? {} : { displayName: mentionDisplayName }),
        ...(mention['bot'] === true ? { bot: true } : {}),
      }
    })
    .filter((mention): mention is QQDecodedMention => mention !== undefined)

const mentionAtom = (mention: QQDecodedMention): QQContentAtom => {
  const displayName = mention.displayName ?? (mention.bot ? '机器人账号' : undefined)
  return {
    kind: 'mention',
    openId: mention.openId,
    ...(displayName === undefined ? {} : { displayName }),
    ...(mention.bot ? { bot: true } : {}),
  }
}

/** Split QQ text so Mention tokens keep their original offsets in the `parts` array. */
export const splitQQContentAtoms = (
  content: string | undefined,
  mentions: readonly QQDecodedMention[],
): readonly QQContentAtom[] => {
  type Span = { readonly start: number; readonly end: number; readonly mention: QQDecodedMention }
  const spans: Span[] = []
  if (content) {
    for (const mention of mentions) {
      const token = new RegExp(`<@!?${regexEscape(mention.openId)}>`, 'gu')
      for (const match of content.matchAll(token)) {
        spans.push({ start: match.index, end: match.index + match[0].length, mention })
      }
      if (!mention.displayName) continue
      const name = new RegExp(`@${regexEscape(mention.displayName)}`, 'gu')
      for (const match of content.matchAll(name)) {
        spans.push({ start: match.index, end: match.index + match[0].length, mention })
      }
    }
    spans.sort((left, right) => left.start - right.start || right.end - right.start - (left.end - left.start))
  }

  const selected: Span[] = []
  let cursor = 0
  for (const span of spans) {
    if (span.start < cursor) continue
    selected.push(span)
    cursor = span.end
  }

  const usedInContent = new Set(selected.map((span) => span.mention.openId))
  const atoms: QQContentAtom[] = []
  const emitted = new Set<string>()
  for (const mention of mentions) {
    if (!mention.bot || usedInContent.has(mention.openId) || emitted.has(mention.openId)) continue
    atoms.push(mentionAtom(mention))
    emitted.add(mention.openId)
  }

  let offset = 0
  for (const span of selected) {
    if (content && span.start > offset) {
      const value = content.slice(offset, span.start)
      if (value) atoms.push({ kind: 'text', value })
    }
    atoms.push(mentionAtom(span.mention))
    emitted.add(span.mention.openId)
    offset = span.end
  }
  if (content && offset < content.length) {
    const value = content.slice(offset)
    if (value) atoms.push({ kind: 'text', value })
  }

  for (const mention of mentions) {
    if (emitted.has(mention.openId)) continue
    atoms.push(mentionAtom(mention))
    emitted.add(mention.openId)
  }
  return atoms
}

/** Converts the three supported QQ Gateway message events into the Adapter's platform-neutral inbound shape. */
export const decodeQQInboundMessage = (
  eventType: string,
  value: unknown,
  options: { readonly now?: () => number } = {},
): QQNormalizedInboundMessage | undefined => {
  const typedEvent = QQ_MESSAGE_EVENT_TYPES.find((candidate) => candidate === eventType)
  if (typedEvent === undefined) return undefined
  const raw = record(value)
  const author = record(raw['author'])
  const reference = parseReference(raw)
  const platformMessageId = required(text(raw['id'], reference.messageId), 'message ID')
  const now = options.now?.() ?? Date.now()

  if (typedEvent === 'C2C_MESSAGE_CREATE') {
    const senderOpenId = required(
      text(author['user_openid'], author['id'], author['union_openid']),
      'C2C sender OpenID',
    )
    const senderDisplayName = displayName(author)
    const mentions = parseMentions(raw['mentions'])
    const richPayload = parseQQRichPayload(raw, normalizeQQContent(raw['content']))
    return {
      eventType: typedEvent,
      platformMessageId,
      target: { kind: 'c2c', openId: senderOpenId },
      senderOpenId,
      ...(senderDisplayName === undefined ? {} : { senderDisplayName }),
      ...(richPayload.content === undefined ? {} : { content: richPayload.content }),
      ...(richPayload.rich === undefined ? {} : { rich: richPayload.rich }),
      ...(mentions.length === 0 ? {} : { mentions }),
      attachments: parseAttachments(raw['attachments']),
      ...(reference.reference === undefined ? {} : { platformReference: reference.reference }),
      platformTimestamp: parseTimestamp(raw['timestamp'], now),
    }
  }

  const groupOpenId = required(text(raw['group_openid'], raw['group_id']), 'group OpenID')
  const senderOpenId = required(text(author['member_openid'], author['id']), 'group sender OpenID')
  const mentions = parseMentions(raw['mentions'])
  const targetDisplayName = text(raw['group_name'], raw['group_nick'], raw['group_title'])
  const senderDisplayName = displayName(author)
  const richPayload = parseQQRichPayload(raw, normalizeQQContent(raw['content']))
  return {
    eventType: typedEvent,
    platformMessageId,
    target: { kind: 'group', openId: groupOpenId },
    ...(targetDisplayName === undefined ? {} : { targetDisplayName }),
    senderOpenId,
    ...(senderDisplayName === undefined ? {} : { senderDisplayName }),
    ...(richPayload.content === undefined ? {} : { content: richPayload.content }),
    ...(richPayload.rich === undefined ? {} : { rich: richPayload.rich }),
    mentions,
    attachments: parseAttachments(raw['attachments']),
    ...(reference.reference === undefined ? {} : { platformReference: reference.reference }),
    platformTimestamp: parseTimestamp(raw['timestamp'], now),
  }
}
