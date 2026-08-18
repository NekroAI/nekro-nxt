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

export type JsonValue = null | boolean | number | string | JsonValue[] | { readonly [key: string]: JsonValue }

export const JsonValueSchema = z.json()

export function parseJsonValue(input: unknown): JsonValue {
  return JsonValueSchema.parse(input)
}

/** Current-environment support conclusion for one DSH capability package. */
export type DshPluginSupportStatus = 'verified' | 'loadable-unverified' | 'partial' | 'incompatible' | 'unassessed'

export type DshSupportFacet =
  | 'host-load'
  | 'service-injection'
  | 'lifecycle'
  | 'settings'
  | 'tools'
  | 'providers'
  | 'scope-bundle-preset'
  | 'client-ui'

export type DshFacetStatus = 'supported' | 'unverified' | 'unsupported' | 'failed' | 'not-applicable'

export type DshSupportEvidenceLevel = 'metadata' | 'activation' | 'lifecycle' | 'integration' | 'external-result'

export interface DshClientModuleDescriptor {
  readonly packageName: string
  readonly packageVersion: string
  readonly moduleId: string
  readonly platform: 'web'
  readonly inject: readonly string[]
  readonly bundleDigest: string
  readonly bundleUrl: string
  readonly compatibility: 'ready' | 'missing-dependency' | 'version-conflict' | 'unsupported-remote'
  readonly reasons: readonly string[]
}

export interface PluginSupportAssessment {
  readonly packageName: string
  readonly packageVersion: string
  readonly dshVersion: string
  readonly origin: 'builtin' | 'profile' | 'dynamic'
  readonly overall: DshPluginSupportStatus
  readonly facets: readonly {
    readonly facet: DshSupportFacet
    readonly status: DshFacetStatus
    readonly evidence: readonly {
      readonly level: DshSupportEvidenceLevel
      readonly code: string
      readonly message: string
    }[]
  }[]
  readonly settingsNamespaces: readonly string[]
  readonly clientModule?: DshClientModuleDescriptor
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

export const MessagePartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }).strict(),
  z.object({ type: z.literal('mention'), memberId: ChannelMemberIdSchema }).strict(),
  z.object({ type: z.literal('image'), assetId: AssetIdSchema, alt: z.string().optional() }).strict(),
  z.object({ type: z.literal('file'), assetId: AssetIdSchema, name: z.string().optional() }).strict(),
  z.object({ type: z.literal('audio'), assetId: AssetIdSchema }).strict(),
  z.object({ type: z.literal('quote'), messageId: LogicalMessageIdSchema }).strict(),
])

export type MessagePart = z.infer<typeof MessagePartSchema>

export const MessagePartsSchema = z.array(MessagePartSchema)
export const NonEmptyMessagePartsSchema = MessagePartsSchema.min(1)

export function parseMessageParts(input: unknown): MessagePart[] {
  return MessagePartsSchema.parse(input)
}
