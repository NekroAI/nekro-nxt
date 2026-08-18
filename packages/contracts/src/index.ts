import { z } from 'zod'

declare const opaqueIdBrand: unique symbol

/** Nominal identity used across persistence and process boundaries. */
export type OpaqueId<Name extends string> = string & { readonly [opaqueIdBrand]: Name }

export type AgentId = OpaqueId<'AgentId'>
export type AgentRevisionId = OpaqueId<'AgentRevisionId'>
export type ConnectionId = OpaqueId<'ConnectionId'>
export type ChannelId = OpaqueId<'ChannelId'>
export type ChannelEventId = OpaqueId<'ChannelEventId'>
export type PlatformIdentityId = OpaqueId<'PlatformIdentityId'>
export type ChannelMemberId = OpaqueId<'ChannelMemberId'>
export type BindingId = OpaqueId<'BindingId'>
export type AdmissionId = OpaqueId<'AdmissionId'>
export type AssetOccurrenceId = OpaqueId<'AssetOccurrenceId'>
export type OutboundIntentId = OpaqueId<'OutboundIntentId'>
export type DeliveryReceiptId = OpaqueId<'DeliveryReceiptId'>
export type LogicalMessageId = OpaqueId<'LogicalMessageId'>
export type PhysicalDeliveryId = OpaqueId<'PhysicalDeliveryId'>
export type AssetId = OpaqueId<'AssetId'>
export type EpisodeId = OpaqueId<'EpisodeId'>
export type EpisodeHandoffId = OpaqueId<'EpisodeHandoffId'>
export type ExtensionDraftId = OpaqueId<'ExtensionDraftId'>
export type DraftPackageId = OpaqueId<'DraftPackageId'>
export type ExtensionId = OpaqueId<'ExtensionId'>
export type ExtensionRevisionId = OpaqueId<'ExtensionRevisionId'>
export type ExtensionSaveOperationId = OpaqueId<'ExtensionSaveOperationId'>
export type AgentActivationId = OpaqueId<'AgentActivationId'>

const opaqueId = <Name extends string>(name: Name) =>
  z
    .string()
    .trim()
    .min(1, `${name} must not be empty.`)
    .transform((value) => value as OpaqueId<Name>)

export const AgentIdSchema = opaqueId('AgentId')
export const AgentRevisionIdSchema = opaqueId('AgentRevisionId')
export const ConnectionIdSchema = opaqueId('ConnectionId')
export const ChannelIdSchema = opaqueId('ChannelId')
export const ChannelEventIdSchema = opaqueId('ChannelEventId')
export const PlatformIdentityIdSchema = opaqueId('PlatformIdentityId')
export const ChannelMemberIdSchema = opaqueId('ChannelMemberId')
export const BindingIdSchema = opaqueId('BindingId')
export const AdmissionIdSchema = opaqueId('AdmissionId')
export const AssetOccurrenceIdSchema = opaqueId('AssetOccurrenceId')
export const OutboundIntentIdSchema = opaqueId('OutboundIntentId')
export const DeliveryReceiptIdSchema = opaqueId('DeliveryReceiptId')
export const LogicalMessageIdSchema = opaqueId('LogicalMessageId')
export const PhysicalDeliveryIdSchema = opaqueId('PhysicalDeliveryId')
export const AssetIdSchema = opaqueId('AssetId')
export const EpisodeIdSchema = opaqueId('EpisodeId')
export const EpisodeHandoffIdSchema = opaqueId('EpisodeHandoffId')
export const ExtensionDraftIdSchema = opaqueId('ExtensionDraftId')
export const DraftPackageIdSchema = opaqueId('DraftPackageId')
export const ExtensionIdSchema = opaqueId('ExtensionId')
export const ExtensionRevisionIdSchema = opaqueId('ExtensionRevisionId')
export const ExtensionSaveOperationIdSchema = opaqueId('ExtensionSaveOperationId')
export const AgentActivationIdSchema = opaqueId('AgentActivationId')

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

export type MessagePart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'mention'; readonly memberId: ChannelMemberId }
  | { readonly type: 'image'; readonly assetId: AssetId; readonly alt?: string }
  | { readonly type: 'file'; readonly assetId: AssetId; readonly name?: string }
  | { readonly type: 'audio'; readonly assetId: AssetId }
  | { readonly type: 'quote'; readonly messageId: LogicalMessageId }

export const MessagePartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }).strict(),
  z.object({ type: z.literal('mention'), memberId: ChannelMemberIdSchema }).strict(),
  z.object({ type: z.literal('image'), assetId: AssetIdSchema, alt: z.string().optional() }).strict(),
  z.object({ type: z.literal('file'), assetId: AssetIdSchema, name: z.string().optional() }).strict(),
  z.object({ type: z.literal('audio'), assetId: AssetIdSchema }).strict(),
  z.object({ type: z.literal('quote'), messageId: LogicalMessageIdSchema }).strict(),
])

export const MessagePartsSchema = z.array(MessagePartSchema).min(1)

export function parseMessageParts(input: unknown): MessagePart[] {
  return MessagePartsSchema.parse(input) as MessagePart[]
}
