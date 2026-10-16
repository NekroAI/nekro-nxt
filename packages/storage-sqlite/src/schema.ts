import type { AdapterFailureKind } from '@nekro-nxt/adapter-sdk'
import type {
  CommandExecutionRecord,
  CommandPolicy,
  AgentId,
  AgentRevisionId,
  AuthoringAttemptId,
  AuthoringTaskId,
  SubConversationId,
  AdmissionId,
  AssetId,
  ChannelContextPolicy,
  ChannelEventId,
  AdapterActivityKey,
  ChannelId,
  ChannelMemberId,
  ConnectionId,
  ConnectionEventId,
  DshPluginEntryId,
  DshPluginPackageId,
  EpisodeHandoffId,
  EpisodeId,
  ExtensionId,
  ExtensionRevisionId,
  HostPageIcon,
  HostUiPageInstanceId,
  HostUiPermissionDeclaration,
  JsonValue,
  LogicalMessageId,
  ManagementDeviceId,
  MessagePart,
  OutboundIntentId,
  PhysicalDeliveryId,
  PlatformIdentityId,
  PromptDocumentV1,
  ServerInstanceId,
  CommunityFeedbackDraft,
  CommunityFeedbackDraftId,
  CommunityFeedbackItem,
} from '@nekro-nxt/contracts'
import type { StoredAgentCapabilityGrants, ImageUnderstandingPolicy } from '@nekro-nxt/core'
import type {
  AuthoringAttemptFailure,
  AuthoringHalfState,
  DynamicAuthoringVerification,
  ExtensionRevisionVerification,
} from '@nekro-nxt/extension-runtime'
import { sql } from 'drizzle-orm'
import {
  blob,
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

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
    capabilities: jsonText<StoredAgentCapabilityGrants>('capabilities').notNull(),
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
    accountKey: text('account_key'),
    alias: text('alias'),
    config: jsonText<JsonValue>('config').notNull(),
    credentialRefs: jsonText<Readonly<Record<string, string>>>('credential_refs').notNull(),
    activityTriggerDefaults: jsonText<readonly AdapterActivityKey[]>('activity_trigger_defaults').notNull().default([]),
    createdAt: integer('created_at').notNull(),
    archivedAt: integer('archived_at'),
  },
  (table) => [
    index('connections_adapter_idx').on(table.adapterKey, table.createdAt),
    uniqueIndex('connections_adapter_account_uq')
      .on(table.adapterKey, table.accountKey)
      .where(sql`${table.accountKey} IS NOT NULL AND ${table.archivedAt} IS NULL`),
  ],
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
    kind: text({ enum: ['internal', 'direct', 'group'] }).notNull(),
    displayName: text('display_name'),
    platformDisplayName: text('platform_display_name'),
    preferredProcessingFeedback: text('preferred_processing_feedback', { enum: ['auto', 'off'] })
      .notNull()
      .default('auto'),
    autoCreatedForAgentId: text('auto_created_for_agent_id').$type<AgentId>(),
    createdAt: integer('created_at').notNull(),
    deletedAt: integer('deleted_at'),
  },
  (table) => [
    uniqueIndex('channels_connection_platform_uq').on(table.connectionId, table.platformChannelId),
    check('channels_kind_ck', sql`${table.kind} IN ('internal', 'direct', 'group')`),
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
    /** `member`: the Adapter marked this user as its own account; `account`: the account it reported for the connection. */
    selfKind: text('self_kind').$type<'member' | 'account'>(),
  },
  (table) => [
    uniqueIndex('platform_identities_connection_user_uq').on(table.connectionId, table.platformUserId),
    uniqueIndex('platform_identities_id_connection_uq').on(table.id, table.connectionId),
  ],
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

export const connectionEvents = sqliteTable(
  'connection_events',
  {
    id: text().$type<ConnectionEventId>().primaryKey(),
    connectionId: text('connection_id')
      .$type<ConnectionId>()
      .notNull()
      .references(() => connections.id, { onDelete: 'restrict' }),
    activityKey: text('activity_key').$type<AdapterActivityKey>().notNull(),
    summary: text().notNull(),
    actorIdentityId: text('actor_identity_id').$type<PlatformIdentityId>(),
    subjectIdentityId: text('subject_identity_id').$type<PlatformIdentityId>(),
    sourceTimestamp: integer('source_timestamp').notNull(),
    receivedAt: integer('received_at').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    facts: jsonText<Readonly<Record<string, JsonValue>>>('facts'),
  },
  (table) => [
    uniqueIndex('connection_events_connection_dedupe_uq').on(table.connectionId, table.dedupeKey),
    index('connection_events_history_idx').on(table.connectionId, table.receivedAt, table.id),
    foreignKey({
      name: 'connection_events_actor_fk',
      columns: [table.actorIdentityId, table.connectionId],
      foreignColumns: [platformIdentities.id, platformIdentities.connectionId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'connection_events_subject_fk',
      columns: [table.subjectIdentityId, table.connectionId],
      foreignColumns: [platformIdentities.id, platformIdentities.connectionId],
    }).onDelete('restrict'),
  ],
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
    paused: integer('paused', { mode: 'boolean' }).notNull().default(false),
    localAgentMessages: text('local_agent_messages', { enum: ['observe', 'trigger'] })
      .notNull()
      .default('observe'),
    processingFeedback: text('processing_feedback', { enum: ['auto', 'off'] })
      .notNull()
      .default('auto'),
    activityTriggerOverridesEnabled: jsonText<readonly AdapterActivityKey[]>('activity_triggers').notNull().default([]),
    activityTriggerSuppressions: jsonText<readonly AdapterActivityKey[]>('activity_trigger_suppressions')
      .notNull()
      .default([]),
    boundAt: integer('bound_at').notNull(),
  },
  (table) => [
    index('channel_bindings_agent_idx').on(table.agentId, table.boundAt),
    check(
      'channel_bindings_trigger_policy_ck',
      sql`${table.triggerPolicy} IN ('always', 'mentioned-or-replied', 'command', 'observe-only')`,
    ),
    check('channel_bindings_processing_feedback_ck', sql`${table.processingFeedback} IN ('auto', 'off')`),
    check('channel_bindings_local_agent_messages_ck', sql`${table.localAgentMessages} IN ('observe', 'trigger')`),
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
    activityKey: text('activity_key').$type<AdapterActivityKey>(),
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
    index('episodes_channel_history_idx').on(table.channelId, table.id),
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

export const dynamicAuthoringTasks = sqliteTable(
  'dynamic_authoring_tasks',
  {
    id: text().$type<AuthoringTaskId>().primaryKey(),
    agentId: text('agent_id').$type<AgentId>().notNull(),
    /** Channel and Episode the task currently runs in; continuing it in a later conversation moves both. */
    channelId: text('channel_id').$type<ChannelId>().notNull(),
    episodeId: text('episode_id').$type<EpisodeId>().notNull(),
    /** Channel of the message that started the task; owns `initiating_event_id`. */
    originChannelId: text('origin_channel_id').$type<ChannelId>().notNull(),
    initiatingEventId: text('initiating_event_id').$type<ChannelEventId>().notNull(),
    /** `create` builds a new extension; `revise` changes `target_extension_id` starting from `base_revision_id`. */
    kind: text({ enum: ['create', 'revise'] })
      .notNull()
      .default('create'),
    targetExtensionId: text('target_extension_id').$type<ExtensionId>(),
    baseRevisionId: text('base_revision_id').$type<ExtensionRevisionId>(),
    /** Another Revision handed to the agent as reference, for example local changes to carry over in a merge. */
    referenceRevisionId: text('reference_revision_id').$type<ExtensionRevisionId>(),
    /** Why a paused task stopped; cleared when it continues. */
    pausedReason: text('paused_reason'),
    pluginKey: text('plugin_key').notNull(),
    title: text().notNull(),
    requirementSummary: text('requirement_summary').notNull(),
    status: text({
      enum: [
        'working',
        'awaiting-approval',
        'running',
        'ready',
        'repairing',
        'failed',
        'interrupted',
        'stopped',
        'completed',
        'paused',
      ],
    }).notNull(),
    approvalPolicy: text('approval_policy', { enum: ['risk-stable', 'fully-automatic'] }).notNull(),
    approvedRiskDigest: text('approved_risk_digest'),
    revision: integer().notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    completedAt: integer('completed_at'),
  },
  (table) => [
    uniqueIndex('dynamic_authoring_tasks_episode_plugin_uq').on(table.episodeId, table.pluginKey),
    index('dynamic_authoring_tasks_agent_status_idx').on(table.agentId, table.status, table.updatedAt),
    foreignKey({
      name: 'dynamic_authoring_tasks_episode_owner_fk',
      columns: [table.episodeId, table.channelId, table.agentId],
      foreignColumns: [episodes.id, episodes.channelId, episodes.agentId],
    }).onDelete('restrict'),
    index('dynamic_authoring_tasks_target_idx').on(table.targetExtensionId, table.status),
    foreignKey({
      name: 'dynamic_authoring_tasks_initiating_event_fk',
      columns: [table.initiatingEventId, table.originChannelId],
      foreignColumns: [channelEvents.id, channelEvents.channelId],
    }).onDelete('restrict'),
    check('dynamic_authoring_tasks_revision_ck', sql`${table.revision} > 0`),
    check('dynamic_authoring_tasks_created_at_ck', sql`${table.createdAt} >= 0`),
    check('dynamic_authoring_tasks_updated_at_ck', sql`${table.updatedAt} >= ${table.createdAt}`),
  ],
)

export const dynamicAuthoringAttempts = sqliteTable(
  'dynamic_authoring_attempts',
  {
    id: text().$type<AuthoringAttemptId>().primaryKey(),
    taskId: text('task_id')
      .$type<AuthoringTaskId>()
      .notNull()
      .references(() => dynamicAuthoringTasks.id, { onDelete: 'cascade' }),
    ordinal: integer().notNull(),
    name: text().notNull(),
    purpose: text().notNull(),
    snapshotDigest: text('snapshot_digest').notNull(),
    riskDigest: text('risk_digest').notNull(),
    sourcePath: text('source_path').notNull(),
    state: text({
      enum: [
        'drafting',
        'preflight-failed',
        'awaiting-approval',
        'starting-host',
        'loading-client',
        'verifying',
        'active',
        'failed',
        'rejected',
        'stopped',
      ],
    }).notNull(),
    host: jsonText<AuthoringHalfState>('host').notNull(),
    client: jsonText<AuthoringHalfState>('client').notNull(),
    error: jsonText<AuthoringAttemptFailure>('error'),
    verification: jsonText<DynamicAuthoringVerification>('verification'),
    runnerPluginId: text('runner_plugin_id'),
    runnerPackageId: text('runner_package_id'),
    runnerRunId: text('runner_run_id'),
    createdAt: integer('created_at').notNull(),
    settledAt: integer('settled_at'),
  },
  (table) => [
    uniqueIndex('dynamic_authoring_attempts_id_task_uq').on(table.id, table.taskId),
    uniqueIndex('dynamic_authoring_attempts_task_ordinal_uq').on(table.taskId, table.ordinal),
    uniqueIndex('dynamic_authoring_attempts_task_package_uq').on(table.taskId, table.runnerPackageId),
    index('dynamic_authoring_attempts_task_state_idx').on(table.taskId, table.state, table.ordinal),
    check('dynamic_authoring_attempts_ordinal_ck', sql`${table.ordinal} > 0`),
    check('dynamic_authoring_attempts_created_at_ck', sql`${table.createdAt} >= 0`),
  ],
)

export const dynamicAuthoringEvents = sqliteTable(
  'dynamic_authoring_events',
  {
    taskId: text('task_id')
      .$type<AuthoringTaskId>()
      .notNull()
      .references(() => dynamicAuthoringTasks.id, { onDelete: 'cascade' }),
    sequence: integer().notNull(),
    kind: text({
      enum: [
        'task-created',
        'attempt-created',
        'preflight-failed',
        'approval-requested',
        'approval-accepted',
        'approval-rejected',
        'phase-changed',
        'verification-completed',
        'attempt-failed',
        'task-interrupted',
        'task-stopped',
        'task-completed',
        'task-paused',
        'task-resumed',
      ],
    }).notNull(),
    attemptId: text('attempt_id').$type<AuthoringAttemptId>(),
    payload: jsonText<JsonValue>('payload').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.taskId, table.sequence] }),
    index('dynamic_authoring_events_attempt_idx').on(table.attemptId, table.sequence),
    foreignKey({
      name: 'dynamic_authoring_events_attempt_fk',
      columns: [table.attemptId, table.taskId],
      foreignColumns: [dynamicAuthoringAttempts.id, dynamicAuthoringAttempts.taskId],
    }).onDelete('cascade'),
    check('dynamic_authoring_events_sequence_ck', sql`${table.sequence} > 0`),
    check('dynamic_authoring_events_created_at_ck', sql`${table.createdAt} >= 0`),
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
    state: text({ enum: ['pending', 'claimed', 'logged-to-session', 'cancelled'] }).notNull(),
    dshMessageId: text('dsh_message_id'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('admissions_recovery_idx').on(table.episodeId, table.state, table.createdAt),
    check('admissions_mode_ck', sql`${table.mode} IN ('followup', 'inject')`),
    check('admissions_state_ck', sql`${table.state} IN ('pending', 'claimed', 'logged-to-session', 'cancelled')`),
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

export const commandSystem = sqliteTable('command_system', {
  id: integer().primaryKey(),
  cutoffEventId: text('cutoff_event_id').notNull(),
})
export const commandPolicies = sqliteTable(
  'command_policies',
  {
    scope: text().notNull(),
    commandName: text('command_name').notNull(),
    policy: jsonText<CommandPolicy>('policy').notNull(),
  },
  (table) => [primaryKey({ columns: [table.scope, table.commandName] })],
)
/**
 * Messages recognized as commands that deliberately got no execution (dropped by the rate limit). Recording the
 * decision keeps them out of model context for good, instead of re-deciding later under different settings.
 */
export const commandIgnoredEvents = sqliteTable('command_ignored_events', {
  eventId: text('event_id')
    .$type<ChannelEventId>()
    .primaryKey()
    .references(() => channelEvents.id, { onDelete: 'cascade' }),
  reason: text({ enum: ['rate-limited'] }).notNull(),
})
/** Per-channel command behavior that is not a policy of one command. */
export const commandChannelSettings = sqliteTable('command_channel_settings', {
  channelId: text('channel_id')
    .$type<ChannelId>()
    .primaryKey()
    .references(() => channels.id, { onDelete: 'cascade' }),
  /** External groups recognize `/command` without a leading mention of the account. */
  bareCommands: integer('bare_commands', { mode: 'boolean' }).notNull().default(false),
})
export const commandGrants = sqliteTable(
  'command_grants',
  {
    channelId: text('channel_id')
      .$type<ChannelId>()
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    connectionId: text('connection_id')
      .$type<ConnectionId>()
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    platformUserId: text('platform_user_id').notNull(),
  },
  (table) => [primaryKey({ columns: [table.channelId, table.connectionId, table.platformUserId] })],
)
export const commandExecutions = sqliteTable(
  'command_executions',
  {
    id: text().primaryKey(),
    channelId: text('channel_id')
      .$type<ChannelId>()
      .notNull()
      .references(() => channels.id, { onDelete: 'restrict' }),
    source: text({ enum: ['web', 'platform'] }).notNull(),
    requestId: text('request_id').notNull(),
    eventId: text('event_id')
      .$type<ChannelEventId>()
      .references(() => channelEvents.id, { onDelete: 'restrict' }),
    /** Full name once the command resolved; empty for unknown commands. */
    commandName: text('command_name'),
    status: text({ enum: ['pending', 'running', 'succeeded', 'failed', 'uncertain'] }).notNull(),
    needsRecovery: integer('needs_recovery', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at').notNull(),
    completedAt: integer('completed_at'),
    /** Arguments, identity, result and replies; every field used to filter or order lives in a column. */
    record: jsonText<CommandExecutionRecord>('record').notNull(),
  },
  (table) => [
    uniqueIndex('command_execution_request_uq').on(table.channelId, table.source, table.requestId),
    uniqueIndex('command_execution_event_uq').on(table.eventId),
    index('command_execution_recovery_idx').on(table.needsRecovery, table.createdAt, table.id),
    index('command_execution_channel_idx').on(table.channelId, table.createdAt),
  ],
)
export const outboundIntents = sqliteTable(
  'outbound_intents',
  {
    id: text().$type<OutboundIntentId>().primaryKey(),
    logicalMessageId: text('logical_message_id').$type<LogicalMessageId>().notNull().unique(),
    episodeId: text('episode_id')
      .$type<EpisodeId>()
      .references(() => episodes.id, { onDelete: 'restrict' }),
    agentRevisionId: text('agent_revision_id')
      .$type<AgentRevisionId>()
      .references(() => agentRevisions.id, { onDelete: 'restrict' }),
    channelId: text('channel_id')
      .$type<ChannelId>()
      .references(() => channels.id, { onDelete: 'restrict' }),
    commandExecutionId: text('command_execution_id').references(() => commandExecutions.id, { onDelete: 'restrict' }),
    /** Position of this reply within its command execution. */
    commandOrdinal: integer('command_ordinal'),
    /**
     * Host notice that is neither an agent's message nor a command reply, such as an extension request or its
     * outcome; the key makes each notice planned at most once.
     */
    noticeKey: text('notice_key'),
    sourceTurnId: text('source_turn_id'),
    parts: jsonText<readonly MessagePart[]>('parts').notNull(),
    searchText: text('search_text').notNull(),
    replyTo: text('reply_to'),
    clientRequestId: text('client_request_id'),
    state: text({ enum: ['planned', 'sending', 'sent', 'partially-sent', 'failed', 'unknown'] }).notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('outbound_intents_command_uq').on(table.commandExecutionId, table.commandOrdinal),
    uniqueIndex('outbound_intents_notice_uq').on(table.noticeKey),
    index('outbound_intents_channel_history_idx').on(table.channelId, table.createdAt),
    check(
      'outbound_intents_source_ck',
      sql`(${table.episodeId} IS NOT NULL AND ${table.agentRevisionId} IS NOT NULL AND ${table.commandExecutionId} IS NULL AND ${table.commandOrdinal} IS NULL AND ${table.noticeKey} IS NULL) OR (${table.episodeId} IS NULL AND ${table.agentRevisionId} IS NULL AND ${table.commandExecutionId} IS NOT NULL AND ${table.commandOrdinal} IS NOT NULL AND ${table.noticeKey} IS NULL AND ${table.channelId} IS NOT NULL) OR (${table.episodeId} IS NULL AND ${table.agentRevisionId} IS NULL AND ${table.commandExecutionId} IS NULL AND ${table.commandOrdinal} IS NULL AND ${table.noticeKey} IS NOT NULL AND ${table.channelId} IS NOT NULL)`,
    ),
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
    diagnostic: jsonText<{ readonly action?: string | undefined; readonly retcode?: number | undefined }>('diagnostic'),
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
    source: text('source', { enum: ['agent-tool', 'extension-library', 'browser-composer'] }).notNull(),
    grantedAt: integer('granted_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.assetId, table.channelId] }),
    index('asset_channel_grants_channel_idx').on(table.channelId, table.grantedAt),
    check(
      'asset_channel_grants_source_ck',
      sql`${table.source} IN ('agent-tool', 'extension-library', 'browser-composer')`,
    ),
    check('asset_channel_grants_granted_at_ck', sql`${table.grantedAt} >= 0`),
  ],
)

export const localExtensions = sqliteTable('local_extensions', {
  id: text().$type<ExtensionId>().primaryKey(),
  /** What the latest Revision provides (Manifest V7 labels); listing and filtering only. */
  provides: jsonText<readonly ('agent' | 'page' | 'adapter' | 'mcp')[]>('provides').notNull().default([]),
  slug: text().notNull().unique(),
  displayName: text('display_name').notNull(),
  description: text().notNull(),
  createdByAgentId: text('created_by_agent_id')
    .$type<AgentId>()
    .references(() => agentDefinitions.id, { onDelete: 'restrict' }),
  /** The Revision of another extension this one was branched from; set once when the branch is created. */
  branchOfExtensionId: text('branch_of_extension_id').$type<ExtensionId>(),
  branchOfRevisionId: text('branch_of_revision_id').$type<ExtensionRevisionId>(),
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
    payloadDigest: text('payload_digest').notNull(),
    /** Revision this one was made from on the same line; it may not exist on this machine. */
    parentRevisionId: text('parent_revision_id').$type<ExtensionRevisionId>(),
    /** Earlier Revisions of the line, newest first, as the Manifest lineage records them. */
    ancestry: jsonText<readonly ExtensionRevisionId[]>('ancestry').notNull().default([]),
    /** How the Revision reached this machine. */
    origin: text({ enum: ['authored', 'file', 'community', 'branch'] })
      .notNull()
      .default('file'),
    /** Creation task that saved it, when it was authored here. */
    authoringTaskId: text('authoring_task_id').$type<AuthoringTaskId>(),
    dataVersion: integer('data_version').notNull().default(1),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    uniqueIndex('extension_revisions_id_extension_uq').on(table.id, table.extensionId),
    uniqueIndex('extension_revisions_number_uq').on(table.extensionId, table.revisionNumber),
    uniqueIndex('extension_revisions_digest_uq').on(table.extensionId, table.contentDigest),
    uniqueIndex('extension_revisions_payload_digest_uq').on(table.extensionId, table.payloadDigest),
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

/**
 * The community release a Revision corresponds to: written when it is installed from the community and when it is
 * published from here, so the machine knows which public version each local one is.
 */
export const extensionRevisionReleases = sqliteTable(
  'extension_revision_releases',
  {
    revisionId: text('revision_id')
      .$type<ExtensionRevisionId>()
      .notNull()
      .references(() => extensionRevisions.id, { onDelete: 'cascade' }),
    extensionId: text('extension_id').$type<ExtensionId>().notNull(),
    communityUrl: text('community_url').notNull(),
    releaseId: text('release_id').notNull(),
    releaseNumber: integer('release_number'),
    publisherHandle: text('publisher_handle').notNull(),
    via: text({ enum: ['install', 'publish'] }).notNull(),
    recordedAt: integer('recorded_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.revisionId, table.communityUrl] }),
    index('extension_revision_releases_extension_idx').on(table.extensionId, table.communityUrl),
  ],
)

/** This machine's relation to an extension line on one community: may publish it (`owner`) or only follow it. */
export const extensionCommunityLinks = sqliteTable(
  'extension_community_links',
  {
    extensionId: text('extension_id')
      .$type<ExtensionId>()
      .notNull()
      .references(() => localExtensions.id, { onDelete: 'cascade' }),
    communityUrl: text('community_url').notNull(),
    role: text({ enum: ['owner', 'subscriber'] }).notNull(),
    /** A community release the user chose to keep their local changes over; it is not offered again. */
    dismissedReleaseId: text('dismissed_release_id'),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.extensionId, table.communityUrl] })],
)

/** Shape version of the data an extension currently stores on this machine. */
export const extensionDataStates = sqliteTable('extension_data_states', {
  extensionId: text('extension_id')
    .$type<ExtensionId>()
    .primaryKey()
    .references(() => localExtensions.id, { onDelete: 'cascade' }),
  dataVersion: integer('data_version').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

/**
 * A copy of one extension's data taken before a version switch or an explicit migration, so the change can be undone.
 * Library assets are content-addressed and only referenced here.
 */
export const extensionDataSnapshots = sqliteTable(
  'extension_data_snapshots',
  {
    id: text().primaryKey(),
    extensionId: text('extension_id')
      .$type<ExtensionId>()
      .notNull()
      .references(() => localExtensions.id, { onDelete: 'cascade' }),
    reason: text({ enum: ['switch', 'migration', 'manual'] }).notNull(),
    label: text().notNull(),
    dataVersion: integer('data_version').notNull(),
    payload: blob({ mode: 'buffer' }).notNull(),
    byteSize: integer('byte_size').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('extension_data_snapshots_extension_idx').on(table.extensionId, table.createdAt)],
)

/** Platform accounts that are instance administrators; the signed-in console is always one as well. */
export const instanceAdministrators = sqliteTable(
  'instance_administrators',
  {
    connectionId: text('connection_id')
      .$type<ConnectionId>()
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    platformUserId: text('platform_user_id').notNull(),
    /** Name shown when the account was added; the user directory has the current one. */
    label: text().notNull(),
    addedVia: text('added_via', { enum: ['console', 'claim'] }).notNull(),
    addedAt: integer('added_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.connectionId, table.platformUserId] })],
)

/**
 * An extension action an agent asked for that an administrator must confirm with `/ext approve <number>` or in the
 * console. The number is short so it can be typed in chat.
 */
export const extensionRequests = sqliteTable(
  'extension_requests',
  {
    number: integer().primaryKey({ autoIncrement: true }),
    kind: text().notNull(),
    agentId: text('agent_id')
      .$type<AgentId>()
      .notNull()
      .references(() => agentDefinitions.id, { onDelete: 'cascade' }),
    channelId: text('channel_id')
      .$type<ChannelId>()
      .references(() => channels.id, { onDelete: 'cascade' }),
    extensionId: text('extension_id').$type<ExtensionId>(),
    summary: text().notNull(),
    payload: jsonText<JsonValue>('payload').notNull(),
    status: text({ enum: ['pending', 'approved', 'rejected', 'expired', 'completed', 'failed'] }).notNull(),
    result: jsonText<JsonValue>('result'),
    decidedBy: text('decided_by'),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    decidedAt: integer('decided_at'),
  },
  (table) => [
    index('extension_requests_status_idx').on(table.status, table.createdAt),
    index('extension_requests_agent_idx').on(table.agentId, table.status),
  ],
)

export const hostExtensionInstallations = sqliteTable(
  'host_extension_installations',
  {
    extensionId: text('extension_id')
      .$type<ExtensionId>()
      .primaryKey()
      .references(() => localExtensions.id, { onDelete: 'restrict' }),
    extensionRevisionId: text('extension_revision_id').$type<ExtensionRevisionId>().notNull(),
    installedAt: integer('installed_at').notNull(),
    config: jsonText<JsonValue>('config').notNull().default({}),
  },
  (table) => [
    uniqueIndex('host_extension_installations_revision_uq').on(table.extensionId, table.extensionRevisionId),
    foreignKey({
      name: 'host_extension_installations_revision_fk',
      columns: [table.extensionRevisionId, table.extensionId],
      foreignColumns: [extensionRevisions.id, extensionRevisions.extensionId],
    }).onDelete('restrict'),
    check('host_extension_installations_installed_at_ck', sql`${table.installedAt} >= 0`),
  ],
)

export const hostUiPageEntries = sqliteTable(
  'host_ui_page_entries',
  {
    pageInstanceId: text('page_instance_id').$type<HostUiPageInstanceId>().primaryKey(),
    ownerKind: text('owner_kind', { enum: ['extension', 'dsh-plugin'] }).notNull(),
    ownerId: text('owner_id').notNull(),
    artifactId: text('artifact_id').notNull(),
    entryId: text('entry_id').notNull(),
    title: text().notNull(),
    description: text(),
    icon: jsonText<HostPageIcon>('icon').notNull(),
    objectPane: text('object_pane', { enum: ['navigation', 'hidden'] }).notNull(),
    startPath: text('start_path').notNull(),
    visible: integer({ mode: 'boolean' }).notNull(),
    sortOrder: integer('sort_order').notNull(),
    /** Navigation rail position when the page registered a rail entry; null otherwise. */
    railOrder: integer('rail_order'),
    clientBuildKey: text('client_build_key').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('host_ui_page_entries_owner_entry_uq').on(table.ownerKind, table.ownerId, table.entryId),
    uniqueIndex('host_ui_page_entries_sort_order_uq').on(table.sortOrder),
    index('host_ui_page_entries_owner_idx').on(table.ownerKind, table.ownerId),
    check('host_ui_page_entries_sort_order_ck', sql`${table.sortOrder} >= 0`),
    check('host_ui_page_entries_created_at_ck', sql`${table.createdAt} >= 0`),
    check('host_ui_page_entries_updated_at_ck', sql`${table.updatedAt} >= 0`),
  ],
)

export const hostUiPagePreferences = sqliteTable(
  'host_ui_page_preferences',
  {
    id: integer().primaryKey(),
    revision: integer().notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    check('host_ui_page_preferences_singleton_ck', sql`${table.id} = 1`),
    check('host_ui_page_preferences_revision_ck', sql`${table.revision} >= 0`),
  ],
)

export const hostUiPermissionGrants = sqliteTable('host_ui_permission_grants', {
  ownerKey: text('owner_key').primaryKey(),
  artifactDigest: text('artifact_digest').notNull(),
  permissionDigest: text('permission_digest').notNull(),
  declaration: jsonText<HostUiPermissionDeclaration>('declaration').notNull(),
  approvedAt: integer('approved_at').notNull(),
})

export const hostUiDiagnostics = sqliteTable(
  'host_ui_diagnostics',
  {
    pageInstanceId: text('page_instance_id')
      .$type<HostUiPageInstanceId>()
      .primaryKey()
      .references(() => hostUiPageEntries.pageInstanceId, { onDelete: 'cascade' }),
    status: text({ enum: ['ready', 'load-failed', 'navigation-failed', 'rpc-failed', 'restore-failed'] }).notNull(),
    message: text(),
    observedAt: integer('observed_at').notNull(),
  },
  (table) => [check('host_ui_diagnostics_observed_at_ck', sql`${table.observedAt} >= 0`)],
)

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

export const dshPluginPackages = sqliteTable(
  'dsh_plugin_packages',
  {
    id: text().$type<DshPluginPackageId>().primaryKey(),
    packageName: text('package_name').notNull(),
    packageVersion: text('package_version').notNull(),
    source: text({ enum: ['registry', 'tarball', 'imported'] }).notNull(),
    packageDigest: text('package_digest').notNull(),
    integrity: text(),
    lockfileDigest: text('lockfile_digest').notNull(),
    manifest: jsonText<JsonValue>('manifest').notNull(),
    approvedBuilds: jsonText<readonly string[]>('approved_builds').notNull(),
    installedAt: integer('installed_at').notNull(),
  },
  (table) => [
    uniqueIndex('dsh_plugin_packages_identity_uq').on(table.packageName, table.packageVersion, table.packageDigest),
    check('dsh_plugin_packages_installed_at_ck', sql`${table.installedAt} >= 0`),
  ],
)

export const dshPluginEntries = sqliteTable(
  'dsh_plugin_entries',
  {
    id: text().$type<DshPluginEntryId>().primaryKey(),
    packageId: text('package_id')
      .$type<DshPluginPackageId>()
      .notNull()
      .references(() => dshPluginPackages.id, { onDelete: 'cascade' }),
    entryKey: text('entry_key').notNull(),
    moduleName: text('module_name').notNull(),
    suggestedScope: text('suggested_scope', { enum: ['host', 'agent'] }).notNull(),
    selectedScope: text('selected_scope', { enum: ['host', 'agent'] }),
    config: jsonText<JsonValue>('config').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('dsh_plugin_entries_package_key_uq').on(table.packageId, table.entryKey),
    check('dsh_plugin_entries_created_at_ck', sql`${table.createdAt} >= 0`),
  ],
)

export const dshPluginActivations = sqliteTable(
  'dsh_plugin_activations',
  {
    entryId: text('entry_id')
      .$type<DshPluginEntryId>()
      .notNull()
      .references(() => dshPluginEntries.id, { onDelete: 'cascade' }),
    targetKey: text('target_key').notNull(),
    target: text({ enum: ['host', 'agent'] }).notNull(),
    agentId: text('agent_id')
      .$type<AgentId>()
      .references(() => agentDefinitions.id, { onDelete: 'restrict' }),
    activatedAt: integer('activated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.entryId, table.targetKey] }),
    index('dsh_plugin_activations_agent_idx').on(table.agentId, table.entryId),
    check(
      'dsh_plugin_activations_target_ck',
      sql`(${table.target} = 'host' AND ${table.targetKey} = 'host' AND ${table.agentId} IS NULL) OR (${table.target} = 'agent' AND ${table.agentId} IS NOT NULL AND ${table.targetKey} = ${table.agentId})`,
    ),
    check('dsh_plugin_activations_activated_at_ck', sql`${table.activatedAt} >= 0`),
  ],
)

export const dshPluginDiagnostics = sqliteTable(
  'dsh_plugin_diagnostics',
  {
    entryId: text('entry_id')
      .$type<DshPluginEntryId>()
      .notNull()
      .references(() => dshPluginEntries.id, { onDelete: 'cascade' }),
    targetKey: text('target_key').notNull(),
    status: text({ enum: ['active', 'load-failed', 'restore-failed', 'dispose-failed'] }).notNull(),
    phase: text({ enum: ['import', 'apply', 'update', 'dispose', 'restore'] }).notNull(),
    message: text(),
    observedAt: integer('observed_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.entryId, table.targetKey] }),
    check('dsh_plugin_diagnostics_observed_at_ck', sql`${table.observedAt} >= 0`),
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

export const communityFeedbackDrafts = sqliteTable(
  'community_feedback_drafts',
  {
    id: text().$type<CommunityFeedbackDraftId>().primaryKey(),
    communityUrl: text('community_url').notNull(),
    communityUserId: text('community_user_id'),
    agentId: text('agent_id').$type<AgentId>(),
    channelId: text('channel_id').$type<ChannelId>(),
    kind: text().$type<CommunityFeedbackDraft['kind']>().notNull(),
    target: jsonText<CommunityFeedbackDraft['target']>('target').notNull(),
    title: text().notNull(),
    body: text().notNull(),
    excerpt: jsonText<CommunityFeedbackDraft['excerpt']>('excerpt'),
    excerptSharedWithAuthor: integer('excerpt_shared_with_author', { mode: 'boolean' }).notNull().default(false),
    diagnostics: jsonText<CommunityFeedbackDraft['diagnostics']>('diagnostics').notNull(),
    state: text().$type<CommunityFeedbackDraft['state']>().notNull(),
    requestedBy: text('requested_by').notNull(),
    auto: integer({ mode: 'boolean' }).notNull().default(false),
    error: text(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('community_feedback_drafts_identity_idx').on(table.communityUrl, table.communityUserId, table.createdAt),
    check(
      'community_feedback_drafts_state_ck',
      sql`${table.state} IN ('awaiting', 'sending', 'sent', 'failed', 'discarded')`,
    ),
  ],
)

export const communityFeedbackItems = sqliteTable(
  'community_feedback_items',
  {
    ref: text().notNull(),
    communityUrl: text('community_url').notNull(),
    communityUserId: text('community_user_id').notNull(),
    channelId: text('channel_id').$type<ChannelId>(),
    draftId: text('draft_id').$type<CommunityFeedbackDraftId>(),
    title: text().notNull(),
    kind: text().$type<CommunityFeedbackItem['kind']>(),
    target: jsonText<CommunityFeedbackItem['target']>('target'),
    status: text().$type<CommunityFeedbackItem['status']>().notNull(),
    fixedIn: text('fixed_in'),
    unread: integer({ mode: 'boolean' }).notNull().default(false),
    lastEventSeq: integer('last_event_seq').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.communityUrl, table.communityUserId, table.ref] }),
    index('community_feedback_items_channel_idx').on(table.communityUrl, table.communityUserId, table.channelId),
  ],
)

/** A reset belongs to the source storage identity, never to a product build. */
export const dshSessionResets = sqliteTable(
  'dsh_session_resets',
  {
    migrationId: text('migration_id').primaryKey(),
    closedAt: integer('closed_at').notNull(),
    episodesClosed: integer('episodes_closed').notNull(),
    admissionsCancelled: integer('admissions_cancelled').notNull(),
    bindingsCutOff: integer('bindings_cut_off').notNull(),
    authoringTasksInterrupted: integer('authoring_tasks_interrupted').notNull(),
  },
  (table) => [check('dsh_session_resets_time_ck', sql`${table.closedAt} >= 0`)],
)

/** Preserve the Binding's creation time while excluding pre-upgrade inbound backlog. */
export const bindingAdmissionCutoffs = sqliteTable(
  'binding_admission_cutoffs',
  {
    channelId: text('channel_id')
      .$type<ChannelId>()
      .primaryKey()
      .references(() => channelBindings.channelId, { onDelete: 'cascade' }),
    agentId: text('agent_id').$type<AgentId>().notNull(),
    boundAt: integer('bound_at').notNull(),
    eventId: text('event_id').$type<ChannelEventId>().notNull(),
    migrationId: text('migration_id')
      .notNull()
      .references(() => dshSessionResets.migrationId, { onDelete: 'restrict' }),
  },
  (table) => [
    foreignKey({
      name: 'binding_admission_cutoffs_event_fk',
      columns: [table.eventId, table.channelId],
      foreignColumns: [channelEvents.id, channelEvents.channelId],
    }).onDelete('restrict'),
  ],
)

/** Non-versioned agent presentation: identity hue (0-359) and optional avatar Asset. Never part of a Revision. */
export const agentAppearances = sqliteTable(
  'agent_appearances',
  {
    agentId: text('agent_id')
      .$type<AgentId>()
      .primaryKey()
      .references(() => agentDefinitions.id, { onDelete: 'cascade' }),
    hue: integer(),
    avatarAssetId: text('avatar_asset_id')
      .$type<AssetId>()
      .references(() => assets.id, { onDelete: 'set null' }),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    check('agent_appearances_hue_ck', sql`${table.hue} IS NULL OR (${table.hue} >= 0 AND ${table.hue} <= 359)`),
  ],
)

/** A management viewer: `local` for the loopback console, `device:<id>` for paired remote devices. */
export const readViewers = sqliteTable('read_viewers', {
  viewerKey: text('viewer_key').primaryKey(),
  createdAt: integer('created_at').notNull(),
})

/** Per-viewer read position in one Channel's inbound history. */
export const channelReadCursors = sqliteTable(
  'channel_read_cursors',
  {
    viewerKey: text('viewer_key')
      .notNull()
      .references(() => readViewers.viewerKey, { onDelete: 'cascade' }),
    channelId: text('channel_id')
      .$type<ChannelId>()
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    readAt: integer('read_at').notNull(),
    readSourceId: text('read_source_id').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.viewerKey, table.channelId] })],
)

/** Instance-wide dismissal of one attention item fingerprint. */
export const attentionDismissals = sqliteTable(
  'attention_dismissals',
  {
    fingerprint: text().primaryKey(),
    dismissedAt: integer('dismissed_at').notNull(),
  },
  (table) => [index('attention_dismissals_time_idx').on(table.dismissedAt)],
)

/** Administrator resolutions of unsettled Outbound Intents; earlier receipts are kept here, not overwritten silently. */
export const outboundResolutions = sqliteTable(
  'outbound_resolutions',
  {
    id: text().primaryKey(),
    intentId: text('intent_id')
      .$type<OutboundIntentId>()
      .notNull()
      .references(() => outboundIntents.id, { onDelete: 'cascade' }),
    action: text({ enum: ['retry', 'confirm-delivered'] }).notNull(),
    previousState: text('previous_state', { enum: ['partially-sent', 'failed', 'unknown'] }).notNull(),
    previousDeliveries: jsonText<JsonValue>('previous_deliveries').notNull(),
    viewerKey: text('viewer_key').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('outbound_resolutions_intent_idx').on(table.intentId, table.createdAt),
    check('outbound_resolutions_action_ck', sql`${table.action} IN ('retry', 'confirm-delivered')`),
    check(
      'outbound_resolutions_previous_state_ck',
      sql`${table.previousState} IN ('partially-sent', 'failed', 'unknown')`,
    ),
  ],
)

export const extensionStorageEntries = sqliteTable(
  'extension_storage_entries',
  {
    extensionId: text('extension_id')
      .$type<ExtensionId>()
      .notNull()
      .references(() => localExtensions.id, { onDelete: 'cascade' }),
    owner: text().notNull(),
    agentId: text('agent_id').$type<AgentId>(),
    partition: text().notNull(),
    key: text().notNull(),
    valueJson: jsonText<JsonValue>('value_json').notNull(),
    byteSize: integer('byte_size').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.extensionId, table.owner, table.partition, table.key] }),
    index('extension_storage_entries_extension_idx').on(table.extensionId),
    foreignKey({
      name: 'extension_storage_entries_agent_fk',
      columns: [table.agentId],
      foreignColumns: [agentDefinitions.id],
    }).onDelete('cascade'),
    check(
      'extension_storage_entries_owner_agent_ck',
      sql`(${table.owner} = 'shared' AND ${table.agentId} IS NULL) OR (${table.owner} != 'shared' AND ${table.agentId} = ${table.owner})`,
    ),
    check('extension_storage_entries_byte_size_ck', sql`${table.byteSize} >= 0`),
    check('extension_storage_entries_updated_at_ck', sql`${table.updatedAt} >= 0`),
  ],
)

export const extensionJobs = sqliteTable(
  'extension_jobs',
  {
    id: text().primaryKey(),
    agentId: text('agent_id')
      .$type<AgentId>()
      .notNull()
      .references(() => agentDefinitions.id, { onDelete: 'cascade' }),
    extensionId: text('extension_id')
      .$type<ExtensionId>()
      .references(() => localExtensions.id, { onDelete: 'cascade' }),
    channelId: text('channel_id')
      .$type<ChannelId>()
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    source: text('source', { enum: ['declared', 'runtime', 'reminder'] }).notNull(),
    declaredKey: text('declared_key'),
    label: text().notNull(),
    scheduleKind: text('schedule_kind', { enum: ['once', 'cron'] }).notNull(),
    runAt: integer('run_at'),
    cron: text(),
    timezone: text(),
    payloadJson: jsonText<JsonValue>('payload_json').notNull(),
    nextRunAt: integer('next_run_at'),
    lastFiredAt: integer('last_fired_at'),
    paused: integer().notNull().default(0),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('extension_jobs_paused_next_run_idx').on(table.paused, table.nextRunAt),
    index('extension_jobs_agent_extension_idx').on(table.agentId, table.extensionId),
    uniqueIndex('extension_jobs_declared_unique')
      .on(table.agentId, table.extensionId, table.channelId, table.declaredKey)
      .where(sql`${table.source} = 'declared'`),
    check('extension_jobs_id_ck', sql`${table.id} LIKE 'job_%'`),
    check('extension_jobs_label_length_ck', sql`LENGTH(${table.label}) BETWEEN 1 AND 200`),
    check(
      'extension_jobs_schedule_kind_ck',
      sql`(${table.scheduleKind} = 'once' AND ${table.runAt} IS NOT NULL AND ${table.cron} IS NULL AND ${table.timezone} IS NULL) OR (${table.scheduleKind} = 'cron' AND ${table.runAt} IS NULL AND ${table.cron} IS NOT NULL AND ${table.timezone} IS NOT NULL)`,
    ),
    check(
      'extension_jobs_declared_key_ck',
      sql`(${table.source} = 'declared' AND ${table.declaredKey} IS NOT NULL) OR (${table.source} != 'declared' AND ${table.declaredKey} IS NULL)`,
    ),
    check(
      'extension_jobs_extension_id_ck',
      sql`(${table.source} = 'declared' OR ${table.source} = 'runtime') AND ${table.extensionId} IS NOT NULL OR (${table.source} = 'reminder' AND ${table.extensionId} IS NULL)`,
    ),
  ],
)

export const inboundHookDecisions = sqliteTable(
  'inbound_hook_decisions',
  {
    channelEventId: text('channel_event_id')
      .$type<ChannelEventId>()
      .notNull()
      .references(() => channelEvents.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .$type<AgentId>()
      .notNull()
      .references(() => agentDefinitions.id, { onDelete: 'cascade' }),
    trigger: text('trigger', { enum: ['default', 'suppress', 'force'] }).notNull(),
    hidden: integer().notNull(),
    annotation: text(),
    decidedBy: jsonText<ExtensionId[]>('decided_by').notNull(),
    diagnostics: jsonText<JsonValue>('diagnostics'),
    decidedAt: integer('decided_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.channelEventId, table.agentId] }),
    check(
      'inbound_hook_decisions_annotation_length_ck',
      sql`${table.annotation} IS NULL OR LENGTH(${table.annotation}) <= 2000`,
    ),
    check('inbound_hook_decisions_decided_at_ck', sql`${table.decidedAt} > 0`),
  ],
)

export const coreSchema = {
  commandSystem,
  commandPolicies,
  commandGrants,
  commandChannelSettings,
  commandIgnoredEvents,
  commandExecutions,
  communityFeedbackDrafts,
  communityFeedbackItems,
  agentDefinitions,
  agentRevisions,
  agentCurrentRevisions,
  connections,
  connectionState,
  connectionEvents,
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
  extensionRevisionReleases,
  extensionCommunityLinks,
  extensionDataStates,
  extensionDataSnapshots,
  instanceAdministrators,
  extensionRequests,
  hostExtensionInstallations,
  hostUiPageEntries,
  hostUiPagePreferences,
  hostUiPermissionGrants,
  hostUiDiagnostics,
  agentActivations,
  extensionClientDiagnostics,
  dshPluginPackages,
  dshPluginEntries,
  dshPluginActivations,
  dshPluginDiagnostics,
  hostSecurityMetadata,
  managementDevices,
  workTreeOrder,
  systemSettings,
  dshSessionResets,
  bindingAdmissionCutoffs,
  agentAppearances,
  readViewers,
  channelReadCursors,
  attentionDismissals,
  outboundResolutions,
  extensionStorageEntries,
  extensionJobs,
  inboundHookDecisions,
} as const

/**
 * What the agent answering a channel reads about it; it follows the channel across rebinding. `instructions` are the
 * admin's (system prompt, agent cannot edit); `notes` are the agent's own (runtime context, editable unless locked).
 */
export const channelPrompts = sqliteTable(
  'channel_prompts',
  {
    channelId: text('channel_id')
      .$type<ChannelId>()
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['instructions', 'notes'] }).notNull(),
    document: jsonText<PromptDocumentV1>('document').notNull(),
    /** Notes only: the agent may not rewrite them. */
    locked: integer({ mode: 'boolean' }).notNull().default(false),
    revision: integer().notNull(),
    updatedBy: text('updated_by', { enum: ['admin', 'agent'] }).notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.channelId, table.kind] }),
    check('channel_prompts_kind_ck', sql`${table.kind} IN ('instructions', 'notes')`),
    check('channel_prompts_revision_ck', sql`${table.revision} >= 1`),
    check('channel_prompts_updated_by_ck', sql`${table.updatedBy} IN ('admin', 'agent')`),
  ],
)

/** What the agent keeps about one member of a channel; it comes with that member's messages, only in this channel. */
export const channelMemberNotes = sqliteTable(
  'channel_member_notes',
  {
    channelId: text('channel_id')
      .$type<ChannelId>()
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    memberId: text('member_id')
      .$type<ChannelMemberId>()
      .notNull()
      .references(() => channelMembers.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    updatedBy: text('updated_by', { enum: ['admin', 'agent'] }).notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.channelId, table.memberId] }),
    check('channel_member_notes_updated_by_ck', sql`${table.updatedBy} IN ('admin', 'agent')`),
  ],
)

/** A sub-conversation under a channel's conversation; its log lives in the DSH session `dsh_session_id`. */
export const subConversations = sqliteTable(
  'sub_conversations',
  {
    id: text().$type<SubConversationId>().primaryKey(),
    channelId: text('channel_id')
      .$type<ChannelId>()
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    // Not a foreign key: the channel already removes its sub-conversations, and a channel conversation's session is
    // known before its episode row in some host paths.
    episodeId: text('episode_id').$type<EpisodeId>().notNull(),
    agentId: text('agent_id').$type<AgentId>().notNull(),
    dshSessionId: text('dsh_session_id').notNull().unique(),
    parentDshSessionId: text('parent_dsh_session_id').notNull(),
    title: text().notNull(),
    openedBy: text('opened_by', { enum: ['agent', 'host'] }).notNull(),
    driver: text({ enum: ['model', 'script'] }).notNull(),
    status: text({ enum: ['open', 'closed'] }).notNull(),
    closeReason: text('close_reason', {
      enum: ['completed', 'closed-by-agent', 'closed-by-admin', 'failed', 'conversation-ended'],
    }),
    summary: text(),
    authoringTaskId: text('authoring_task_id').$type<AuthoringTaskId>(),
    createdAt: integer('created_at').notNull(),
    closedAt: integer('closed_at'),
  },
  (table) => [
    index('sub_conversations_channel_idx').on(table.channelId, table.createdAt),
    index('sub_conversations_episode_idx').on(table.episodeId, table.status),
    index('sub_conversations_closed_idx').on(table.status, table.closedAt),
    check('sub_conversations_opened_by_ck', sql`${table.openedBy} IN ('agent', 'host')`),
    check('sub_conversations_driver_ck', sql`${table.driver} IN ('model', 'script')`),
    check(
      'sub_conversations_status_ck',
      sql`(${table.status} = 'open' AND ${table.closeReason} IS NULL AND ${table.closedAt} IS NULL) OR (${table.status} = 'closed' AND ${table.closeReason} IN ('completed', 'closed-by-agent', 'closed-by-admin', 'failed', 'conversation-ended') AND ${table.closedAt} IS NOT NULL)`,
    ),
  ],
)

/** A channel's own context budget; channels without a row follow the defaults. */
export const channelContextPolicies = sqliteTable('channel_context_policies', {
  channelId: text('channel_id')
    .$type<ChannelId>()
    .primaryKey()
    .references(() => channels.id, { onDelete: 'cascade' }),
  policy: jsonText<ChannelContextPolicy>('policy').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

/** Recent earlier versions of a channel prompt, kept so an edit by the agent or an admin can be undone. */
export const channelPromptRevisions = sqliteTable(
  'channel_prompt_revisions',
  {
    channelId: text('channel_id')
      .$type<ChannelId>()
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['instructions', 'notes'] }).notNull(),
    revision: integer().notNull(),
    document: jsonText<PromptDocumentV1>('document').notNull(),
    updatedBy: text('updated_by', { enum: ['admin', 'agent'] }).notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.channelId, table.kind, table.revision] }),
    check('channel_prompt_revisions_updated_by_ck', sql`${table.updatedBy} IN ('admin', 'agent')`),
  ],
)

/**
 * Assets an extension keeps in its own library (表情包与扩展素材能力 §4.2). A library Asset can be granted to any
 * channel later; the row also counts toward the extension's library quota.
 */
export const extensionLibraryAssets = sqliteTable(
  'extension_library_assets',
  {
    extensionId: text('extension_id')
      .$type<ExtensionId>()
      .notNull()
      .references(() => localExtensions.id, { onDelete: 'cascade' }),
    assetId: text('asset_id')
      .$type<AssetId>()
      .notNull()
      .references(() => assets.id, { onDelete: 'restrict' }),
    addedAt: integer('added_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.extensionId, table.assetId] }),
    index('extension_library_assets_added_idx').on(table.extensionId, table.addedAt, table.assetId),
    check('extension_library_assets_added_at_ck', sql`${table.addedAt} >= 0`),
  ],
)

/**
 * One document of an extension's search index. `id` is the rowid of `extension_index_fts`, a keyword table created by
 * the migration and kept in step by triggers; `fields` keeps the source text so keywords and vectors can be rebuilt.
 */
export const extensionIndexDocuments = sqliteTable(
  'extension_index_documents',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    extensionId: text('extension_id')
      .$type<ExtensionId>()
      .notNull()
      .references(() => localExtensions.id, { onDelete: 'cascade' }),
    collection: text().notNull(),
    documentId: text('document_id').notNull(),
    fields: jsonText<Readonly<Record<string, string>>>('fields').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('extension_index_documents_key_uq').on(table.extensionId, table.collection, table.documentId),
    check('extension_index_documents_updated_at_ck', sql`${table.updatedAt} >= 0`),
  ],
)

export const extensionIndexFilterValues = sqliteTable(
  'extension_index_filter_values',
  {
    documentRowId: integer('document_row_id')
      .notNull()
      .references(() => extensionIndexDocuments.id, { onDelete: 'cascade' }),
    field: text().notNull(),
    value: text().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.documentRowId, table.field, table.value] }),
    index('extension_index_filter_values_lookup_idx').on(table.field, table.value, table.documentRowId),
  ],
)

/**
 * Vectors of one document in one vector space (model, dimensions and text template). Spaces never mix: a query only
 * compares vectors of the space it was embedded in.
 */
export const extensionIndexVectors = sqliteTable(
  'extension_index_vectors',
  {
    documentRowId: integer('document_row_id')
      .notNull()
      .references(() => extensionIndexDocuments.id, { onDelete: 'cascade' }),
    space: text().notNull(),
    /** int8 components; `scale` restores the original magnitudes. */
    vector: blob({ mode: 'buffer' }).notNull(),
    scale: real().notNull(),
    textDigest: text('text_digest').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.documentRowId, table.space] }),
    index('extension_index_vectors_space_idx').on(table.space, table.documentRowId),
  ],
)
