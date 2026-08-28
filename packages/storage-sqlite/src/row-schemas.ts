import { createSelectSchema } from 'drizzle-zod'
import { z } from 'zod'
import {
  AdmissionIdSchema,
  AgentIdSchema,
  AgentRevisionIdSchema,
  AssetIdSchema,
  ChannelEventIdSchema,
  ChannelActivityTypeSchema,
  ChannelIdSchema,
  ChannelMemberIdSchema,
  ConnectionIdSchema,
  DshPluginEntryIdSchema,
  DshPluginPackageIdSchema,
  EpisodeHandoffIdSchema,
  EpisodeIdSchema,
  ExtensionIdSchema,
  ExtensionRevisionIdSchema,
  HostPageIconSchema,
  HostUiPageInstanceIdSchema,
  HostUiPermissionDeclarationSchema,
  JsonValueSchema,
  LogicalMessageIdSchema,
  ManagementDeviceIdSchema,
  MessagePartsSchema,
  OutboundIntentIdSchema,
  PhysicalDeliveryIdSchema,
  PlatformIdentityIdSchema,
  PromptDocumentV1Schema,
  ServerInstanceIdSchema,
} from '@nekro-nxt/contracts'
import {
  AgentCapabilityGrantsSchema,
  DynamicClientApprovalPolicySchema,
  ImageUnderstandingPolicySchema,
} from '@nekro-nxt/core'
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
  dshPluginActivations,
  dshPluginDiagnostics,
  dshPluginEntries,
  dshPluginPackages,
  episodeHandoffEvents,
  episodeHandoffs,
  episodes,
  extensionRevisions,
  extensionRevisionVerifications,
  extensionClientDiagnostics,
  hostSecurityMetadata,
  hostExtensionInstallations,
  hostUiDiagnostics,
  hostUiPageEntries,
  hostUiPagePreferences,
  hostUiPermissionGrants,
  localExtensions,
  managementDevices,
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
  imagePolicy: ImageUnderstandingPolicySchema,
  dynamicClientApprovalPolicy: DynamicClientApprovalPolicySchema,
  personaDocument: PromptDocumentV1Schema.nullable(),
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
  autoCreatedForAgentId: AgentIdSchema.nullable(),
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
  eventTriggers: z.array(ChannelActivityTypeSchema),
})
export const ChannelEventRowSchema = createSelectSchema(channelEvents, {
  id: ChannelEventIdSchema,
  logicalMessageId: LogicalMessageIdSchema,
  channelId: ChannelIdSchema,
  senderMemberId: ChannelMemberIdSchema.nullable(),
  activityType: ChannelActivityTypeSchema.nullable(),
  targetLogicalMessageId: LogicalMessageIdSchema.nullable(),
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
export const HostExtensionInstallationRowSchema = createSelectSchema(hostExtensionInstallations, {
  extensionId: ExtensionIdSchema,
  extensionRevisionId: ExtensionRevisionIdSchema,
})
export const HostUiPageEntryRowSchema = createSelectSchema(hostUiPageEntries, {
  pageInstanceId: HostUiPageInstanceIdSchema,
  icon: HostPageIconSchema,
})
export const HostUiPagePreferenceRowSchema = createSelectSchema(hostUiPagePreferences)
export const HostUiPermissionGrantRowSchema = createSelectSchema(hostUiPermissionGrants, {
  declaration: HostUiPermissionDeclarationSchema,
})
export const HostUiDiagnosticRowSchema = createSelectSchema(hostUiDiagnostics, {
  pageInstanceId: HostUiPageInstanceIdSchema,
})
export const AgentActivationRowSchema = createSelectSchema(agentActivations, {
  agentId: AgentIdSchema,
  extensionId: ExtensionIdSchema,
  extensionRevisionId: ExtensionRevisionIdSchema,
  config: JsonValueSchema,
})
export const DshPluginPackageRowSchema = createSelectSchema(dshPluginPackages, {
  id: DshPluginPackageIdSchema,
  manifest: JsonValueSchema,
  approvedBuilds: z.array(z.string()),
})
export const DshPluginEntryRowSchema = createSelectSchema(dshPluginEntries, {
  id: DshPluginEntryIdSchema,
  packageId: DshPluginPackageIdSchema,
  config: JsonValueSchema,
})
export const DshPluginActivationRowSchema = createSelectSchema(dshPluginActivations, {
  entryId: DshPluginEntryIdSchema,
  agentId: AgentIdSchema.nullable(),
})
export const DshPluginDiagnosticRowSchema = createSelectSchema(dshPluginDiagnostics, {
  entryId: DshPluginEntryIdSchema,
})
export const ExtensionClientDiagnosticRowSchema = createSelectSchema(extensionClientDiagnostics, {
  agentId: AgentIdSchema,
  extensionId: ExtensionIdSchema,
  revisionId: ExtensionRevisionIdSchema,
})
export const HostSecurityMetadataRowSchema = createSelectSchema(hostSecurityMetadata, {
  instanceId: ServerInstanceIdSchema,
  managementKeyDigest: z.string().min(1),
})
export const ManagementDeviceRowSchema = createSelectSchema(managementDevices, {
  id: ManagementDeviceIdSchema,
  label: z.string().min(1).max(80),
  secretDigest: z.string().min(1),
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
  hostExtensionInstallations: HostExtensionInstallationRowSchema,
  hostUiPageEntries: HostUiPageEntryRowSchema,
  hostUiPagePreferences: HostUiPagePreferenceRowSchema,
  hostUiPermissionGrants: HostUiPermissionGrantRowSchema,
  hostUiDiagnostics: HostUiDiagnosticRowSchema,
  agentActivations: AgentActivationRowSchema,
  extensionClientDiagnostics: ExtensionClientDiagnosticRowSchema,
  dshPluginPackages: DshPluginPackageRowSchema,
  dshPluginEntries: DshPluginEntryRowSchema,
  dshPluginActivations: DshPluginActivationRowSchema,
  dshPluginDiagnostics: DshPluginDiagnosticRowSchema,
  hostSecurityMetadata: HostSecurityMetadataRowSchema,
  managementDevices: ManagementDeviceRowSchema,
} as const
