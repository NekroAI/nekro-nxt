import type { AdapterFailureKind } from '@nekro-nxt/adapter-sdk'
import type {
  AgentId,
  AgentRevisionId,
  AdmissionId,
  AssetId,
  ChannelEventId,
  ChannelActivityType,
  ChannelId,
  ChannelMemberId,
  ConnectionId,
  EpisodeHandoffId,
  EpisodeId,
  ExtensionId,
  ExtensionRevisionId,
  JsonValue,
  LogicalMessageId,
  ManagementDeviceId,
  MessagePart,
  OutboundIntentId,
  PhysicalDeliveryId,
  PlatformIdentityId,
  PromptDocumentV1,
  ServerInstanceId,
} from '@nekro-nxt/contracts'
import type { AgentCapabilityGrants, ImageUnderstandingPolicy } from '@nekro-nxt/core'
import type { ExtensionRevisionVerification } from '@nekro-nxt/extension-runtime'
import { sql } from 'drizzle-orm'
import { check, foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

const jsonText = <T>(name: string) => text(name, { mode: 'json' }).$type<T>()

export const agentDefinitions = sqliteTable('agent_definitions', {
  id: text().$type<AgentId>().primaryKey(),
  createdAt: integer('created_at').notNull(),
  deletedAt: integer('deleted_at'),
})

export const agentRevisions = sqliteTable(
  'agent_revisions',
  {
    id: text().$type<AgentRevisionId>().notNull(),
    agentId: text('agent_id')
      .$type<AgentId>()
      .notNull()
      .references(() => agentDefinitions.id, { onDelete: 'restrict' }),
    revision: integer().notNull(),
    displayName: text('display_name').notNull(),
    persona: text().notNull(),
    personaDocument: jsonText<PromptDocumentV1>('persona_document'),
    modelProvider: text('model_provider').notNull(),
    modelId: text('model_id').notNull(),
    reasoningEffort: text('reasoning_effort'),
    capabilities: jsonText<AgentCapabilityGrants>('capabilities').notNull(),
    imagePolicy: jsonText<ImageUnderstandingPolicy>('image_policy').notNull(),
    dynamicClientApprovalPolicy: text('dynamic_client_approval_policy', { enum: ['manual', 'automatic'] })
      .notNull()
      .default('manual'),
    contentDigest: text('content_digest').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    uniqueIndex('agent_revisions_id_agent_uq').on(table.id, table.agentId),
    uniqueIndex('agent_revisions_agent_revision_uq').on(table.agentId, table.revision),
    uniqueIndex('agent_revisions_agent_digest_uq').on(table.agentId, table.contentDigest),
    check('agent_revisions_revision_ck', sql`${table.revision} > 0`),
  ],
)

export const agentCurrentRevisions = sqliteTable(
  'agent_current_revisions',
  {
    agentId: text('agent_id').$type<AgentId>().primaryKey(),
    revisionId: text('revision_id').$type<AgentRevisionId>().notNull(),
  },
  (table) => [
    foreignKey({
      name: 'agent_current_revisions_agent_fk',
      columns: [table.agentId],
      foreignColumns: [agentDefinitions.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'agent_current_revisions_revision_fk',
      columns: [table.revisionId, table.agentId],
      foreignColumns: [agentRevisions.id, agentRevisions.agentId],
    }).onDelete('restrict'),
  ],
)

export const connections = sqliteTable(
  'connections',
  {
    id: text().$type<ConnectionId>().primaryKey(),
    adapterKey: text('adapter_key').notNull(),
    alias: text('alias'),
    config: jsonText<JsonValue>('config').notNull(),
    credentialRefs: jsonText<Readonly<Record<string, string>>>('credential_refs').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('connections_adapter_idx').on(table.adapterKey, table.createdAt)],
)

export const connectionState = sqliteTable('connection_state', {
  connectionId: text('connection_id')
    .$type<ConnectionId>()
    .primaryKey()
    .references(() => connections.id, { onDelete: 'cascade' }),
  state: jsonText<JsonValue>('state').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export const channels = sqliteTable(
  'channels',
  {
    id: text().$type<ChannelId>().primaryKey(),
    connectionId: text('connection_id')
      .$type<ConnectionId>()
      .notNull()
      .references(() => connections.id, { onDelete: 'restrict' }),
    platformChannelId: text('platform_channel_id').notNull(),
    kind: text({ enum: ['web', 'direct', 'group'] }).notNull(),
    displayName: text('display_name'),
    autoCreatedForAgentId: text('auto_created_for_agent_id').$type<AgentId>(),
    createdAt: integer('created_at').notNull(),
    deletedAt: integer('deleted_at'),
  },
  (table) => [
    uniqueIndex('channels_connection_platform_uq').on(table.connectionId, table.platformChannelId),
    check('channels_kind_ck', sql`${table.kind} IN ('web', 'direct', 'group')`),
    foreignKey({
      name: 'channels_auto_created_agent_fk',
      columns: [table.autoCreatedForAgentId],
      foreignColumns: [agentDefinitions.id],
    }).onDelete('restrict'),
  ],
)

export const platformIdentities = sqliteTable(
  'platform_identities',
  {
    id: text().$type<PlatformIdentityId>().primaryKey(),
    connectionId: text('connection_id')
      .$type<ConnectionId>()
      .notNull()
      .references(() => connections.id, { onDelete: 'restrict' }),
    platformUserId: text('platform_user_id').notNull(),
    displayName: text('display_name'),
  },
  (table) => [uniqueIndex('platform_identities_connection_user_uq').on(table.connectionId, table.platformUserId)],
)

export const channelMembers = sqliteTable(
  'channel_members',
  {
    id: text().$type<ChannelMemberId>().primaryKey(),
    channelId: text('channel_id')
      .$type<ChannelId>()
      .notNull()
      .references(() => channels.id, { onDelete: 'restrict' }),
    platformIdentityId: text('platform_identity_id')
      .$type<PlatformIdentityId>()
      .notNull()
      .references(() => platformIdentities.id, { onDelete: 'restrict' }),
    displayName: text('display_name'),
  },
  (table) => [uniqueIndex('channel_members_channel_identity_uq').on(table.channelId, table.platformIdentityId)],
)

export const channelBindings = sqliteTable(
  'channel_bindings',
  {
    channelId: text('channel_id')
      .$type<ChannelId>()
      .primaryKey()
      .references(() => channels.id, { onDelete: 'restrict' }),
    agentId: text('agent_id')
      .$type<AgentId>()
      .notNull()
      .references(() => agentDefinitions.id, { onDelete: 'restrict' }),
    triggerPolicy: text('trigger_policy', {
      enum: ['always', 'mentioned-or-replied', 'command', 'observe-only'],
    }).notNull(),
    processingFeedback: text('processing_feedback', { enum: ['auto', 'off'] })
      .notNull()
      .default('auto'),
    eventTriggers: jsonText<readonly ChannelActivityType[]>('event_triggers').notNull().default([]),
    boundAt: integer('bound_at').notNull(),
  },
  (table) => [
    index('channel_bindings_agent_idx').on(table.agentId, table.boundAt),
    check(
      'channel_bindings_trigger_policy_ck',
      sql`${table.triggerPolicy} IN ('always', 'mentioned-or-replied', 'command', 'observe-only')`,
    ),
    check('channel_bindings_processing_feedback_ck', sql`${table.processingFeedback} IN ('auto', 'off')`),
  ],
)

export const channelEvents = sqliteTable(
  'channel_events',
  {
    id: text().$type<ChannelEventId>().notNull(),
    logicalMessageId: text('logical_message_id').$type<LogicalMessageId>().notNull(),
    channelId: text('channel_id')
      .$type<ChannelId>()
      .notNull()
      .references(() => channels.id, { onDelete: 'restrict' }),
    platformMessageId: text('platform_message_id'),
    kind: text({
      enum: ['message-created', 'message-edited', 'message-deleted', 'member-updated', 'reaction', 'control'],
    }).notNull(),
    activityType: text('activity_type').$type<ChannelActivityType>(),
    targetPlatformMessageId: text('target_platform_message_id'),
    targetLogicalMessageId: text('target_logical_message_id').$type<LogicalMessageId>(),
    senderMemberId: text('sender_member_id').$type<ChannelMemberId>(),
    parts: jsonText<readonly MessagePart[]>('parts').notNull(),
    sourceTimestamp: integer('source_timestamp').notNull(),
    receivedAt: integer('received_at').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    facts: jsonText<Readonly<Record<string, JsonValue>>>('facts'),
    searchText: text('search_text').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    uniqueIndex('channel_events_id_channel_uq').on(table.id, table.channelId),
    uniqueIndex('channel_events_logical_message_uq').on(table.logicalMessageId),
    uniqueIndex('channel_events_channel_dedupe_uq').on(table.channelId, table.dedupeKey),
    index('channel_events_history_idx').on(table.channelId, table.receivedAt, table.id),
    index('channel_events_platform_message_idx').on(table.channelId, table.platformMessageId),
    foreignKey({
      name: 'channel_events_sender_fk',
      columns: [table.senderMemberId],
      foreignColumns: [channelMembers.id],
    }).onDelete('restrict'),
    check(
      'channel_events_kind_ck',
      sql`${table.kind} IN ('message-created', 'message-edited', 'message-deleted', 'member-updated', 'reaction', 'control')`,
    ),
  ],
)

export const episodes = sqliteTable(
  'episodes',
  {
    id: text().$type<EpisodeId>().notNull(),
    channelId: text('channel_id').$type<ChannelId>().notNull(),
    agentId: text('agent_id').$type<AgentId>().notNull(),
    agentRevisionId: text('agent_revision_id').$type<AgentRevisionId>().notNull(),
    dshSessionId: text('dsh_session_id').unique(),
    status: text({ enum: ['opening', 'active', 'closed', 'failed'] }).notNull(),
    openedAtEventId: text('opened_at_event_id').$type<ChannelEventId>().notNull(),
    lastAdmittedEventId: text('last_admitted_event_id').$type<ChannelEventId>(),
    closedAtEventId: text('closed_at_event_id').$type<ChannelEventId>(),
    closedAt: integer('closed_at'),
    closeReason: text('close_reason', {
      enum: [
        'manual',
        'context-cleared',
        'context-compacted',
        'idle-timeout',
        'incompatible-revision',
        'incompatible-activation',
        'incompatible-session-storage',
        'unrecoverable-session',
        'permission-revoked',
        'binding-replaced',
        'channel-deleted',
        'stopped',
      ],
    }),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    uniqueIndex('episodes_id_channel_agent_uq').on(table.id, table.channelId, table.agentId),
    uniqueIndex('episodes_live_lane_uq')
      .on(table.channelId, table.agentId)
      .where(sql`${table.status} IN ('opening', 'active')`),
    index('episodes_agent_history_idx').on(table.agentId, table.createdAt),
    foreignKey({
      name: 'episodes_channel_fk',
      columns: [table.channelId],
      foreignColumns: [channels.id],
    }).onDelete('restrict'),
    check('episodes_status_ck', sql`${table.status} IN ('opening', 'active', 'closed', 'failed')`),
    check(
      'episodes_close_reason_ck',
      sql`${table.closeReason} IS NULL OR ${table.closeReason} IN ('manual', 'context-cleared', 'context-compacted', 'idle-timeout', 'incompatible-revision', 'incompatible-activation', 'incompatible-session-storage', 'unrecoverable-session', 'permission-revoked', 'binding-replaced', 'channel-deleted', 'stopped')`,
    ),
    foreignKey({
      name: 'episodes_revision_fk',
      columns: [table.agentRevisionId, table.agentId],
      foreignColumns: [agentRevisions.id, agentRevisions.agentId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'episodes_opened_event_fk',
      columns: [table.openedAtEventId, table.channelId],
      foreignColumns: [channelEvents.id, channelEvents.channelId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'episodes_last_event_fk',
      columns: [table.lastAdmittedEventId, table.channelId],
      foreignColumns: [channelEvents.id, channelEvents.channelId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'episodes_closed_event_fk',
      columns: [table.closedAtEventId, table.channelId],
      foreignColumns: [channelEvents.id, channelEvents.channelId],
    }).onDelete('restrict'),
  ],
)

export const episodeHandoffs = sqliteTable(
  'episode_handoffs',
  {
    id: text().$type<EpisodeHandoffId>().primaryKey(),
    fromEpisodeId: text('from_episode_id')
      .$type<EpisodeId>()
      .notNull()
      .references(() => episodes.id, { onDelete: 'restrict' }),
    toEpisodeId: text('to_episode_id')
      .$type<EpisodeId>()
      .notNull()
      .references(() => episodes.id, { onDelete: 'restrict' }),
    summary: text().notNull(),
    provider: text().notNull(),
    model: text().notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('episode_handoffs_from_uq').on(table.fromEpisodeId),
    uniqueIndex('episode_handoffs_to_uq').on(table.toEpisodeId),
  ],
)

export const episodeHandoffEvents = sqliteTable(
  'episode_handoff_events',
  {
    handoffId: text('handoff_id')
      .$type<EpisodeHandoffId>()
      .notNull()
      .references(() => episodeHandoffs.id, { onDelete: 'cascade' }),
    eventId: text('event_id')
      .$type<ChannelEventId>()
      .notNull()
      .references(() => channelEvents.id, { onDelete: 'restrict' }),
    role: text({ enum: ['source', 'recent'] }).notNull(),
    position: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.handoffId, table.role, table.position] }),
    uniqueIndex('episode_handoff_events_event_uq').on(table.handoffId, table.role, table.eventId),
    check('episode_handoff_events_role_ck', sql`${table.role} IN ('source', 'recent')`),
    check('episode_handoff_events_position_ck', sql`${table.position} >= 0`),
  ],
)

export const admissions = sqliteTable(
  'admissions',
  {
    id: text().$type<AdmissionId>().primaryKey(),
    episodeId: text('episode_id')
      .$type<EpisodeId>()
      .notNull()
      .references(() => episodes.id, { onDelete: 'restrict' }),
    mode: text({ enum: ['followup', 'inject'] }).notNull(),
    state: text({ enum: ['pending', 'claimed', 'logged-to-session'] }).notNull(),
    dshMessageId: text('dsh_message_id'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('admissions_recovery_idx').on(table.episodeId, table.state, table.createdAt),
    check('admissions_mode_ck', sql`${table.mode} IN ('followup', 'inject')`),
    check('admissions_state_ck', sql`${table.state} IN ('pending', 'claimed', 'logged-to-session')`),
  ],
)

export const admissionEvents = sqliteTable(
  'admission_events',
  {
    admissionId: text('admission_id')
      .notNull()
      .references(() => admissions.id, { onDelete: 'cascade' }),
    eventId: text('event_id')
      .$type<ChannelEventId>()
      .notNull()
      .references(() => channelEvents.id, { onDelete: 'restrict' }),
    position: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.admissionId, table.position] }),
    uniqueIndex('admission_events_event_uq').on(table.admissionId, table.eventId),
    index('admission_events_event_idx').on(table.eventId),
    check('admission_events_position_ck', sql`${table.position} >= 0`),
  ],
)

export const outboundIntents = sqliteTable(
  'outbound_intents',
  {
    id: text().$type<OutboundIntentId>().primaryKey(),
    logicalMessageId: text('logical_message_id').$type<LogicalMessageId>().notNull().unique(),
    episodeId: text('episode_id')
      .$type<EpisodeId>()
      .notNull()
      .references(() => episodes.id, { onDelete: 'restrict' }),
    agentRevisionId: text('agent_revision_id')
      .$type<AgentRevisionId>()
      .notNull()
      .references(() => agentRevisions.id, { onDelete: 'restrict' }),
    sourceTurnId: text('source_turn_id'),
    parts: jsonText<readonly MessagePart[]>('parts').notNull(),
    searchText: text('search_text').notNull(),
    replyTo: text('reply_to'),
    clientRequestId: text('client_request_id'),
    state: text({ enum: ['planned', 'sending', 'sent', 'partially-sent', 'failed', 'unknown'] }).notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('outbound_intents_client_request_uq').on(table.episodeId, table.clientRequestId),
    index('outbound_intents_recovery_idx').on(table.state, table.createdAt),
    index('outbound_intents_episode_history_idx').on(table.episodeId, table.createdAt),
    check(
      'outbound_intents_state_ck',
      sql`${table.state} IN ('planned', 'sending', 'sent', 'partially-sent', 'failed', 'unknown')`,
    ),
  ],
)

export const physicalDeliveries = sqliteTable(
  'physical_deliveries',
  {
    id: text().$type<PhysicalDeliveryId>().primaryKey(),
    intentId: text('intent_id')
      .$type<OutboundIntentId>()
      .notNull()
      .references(() => outboundIntents.id, { onDelete: 'cascade' }),
    sequence: integer().notNull(),
    parts: jsonText<readonly MessagePart[]>('parts').notNull(),
    adapterContext: jsonText<JsonValue>('adapter_context'),
    processingFeedbackLeaseId: text('processing_feedback_lease_id'),
    state: text({ enum: ['planned', 'sending', 'sent', 'failed', 'unknown'] }).notNull(),
    platformMessageId: text('platform_message_id'),
    capabilityOutcomes: jsonText<Readonly<Record<string, JsonValue>>>('capability_outcomes'),
    failureKind: text('failure_kind', {
      enum: ['transient', 'permanent', 'rate-limited', 'authentication', 'invalid'],
    }).$type<AdapterFailureKind>(),
    resultMessage: text('result_message'),
    retryAfterMs: integer('retry_after_ms'),
    completedAt: integer('completed_at'),
  },
  (table) => [
    uniqueIndex('physical_deliveries_intent_sequence_uq').on(table.intentId, table.sequence),
    check('physical_deliveries_sequence_ck', sql`${table.sequence} >= 0`),
    check('physical_deliveries_state_ck', sql`${table.state} IN ('planned', 'sending', 'sent', 'failed', 'unknown')`),
  ],
)

export const assets = sqliteTable(
  'assets',
  {
    id: text().$type<AssetId>().primaryKey(),
    contentDigest: text('content_digest').notNull().unique(),
    byteSize: integer('byte_size').notNull(),
    mediaType: text('media_type').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [check('assets_byte_size_ck', sql`${table.byteSize} >= 0`)],
)

export const assetOccurrences = sqliteTable(
  'asset_occurrences',
  {
    channelEventId: text('channel_event_id')
      .$type<ChannelEventId>()
      .notNull()
      .references(() => channelEvents.id, { onDelete: 'cascade' }),
    partIndex: integer('part_index').notNull(),
    assetId: text('asset_id')
      .$type<AssetId>()
      .notNull()
      .references(() => assets.id, { onDelete: 'restrict' }),
  },
  (table) => [
    primaryKey({ columns: [table.channelEventId, table.partIndex] }),
    index('asset_occurrences_asset_idx').on(table.assetId, table.channelEventId),
    check('asset_occurrences_part_index_ck', sql`${table.partIndex} >= 0`),
  ],
)

/** Channel-scoped access created by product operations that do not have a Channel Event occurrence. */
export const assetChannelGrants = sqliteTable(
  'asset_channel_grants',
  {
    assetId: text('asset_id')
      .$type<AssetId>()
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    channelId: text('channel_id')
      .$type<ChannelId>()
      .notNull()
      .references(() => channels.id, { onDelete: 'restrict' }),
    source: text('source', { enum: ['agent-tool'] }).notNull(),
    grantedAt: integer('granted_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.assetId, table.channelId] }),
    index('asset_channel_grants_channel_idx').on(table.channelId, table.grantedAt),
    check('asset_channel_grants_source_ck', sql`${table.source} = 'agent-tool'`),
    check('asset_channel_grants_granted_at_ck', sql`${table.grantedAt} >= 0`),
  ],
)

export const localExtensions = sqliteTable('local_extensions', {
  id: text().$type<ExtensionId>().primaryKey(),
  slug: text().notNull().unique(),
  displayName: text('display_name').notNull(),
  description: text().notNull(),
  createdByAgentId: text('created_by_agent_id')
    .$type<AgentId>()
    .references(() => agentDefinitions.id, { onDelete: 'restrict' }),
  createdAt: integer('created_at').notNull(),
})

export const extensionRevisions = sqliteTable(
  'extension_revisions',
  {
    id: text().$type<ExtensionRevisionId>().notNull(),
    extensionId: text('extension_id')
      .$type<ExtensionId>()
      .notNull()
      .references(() => localExtensions.id, { onDelete: 'restrict' }),
    revisionNumber: integer('revision_number').notNull(),
    contentDigest: text('content_digest').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    uniqueIndex('extension_revisions_id_extension_uq').on(table.id, table.extensionId),
    uniqueIndex('extension_revisions_number_uq').on(table.extensionId, table.revisionNumber),
    uniqueIndex('extension_revisions_digest_uq').on(table.extensionId, table.contentDigest),
  ],
)

export const extensionRevisionVerifications = sqliteTable('extension_revision_verifications', {
  revisionId: text('revision_id')
    .$type<ExtensionRevisionId>()
    .primaryKey()
    .references(() => extensionRevisions.id, { onDelete: 'cascade' }),
  verifiedAt: integer('verified_at').notNull(),
  evidence: jsonText<ExtensionRevisionVerification>('evidence').notNull(),
})

export const agentActivations = sqliteTable(
  'agent_activations',
  {
    agentId: text('agent_id')
      .$type<AgentId>()
      .notNull()
      .references(() => agentDefinitions.id, { onDelete: 'restrict' }),
    extensionId: text('extension_id')
      .$type<ExtensionId>()
      .notNull()
      .references(() => localExtensions.id, { onDelete: 'restrict' }),
    extensionRevisionId: text('extension_revision_id').$type<ExtensionRevisionId>().notNull(),
    config: jsonText<JsonValue>('config').notNull(),
    activatedAt: integer('activated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.extensionId] }),
    foreignKey({
      name: 'agent_activations_revision_fk',
      columns: [table.extensionRevisionId, table.extensionId],
      foreignColumns: [extensionRevisions.id, extensionRevisions.extensionId],
    }).onDelete('restrict'),
    index('agent_activations_extension_idx').on(table.extensionId, table.agentId),
  ],
)

export const extensionClientDiagnostics = sqliteTable(
  'extension_client_diagnostics',
  {
    agentId: text('agent_id').$type<AgentId>().notNull(),
    extensionId: text('extension_id').$type<ExtensionId>().notNull(),
    revisionId: text('revision_id').$type<ExtensionRevisionId>().notNull(),
    status: text({ enum: ['loaded', 'failed'] }).notNull(),
    message: text(),
    observedAt: integer('observed_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.extensionId] }),
    foreignKey({
      name: 'extension_client_diagnostics_activation_fk',
      columns: [table.agentId, table.extensionId],
      foreignColumns: [agentActivations.agentId, agentActivations.extensionId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'extension_client_diagnostics_revision_fk',
      columns: [table.revisionId, table.extensionId],
      foreignColumns: [extensionRevisions.id, extensionRevisions.extensionId],
    }).onDelete('cascade'),
  ],
)

export const hostSecurityMetadata = sqliteTable(
  'host_security_metadata',
  {
    id: integer().primaryKey(),
    instanceId: text('instance_id').$type<ServerInstanceId>().notNull().unique(),
    managementKeyDigest: text('management_key_digest').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [check('host_security_metadata_singleton_ck', sql`${table.id} = 1`)],
)

export const managementDevices = sqliteTable(
  'management_devices',
  {
    id: text().$type<ManagementDeviceId>().primaryKey(),
    label: text().notNull(),
    secretDigest: text('secret_digest').notNull(),
    createdAt: integer('created_at').notNull(),
    lastUsedAt: integer('last_used_at'),
    revokedAt: integer('revoked_at'),
  },
  (table) => [index('management_devices_active_idx').on(table.revokedAt, table.createdAt)],
)

export const workTreeOrder = sqliteTable(
  'work_tree_order',
  {
    id: integer().primaryKey(),
    agentIds: jsonText<readonly string[]>('agent_ids').notNull(),
    channelIdsByAgent: jsonText<Readonly<Record<string, readonly string[]>>>('channel_ids_by_agent').notNull(),
    unboundChannelIds: jsonText<readonly string[]>('unbound_channel_ids').notNull(),
  },
  (table) => [check('work_tree_order_singleton_ck', sql`${table.id} = 1`)],
)

export const systemSettings = sqliteTable(
  'system_settings',
  {
    key: text().primaryKey(),
    value: jsonText<JsonValue>('value').notNull(),
    revision: integer().notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [check('system_settings_revision_ck', sql`${table.revision} > 0`)],
)

export const coreSchema = {
  agentDefinitions,
  agentRevisions,
  agentCurrentRevisions,
  connections,
  connectionState,
  channels,
  platformIdentities,
  channelMembers,
  channelBindings,
  channelEvents,
  episodes,
  episodeHandoffs,
  episodeHandoffEvents,
  admissions,
  admissionEvents,
  outboundIntents,
  physicalDeliveries,
  assets,
  assetOccurrences,
  assetChannelGrants,
  localExtensions,
  extensionRevisions,
  extensionRevisionVerifications,
  agentActivations,
  extensionClientDiagnostics,
  hostSecurityMetadata,
  managementDevices,
  workTreeOrder,
  systemSettings,
} as const
