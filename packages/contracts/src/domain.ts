import { z } from 'zod'

const brandedId = <Prefix extends string, Brand extends string>(prefix: Prefix, brand: Brand) =>
  z
    .string()
    .regex(new RegExp(`^${prefix}_[0-9A-Za-z]+$`), `${brand} has an invalid format.`)
    .brand(brand)

export const AgentIdSchema = brandedId('agt', 'AgentId')
export const AgentRevisionIdSchema = brandedId('arev', 'AgentRevisionId')
export const ConnectionIdSchema = brandedId('con', 'ConnectionId')
export const ChannelIdSchema = brandedId('chn', 'ChannelId')
export const ChannelEventIdSchema = brandedId('evt', 'ChannelEventId')
export const PlatformIdentityIdSchema = brandedId('pid', 'PlatformIdentityId')
export const ChannelMemberIdSchema = brandedId('mbr', 'ChannelMemberId')
export const AdmissionIdSchema = brandedId('adm', 'AdmissionId')
export const OutboundIntentIdSchema = brandedId('out', 'OutboundIntentId')
export const LogicalMessageIdSchema = brandedId('msg', 'LogicalMessageId')
export const PhysicalDeliveryIdSchema = brandedId('phy', 'PhysicalDeliveryId')
export const AssetIdSchema = brandedId('ast', 'AssetId')
export const EpisodeIdSchema = brandedId('eps', 'EpisodeId')
export const EpisodeHandoffIdSchema = brandedId('hof', 'EpisodeHandoffId')
export const ExtensionIdSchema = brandedId('ext', 'ExtensionId')
export const ExtensionRevisionIdSchema = brandedId('xrv', 'ExtensionRevisionId')

export type AgentId = z.infer<typeof AgentIdSchema>
export type AgentRevisionId = z.infer<typeof AgentRevisionIdSchema>
export type ConnectionId = z.infer<typeof ConnectionIdSchema>
export type ChannelId = z.infer<typeof ChannelIdSchema>
export type ChannelEventId = z.infer<typeof ChannelEventIdSchema>
export type PlatformIdentityId = z.infer<typeof PlatformIdentityIdSchema>
export type ChannelMemberId = z.infer<typeof ChannelMemberIdSchema>
export type AdmissionId = z.infer<typeof AdmissionIdSchema>
export type OutboundIntentId = z.infer<typeof OutboundIntentIdSchema>
export type LogicalMessageId = z.infer<typeof LogicalMessageIdSchema>
export type PhysicalDeliveryId = z.infer<typeof PhysicalDeliveryIdSchema>
export type AssetId = z.infer<typeof AssetIdSchema>
export type EpisodeId = z.infer<typeof EpisodeIdSchema>
export type EpisodeHandoffId = z.infer<typeof EpisodeHandoffIdSchema>
export type ExtensionId = z.infer<typeof ExtensionIdSchema>
export type ExtensionRevisionId = z.infer<typeof ExtensionRevisionIdSchema>

export const ChannelActivityTypeSchema = z.enum([
  'member-poked',
  'profile-liked',
  'member-joined',
  'member-left',
  'member-muted',
  'member-unmuted',
  'member-admin-set',
  'member-admin-unset',
  'member-card-changed',
  'member-title-changed',
  'channel-name-changed',
  'message-recalled',
  'message-reaction-added',
  'message-reaction-removed',
  'file-uploaded',
  'essence-added',
  'essence-removed',
  'friend-added',
  'conversation-entered',
  'card-action-invoked',
  'message-feedback-positive',
  'message-feedback-negative',
  'message-feedback-withdrawn',
])

export type ChannelActivityType = z.infer<typeof ChannelActivityTypeSchema>

const PromptTextSegmentSchema = z.object({ type: z.literal('text'), text: z.string() }).strict()

const PromptReferenceLabelSchema = z.string().trim().min(1).max(120)

const PromptReferenceSegmentSchema = z.discriminatedUnion('kind', [
  z
    .object({
      type: z.literal('reference'),
      kind: z.literal('platform-user'),
      targetId: PlatformIdentityIdSchema,
      labelSnapshot: PromptReferenceLabelSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('reference'),
      kind: z.literal('channel'),
      targetId: ChannelIdSchema,
      labelSnapshot: PromptReferenceLabelSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('reference'),
      kind: z.literal('extension'),
      targetId: ExtensionIdSchema,
      labelSnapshot: PromptReferenceLabelSchema,
    })
    .strict(),
])

export const PromptSegmentSchema = z.union([PromptTextSegmentSchema, PromptReferenceSegmentSchema])

export const PROMPT_DOCUMENT_MAX_REFERENCES = 128
export const PROMPT_DOCUMENT_MAX_PLAIN_TEXT_LENGTH = 64 * 1024

export const PromptDocumentV1Schema = z
  .object({ version: z.literal(1), segments: z.array(PromptSegmentSchema) })
  .strict()
  .superRefine((document, context) => {
    const referenceCount = document.segments.filter((segment) => segment.type === 'reference').length
    if (referenceCount > PROMPT_DOCUMENT_MAX_REFERENCES) {
      context.addIssue({
        code: 'custom',
        message: `Prompt document must not contain more than ${PROMPT_DOCUMENT_MAX_REFERENCES} references.`,
        path: ['segments'],
      })
    }
    const plainTextLength = document.segments.reduce(
      (length, segment) => length + (segment.type === 'text' ? segment.text.length : segment.labelSnapshot.length + 1),
      0,
    )
    if (plainTextLength > PROMPT_DOCUMENT_MAX_PLAIN_TEXT_LENGTH) {
      context.addIssue({
        code: 'custom',
        message: `Prompt document plain-text projection must not exceed ${PROMPT_DOCUMENT_MAX_PLAIN_TEXT_LENGTH} characters.`,
        path: ['segments'],
      })
    }
  })

export type PromptSegment = z.output<typeof PromptSegmentSchema>
export type PromptDocumentV1 = z.output<typeof PromptDocumentV1Schema>

export const promptDocumentFromText = (text: string): PromptDocumentV1 =>
  normalizePromptDocument({ version: 1, segments: text.length === 0 ? [] : [{ type: 'text', text }] })

export const promptDocumentPlainText = (document: PromptDocumentV1): string =>
  document.segments.map((segment) => (segment.type === 'text' ? segment.text : `@${segment.labelSnapshot}`)).join('')

export const normalizePromptDocument = (input: unknown): PromptDocumentV1 => {
  const parsed = PromptDocumentV1Schema.parse(input)
  const segments: PromptSegment[] = []
  for (const segment of parsed.segments) {
    if (segment.type === 'text') {
      if (segment.text.length === 0) continue
      const previous = segments.at(-1)
      if (previous?.type === 'text') {
        segments[segments.length - 1] = { type: 'text', text: `${previous.text}${segment.text}` }
      } else {
        segments.push(segment)
      }
      continue
    }
    segments.push(segment)
  }
  return PromptDocumentV1Schema.parse({ version: 1, segments })
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { readonly [key: string]: JsonValue }

export const JsonValueSchema = z.json()

export function parseJsonValue(input: unknown): JsonValue {
  return JsonValueSchema.parse(input)
}

/** Package identity and source for one DSH extension visible in the current Host. */
export interface DshPluginCatalogEntry {
  readonly packageName: string
  readonly packageVersion: string
  readonly origin: 'builtin' | 'profile' | 'dynamic'
  readonly settingsNamespaces: readonly string[]
  readonly loadError?: { readonly code: string; readonly message: string }
}

export interface DshSettingsNamespaceView {
  readonly ns: string
  readonly schema: unknown
  readonly resolved: unknown
  readonly base?: unknown
  readonly user?: unknown
  readonly applies: 'live' | 'restart'
  readonly secrets: readonly { readonly path: readonly string[]; readonly set: boolean }[]
  readonly revision: number
  readonly writable: boolean
  readonly owner?: { readonly packageName: string; readonly packageVersion: string }
}

export type DshSettingsPathOperation =
  | { readonly op: 'set'; readonly path: readonly string[]; readonly value: unknown }
  | { readonly op: 'unset'; readonly path: readonly string[] }

export interface DshSettingsMutationRequest {
  readonly expectedRevision: number
  readonly ops: readonly DshSettingsPathOperation[]
}

export interface DshCredentialView {
  readonly configured: boolean
  readonly source?: string
  readonly writable: boolean
}

const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).byteLength

export const RICH_EXTENSION_MAX_BYTES = 64 * 1024

export const RichExtensionSchema = JsonValueSchema.refine(
  (value) => utf8ByteLength(JSON.stringify(value)) <= RICH_EXTENSION_MAX_BYTES,
  `rich extension must not exceed ${RICH_EXTENSION_MAX_BYTES} bytes.`,
)

export const RichTargetUrlSchema = z
  .url()
  .max(2048)
  .refine((value) => {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:'
  }, 'rich target URL must use HTTP or HTTPS.')

export const MessagePartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }).strict(),
  z.object({ type: z.literal('mention'), memberId: ChannelMemberIdSchema }).strict(),
  z.object({ type: z.literal('image'), assetId: AssetIdSchema, alt: z.string().optional() }).strict(),
  z.object({ type: z.literal('file'), assetId: AssetIdSchema, name: z.string().optional() }).strict(),
  z.object({ type: z.literal('audio'), assetId: AssetIdSchema }).strict(),
  z.object({ type: z.literal('quote'), messageId: LogicalMessageIdSchema }).strict(),
  z
    .object({
      type: z.literal('rich'),
      adapterKey: z.string().trim().min(1).max(64),
      kind: z.string().trim().min(1).max(64),
      summary: z.string().trim().min(1).max(500),
      title: z.string().trim().min(1).max(200).optional(),
      source: z.string().trim().min(1).max(80).optional(),
      targetUrl: RichTargetUrlSchema.optional(),
      previewAssetId: AssetIdSchema.optional(),
      extension: RichExtensionSchema.optional(),
    })
    .strict(),
])

export type MessagePart = z.infer<typeof MessagePartSchema>

export const MessagePartsSchema = z.array(MessagePartSchema)
export const NonEmptyMessagePartsSchema = MessagePartsSchema.min(1)

export function parseMessageParts(input: unknown): MessagePart[] {
  return MessagePartsSchema.parse(input)
}

const collectRichAssetIds = (value: JsonValue | undefined, into: AssetId[]): void => {
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') return
  if (typeof value === 'string') return
  if (Array.isArray(value)) {
    for (const item of value) collectRichAssetIds(item, into)
    return
  }
  for (const [key, child] of Object.entries(value)) {
    if ((key === 'imageAssetId' || key === 'previewAssetId') && typeof child === 'string') {
      const parsed = AssetIdSchema.safeParse(child)
      if (parsed.success) into.push(parsed.data)
    } else {
      collectRichAssetIds(child, into)
    }
  }
}

export const messagePartAssetIds = (part: MessagePart): readonly AssetId[] => {
  if (part.type === 'image' || part.type === 'file' || part.type === 'audio') return [part.assetId]
  if (part.type !== 'rich') return []
  const ids: AssetId[] = []
  if (part.previewAssetId) ids.push(part.previewAssetId)
  collectRichAssetIds(part.extension, ids)
  return ids
}

export const messagePartAssetId = (part: MessagePart): AssetId | undefined => messagePartAssetIds(part)[0]

const asJsonRecord = (value: JsonValue | undefined): Readonly<Record<string, JsonValue>> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined

const richItemLine = (value: JsonValue): string | undefined => {
  const item = asJsonRecord(value)
  if (!item) return undefined
  const sender = typeof item['sender'] === 'string' ? item['sender'] : undefined
  const text = typeof item['text'] === 'string' ? item['text'] : undefined
  const card = asJsonRecord(item['card'])
  const cardSummary =
    typeof card?.['summary'] === 'string'
      ? card['summary']
      : typeof card?.['title'] === 'string'
        ? card['title']
        : undefined
  const imageName = typeof item['imageName'] === 'string' ? item['imageName'] : undefined
  const imageText = typeof item['imageAssetId'] === 'string' ? `[图片${imageName ? ` ${imageName}` : ''}]` : undefined
  const body = [text, cardSummary ? `[卡片] ${cardSummary}` : undefined, imageText]
    .filter((part): part is string => Boolean(part && part.length > 0))
    .join(' ')
  if (!sender && !body) return undefined
  return sender ? `${sender}：${body}` : body
}

/** Flatten a rich part for search and model context. */
export const richPartContextText = (part: Extract<MessagePart, { type: 'rich' }>): string => {
  const header = [part.summary, part.title, part.source].filter(
    (value, index, all): value is string =>
      typeof value === 'string' && value.length > 0 && all.indexOf(value) === index,
  )
  const items = asJsonRecord(part.extension)?.['items']
  const itemLines = Array.isArray(items)
    ? items.flatMap((item) => {
        const line = richItemLine(item)
        return line === undefined ? [] : [line]
      })
    : []
  return [...header, ...itemLines].join('\n')
}

export const messagePartsSearchText = (parts: readonly MessagePart[]): string =>
  parts
    .flatMap((part) => {
      if (part.type === 'text') return [part.text]
      if (part.type === 'rich') return [richPartContextText(part)]
      return []
    })
    .join('\n')
