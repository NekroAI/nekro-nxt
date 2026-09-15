import type { AdapterChannelInboundEvent } from '@nekro-nxt/adapter-sdk'
import type { AssetId, ChannelId, ChannelMemberId, ConnectionId, JsonValue, MessagePart } from '@nekro-nxt/contracts'
import {
  WECHAT_ILINK_ADAPTER_KEY,
  WECHAT_ILINK_CONTEXT_TOKEN_STATE_PREFIX,
  type WechatIlinkCdnMedia,
  type WechatIlinkFileItem,
  type WechatIlinkImageItem,
  type WechatIlinkMessage,
  type WechatIlinkMessageItem,
} from './types.js'

const WECHAT_TEXT_ITEM_TYPE = 1
const WECHAT_IMAGE_ITEM_TYPE = 2
const WECHAT_FILE_ITEM_TYPE = 4
const WECHAT_BOT_MESSAGE_TYPE = 2

export const encodeWechatId = (id: string): string => Buffer.from(id, 'utf8').toString('base64url')

export const decodeWechatId = (encoded: string): string | undefined => {
  try {
    const decoded = Buffer.from(encoded, 'base64url').toString('utf8')
    return Buffer.from(decoded, 'utf8').toString('base64url') === encoded ? decoded : undefined
  } catch {
    return undefined
  }
}

export const platformChannelIdFromUserId = (userId: string): string => 'direct:' + encodeWechatId(userId)

export const contextTokenStateKey = (userId: string): string =>
  WECHAT_ILINK_CONTEXT_TOKEN_STATE_PREFIX + platformChannelIdFromUserId(userId)

const itemType = (item: WechatIlinkMessageItem): number | undefined => item.item_type ?? item.type

export const wechatAccountIdsMatch = (left: string, right: string): boolean => {
  const first = left.trim()
  const second = right.trim()
  if (!first || !second) return false
  return first === second
}

export const isWechatIlinkDeletedMessage = (message: WechatIlinkMessage): boolean => {
  const deletedAt = message.delete_time_ms
  return typeof deletedAt === 'number' && Number.isFinite(deletedAt) && deletedAt > 0
}

export const isWechatIlinkInboundEcho = (message: WechatIlinkMessage, accountId?: string): boolean => {
  if (message.message_type === WECHAT_BOT_MESSAGE_TYPE) return true
  const fromUserId = message.from_user_id?.trim()
  return Boolean(accountId && fromUserId && wechatAccountIdsMatch(fromUserId, accountId))
}

const trimmedString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

const firstString = (values: readonly unknown[]): string | undefined => {
  for (const value of values) {
    const text = trimmedString(value)
    if (text) return text
  }
  return undefined
}

const byteSize = (value: unknown): number | undefined => {
  const numeric =
    typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : undefined
  return numeric !== undefined && Number.isFinite(numeric) && numeric >= 0 ? Math.trunc(numeric) : undefined
}

const hasCdnDownloadParam = (media: WechatIlinkCdnMedia | undefined): boolean =>
  trimmedString(media?.encrypt_query_param) !== undefined

const hasEncryptedCdnDownloadParam = (media: WechatIlinkCdnMedia | undefined): boolean =>
  trimmedString(media?.encrypt_query_param) !== undefined && trimmedString(media?.aes_key) !== undefined

export const wechatMessageTextParts = (message: WechatIlinkMessage): readonly string[] =>
  (message.item_list ?? [])
    .filter((item) => itemType(item) === WECHAT_TEXT_ITEM_TYPE)
    .map((item) => item.text_item?.text ?? '')
    .filter((text) => text.length > 0)

export type WechatIlinkInboundMediaKind = 'image' | 'file'

export interface WechatIlinkInboundMediaAttachment {
  readonly kind: WechatIlinkInboundMediaKind
  readonly item: WechatIlinkMessageItem
  readonly url?: string
  readonly fileName?: string
  readonly mediaType?: string
  readonly byteSize?: number
}

export type WechatIlinkInboundImageAttachment = WechatIlinkInboundMediaAttachment & { readonly kind: 'image' }
export type WechatIlinkInboundFileAttachment = WechatIlinkInboundMediaAttachment & { readonly kind: 'file' }

export interface WechatIlinkInboundMediaOccurrence {
  readonly partIndex: number
  readonly attachment: WechatIlinkInboundMediaAttachment
}

export type WechatIlinkInboundImageOccurrence = WechatIlinkInboundMediaOccurrence & {
  readonly attachment: WechatIlinkInboundImageAttachment
}

const imageAttachmentFromPayloads = (
  item: WechatIlinkMessageItem,
  image: WechatIlinkImageItem | undefined,
): WechatIlinkInboundImageAttachment | undefined => {
  const url = firstString([
    image?.url,
    image?.download_url,
    image?.cdn_url,
    image?.file_url,
    image?.thumb_url,
    item.url,
    item.download_url,
    item.cdn_url,
    item.file_url,
    item.thumb_url,
  ])
  const hasSdkMedia = hasCdnDownloadParam(image?.media) || hasCdnDownloadParam(item.media)
  if (!url && !hasSdkMedia) return undefined
  const fileName = firstString([image?.file_name, image?.name, item.file_name, item.name])
  const mediaType = firstString([
    image?.mime_type,
    image?.media_type,
    image?.content_type,
    item.mime_type,
    item.media_type,
    item.content_type,
  ])
  const size = byteSize(image?.size ?? item.size ?? image?.mid_size ?? image?.hd_size ?? image?.thumb_size)
  return {
    kind: 'image',
    item,
    ...(url === undefined ? {} : { url }),
    ...(fileName === undefined ? {} : { fileName }),
    ...(mediaType === undefined ? {} : { mediaType }),
    ...(size === undefined ? {} : { byteSize: size }),
  }
}

const fileAttachmentFromPayloads = (
  item: WechatIlinkMessageItem,
  file: WechatIlinkFileItem | undefined,
): WechatIlinkInboundFileAttachment | undefined => {
  const url = firstString([
    file?.url,
    file?.download_url,
    file?.cdn_url,
    file?.file_url,
    item.url,
    item.download_url,
    item.cdn_url,
    item.file_url,
  ])
  const hasSdkMedia = hasEncryptedCdnDownloadParam(file?.media) || hasEncryptedCdnDownloadParam(item.media)
  if (!url && !hasSdkMedia) return undefined
  const fileName = firstString([file?.file_name, file?.name, item.file_name, item.name])
  const mediaType = firstString([
    file?.mime_type,
    file?.media_type,
    file?.content_type,
    item.mime_type,
    item.media_type,
    item.content_type,
  ])
  const size = byteSize(file?.len ?? file?.size ?? item.len ?? item.size)
  return {
    kind: 'file',
    item,
    ...(url === undefined ? {} : { url }),
    ...(fileName === undefined ? {} : { fileName }),
    ...(mediaType === undefined ? {} : { mediaType }),
    ...(size === undefined ? {} : { byteSize: size }),
  }
}

export const wechatMessageImageAttachment = (
  item: WechatIlinkMessageItem,
): WechatIlinkInboundImageAttachment | undefined =>
  itemType(item) === WECHAT_IMAGE_ITEM_TYPE || item.image_item !== undefined
    ? imageAttachmentFromPayloads(item, item.image_item)
    : undefined

export const wechatMessageFileAttachment = (
  item: WechatIlinkMessageItem,
): WechatIlinkInboundFileAttachment | undefined =>
  itemType(item) === WECHAT_FILE_ITEM_TYPE || item.file_item !== undefined
    ? fileAttachmentFromPayloads(item, item.file_item)
    : undefined

const isWechatImageItem = (item: WechatIlinkMessageItem): boolean =>
  itemType(item) === WECHAT_IMAGE_ITEM_TYPE || item.image_item !== undefined

const isWechatFileItem = (item: WechatIlinkMessageItem): boolean =>
  itemType(item) === WECHAT_FILE_ITEM_TYPE || item.file_item !== undefined

export const wechatMessageImageAttachments = (
  message: WechatIlinkMessage,
): readonly WechatIlinkInboundImageAttachment[] =>
  (message.item_list ?? [])
    .filter(isWechatImageItem)
    .map(wechatMessageImageAttachment)
    .filter((item): item is WechatIlinkInboundImageAttachment => item !== undefined)

export const wechatMessageFileAttachments = (
  message: WechatIlinkMessage,
): readonly WechatIlinkInboundFileAttachment[] =>
  (message.item_list ?? [])
    .filter(isWechatFileItem)
    .map(wechatMessageFileAttachment)
    .filter((item): item is WechatIlinkInboundFileAttachment => item !== undefined)

export interface WechatIlinkNormalizedInboundMessage {
  readonly platformChannelId: string
  readonly platformUserId: string
  readonly platformMessageId: string
  readonly platformEventId: string
  readonly platformSequence?: number
  readonly platformTimestamp: number
  readonly receivedAt: number
  readonly parts: readonly MessagePart[]
  readonly mediaAttachments: readonly WechatIlinkInboundMediaOccurrence[]
  readonly imageAttachments: readonly WechatIlinkInboundImageOccurrence[]
  readonly contextToken?: string
  readonly facts: Readonly<Record<string, JsonValue>>
}

export interface WechatIlinkNormalizeOptions {
  readonly now: () => number
  readonly accountId?: string
}

const platformMessageId = (message: WechatIlinkMessage): string | undefined => {
  if (message.message_id !== undefined && String(message.message_id).trim()) return String(message.message_id)
  if (message.client_id !== undefined && message.client_id.trim()) return 'client:' + message.client_id
  if (message.seq !== undefined && message.create_time_ms !== undefined) {
    return 'seq:' + message.seq + ':' + message.create_time_ms
  }
  return undefined
}

export const normalizeWechatIlinkInboundMessage = (
  message: WechatIlinkMessage,
  options: WechatIlinkNormalizeOptions,
): WechatIlinkNormalizedInboundMessage | undefined => {
  if (isWechatIlinkDeletedMessage(message)) return undefined
  if (isWechatIlinkInboundEcho(message, options.accountId)) return undefined
  const fromUserId = message.from_user_id?.trim()
  if (!fromUserId) return undefined
  const id = platformMessageId(message)
  if (!id) return undefined
  const parts: MessagePart[] = []
  const mediaAttachments: WechatIlinkInboundMediaOccurrence[] = []
  const imageAttachments: WechatIlinkInboundImageOccurrence[] = []
  let imageItemCount = 0
  let fileItemCount = 0
  for (const item of message.item_list ?? []) {
    if (itemType(item) === WECHAT_TEXT_ITEM_TYPE) {
      const text = item.text_item?.text ?? ''
      if (text.length > 0) parts.push({ type: 'text', text })
      continue
    }
    const isImage = isWechatImageItem(item)
    const isFile = isWechatFileItem(item)
    if (!isImage && !isFile) continue
    const attachment = isImage ? wechatMessageImageAttachment(item) : wechatMessageFileAttachment(item)
    const kind: WechatIlinkInboundMediaKind = isImage ? 'image' : 'file'
    if (kind === 'image') imageItemCount += 1
    else fileItemCount += 1
    if (attachment) {
      const partIndex = parts.length
      parts.push({
        type: 'rich',
        adapterKey: WECHAT_ILINK_ADAPTER_KEY,
        kind,
        summary: kind === 'image' ? '微信 iLink 图片等待导入。' : '微信 iLink 文件等待导入。',
        ...(attachment.fileName === undefined ? {} : { title: attachment.fileName }),
      })
      mediaAttachments.push({ partIndex, attachment })
      if (attachment.kind === 'image') imageAttachments.push({ partIndex, attachment })
      continue
    }
    parts.push({
      type: 'rich',
      adapterKey: WECHAT_ILINK_ADAPTER_KEY,
      kind,
      summary: kind === 'image' ? '微信 iLink 图片暂时不可下载。' : '微信 iLink 文件暂时不可下载。',
    })
  }
  if (parts.length === 0) return undefined
  const timestamp = message.create_time_ms ?? options.now()
  const itemTypes = (message.item_list ?? [])
    .map((item) => itemType(item))
    .filter((type): type is number => type !== undefined)
  return {
    platformChannelId: platformChannelIdFromUserId(fromUserId),
    platformUserId: fromUserId,
    platformMessageId: id,
    platformEventId: 'wechat-ilink:' + id,
    ...(message.seq === undefined ? {} : { platformSequence: message.seq }),
    platformTimestamp: timestamp,
    receivedAt: options.now(),
    parts,
    mediaAttachments,
    imageAttachments,
    ...(message.context_token?.trim() ? { contextToken: message.context_token } : {}),
    facts: {
      ...(message.session_id === undefined ? {} : { sessionId: message.session_id }),
      ...(message.message_state === undefined ? {} : { messageState: message.message_state }),
      hasContextToken: Boolean(message.context_token?.trim()),
      itemTypes,
      ...(imageItemCount === 0 ? {} : { imageItemCount, downloadableImageItemCount: imageAttachments.length }),
      ...(fileItemCount === 0
        ? {}
        : {
            fileItemCount,
            downloadableFileItemCount: mediaAttachments.filter((occurrence) => occurrence.attachment.kind === 'file')
              .length,
          }),
      hasGroupId: Boolean(message.group_id?.trim()),
    },
  }
}

export const createWechatIlinkInboundEvent = (input: {
  readonly connectionId: ConnectionId
  readonly channelId: ChannelId
  readonly senderMemberId: ChannelMemberId
  readonly normalized: WechatIlinkNormalizedInboundMessage
  readonly parts?: readonly MessagePart[]
  readonly assetOccurrences?: readonly { readonly partIndex: number; readonly assetId: AssetId }[]
}): AdapterChannelInboundEvent => ({
  connectionId: input.connectionId,
  channelId: input.channelId,
  adapterKey: WECHAT_ILINK_ADAPTER_KEY,
  platformEventId: input.normalized.platformEventId,
  platformMessageId: input.normalized.platformMessageId,
  kind: 'message-created',
  senderMemberId: input.senderMemberId,
  parts: [...(input.parts ?? input.normalized.parts)],
  ...(input.normalized.platformSequence === undefined ? {} : { platformSequence: input.normalized.platformSequence }),
  platformTimestamp: input.normalized.platformTimestamp,
  receivedAt: input.normalized.receivedAt,
  dedupeKey: input.normalized.platformEventId,
  facts: input.normalized.facts,
  ...(input.assetOccurrences === undefined || input.assetOccurrences.length === 0
    ? {}
    : { assetOccurrences: [...input.assetOccurrences] }),
})
