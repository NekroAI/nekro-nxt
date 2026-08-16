import { backup, DatabaseSync } from 'node:sqlite'
import { lstat, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  AdmissionId,
  AgentActivationId,
  AgentId,
  AgentRevisionId,
  AssetId,
  AssetOccurrenceId,
  BindingId,
  ChannelEventId,
  ChannelId,
  ChannelMemberId,
  ConnectionId,
  DeliveryReceiptId,
  EpisodeId,
  EpisodeHandoffId,
  DraftPackageId,
  ExtensionDraftId,
  ExtensionId,
  ExtensionRevisionId,
  ExtensionSaveOperationId,
  JsonValue,
  LogicalMessageId,
  MessagePart,
  OutboundIntentId,
  PhysicalDeliveryId,
  PlatformIdentityId,
} from '@nekro-nxt/contracts'
import { parseJsonValue, parseMessageParts } from '@nekro-nxt/contracts'
import { parseAdapterDeliveryReceipt } from '@nekro-nxt/adapter-sdk'
import type { AdapterRuntimeStateStore } from '@nekro-nxt/adapter-sdk'
import type {
  AdmissionRecord,
  ChannelHistoryEntry,
  ChannelHistoryRepository,
  ChannelHistorySearchHit,
  DeliveryReceiptRecord,
  EpisodeRecord,
  EpisodeCloseReason,
  EpisodeHandoffRecord,
  OutboundIntentRecord,
  OutboundSnapshot,
  OutboundState,
  PhysicalDeliveryRecord,
  RuntimeRepository,
} from '@nekro-nxt/channel-runtime'
import type {
  AgentDefinitionRecord,
  AgentRevisionRecord,
  AppendChannelEventCommit,
  AssetOccurrenceInput,
  AssetOccurrenceRecord,
  AssetEnrichmentRecord,
  AssetEnrichmentRepository,
  AssetOperationRecord,
  AssetReceiptCommit,
  AssetRecord,
  AssetRepository,
  BindingRecord,
  ChannelEventRecord,
  ChannelRecord,
  ChannelMemberRecord,
  ConnectionRecord,
  CoreRepository,
  CreateAgentCommit,
  PlatformIdentityRecord,
  PlatformMessageReferenceRecord,
} from '@nekro-nxt/core'
import { parseAgentCapabilityGrants } from '@nekro-nxt/core'
import type {
  AgentActivationRecord,
  DraftPackageRecord,
  ExtensionDraftRecord,
  ExtensionRepository,
  ExtensionRevisionRecord,
  ExtensionSaveOperationRecord,
  LocalExtensionRecord,
} from '@nekro-nxt/extension-runtime'

export {
  adapterCheckpoints,
  adapterRuntimeStates,
  agentActivations,
  admissions,
  agentDefinitions,
  agentRevisions,
  assetOccurrences,
  assetEnrichments,
  assetOperations,
  assets,
  bindings,
  channelMembers,
  channelEvents,
  channels,
  connections,
  deliveryReceipts,
  draftPackages,
  episodes,
  episodeHandoffs,
  extensionDrafts,
  extensionRevisions,
  extensionSaveOperations,
  localExtensions,
  migrationJournal,
  outboundIntents,
  physicalDeliveries,
  platformIdentities,
} from './schema.js'

/** The Core schema version starts at one with the upgrade journal table. */
export const CORE_SCHEMA_VERSION = 13
const CORE_MIGRATION_FILES = [
  '0000_red_darkstar.sql',
  '0001_broad_taskmaster.sql',
  '0002_runtime.sql',
  '0003_assets.sql',
  '0004_channel_history_fts.sql',
  '0005_episode_rollover.sql',
  '0006_asset_enrichment.sql',
  '0007_agent_capabilities.sql',
  '0008_extension_runtime.sql',
  '0009_platform_identities.sql',
  '0010_adapter_runtime_state.sql',
  '0011_inbound_logical_message.sql',
  '0012_delivery_adapter_context.sql',
] as const

/** Opens an owned Core database with the durability and integrity settings shared by both Hosts. */
export function openCoreDatabase(filename: string): DatabaseSync {
  const database = new DatabaseSync(filename)
  database.exec('PRAGMA foreign_keys = ON')
  database.exec('PRAGMA journal_mode = WAL')
  return database
}

/** Applies every owned Core migration in order and rejects unknown future schemas. */
export async function migrateCoreDatabase(database: DatabaseSync): Promise<void> {
  const row = database.prepare('PRAGMA user_version').get() as { readonly user_version?: unknown }
  const current = row.user_version
  if (!Number.isSafeInteger(current) || typeof current !== 'number' || current < 0) {
    throw new Error('Core database reports an invalid schema version.')
  }
  if (current > CORE_SCHEMA_VERSION) {
    throw new Error(`Core database schema ${current} is newer than supported version ${CORE_SCHEMA_VERSION}.`)
  }
  for (let index = current; index < CORE_MIGRATION_FILES.length; index += 1) {
    const filename = CORE_MIGRATION_FILES[index]!
    const sql = await readFile(new URL(`../migrations/${filename}`, import.meta.url), 'utf8')
    database.exec('BEGIN IMMEDIATE')
    try {
      database.exec(sql)
      database.exec(`PRAGMA user_version = ${index + 1}`)
      database.exec('COMMIT')
    } catch (error) {
      try {
        database.exec('ROLLBACK')
      } catch {
        // Preserve the migration failure when SQLite also refuses rollback.
      }
      throw new Error(`Core migration ${filename} failed.`, { cause: error })
    }
  }
}

export async function openMigratedCoreDatabase(filename: string): Promise<DatabaseSync> {
  const database = openCoreDatabase(filename)
  try {
    await migrateCoreDatabase(database)
    return database
  } catch (error) {
    database.close()
    throw error
  }
}

type SqliteRow = Readonly<Record<string, unknown>>

const requiredString = (row: SqliteRow, key: string): string => {
  const value = row[key]
  if (typeof value !== 'string') throw new Error(`Core database column ${key} must be text.`)
  return value
}

const optionalString = (row: SqliteRow, key: string): string | undefined => {
  const value = row[key]
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`Core database column ${key} must be text or null.`)
  return value
}

const requiredInteger = (row: SqliteRow, key: string): number => {
  const value = row[key]
  if (!Number.isSafeInteger(value)) throw new Error(`Core database column ${key} must be a safe integer.`)
  return value as number
}

const optionalInteger = (row: SqliteRow, key: string): number | undefined => {
  const value = row[key]
  if (value === null || value === undefined) return undefined
  if (!Number.isSafeInteger(value)) throw new Error(`Core database column ${key} must be a safe integer or null.`)
  return value as number
}

const requiredNumber = (row: SqliteRow, key: string): number => {
  const value = row[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Core database column ${key} must be a finite number.`)
  }
  return value
}

const parseStoredJson = (value: string, label: string): JsonValue => {
  try {
    return parseJsonValue(JSON.parse(value))
  } catch (error) {
    throw new Error(`Core database ${label} contains invalid JSON.`, { cause: error })
  }
}

const requiredObject = (value: JsonValue, label: string): Readonly<Record<string, JsonValue>> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Core database ${label} must be an object.`)
  }
  return value
}

const objectString = (value: Readonly<Record<string, JsonValue>>, key: string, label: string): string => {
  const field = value[key]
  if (typeof field !== 'string') throw new Error(`Core database ${label}.${key} must be text.`)
  return field
}

const objectOptionalString = (
  value: Readonly<Record<string, JsonValue>>,
  key: string,
  label: string,
): string | undefined => {
  const field = value[key]
  if (field === undefined) return undefined
  if (typeof field !== 'string') throw new Error(`Core database ${label}.${key} must be text when present.`)
  return field
}

const objectInteger = (value: Readonly<Record<string, JsonValue>>, key: string, label: string): number => {
  const field = value[key]
  if (!Number.isSafeInteger(field)) throw new Error(`Core database ${label}.${key} must be a safe integer.`)
  return field as number
}

const parseCredentialRefs = (value: string): Readonly<Record<string, string>> => {
  const parsed = parseStoredJson(value, 'credential_refs_json')
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Core database credential_refs_json must be an object.')
  }
  for (const [key, reference] of Object.entries(parsed)) {
    if (key.length === 0 || typeof reference !== 'string' || reference.length === 0) {
      throw new Error('Core database credential_refs_json contains an invalid reference.')
    }
  }
  return parsed as Readonly<Record<string, string>>
}

const searchableMessageParts = (parts: readonly MessagePart[]): string =>
  parts
    .map((part) => {
      switch (part.type) {
        case 'text':
          return part.text
        case 'mention':
          return part.memberId
        case 'image':
          return `${part.alt ?? ''} ${part.assetId}`
        case 'file':
          return `${part.name ?? ''} ${part.assetId}`
        case 'audio':
          return part.assetId
        case 'quote':
          return part.messageId
      }
    })
    .join(' ')

const historyLimit = (value: number | undefined): number => {
  const limit = value ?? 50
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError('Channel history limit must be an integer between 1 and 100.')
  }
  return limit
}

const withTransaction = <T>(database: DatabaseSync, operation: () => T): T => {
  database.exec('BEGIN IMMEDIATE')
  try {
    const result = operation()
    database.exec('COMMIT')
    return result
  } catch (error) {
    try {
      database.exec('ROLLBACK')
    } catch {
      // Preserve the original commit failure.
    }
    throw error
  }
}

/** Raw node:sqlite implementation of the Core domain commit boundary. */
export class SqliteCoreRepository
  implements
    CoreRepository,
    RuntimeRepository,
    AssetRepository,
    AssetEnrichmentRepository,
    ChannelHistoryRepository,
    ExtensionRepository,
    AdapterRuntimeStateStore
{
  readonly #database: DatabaseSync

  constructor(database: DatabaseSync) {
    this.#database = database
  }

  createAgent(commit: CreateAgentCommit): void {
    withTransaction(this.#database, () => {
      this.#database
        .prepare('INSERT INTO agent_definitions (id, current_revision_id, created_at) VALUES (?, ?, ?)')
        .run(commit.definition.id, commit.definition.currentRevisionId, commit.definition.createdAt)
      this.#insertAgentRevision(commit.revision)
    })
  }

  getAgent(id: AgentId): CreateAgentCommit | undefined {
    const row = this.#database
      .prepare(
        `SELECT d.id AS definition_id, d.current_revision_id, d.created_at AS definition_created_at,
                r.id AS revision_id, r.agent_id, r.revision, r.display_name, r.persona,
                r.model_provider, r.model_id, r.reasoning_effort, r.capabilities_json, r.settings_json,
                r.content_digest, r.created_at AS revision_created_at
           FROM agent_definitions d
           JOIN agent_revisions r ON r.id = d.current_revision_id
          WHERE d.id = ?`,
      )
      .get(id) as SqliteRow | undefined
    if (!row) return undefined
    const definition: AgentDefinitionRecord = {
      id: requiredString(row, 'definition_id') as AgentId,
      currentRevisionId: requiredString(row, 'current_revision_id') as AgentRevisionId,
      createdAt: requiredInteger(row, 'definition_created_at'),
    }
    const settings = optionalString(row, 'settings_json')
    const reasoningEffort = optionalString(row, 'reasoning_effort')
    const revision: AgentRevisionRecord = {
      id: requiredString(row, 'revision_id') as AgentRevisionId,
      agentId: requiredString(row, 'agent_id') as AgentId,
      revision: requiredInteger(row, 'revision'),
      displayName: requiredString(row, 'display_name'),
      persona: requiredString(row, 'persona'),
      model: {
        provider: requiredString(row, 'model_provider'),
        model: requiredString(row, 'model_id'),
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      },
      capabilities: parseAgentCapabilityGrants(
        parseStoredJson(requiredString(row, 'capabilities_json'), 'capabilities_json'),
      ),
      ...(settings === undefined ? {} : { settings: parseStoredJson(settings, 'settings_json') }),
      contentDigest: requiredString(row, 'content_digest'),
      createdAt: requiredInteger(row, 'revision_created_at'),
    }
    return { definition, revision }
  }

  getAgentRevision(id: AgentRevisionId): AgentRevisionRecord | undefined {
    const row = this.#database.prepare('SELECT * FROM agent_revisions WHERE id = ?').get(id) as SqliteRow | undefined
    return row ? this.#agentRevision(row) : undefined
  }

  appendAgentRevision(
    definition: AgentDefinitionRecord,
    revision: AgentRevisionRecord,
    expectedCurrentRevisionId: AgentRevisionId,
  ): void {
    withTransaction(this.#database, () => {
      this.#insertAgentRevision(revision)
      const result = this.#database
        .prepare('UPDATE agent_definitions SET current_revision_id = ? WHERE id = ? AND current_revision_id = ?')
        .run(definition.currentRevisionId, definition.id, expectedCurrentRevisionId)
      if (result.changes !== 1) throw new Error(`Agent revision conflict: expected ${expectedCurrentRevisionId}.`)
    })
  }

  createConnection(record: ConnectionRecord): void {
    this.#database
      .prepare(
        `INSERT INTO connections
          (id, adapter_key, config_json, credential_refs_json, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.adapterKey,
        JSON.stringify(record.config),
        JSON.stringify(record.credentialRefs),
        record.status,
        record.createdAt,
      )
  }

  getConnection(id: ConnectionId): ConnectionRecord | undefined {
    const row = this.#database.prepare('SELECT * FROM connections WHERE id = ?').get(id) as SqliteRow | undefined
    if (!row) return undefined
    const status = requiredString(row, 'status')
    if (!['configured', 'active', 'stopped', 'failed'].includes(status)) {
      throw new Error(`Core database contains unknown connection status: ${status}`)
    }
    return {
      id: requiredString(row, 'id') as ConnectionId,
      adapterKey: requiredString(row, 'adapter_key'),
      config: parseStoredJson(requiredString(row, 'config_json'), 'config_json'),
      credentialRefs: parseCredentialRefs(requiredString(row, 'credential_refs_json')),
      status: status as ConnectionRecord['status'],
      createdAt: requiredInteger(row, 'created_at'),
    }
  }

  createChannel(record: ChannelRecord): void {
    this.#database
      .prepare(
        `INSERT INTO channels
          (id, connection_id, platform_channel_id, kind, display_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.connectionId,
        record.platformChannelId,
        record.kind,
        record.displayName ?? null,
        record.createdAt,
      )
  }

  ensureChannel(record: ChannelRecord): ChannelRecord {
    this.#database
      .prepare(
        `INSERT INTO channels
          (id, connection_id, platform_channel_id, kind, display_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(connection_id, platform_channel_id) DO UPDATE SET
           display_name = COALESCE(excluded.display_name, channels.display_name)`,
      )
      .run(
        record.id,
        record.connectionId,
        record.platformChannelId,
        record.kind,
        record.displayName ?? null,
        record.createdAt,
      )
    const stored = this.getChannelByPlatformId(record.connectionId, record.platformChannelId)
    if (!stored) throw new Error('Core database failed to ensure Channel.')
    if (stored.kind !== record.kind) {
      throw new Error(`Platform Channel kind conflict: ${record.platformChannelId}.`)
    }
    return stored
  }

  getChannel(id: ChannelId): ChannelRecord | undefined {
    const row = this.#database.prepare('SELECT * FROM channels WHERE id = ?').get(id) as SqliteRow | undefined
    return row ? this.#channel(row) : undefined
  }

  #channel(row: SqliteRow): ChannelRecord {
    const kind = requiredString(row, 'kind')
    if (!['web', 'direct', 'group'].includes(kind))
      throw new Error(`Core database contains unknown channel kind: ${kind}`)
    const displayName = optionalString(row, 'display_name')
    return {
      id: requiredString(row, 'id') as ChannelId,
      connectionId: requiredString(row, 'connection_id') as ConnectionId,
      platformChannelId: requiredString(row, 'platform_channel_id'),
      kind: kind as ChannelRecord['kind'],
      ...(displayName === undefined ? {} : { displayName }),
      createdAt: requiredInteger(row, 'created_at'),
    }
  }

  getChannelByPlatformId(connectionId: ConnectionId, platformChannelId: string): ChannelRecord | undefined {
    const row = this.#database
      .prepare('SELECT * FROM channels WHERE connection_id = ? AND platform_channel_id = ?')
      .get(connectionId, platformChannelId) as SqliteRow | undefined
    return row ? this.#channel(row) : undefined
  }

  listChannelIdsByConnection(connectionId: ConnectionId): readonly ChannelId[] {
    const rows = this.#database
      .prepare('SELECT id FROM channels WHERE connection_id = ? ORDER BY created_at, id')
      .all(connectionId) as SqliteRow[]
    return rows.map((row) => requiredString(row, 'id') as ChannelId)
  }

  ensurePlatformIdentity(record: PlatformIdentityRecord): PlatformIdentityRecord {
    this.#database
      .prepare(
        `INSERT INTO platform_identities
          (id, connection_id, platform_user_id, display_name, first_seen_at, last_seen_at, seen_count)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(connection_id, platform_user_id) DO UPDATE SET
           display_name = COALESCE(excluded.display_name, platform_identities.display_name),
           last_seen_at = MAX(platform_identities.last_seen_at, excluded.last_seen_at),
           seen_count = platform_identities.seen_count + 1`,
      )
      .run(
        record.id,
        record.connectionId,
        record.platformUserId,
        record.displayName ?? null,
        record.firstSeenAt,
        record.lastSeenAt,
        record.seenCount,
      )
    const row = this.#database
      .prepare('SELECT * FROM platform_identities WHERE connection_id = ? AND platform_user_id = ?')
      .get(record.connectionId, record.platformUserId) as SqliteRow | undefined
    if (!row) throw new Error('Core database failed to ensure PlatformIdentity.')
    return this.#platformIdentity(row)
  }

  getPlatformIdentity(id: PlatformIdentityId): PlatformIdentityRecord | undefined {
    const row = this.#database.prepare('SELECT * FROM platform_identities WHERE id = ?').get(id) as
      SqliteRow | undefined
    return row ? this.#platformIdentity(row) : undefined
  }

  ensureChannelMember(record: ChannelMemberRecord): ChannelMemberRecord {
    this.#database
      .prepare(
        `INSERT INTO channel_members
          (id, channel_id, platform_identity_id, display_name, first_seen_at, last_seen_at, seen_count)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(channel_id, platform_identity_id) DO UPDATE SET
           display_name = COALESCE(excluded.display_name, channel_members.display_name),
           last_seen_at = MAX(channel_members.last_seen_at, excluded.last_seen_at),
           seen_count = channel_members.seen_count + 1`,
      )
      .run(
        record.id,
        record.channelId,
        record.platformIdentityId,
        record.displayName ?? null,
        record.firstSeenAt,
        record.lastSeenAt,
        record.seenCount,
      )
    const stored = this.getChannelMemberByIdentity(record.channelId, record.platformIdentityId)
    if (!stored) throw new Error('Core database failed to ensure ChannelMember.')
    return stored
  }

  getChannelMember(id: ChannelMemberId): ChannelMemberRecord | undefined {
    const row = this.#database.prepare('SELECT * FROM channel_members WHERE id = ?').get(id) as SqliteRow | undefined
    return row ? this.#channelMember(row) : undefined
  }

  getChannelMemberByIdentity(
    channelId: ChannelId,
    platformIdentityId: PlatformIdentityId,
  ): ChannelMemberRecord | undefined {
    const row = this.#database
      .prepare('SELECT * FROM channel_members WHERE channel_id = ? AND platform_identity_id = ?')
      .get(channelId, platformIdentityId) as SqliteRow | undefined
    return row ? this.#channelMember(row) : undefined
  }

  createBinding(record: BindingRecord): void {
    this.#database
      .prepare(
        `INSERT INTO bindings (id, channel_id, agent_id, trigger_policy, revision, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(record.id, record.channelId, record.agentId, record.triggerPolicy, record.revision, record.createdAt)
  }

  getBinding(channelId: ChannelId, agentId: AgentId): BindingRecord | undefined {
    const row = this.#database
      .prepare('SELECT * FROM bindings WHERE channel_id = ? AND agent_id = ?')
      .get(channelId, agentId) as SqliteRow | undefined
    if (!row) return undefined
    return this.#binding(row)
  }

  listBindings(channelId: ChannelId): readonly BindingRecord[] {
    const rows = this.#database
      .prepare('SELECT * FROM bindings WHERE channel_id = ? ORDER BY created_at, id')
      .all(channelId) as SqliteRow[]
    return rows.map((row) => this.#binding(row))
  }

  appendChannelEvent(candidate: ChannelEventRecord): AppendChannelEventCommit {
    return withTransaction(this.#database, () => {
      const existing = this.#database
        .prepare('SELECT * FROM channel_events WHERE connection_id = ? AND dedupe_key = ?')
        .get(candidate.connectionId, candidate.dedupeKey) as SqliteRow | undefined
      if (existing) {
        return { event: this.#channelEvent(existing), inserted: false, checkpointCommitted: true }
      }

      this.#database
        .prepare(
          `INSERT INTO channel_events
            (id, logical_message_id, connection_id, channel_id, adapter_key, platform_event_id, platform_message_id,
             kind, sender_member_id, parts_json, platform_sequence, platform_timestamp,
             received_at, dedupe_key, facts_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          candidate.id,
          candidate.logicalMessageId,
          candidate.connectionId,
          candidate.channelId,
          candidate.adapterKey,
          candidate.platformEventId ?? null,
          candidate.platformMessageId ?? null,
          candidate.kind,
          candidate.senderMemberId ?? null,
          JSON.stringify(candidate.parts),
          candidate.platformSequence ?? null,
          candidate.platformTimestamp,
          candidate.receivedAt,
          candidate.dedupeKey,
          candidate.facts === undefined ? null : JSON.stringify(candidate.facts),
          candidate.receivedAt,
        )

      this.#database
        .prepare(
          `INSERT INTO channel_history_fts (source_id, source_kind, channel_id, content)
           VALUES (?, 'channel-event', ?, ?)`,
        )
        .run(candidate.id, candidate.channelId, searchableMessageParts(candidate.parts))

      if (candidate.checkpoint !== undefined) {
        this.#database
          .prepare(
            `INSERT INTO adapter_checkpoints (connection_id, checkpoint_json, channel_event_id, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(connection_id) DO UPDATE SET
               checkpoint_json = excluded.checkpoint_json,
               channel_event_id = excluded.channel_event_id,
               updated_at = excluded.updated_at`,
          )
          .run(candidate.connectionId, JSON.stringify(candidate.checkpoint), candidate.id, candidate.receivedAt)
      }
      return { event: candidate, inserted: true, checkpointCommitted: true }
    })
  }

  getChannelEvent(id: ChannelEventId): ChannelEventRecord | undefined {
    const row = this.#database.prepare('SELECT * FROM channel_events WHERE id = ?').get(id) as SqliteRow | undefined
    return row ? this.#channelEvent(row) : undefined
  }

  resolvePlatformMessage(
    connectionId: ConnectionId,
    channelId: ChannelId,
    platformMessageId: string,
  ): PlatformMessageReferenceRecord | undefined {
    const inbound = this.#database
      .prepare(
        `SELECT logical_message_id
           FROM channel_events
          WHERE connection_id = ? AND channel_id = ? AND platform_message_id = ?
          ORDER BY created_at DESC, id DESC
          LIMIT 1`,
      )
      .get(connectionId, channelId, platformMessageId) as SqliteRow | undefined
    if (inbound) {
      return {
        logicalMessageId: requiredString(inbound, 'logical_message_id') as LogicalMessageId,
        authoredByAgent: false,
      }
    }
    const outbound = this.#database
      .prepare(
        `SELECT i.logical_message_id
           FROM delivery_receipts r
           JOIN physical_deliveries d ON d.id = r.physical_delivery_id
           JOIN outbound_intents i ON i.id = d.intent_id
           JOIN channels c ON c.id = i.channel_id
          WHERE c.connection_id = ? AND i.channel_id = ?
            AND json_extract(r.receipt_json, '$.status') = 'sent'
            AND json_extract(r.receipt_json, '$.platformMessageId') = ?
          ORDER BY r.created_at DESC, r.id DESC
          LIMIT 1`,
      )
      .get(connectionId, channelId, platformMessageId) as SqliteRow | undefined
    return outbound
      ? {
          logicalMessageId: requiredString(outbound, 'logical_message_id') as LogicalMessageId,
          authoredByAgent: true,
        }
      : undefined
  }

  resolveLogicalMessagePlatformId(
    connectionId: ConnectionId,
    channelId: ChannelId,
    logicalMessageId: LogicalMessageId,
  ): string | undefined {
    const inbound = this.#database
      .prepare(
        `SELECT platform_message_id
           FROM channel_events
          WHERE connection_id = ? AND channel_id = ? AND logical_message_id = ?
            AND platform_message_id IS NOT NULL
          LIMIT 1`,
      )
      .get(connectionId, channelId, logicalMessageId) as SqliteRow | undefined
    if (inbound) return requiredString(inbound, 'platform_message_id')
    const outbound = this.#database
      .prepare(
        `SELECT json_extract(r.receipt_json, '$.platformMessageId') AS platform_message_id
           FROM delivery_receipts r
           JOIN physical_deliveries d ON d.id = r.physical_delivery_id
           JOIN outbound_intents i ON i.id = d.intent_id
           JOIN channels c ON c.id = i.channel_id
          WHERE c.connection_id = ? AND i.channel_id = ? AND i.logical_message_id = ?
            AND json_extract(r.receipt_json, '$.status') = 'sent'
          ORDER BY r.created_at DESC, r.id DESC
          LIMIT 1`,
      )
      .get(connectionId, channelId, logicalMessageId) as SqliteRow | undefined
    return outbound ? requiredString(outbound, 'platform_message_id') : undefined
  }

  load(connectionId: ConnectionId, key: string): Promise<JsonValue | undefined> {
    const row = this.#database
      .prepare('SELECT state_json FROM adapter_runtime_states WHERE connection_id = ? AND state_key = ?')
      .get(connectionId, key) as SqliteRow | undefined
    return Promise.resolve(
      row ? parseStoredJson(requiredString(row, 'state_json'), 'adapter_runtime_states.state_json') : undefined,
    )
  }

  save(connectionId: ConnectionId, key: string, value: JsonValue, updatedAt: number): Promise<void> {
    if (!key.trim()) return Promise.reject(new TypeError('Adapter runtime state key must not be empty.'))
    if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) {
      return Promise.reject(new TypeError('Adapter runtime state updatedAt must be non-negative.'))
    }
    this.#database
      .prepare(
        `INSERT INTO adapter_runtime_states (connection_id, state_key, state_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(connection_id, state_key) DO UPDATE SET
           state_json = excluded.state_json,
           updated_at = excluded.updated_at`,
      )
      .run(connectionId, key, JSON.stringify(value), updatedAt)
    return Promise.resolve()
  }

  clear(connectionId: ConnectionId, key: string): Promise<void> {
    this.#database
      .prepare('DELETE FROM adapter_runtime_states WHERE connection_id = ? AND state_key = ?')
      .run(connectionId, key)
    return Promise.resolve()
  }

  getEpisode(id: EpisodeId): EpisodeRecord | undefined {
    const row = this.#database.prepare('SELECT * FROM episodes WHERE id = ?').get(id) as SqliteRow | undefined
    return row ? this.#episode(row) : undefined
  }

  getActiveEpisode(channelId: ChannelId, agentId: AgentId): EpisodeRecord | undefined {
    const row = this.#database
      .prepare("SELECT * FROM episodes WHERE channel_id = ? AND agent_id = ? AND status = 'active'")
      .get(channelId, agentId) as SqliteRow | undefined
    return row ? this.#episode(row) : undefined
  }

  listRecoverableEpisodes(): readonly EpisodeRecord[] {
    const rows = this.#database
      .prepare("SELECT * FROM episodes WHERE status IN ('opening', 'active') ORDER BY created_at, id")
      .all() as SqliteRow[]
    return rows.map((row) => this.#episode(row))
  }

  listActiveEpisodesForAgent(agentId: AgentId): readonly EpisodeRecord[] {
    return (
      this.#database
        .prepare("SELECT * FROM episodes WHERE agent_id = ? AND status = 'active' ORDER BY created_at, id")
        .all(agentId) as SqliteRow[]
    ).map((row) => this.#episode(row))
  }

  getEpisodeHandoffTo(episodeId: EpisodeId): EpisodeHandoffRecord | undefined {
    const row = this.#database.prepare('SELECT * FROM episode_handoffs WHERE to_episode_id = ?').get(episodeId) as
      SqliteRow | undefined
    if (!row) return undefined
    const sourceEventIds = parseStoredJson(requiredString(row, 'source_event_ids_json'), 'source_event_ids_json')
    if (!Array.isArray(sourceEventIds) || sourceEventIds.some((id) => typeof id !== 'string')) {
      throw new Error('Core database handoff source_event_ids_json must be a string array.')
    }
    return {
      id: requiredString(row, 'id') as EpisodeHandoffId,
      fromEpisodeId: requiredString(row, 'from_episode_id') as EpisodeId,
      toEpisodeId: requiredString(row, 'to_episode_id') as EpisodeId,
      sourceEventIds: sourceEventIds as ChannelEventId[],
      summary: requiredString(row, 'summary'),
      provider: requiredString(row, 'provider'),
      model: requiredString(row, 'model'),
      createdAt: requiredInteger(row, 'created_at'),
    }
  }

  createEpisode(record: EpisodeRecord): void {
    this.#database
      .prepare(
        `INSERT INTO episodes
          (id, channel_id, agent_id, agent_revision_id, binding_id, binding_revision,
           dsh_session_id, status, opened_at_event_id, last_admitted_event_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.channelId,
        record.agentId,
        record.agentRevisionId,
        record.bindingId,
        record.bindingRevision,
        record.dshSessionId ?? null,
        record.status,
        record.openedAtEventId,
        record.lastAdmittedEventId ?? null,
        record.createdAt,
      )
  }

  activateEpisode(id: EpisodeId, dshSessionId: string): EpisodeRecord {
    const result = this.#database
      .prepare("UPDATE episodes SET status = 'active', dsh_session_id = ? WHERE id = ? AND status = 'opening'")
      .run(dshSessionId, id)
    if (result.changes !== 1) throw new Error(`Episode cannot activate from its current state: ${id}`)
    return this.getEpisode(id)!
  }

  updateEpisodeRevision(
    id: EpisodeId,
    expectedRevisionId: AgentRevisionId,
    targetRevisionId: AgentRevisionId,
  ): EpisodeRecord {
    const result = this.#database
      .prepare("UPDATE episodes SET agent_revision_id = ? WHERE id = ? AND agent_revision_id = ? AND status = 'active'")
      .run(targetRevisionId, id, expectedRevisionId)
    if (result.changes !== 1) throw new Error(`Episode revision update conflicted: ${id}`)
    return this.getEpisode(id)!
  }

  beginEpisodeRollover(id: EpisodeId): EpisodeRecord {
    const result = this.#database
      .prepare("UPDATE episodes SET status = 'rolling-over' WHERE id = ? AND status = 'active'")
      .run(id)
    if (result.changes !== 1) throw new Error(`Episode cannot begin rollover from its current state: ${id}`)
    return this.getEpisode(id)!
  }

  cancelEpisodeRollover(id: EpisodeId): EpisodeRecord {
    const result = this.#database
      .prepare("UPDATE episodes SET status = 'active' WHERE id = ? AND status = 'rolling-over'")
      .run(id)
    if (result.changes !== 1) throw new Error(`Episode cannot cancel rollover from its current state: ${id}`)
    return this.getEpisode(id)!
  }

  closeEpisode(
    id: EpisodeId,
    reason: EpisodeCloseReason,
    closedAtEventId: ChannelEventId,
    closedAt: number,
  ): EpisodeRecord {
    const result = this.#database
      .prepare(
        `UPDATE episodes
            SET status = 'closed', closed_at_event_id = ?, closed_at = ?, close_reason = ?
          WHERE id = ? AND status IN ('active', 'rolling-over')`,
      )
      .run(closedAtEventId, closedAt, reason, id)
    if (result.changes !== 1) throw new Error(`Episode cannot close from its current state: ${id}`)
    return this.getEpisode(id)!
  }

  commitEpisodeRollover(input: {
    readonly fromEpisodeId: EpisodeId
    readonly reason: EpisodeCloseReason
    readonly closedAtEventId: ChannelEventId
    readonly closedAt: number
    readonly nextEpisode: EpisodeRecord
    readonly handoff: EpisodeHandoffRecord
  }): void {
    withTransaction(this.#database, () => {
      const closed = this.#database
        .prepare(
          `UPDATE episodes
              SET status = 'closed', closed_at_event_id = ?, closed_at = ?, close_reason = ?
            WHERE id = ? AND status = 'rolling-over'`,
        )
        .run(input.closedAtEventId, input.closedAt, input.reason, input.fromEpisodeId)
      if (closed.changes !== 1) throw new Error(`Episode rollover commit conflicted: ${input.fromEpisodeId}`)
      const next = input.nextEpisode
      this.#database
        .prepare(
          `INSERT INTO episodes
            (id, channel_id, agent_id, agent_revision_id, binding_id, binding_revision,
             dsh_session_id, status, opened_at_event_id, last_admitted_event_id,
             closed_at_event_id, closed_at, close_reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          next.id,
          next.channelId,
          next.agentId,
          next.agentRevisionId,
          next.bindingId,
          next.bindingRevision,
          next.dshSessionId ?? null,
          next.status,
          next.openedAtEventId,
          next.lastAdmittedEventId ?? null,
          next.closedAtEventId ?? null,
          next.closedAt ?? null,
          next.closeReason ?? null,
          next.createdAt,
        )
      const handoff = input.handoff
      this.#database
        .prepare(
          `INSERT INTO episode_handoffs
            (id, from_episode_id, to_episode_id, source_event_ids_json, summary, provider, model, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          handoff.id,
          handoff.fromEpisodeId,
          handoff.toEpisodeId,
          JSON.stringify(handoff.sourceEventIds),
          handoff.summary,
          handoff.provider,
          handoff.model,
          handoff.createdAt,
        )
    })
  }

  failEpisode(id: EpisodeId): void {
    const result = this.#database
      .prepare("UPDATE episodes SET status = 'failed' WHERE id = ? AND status = 'opening'")
      .run(id)
    if (result.changes !== 1) throw new Error(`Episode cannot fail from its current state: ${id}`)
  }

  createAdmission(record: AdmissionRecord): void {
    this.#database
      .prepare(
        `INSERT INTO admissions
          (id, episode_id, channel_event_ids_json, reason, state, dsh_message_id,
           created_at, claimed_at, logged_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.episodeId,
        JSON.stringify(record.channelEventIds),
        record.reason,
        record.state,
        record.dshMessageId ?? null,
        record.createdAt,
        record.claimedAt ?? null,
        record.loggedAt ?? null,
      )
  }

  listRecoverableAdmissions(episodeId: EpisodeId): readonly AdmissionRecord[] {
    const rows = this.#database
      .prepare(
        "SELECT * FROM admissions WHERE episode_id = ? AND state IN ('pending', 'claimed') ORDER BY created_at, id",
      )
      .all(episodeId) as SqliteRow[]
    return rows.map((row) => this.#admission(row))
  }

  claimAdmission(id: AdmissionId, claimedAt: number): void {
    const result = this.#database
      .prepare("UPDATE admissions SET state = 'claimed', claimed_at = ? WHERE id = ? AND state = 'pending'")
      .run(claimedAt, id)
    if (result.changes !== 1) throw new Error(`Admission cannot be claimed from its current state: ${id}`)
  }

  completeAdmission(id: AdmissionId, dshMessageId: string, eventId: ChannelEventId, loggedAt: number): void {
    withTransaction(this.#database, () => {
      const row = this.#database.prepare('SELECT episode_id FROM admissions WHERE id = ?').get(id) as
        SqliteRow | undefined
      if (!row) throw new Error(`Unknown Admission: ${id}`)
      const result = this.#database
        .prepare(
          `UPDATE admissions
              SET state = 'logged-to-session', dsh_message_id = ?, logged_at = ?
            WHERE id = ? AND state = 'claimed'`,
        )
        .run(dshMessageId, loggedAt, id)
      if (result.changes !== 1) throw new Error(`Admission cannot complete from its current state: ${id}`)
      this.#database
        .prepare("UPDATE episodes SET last_admitted_event_id = ? WHERE id = ? AND status = 'active'")
        .run(eventId, requiredString(row, 'episode_id'))
    })
  }

  findOutboundByClientRequest(
    agentId: AgentId,
    channelId: ChannelId,
    clientRequestId: string,
  ): OutboundSnapshot | undefined {
    const row = this.#database
      .prepare('SELECT id FROM outbound_intents WHERE agent_id = ? AND channel_id = ? AND client_request_id = ?')
      .get(agentId, channelId, clientRequestId) as SqliteRow | undefined
    return row ? this.getOutbound(requiredString(row, 'id') as OutboundIntentId) : undefined
  }

  createOutboundPlan(intent: OutboundIntentRecord, deliveries: readonly PhysicalDeliveryRecord[]): void {
    if (deliveries.length === 0) throw new Error('Outbound plan requires at least one PhysicalDelivery.')
    withTransaction(this.#database, () => {
      this.#database
        .prepare(
          `INSERT INTO outbound_intents
            (id, logical_message_id, agent_id, agent_revision_id, episode_id, source_turn_id,
             channel_id, parts_json, reply_to, client_request_id, state, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          intent.id,
          intent.logicalMessageId,
          intent.agentId,
          intent.agentRevisionId,
          intent.episodeId,
          intent.sourceTurnId ?? null,
          intent.channelId,
          JSON.stringify(intent.parts),
          intent.replyTo ?? null,
          intent.clientRequestId ?? null,
          intent.state,
          intent.createdAt,
        )
      this.#database
        .prepare(
          `INSERT INTO channel_history_fts (source_id, source_kind, channel_id, content)
           VALUES (?, 'outbound-intent', ?, ?)`,
        )
        .run(intent.id, intent.channelId, searchableMessageParts(intent.parts))
      const insert = this.#database.prepare(
        `INSERT INTO physical_deliveries
          (id, intent_id, sequence, parts_json, adapter_context_json, state, attempt_count)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      for (const delivery of deliveries) {
        insert.run(
          delivery.id,
          delivery.intentId,
          delivery.sequence,
          JSON.stringify(delivery.parts),
          delivery.adapterContext === undefined ? null : JSON.stringify(delivery.adapterContext),
          delivery.state,
          delivery.attemptCount,
        )
      }
    })
  }

  markIntentSending(id: OutboundIntentId): void {
    const result = this.#database
      .prepare("UPDATE outbound_intents SET state = 'sending' WHERE id = ? AND state = 'planned'")
      .run(id)
    if (result.changes !== 1) throw new Error(`Outbound intent cannot start from its current state: ${id}`)
  }

  markDeliverySending(id: PhysicalDeliveryId, attempt: number): void {
    const result = this.#database
      .prepare("UPDATE physical_deliveries SET state = 'sending', attempt_count = ? WHERE id = ? AND state = 'planned'")
      .run(attempt, id)
    if (result.changes !== 1) throw new Error(`Physical delivery cannot start from its current state: ${id}`)
  }

  recordDeliveryReceipt(record: DeliveryReceiptRecord): void {
    withTransaction(this.#database, () => {
      this.#database
        .prepare(
          `INSERT INTO delivery_receipts
            (id, physical_delivery_id, attempt, receipt_json, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(record.id, record.physicalDeliveryId, record.attempt, JSON.stringify(record.receipt), record.createdAt)
      const result = this.#database
        .prepare("UPDATE physical_deliveries SET state = ? WHERE id = ? AND state = 'sending'")
        .run(record.receipt.status, record.physicalDeliveryId)
      if (result.changes !== 1)
        throw new Error(`Physical delivery cannot receive a result: ${record.physicalDeliveryId}`)
    })
  }

  completeOutboundIntent(id: OutboundIntentId, state: OutboundState): void {
    if (!['sent', 'partially-sent', 'failed', 'unknown'].includes(state)) {
      throw new Error(`Outbound completion requires a settled state: ${state}`)
    }
    const result = this.#database
      .prepare("UPDATE outbound_intents SET state = ? WHERE id = ? AND state = 'sending'")
      .run(state, id)
    if (result.changes !== 1) throw new Error(`Outbound intent cannot complete from its current state: ${id}`)
  }

  getOutbound(id: OutboundIntentId): OutboundSnapshot {
    const intentRow = this.#database.prepare('SELECT * FROM outbound_intents WHERE id = ?').get(id) as
      SqliteRow | undefined
    if (!intentRow) throw new Error(`Unknown outbound intent: ${id}`)
    const deliveryRows = this.#database
      .prepare('SELECT * FROM physical_deliveries WHERE intent_id = ? ORDER BY sequence')
      .all(id) as SqliteRow[]
    const receiptRows = this.#database
      .prepare(
        `SELECT r.*
           FROM delivery_receipts r
           JOIN physical_deliveries d ON d.id = r.physical_delivery_id
          WHERE d.intent_id = ?
          ORDER BY d.sequence, r.attempt`,
      )
      .all(id) as SqliteRow[]
    return {
      intent: this.#outboundIntent(intentRow),
      deliveries: deliveryRows.map((row) => this.#physicalDelivery(row)),
      receipts: receiptRows.map((row) => this.#deliveryReceipt(row)),
    }
  }

  listUnsettledOutboundIds(): readonly OutboundIntentId[] {
    const rows = this.#database
      .prepare("SELECT id FROM outbound_intents WHERE state IN ('planned', 'sending') ORDER BY created_at, id")
      .all() as SqliteRow[]
    return rows.map((row) => requiredString(row, 'id') as OutboundIntentId)
  }

  listChannelHistory(
    channelId: ChannelId,
    options: {
      readonly before?: { readonly occurredAt: number; readonly sourceId: string }
      readonly limit?: number
    } = {},
  ): readonly ChannelHistoryEntry[] {
    const limit = historyLimit(options.limit)
    if (options.before !== undefined) {
      if (!Number.isSafeInteger(options.before.occurredAt) || options.before.occurredAt < 0) {
        throw new TypeError('Channel history cursor occurredAt must be a non-negative integer.')
      }
      if (options.before.sourceId.length === 0)
        throw new TypeError('Channel history cursor sourceId must not be empty.')
    }
    const union = `
      SELECT 'channel-event' AS source, id AS source_id, channel_id, received_at AS occurred_at,
             parts_json, NULL AS logical_message_id, NULL AS state
        FROM channel_events
       WHERE channel_id = ?
      UNION ALL
      SELECT 'outbound-intent' AS source, id AS source_id, channel_id, created_at AS occurred_at,
             parts_json, logical_message_id, state
        FROM outbound_intents
       WHERE channel_id = ?`
    const rows = options.before
      ? (this.#database
          .prepare(
            `SELECT * FROM (${union})
              WHERE occurred_at < ? OR (occurred_at = ? AND source_id < ?)
              ORDER BY occurred_at DESC, source_id DESC
              LIMIT ?`,
          )
          .all(
            channelId,
            channelId,
            options.before.occurredAt,
            options.before.occurredAt,
            options.before.sourceId,
            limit,
          ) as SqliteRow[])
      : (this.#database
          .prepare(`SELECT * FROM (${union}) ORDER BY occurred_at DESC, source_id DESC LIMIT ?`)
          .all(channelId, channelId, limit) as SqliteRow[])
    return rows.map((row) => this.#historyEntry(row))
  }

  searchChannelHistory(
    channelId: ChannelId,
    query: string,
    options: { readonly limit?: number } = {},
  ): readonly ChannelHistorySearchHit[] {
    const normalized = query.trim()
    if (normalized.length === 0) throw new TypeError('Channel history search query must not be empty.')
    if ([...normalized].length > 500) throw new TypeError('Channel history search query is too long.')
    const limit = historyLimit(options.limit)
    const select = `
      SELECT f.source_kind AS source, f.source_id, f.channel_id,
             coalesce(e.received_at, o.created_at) AS occurred_at,
             coalesce(e.parts_json, o.parts_json) AS parts_json,
             o.logical_message_id, o.state`
    const joins = `
        FROM channel_history_fts f
        LEFT JOIN channel_events e ON f.source_kind = 'channel-event' AND e.id = f.source_id
        LEFT JOIN outbound_intents o ON f.source_kind = 'outbound-intent' AND o.id = f.source_id`
    let rows: SqliteRow[]
    if ([...normalized].length >= 3) {
      const literal = `"${normalized.replaceAll('"', '""')}"`
      rows = this.#database
        .prepare(
          `${select}, bm25(channel_history_fts) AS rank
           ${joins}
           WHERE channel_history_fts MATCH ? AND f.channel_id = ?
           ORDER BY rank, occurred_at DESC
           LIMIT ?`,
        )
        .all(literal, channelId, limit)
    } else {
      const escaped = normalized.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
      rows = this.#database
        .prepare(
          `${select}, 0.0 AS rank
           ${joins}
           WHERE f.channel_id = ? AND f.content LIKE ? ESCAPE '\\'
           ORDER BY occurred_at DESC
           LIMIT ?`,
        )
        .all(channelId, `%${escaped}%`, limit)
    }
    return rows.map((row) => ({ entry: this.#historyEntry(row), rank: requiredNumber(row, 'rank') }))
  }

  beginAssetOperation(operation: AssetOperationRecord): void {
    if (operation.state !== 'running') throw new Error('A new Asset operation must be running.')
    this.#database
      .prepare(
        `INSERT INTO asset_operations
          (id, state, staging_relative_path, blob_relative_path, candidate_json,
           occurrence_json, created_at, completed_at, error_summary)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        operation.id,
        operation.state,
        operation.stagingRelativePath,
        operation.blobRelativePath,
        JSON.stringify(operation.candidate),
        JSON.stringify(operation.occurrence),
        operation.createdAt,
        null,
        null,
      )
  }

  reserveAsset(candidate: AssetRecord): AssetRecord {
    return withTransaction(this.#database, () => {
      this.#database
        .prepare(
          `INSERT OR IGNORE INTO assets
            (id, content_digest, byte_size, media_type, blob_state, first_received_at,
             last_received_at, receive_count, last_accessed_at, storage_format_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          candidate.id,
          candidate.contentDigest,
          candidate.byteSize,
          candidate.mediaType,
          candidate.blobState,
          candidate.firstReceivedAt,
          candidate.lastReceivedAt,
          candidate.receiveCount,
          candidate.lastAccessedAt ?? null,
          candidate.storageFormatVersion,
        )
      const row = this.#database
        .prepare('SELECT * FROM assets WHERE content_digest = ?')
        .get(candidate.contentDigest) as SqliteRow | undefined
      if (!row) throw new Error('Core database failed to reserve Asset.')
      const asset = this.#asset(row)
      if (asset.byteSize !== candidate.byteSize) {
        throw new Error(`Asset digest has conflicting byte sizes: ${candidate.contentDigest}`)
      }
      return asset
    })
  }

  completeAssetOperation(operationId: string, completedAt: number): AssetReceiptCommit {
    return withTransaction(this.#database, () => {
      const operationRow = this.#database
        .prepare("SELECT * FROM asset_operations WHERE id = ? AND state = 'running'")
        .get(operationId) as SqliteRow | undefined
      if (!operationRow) throw new Error(`Asset operation cannot complete from its current state: ${operationId}`)
      const operation = this.#assetOperation(operationRow)
      const existingOccurrence = this.#database
        .prepare('SELECT * FROM asset_occurrences WHERE id = ?')
        .get(operation.occurrence.id) as SqliteRow | undefined
      if (existingOccurrence) {
        const occurrence = this.#assetOccurrence(existingOccurrence)
        const assetRow = this.#database.prepare('SELECT * FROM assets WHERE id = ?').get(occurrence.assetId) as
          SqliteRow | undefined
        if (!assetRow) throw new Error(`Asset occurrence references a missing Asset: ${occurrence.id}`)
        this.#database
          .prepare(
            "UPDATE asset_operations SET state = 'completed', completed_at = ?, error_summary = NULL WHERE id = ?",
          )
          .run(completedAt, operationId)
        return { asset: this.#asset(assetRow), occurrence, insertedAsset: false }
      }
      const existingRow = this.#database
        .prepare('SELECT * FROM assets WHERE content_digest = ?')
        .get(operation.candidate.contentDigest) as SqliteRow | undefined

      let asset: AssetRecord
      let insertedAsset = false
      if (existingRow) {
        const existing = this.#asset(existingRow)
        if (existing.byteSize !== operation.candidate.byteSize) {
          throw new Error(`Asset digest has conflicting byte sizes: ${existing.contentDigest}`)
        }
        const lastReceivedAt = Math.max(existing.lastReceivedAt, operation.occurrence.receivedAt)
        this.#database
          .prepare(
            `UPDATE assets
                SET blob_state = 'present', last_received_at = ?, receive_count = receive_count + 1
              WHERE id = ?`,
          )
          .run(lastReceivedAt, existing.id)
        asset = { ...existing, blobState: 'present', lastReceivedAt, receiveCount: existing.receiveCount + 1 }
      } else {
        asset = operation.candidate
        this.#database
          .prepare(
            `INSERT INTO assets
              (id, content_digest, byte_size, media_type, blob_state, first_received_at,
               last_received_at, receive_count, last_accessed_at, storage_format_version)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            asset.id,
            asset.contentDigest,
            asset.byteSize,
            asset.mediaType,
            asset.blobState,
            asset.firstReceivedAt,
            asset.lastReceivedAt,
            asset.receiveCount,
            asset.lastAccessedAt ?? null,
            asset.storageFormatVersion,
          )
        insertedAsset = true
      }

      const occurrence: AssetOccurrenceRecord = { ...operation.occurrence, assetId: asset.id }
      this.#database
        .prepare(
          `INSERT INTO asset_occurrences
            (id, asset_id, channel_event_id, channel_id, connection_id,
             platform_message_id, received_at, filename, declared_media_type)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          occurrence.id,
          occurrence.assetId,
          occurrence.channelEventId,
          occurrence.channelId,
          occurrence.connectionId,
          occurrence.platformMessageId ?? null,
          occurrence.receivedAt,
          occurrence.filename ?? null,
          occurrence.declaredMediaType ?? null,
        )
      const completed = this.#database
        .prepare(
          "UPDATE asset_operations SET state = 'completed', completed_at = ?, error_summary = NULL WHERE id = ? AND state = 'running'",
        )
        .run(completedAt, operationId)
      if (completed.changes !== 1) throw new Error(`Asset operation completion conflicted: ${operationId}`)
      return { asset, occurrence, insertedAsset }
    })
  }

  failAssetOperation(operationId: string, errorSummary: string, completedAt: number): void {
    const result = this.#database
      .prepare(
        "UPDATE asset_operations SET state = 'failed', completed_at = ?, error_summary = ? WHERE id = ? AND state = 'running'",
      )
      .run(completedAt, errorSummary, operationId)
    if (result.changes !== 1) throw new Error(`Asset operation cannot fail from its current state: ${operationId}`)
  }

  listPendingAssetOperations(): readonly AssetOperationRecord[] {
    const rows = this.#database
      .prepare("SELECT * FROM asset_operations WHERE state = 'running' ORDER BY created_at, id")
      .all() as SqliteRow[]
    return rows.map((row) => this.#assetOperation(row))
  }

  getAssetByDigest(contentDigest: string): AssetRecord | undefined {
    const row = this.#database.prepare('SELECT * FROM assets WHERE content_digest = ?').get(contentDigest) as
      SqliteRow | undefined
    return row ? this.#asset(row) : undefined
  }

  getAssetById(id: AssetId): AssetRecord | undefined {
    const row = this.#database.prepare('SELECT * FROM assets WHERE id = ?').get(id) as SqliteRow | undefined
    return row ? this.#asset(row) : undefined
  }

  ensureAssetEnrichment(record: AssetEnrichmentRecord) {
    const result = this.#database
      .prepare(
        `INSERT OR IGNORE INTO asset_enrichments
          (id, asset_id, enhancer_id, provider, model_id, prompt_version, schema_version,
           state, summary, ocr_text, tags_json, input_digest, attempt_count,
           failure_kind, error_summary, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.assetId,
        record.enhancerId,
        record.provider,
        record.modelId,
        record.promptVersion,
        record.schemaVersion,
        record.state,
        null,
        null,
        null,
        record.inputDigest,
        record.attemptCount,
        null,
        null,
        record.createdAt,
        record.updatedAt,
      )
    const row = this.#database
      .prepare(
        `SELECT * FROM asset_enrichments
          WHERE asset_id = ? AND enhancer_id = ? AND model_id = ? AND prompt_version = ? AND schema_version = ?`,
      )
      .get(record.assetId, record.enhancerId, record.modelId, record.promptVersion, record.schemaVersion) as SqliteRow
    return { record: this.#assetEnrichment(row), inserted: result.changes === 1 }
  }

  claimPendingAssetEnrichment(updatedAt: number): AssetEnrichmentRecord | undefined {
    return withTransaction(this.#database, () => {
      const row = this.#database
        .prepare("SELECT * FROM asset_enrichments WHERE state = 'pending' ORDER BY created_at, id LIMIT 1")
        .get() as SqliteRow | undefined
      if (!row) return undefined
      const id = requiredString(row, 'id')
      const result = this.#database
        .prepare(
          "UPDATE asset_enrichments SET state = 'running', attempt_count = attempt_count + 1, updated_at = ? WHERE id = ? AND state = 'pending'",
        )
        .run(updatedAt, id)
      if (result.changes !== 1) throw new Error(`Asset enrichment claim conflicted: ${id}`)
      return this.#assetEnrichment(
        this.#database.prepare('SELECT * FROM asset_enrichments WHERE id = ?').get(id) as SqliteRow,
      )
    })
  }

  completeAssetEnrichment(
    id: string,
    result: { readonly summary: string; readonly ocrText?: string; readonly tags?: readonly string[] },
    updatedAt: number,
  ): AssetEnrichmentRecord {
    const update = this.#database
      .prepare(
        `UPDATE asset_enrichments SET state = 'succeeded', summary = ?, ocr_text = ?, tags_json = ?,
         failure_kind = NULL, error_summary = NULL, updated_at = ? WHERE id = ? AND state = 'running'`,
      )
      .run(
        result.summary,
        result.ocrText ?? null,
        result.tags === undefined ? null : JSON.stringify(result.tags),
        updatedAt,
        id,
      )
    if (update.changes !== 1) throw new Error(`Asset enrichment cannot complete: ${id}`)
    return this.#assetEnrichment(
      this.#database.prepare('SELECT * FROM asset_enrichments WHERE id = ?').get(id) as SqliteRow,
    )
  }

  failAssetEnrichment(id: string, failureKind: string, errorSummary: string, updatedAt: number): AssetEnrichmentRecord {
    const result = this.#database
      .prepare(
        "UPDATE asset_enrichments SET state = 'failed', failure_kind = ?, error_summary = ?, updated_at = ? WHERE id = ? AND state = 'running'",
      )
      .run(failureKind, errorSummary, updatedAt, id)
    if (result.changes !== 1) throw new Error(`Asset enrichment cannot fail: ${id}`)
    return this.#assetEnrichment(
      this.#database.prepare('SELECT * FROM asset_enrichments WHERE id = ?').get(id) as SqliteRow,
    )
  }

  resetRunningAssetEnrichments(updatedAt: number): number {
    return Number(
      this.#database
        .prepare("UPDATE asset_enrichments SET state = 'pending', updated_at = ? WHERE state = 'running'")
        .run(updatedAt).changes,
    )
  }

  listAssetEnrichments(assetId: AssetId): readonly AssetEnrichmentRecord[] {
    return (
      this.#database
        .prepare('SELECT * FROM asset_enrichments WHERE asset_id = ? ORDER BY created_at, id')
        .all(assetId) as SqliteRow[]
    ).map((row) => this.#assetEnrichment(row))
  }

  canAccessAsset(assetId: AssetId, channelId: ChannelId): boolean {
    return (
      this.#database
        .prepare('SELECT 1 FROM asset_occurrences WHERE asset_id = ? AND channel_id = ? LIMIT 1')
        .get(assetId, channelId) !== undefined
    )
  }

  findOpenDraft(agentId: AgentId, dshSessionId: string, dynamicPluginId: string): ExtensionDraftRecord | undefined {
    const row = this.#database
      .prepare(
        `SELECT * FROM extension_drafts
          WHERE agent_id = ? AND source_dsh_session_id = ? AND source_dynamic_plugin_id = ? AND state = 'open'`,
      )
      .get(agentId, dshSessionId, dynamicPluginId) as SqliteRow | undefined
    return row ? this.#extensionDraft(row) : undefined
  }

  createDraft(record: ExtensionDraftRecord): void {
    this.#database
      .prepare(
        `INSERT INTO extension_drafts
          (id, agent_id, source_dsh_session_id, source_dynamic_plugin_id, display_name, description,
           state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.agentId,
        record.sourceDshSessionId,
        record.sourceDynamicPluginId,
        record.displayName,
        record.description,
        record.state,
        record.createdAt,
        record.updatedAt,
      )
  }

  getDraft(id: ExtensionDraftId): ExtensionDraftRecord | undefined {
    const row = this.#database.prepare('SELECT * FROM extension_drafts WHERE id = ?').get(id) as SqliteRow | undefined
    return row ? this.#extensionDraft(row) : undefined
  }

  appendDraftPackage(record: DraftPackageRecord): DraftPackageRecord {
    this.#database
      .prepare(
        `INSERT OR IGNORE INTO draft_packages
          (id, draft_id, source_dynamic_package_id, sequence, name, purpose, host_code, client_code, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.draftId,
        record.sourceDynamicPackageId,
        record.sequence,
        record.name,
        record.purpose,
        record.hostCode ?? null,
        record.clientCode ?? null,
        record.createdAt,
      )
    const row = this.#database
      .prepare('SELECT * FROM draft_packages WHERE draft_id = ? AND source_dynamic_package_id = ?')
      .get(record.draftId, record.sourceDynamicPackageId) as SqliteRow | undefined
    if (!row) throw new Error('DraftPackage insert did not publish a row.')
    const stored = this.#draftPackage(row)
    if (
      stored.name !== record.name ||
      stored.purpose !== record.purpose ||
      stored.hostCode !== record.hostCode ||
      stored.clientCode !== record.clientCode
    ) {
      throw new Error('Dynamic Package identity was replayed with different source.')
    }
    return stored
  }

  getDraftPackage(id: DraftPackageId): DraftPackageRecord | undefined {
    const row = this.#database.prepare('SELECT * FROM draft_packages WHERE id = ?').get(id) as SqliteRow | undefined
    return row ? this.#draftPackage(row) : undefined
  }

  listDraftPackages(draftId: ExtensionDraftId): readonly DraftPackageRecord[] {
    return (
      this.#database
        .prepare('SELECT * FROM draft_packages WHERE draft_id = ? ORDER BY sequence')
        .all(draftId) as SqliteRow[]
    ).map((row) => this.#draftPackage(row))
  }

  getExtension(id: ExtensionId): LocalExtensionRecord | undefined {
    const row = this.#database.prepare('SELECT * FROM local_extensions WHERE id = ?').get(id) as SqliteRow | undefined
    return row ? this.#localExtension(row) : undefined
  }

  getExtensionBySlug(slug: string): LocalExtensionRecord | undefined {
    const row = this.#database.prepare('SELECT * FROM local_extensions WHERE slug = ?').get(slug) as
      SqliteRow | undefined
    return row ? this.#localExtension(row) : undefined
  }

  getExtensionRevision(id: ExtensionRevisionId): ExtensionRevisionRecord | undefined {
    const row = this.#database.prepare('SELECT * FROM extension_revisions WHERE id = ?').get(id) as
      SqliteRow | undefined
    return row ? this.#extensionRevision(row) : undefined
  }

  listExtensionRevisions(storageState?: ExtensionRevisionRecord['storageState']): readonly ExtensionRevisionRecord[] {
    const rows = storageState
      ? (this.#database
          .prepare('SELECT * FROM extension_revisions WHERE storage_state = ? ORDER BY created_at, id')
          .all(storageState) as SqliteRow[])
      : (this.#database.prepare('SELECT * FROM extension_revisions ORDER BY created_at, id').all() as SqliteRow[])
    return rows.map((row) => this.#extensionRevision(row))
  }

  nextExtensionRevisionNumber(extensionId: ExtensionId): number {
    const row = this.#database
      .prepare('SELECT COALESCE(MAX(revision_number), 0) + 1 AS next FROM extension_revisions WHERE extension_id = ?')
      .get(extensionId) as SqliteRow
    return requiredInteger(row, 'next')
  }

  beginExtensionSave(input: {
    readonly extension: LocalExtensionRecord
    readonly revision: ExtensionRevisionRecord
    readonly operation: ExtensionSaveOperationRecord
  }): void {
    withTransaction(this.#database, () => {
      this.#database
        .prepare(
          `INSERT OR IGNORE INTO local_extensions
            (id, slug, display_name, description, origin, created_by_agent_id, default_revision_id, created_at, deleted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.extension.id,
          input.extension.slug,
          input.extension.displayName,
          input.extension.description,
          input.extension.origin,
          input.extension.createdByAgentId ?? null,
          input.extension.defaultRevisionId ?? null,
          input.extension.createdAt,
          input.extension.deletedAt ?? null,
        )
      this.#database
        .prepare(
          `INSERT INTO extension_revisions
            (id, extension_id, revision_number, content_digest, manifest_schema_version, extension_api_version,
             source_kind, source_dynamic_package_ref, compatible_nekro_nxt_range, compatible_dsh_range,
             storage_state, last_build_status, last_validation_status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.revision.id,
          input.revision.extensionId,
          input.revision.revisionNumber,
          input.revision.contentDigest,
          input.revision.manifestSchemaVersion,
          input.revision.extensionApiVersion,
          input.revision.sourceKind,
          input.revision.sourceDynamicPackageRef ?? null,
          input.revision.compatibleNekroNxtRange,
          input.revision.compatibleDshRange,
          input.revision.storageState,
          input.revision.lastBuildStatus ?? null,
          input.revision.lastValidationStatus ?? null,
          input.revision.createdAt,
        )
      this.#database
        .prepare(
          `INSERT INTO extension_save_operations
            (id, draft_package_id, extension_id, revision_id, staging_relative_path, final_relative_path,
             state, error_summary, created_at, completed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.operation.id,
          input.operation.draftPackageId,
          input.operation.extensionId,
          input.operation.revisionId,
          input.operation.stagingRelativePath,
          input.operation.finalRelativePath,
          input.operation.state,
          input.operation.errorSummary ?? null,
          input.operation.createdAt,
          input.operation.completedAt ?? null,
        )
    })
  }

  completeExtensionSave(operationId: ExtensionSaveOperationId, completedAt: number): void {
    withTransaction(this.#database, () => {
      const operation = this.#database
        .prepare("SELECT * FROM extension_save_operations WHERE id = ? AND state = 'running'")
        .get(operationId) as SqliteRow | undefined
      if (!operation) throw new Error(`Extension save is not running: ${operationId}`)
      const revisionId = requiredString(operation, 'revision_id')
      const draftPackageId = requiredString(operation, 'draft_package_id')
      this.#database
        .prepare("UPDATE extension_revisions SET storage_state = 'saved' WHERE id = ? AND storage_state = 'saving'")
        .run(revisionId)
      this.#database
        .prepare(
          `UPDATE extension_drafts SET state = 'saved', updated_at = ?
            WHERE id = (SELECT draft_id FROM draft_packages WHERE id = ?) AND state = 'open'`,
        )
        .run(completedAt, draftPackageId)
      const result = this.#database
        .prepare(
          "UPDATE extension_save_operations SET state = 'completed', completed_at = ? WHERE id = ? AND state = 'running'",
        )
        .run(completedAt, operationId)
      if (result.changes !== 1) throw new Error(`Extension save completion conflicted: ${operationId}`)
    })
  }

  failExtensionSave(operationId: ExtensionSaveOperationId, errorSummary: string, completedAt: number): void {
    withTransaction(this.#database, () => {
      const operation = this.#database
        .prepare('SELECT revision_id FROM extension_save_operations WHERE id = ?')
        .get(operationId) as SqliteRow | undefined
      if (!operation) throw new Error(`Unknown Extension save operation: ${operationId}`)
      this.#database
        .prepare("UPDATE extension_revisions SET storage_state = 'damaged' WHERE id = ? AND storage_state = 'saving'")
        .run(requiredString(operation, 'revision_id'))
      const result = this.#database
        .prepare(
          "UPDATE extension_save_operations SET state = 'failed', error_summary = ?, completed_at = ? WHERE id = ? AND state = 'running'",
        )
        .run(errorSummary, completedAt, operationId)
      if (result.changes !== 1) throw new Error(`Extension save failure conflicted: ${operationId}`)
    })
  }

  listRunningExtensionSaves(): readonly ExtensionSaveOperationRecord[] {
    return (
      this.#database
        .prepare("SELECT * FROM extension_save_operations WHERE state = 'running' ORDER BY created_at, id")
        .all() as SqliteRow[]
    ).map((row) => this.#extensionSaveOperation(row))
  }

  markExtensionRevisionStorageState(id: ExtensionRevisionId, state: 'saved' | 'damaged' | 'quarantined'): void {
    const result = this.#database
      .prepare('UPDATE extension_revisions SET storage_state = ? WHERE id = ?')
      .run(state, id)
    if (result.changes !== 1) throw new Error(`Unknown Extension Revision: ${id}`)
  }

  markExtensionBuild(id: ExtensionRevisionId, status: 'succeeded' | 'failed'): void {
    const result = this.#database
      .prepare('UPDATE extension_revisions SET last_build_status = ? WHERE id = ?')
      .run(status, id)
    if (result.changes !== 1) throw new Error(`Unknown Extension Revision: ${id}`)
  }

  markExtensionValidation(id: ExtensionRevisionId, status: 'succeeded' | 'failed'): void {
    const result = this.#database
      .prepare('UPDATE extension_revisions SET last_validation_status = ? WHERE id = ?')
      .run(status, id)
    if (result.changes !== 1) throw new Error(`Unknown Extension Revision: ${id}`)
  }

  createActivation(record: AgentActivationRecord): void {
    withTransaction(this.#database, () => {
      const transition = this.#database
        .prepare(
          "SELECT id FROM agent_activations WHERE agent_id = ? AND extension_id = ? AND state IN ('pending', 'waiting-safe-switch') LIMIT 1",
        )
        .get(record.agentId, record.extensionId)
      if (transition) throw new Error('Extension already has an Activation transition for this Agent.')
      this.#database
        .prepare(
          `INSERT INTO agent_activations
            (id, agent_id, extension_id, extension_revision_id, config_json, state, runtime_kind,
             created_at, activated_at, disabled_at, last_error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.agentId,
          record.extensionId,
          record.extensionRevisionId,
          JSON.stringify(record.config),
          record.state,
          record.runtimeKind,
          record.createdAt,
          record.activatedAt ?? null,
          record.disabledAt ?? null,
          record.lastError ?? null,
        )
    })
  }

  getActivation(id: AgentActivationId): AgentActivationRecord | undefined {
    const row = this.#database.prepare('SELECT * FROM agent_activations WHERE id = ?').get(id) as SqliteRow | undefined
    return row ? this.#agentActivation(row) : undefined
  }

  listActiveActivations(agentId?: AgentId): readonly AgentActivationRecord[] {
    const rows = agentId
      ? (this.#database
          .prepare("SELECT * FROM agent_activations WHERE state = 'active' AND agent_id = ? ORDER BY created_at, id")
          .all(agentId) as SqliteRow[])
      : (this.#database
          .prepare("SELECT * FROM agent_activations WHERE state = 'active' ORDER BY created_at, id")
          .all() as SqliteRow[])
    return rows.map((row) => this.#agentActivation(row))
  }

  getActiveActivation(agentId: AgentId, extensionId: ExtensionId): AgentActivationRecord | undefined {
    const row = this.#database
      .prepare(
        "SELECT * FROM agent_activations WHERE agent_id = ? AND extension_id = ? AND state = 'active' ORDER BY activated_at DESC LIMIT 1",
      )
      .get(agentId, extensionId) as SqliteRow | undefined
    return row ? this.#agentActivation(row) : undefined
  }

  markActivationWaiting(id: AgentActivationId): void {
    const result = this.#database
      .prepare("UPDATE agent_activations SET state = 'waiting-safe-switch' WHERE id = ? AND state = 'pending'")
      .run(id)
    if (result.changes !== 1) throw new Error(`Activation cannot wait from its current state: ${id}`)
  }

  commitActivationSwitch(id: AgentActivationId, replacedId: AgentActivationId | undefined, activatedAt: number): void {
    withTransaction(this.#database, () => {
      if (replacedId !== undefined) {
        const disabled = this.#database
          .prepare("UPDATE agent_activations SET state = 'disabled', disabled_at = ? WHERE id = ? AND state = 'active'")
          .run(activatedAt, replacedId)
        if (disabled.changes !== 1) throw new Error(`Replaced Activation is not active: ${replacedId}`)
      }
      const activated = this.#database
        .prepare(
          "UPDATE agent_activations SET state = 'active', activated_at = ?, last_error = NULL WHERE id = ? AND state IN ('pending', 'waiting-safe-switch')",
        )
        .run(activatedAt, id)
      if (activated.changes !== 1) throw new Error(`Activation cannot commit from its current state: ${id}`)
    })
  }

  failActivation(id: AgentActivationId, error: string): void {
    const result = this.#database
      .prepare(
        "UPDATE agent_activations SET state = 'failed', last_error = ? WHERE id = ? AND state IN ('pending', 'waiting-safe-switch', 'active')",
      )
      .run(error, id)
    if (result.changes !== 1) throw new Error(`Activation cannot fail from its current state: ${id}`)
  }

  disableActivation(id: AgentActivationId, disabledAt: number): void {
    const result = this.#database
      .prepare("UPDATE agent_activations SET state = 'disabled', disabled_at = ? WHERE id = ? AND state = 'active'")
      .run(disabledAt, id)
    if (result.changes !== 1) throw new Error(`Activation is not active: ${id}`)
  }

  #insertAgentRevision(revision: AgentRevisionRecord): void {
    this.#database
      .prepare(
        `INSERT INTO agent_revisions
          (id, agent_id, revision, display_name, persona, model_provider, model_id,
           reasoning_effort, capabilities_json, settings_json, content_digest, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        revision.id,
        revision.agentId,
        revision.revision,
        revision.displayName,
        revision.persona,
        revision.model.provider,
        revision.model.model,
        revision.model.reasoningEffort ?? null,
        JSON.stringify(revision.capabilities),
        revision.settings === undefined ? null : JSON.stringify(revision.settings),
        revision.contentDigest,
        revision.createdAt,
      )
  }

  #agentRevision(row: SqliteRow): AgentRevisionRecord {
    const settings = optionalString(row, 'settings_json')
    const reasoningEffort = optionalString(row, 'reasoning_effort')
    return {
      id: requiredString(row, 'id') as AgentRevisionId,
      agentId: requiredString(row, 'agent_id') as AgentId,
      revision: requiredInteger(row, 'revision'),
      displayName: requiredString(row, 'display_name'),
      persona: requiredString(row, 'persona'),
      model: {
        provider: requiredString(row, 'model_provider'),
        model: requiredString(row, 'model_id'),
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      },
      capabilities: parseAgentCapabilityGrants(
        parseStoredJson(requiredString(row, 'capabilities_json'), 'capabilities_json'),
      ),
      ...(settings === undefined ? {} : { settings: parseStoredJson(settings, 'settings_json') }),
      contentDigest: requiredString(row, 'content_digest'),
      createdAt: requiredInteger(row, 'created_at'),
    }
  }

  #extensionDraft(row: SqliteRow): ExtensionDraftRecord {
    const state = requiredString(row, 'state')
    if (!['open', 'saved', 'discarded'].includes(state)) throw new Error(`Unknown ExtensionDraft state: ${state}`)
    return {
      id: requiredString(row, 'id') as ExtensionDraftId,
      agentId: requiredString(row, 'agent_id') as AgentId,
      sourceDshSessionId: requiredString(row, 'source_dsh_session_id'),
      sourceDynamicPluginId: requiredString(row, 'source_dynamic_plugin_id'),
      displayName: requiredString(row, 'display_name'),
      description: requiredString(row, 'description'),
      state: state as ExtensionDraftRecord['state'],
      createdAt: requiredInteger(row, 'created_at'),
      updatedAt: requiredInteger(row, 'updated_at'),
    }
  }

  #draftPackage(row: SqliteRow): DraftPackageRecord {
    const hostCode = optionalString(row, 'host_code')
    const clientCode = optionalString(row, 'client_code')
    return {
      id: requiredString(row, 'id') as DraftPackageId,
      draftId: requiredString(row, 'draft_id') as ExtensionDraftId,
      sourceDynamicPackageId: requiredString(row, 'source_dynamic_package_id'),
      sequence: requiredInteger(row, 'sequence'),
      name: requiredString(row, 'name'),
      purpose: requiredString(row, 'purpose'),
      ...(hostCode === undefined ? {} : { hostCode }),
      ...(clientCode === undefined ? {} : { clientCode }),
      createdAt: requiredInteger(row, 'created_at'),
    }
  }

  #localExtension(row: SqliteRow): LocalExtensionRecord {
    const origin = requiredString(row, 'origin')
    if (!['local-created', 'local-imported'].includes(origin)) throw new Error(`Unknown Extension origin: ${origin}`)
    const createdByAgentId = optionalString(row, 'created_by_agent_id')
    const defaultRevisionId = optionalString(row, 'default_revision_id')
    const deletedAt = optionalInteger(row, 'deleted_at')
    return {
      id: requiredString(row, 'id') as ExtensionId,
      slug: requiredString(row, 'slug'),
      displayName: requiredString(row, 'display_name'),
      description: requiredString(row, 'description'),
      origin: origin as LocalExtensionRecord['origin'],
      ...(createdByAgentId === undefined ? {} : { createdByAgentId: createdByAgentId as AgentId }),
      ...(defaultRevisionId === undefined ? {} : { defaultRevisionId: defaultRevisionId as ExtensionRevisionId }),
      createdAt: requiredInteger(row, 'created_at'),
      ...(deletedAt === undefined ? {} : { deletedAt }),
    }
  }

  #extensionRevision(row: SqliteRow): ExtensionRevisionRecord {
    const manifestSchemaVersion = requiredInteger(row, 'manifest_schema_version')
    const extensionApiVersion = requiredString(row, 'extension_api_version')
    const sourceKind = requiredString(row, 'source_kind')
    const storageState = requiredString(row, 'storage_state')
    const lastBuildStatus = optionalString(row, 'last_build_status')
    const lastValidationStatus = optionalString(row, 'last_validation_status')
    if (manifestSchemaVersion !== 1 || extensionApiVersion !== '1') {
      throw new Error('Unsupported Extension Revision schema or API version.')
    }
    if (!['dynamic-package', 'local-source'].includes(sourceKind)) {
      throw new Error(`Unknown Extension source kind: ${sourceKind}`)
    }
    if (!['saving', 'saved', 'damaged', 'quarantined'].includes(storageState)) {
      throw new Error(`Unknown Extension storage state: ${storageState}`)
    }
    if (lastBuildStatus !== undefined && !['succeeded', 'failed'].includes(lastBuildStatus)) {
      throw new Error(`Unknown Extension build status: ${lastBuildStatus}`)
    }
    if (lastValidationStatus !== undefined && !['succeeded', 'failed'].includes(lastValidationStatus)) {
      throw new Error(`Unknown Extension validation status: ${lastValidationStatus}`)
    }
    const sourceDynamicPackageRef = optionalString(row, 'source_dynamic_package_ref')
    return {
      id: requiredString(row, 'id') as ExtensionRevisionId,
      extensionId: requiredString(row, 'extension_id') as ExtensionId,
      revisionNumber: requiredInteger(row, 'revision_number'),
      contentDigest: requiredString(row, 'content_digest'),
      manifestSchemaVersion: 1,
      extensionApiVersion: '1',
      sourceKind: sourceKind as ExtensionRevisionRecord['sourceKind'],
      ...(sourceDynamicPackageRef === undefined ? {} : { sourceDynamicPackageRef }),
      compatibleNekroNxtRange: requiredString(row, 'compatible_nekro_nxt_range'),
      compatibleDshRange: requiredString(row, 'compatible_dsh_range'),
      storageState: storageState as ExtensionRevisionRecord['storageState'],
      ...(lastBuildStatus === undefined
        ? {}
        : { lastBuildStatus: lastBuildStatus as Exclude<ExtensionRevisionRecord['lastBuildStatus'], undefined> }),
      ...(lastValidationStatus === undefined
        ? {}
        : {
            lastValidationStatus: lastValidationStatus as Exclude<
              ExtensionRevisionRecord['lastValidationStatus'],
              undefined
            >,
          }),
      createdAt: requiredInteger(row, 'created_at'),
    }
  }

  #extensionSaveOperation(row: SqliteRow): ExtensionSaveOperationRecord {
    const state = requiredString(row, 'state')
    if (!['running', 'completed', 'failed'].includes(state)) throw new Error(`Unknown Extension save state: ${state}`)
    const errorSummary = optionalString(row, 'error_summary')
    const completedAt = optionalInteger(row, 'completed_at')
    return {
      id: requiredString(row, 'id') as ExtensionSaveOperationId,
      draftPackageId: requiredString(row, 'draft_package_id') as DraftPackageId,
      extensionId: requiredString(row, 'extension_id') as ExtensionId,
      revisionId: requiredString(row, 'revision_id') as ExtensionRevisionId,
      stagingRelativePath: requiredString(row, 'staging_relative_path'),
      finalRelativePath: requiredString(row, 'final_relative_path'),
      state: state as ExtensionSaveOperationRecord['state'],
      ...(errorSummary === undefined ? {} : { errorSummary }),
      createdAt: requiredInteger(row, 'created_at'),
      ...(completedAt === undefined ? {} : { completedAt }),
    }
  }

  #agentActivation(row: SqliteRow): AgentActivationRecord {
    const state = requiredString(row, 'state')
    const runtimeKind = requiredString(row, 'runtime_kind')
    if (!['pending', 'waiting-safe-switch', 'active', 'failed', 'disabled'].includes(state)) {
      throw new Error(`Unknown AgentActivation state: ${state}`)
    }
    if (runtimeKind !== 'in-process') throw new Error(`Unknown AgentActivation Runtime: ${runtimeKind}`)
    const activatedAt = optionalInteger(row, 'activated_at')
    const disabledAt = optionalInteger(row, 'disabled_at')
    const lastError = optionalString(row, 'last_error')
    return {
      id: requiredString(row, 'id') as AgentActivationId,
      agentId: requiredString(row, 'agent_id') as AgentId,
      extensionId: requiredString(row, 'extension_id') as ExtensionId,
      extensionRevisionId: requiredString(row, 'extension_revision_id') as ExtensionRevisionId,
      config: parseStoredJson(requiredString(row, 'config_json'), 'config_json'),
      state: state as AgentActivationRecord['state'],
      runtimeKind: 'in-process',
      createdAt: requiredInteger(row, 'created_at'),
      ...(activatedAt === undefined ? {} : { activatedAt }),
      ...(disabledAt === undefined ? {} : { disabledAt }),
      ...(lastError === undefined ? {} : { lastError }),
    }
  }

  #platformIdentity(row: SqliteRow): PlatformIdentityRecord {
    const displayName = optionalString(row, 'display_name')
    return {
      id: requiredString(row, 'id') as PlatformIdentityId,
      connectionId: requiredString(row, 'connection_id') as ConnectionId,
      platformUserId: requiredString(row, 'platform_user_id'),
      ...(displayName === undefined ? {} : { displayName }),
      firstSeenAt: requiredInteger(row, 'first_seen_at'),
      lastSeenAt: requiredInteger(row, 'last_seen_at'),
      seenCount: requiredInteger(row, 'seen_count'),
    }
  }

  #channelMember(row: SqliteRow): ChannelMemberRecord {
    const displayName = optionalString(row, 'display_name')
    return {
      id: requiredString(row, 'id') as ChannelMemberId,
      channelId: requiredString(row, 'channel_id') as ChannelId,
      platformIdentityId: requiredString(row, 'platform_identity_id') as PlatformIdentityId,
      ...(displayName === undefined ? {} : { displayName }),
      firstSeenAt: requiredInteger(row, 'first_seen_at'),
      lastSeenAt: requiredInteger(row, 'last_seen_at'),
      seenCount: requiredInteger(row, 'seen_count'),
    }
  }

  #channelEvent(row: SqliteRow): ChannelEventRecord {
    const platformEventId = optionalString(row, 'platform_event_id')
    const platformMessageId = optionalString(row, 'platform_message_id')
    const senderMemberId = optionalString(row, 'sender_member_id')
    const platformSequence = optionalInteger(row, 'platform_sequence')
    const facts = optionalString(row, 'facts_json')
    return {
      id: requiredString(row, 'id') as ChannelEventId,
      logicalMessageId: requiredString(row, 'logical_message_id') as LogicalMessageId,
      connectionId: requiredString(row, 'connection_id') as ConnectionId,
      channelId: requiredString(row, 'channel_id') as ChannelId,
      adapterKey: requiredString(row, 'adapter_key'),
      ...(platformEventId === undefined ? {} : { platformEventId }),
      ...(platformMessageId === undefined ? {} : { platformMessageId }),
      kind: requiredString(row, 'kind') as ChannelEventRecord['kind'],
      ...(senderMemberId === undefined ? {} : { senderMemberId: senderMemberId as ChannelMemberId }),
      parts: parseMessageParts(JSON.parse(requiredString(row, 'parts_json'))),
      ...(platformSequence === undefined ? {} : { platformSequence }),
      platformTimestamp: requiredInteger(row, 'platform_timestamp'),
      receivedAt: requiredInteger(row, 'received_at'),
      dedupeKey: requiredString(row, 'dedupe_key'),
      ...(facts === undefined ? {} : { facts: requiredObject(parseStoredJson(facts, 'facts_json'), 'facts_json') }),
    }
  }

  #binding(row: SqliteRow): BindingRecord {
    const triggerPolicy = requiredString(row, 'trigger_policy')
    if (!['always', 'mentioned-or-replied', 'command', 'observe-only'].includes(triggerPolicy)) {
      throw new Error(`Core database contains unknown trigger policy: ${triggerPolicy}`)
    }
    return {
      id: requiredString(row, 'id') as BindingId,
      channelId: requiredString(row, 'channel_id') as ChannelId,
      agentId: requiredString(row, 'agent_id') as AgentId,
      triggerPolicy: triggerPolicy as BindingRecord['triggerPolicy'],
      revision: requiredInteger(row, 'revision'),
      createdAt: requiredInteger(row, 'created_at'),
    }
  }

  #episode(row: SqliteRow): EpisodeRecord {
    const status = requiredString(row, 'status')
    if (!['opening', 'active', 'rolling-over', 'closed', 'failed'].includes(status)) {
      throw new Error(`Core database contains unknown Episode status: ${status}`)
    }
    const dshSessionId = optionalString(row, 'dsh_session_id')
    const lastAdmittedEventId = optionalString(row, 'last_admitted_event_id')
    const closedAtEventId = optionalString(row, 'closed_at_event_id')
    const closedAt = optionalInteger(row, 'closed_at')
    const closeReason = optionalString(row, 'close_reason')
    if (
      closeReason !== undefined &&
      ![
        'manual',
        'idle-timeout',
        'incompatible-revision',
        'incompatible-activation',
        'unrecoverable-session',
        'permission-revoked',
        'stopped',
      ].includes(closeReason)
    ) {
      throw new Error(`Core database contains unknown Episode close reason: ${closeReason}`)
    }
    return {
      id: requiredString(row, 'id') as EpisodeId,
      channelId: requiredString(row, 'channel_id') as ChannelId,
      agentId: requiredString(row, 'agent_id') as AgentId,
      agentRevisionId: requiredString(row, 'agent_revision_id') as AgentRevisionId,
      bindingId: requiredString(row, 'binding_id') as BindingId,
      bindingRevision: requiredInteger(row, 'binding_revision'),
      ...(dshSessionId === undefined ? {} : { dshSessionId }),
      status: status as EpisodeRecord['status'],
      openedAtEventId: requiredString(row, 'opened_at_event_id') as ChannelEventId,
      ...(lastAdmittedEventId === undefined ? {} : { lastAdmittedEventId: lastAdmittedEventId as ChannelEventId }),
      ...(closedAtEventId === undefined ? {} : { closedAtEventId: closedAtEventId as ChannelEventId }),
      ...(closedAt === undefined ? {} : { closedAt }),
      ...(closeReason === undefined ? {} : { closeReason: closeReason as EpisodeCloseReason }),
      createdAt: requiredInteger(row, 'created_at'),
    }
  }

  #admission(row: SqliteRow): AdmissionRecord {
    const state = requiredString(row, 'state')
    if (!['pending', 'claimed', 'logged-to-session', 'rejected'].includes(state)) {
      throw new Error(`Core database contains unknown Admission state: ${state}`)
    }
    const reason = requiredString(row, 'reason')
    if (!['trigger', 'running-injection', 'recovery'].includes(reason)) {
      throw new Error(`Core database contains unknown Admission reason: ${reason}`)
    }
    const eventIds = parseStoredJson(requiredString(row, 'channel_event_ids_json'), 'channel_event_ids_json')
    if (!Array.isArray(eventIds) || eventIds.length === 0 || eventIds.some((id) => typeof id !== 'string')) {
      throw new Error('Core database channel_event_ids_json must be a non-empty string array.')
    }
    const dshMessageId = optionalString(row, 'dsh_message_id')
    const claimedAt = optionalInteger(row, 'claimed_at')
    const loggedAt = optionalInteger(row, 'logged_at')
    return {
      id: requiredString(row, 'id') as AdmissionId,
      episodeId: requiredString(row, 'episode_id') as EpisodeId,
      channelEventIds: eventIds as ChannelEventId[],
      reason: reason as AdmissionRecord['reason'],
      state: state as AdmissionRecord['state'],
      ...(dshMessageId === undefined ? {} : { dshMessageId }),
      createdAt: requiredInteger(row, 'created_at'),
      ...(claimedAt === undefined ? {} : { claimedAt }),
      ...(loggedAt === undefined ? {} : { loggedAt }),
    }
  }

  #outboundIntent(row: SqliteRow): OutboundIntentRecord {
    const state = requiredString(row, 'state')
    if (!['planned', 'sending', 'sent', 'partially-sent', 'failed', 'unknown'].includes(state)) {
      throw new Error(`Core database contains unknown Outbound state: ${state}`)
    }
    const sourceTurnId = optionalString(row, 'source_turn_id')
    const replyTo = optionalString(row, 'reply_to')
    const clientRequestId = optionalString(row, 'client_request_id')
    return {
      id: requiredString(row, 'id') as OutboundIntentId,
      logicalMessageId: requiredString(row, 'logical_message_id') as LogicalMessageId,
      agentId: requiredString(row, 'agent_id') as AgentId,
      agentRevisionId: requiredString(row, 'agent_revision_id') as AgentRevisionId,
      episodeId: requiredString(row, 'episode_id') as EpisodeId,
      ...(sourceTurnId === undefined ? {} : { sourceTurnId }),
      channelId: requiredString(row, 'channel_id') as ChannelId,
      parts: parseMessageParts(JSON.parse(requiredString(row, 'parts_json'))),
      ...(replyTo === undefined ? {} : { replyTo }),
      ...(clientRequestId === undefined ? {} : { clientRequestId }),
      state: state as OutboundState,
      createdAt: requiredInteger(row, 'created_at'),
    }
  }

  #physicalDelivery(row: SqliteRow): PhysicalDeliveryRecord {
    const state = requiredString(row, 'state')
    if (!['planned', 'sending', 'sent', 'failed', 'unknown'].includes(state)) {
      throw new Error(`Core database contains unknown PhysicalDelivery state: ${state}`)
    }
    const adapterContext = optionalString(row, 'adapter_context_json')
    return {
      id: requiredString(row, 'id') as PhysicalDeliveryId,
      intentId: requiredString(row, 'intent_id') as OutboundIntentId,
      sequence: requiredInteger(row, 'sequence'),
      parts: parseMessageParts(JSON.parse(requiredString(row, 'parts_json'))),
      ...(adapterContext === undefined
        ? {}
        : { adapterContext: parseStoredJson(adapterContext, 'adapter_context_json') }),
      state: state as PhysicalDeliveryRecord['state'],
      attemptCount: requiredInteger(row, 'attempt_count'),
    }
  }

  #deliveryReceipt(row: SqliteRow): DeliveryReceiptRecord {
    return {
      id: requiredString(row, 'id') as DeliveryReceiptId,
      physicalDeliveryId: requiredString(row, 'physical_delivery_id') as PhysicalDeliveryId,
      attempt: requiredInteger(row, 'attempt'),
      receipt: parseAdapterDeliveryReceipt(JSON.parse(requiredString(row, 'receipt_json'))),
      createdAt: requiredInteger(row, 'created_at'),
    }
  }

  #asset(row: SqliteRow): AssetRecord {
    const blobState = requiredString(row, 'blob_state')
    if (!['present', 'evicted', 'missing', 'quarantined'].includes(blobState)) {
      throw new Error(`Core database contains unknown Asset blob state: ${blobState}`)
    }
    const storageFormatVersion = requiredInteger(row, 'storage_format_version')
    if (storageFormatVersion !== 1) {
      throw new Error(`Core database contains unsupported Asset storage format: ${storageFormatVersion}`)
    }
    const lastAccessedAt = optionalInteger(row, 'last_accessed_at')
    return {
      id: requiredString(row, 'id') as AssetId,
      contentDigest: requiredString(row, 'content_digest'),
      byteSize: requiredInteger(row, 'byte_size'),
      mediaType: requiredString(row, 'media_type'),
      blobState: blobState as AssetRecord['blobState'],
      firstReceivedAt: requiredInteger(row, 'first_received_at'),
      lastReceivedAt: requiredInteger(row, 'last_received_at'),
      receiveCount: requiredInteger(row, 'receive_count'),
      ...(lastAccessedAt === undefined ? {} : { lastAccessedAt }),
      storageFormatVersion: 1,
    }
  }

  #assetOccurrence(row: SqliteRow): AssetOccurrenceRecord {
    const platformMessageId = optionalString(row, 'platform_message_id')
    const filename = optionalString(row, 'filename')
    const declaredMediaType = optionalString(row, 'declared_media_type')
    return {
      id: requiredString(row, 'id') as AssetOccurrenceId,
      assetId: requiredString(row, 'asset_id') as AssetId,
      channelEventId: requiredString(row, 'channel_event_id') as ChannelEventId,
      channelId: requiredString(row, 'channel_id') as ChannelId,
      connectionId: requiredString(row, 'connection_id') as ConnectionId,
      ...(platformMessageId === undefined ? {} : { platformMessageId }),
      receivedAt: requiredInteger(row, 'received_at'),
      ...(filename === undefined ? {} : { filename }),
      ...(declaredMediaType === undefined ? {} : { declaredMediaType }),
    }
  }

  #historyEntry(row: SqliteRow): ChannelHistoryEntry {
    const source = requiredString(row, 'source')
    const parts = parseMessageParts(JSON.parse(requiredString(row, 'parts_json')))
    if (source === 'channel-event') {
      return {
        source,
        sourceId: requiredString(row, 'source_id') as ChannelEventId,
        channelId: requiredString(row, 'channel_id') as ChannelId,
        occurredAt: requiredInteger(row, 'occurred_at'),
        parts,
      }
    }
    if (source === 'outbound-intent') {
      const state = requiredString(row, 'state')
      if (!['planned', 'sending', 'sent', 'partially-sent', 'failed', 'unknown'].includes(state)) {
        throw new Error(`Core database contains unknown history Outbound state: ${state}`)
      }
      return {
        source,
        sourceId: requiredString(row, 'source_id') as OutboundIntentId,
        logicalMessageId: requiredString(row, 'logical_message_id') as LogicalMessageId,
        channelId: requiredString(row, 'channel_id') as ChannelId,
        occurredAt: requiredInteger(row, 'occurred_at'),
        parts,
        state: state as OutboundState,
      }
    }
    throw new Error(`Core database contains unknown Channel history source: ${source}`)
  }

  #assetEnrichment(row: SqliteRow): AssetEnrichmentRecord {
    const state = requiredString(row, 'state')
    if (!['pending', 'running', 'succeeded', 'failed'].includes(state)) {
      throw new Error(`Core database contains unknown Asset enrichment state: ${state}`)
    }
    const tagsJson = optionalString(row, 'tags_json')
    let tags: string[] | undefined
    if (tagsJson !== undefined) {
      const parsed = parseStoredJson(tagsJson, 'tags_json')
      if (!Array.isArray(parsed) || parsed.some((tag) => typeof tag !== 'string')) {
        throw new Error('Core database tags_json must be a string array.')
      }
      tags = parsed as string[]
    }
    const summary = optionalString(row, 'summary')
    const ocrText = optionalString(row, 'ocr_text')
    const failureKind = optionalString(row, 'failure_kind')
    const errorSummary = optionalString(row, 'error_summary')
    return {
      id: requiredString(row, 'id'),
      assetId: requiredString(row, 'asset_id') as AssetId,
      enhancerId: requiredString(row, 'enhancer_id'),
      provider: requiredString(row, 'provider'),
      modelId: requiredString(row, 'model_id'),
      promptVersion: requiredInteger(row, 'prompt_version'),
      schemaVersion: requiredInteger(row, 'schema_version'),
      state: state as AssetEnrichmentRecord['state'],
      ...(summary === undefined ? {} : { summary }),
      ...(ocrText === undefined ? {} : { ocrText }),
      ...(tags === undefined ? {} : { tags }),
      inputDigest: requiredString(row, 'input_digest'),
      attemptCount: requiredInteger(row, 'attempt_count'),
      ...(failureKind === undefined ? {} : { failureKind }),
      ...(errorSummary === undefined ? {} : { errorSummary }),
      createdAt: requiredInteger(row, 'created_at'),
      updatedAt: requiredInteger(row, 'updated_at'),
    }
  }

  #assetOperation(row: SqliteRow): AssetOperationRecord {
    const state = requiredString(row, 'state')
    if (!['running', 'completed', 'failed'].includes(state)) {
      throw new Error(`Core database contains unknown Asset operation state: ${state}`)
    }
    const candidateValue = requiredObject(
      parseStoredJson(requiredString(row, 'candidate_json'), 'candidate_json'),
      'candidate_json',
    )
    const occurrenceValue = requiredObject(
      parseStoredJson(requiredString(row, 'occurrence_json'), 'occurrence_json'),
      'occurrence_json',
    )
    const blobState = objectString(candidateValue, 'blobState', 'candidate_json')
    if (!['present', 'evicted', 'missing', 'quarantined'].includes(blobState)) {
      throw new Error(`Core database candidate_json.blobState is unknown: ${blobState}`)
    }
    if (objectInteger(candidateValue, 'storageFormatVersion', 'candidate_json') !== 1) {
      throw new Error('Core database candidate_json.storageFormatVersion is unsupported.')
    }
    const lastAccessedAt = candidateValue.lastAccessedAt
    if (lastAccessedAt !== undefined && !Number.isSafeInteger(lastAccessedAt)) {
      throw new Error('Core database candidate_json.lastAccessedAt must be a safe integer when present.')
    }
    const candidate: AssetRecord = {
      id: objectString(candidateValue, 'id', 'candidate_json') as AssetId,
      contentDigest: objectString(candidateValue, 'contentDigest', 'candidate_json'),
      byteSize: objectInteger(candidateValue, 'byteSize', 'candidate_json'),
      mediaType: objectString(candidateValue, 'mediaType', 'candidate_json'),
      blobState: blobState as AssetRecord['blobState'],
      firstReceivedAt: objectInteger(candidateValue, 'firstReceivedAt', 'candidate_json'),
      lastReceivedAt: objectInteger(candidateValue, 'lastReceivedAt', 'candidate_json'),
      receiveCount: objectInteger(candidateValue, 'receiveCount', 'candidate_json'),
      ...(lastAccessedAt === undefined ? {} : { lastAccessedAt: lastAccessedAt as number }),
      storageFormatVersion: 1,
    }
    const platformMessageId = objectOptionalString(occurrenceValue, 'platformMessageId', 'occurrence_json')
    const filename = objectOptionalString(occurrenceValue, 'filename', 'occurrence_json')
    const declaredMediaType = objectOptionalString(occurrenceValue, 'declaredMediaType', 'occurrence_json')
    const occurrence: AssetOccurrenceInput & { readonly id: AssetOccurrenceId } = {
      id: objectString(occurrenceValue, 'id', 'occurrence_json') as AssetOccurrenceId,
      channelEventId: objectString(occurrenceValue, 'channelEventId', 'occurrence_json') as ChannelEventId,
      channelId: objectString(occurrenceValue, 'channelId', 'occurrence_json') as ChannelId,
      connectionId: objectString(occurrenceValue, 'connectionId', 'occurrence_json') as ConnectionId,
      ...(platformMessageId === undefined ? {} : { platformMessageId }),
      receivedAt: objectInteger(occurrenceValue, 'receivedAt', 'occurrence_json'),
      ...(filename === undefined ? {} : { filename }),
      ...(declaredMediaType === undefined ? {} : { declaredMediaType }),
    }
    const completedAt = optionalInteger(row, 'completed_at')
    const errorSummary = optionalString(row, 'error_summary')
    return {
      id: requiredString(row, 'id'),
      state: state as AssetOperationRecord['state'],
      stagingRelativePath: requiredString(row, 'staging_relative_path'),
      blobRelativePath: requiredString(row, 'blob_relative_path'),
      candidate,
      occurrence,
      createdAt: requiredInteger(row, 'created_at'),
      ...(completedAt === undefined ? {} : { completedAt }),
      ...(errorSummary === undefined ? {} : { errorSummary }),
    }
  }
}

/** Creates a consistent online backup using Node's SQLite backup API. */
export async function backupCoreDatabase(database: DatabaseSync, destination: string): Promise<void> {
  await backup(database, destination)
}

export interface SqliteBackupSource {
  readonly name: string
  readonly filename: string
}

export interface SqliteBackupManifest {
  readonly format: 'nxt.sqlite-backup-set'
  readonly version: 1
  readonly createdAt: number
  readonly databases: readonly { readonly name: string; readonly filename: string }[]
}

/**
 * Creates one committed backup directory from multiple live SQLite files.
 * The manifest is written only after every online backup succeeds, then the
 * staging directory is renamed into place. This coordinates snapshots without
 * reading or sharing either database owner's private tables.
 */
export async function createSqliteBackupSet(
  sources: readonly SqliteBackupSource[],
  destination: string,
  createdAt = Date.now(),
): Promise<SqliteBackupManifest> {
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new TypeError('Backup createdAt must be non-negative.')
  if (sources.length === 0) throw new TypeError('Backup set requires at least one database.')
  try {
    await lstat(destination)
    throw new Error(`Backup destination already exists: ${destination}`)
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
  const names = new Set<string>()
  for (const source of sources) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(source.name) || names.has(source.name)) {
      throw new TypeError(`Backup database name must be unique and kebab-case: ${source.name}`)
    }
    if (source.filename === ':memory:' || !path.isAbsolute(source.filename)) {
      throw new TypeError(`Backup source must be an absolute on-disk SQLite path: ${source.name}`)
    }
    names.add(source.name)
  }

  const staging = await mkdtemp(`${destination}.staging-`)
  const databases = sources.map(({ name }) => ({ name, filename: `${name}.sqlite` }))
  const manifest: SqliteBackupManifest = {
    format: 'nxt.sqlite-backup-set',
    version: 1,
    createdAt,
    databases,
  }

  try {
    for (const [index, source] of sources.entries()) {
      const database = new DatabaseSync(source.filename, { readOnly: true })
      try {
        await backup(database, path.join(staging, databases[index]!.filename))
      } finally {
        database.close()
      }
    }
    await writeFile(path.join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    await rename(staging, destination)
    return manifest
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
}
