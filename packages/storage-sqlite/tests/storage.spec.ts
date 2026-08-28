import BetterSqlite3 from 'better-sqlite3'
import { count, eq } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
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
  DshPluginEntryIdSchema,
  EpisodeHandoffIdSchema,
  EpisodeIdSchema,
  ExtensionIdSchema,
  ExtensionRevisionIdSchema,
  HostUiPageInstanceIdSchema,
  LogicalMessageIdSchema,
  OutboundIntentIdSchema,
  PhysicalDeliveryIdSchema,
  PlatformIdentityIdSchema,
} from '@nekro-nxt/contracts'
import type { JsonValue } from '@nekro-nxt/contracts'
import { CoreService } from '@nekro-nxt/core'
import {
  backupCoreDatabase,
  coreSchema,
  createSqliteBackupSet,
  openCoreDatabase,
  openMigratedCoreDatabase,
  SqliteBackupManifestSchema,
  SqliteCoreRepository,
  agentDefinitions,
  assetOccurrences,
  channelEvents,
  channels,
  connections,
  physicalDeliveries,
} from '../src/index.ts'

const directories: string[] = []
const migrationsDirectory = fileURLToPath(new URL('../migrations/', import.meta.url))
const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nekro-nxt-storage-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const capabilities = {
  subagents: false,
  fileTools: false,
  webSearch: false,
  dynamicCreation: false,
  developmentShell: false,
  unrestrictedFileAccess: false,
}

const createFixture = async () => {
  const directory = await temporaryDirectory()
  const database = await openMigratedCoreDatabase(path.join(directory, 'core.sqlite'))
  const repository = new SqliteCoreRepository(database)
  let sequence = 0
  const core = new CoreService(repository, { now: () => 1000 + sequence, nextUlid: () => `T${++sequence}` })
  const connection = core.createConnection({ adapterKey: 'web', config: {} })
  return { directory, database, repository, core, connection }
}

const createDatabaseAtMigration = async (filename: string, lastMigration: number): Promise<void> => {
  const native = new BetterSqlite3(filename)
  try {
    native.exec(`CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at numeric
    )`)
    const journal = z
      .object({
        entries: z.array(z.object({ idx: z.number().int(), when: z.number(), tag: z.string() }).passthrough()),
      })
      .parse(JSON.parse(await readFile(path.join(migrationsDirectory, 'meta', '_journal.json'), 'utf8')))
    for (const entry of journal.entries.filter(({ idx }) => idx <= lastMigration)) {
      const source = await readFile(path.join(migrationsDirectory, `${entry.tag}.sql`), 'utf8')
      for (const statement of source
        .split('--> statement-breakpoint')
        .map((value) => value.trim())
        .filter(Boolean)) {
        native.exec(statement)
      }
      native
        .prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
        .run(createHash('sha256').update(source).digest('hex'), entry.when)
    }
  } finally {
    native.close()
  }
}

const createAgent = (core: CoreService) =>
  core.createAgent({
    displayName: '测试智能体',
    persona: '保持事实准确。',
    model: { provider: 'test', model: 'model' },
    capabilities,
  })

const mutateSqlite = (filename: string, statement: string, ...parameters: (string | number)[]): void => {
  const native = new BetterSqlite3(filename)
  try {
    native.prepare(statement).run(...parameters)
  } finally {
    native.close()
  }
}

const mutateSqliteWithForeignKeysOff = (
  filename: string,
  statement: string,
  ...parameters: (string | number)[]
): void => {
  const native = new BetterSqlite3(filename)
  try {
    native.pragma('foreign_keys = OFF')
    native.prepare(statement).run(...parameters)
  } finally {
    native.close()
  }
}

const appendTextEvent = (
  core: CoreService,
  connectionId: ReturnType<CoreService['createConnection']>['id'],
  channelId: ReturnType<CoreService['createChannel']>['id'],
  dedupeKey: string,
  text: string,
  receivedAt: number,
  options: {
    readonly platformMessageId?: string
    readonly facts?: Readonly<Record<string, JsonValue>>
    readonly kind?: 'message-created' | 'message-edited' | 'control'
  } = {},
) =>
  core.appendInbound({
    connectionId,
    channelId,
    adapterKey: 'web',
    ...(options.platformMessageId === undefined ? {} : { platformMessageId: options.platformMessageId }),
    kind: options.kind ?? 'message-created',
    parts: [{ type: 'text', text }],
    platformTimestamp: receivedAt,
    receivedAt,
    dedupeKey,
    ...(options.facts === undefined ? {} : { facts: options.facts }),
  }).event

describe('Core SQLite baseline', () => {
  it('accepts better-sqlite3 table_list metadata and migrates a clean database', async () => {
    expect(Object.keys(coreSchema)).toHaveLength(38)
    expect(channelEvents.logicalMessageId.name).toBe('logical_message_id')
    expect('logicalMessageId' in channels).toBe(false)

    const { database, core } = await createFixture()
    try {
      expect(database.pragma('foreign_keys')).toBe(1)
      expect(database.pragma('journal_mode')).toBe('wal')
      expect(core.listConnections()).toHaveLength(1)
    } finally {
      database.close()
    }
  })

  it('persists revisioned product settings across a database reopen', async () => {
    const directory = await temporaryDirectory()
    const filename = path.join(directory, 'core.sqlite')
    const database = await openMigratedCoreDatabase(filename)
    const repository = new SqliteCoreRepository(database)
    expect(repository.getSystemSetting('notifications')).toBeUndefined()
    expect(repository.putSystemSetting('notifications', { system: { enabled: true } }, undefined, 10)).toEqual({
      key: 'notifications',
      value: { system: { enabled: true } },
      revision: 1,
      updatedAt: 10,
    })
    expect(() => repository.putSystemSetting('notifications', {}, undefined, 11)).toThrow(
      'System setting revision conflict.',
    )
    database.close()

    const reopened = await openMigratedCoreDatabase(filename)
    try {
      const reopenedRepository = new SqliteCoreRepository(reopened)
      expect(reopenedRepository.getSystemSetting('notifications')).toMatchObject({
        value: { system: { enabled: true } },
        revision: 1,
      })
    } finally {
      reopened.close()
    }
  })

  it('rebuilds a populated referenced Episode table while migrating from schema 0002', async () => {
    const directory = await temporaryDirectory()
    const filename = path.join(directory, 'core.sqlite')
    await createDatabaseAtMigration(filename, 2)
    const oldDatabase = openCoreDatabase(filename)
    const oldRepository = new SqliteCoreRepository(oldDatabase)
    const oldCore = new CoreService(oldRepository, { now: () => 1000, nextUlid: () => 'MIGRATION' })
    const connection = oldCore.createConnection({ adapterKey: 'web', config: {} })
    oldDatabase.close()
    const legacy = new BetterSqlite3(filename)
    const agentId = AgentIdSchema.parse('agt_MIGRATION')
    const agentRevisionId = AgentRevisionIdSchema.parse('arev_MIGRATION')
    legacy.prepare('INSERT INTO agent_definitions (id, created_at) VALUES (?, ?)').run(agentId, 1)
    legacy
      .prepare(
        'INSERT INTO agent_revisions (id, agent_id, revision, display_name, persona, model_provider, model_id, reasoning_effort, capabilities, content_digest, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        agentRevisionId,
        agentId,
        1,
        '迁移测试智能体',
        '',
        'test',
        'model',
        null,
        JSON.stringify(capabilities),
        'v2:legacy-migration',
        1,
      )
    legacy
      .prepare('INSERT INTO agent_current_revisions (agent_id, revision_id) VALUES (?, ?)')
      .run(agentId, agentRevisionId)
    const channelId = ChannelIdSchema.parse('chn_MIGRATION')
    const eventId = ChannelEventIdSchema.parse('evt_MIGRATION')
    const logicalMessageId = LogicalMessageIdSchema.parse('msg_MIGRATION')
    const episodeId = EpisodeIdSchema.parse('eps_MIGRATION')
    const admissionId = AdmissionIdSchema.parse('adm_MIGRATION')
    legacy
      .prepare(
        'INSERT INTO channels (id, connection_id, platform_channel_id, kind, display_name, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(channelId, connection.id, 'migration-channel', 'web', null, 1)
    legacy
      .prepare(
        'INSERT INTO channel_events (id, logical_message_id, channel_id, platform_message_id, kind, sender_member_id, parts, source_timestamp, received_at, dedupe_key, facts, search_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        eventId,
        logicalMessageId,
        channelId,
        null,
        'message-created',
        null,
        JSON.stringify([{ type: 'text', text: 'migration' }]),
        1,
        1,
        'migration-event',
        null,
        'migration',
      )
    legacy
      .prepare(
        'INSERT INTO episodes (id, channel_id, agent_id, agent_revision_id, dsh_session_id, status, opened_at_event_id, last_admitted_event_id, closed_at_event_id, closed_at, close_reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(episodeId, channelId, agentId, agentRevisionId, null, 'opening', eventId, null, null, null, null, 2)
    legacy
      .prepare(
        'INSERT INTO admissions (id, episode_id, mode, state, dsh_message_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(admissionId, episodeId, 'followup', 'pending', null, 3)
    legacy
      .prepare('INSERT INTO admission_events (admission_id, event_id, position) VALUES (?, ?, ?)')
      .run(admissionId, eventId, 0)
    legacy.close()

    const migrated = await openMigratedCoreDatabase(filename)
    try {
      const repository = new SqliteCoreRepository(migrated)
      expect(migrated.pragma('foreign_keys')).toBe(1)
      expect(repository.getEpisode(episodeId)).toMatchObject({ id: episodeId, status: 'opening' })
      expect(repository.listRecoverableAdmissions(episodeId)).toHaveLength(1)
      expect(
        migrated.db
          .select({ deletedAt: agentDefinitions.deletedAt })
          .from(agentDefinitions)
          .where(eq(agentDefinitions.id, agentId))
          .get(),
      ).toEqual({ deletedAt: null })
      expect(repository.getAgentRevision(agentRevisionId)).toMatchObject({
        contentDigest: 'v2:legacy-migration',
        imagePolicy: {
          history: {
            mode: 'persistent-distinct',
            detail: 'auto',
            restoreAfterCompaction: { recentMessages: 32, maxImages: 20 },
          },
          textModel: { mode: 'disabled' },
        },
      })
      expect(
        migrated.db
          .select({ autoCreatedForAgentId: channels.autoCreatedForAgentId, deletedAt: channels.deletedAt })
          .from(channels)
          .where(eq(channels.id, channelId))
          .get(),
      ).toEqual({ autoCreatedForAgentId: null, deletedAt: null })
      expect(repository.closeEpisode(episodeId, 'context-cleared', eventId, 4)).toMatchObject({
        status: 'closed',
        closeReason: 'context-cleared',
      })
    } finally {
      migrated.close()
    }
    const native = new BetterSqlite3(filename)
    try {
      expect(native.pragma('foreign_key_check')).toEqual([])
    } finally {
      native.close()
    }
  })

  it('backfills Extension scope and payload digest while preserving schema 0014 data', async () => {
    const directory = await temporaryDirectory()
    const filename = path.join(directory, 'core.sqlite')
    await createDatabaseAtMigration(filename, 14)
    const extensionId = ExtensionIdSchema.parse('ext_MIGRATIONHOST')
    const revisionId = ExtensionRevisionIdSchema.parse('xrv_MIGRATIONHOST')
    const legacy = new BetterSqlite3(filename)
    legacy
      .prepare('INSERT INTO local_extensions (id, slug, display_name, description, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(extensionId, 'migration-host', '迁移夹具扩展', 'Synthetic migration fixture.', 1)
    legacy
      .prepare(
        'INSERT INTO extension_revisions (id, extension_id, revision_number, content_digest, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(revisionId, extensionId, 1, 'a'.repeat(64), 2)
    legacy
      .prepare('INSERT INTO extension_revision_verifications (revision_id, verified_at, evidence) VALUES (?, ?, ?)')
      .run(
        revisionId,
        2,
        JSON.stringify({
          revisionId,
          dshVersion: '0.1.1-rc.2',
          contractVersion: 'nekro-nxt-extension-v2',
          scope: 'host-adapter',
          origin: {
            episodeId: 'eps_fixture',
            pluginId: 'plugin_fixture',
            packageId: 'pkg_fixture',
            pluginRunId: 'run_fixture',
          },
          verifiedAt: 2,
          hostBuild: { built: true, buildKey: 'host' },
          clientBuild: { built: false, buildKey: 'client' },
          toolInvocations: [],
          rpcMethods: [],
          renderedSlots: [],
        }),
      )
    legacy.close()

    const migrated = await openMigratedCoreDatabase(filename)
    try {
      const repository = new SqliteCoreRepository(migrated)
      expect(repository.getExtension(extensionId)?.displayName).toBe('迁移夹具扩展')
      expect(repository.getExtension(extensionId)?.scope).toBe('host-adapter')
      expect(repository.getExtensionRevision(revisionId)).toMatchObject({
        contentDigest: 'a'.repeat(64),
        payloadDigest: 'a'.repeat(64),
      })
      expect(repository.listHostInstallations()).toEqual([])
      repository.upsertHostInstallation({ extensionId, extensionRevisionId: revisionId, installedAt: 3 })
      expect(repository.getHostInstallation(extensionId)).toEqual({
        extensionId,
        extensionRevisionId: revisionId,
        installedAt: 3,
      })
      repository.deleteHostInstallation(extensionId)
      expect(repository.getHostInstallation(extensionId)).toBeUndefined()
      expect(migrated.pragma('foreign_keys')).toBe(1)
    } finally {
      migrated.close()
    }
  })

  it('persists, reloads, updates, and clears a normalized Connection alias', async () => {
    const { directory, database, core, connection } = await createFixture()
    const filename = path.join(directory, 'core.sqlite')
    let databaseClosed = false
    try {
      const named = core.updateConnectionAlias(connection.id, '  备用账号  ')
      expect(named.alias).toBe('备用账号')
      expect(database.db.select({ alias: connections.alias }).from(connections).get()?.alias).toBe('备用账号')
      database.close()
      databaseClosed = true

      const reopened = await openMigratedCoreDatabase(filename)
      try {
        const reopenedRepository = new SqliteCoreRepository(reopened)
        expect(reopenedRepository.getConnection(connection.id)?.alias).toBe('备用账号')
        const reopenedCore = new CoreService(reopenedRepository, { now: () => 2000, nextUlid: () => 'REOPENED' })
        expect(reopenedCore.updateConnectionAlias(connection.id, '   ')).not.toHaveProperty('alias')
        expect(reopenedRepository.getConnection(connection.id)).not.toHaveProperty('alias')
        expect(() => reopenedCore.updateConnectionAlias(connection.id, 'x'.repeat(81))).toThrow()
      } finally {
        reopened.close()
      }
    } finally {
      if (!databaseClosed) database.close()
    }
  })

  it('rejects a non-baseline development database instead of upgrading it', async () => {
    const directory = await temporaryDirectory()
    const filename = path.join(directory, 'legacy.sqlite')
    const legacy = new BetterSqlite3(filename)
    legacy.exec('CREATE TABLE migration_journal (version INTEGER NOT NULL)')
    legacy.close()
    await expect(openMigratedCoreDatabase(filename)).rejects.toThrow('基线已重置')
  })

  it('reads missing revisions, appends revisions with CAS, and rejects stale or foreign activation', async () => {
    const { database, repository, core } = await createFixture()
    try {
      const first = createAgent(core)
      const second = core.createAgent({
        displayName: '带推理配置的智能体',
        persona: '',
        model: { provider: 'test', model: 'model', reasoningEffort: 'high' },
        capabilities,
      })
      const missingAgentId = AgentIdSchema.parse('agt_MISSING')
      const missingRevisionId = AgentRevisionIdSchema.parse('arev_MISSING')
      expect(repository.getAgent(missingAgentId)).toBeUndefined()
      expect(repository.listAgents().map(({ definition }) => definition.id)).toEqual([
        first.definition.id,
        second.definition.id,
      ])
      expect(repository.getAgentRevision(missingRevisionId)).toBeUndefined()
      expect(repository.getAgentRevisionByDigest(first.definition.id, 'sha256:missing')).toBeUndefined()
      expect(repository.listAgentRevisions(missingAgentId)).toEqual([])
      expect(repository.getNextAgentRevisionNumber(missingAgentId)).toBe(1)
      expect(repository.getAgentRevision(second.revision.id)?.model.reasoningEffort).toBe('high')

      const revised = core.reviseAgent(first.definition.id, first.revision.id, {
        displayName: '更新后的智能体',
        persona: first.revision.persona,
        model: first.revision.model,
        capabilities,
      })
      expect(repository.listAgentRevisions(first.definition.id)).toHaveLength(2)
      expect(repository.getNextAgentRevisionNumber(first.definition.id)).toBe(3)
      expect(repository.getAgentRevisionByDigest(first.definition.id, revised.revision.contentDigest)).toEqual(
        revised.revision,
      )

      const restored = core.reviseAgent(first.definition.id, revised.revision.id, {
        displayName: first.revision.displayName,
        persona: first.revision.persona,
        model: first.revision.model,
        capabilities,
      })
      expect(restored.revision.id).toBe(first.revision.id)

      const candidate = {
        ...revised.revision,
        id: AgentRevisionIdSchema.parse('arev_CONFLICT'),
        revision: 3,
        displayName: '不会提交的修订',
        contentDigest: 'sha256:conflict',
      }
      expect(() =>
        repository.appendAgentRevision(
          { ...first.definition, currentRevisionId: candidate.id },
          candidate,
          AgentRevisionIdSchema.parse('arev_STALE'),
        ),
      ).toThrow('Agent revision conflict')
      expect(repository.getAgentRevision(candidate.id)).toBeUndefined()

      expect(() => repository.activateAgentRevision(first.definition, second.revision, first.revision.id)).toThrow(
        'does not belong',
      )
      expect(() =>
        repository.activateAgentRevision(first.definition, first.revision, AgentRevisionIdSchema.parse('arev_STALE')),
      ).toThrow('Agent revision conflict')
    } finally {
      database.close()
    }
  })

  it('atomically creates Agent, Revision, current pointer, Channel and Binding', async () => {
    const { database, repository, core, connection } = await createFixture()
    try {
      const committed = core.createAgentWithChannel(
        {
          displayName: '原子智能体',
          persona: '',
          model: { provider: 'test', model: 'model' },
          capabilities,
        },
        {
          connectionId: connection.id,
          kind: 'web',
          platformChannelId: 'fixed-channel',
          triggerPolicy: 'always',
        },
      )
      expect(repository.getBinding(committed.channel.id)).toEqual(committed.binding)
      expect(repository.getAgent(committed.definition.id)?.revision.id).toBe(committed.revision.id)

      expect(() =>
        core.createAgentWithChannel(
          {
            displayName: '冲突智能体',
            persona: '',
            model: { provider: 'test', model: 'model' },
            capabilities,
          },
          {
            connectionId: connection.id,
            kind: 'web',
            platformChannelId: 'fixed-channel',
            triggerPolicy: 'always',
          },
        ),
      ).toThrow()
      expect(database.db.select({ value: count() }).from(agentDefinitions).get()?.value).toBe(1)
    } finally {
      database.close()
    }
  })

  it('tombstones an intelligent-agent while preserving its immutable history and channel facts', async () => {
    const { database, repository, core, connection } = await createFixture()
    try {
      const committed = core.createAgentWithChannel(
        {
          displayName: '待删除智能体',
          persona: '',
          model: { provider: 'test', model: 'model' },
          capabilities,
        },
        {
          connectionId: connection.id,
          kind: 'web',
          platformChannelId: 'tombstone-channel',
          triggerPolicy: 'always',
        },
      )
      const event = appendTextEvent(core, connection.id, committed.channel.id, 'tombstone-event', '保留的频道事实', 10)
      const episodeId = EpisodeIdSchema.parse('eps_TOMBSTONE')
      repository.createEpisode({
        id: episodeId,
        channelId: committed.channel.id,
        agentId: committed.definition.id,
        agentRevisionId: committed.revision.id,
        status: 'opening',
        openedAtEventId: event.id,
        createdAt: 11,
      })
      repository.closeEpisode(episodeId, 'context-cleared', event.id, 12)
      repository.putWorkTreeOrder({
        agentIds: [committed.definition.id],
        channelIdsByAgent: { [committed.definition.id]: [committed.channel.id] },
        unboundChannelIds: [],
      })

      core.deleteAgent(committed.definition.id)

      expect(repository.getAgent(committed.definition.id)).toBeUndefined()
      expect(repository.listAgents()).toEqual([])
      expect(repository.getAgentRevision(committed.revision.id)).toEqual(committed.revision)
      expect(repository.getEpisode(episodeId)).toMatchObject({
        closeReason: 'context-cleared',
        status: 'closed',
      })
      expect(repository.getChannel(committed.channel.id)).toEqual(committed.channel)
      expect(repository.getChannelEvent(event.id)?.searchText).toBe('保留的频道事实')
      expect(repository.getBinding(committed.channel.id)).toBeUndefined()
      expect(repository.getWorkTreeOrder()).toEqual({
        agentIds: [],
        channelIdsByAgent: {},
        unboundChannelIds: [committed.channel.id],
      })
      expect(
        database.db
          .select({ deletedAt: agentDefinitions.deletedAt })
          .from(agentDefinitions)
          .where(eq(agentDefinitions.id, committed.definition.id))
          .get()?.deletedAt,
      ).toBeGreaterThanOrEqual(1000)
    } finally {
      database.close()
    }
  })

  it('tombstones a channel while preserving history and revives an externally rediscovered channel', async () => {
    const { database, repository, core, connection } = await createFixture()
    try {
      const agent = createAgent(core)
      const channel = core.ensureChannel({
        connectionId: connection.id,
        platformChannelId: 'rediscovered-channel',
        kind: 'group',
        displayName: '外部频道',
        observedAt: 10,
      })
      core.createBinding({ channelId: channel.id, agentId: agent.definition.id, triggerPolicy: 'always' })
      const event = appendTextEvent(core, connection.id, channel.id, 'channel-delete-event', '应保留的历史', 11)
      repository.putWorkTreeOrder({
        agentIds: [agent.definition.id],
        channelIdsByAgent: { [agent.definition.id]: [channel.id] },
        unboundChannelIds: [channel.id],
      })

      core.deleteChannel(channel.id)

      expect(repository.getChannel(channel.id)).toBeUndefined()
      expect(repository.getChannelByPlatformId(connection.id, 'rediscovered-channel')).toBeUndefined()
      expect(repository.listChannelIdsByConnection(connection.id)).toEqual([])
      expect(repository.getBinding(channel.id)).toBeUndefined()
      expect(repository.getChannelEvent(event.id)?.searchText).toBe('应保留的历史')
      expect(repository.getWorkTreeOrder()).toEqual({
        agentIds: [agent.definition.id],
        channelIdsByAgent: { [agent.definition.id]: [] },
        unboundChannelIds: [],
      })
      expect(
        database.db.select({ deletedAt: channels.deletedAt }).from(channels).where(eq(channels.id, channel.id)).get()
          ?.deletedAt,
      ).toBeGreaterThanOrEqual(1000)

      const revived = core.ensureChannel({
        connectionId: connection.id,
        platformChannelId: 'rediscovered-channel',
        kind: 'group',
        displayName: '重新发现的外部频道',
        observedAt: 20,
      })
      expect(revived).toMatchObject({ id: channel.id, displayName: '重新发现的外部频道' })
      expect(repository.listChannelIdsByConnection(connection.id)).toEqual([channel.id])
      expect(repository.getChannelEvent(event.id)?.searchText).toBe('应保留的历史')
    } finally {
      database.close()
    }
  })

  it('stores one current Binding per Channel while one Agent can own several Channels', async () => {
    const { database, repository, core, connection } = await createFixture()
    try {
      const firstAgent = createAgent(core)
      const secondAgent = createAgent(core)
      const first = core.createChannel({ connectionId: connection.id, platformChannelId: 'first', kind: 'group' })
      const second = core.createChannel({ connectionId: connection.id, platformChannelId: 'second', kind: 'group' })
      core.createBinding({ channelId: first.id, agentId: firstAgent.definition.id, triggerPolicy: 'always' })
      core.createBinding({ channelId: second.id, agentId: firstAgent.definition.id, triggerPolicy: 'command' })
      core.replaceBinding({ channelId: first.id, agentId: secondAgent.definition.id, triggerPolicy: 'observe-only' })
      expect(repository.getBinding(first.id)).toMatchObject({ agentId: secondAgent.definition.id })
      expect(repository.getBinding(second.id)).toMatchObject({ agentId: firstAgent.definition.id })
      core.clearBinding(first.id)
      expect(repository.getBinding(first.id)).toBeUndefined()
      expect(repository.getBinding(second.id)).toMatchObject({ agentId: firstAgent.definition.id })
      const order = { agentIds: [firstAgent.definition.id], channelIdsByAgent: {}, unboundChannelIds: [first.id] }
      expect(repository.putWorkTreeOrder(order)).toEqual(order)
      expect(repository.getWorkTreeOrder()).toEqual(order)
    } finally {
      database.close()
    }
  })

  it('round-trips optional channel records, cursors, lookups, and database constraints', async () => {
    const { database, repository, core, connection } = await createFixture()
    try {
      const otherConnection = core.createConnection({ adapterKey: 'qq-openclaw', config: { token: 'x' } })
      expect(repository.getConnection(ConnectionIdSchema.parse('con_MISSING'))).toBeUndefined()
      expect(repository.listConnectionIdsByAdapter('web')).toEqual([connection.id])
      expect(repository.listConnectionIdsByAdapter('missing')).toEqual([])

      const channel = core.ensureChannel({
        connectionId: connection.id,
        platformChannelId: 'optional-channel',
        kind: 'web',
        observedAt: 10,
      })
      const updatedChannel = core.ensureChannel({
        connectionId: connection.id,
        platformChannelId: 'optional-channel',
        kind: 'group',
        displayName: '带名称的频道',
        observedAt: 11,
      })
      expect(updatedChannel).toMatchObject({ id: channel.id, kind: 'group', displayName: '带名称的频道' })
      expect(repository.getChannelByPlatformId(connection.id, 'optional-channel')).toEqual(updatedChannel)
      expect(repository.getChannel(ChannelIdSchema.parse('chn_MISSING'))).toBeUndefined()
      expect(repository.getChannelByPlatformId(connection.id, 'missing')).toBeUndefined()
      expect(repository.listChannelIdsByConnection(connection.id)).toEqual([channel.id])
      expect(repository.listChannelIdsByConnection(otherConnection.id)).toEqual([])
      core.updateChannelDisplayName(channel.id, '再次更新')
      expect(repository.getChannel(channel.id)?.displayName).toBe('再次更新')
      expect(() => repository.updateChannelDisplayName(ChannelIdSchema.parse('chn_MISSING'), '不存在')).toThrow(
        'Unknown channel',
      )

      expect(repository.getBinding(channel.id)).toBeUndefined()
      expect(repository.listBindings(channel.id)).toEqual([])
      const agent = createAgent(core)
      core.createBinding({ channelId: channel.id, agentId: agent.definition.id, triggerPolicy: 'always' })
      expect(repository.listBindings(channel.id)).toHaveLength(1)

      const observed = core.observeChannelMember({
        connectionId: connection.id,
        channelId: channel.id,
        platformUserId: 'user-1',
        displayName: '初始显示名',
        observedAt: 12,
      })
      const observedAgain = core.observeChannelMember({
        connectionId: connection.id,
        channelId: channel.id,
        platformUserId: 'user-1',
        displayName: '显示名',
        observedAt: 13,
      })
      expect(observedAgain.identity.id).toBe(observed.identity.id)
      expect(observedAgain.member.id).toBe(observed.member.id)
      expect(repository.getPlatformIdentity(observed.identity.id)?.displayName).toBe('显示名')
      expect(repository.getChannelMember(observed.member.id)?.displayName).toBe('显示名')
      const observedWithoutDisplayName = core.observeChannelMember({
        connectionId: connection.id,
        channelId: channel.id,
        platformUserId: 'user-1',
        observedAt: 14,
      })
      expect(observedWithoutDisplayName.identity).toEqual(observedAgain.identity)
      expect(observedWithoutDisplayName.member).toEqual(observedAgain.member)
      expect(repository.getPlatformIdentity(PlatformIdentityIdSchema.parse('pid_MISSING'))).toBeUndefined()
      expect(repository.getChannelMember(ChannelMemberIdSchema.parse('mbr_MISSING'))).toBeUndefined()
      expect(repository.getChannelMemberByIdentity(channel.id, observed.identity.id)).toEqual(observedAgain.member)
      expect(
        repository.getChannelMemberByIdentity(channel.id, PlatformIdentityIdSchema.parse('pid_MISSING')),
      ).toBeUndefined()

      const firstEvent = core.appendInbound({
        connectionId: connection.id,
        channelId: channel.id,
        adapterKey: 'web',
        platformMessageId: 'platform-in-1',
        kind: 'message-created',
        senderMemberId: observed.member.id,
        parts: [{ type: 'text', text: '第一条' }],
        platformTimestamp: 20,
        receivedAt: 20,
        dedupeKey: 'channel-event-1',
        facts: { source: 'test' },
      }).event
      appendTextEvent(core, connection.id, channel.id, 'channel-event-2', '第二条', 20)
      expect(repository.getChannelEvent(firstEvent.id)).toMatchObject({
        platformMessageId: 'platform-in-1',
        senderMemberId: observed.member.id,
        facts: { source: 'test' },
      })
      expect(repository.getChannelEvent(ChannelEventIdSchema.parse('evt_MISSING'))).toBeUndefined()
      const newest = repository.listChannelEvents(channel.id, { limit: 1 })
      expect(newest).toHaveLength(1)
      const newestEvent = newest[0]
      if (newestEvent === undefined) throw new Error('Expected the newest Channel Event.')
      expect(repository.listChannelEvents(channel.id, { before: newestEvent, limit: 10 })).toHaveLength(1)
      expect(() => repository.listChannelEvents(channel.id, { limit: 0 })).toThrow('Invalid Channel Event limit')
      expect(() => repository.listChannelEvents(channel.id, { limit: 1001 })).toThrow('Invalid Channel Event limit')

      expect(repository.resolvePlatformMessage(connection.id, channel.id, 'platform-in-1')).toEqual({
        logicalMessageId: firstEvent.logicalMessageId,
        authoredByAgent: false,
      })
      expect(repository.resolvePlatformMessage(otherConnection.id, channel.id, 'platform-in-1')).toBeUndefined()
      expect(repository.resolvePlatformMessage(connection.id, channel.id, 'missing')).toBeUndefined()
      expect(repository.resolveLogicalMessagePlatformId(connection.id, channel.id, firstEvent.logicalMessageId)).toBe(
        'platform-in-1',
      )
      expect(
        repository.resolveLogicalMessagePlatformId(
          connection.id,
          channel.id,
          LogicalMessageIdSchema.parse('msg_MISSING'),
        ),
      ).toBeUndefined()
      expect(
        repository.resolveLogicalMessagePlatformId(otherConnection.id, channel.id, firstEvent.logicalMessageId),
      ).toBeUndefined()

      expect(() => repository.createConnection(connection)).toThrow()
      expect(() =>
        core.createChannel({ connectionId: connection.id, platformChannelId: 'optional-channel', kind: 'web' }),
      ).toThrow()
      expect(() =>
        repository.createChannel({
          id: ChannelIdSchema.parse('chn_BADFK'),
          connectionId: ConnectionIdSchema.parse('con_MISSING'),
          platformChannelId: 'bad-fk',
          kind: 'web',
          createdAt: 1,
        }),
      ).toThrow()
      const invalidChannel: Parameters<SqliteCoreRepository['createChannel']>[0] = {
        id: ChannelIdSchema.parse('chn_BADCHECK'),
        connectionId: connection.id,
        platformChannelId: 'bad-check',
        kind: 'web',
        createdAt: 1,
      }
      Object.defineProperty(invalidChannel, 'kind', { value: 'invalid' })
      expect(() => repository.createChannel(invalidChannel)).toThrow()
      const invalidBinding: Parameters<SqliteCoreRepository['replaceBinding']>[0] = {
        channelId: channel.id,
        agentId: agent.definition.id,
        triggerPolicy: 'always',
        processingFeedback: 'auto',
        eventTriggers: [],
        boundAt: 1,
      }
      Object.defineProperty(invalidBinding, 'triggerPolicy', { value: 'invalid' })
      expect(() => repository.replaceBinding(invalidBinding)).toThrow()
    } finally {
      database.close()
    }
  })

  it('lists platform identities once per Connection and retains historical-only users', async () => {
    const { database, repository, core, connection } = await createFixture()
    try {
      const secondConnection = core.createConnection({ adapterKey: 'web', config: {} })
      const firstChannel = core.createChannel({
        connectionId: connection.id,
        platformChannelId: 'group-one',
        kind: 'group',
        displayName: '第一讨论组',
      })
      const secondChannel = core.createChannel({
        connectionId: connection.id,
        platformChannelId: 'group-two',
        kind: 'group',
        displayName: '第二讨论组',
      })
      const otherChannel = core.createChannel({
        connectionId: secondConnection.id,
        platformChannelId: 'group-three',
        kind: 'group',
      })
      const first = core.observeChannelMember({
        connectionId: connection.id,
        channelId: firstChannel.id,
        platformUserId: 'same-account',
        displayName: '成员甲',
        observedAt: 10,
      })
      const sameConnection = core.observeChannelMember({
        connectionId: connection.id,
        channelId: secondChannel.id,
        platformUserId: 'same-account',
        displayName: '成员甲',
        observedAt: 11,
      })
      const differentConnection = core.observeChannelMember({
        connectionId: secondConnection.id,
        channelId: otherChannel.id,
        platformUserId: 'same-account',
        displayName: '成员甲',
        observedAt: 12,
      })
      expect(sameConnection.identity.id).toBe(first.identity.id)
      expect(differentConnection.identity.id).not.toBe(first.identity.id)
      const users = repository.listPlatformUsers()
      const sameConnectionUser = users.find((user) => user.identityId === first.identity.id)
      expect(sameConnectionUser?.historicalOnly).toBe(false)
      expect(sameConnectionUser?.activeChannels.map((channel) => channel.id)).toEqual(
        expect.arrayContaining([firstChannel.id, secondChannel.id]),
      )
      expect(users.find((user) => user.identityId === differentConnection.identity.id)?.historicalOnly).toBe(false)
      core.deleteChannel(otherChannel.id)
      expect(repository.listPlatformUsers()).toContainEqual(
        expect.objectContaining({
          identityId: differentConnection.identity.id,
          activeChannels: [],
          historicalOnly: true,
        }),
      )
    } finally {
      database.close()
    }
  })
})

describe('relations, admissions and outbox', () => {
  it('commits Channel Event and Asset Occurrence atomically and deduplicates replay', async () => {
    const { database, repository, core, connection } = await createFixture()
    try {
      const channel = core.createChannel({ connectionId: connection.id, platformChannelId: 'asset', kind: 'group' })
      const assetId = AssetIdSchema.parse('ast_ASSET1')
      repository.ensureAsset({
        id: assetId,
        contentDigest: `sha256:${'a'.repeat(64)}`,
        byteSize: 4,
        mediaType: 'image/png',
        createdAt: 1,
      })
      const event = {
        connectionId: connection.id,
        channelId: channel.id,
        adapterKey: 'web',
        platformMessageId: 'platform-1',
        kind: 'message-created' as const,
        parts: [{ type: 'image' as const, assetId }],
        platformTimestamp: 10,
        receivedAt: 11,
        dedupeKey: 'asset-event-1',
        assetOccurrences: [{ partIndex: 0, assetId }],
      }
      const first = core.appendInbound(event)
      const replay = core.appendInbound(event)
      expect(first.inserted).toBe(true)
      expect(replay.inserted).toBe(false)
      expect(database.db.select({ value: count() }).from(channelEvents).get()?.value).toBe(1)
      expect(database.db.select({ value: count() }).from(assetOccurrences).get()?.value).toBe(1)
      expect(repository.canAccessAsset(assetId, channel.id)).toBe(true)
      expect(repository.canAccessAsset(assetId, ChannelIdSchema.parse('chn_OTHER'))).toBe(false)
      expect(repository.getAssetById(AssetIdSchema.parse('ast_MISSING'))).toBeUndefined()
      expect(
        repository.ensureAsset({
          id: AssetIdSchema.parse('ast_ASSET2'),
          contentDigest: `sha256:${'a'.repeat(64)}`,
          byteSize: 999,
          mediaType: 'application/octet-stream',
          createdAt: 99,
        }),
      ).toEqual(repository.getAssetById(assetId))

      core.appendInbound({
        connectionId: connection.id,
        channelId: channel.id,
        adapterKey: 'web',
        kind: 'message-created',
        parts: [{ type: 'text', text: '没有资源 occurrence' }],
        platformTimestamp: 12,
        receivedAt: 13,
        dedupeKey: 'plain-event',
      })
      expect(database.db.select({ value: count() }).from(assetOccurrences).get()?.value).toBe(1)
    } finally {
      database.close()
    }
  })

  it('persists activity relationships without rewriting the target message fact', async () => {
    const { database, repository, core, connection } = await createFixture()
    try {
      const channel = core.createChannel({ connectionId: connection.id, platformChannelId: 'activity', kind: 'group' })
      const original = core.appendInbound({
        connectionId: connection.id,
        channelId: channel.id,
        adapterKey: 'web',
        platformMessageId: 'platform-original',
        kind: 'message-created',
        parts: [{ type: 'text', text: '原始事实' }],
        platformTimestamp: 20,
        receivedAt: 20,
        dedupeKey: 'original-event',
      })
      const recalled = core.appendInbound({
        connectionId: connection.id,
        channelId: channel.id,
        adapterKey: 'web',
        kind: 'message-deleted',
        activityType: 'message-recalled',
        targetPlatformMessageId: 'platform-original',
        parts: [{ type: 'rich', adapterKey: 'web', kind: 'message-recalled', summary: '一条消息被撤回。' }],
        platformTimestamp: 21,
        receivedAt: 21,
        dedupeKey: 'recall-event',
      })
      expect(recalled.event).toMatchObject({
        activityType: 'message-recalled',
        targetPlatformMessageId: 'platform-original',
        targetLogicalMessageId: original.event.logicalMessageId,
      })
      expect(repository.getChannelEvent(original.event.id)).toMatchObject({
        kind: 'message-created',
        parts: [{ type: 'text', text: '原始事实' }],
      })
      const feedback = core.appendInbound({
        connectionId: connection.id,
        channelId: channel.id,
        adapterKey: 'web',
        kind: 'control',
        activityType: 'message-feedback-negative',
        targetLogicalMessageId: original.event.logicalMessageId,
        parts: [{ type: 'rich', adapterKey: 'web', kind: 'feedback', summary: '成员提交了负向反馈。' }],
        platformTimestamp: 22,
        receivedAt: 22,
        dedupeKey: 'feedback-event',
      })
      expect(feedback.event.targetLogicalMessageId).toBe(original.event.logicalMessageId)
      const otherChannel = core.createChannel({
        connectionId: connection.id,
        platformChannelId: 'activity-other',
        kind: 'group',
      })
      expect(() =>
        core.appendInbound({
          connectionId: connection.id,
          channelId: otherChannel.id,
          adapterKey: 'web',
          kind: 'control',
          activityType: 'message-feedback-negative',
          targetLogicalMessageId: original.event.logicalMessageId,
          parts: [{ type: 'rich', adapterKey: 'web', kind: 'feedback', summary: '无效跨频道反馈。' }],
          platformTimestamp: 23,
          receivedAt: 23,
          dedupeKey: 'invalid-feedback-event',
        }),
      ).toThrow(/does not belong/u)
    } finally {
      database.close()
    }
  })

  it('returns every unadmitted event beyond the former 100-event window', async () => {
    const { database, repository, core, connection } = await createFixture()
    try {
      const agent = createAgent(core)
      const channel = core.createChannel({ connectionId: connection.id, platformChannelId: 'backlog', kind: 'group' })
      core.createBinding({ channelId: channel.id, agentId: agent.definition.id, triggerPolicy: 'command' })
      for (let index = 0; index < 225; index += 1) {
        core.appendInbound({
          connectionId: connection.id,
          channelId: channel.id,
          adapterKey: 'web',
          platformMessageId: `p-${index}`,
          kind: 'message-created',
          parts: [{ type: 'text', text: `消息 ${index}` }],
          platformTimestamp: index,
          receivedAt: 2000 + index,
          dedupeKey: `event-${index}`,
        })
      }
      expect(repository.listUnadmittedEvents(channel.id, agent.definition.id, 0)).toHaveLength(225)
    } finally {
      database.close()
    }
  })

  it('persists relational Admission events and structured delivery receipts', async () => {
    const { database, repository, core, connection } = await createFixture()
    try {
      const agent = createAgent(core)
      const channel = core.createChannel({ connectionId: connection.id, platformChannelId: 'runtime', kind: 'web' })
      const event = core.appendInbound({
        connectionId: connection.id,
        channelId: channel.id,
        adapterKey: 'web',
        kind: 'message-created',
        parts: [{ type: 'text', text: 'hello' }],
        platformTimestamp: 1,
        receivedAt: 2,
        dedupeKey: 'runtime-event',
      }).event
      const episodeId = EpisodeIdSchema.parse('eps_EPISODE1')
      repository.createEpisode({
        id: episodeId,
        channelId: channel.id,
        agentId: agent.definition.id,
        agentRevisionId: agent.revision.id,
        status: 'opening',
        openedAtEventId: event.id,
        createdAt: 3,
      })
      repository.activateEpisode(episodeId, 'dsh-session-1')
      const admissionId = AdmissionIdSchema.parse('adm_ADMISSION1')
      repository.createAdmission({
        id: admissionId,
        episodeId,
        eventIds: [event.id],
        mode: 'followup',
        state: 'pending',
        createdAt: 4,
      })
      repository.claimAdmission(admissionId)
      repository.completeAdmission(admissionId, 'dsh-message-1', event.id)

      const intentId = OutboundIntentIdSchema.parse('out_INTENT1')
      const deliveryId = PhysicalDeliveryIdSchema.parse('phy_DELIVERY1')
      repository.createOutboundPlan(
        {
          id: intentId,
          logicalMessageId: LogicalMessageIdSchema.parse('msg_OUTBOUND1'),
          agentRevisionId: agent.revision.id,
          episodeId,
          parts: [{ type: 'text', text: 'reply' }],
          state: 'planned',
          createdAt: 5,
        },
        [
          {
            id: deliveryId,
            intentId,
            sequence: 0,
            parts: [{ type: 'text', text: 'reply' }],
            processingFeedbackLeaseId: 'feedback:delivery-fixture',
            state: 'planned',
          },
        ],
      )
      repository.markIntentSending(intentId)
      repository.markDeliverySending(deliveryId)
      repository.recordDeliveryReceipt(deliveryId, { status: 'sent', platformMessageId: 'platform-out-1' }, 6)
      repository.completeOutboundIntent(intentId, 'sent')
      expect(repository.getOutbound(intentId).receipts).toEqual([
        {
          physicalDeliveryId: deliveryId,
          receipt: { status: 'sent', platformMessageId: 'platform-out-1' },
          completedAt: 6,
        },
      ])
      expect(
        database.db.select().from(physicalDeliveries).where(eq(physicalDeliveries.id, deliveryId)).get(),
      ).toMatchObject({
        state: 'sent',
        platformMessageId: 'platform-out-1',
        processingFeedbackLeaseId: 'feedback:delivery-fixture',
      })

      const noIdIntent = OutboundIntentIdSchema.parse('out_INTENTNOID')
      const noIdDelivery = PhysicalDeliveryIdSchema.parse('phy_DELIVERYNOID')
      repository.createOutboundPlan(
        {
          id: noIdIntent,
          logicalMessageId: LogicalMessageIdSchema.parse('msg_OUTBOUNDNOID'),
          agentRevisionId: agent.revision.id,
          episodeId,
          parts: [{ type: 'text', text: 'accepted without id' }],
          state: 'planned',
          createdAt: 7,
        },
        [
          {
            id: noIdDelivery,
            intentId: noIdIntent,
            sequence: 0,
            parts: [{ type: 'text', text: 'accepted without id' }],
            state: 'planned',
          },
        ],
      )
      repository.markIntentSending(noIdIntent)
      repository.markDeliverySending(noIdDelivery)
      repository.recordDeliveryReceipt(noIdDelivery, { status: 'sent' }, 8)
      expect(repository.getOutbound(noIdIntent).receipts).toEqual([
        { physicalDeliveryId: noIdDelivery, receipt: { status: 'sent' }, completedAt: 8 },
      ])
      expect(
        database.db.select().from(physicalDeliveries).where(eq(physicalDeliveries.id, noIdDelivery)).get(),
      ).toMatchObject({ state: 'sent', platformMessageId: null })
    } finally {
      database.close()
    }
  })

  it('persists and resolves logical message identities within one Channel', async () => {
    const fixture = await createFixture()
    let activeDatabase = fixture.database
    try {
      const agent = createAgent(fixture.core)
      const channel = fixture.core.createChannel({
        connectionId: fixture.connection.id,
        platformChannelId: 'logical-message-main',
        kind: 'group',
      })
      const otherChannel = fixture.core.createChannel({
        connectionId: fixture.connection.id,
        platformChannelId: 'logical-message-other',
        kind: 'group',
      })
      const inbound = fixture.core.appendInbound({
        connectionId: fixture.connection.id,
        channelId: channel.id,
        adapterKey: 'web',
        kind: 'message-created',
        parts: [{ type: 'text', text: '同频道引用目标' }],
        platformTimestamp: 10,
        receivedAt: 10,
        dedupeKey: 'logical-message-inbound',
      }).event
      const otherInbound = fixture.core.appendInbound({
        connectionId: fixture.connection.id,
        channelId: otherChannel.id,
        adapterKey: 'web',
        kind: 'message-created',
        parts: [{ type: 'text', text: '其他频道内容' }],
        platformTimestamp: 11,
        receivedAt: 11,
        dedupeKey: 'logical-message-other',
      }).event
      const episodeId = EpisodeIdSchema.parse('eps_LOGICALMESSAGE')
      fixture.repository.createEpisode({
        id: episodeId,
        channelId: channel.id,
        agentId: agent.definition.id,
        agentRevisionId: agent.revision.id,
        status: 'opening',
        openedAtEventId: inbound.id,
        createdAt: 12,
      })
      const outboundLogicalMessageId = LogicalMessageIdSchema.parse('msg_LOGICALOUTBOUND')
      fixture.repository.createOutboundPlan(
        {
          id: OutboundIntentIdSchema.parse('out_LOGICALOUTBOUND'),
          logicalMessageId: outboundLogicalMessageId,
          agentRevisionId: agent.revision.id,
          episodeId,
          parts: [{ type: 'text', text: '智能体历史发言' }],
          state: 'planned',
          createdAt: 13,
        },
        [],
      )

      activeDatabase.close()
      activeDatabase = await openMigratedCoreDatabase(path.join(fixture.directory, 'core.sqlite'))
      const reopened = new SqliteCoreRepository(activeDatabase)
      expect(reopened.listChannelHistory(channel.id, { limit: 10 })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: 'channel-event', logicalMessageId: inbound.logicalMessageId }),
          expect.objectContaining({ source: 'outbound-intent', logicalMessageId: outboundLogicalMessageId }),
        ]),
      )
      expect(reopened.getChannelHistoryEntryByLogicalMessageId(channel.id, inbound.logicalMessageId)).toMatchObject({
        source: 'channel-event',
        logicalMessageId: inbound.logicalMessageId,
        parts: [{ type: 'text', text: '同频道引用目标' }],
      })
      expect(reopened.getChannelHistoryEntryByLogicalMessageId(channel.id, outboundLogicalMessageId)).toMatchObject({
        source: 'outbound-intent',
        logicalMessageId: outboundLogicalMessageId,
        parts: [{ type: 'text', text: '智能体历史发言' }],
      })
      expect(
        reopened.getChannelHistoryEntryByLogicalMessageId(channel.id, otherInbound.logicalMessageId),
      ).toBeUndefined()
      expect(
        reopened.getChannelHistoryEntryByLogicalMessageId(
          channel.id,
          LogicalMessageIdSchema.parse('msg_LOGICALMISSING'),
        ),
      ).toBeUndefined()
    } finally {
      activeDatabase.close()
    }
  })

  it('searches literal percent, underscore and Chinese text within one Channel only', async () => {
    const { database, repository, core, connection } = await createFixture()
    try {
      const first = core.createChannel({ connectionId: connection.id, platformChannelId: 'search-1', kind: 'web' })
      const second = core.createChannel({ connectionId: connection.id, platformChannelId: 'search-2', kind: 'web' })
      for (const [channel, text, key] of [
        [first, '进度 100%_完成', 'first'],
        [second, '进度 100%_完成', 'second'],
      ] as const) {
        core.appendInbound({
          connectionId: connection.id,
          channelId: channel.id,
          adapterKey: 'web',
          kind: 'message-created',
          parts: [{ type: 'text', text }],
          platformTimestamp: 1,
          receivedAt: 1,
          dedupeKey: key,
        })
      }
      expect(repository.searchChannelHistory(first.id, '100%_完')).toHaveLength(1)
      expect(repository.searchChannelHistory(first.id, '不存在')).toHaveLength(0)
    } finally {
      database.close()
    }
  })

  it('covers episode lifecycle conflicts, admissions, handoff links, and recovery queries', async () => {
    const { database, repository, core, connection } = await createFixture()
    try {
      const agent = createAgent(core)
      const channel = core.createChannel({
        connectionId: connection.id,
        platformChannelId: 'runtime-lifecycle',
        kind: 'web',
      })
      const openedEvent = appendTextEvent(core, connection.id, channel.id, 'lifecycle-open', 'open', 1)
      const episodeId = EpisodeIdSchema.parse('eps_LIFECYCLE1')
      repository.createEpisode({
        id: episodeId,
        channelId: channel.id,
        agentId: agent.definition.id,
        agentRevisionId: agent.revision.id,
        status: 'opening',
        openedAtEventId: openedEvent.id,
        createdAt: 2,
      })
      expect(repository.getEpisode(EpisodeIdSchema.parse('eps_MISSING'))).toBeUndefined()
      expect(repository.getActiveEpisode(channel.id, agent.definition.id)?.status).toBe('opening')
      expect(repository.listRecoverableEpisodes()).toHaveLength(1)
      expect(repository.listActiveEpisodesForAgent(agent.definition.id)).toEqual([])

      const active = repository.activateEpisode(episodeId, 'session-lifecycle')
      expect(active).toMatchObject({ status: 'active', dshSessionId: 'session-lifecycle' })
      expect(repository.getActiveEpisode(channel.id, agent.definition.id)?.id).toBe(episodeId)
      expect(repository.listActiveEpisodesForAgent(agent.definition.id)).toHaveLength(1)
      expect(() => repository.activateEpisode(episodeId, 'session-again')).toThrow('Episode is not opening')

      const revised = core.reviseAgent(agent.definition.id, agent.revision.id, {
        displayName: '生命周期新版本',
        persona: agent.revision.persona,
        model: agent.revision.model,
        capabilities,
      })
      expect(repository.updateEpisodeRevision(episodeId, agent.revision.id, revised.revision.id).agentRevisionId).toBe(
        revised.revision.id,
      )
      expect(() => repository.updateEpisodeRevision(episodeId, agent.revision.id, agent.revision.id)).toThrow(
        'Episode Revision transition conflict',
      )
      expect(() => repository.failEpisode(episodeId)).toThrow('Episode is not opening')

      const closeEvent = appendTextEvent(core, connection.id, channel.id, 'lifecycle-close', 'close', 3)
      const closed = repository.closeEpisode(episodeId, 'manual', closeEvent.id, 4)
      expect(closed).toMatchObject({
        status: 'closed',
        closedAtEventId: closeEvent.id,
        closedAt: 4,
        closeReason: 'manual',
      })
      expect(repository.getActiveEpisode(channel.id, agent.definition.id)).toBeUndefined()
      expect(repository.listRecoverableEpisodes()).toEqual([])
      expect(() => repository.closeEpisode(episodeId, 'manual', closeEvent.id, 5)).toThrow('Episode is not live')

      const failedEpisodeId = EpisodeIdSchema.parse('eps_FAILED1')
      repository.createEpisode({
        id: failedEpisodeId,
        channelId: channel.id,
        agentId: agent.definition.id,
        agentRevisionId: revised.revision.id,
        status: 'opening',
        openedAtEventId: closeEvent.id,
        createdAt: 5,
      })
      repository.failEpisode(failedEpisodeId)
      expect(repository.getEpisode(failedEpisodeId)?.status).toBe('failed')
      expect(() => repository.failEpisode(failedEpisodeId)).toThrow('Episode is not opening')

      const admissionEvent = appendTextEvent(core, connection.id, channel.id, 'lifecycle-admission', 'admit', 6)
      const admissionId = AdmissionIdSchema.parse('adm_LIFECYCLE1')
      expect(() =>
        repository.createAdmission({
          id: AdmissionIdSchema.parse('adm_EMPTY'),
          episodeId,
          eventIds: [],
          mode: 'followup',
          state: 'pending',
          createdAt: 7,
        }),
      ).toThrow('at least one Event')
      repository.createAdmission({
        id: admissionId,
        episodeId,
        eventIds: [admissionEvent.id],
        mode: 'inject',
        state: 'pending',
        createdAt: 8,
      })
      expect(repository.listRecoverableAdmissions(episodeId)).toHaveLength(1)
      expect(repository.listRecoverableAdmissions(EpisodeIdSchema.parse('eps_MISSING'))).toEqual([])
      repository.claimAdmission(admissionId)
      expect(repository.listRecoverableAdmissions(episodeId)).toHaveLength(1)
      expect(() => repository.claimAdmission(admissionId)).toThrow('Admission is not pending')
      repository.completeAdmission(admissionId, 'dsh-message-lifecycle', admissionEvent.id)
      expect(repository.listRecoverableAdmissions(episodeId)).toEqual([])
      expect(
        repository.listUnadmittedEvents(channel.id, agent.definition.id, 0).some(({ id }) => id === admissionEvent.id),
      ).toBe(false)
      expect(() => repository.completeAdmission(admissionId, 'dsh-message-again', admissionEvent.id)).toThrow(
        'Admission is not claimed',
      )
      expect(() =>
        repository.completeAdmission(AdmissionIdSchema.parse('adm_MISSING'), 'dsh-message-missing', admissionEvent.id),
      ).toThrow('Unknown Admission')

      expect(repository.getEpisodeHandoffTo(episodeId)).toBeUndefined()
      const rolloverFromId = EpisodeIdSchema.parse('eps_ROLLOVERFROM')
      repository.createEpisode({
        id: rolloverFromId,
        channelId: channel.id,
        agentId: agent.definition.id,
        agentRevisionId: revised.revision.id,
        status: 'opening',
        openedAtEventId: closeEvent.id,
        createdAt: 9,
      })
      repository.activateEpisode(rolloverFromId, 'session-rollover-from')
      const rolloverToId = EpisodeIdSchema.parse('eps_ROLLOVERTO')
      const handoffId = EpisodeHandoffIdSchema.parse('hof_LIFECYCLE1')
      repository.commitEpisodeRollover({
        fromEpisodeId: rolloverFromId,
        reason: 'incompatible-revision',
        closedAtEventId: closeEvent.id,
        closedAt: 10,
        nextEpisode: {
          id: rolloverToId,
          channelId: channel.id,
          agentId: agent.definition.id,
          agentRevisionId: revised.revision.id,
          status: 'opening',
          openedAtEventId: admissionEvent.id,
          createdAt: 11,
        },
        handoff: {
          id: handoffId,
          fromEpisodeId: rolloverFromId,
          toEpisodeId: rolloverToId,
          sourceEventIds: [openedEvent.id],
          recentEventIds: [admissionEvent.id],
          summary: '生命周期摘要',
          provider: 'test-provider',
          model: 'test-model',
          createdAt: 12,
        },
      })
      expect(repository.getEpisode(rolloverFromId)?.status).toBe('closed')
      expect(repository.getEpisodeHandoffTo(rolloverToId)).toMatchObject({
        id: handoffId,
        sourceEventIds: [openedEvent.id],
        recentEventIds: [admissionEvent.id],
      })
      expect(() =>
        repository.commitEpisodeRollover({
          fromEpisodeId: rolloverFromId,
          reason: 'manual',
          closedAtEventId: closeEvent.id,
          closedAt: 13,
          nextEpisode: {
            id: EpisodeIdSchema.parse('eps_ROLLOVERCONFLICT'),
            channelId: channel.id,
            agentId: agent.definition.id,
            agentRevisionId: revised.revision.id,
            status: 'opening',
            openedAtEventId: admissionEvent.id,
            createdAt: 14,
          },
          handoff: {
            id: EpisodeHandoffIdSchema.parse('hof_ROLLOVERCONFLICT'),
            fromEpisodeId: rolloverFromId,
            toEpisodeId: EpisodeIdSchema.parse('eps_ROLLOVERCONFLICT'),
            sourceEventIds: [],
            recentEventIds: [],
            summary: '',
            provider: 'test-provider',
            model: 'test-model',
            createdAt: 15,
          },
        }),
      ).toThrow('Episode rollover conflict')
    } finally {
      database.close()
    }
  })

  it('loads, merges, clears, and recovers connection state values', async () => {
    const { directory, database, repository, connection } = await createFixture()
    const filename = path.join(directory, 'core.sqlite')
    try {
      const missingConnectionId = ConnectionIdSchema.parse('con_MISSING')
      expect(await repository.load(missingConnectionId, 'missing')).toBeUndefined()
      await repository.clear(missingConnectionId, 'missing')
      await repository.save(connection.id, 'first', { nested: true }, 20)
      expect(await repository.load(connection.id, 'first')).toEqual({ nested: true })
      expect(await repository.load(connection.id, 'missing')).toBeUndefined()
      await repository.save(connection.id, 'second', ['value'], 21)
      expect(await repository.load(connection.id, 'second')).toEqual(['value'])
      await repository.clear(connection.id, 'first')
      expect(await repository.load(connection.id, 'first')).toBeUndefined()
      expect(await repository.load(connection.id, 'second')).toEqual(['value'])
      await repository.clear(connection.id, 'missing')

      database.close()
      mutateSqlite(filename, 'UPDATE connection_state SET state = ? WHERE connection_id = ?', '[]', connection.id)
      const reopened = await openMigratedCoreDatabase(filename)
      try {
        const reopenedRepository = new SqliteCoreRepository(reopened)
        expect(await reopenedRepository.load(connection.id, 'second')).toBeUndefined()
        await reopenedRepository.clear(connection.id, 'second')
        await reopenedRepository.save(connection.id, 'recovered', 'value', 22)
        expect(await reopenedRepository.load(connection.id, 'recovered')).toBe('value')
      } finally {
        reopened.close()
      }
    } finally {
      // The database is deliberately closed before corruption; this keeps the mutation outside the live connection.
      try {
        database.close()
      } catch {
        // Already closed by the corruption setup.
      }
    }
  })

  it('persists sent, failed, unknown, and partially-sent deliveries with recovery guards', async () => {
    const { database, repository, core, connection } = await createFixture()
    try {
      const agent = createAgent(core)
      const channel = core.createChannel({
        connectionId: connection.id,
        platformChannelId: 'outbox-cases',
        kind: 'web',
      })
      const openedEvent = appendTextEvent(core, connection.id, channel.id, 'outbox-open', 'history start', 1)
      const episodeId = EpisodeIdSchema.parse('eps_OUTBOXCASES')
      repository.createEpisode({
        id: episodeId,
        channelId: channel.id,
        agentId: agent.definition.id,
        agentRevisionId: agent.revision.id,
        status: 'active',
        dshSessionId: 'session-outbox-cases',
        openedAtEventId: openedEvent.id,
        createdAt: 2,
      })

      const failedIntentId = OutboundIntentIdSchema.parse('out_FAILEDCASE')
      const failedDeliveryId = PhysicalDeliveryIdSchema.parse('phy_FAILEDCASE')
      repository.createOutboundPlan(
        {
          id: failedIntentId,
          logicalMessageId: LogicalMessageIdSchema.parse('msg_FAILEDCASE'),
          agentRevisionId: agent.revision.id,
          episodeId,
          sourceTurnId: 'turn-1',
          parts: [{ type: 'text', text: 'failed delivery' }],
          replyTo: 'reply-1',
          clientRequestId: 'request-failed',
          state: 'planned',
          createdAt: 3,
        },
        [
          {
            id: failedDeliveryId,
            intentId: failedIntentId,
            sequence: 0,
            parts: [{ type: 'text', text: 'failed delivery' }],
            adapterContext: { attempt: 1 },
            state: 'planned',
          },
        ],
      )
      expect(repository.getOutbound(failedIntentId)).toMatchObject({
        intent: { sourceTurnId: 'turn-1', replyTo: 'reply-1', clientRequestId: 'request-failed' },
        deliveries: [{ state: 'planned', adapterContext: { attempt: 1 } }],
        receipts: [],
      })
      expect(repository.findOutboundByClientRequest(agent.definition.id, channel.id, 'request-failed')?.intent.id).toBe(
        failedIntentId,
      )
      expect(repository.findOutboundByClientRequest(agent.definition.id, channel.id, 'missing')).toBeUndefined()
      expect(repository.listUnsettledOutboundIds()).toContain(failedIntentId)
      repository.markIntentSending(failedIntentId)
      repository.markDeliverySending(failedDeliveryId)
      expect(repository.getOutbound(failedIntentId).receipts).toEqual([])
      repository.recordDeliveryReceipt(
        failedDeliveryId,
        { status: 'failed', failure: { kind: 'transient', message: 'try again', retryAfterMs: 250 } },
        4,
      )
      expect(repository.getOutbound(failedIntentId).deliveries[0]).toMatchObject({
        state: 'failed',
        receipt: { status: 'failed', failure: { kind: 'transient', message: 'try again', retryAfterMs: 250 } },
        completedAt: 4,
      })
      repository.completeOutboundIntent(failedIntentId, 'failed')
      expect(repository.getOutbound(failedIntentId).intent.state).toBe('failed')
      expect(() => repository.completeOutboundIntent(failedIntentId, 'sent')).toThrow('not sending')
      expect(() =>
        repository.recordDeliveryReceipt(failedDeliveryId, { status: 'unknown', message: 'late' }, 5),
      ).toThrow('not sending')

      const unknownIntentId = OutboundIntentIdSchema.parse('out_UNKNOWNCASE')
      const unknownDeliveryId = PhysicalDeliveryIdSchema.parse('phy_UNKNOWNCASE')
      repository.createOutboundPlan(
        {
          id: unknownIntentId,
          logicalMessageId: LogicalMessageIdSchema.parse('msg_UNKNOWNCASE'),
          agentRevisionId: agent.revision.id,
          episodeId,
          parts: [{ type: 'text', text: 'unknown delivery' }],
          state: 'planned',
          createdAt: 5,
        },
        [{ id: unknownDeliveryId, intentId: unknownIntentId, sequence: 0, parts: [], state: 'planned' }],
      )
      repository.markIntentSending(unknownIntentId)
      repository.markDeliverySending(unknownDeliveryId)
      repository.recordDeliveryReceipt(unknownDeliveryId, { status: 'unknown', message: '结果未知' }, 6)
      expect(repository.getOutbound(unknownIntentId).receipts[0]).toMatchObject({
        receipt: { status: 'unknown', message: '结果未知' },
        completedAt: 6,
      })
      repository.completeOutboundIntent(unknownIntentId, 'unknown')

      const partialIntentId = OutboundIntentIdSchema.parse('out_PARTIALCASE')
      const sentDeliveryId = PhysicalDeliveryIdSchema.parse('phy_PARTIALSENT')
      const partialFailedDeliveryId = PhysicalDeliveryIdSchema.parse('phy_PARTIALFAILED')
      repository.createOutboundPlan(
        {
          id: partialIntentId,
          logicalMessageId: LogicalMessageIdSchema.parse('msg_PARTIALCASE'),
          agentRevisionId: agent.revision.id,
          episodeId,
          parts: [{ type: 'text', text: 'partial needle' }],
          state: 'planned',
          createdAt: 7,
        },
        [
          { id: sentDeliveryId, intentId: partialIntentId, sequence: 0, parts: [], state: 'planned' },
          { id: partialFailedDeliveryId, intentId: partialIntentId, sequence: 1, parts: [], state: 'planned' },
        ],
      )
      repository.markIntentSending(partialIntentId)
      repository.markDeliverySending(sentDeliveryId)
      repository.markDeliverySending(partialFailedDeliveryId)
      repository.recordDeliveryReceipt(
        sentDeliveryId,
        { status: 'sent', platformMessageId: 'platform-partial', capabilityOutcomes: { text: true } },
        8,
      )
      repository.recordDeliveryReceipt(
        partialFailedDeliveryId,
        { status: 'failed', failure: { kind: 'permanent', message: 'rejected' } },
        9,
      )
      repository.completeOutboundIntent(partialIntentId, 'partially-sent')
      expect(repository.getOutbound(partialIntentId).receipts).toHaveLength(2)
      expect(repository.resolvePlatformMessage(connection.id, channel.id, 'platform-partial')).toEqual({
        logicalMessageId: LogicalMessageIdSchema.parse('msg_PARTIALCASE'),
        authoredByAgent: true,
      })
      expect(
        repository.resolveLogicalMessagePlatformId(
          connection.id,
          channel.id,
          LogicalMessageIdSchema.parse('msg_PARTIALCASE'),
        ),
      ).toBe('platform-partial')
      expect(repository.listUnsettledOutboundIds()).toEqual([])

      const emptyIntentId = OutboundIntentIdSchema.parse('out_EMPTYCASE')
      repository.createOutboundPlan(
        {
          id: emptyIntentId,
          logicalMessageId: LogicalMessageIdSchema.parse('msg_EMPTYCASE'),
          agentRevisionId: agent.revision.id,
          episodeId,
          parts: [],
          state: 'planned',
          createdAt: 10,
        },
        [],
      )
      expect(repository.getOutbound(emptyIntentId).deliveries).toEqual([])
      expect(repository.getOutbound(emptyIntentId).receipts).toEqual([])
      const invalidSettledState = z
        .custom<Parameters<SqliteCoreRepository['completeOutboundIntent']>[1]>((value) => value === 'invalid')
        .parse('invalid')
      expect(() => repository.completeOutboundIntent(emptyIntentId, invalidSettledState)).toThrow(
        'Invalid settled state',
      )
      expect(() => repository.markIntentSending(OutboundIntentIdSchema.parse('out_MISSING'))).toThrow('not planned')
      expect(() => repository.markDeliverySending(PhysicalDeliveryIdSchema.parse('phy_MISSING'))).toThrow('not planned')
      expect(() => repository.getOutbound(OutboundIntentIdSchema.parse('out_MISSING'))).toThrow(
        'Unknown Outbound Intent',
      )

      const invalidIntent = OutboundIntentIdSchema.parse('out_INVALIDCONSTRAINT')
      expect(() =>
        repository.createOutboundPlan(
          {
            id: invalidIntent,
            logicalMessageId: LogicalMessageIdSchema.parse('msg_INVALIDCONSTRAINT'),
            agentRevisionId: agent.revision.id,
            episodeId,
            parts: [],
            state: 'planned',
            createdAt: 16,
          },
          [
            {
              id: PhysicalDeliveryIdSchema.parse('phy_INVALIDCONSTRAINT'),
              intentId: invalidIntent,
              sequence: -1,
              parts: [],
              state: 'planned',
            },
          ],
        ),
      ).toThrow()
      expect(() =>
        repository.createOutboundPlan(
          {
            id: OutboundIntentIdSchema.parse('out_DUPLICATEDELIVERY'),
            logicalMessageId: LogicalMessageIdSchema.parse('msg_DUPLICATEDELIVERY'),
            agentRevisionId: agent.revision.id,
            episodeId,
            parts: [],
            state: 'planned',
            createdAt: 17,
          },
          [
            {
              id: PhysicalDeliveryIdSchema.parse('phy_DUPLICATE1'),
              intentId: OutboundIntentIdSchema.parse('out_DUPLICATEDELIVERY'),
              sequence: 0,
              parts: [],
              state: 'planned',
            },
            {
              id: PhysicalDeliveryIdSchema.parse('phy_DUPLICATE2'),
              intentId: OutboundIntentIdSchema.parse('out_DUPLICATEDELIVERY'),
              sequence: 0,
              parts: [],
              state: 'planned',
            },
          ],
        ),
      ).toThrow()

      const historyBeforeAdmission = repository.listEpisodeHistory(episodeId)
      expect(historyBeforeAdmission).toHaveLength(4)
      expect(historyBeforeAdmission.every((entry) => entry.source === 'outbound-intent')).toBe(true)
      expect(repository.listEpisodeHistory(EpisodeIdSchema.parse('eps_MISSING'))).toEqual([])
      const historyAdmissionId = AdmissionIdSchema.parse('adm_OUTBOXHISTORY')
      repository.createAdmission({
        id: historyAdmissionId,
        episodeId,
        eventIds: [openedEvent.id],
        mode: 'followup',
        state: 'pending',
        createdAt: 11,
      })
      repository.claimAdmission(historyAdmissionId)
      repository.completeAdmission(historyAdmissionId, 'dsh-history', openedEvent.id)
      expect(repository.listEpisodeHistory(episodeId).map((entry) => entry.source)).toEqual([
        'outbound-intent',
        'outbound-intent',
        'outbound-intent',
        'outbound-intent',
        'channel-event',
      ])

      for (let index = 0; index < 105; index += 1) {
        appendTextEvent(core, connection.id, channel.id, `history-${index}`, `ordinary ${index}`, 100 + index)
      }
      appendTextEvent(core, connection.id, channel.id, 'history-needle', 'old NEEDLE text', 2)
      const history = repository.listChannelHistory(channel.id, { limit: 100 })
      expect(history).toHaveLength(100)
      expect(repository.listChannelHistory(channel.id, { before: history.at(-1)!, limit: 100 })).toHaveLength(11)
      expect(() => repository.listChannelHistory(channel.id, { limit: 0 })).toThrow('History limit')
      expect(() => repository.listChannelHistory(channel.id, { limit: 101 })).toThrow('History limit')
      expect(repository.searchChannelHistory(channel.id, '  NEEDLE  ', { limit: 1 })).toHaveLength(1)
      expect(repository.searchChannelHistory(channel.id, 'partial needle')).toHaveLength(1)
      expect(repository.searchChannelHistory(channel.id, '   ')).toEqual([])
      expect(() => repository.searchChannelHistory(channel.id, 'needle', { limit: 101 })).toThrow('History limit')
    } finally {
      database.close()
    }
  })
})

describe('Extension and backup', () => {
  it('preserves Host UI page identity while atomically updating shared order and visibility', async () => {
    const { database, repository } = await createFixture()
    try {
      const extensionId = ExtensionIdSchema.parse('ext_HOSTUI')
      const firstRevisionId = ExtensionRevisionIdSchema.parse('xrv_HOSTUIONE')
      const secondRevisionId = ExtensionRevisionIdSchema.parse('xrv_HOSTUITWO')
      repository.saveExtensionRevision({
        extension: {
          id: extensionId,
          scope: 'host-ui',
          slug: 'host-ui-test',
          displayName: '页面扩展',
          description: '',
          createdAt: 1,
        },
        revision: {
          id: firstRevisionId,
          extensionId,
          revisionNumber: 1,
          contentDigest: 'a'.repeat(64),
          payloadDigest: 'b'.repeat(64),
          createdAt: 1,
        },
      })
      repository.saveExtensionRevision({
        extension: {
          id: extensionId,
          scope: 'host-ui',
          slug: 'host-ui-test',
          displayName: '页面扩展',
          description: '',
          createdAt: 1,
        },
        revision: {
          id: secondRevisionId,
          extensionId,
          revisionNumber: 2,
          contentDigest: 'c'.repeat(64),
          payloadDigest: 'd'.repeat(64),
          createdAt: 2,
        },
      })
      let sequence = 0
      const first = repository.replaceHostUiExtensionPages({
        extensionId,
        revisionId: firstRevisionId,
        pages: [
          {
            kind: 'host-page',
            entryId: 'overview',
            title: '概览',
            icon: { kind: 'host-icon', name: 'layout-dashboard' },
            objectPane: 'hidden',
            startPath: '',
          },
        ],
        clientBuildKey: 'e'.repeat(64),
        now: 10,
        nextPageInstanceId: () => HostUiPageInstanceIdSchema.parse(`hup_PAGE${++sequence}`),
      })
      expect(first).toHaveLength(1)
      const pageInstanceId = first[0]!.pageInstanceId
      const preferenceRevision = repository.getHostUiPreferencesRevision()
      expect(
        repository.updateHostUiPagePreferences({
          expectedRevision: preferenceRevision,
          entries: [{ pageInstanceId, visible: false }],
          now: 11,
        }),
      ).toBe(preferenceRevision + 1)
      expect(() =>
        repository.updateHostUiPagePreferences({
          expectedRevision: preferenceRevision,
          entries: [{ pageInstanceId, visible: true }],
          now: 12,
        }),
      ).toThrow('已被其他客户端更新')
      const updated = repository.replaceHostUiExtensionPages({
        extensionId,
        revisionId: secondRevisionId,
        pages: [
          {
            kind: 'host-page',
            entryId: 'overview',
            title: '项目概览',
            icon: { kind: 'host-icon', name: 'layout-dashboard' },
            objectPane: 'navigation',
            startPath: 'projects',
          },
        ],
        clientBuildKey: 'f'.repeat(64),
        now: 13,
        nextPageInstanceId: () => HostUiPageInstanceIdSchema.parse(`hup_PAGE${++sequence}`),
      })
      expect(updated[0]).toMatchObject({ pageInstanceId, visible: false, title: '项目概览' })
      expect(repository.getHostUiDiagnostic(pageInstanceId)).toBeUndefined()
      repository.upsertHostUiDiagnostic({ pageInstanceId, status: 'ready', observedAt: 14 })
      expect(repository.getHostUiDiagnostic(pageInstanceId)).toMatchObject({ status: 'ready' })
      repository.upsertHostUiDiagnostic({ pageInstanceId, status: 'rpc-failed', message: '调用失败', observedAt: 15 })
      expect(repository.getHostUiDiagnostic(pageInstanceId)).toMatchObject({ message: '调用失败' })

      const ownerKey = `extension:${extensionId}`
      expect(repository.getHostUiPermissionGrant(ownerKey)).toBeUndefined()
      repository.upsertHostUiPermissionGrant({
        ownerKey,
        artifactDigest: 'd'.repeat(64),
        permissionDigest: 'e'.repeat(64),
        declaration: { permissions: ['agents.read'], networkOrigins: [] },
        approvedAt: 15,
      })
      expect(repository.getHostUiPermissionGrant(ownerKey)).toMatchObject({ artifactDigest: 'd'.repeat(64) })
      repository.deleteHostUiPermissionGrant(ownerKey)
      expect(repository.getHostUiPermissionGrant(ownerKey)).toBeUndefined()

      const replaced = repository.replaceHostUiExtensionPages({
        extensionId,
        revisionId: secondRevisionId,
        pages: [
          {
            kind: 'host-page',
            entryId: 'reports',
            title: '报表',
            icon: { kind: 'host-icon', name: 'bar-chart' },
            objectPane: 'hidden',
            startPath: 'daily',
          },
        ],
        clientBuildKey: 'f'.repeat(64),
        now: 16,
        nextPageInstanceId: () => HostUiPageInstanceIdSchema.parse(`hup_PAGE${++sequence}`),
      })
      expect(replaced[0]?.pageInstanceId).not.toBe(pageInstanceId)
      repository.replaceHostUiExtensionPages({
        extensionId,
        revisionId: secondRevisionId,
        pages: [],
        clientBuildKey: 'f'.repeat(64),
        now: 17,
        nextPageInstanceId: () => HostUiPageInstanceIdSchema.parse(`hup_PAGE${++sequence}`),
      })
      expect(repository.listHostUiPageEntries()).toEqual([])

      const dshEntryId = DshPluginEntryIdSchema.parse('dse_HOSTUI')
      const dshPages = repository.replaceHostUiDshPages({
        entryId: dshEntryId,
        artifactDigest: 'a'.repeat(64),
        pages: [
          {
            kind: 'host-page',
            entryId: 'dsh-overview',
            title: 'DSH 概览',
            icon: { kind: 'host-icon', name: 'puzzle' },
            objectPane: 'navigation',
            startPath: '',
          },
        ],
        clientBuildKey: 'b'.repeat(64),
        now: 18,
        nextPageInstanceId: () => HostUiPageInstanceIdSchema.parse(`hup_PAGE${++sequence}`),
      })
      expect(dshPages[0]?.owner).toMatchObject({ kind: 'dsh-plugin', entryId: dshEntryId })
      repository.deleteHostUiDshPages(dshEntryId)
      expect(repository.listHostUiPageEntries()).toEqual([])
    } finally {
      database.close()
    }
  })

  it('keeps historical Extension verification evidence readable after a DSH upgrade', async () => {
    const { database, repository } = await createFixture()
    try {
      const extensionId = ExtensionIdSchema.parse('ext_HISTORICAL')
      const revisionId = ExtensionRevisionIdSchema.parse('xrv_HISTORICAL')
      repository.saveExtensionRevision({
        extension: {
          id: extensionId,
          scope: 'agent',
          slug: 'historical-extension',
          displayName: '历史验证扩展',
          description: '',
          createdAt: 1,
        },
        revision: {
          id: revisionId,
          extensionId,
          revisionNumber: 1,
          contentDigest: 'sha256:historical',
          payloadDigest: 'sha256:historical',
          createdAt: 1,
        },
        verification: {
          revisionId,
          dshVersion: '0.1.1-rc.1',
          contractVersion: 'nekro-nxt-extension-v1',
          origin: {
            episodeId: 'eps_history',
            pluginId: 'plugin_history',
            packageId: 'pkg_history',
            pluginRunId: 'run_history',
          },
          verifiedAt: 1,
          hostBuild: { built: true, buildKey: 'host-history' },
          clientBuild: { built: false, buildKey: 'client-history' },
          toolInvocations: [],
          rpcMethods: [],
          renderedSlots: [],
        },
      })

      expect(repository.getExtensionRevisionVerification(revisionId)).toMatchObject({
        revisionId,
        dshVersion: '0.1.1-rc.1',
      })
    } finally {
      database.close()
    }
  })

  it('stores one current Activation per Agent and Extension without transitional rows', async () => {
    const { database, repository, core } = await createFixture()
    try {
      const firstAgent = createAgent(core)
      const secondAgent = createAgent(core)
      const extensionId = ExtensionIdSchema.parse('ext_EXTENSION1')
      const revisionId = ExtensionRevisionIdSchema.parse('xrv_REVISION1')
      repository.saveExtensionRevision({
        extension: {
          id: extensionId,
          scope: 'agent',
          slug: 'test-extension',
          displayName: '测试扩展',
          description: '',
          createdByAgentId: firstAgent.definition.id,
          createdAt: 1,
        },
        revision: {
          id: revisionId,
          extensionId,
          revisionNumber: 1,
          contentDigest: 'sha256:test',
          payloadDigest: 'sha256:test',
          createdAt: 1,
        },
      })
      repository.upsertActivation({
        agentId: firstAgent.definition.id,
        extensionId,
        extensionRevisionId: revisionId,
        config: { first: true },
        activatedAt: 2,
      })
      repository.upsertActivation({
        agentId: secondAgent.definition.id,
        extensionId,
        extensionRevisionId: revisionId,
        config: { second: true },
        activatedAt: 3,
      })
      expect(repository.listActivations()).toHaveLength(2)
      repository.deleteActivation(firstAgent.definition.id, extensionId)
      expect(repository.listActivations()).toHaveLength(1)
    } finally {
      database.close()
    }
  })

  it('lists Extension records and filters activations independently for multiple intelligent agents', async () => {
    const { database, repository, core } = await createFixture()
    try {
      const firstAgent = createAgent(core)
      const secondAgent = core.createAgent({
        displayName: '第二个智能体',
        persona: '',
        model: { provider: 'test', model: 'model' },
        capabilities,
      })
      const extensionId = ExtensionIdSchema.parse('ext_QUERYCASE')
      const revisionOneId = ExtensionRevisionIdSchema.parse('xrv_QUERYONE')
      const revisionTwoId = ExtensionRevisionIdSchema.parse('xrv_QUERYTWO')
      repository.saveExtensionRevision({
        extension: {
          id: extensionId,
          scope: 'agent',
          slug: 'query-extension',
          displayName: '查询扩展',
          description: '有创建者',
          createdByAgentId: firstAgent.definition.id,
          createdAt: 1,
        },
        revision: {
          id: revisionOneId,
          extensionId,
          revisionNumber: 1,
          contentDigest: 'sha256:query-one',
          payloadDigest: 'sha256:query-one',
          createdAt: 1,
        },
      })
      repository.saveExtensionRevision({
        extension: {
          id: extensionId,
          scope: 'agent',
          slug: 'query-extension',
          displayName: '查询扩展',
          description: '重复的扩展元数据不会覆盖',
          createdAt: 2,
        },
        revision: {
          id: revisionTwoId,
          extensionId,
          revisionNumber: 2,
          contentDigest: 'sha256:query-two',
          payloadDigest: 'sha256:query-two',
          createdAt: 2,
        },
      })
      expect(repository.listExtensions()).toMatchObject([
        { id: extensionId, slug: 'query-extension', createdByAgentId: firstAgent.definition.id },
      ])
      expect(repository.getExtension(extensionId)?.description).toBe('有创建者')
      expect(repository.getExtensionBySlug('query-extension')?.id).toBe(extensionId)
      expect(repository.getExtension(ExtensionIdSchema.parse('ext_MISSING'))).toBeUndefined()
      expect(repository.getExtensionBySlug('missing')).toBeUndefined()
      expect(repository.listExtensionRevisions()).toHaveLength(2)
      expect(repository.listExtensionRevisions(extensionId).map(({ id }) => id)).toEqual([revisionOneId, revisionTwoId])
      expect(repository.getExtensionRevision(revisionOneId)?.revisionNumber).toBe(1)
      expect(repository.getExtensionRevision(ExtensionRevisionIdSchema.parse('xrv_MISSING'))).toBeUndefined()
      expect(repository.nextExtensionRevisionNumber(extensionId)).toBe(3)
      expect(repository.nextExtensionRevisionNumber(ExtensionIdSchema.parse('ext_EMPTY'))).toBe(1)

      repository.upsertActivation({
        agentId: firstAgent.definition.id,
        extensionId,
        extensionRevisionId: revisionOneId,
        config: { owner: 'first' },
        activatedAt: 3,
      })
      repository.upsertActivation({
        agentId: firstAgent.definition.id,
        extensionId,
        extensionRevisionId: revisionTwoId,
        config: { owner: 'first', revision: 2 },
        activatedAt: 4,
      })
      repository.upsertActivation({
        agentId: secondAgent.definition.id,
        extensionId,
        extensionRevisionId: revisionTwoId,
        config: { owner: 'second' },
        activatedAt: 5,
      })
      expect(repository.getActivation(firstAgent.definition.id, extensionId)).toMatchObject({
        extensionRevisionId: revisionTwoId,
        config: { owner: 'first', revision: 2 },
      })
      expect(repository.getActivation(AgentIdSchema.parse('agt_MISSING'), extensionId)).toBeUndefined()
      expect(repository.listActivations(firstAgent.definition.id)).toHaveLength(1)
      expect(repository.listActivations(secondAgent.definition.id)).toHaveLength(1)
      expect(repository.listActivations()).toHaveLength(2)
      repository.deleteActivation(secondAgent.definition.id, extensionId)
      repository.deleteActivation(secondAgent.definition.id, extensionId)
      expect(repository.listActivations()).toHaveLength(1)
    } finally {
      database.close()
    }
  })

  it('rejects malformed JSON and branded identifiers when reading persisted rows', async () => {
    const { directory, database, core } = await createFixture()
    const filename = path.join(directory, 'core.sqlite')
    try {
      const connection = core.listConnections()[0]
      if (connection === undefined) throw new Error('Fixture connection missing')
      const channel = core.createChannel({
        connectionId: connection.id,
        platformChannelId: 'corrupt-channel',
        kind: 'web',
      })
      database.close()
      mutateSqlite(filename, 'UPDATE connections SET config = ? WHERE id = ?', '{not-json', connection.id)
      const malformedJsonDatabase = await openMigratedCoreDatabase(filename)
      try {
        expect(() => new SqliteCoreRepository(malformedJsonDatabase).getConnection(connection.id)).toThrow()
      } finally {
        malformedJsonDatabase.close()
      }

      mutateSqlite(filename, 'UPDATE connections SET config = ? WHERE id = ?', '{}', connection.id)
      mutateSqliteWithForeignKeysOff(
        filename,
        'UPDATE channels SET connection_id = ? WHERE id = ?',
        'bad-connection-id',
        channel.id,
      )
      const brandedDatabase = await openMigratedCoreDatabase(filename)
      try {
        expect(() => new SqliteCoreRepository(brandedDatabase).getChannel(channel.id)).toThrow()
      } finally {
        brandedDatabase.close()
      }
    } finally {
      try {
        database.close()
      } catch {
        // Closed before reopening the corrupted database.
      }
    }
  })

  it('creates a readable online WAL backup and a two-database backup set', async () => {
    const { directory, database, core } = await createFixture()
    const backupPath = path.join(directory, 'core-backup.sqlite')
    core.createConnection({ adapterKey: 'qq-openclaw', config: {} })
    await backupCoreDatabase(database, backupPath)
    database.close()

    const restored = await openMigratedCoreDatabase(backupPath)
    try {
      expect(new SqliteCoreRepository(restored).listConnectionIdsByAdapter()).toHaveLength(2)
    } finally {
      restored.close()
    }

    const dshPath = path.join(directory, 'dsh.sqlite')
    const dsh = new BetterSqlite3(dshPath)
    dsh.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY); INSERT INTO sessions VALUES ('session-1')")
    dsh.close()
    const destination = path.join(directory, 'backup-set')
    const manifest = await createSqliteBackupSet(
      [
        { name: 'core', filename: backupPath },
        { name: 'dsh-sessions', filename: dshPath },
      ],
      destination,
      42,
    )
    expect(manifest.databases).toHaveLength(2)
    expect(
      SqliteBackupManifestSchema.parse(JSON.parse(await readFile(path.join(destination, 'manifest.json'), 'utf8'))),
    ).toEqual(manifest)
  })

  it('retires every live Episode and releases unresolved Admissions after DSH storage replacement', async () => {
    const { database, repository, core, connection } = await createFixture()
    try {
      const firstAgent = createAgent(core)
      const firstChannel = core.createChannel({
        connectionId: connection.id,
        platformChannelId: 'storage-reset-first',
        kind: 'web',
      })
      const firstEvent = appendTextEvent(core, connection.id, firstChannel.id, 'storage-reset-first', 'first', 1)
      const firstEpisodeId = EpisodeIdSchema.parse('eps_STORAGERESET1')
      repository.createEpisode({
        id: firstEpisodeId,
        channelId: firstChannel.id,
        agentId: firstAgent.definition.id,
        agentRevisionId: firstAgent.revision.id,
        status: 'opening',
        openedAtEventId: firstEvent.id,
        createdAt: 2,
      })
      const admissionId = AdmissionIdSchema.parse('adm_STORAGERESET1')
      repository.createAdmission({
        id: admissionId,
        episodeId: firstEpisodeId,
        mode: 'followup',
        state: 'pending',
        eventIds: [firstEvent.id],
        createdAt: 3,
      })
      repository.claimAdmission(admissionId)

      const secondAgent = createAgent(core)
      const secondChannel = core.createChannel({
        connectionId: connection.id,
        platformChannelId: 'storage-reset-second',
        kind: 'web',
      })
      const secondEvent = appendTextEvent(core, connection.id, secondChannel.id, 'storage-reset-second', 'second', 4)
      const secondEpisodeId = EpisodeIdSchema.parse('eps_STORAGERESET2')
      repository.createEpisode({
        id: secondEpisodeId,
        channelId: secondChannel.id,
        agentId: secondAgent.definition.id,
        agentRevisionId: secondAgent.revision.id,
        status: 'opening',
        openedAtEventId: secondEvent.id,
        createdAt: 5,
      })
      repository.activateEpisode(secondEpisodeId, 'synthetic-old-session')

      expect(repository.retireDshSessionEpisodes(6)).toEqual({ episodesClosed: 2, admissionsReleased: 1 })
      expect(repository.getEpisode(firstEpisodeId)).toMatchObject({
        status: 'closed',
        closeReason: 'incompatible-session-storage',
        closedAtEventId: firstEvent.id,
        closedAt: 6,
      })
      expect(repository.getEpisode(secondEpisodeId)).toMatchObject({
        status: 'closed',
        closeReason: 'incompatible-session-storage',
        closedAtEventId: secondEvent.id,
        closedAt: 6,
      })
      expect(repository.listRecoverableEpisodes()).toEqual([])
      expect(repository.listRecoverableAdmissions(firstEpisodeId)).toEqual([])
      expect(repository.listUnadmittedEvents(firstChannel.id, firstAgent.definition.id, 0).map(({ id }) => id)).toEqual(
        [firstEvent.id],
      )
      expect(repository.retireDshSessionEpisodes(7)).toEqual({ episodesClosed: 0, admissionsReleased: 0 })
    } finally {
      database.close()
    }
  })

  it('reports backup destination, source, staging, and manifest errors', async () => {
    const { directory, database } = await createFixture()
    const source = path.join(directory, 'core.sqlite')
    try {
      await expect(
        backupCoreDatabase(database, path.join(directory, 'missing-parent', 'backup.sqlite')),
      ).rejects.toThrow()
      await expect(createSqliteBackupSet([], path.join(directory, 'empty-set'))).rejects.toThrow('at least one')
      await expect(
        createSqliteBackupSet([{ name: 'core', filename: source }], path.join(directory, 'bad-time'), -1),
      ).rejects.toThrow('createdAt')
      await expect(
        createSqliteBackupSet(
          [{ name: 'core', filename: source }],
          path.join(directory, 'bad-time-safe'),
          Number.MAX_SAFE_INTEGER + 1,
        ),
      ).rejects.toThrow('createdAt')
      await expect(createSqliteBackupSet([{ name: 'core', filename: source }], directory)).rejects.toThrow(
        'already exists',
      )
      await expect(
        createSqliteBackupSet(
          [
            { name: 'bad_name', filename: source },
            { name: 'bad_name', filename: source },
          ],
          path.join(directory, 'bad-name'),
        ),
      ).rejects.toThrow('kebab-case')
      await expect(
        createSqliteBackupSet(
          [
            { name: 'duplicate', filename: source },
            { name: 'duplicate', filename: source },
          ],
          path.join(directory, 'duplicate-name'),
        ),
      ).rejects.toThrow('kebab-case')
      await expect(
        createSqliteBackupSet(
          [{ name: 'relative', filename: 'relative.sqlite' }],
          path.join(directory, 'relative-source'),
        ),
      ).rejects.toThrow('absolute')
      await expect(
        createSqliteBackupSet([{ name: 'memory', filename: ':memory:' }], path.join(directory, 'memory-source')),
      ).rejects.toThrow('absolute')
      const missingDestination = path.join(directory, 'missing-source-set')
      await expect(
        createSqliteBackupSet(
          [{ name: 'missing', filename: path.join(directory, 'does-not-exist.sqlite') }],
          missingDestination,
        ),
      ).rejects.toThrow()
      await expect(readFile(path.join(missingDestination, 'manifest.json'), 'utf8')).rejects.toThrow()
      expect(() =>
        SqliteBackupManifestSchema.parse({
          format: 'nxt.sqlite-backup-set',
          version: 1,
          createdAt: 1,
          databases: [],
          extra: true,
        }),
      ).toThrow()
    } finally {
      database.close()
    }
  })
})
