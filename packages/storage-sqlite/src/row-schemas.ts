import { createSelectSchema } from 'drizzle-zod'
import { z } from 'zod'
import {
  AdmissionIdSchema,
  AgentIdSchema,
  AgentRevisionIdSchema,
  AssetIdSchema,
  ChannelEventIdSchema,
  ChannelIdSchema,
  ChannelMemberIdSchema,
  ConnectionIdSchema,
  EpisodeHandoffIdSchema,
  EpisodeIdSchema,
  ExtensionIdSchema,
  ExtensionRevisionIdSchema,
  JsonValueSchema,
  LogicalMessageIdSchema,
  MessagePartsSchema,
  OutboundIntentIdSchema,
  PhysicalDeliveryIdSchema,
  PlatformIdentityIdSchema,
} from '@nekro-nxt/contracts'
import { AgentCapabilityGrantsSchema } from '@nekro-nxt/core'
import {
  admissionEvents,
  admissions,
  agentActivations,
  agentCurrentRevisions,
  agentDefinitions,
  agentRevisions,
  assetChannelGrants,
  assetOccurrences,
  assets,
  channelBindings,
  channelEvents,
  channelMembers,
  channels,
  connectionState,
  connections,
  episodeHandoffEvents,
  episodeHandoffs,
  episodes,
  extensionRevisions,
  extensionRevisionVerifications,
  localExtensions,
  outboundIntents,
  physicalDeliveries,
  platformIdentities,
} from './schema.js'

const jsonObjectSchema = z.record(z.string(), JsonValueSchema)
const credentialRefsSchema = z.record(z.string().min(1), z.string().min(1))

export const AgentDefinitionRowSchema = createSelectSchema(agentDefinitions, { id: AgentIdSchema })
export const AgentRevisionRowSchema = createSelectSchema(agentRevisions, {
  id: AgentRevisionIdSchema,
  agentId: AgentIdSchema,
  capabilities: AgentCapabilityGrantsSchema,
})
export const AgentCurrentRevisionRowSchema = createSelectSchema(agentCurrentRevisions, {
  agentId: AgentIdSchema,
  revisionId: AgentRevisionIdSchema,
})
export const ConnectionRowSchema = createSelectSchema(connections, {
  id: ConnectionIdSchema,
  config: JsonValueSchema,
  credentialRefs: credentialRefsSchema,
  alias: z.string().max(80).nullable(),
})
export const ConnectionStateRowSchema = createSelectSchema(connectionState, {
  connectionId: ConnectionIdSchema,
  state: JsonValueSchema,
})
export const ChannelRowSchema = createSelectSchema(channels, {
  id: ChannelIdSchema,
  connectionId: ConnectionIdSchema,
})
export const PlatformIdentityRowSchema = createSelectSchema(platformIdentities, {
  id: PlatformIdentityIdSchema,
  connectionId: ConnectionIdSchema,
})
export const ChannelMemberRowSchema = createSelectSchema(channelMembers, {
  id: ChannelMemberIdSchema,
  channelId: ChannelIdSchema,
  platformIdentityId: PlatformIdentityIdSchema,
})
export const ChannelBindingRowSchema = createSelectSchema(channelBindings, {
  channelId: ChannelIdSchema,
  agentId: AgentIdSchema,
})
export const ChannelEventRowSchema = createSelectSchema(channelEvents, {
  id: ChannelEventIdSchema,
  logicalMessageId: LogicalMessageIdSchema,
  channelId: ChannelIdSchema,
  senderMemberId: ChannelMemberIdSchema.nullable(),
  parts: MessagePartsSchema,
  facts: jsonObjectSchema.nullable(),
})
export const EpisodeRowSchema = createSelectSchema(episodes, {
  id: EpisodeIdSchema,
  channelId: ChannelIdSchema,
  agentId: AgentIdSchema,
  agentRevisionId: AgentRevisionIdSchema,
  openedAtEventId: ChannelEventIdSchema,
  lastAdmittedEventId: ChannelEventIdSchema.nullable(),
  closedAtEventId: ChannelEventIdSchema.nullable(),
})
export const EpisodeHandoffRowSchema = createSelectSchema(episodeHandoffs, {
  id: EpisodeHandoffIdSchema,
  fromEpisodeId: EpisodeIdSchema,
  toEpisodeId: EpisodeIdSchema,
})
export const EpisodeHandoffEventRowSchema = createSelectSchema(episodeHandoffEvents, {
  handoffId: EpisodeHandoffIdSchema,
  eventId: ChannelEventIdSchema,
})
export const AdmissionRowSchema = createSelectSchema(admissions, {
  id: AdmissionIdSchema,
  episodeId: EpisodeIdSchema,
})
export const AdmissionEventRowSchema = createSelectSchema(admissionEvents, {
  admissionId: AdmissionIdSchema,
  eventId: ChannelEventIdSchema,
})
export const OutboundIntentRowSchema = createSelectSchema(outboundIntents, {
  id: OutboundIntentIdSchema,
  logicalMessageId: LogicalMessageIdSchema,
  episodeId: EpisodeIdSchema,
  agentRevisionId: AgentRevisionIdSchema,
  parts: MessagePartsSchema,
})
export const PhysicalDeliveryRowSchema = createSelectSchema(physicalDeliveries, {
  id: PhysicalDeliveryIdSchema,
  intentId: OutboundIntentIdSchema,
  parts: MessagePartsSchema,
  adapterContext: JsonValueSchema.nullable(),
  capabilityOutcomes: jsonObjectSchema.nullable(),
})
export const AssetRowSchema = createSelectSchema(assets, { id: AssetIdSchema })
export const AssetOccurrenceRowSchema = createSelectSchema(assetOccurrences, {
  channelEventId: ChannelEventIdSchema,
  assetId: AssetIdSchema,
})
export const AssetChannelGrantRowSchema = createSelectSchema(assetChannelGrants, {
  assetId: AssetIdSchema,
  channelId: ChannelIdSchema,
})
export const LocalExtensionRowSchema = createSelectSchema(localExtensions, {
  id: ExtensionIdSchema,
  createdByAgentId: AgentIdSchema.nullable(),
})
export const ExtensionRevisionRowSchema = createSelectSchema(extensionRevisions, {
  id: ExtensionRevisionIdSchema,
  extensionId: ExtensionIdSchema,
})
export const ExtensionRevisionVerificationRowSchema = createSelectSchema(extensionRevisionVerifications, {
  revisionId: ExtensionRevisionIdSchema,
  evidence: JsonValueSchema,
})
export const AgentActivationRowSchema = createSelectSchema(agentActivations, {
  agentId: AgentIdSchema,
  extensionId: ExtensionIdSchema,
  extensionRevisionId: ExtensionRevisionIdSchema,
  config: JsonValueSchema,
})

export const CoreRowSchemas = {
  agentDefinitions: AgentDefinitionRowSchema,
  agentRevisions: AgentRevisionRowSchema,
  agentCurrentRevisions: AgentCurrentRevisionRowSchema,
  connections: ConnectionRowSchema,
  connectionState: ConnectionStateRowSchema,
  channels: ChannelRowSchema,
  platformIdentities: PlatformIdentityRowSchema,
  channelMembers: ChannelMemberRowSchema,
  channelBindings: ChannelBindingRowSchema,
  channelEvents: ChannelEventRowSchema,
  episodes: EpisodeRowSchema,
  episodeHandoffs: EpisodeHandoffRowSchema,
  episodeHandoffEvents: EpisodeHandoffEventRowSchema,
  admissions: AdmissionRowSchema,
  admissionEvents: AdmissionEventRowSchema,
  outboundIntents: OutboundIntentRowSchema,
  physicalDeliveries: PhysicalDeliveryRowSchema,
  assets: AssetRowSchema,
  assetOccurrences: AssetOccurrenceRowSchema,
  assetChannelGrants: AssetChannelGrantRowSchema,
  localExtensions: LocalExtensionRowSchema,
  extensionRevisions: ExtensionRevisionRowSchema,
  extensionRevisionVerifications: ExtensionRevisionVerificationRowSchema,
  agentActivations: AgentActivationRowSchema,
} as const
