import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

/** Durable Host upgrade journal; domain tables are introduced with their first real consumers. */
export const migrationJournal = sqliteTable('migration_journal', {
  id: text('id').primaryKey(),
  state: text('state', { enum: ['running', 'completed', 'failed'] }).notNull(),
  startedAt: integer('started_at').notNull(),
  completedAt: integer('completed_at'),
  errorSummary: text('error_summary'),
})

export const agentDefinitions = sqliteTable('agent_definitions', {
  id: text('id').primaryKey(),
  currentRevisionId: text('current_revision_id').notNull(),
  createdAt: integer('created_at').notNull(),
})

export const agentRevisions = sqliteTable(
  'agent_revisions',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agentDefinitions.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    displayName: text('display_name').notNull(),
    persona: text('persona').notNull(),
    modelProvider: text('model_provider').notNull(),
    modelId: text('model_id').notNull(),
    reasoningEffort: text('reasoning_effort'),
    capabilitiesJson: text('capabilities_json').notNull(),
    settingsJson: text('settings_json'),
    contentDigest: text('content_digest').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('agent_revisions_agent_revision_uq').on(table.agentId, table.revision),
    uniqueIndex('agent_revisions_agent_digest_uq').on(table.agentId, table.contentDigest),
  ],
)

export const connections = sqliteTable('connections', {
  id: text('id').primaryKey(),
  adapterKey: text('adapter_key').notNull(),
  configJson: text('config_json').notNull(),
  credentialRefsJson: text('credential_refs_json').notNull(),
  status: text('status', { enum: ['configured', 'active', 'stopped', 'failed'] }).notNull(),
  createdAt: integer('created_at').notNull(),
})

export const channels = sqliteTable(
  'channels',
  {
    id: text('id').primaryKey(),
    logicalMessageId: text('logical_message_id').notNull().unique(),
    connectionId: text('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    platformChannelId: text('platform_channel_id').notNull(),
    kind: text('kind', { enum: ['web', 'direct', 'group'] }).notNull(),
    displayName: text('display_name'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [uniqueIndex('channels_connection_platform_uq').on(table.connectionId, table.platformChannelId)],
)

export const platformIdentities = sqliteTable(
  'platform_identities',
  {
    id: text('id').primaryKey(),
    connectionId: text('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    platformUserId: text('platform_user_id').notNull(),
    displayName: text('display_name'),
    firstSeenAt: integer('first_seen_at').notNull(),
    lastSeenAt: integer('last_seen_at').notNull(),
    seenCount: integer('seen_count').notNull(),
  },
  (table) => [uniqueIndex('platform_identities_connection_user_uq').on(table.connectionId, table.platformUserId)],
)

export const channelMembers = sqliteTable(
  'channel_members',
  {
    id: text('id').primaryKey(),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    platformIdentityId: text('platform_identity_id')
      .notNull()
      .references(() => platformIdentities.id, { onDelete: 'cascade' }),
    displayName: text('display_name'),
    firstSeenAt: integer('first_seen_at').notNull(),
    lastSeenAt: integer('last_seen_at').notNull(),
    seenCount: integer('seen_count').notNull(),
  },
  (table) => [uniqueIndex('channel_members_channel_identity_uq').on(table.channelId, table.platformIdentityId)],
)

export const bindings = sqliteTable(
  'bindings',
  {
    id: text('id').primaryKey(),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agentDefinitions.id, { onDelete: 'cascade' }),
    triggerPolicy: text('trigger_policy', {
      enum: ['always', 'mentioned-or-replied', 'command', 'observe-only'],
    }).notNull(),
    revision: integer('revision').notNull(),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('bindings_channel_agent_uq').on(table.channelId, table.agentId),
    uniqueIndex('bindings_active_channel_uq')
      .on(table.channelId)
      .where(sql`${table.active} = 1`),
  ],
)

export const channelEvents = sqliteTable(
  'channel_events',
  {
    id: text('id').primaryKey(),
    connectionId: text('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    adapterKey: text('adapter_key').notNull(),
    platformEventId: text('platform_event_id'),
    platformMessageId: text('platform_message_id'),
    kind: text('kind').notNull(),
    senderMemberId: text('sender_member_id'),
    partsJson: text('parts_json').notNull(),
    platformSequence: integer('platform_sequence'),
    platformTimestamp: integer('platform_timestamp').notNull(),
    receivedAt: integer('received_at').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    factsJson: text('facts_json'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [uniqueIndex('channel_events_connection_dedupe_uq').on(table.connectionId, table.dedupeKey)],
)

export const adapterCheckpoints = sqliteTable('adapter_checkpoints', {
  connectionId: text('connection_id')
    .primaryKey()
    .references(() => connections.id, { onDelete: 'cascade' }),
  checkpointJson: text('checkpoint_json').notNull(),
  channelEventId: text('channel_event_id')
    .notNull()
    .references(() => channelEvents.id, { onDelete: 'cascade' }),
  updatedAt: integer('updated_at').notNull(),
})

export const adapterRuntimeStates = sqliteTable(
  'adapter_runtime_states',
  {
    connectionId: text('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    stateKey: text('state_key').notNull(),
    stateJson: text('state_json').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [uniqueIndex('adapter_runtime_states_connection_key_uq').on(table.connectionId, table.stateKey)],
)

export const episodes = sqliteTable(
  'episodes',
  {
    id: text('id').primaryKey(),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agentDefinitions.id, { onDelete: 'cascade' }),
    agentRevisionId: text('agent_revision_id')
      .notNull()
      .references(() => agentRevisions.id),
    bindingId: text('binding_id')
      .notNull()
      .references(() => bindings.id),
    bindingRevision: integer('binding_revision').notNull(),
    dshSessionId: text('dsh_session_id'),
    status: text('status', { enum: ['opening', 'active', 'rolling-over', 'closed', 'failed'] }).notNull(),
    openedAtEventId: text('opened_at_event_id')
      .notNull()
      .references(() => channelEvents.id),
    lastAdmittedEventId: text('last_admitted_event_id').references(() => channelEvents.id),
    closedAtEventId: text('closed_at_event_id').references(() => channelEvents.id),
    closedAt: integer('closed_at'),
    closeReason: text('close_reason', {
      enum: [
        'manual',
        'idle-timeout',
        'incompatible-revision',
        'incompatible-activation',
        'unrecoverable-session',
        'permission-revoked',
        'stopped',
      ],
    }),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('episodes_live_lane_uq')
      .on(table.channelId, table.agentId)
      .where(sql`${table.status} IN ('opening', 'active', 'rolling-over')`),
  ],
)

export const episodeHandoffs = sqliteTable('episode_handoffs', {
  id: text('id').primaryKey(),
  fromEpisodeId: text('from_episode_id')
    .notNull()
    .references(() => episodes.id),
  toEpisodeId: text('to_episode_id')
    .notNull()
    .references(() => episodes.id),
  sourceEventIdsJson: text('source_event_ids_json').notNull(),
  recentEventIdsJson: text('recent_event_ids_json').notNull(),
  summary: text('summary').notNull(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  createdAt: integer('created_at').notNull(),
})

export const admissions = sqliteTable('admissions', {
  id: text('id').primaryKey(),
  episodeId: text('episode_id')
    .notNull()
    .references(() => episodes.id, { onDelete: 'cascade' }),
  channelEventIdsJson: text('channel_event_ids_json').notNull(),
  reason: text('reason', { enum: ['trigger', 'running-injection', 'recovery'] }).notNull(),
  state: text('state', { enum: ['pending', 'claimed', 'logged-to-session', 'rejected'] }).notNull(),
  dshMessageId: text('dsh_message_id'),
  createdAt: integer('created_at').notNull(),
  claimedAt: integer('claimed_at'),
  loggedAt: integer('logged_at'),
})

export const outboundIntents = sqliteTable(
  'outbound_intents',
  {
    id: text('id').primaryKey(),
    logicalMessageId: text('logical_message_id').notNull().unique(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agentDefinitions.id),
    agentRevisionId: text('agent_revision_id')
      .notNull()
      .references(() => agentRevisions.id),
    episodeId: text('episode_id')
      .notNull()
      .references(() => episodes.id),
    sourceTurnId: text('source_turn_id'),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id),
    partsJson: text('parts_json').notNull(),
    replyTo: text('reply_to'),
    clientRequestId: text('client_request_id'),
    state: text('state', {
      enum: ['planned', 'sending', 'sent', 'partially-sent', 'failed', 'unknown'],
    }).notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('outbound_intents_client_request_uq').on(table.agentId, table.channelId, table.clientRequestId),
  ],
)

export const physicalDeliveries = sqliteTable(
  'physical_deliveries',
  {
    id: text('id').primaryKey(),
    intentId: text('intent_id')
      .notNull()
      .references(() => outboundIntents.id, { onDelete: 'cascade' }),
    sequence: integer('sequence').notNull(),
    partsJson: text('parts_json').notNull(),
    adapterContextJson: text('adapter_context_json'),
    state: text('state', { enum: ['planned', 'sending', 'sent', 'failed', 'unknown'] }).notNull(),
    attemptCount: integer('attempt_count').notNull(),
  },
  (table) => [uniqueIndex('physical_deliveries_intent_sequence_uq').on(table.intentId, table.sequence)],
)

export const deliveryReceipts = sqliteTable(
  'delivery_receipts',
  {
    id: text('id').primaryKey(),
    physicalDeliveryId: text('physical_delivery_id')
      .notNull()
      .references(() => physicalDeliveries.id, { onDelete: 'cascade' }),
    attempt: integer('attempt').notNull(),
    receiptJson: text('receipt_json').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [uniqueIndex('delivery_receipts_delivery_attempt_uq').on(table.physicalDeliveryId, table.attempt)],
)

export const assets = sqliteTable(
  'assets',
  {
    id: text('id').primaryKey(),
    contentDigest: text('content_digest').notNull(),
    byteSize: integer('byte_size').notNull(),
    mediaType: text('media_type').notNull(),
    blobState: text('blob_state', { enum: ['present', 'evicted', 'missing', 'quarantined'] }).notNull(),
    firstReceivedAt: integer('first_received_at').notNull(),
    lastReceivedAt: integer('last_received_at').notNull(),
    receiveCount: integer('receive_count').notNull(),
    lastAccessedAt: integer('last_accessed_at'),
    storageFormatVersion: integer('storage_format_version').notNull(),
  },
  (table) => [uniqueIndex('assets_content_digest_uq').on(table.contentDigest)],
)

export const assetOccurrences = sqliteTable('asset_occurrences', {
  id: text('id').primaryKey(),
  assetId: text('asset_id')
    .notNull()
    .references(() => assets.id, { onDelete: 'cascade' }),
  channelEventId: text('channel_event_id')
    .notNull()
    .references(() => channelEvents.id, { onDelete: 'cascade' }),
  channelId: text('channel_id')
    .notNull()
    .references(() => channels.id, { onDelete: 'cascade' }),
  connectionId: text('connection_id')
    .notNull()
    .references(() => connections.id, { onDelete: 'cascade' }),
  platformMessageId: text('platform_message_id'),
  receivedAt: integer('received_at').notNull(),
  filename: text('filename'),
  declaredMediaType: text('declared_media_type'),
})

export const assetOperations = sqliteTable('asset_operations', {
  id: text('id').primaryKey(),
  state: text('state', { enum: ['running', 'completed', 'failed'] }).notNull(),
  stagingRelativePath: text('staging_relative_path').notNull(),
  blobRelativePath: text('blob_relative_path').notNull(),
  candidateJson: text('candidate_json').notNull(),
  occurrenceJson: text('occurrence_json').notNull(),
  createdAt: integer('created_at').notNull(),
  completedAt: integer('completed_at'),
  errorSummary: text('error_summary'),
})

export const assetEnrichments = sqliteTable(
  'asset_enrichments',
  {
    id: text('id').primaryKey(),
    assetId: text('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    enhancerId: text('enhancer_id').notNull(),
    provider: text('provider').notNull(),
    modelId: text('model_id').notNull(),
    promptVersion: integer('prompt_version').notNull(),
    schemaVersion: integer('schema_version').notNull(),
    state: text('state', { enum: ['pending', 'running', 'succeeded', 'failed'] }).notNull(),
    summary: text('summary'),
    ocrText: text('ocr_text'),
    tagsJson: text('tags_json'),
    inputDigest: text('input_digest').notNull(),
    attemptCount: integer('attempt_count').notNull(),
    failureKind: text('failure_kind'),
    errorSummary: text('error_summary'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('asset_enrichments_key_uq').on(
      table.assetId,
      table.enhancerId,
      table.modelId,
      table.promptVersion,
      table.schemaVersion,
    ),
  ],
)

export const extensionDrafts = sqliteTable(
  'extension_drafts',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agentDefinitions.id, { onDelete: 'cascade' }),
    sourceDshSessionId: text('source_dsh_session_id').notNull(),
    sourceDynamicPluginId: text('source_dynamic_plugin_id').notNull(),
    displayName: text('display_name').notNull(),
    description: text('description').notNull(),
    state: text('state', { enum: ['open', 'saved', 'discarded'] }).notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('extension_drafts_open_source_uq')
      .on(table.agentId, table.sourceDshSessionId, table.sourceDynamicPluginId)
      .where(sql`${table.state} = 'open'`),
  ],
)

export const draftPackages = sqliteTable(
  'draft_packages',
  {
    id: text('id').primaryKey(),
    draftId: text('draft_id')
      .notNull()
      .references(() => extensionDrafts.id, { onDelete: 'cascade' }),
    sourceDynamicPackageId: text('source_dynamic_package_id').notNull(),
    sequence: integer('sequence').notNull(),
    name: text('name').notNull(),
    purpose: text('purpose').notNull(),
    hostCode: text('host_code'),
    clientCode: text('client_code'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('draft_packages_source_uq').on(table.draftId, table.sourceDynamicPackageId),
    uniqueIndex('draft_packages_sequence_uq').on(table.draftId, table.sequence),
  ],
)

export const localExtensions = sqliteTable('local_extensions', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  displayName: text('display_name').notNull(),
  description: text('description').notNull(),
  origin: text('origin', { enum: ['local-created', 'local-imported'] }).notNull(),
  createdByAgentId: text('created_by_agent_id').references(() => agentDefinitions.id),
  defaultRevisionId: text('default_revision_id'),
  createdAt: integer('created_at').notNull(),
  deletedAt: integer('deleted_at'),
})

export const extensionRevisions = sqliteTable(
  'extension_revisions',
  {
    id: text('id').primaryKey(),
    extensionId: text('extension_id')
      .notNull()
      .references(() => localExtensions.id, { onDelete: 'cascade' }),
    revisionNumber: integer('revision_number').notNull(),
    contentDigest: text('content_digest').notNull(),
    manifestSchemaVersion: integer('manifest_schema_version').notNull(),
    extensionApiVersion: text('extension_api_version').notNull(),
    sourceKind: text('source_kind', { enum: ['dynamic-package', 'local-source'] }).notNull(),
    sourceDynamicPackageRef: text('source_dynamic_package_ref'),
    compatibleNekroNxtRange: text('compatible_nekro_nxt_range').notNull(),
    compatibleDshRange: text('compatible_dsh_range').notNull(),
    storageState: text('storage_state', { enum: ['saving', 'saved', 'damaged', 'quarantined'] }).notNull(),
    lastBuildStatus: text('last_build_status', { enum: ['succeeded', 'failed'] }),
    lastValidationStatus: text('last_validation_status', { enum: ['succeeded', 'failed'] }),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('extension_revisions_number_uq').on(table.extensionId, table.revisionNumber),
    uniqueIndex('extension_revisions_digest_uq').on(table.extensionId, table.contentDigest),
  ],
)

export const extensionSaveOperations = sqliteTable('extension_save_operations', {
  id: text('id').primaryKey(),
  draftPackageId: text('draft_package_id')
    .notNull()
    .references(() => draftPackages.id),
  extensionId: text('extension_id')
    .notNull()
    .references(() => localExtensions.id),
  revisionId: text('revision_id')
    .notNull()
    .references(() => extensionRevisions.id),
  stagingRelativePath: text('staging_relative_path').notNull(),
  finalRelativePath: text('final_relative_path').notNull(),
  state: text('state', { enum: ['running', 'completed', 'failed'] }).notNull(),
  errorSummary: text('error_summary'),
  createdAt: integer('created_at').notNull(),
  completedAt: integer('completed_at'),
})

export const agentActivations = sqliteTable('agent_activations', {
  id: text('id').primaryKey(),
  agentId: text('agent_id')
    .notNull()
    .references(() => agentDefinitions.id, { onDelete: 'cascade' }),
  extensionId: text('extension_id')
    .notNull()
    .references(() => localExtensions.id, { onDelete: 'cascade' }),
  extensionRevisionId: text('extension_revision_id')
    .notNull()
    .references(() => extensionRevisions.id),
  configJson: text('config_json').notNull(),
  state: text('state', { enum: ['pending', 'waiting-safe-switch', 'active', 'failed', 'disabled'] }).notNull(),
  runtimeKind: text('runtime_kind', { enum: ['in-process'] }).notNull(),
  createdAt: integer('created_at').notNull(),
  activatedAt: integer('activated_at'),
  disabledAt: integer('disabled_at'),
  lastError: text('last_error'),
})
