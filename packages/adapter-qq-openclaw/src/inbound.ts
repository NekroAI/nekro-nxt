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
    const content = normalizeQQContent(raw['content'])
    const mentions = parseMentions(raw['mentions'])
    return {
      eventType: typedEvent,
      platformMessageId,
      target: { kind: 'c2c', openId: senderOpenId },
      senderOpenId,
      ...(senderDisplayName === undefined ? {} : { senderDisplayName }),
      ...(content === undefined ? {} : { content }),
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
  const content = normalizeQQContent(raw['content'])
  return {
    eventType: typedEvent,
    platformMessageId,
    target: { kind: 'group', openId: groupOpenId },
    ...(targetDisplayName === undefined ? {} : { targetDisplayName }),
    senderOpenId,
    ...(senderDisplayName === undefined ? {} : { senderDisplayName }),
    ...(content === undefined ? {} : { content }),
    mentions,
    attachments: parseAttachments(raw['attachments']),
    ...(reference.reference === undefined ? {} : { platformReference: reference.reference }),
    platformTimestamp: parseTimestamp(raw['timestamp'], now),
  }
}
