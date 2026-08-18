import type { QQInboundAttachment, QQNormalizedInboundMessage } from './index.js'

export const QQ_MESSAGE_EVENT_TYPES = ['C2C_MESSAGE_CREATE', 'GROUP_AT_MESSAGE_CREATE', 'GROUP_MESSAGE_CREATE'] as const

export type QQMessageEventType = (typeof QQ_MESSAGE_EVENT_TYPES)[number]

type UnknownRecord = Readonly<Record<string, unknown>>

const record = (value: unknown): UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as UnknownRecord) : {}

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
  text(value.username, value.nickname, value.nick, value.name)

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
    const voiceUrl = text(item.voice_wav_url)
    const url = text(item.url, voiceUrl)
    if (!url) continue
    const mediaType = text(item.content_type) ?? inferMediaType(url, voiceUrl)
    const fileName = text(item.filename)
    attachments.push({
      url,
      ...(fileName === undefined ? {} : { fileName }),
      ...(mediaType === undefined ? {} : { mediaType: mediaType.toLowerCase() }),
    })
  }
  return attachments
}

const parseReference = (raw: UnknownRecord): { readonly messageId?: string; readonly reference?: string } => {
  const scene = record(raw.message_scene)
  const ext = parseExt(scene.ext)
  const elements = records(raw.msg_elements)
  const firstElementIndex = text(elements[0]?.msg_idx)
  const messageId = text(ext.msg_idx, ext.msgIdx, firstElementIndex, raw.id)
  const extReference = text(ext.ref_msg_idx, ext.refMsgIdx, ext.ref_idx, ext.refIdx)
  const messageType = typeof raw.message_type === 'number' ? raw.message_type : Number(raw.message_type)
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
  const normalized = content.replace(/<faceType=\d+,faceId="[^"]*",ext="[^"]*">/gu, '[QQ 表情]').trim()
  return normalized || undefined
}

const stripStructuredMentions = (
  content: string | undefined,
  mentions: readonly { readonly openId: string; readonly displayName?: string }[],
): string | undefined => {
  if (!content) return undefined
  let normalized = content
  for (const mention of mentions) {
    normalized = normalized.replace(new RegExp(`<@!?${regexEscape(mention.openId)}>`, 'gu'), '')
    if (mention.displayName) {
      normalized = normalized.replace(new RegExp(`@${regexEscape(mention.displayName)}`, 'gu'), '')
    }
  }
  const trimmed = normalized.trim()
  return trimmed || undefined
}

/** Converts the three supported QQ Gateway message events into the Adapter's platform-neutral inbound shape. */
export const decodeQQInboundMessage = (
  eventType: string,
  value: unknown,
  options: { readonly now?: () => number } = {},
): QQNormalizedInboundMessage | undefined => {
  if (!QQ_MESSAGE_EVENT_TYPES.some((candidate) => candidate === eventType)) return undefined
  const typedEvent = eventType as QQMessageEventType
  const raw = record(value)
  const author = record(raw.author)
  const reference = parseReference(raw)
  const platformMessageId = required(text(raw.id, reference.messageId), 'message ID')
  const now = options.now?.() ?? Date.now()

  if (typedEvent === 'C2C_MESSAGE_CREATE') {
    const senderOpenId = required(text(author.user_openid, author.id, author.union_openid), 'C2C sender OpenID')
    const senderDisplayName = displayName(author)
    const content = normalizeQQContent(raw.content)
    return {
      eventType: typedEvent,
      platformMessageId,
      target: { kind: 'c2c', openId: senderOpenId },
      senderOpenId,
      ...(senderDisplayName === undefined ? {} : { senderDisplayName }),
      ...(content === undefined ? {} : { content }),
      attachments: parseAttachments(raw.attachments),
      ...(reference.reference === undefined ? {} : { platformReference: reference.reference }),
      platformTimestamp: parseTimestamp(raw.timestamp, now),
    }
  }

  const groupOpenId = required(text(raw.group_openid, raw.group_id), 'group OpenID')
  const senderOpenId = required(text(author.member_openid, author.id), 'group sender OpenID')
  const mentions = records(raw.mentions)
    .map((mention) => {
      const openId = text(mention.member_openid, mention.user_openid, mention.id)
      if (!openId) return undefined
      const mentionDisplayName = displayName(mention)
      return {
        openId,
        ...(mentionDisplayName === undefined ? {} : { displayName: mentionDisplayName }),
        ...(mention.bot === true ? { bot: true } : {}),
      }
    })
    .filter((mention): mention is NonNullable<typeof mention> => mention !== undefined)
  const targetDisplayName = text(raw.group_name, raw.group_nick, raw.group_title)
  const senderDisplayName = displayName(author)
  const content = stripStructuredMentions(normalizeQQContent(raw.content), mentions)
  return {
    eventType: typedEvent,
    platformMessageId,
    target: { kind: 'group', openId: groupOpenId },
    ...(targetDisplayName === undefined ? {} : { targetDisplayName }),
    senderOpenId,
    ...(senderDisplayName === undefined ? {} : { senderDisplayName }),
    ...(content === undefined ? {} : { content }),
    mentions,
    attachments: parseAttachments(raw.attachments),
    ...(reference.reference === undefined ? {} : { platformReference: reference.reference }),
    platformTimestamp: parseTimestamp(raw.timestamp, now),
  }
}
