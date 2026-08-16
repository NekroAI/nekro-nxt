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
