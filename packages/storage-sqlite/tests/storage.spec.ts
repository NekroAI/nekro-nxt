import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AdapterConnectionContext } from '@nekro-nxt/adapter-sdk'
import type { AgentSessionDriver } from '@nekro-nxt/channel-runtime'
import { ChannelRuntime } from '@nekro-nxt/channel-runtime'
import type { AgentActivationId, ChannelId, EpisodeId } from '@nekro-nxt/contracts'
import { AssetEnrichmentService, AssetIngestionPipeline, AssetService, CoreService } from '@nekro-nxt/core'
import {
  ExtensionActivationCoordinator,
  ExtensionBuilder,
  ExtensionService,
  ExtensionSourceStore,
  type ExtensionActivationHost,
  type MountedExtension,
} from '@nekro-nxt/extension-runtime'
import { FakeAdapterConnection } from '@nekro-nxt/test-harness'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  backupCoreDatabase,
  CORE_SCHEMA_VERSION,
  createSqliteBackupSet,
  migrateCoreDatabase,
  openCoreDatabase,
  openMigratedCoreDatabase,
  SqliteCoreRepository,
} from '../src/index.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-sqlite-'))
  temporaryDirectories.push(directory)
  return directory
}

describe('Core SQLite capabilities', () => {
  it('atomically switches one agent between current channel bindings while preserving binding history', async () => {
    const directory = await temporaryDirectory()
    const database = await openMigratedCoreDatabase(path.join(directory, 'core.sqlite'))
    try {
      const repository = new SqliteCoreRepository(database)
      let id = 0
      const core = new CoreService(repository, { now: () => 1000 + id, nextUlid: () => `B${++id}` })
      const agent = core.createAgent({
        displayName: '换绑智能体',
        persona: '',
        model: { provider: 'test', model: 'model' },
      })
      const connection = core.createConnection({ adapterKey: 'web', config: {} })
      const first = core.createChannel({ connectionId: connection.id, platformChannelId: 'first', kind: 'web' })
      const second = core.createChannel({ connectionId: connection.id, platformChannelId: 'second', kind: 'web' })
      const original = core.createBinding({
        channelId: first.id,
        agentId: agent.definition.id,
        triggerPolicy: 'always',
      })
      core.createBinding({ channelId: second.id, agentId: agent.definition.id, triggerPolicy: 'command' })
      expect(core.listBindings(first.id)).toEqual([])
      const restored = core.createBinding({
        channelId: first.id,
        agentId: agent.definition.id,
        triggerPolicy: 'observe-only',
      })
      expect(restored).toMatchObject({ id: original.id, revision: 2, triggerPolicy: 'observe-only' })
      expect(core.listBindings(second.id)).toEqual([])
      expect(
        database
          .prepare('SELECT COUNT(*) AS count FROM bindings WHERE agent_id = ? AND active = 1')
          .get(agent.definition.id),
      ).toEqual({ count: 1 })
    } finally {
      database.close()
    }
  })

  it('persists, builds, switches, rolls back and cache-restores local Extension Revisions', async () => {
    const directory = await temporaryDirectory()
    const database = await openMigratedCoreDatabase(path.join(directory, 'core.sqlite'))
    const repository = new SqliteCoreRepository(database)
    let coreId = 0
    let extensionId = 0
    let activationId = 0
    const core = new CoreService(repository, { now: () => 1000, nextUlid: () => `E${++coreId}` })
    const agent = core.createAgent({
      displayName: '扩展智能体',
      persona: '',
      model: { provider: 'test', model: 'model' },
      capabilities: { dynamicCreation: true },
    })
    const sourceStore = new ExtensionSourceStore(path.join(directory, 'extension-data'))
    const service = new ExtensionService(repository, sourceStore, {
      now: () => 1100 + extensionId,
      nextUlid: () => `X${++extensionId}`,
    })
    const cacheRoot = path.join(directory, 'extension-cache')
    const builder = new ExtensionBuilder(cacheRoot)
    const hostCode = (value: string) => `return {
      apply(ctx) {
        const tool = harness.defineTool({
          name: 'saved_probe',
          description: 'Saved probe ${value}',
          parameters: {},
          output: { schema: { type: 'string' }, render(_args, result) { return [{ type: 'text', text: result }] } },
          execute() { return ${JSON.stringify(value)} }
        })
        harness.registerTool(ctx, tool)
      }
    }`
    const clientCode = `return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.register({ name: 'root' }, () => React.createElement('div', null, '扩展界面'))
      }
    }`

    const firstCapture = service.captureDynamicPackage(agent.definition.id, {
      dshSessionId: 'session-1',
      dynamicPluginId: 'probe-1',
      dynamicPackageId: 'pkg-1',
      name: '保存探针',
      purpose: '验证扩展保存与启用。',
      hostCode: hostCode('v1'),
      clientCode,
    })
    expect(
      service.captureDynamicPackage(agent.definition.id, {
        dshSessionId: 'session-1',
        dynamicPluginId: 'probe-1',
        dynamicPackageId: 'pkg-1',
        name: '保存探针',
        purpose: '验证扩展保存与启用。',
        hostCode: hostCode('v1'),
        clientCode,
      }).package.id,
    ).toBe(firstCapture.package.id)
    const first = await service.saveDraftPackage({
      draftPackageId: firstCapture.package.id,
      slug: 'saved-probe',
      displayName: '保存探针',
      description: '用于验证不可变本地扩展。',
    })
    expect(first.revision).toMatchObject({ revisionNumber: 1, storageState: 'saved' })
    expect(
      await readFile(path.join(service.revisionSourceDirectory(first.revision), 'manifest.json'), 'utf8'),
    ).toContain('保存探针')
    expect(repository.listActiveActivations(agent.definition.id)).toEqual([])

    const activeTools = new Map<string, string>()
    const lifecycle: string[] = []
    const activationHost: ExtensionActivationHost = {
      waitUntilSafe: (agentId) => {
        lifecycle.push(`safe:${agentId}`)
        return Promise.resolve()
      },
      mount: async (_agentId, revision, artifact): Promise<MountedExtension> => {
        lifecycle.push(`mount:${revision.revisionNumber}`)
        if (!artifact.hostEntry) throw new Error('Host artifact is required by this test.')
        const module = (await import(`${pathToFileURL(artifact.hostEntry).href}?load=${lifecycle.length}`)) as {
          default(environment: unknown): Promise<{ apply(context: unknown): void }>
        }
        const disposers: (() => void)[] = []
        const plugin = await module.default({
          harness: {
            defineTool: (definition: unknown) => definition,
            registerTool: (_context: unknown, definition: unknown) => {
              const tool = definition as { name: string; execute(): string }
              activeTools.set(tool.name, tool.execute())
              const dispose = () => activeTools.delete(tool.name)
              disposers.push(dispose)
              return dispose
            },
            handle: () => () => {},
          },
        })
        plugin.apply({})
        return {
          evidence: {
            hostLoaded: true,
            clientBuilt: artifact.clientEntry !== undefined,
            details: [revision.contentDigest],
          },
          dispose: () => {
            lifecycle.push(`dispose:${revision.revisionNumber}`)
            for (const dispose of disposers.splice(0)) dispose()
            return Promise.resolve()
          },
        }
      },
    }
    const coordinator = new ExtensionActivationCoordinator(repository, service, builder, activationHost, {
      now: () => 2000 + activationId,
      nextUlid: () => `A${++activationId}`,
    })
    const firstActivation = await coordinator.activate({
      agentId: agent.definition.id,
      extensionId: first.extension.id,
      revisionId: first.revision.id,
    })
    expect(firstActivation.state).toBe('active')
    expect(activeTools.get('saved_probe')).toBe('v1')

    const secondCapture = service.captureDynamicPackage(agent.definition.id, {
      dshSessionId: 'session-1',
      dynamicPluginId: 'probe-1',
      dynamicPackageId: 'pkg-2',
      name: '保存探针 v2',
      purpose: '验证安全切换。',
      hostCode: hostCode('v2'),
      clientCode,
    })
    const second = await service.saveDraftPackage({
      draftPackageId: secondCapture.package.id,
      extensionId: first.extension.id,
      slug: 'saved-probe',
      displayName: '保存探针',
      description: '用于验证不可变本地扩展。',
    })
    expect(second.revision.revisionNumber).toBe(2)
    const secondActivation = await coordinator.activate({
      agentId: agent.definition.id,
      extensionId: first.extension.id,
      revisionId: second.revision.id,
    })
    expect(repository.getActivation(firstActivation.id)?.state).toBe('disabled')
    expect(secondActivation.state).toBe('active')
    expect(activeTools.get('saved_probe')).toBe('v2')
    expect(lifecycle).toEqual(expect.arrayContaining([`safe:${agent.definition.id}`, 'dispose:1', 'mount:2']))

    const rollback = await coordinator.activate({
      agentId: agent.definition.id,
      extensionId: first.extension.id,
      revisionId: first.revision.id,
    })
    expect(rollback.state).toBe('active')
    expect(activeTools.get('saved_probe')).toBe('v1')

    const brokenCapture = service.captureDynamicPackage(agent.definition.id, {
      dshSessionId: 'session-1',
      dynamicPluginId: 'broken-probe',
      dynamicPackageId: 'broken-package',
      name: '损坏探针',
      purpose: '验证坏 Revision 不阻止其他扩展恢复。',
      hostCode: hostCode('broken'),
    })
    const broken = await service.saveDraftPackage({
      draftPackageId: brokenCapture.package.id,
      slug: 'broken-probe',
      displayName: '损坏探针',
      description: '验证隔离恢复。',
    })
    const brokenActivationId = 'act_broken' as AgentActivationId
    repository.createActivation({
      id: brokenActivationId,
      agentId: agent.definition.id,
      extensionId: broken.extension.id,
      extensionRevisionId: broken.revision.id,
      config: {},
      state: 'pending',
      runtimeKind: 'in-process',
      createdAt: 2500,
    })
    repository.markActivationWaiting(brokenActivationId)
    repository.commitActivationSwitch(brokenActivationId, undefined, 2501)
    await rm(service.revisionSourceDirectory(broken.revision), { recursive: true, force: true })

    await coordinator.dispose()
    expect(activeTools).toEqual(new Map())
    await rm(cacheRoot, { recursive: true, force: true })
    const restored = new ExtensionActivationCoordinator(
      repository,
      service,
      new ExtensionBuilder(cacheRoot),
      activationHost,
      { now: () => 3000, nextUlid: () => `R${++activationId}` },
    )
    expect(await restored.restore()).toEqual({ restored: 1, failed: 1 })
    const failedActivation = repository.getActivation(brokenActivationId)
    expect(failedActivation?.state).toBe('failed')
    expect(failedActivation?.lastError).toContain('ENOENT')
    expect(activeTools.get('saved_probe')).toBe('v1')
    await restored.disable(rollback.id)
    expect(activeTools).toEqual(new Map())
    database.close()
  })

  it('recovers committed saves and isolates interrupted, missing or digest-mismatched Revision sources', async () => {
    const directory = await temporaryDirectory()
    const database = await openMigratedCoreDatabase(path.join(directory, 'core.sqlite'))
    const repository = new SqliteCoreRepository(database)
    let id = 0
    const core = new CoreService(repository, { now: () => 4000, nextUlid: () => `RC${++id}` })
    const agent = core.createAgent({
      displayName: '恢复智能体',
      persona: '',
      model: { provider: 'test', model: 'model' },
    })
    const sourceStore = new ExtensionSourceStore(path.join(directory, 'extension-data'))
    const service = new ExtensionService(repository, sourceStore, {
      now: () => 4100 + id,
      nextUlid: () => `RS${++id}`,
    })
    const save = async (sequence: number) => {
      const captured = service.captureDynamicPackage(agent.definition.id, {
        dshSessionId: 'recovery-session',
        dynamicPluginId: `recovery-${sequence}`,
        dynamicPackageId: `package-${sequence}`,
        name: `恢复探针 ${sequence}`,
        purpose: '验证保存崩溃恢复。',
        hostCode: 'return { apply() {} }',
      })
      return service.saveDraftPackage({
        draftPackageId: captured.package.id,
        slug: `recovery-probe-${sequence}`,
        displayName: `恢复探针 ${sequence}`,
        description: '验证保存崩溃恢复。',
      })
    }

    try {
      const committed = await save(1)
      database
        .prepare("UPDATE extension_save_operations SET state = 'running', completed_at = NULL WHERE revision_id = ?")
        .run(committed.revision.id)
      database
        .prepare("UPDATE extension_revisions SET storage_state = 'saving' WHERE id = ?")
        .run(committed.revision.id)
      expect(await service.recoverSaves()).toEqual({ completed: 1, failed: 0, damaged: 0 })
      expect(repository.getExtensionRevision(committed.revision.id)?.storageState).toBe('saved')

      const invalid = await save(2)
      database
        .prepare("UPDATE extension_save_operations SET state = 'running', completed_at = NULL WHERE revision_id = ?")
        .run(invalid.revision.id)
      database.prepare("UPDATE extension_revisions SET storage_state = 'saving' WHERE id = ?").run(invalid.revision.id)
      await writeFile(
        path.join(service.revisionSourceDirectory(invalid.revision), 'content.sha256'),
        'invalid\n',
        'utf8',
      )
      expect(await service.recoverSaves()).toEqual({ completed: 0, failed: 1, damaged: 0 })
      expect(repository.getExtensionRevision(invalid.revision.id)?.storageState).toBe('quarantined')

      const interrupted = await save(3)
      database
        .prepare("UPDATE extension_save_operations SET state = 'running', completed_at = NULL WHERE revision_id = ?")
        .run(interrupted.revision.id)
      database
        .prepare("UPDATE extension_revisions SET storage_state = 'saving' WHERE id = ?")
        .run(interrupted.revision.id)
      await rm(service.revisionSourceDirectory(interrupted.revision), { recursive: true, force: true })
      expect(await service.recoverSaves()).toEqual({ completed: 0, failed: 1, damaged: 0 })
      expect(repository.getExtensionRevision(interrupted.revision.id)?.storageState).toBe('damaged')

      const missing = await save(4)
      await rm(service.revisionSourceDirectory(missing.revision), { recursive: true, force: true })
      expect(await service.recoverSaves()).toEqual({ completed: 0, failed: 0, damaged: 1 })
      expect(repository.getExtensionRevision(missing.revision.id)?.storageState).toBe('damaged')
    } finally {
      database.close()
    }
  })

  it('applies the generated Drizzle migration to a clean database', async () => {
    const directory = await temporaryDirectory()
    const database = openCoreDatabase(path.join(directory, 'core.sqlite'))
    try {
      await migrateCoreDatabase(database)
      expect(
        database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get('migration_journal'),
      ).toEqual({
        name: 'migration_journal',
      })
      expect(
        database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get('channel_events'),
      ).toEqual({ name: 'channel_events' })
      expect(
        database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get('channel_history_fts'),
      ).toEqual({ name: 'channel_history_fts' })
      expect(
        database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get('platform_identities'),
      ).toEqual({ name: 'platform_identities' })
      expect(
        database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get('channel_members'),
      ).toEqual({ name: 'channel_members' })
      expect(
        database
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get('adapter_runtime_states'),
      ).toEqual({ name: 'adapter_runtime_states' })
      expect(
        database
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
          .get('bindings_active_agent_uq'),
      ).toEqual({ name: 'bindings_active_agent_uq' })
      expect(database.prepare('PRAGMA user_version').get()).toEqual({ user_version: CORE_SCHEMA_VERSION })
    } finally {
      database.close()
    }
  })

  it('rejects a future Core schema without modifying it', async () => {
    const directory = await temporaryDirectory()
    const database = openCoreDatabase(path.join(directory, 'future.sqlite'))
    try {
      database.exec(`PRAGMA user_version = ${CORE_SCHEMA_VERSION + 1}`)
      await expect(migrateCoreDatabase(database)).rejects.toThrow('newer than supported')
      expect(database.prepare('PRAGMA user_version').get()).toEqual({ user_version: CORE_SCHEMA_VERSION + 1 })
    } finally {
      database.close()
    }
  })

  it('upgrades pre-capability Agent rows with three independent grants denied by default', async () => {
    const directory = await temporaryDirectory()
    const database = openCoreDatabase(path.join(directory, 'capability-upgrade.sqlite'))
    try {
      database.exec(`
        CREATE TABLE agent_revisions (id TEXT PRIMARY KEY NOT NULL);
        CREATE TABLE channel_events (id TEXT PRIMARY KEY NOT NULL);
        CREATE TABLE physical_deliveries (id TEXT PRIMARY KEY NOT NULL);
        CREATE TABLE bindings (id TEXT PRIMARY KEY NOT NULL, agent_id TEXT NOT NULL, created_at INTEGER NOT NULL);
        INSERT INTO agent_revisions (id) VALUES ('legacy-revision');
        PRAGMA user_version = 7;
      `)
      await migrateCoreDatabase(database)
      expect(database.prepare('SELECT capabilities_json FROM agent_revisions').get()).toEqual({
        capabilities_json: '{"dynamicCreation":false,"developmentShell":false,"fullFileAccess":false}',
      })
    } finally {
      database.close()
    }
  })

  it('enables WAL and supports FTS5 with source-row lookup', async () => {
    const directory = await temporaryDirectory()
    const database = openCoreDatabase(path.join(directory, 'core.sqlite'))
    try {
      expect(database.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' })
      expect(database.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 })
      database.exec(`
        CREATE TABLE message_source (id TEXT PRIMARY KEY, content TEXT NOT NULL);
        CREATE VIRTUAL TABLE message_search USING fts5(id UNINDEXED, content, tokenize = 'trigram');
      `)
      database
        .prepare('INSERT INTO message_source (id, content) VALUES (?, ?)')
        .run('message-1', '小奈正在整理频道摘要')
      database
        .prepare('INSERT INTO message_search (id, content) VALUES (?, ?)')
        .run('message-1', '小奈正在整理频道摘要')
      const hit = database.prepare("SELECT id FROM message_search WHERE message_search MATCH '频道摘'").get()
      expect(hit).toEqual({ id: 'message-1' })
      expect(database.prepare('SELECT content FROM message_source WHERE id = ?').get(String(hit?.id))).toEqual({
        content: '小奈正在整理频道摘要',
      })
    } finally {
      database.close()
    }
  })

  it('creates a readable online backup while the source uses WAL', async () => {
    const directory = await temporaryDirectory()
    const source = openCoreDatabase(path.join(directory, 'core.sqlite'))
    const destination = path.join(directory, 'backup.sqlite')
    try {
      source.exec("CREATE TABLE facts (value TEXT NOT NULL); INSERT INTO facts VALUES ('preserved');")
      await backupCoreDatabase(source, destination)
    } finally {
      source.close()
    }

    expect((await readFile(destination)).byteLength).toBeGreaterThan(0)
    const restored = openCoreDatabase(destination)
    try {
      expect(restored.prepare('SELECT value FROM facts').get()).toEqual({ value: 'preserved' })
    } finally {
      restored.close()
    }
  })

  it('commits a readable Core and DSH SQLite backup set only after both snapshots exist', async () => {
    const directory = await temporaryDirectory()
    const corePath = path.join(directory, 'core.sqlite')
    const dshPath = path.join(directory, 'sessions.sqlite')
    const destination = path.join(directory, 'backup-set')
    const core = openCoreDatabase(corePath)
    const dsh = openCoreDatabase(dshPath)
    try {
      core.exec("CREATE TABLE core_fact (value TEXT NOT NULL); INSERT INTO core_fact VALUES ('core');")
      dsh.exec("CREATE TABLE session_fact (value TEXT NOT NULL); INSERT INTO session_fact VALUES ('dsh');")

      expect(
        await createSqliteBackupSet(
          [
            { name: 'core', filename: corePath },
            { name: 'dsh-sessions', filename: dshPath },
          ],
          destination,
          123,
        ),
      ).toEqual({
        format: 'nxt.sqlite-backup-set',
        version: 1,
        createdAt: 123,
        databases: [
          { name: 'core', filename: 'core.sqlite' },
          { name: 'dsh-sessions', filename: 'dsh-sessions.sqlite' },
        ],
      })
    } finally {
      core.close()
      dsh.close()
    }

    const coreBackup = openCoreDatabase(path.join(destination, 'core.sqlite'))
    const dshBackup = openCoreDatabase(path.join(destination, 'dsh-sessions.sqlite'))
    try {
      expect(coreBackup.prepare('SELECT value FROM core_fact').get()).toEqual({ value: 'core' })
      expect(dshBackup.prepare('SELECT value FROM session_fact').get()).toEqual({ value: 'dsh' })
      expect(JSON.parse(await readFile(path.join(destination, 'manifest.json'), 'utf8'))).toMatchObject({
        format: 'nxt.sqlite-backup-set',
        version: 1,
      })
    } finally {
      coreBackup.close()
      dshBackup.close()
    }
  })

  it('persists the Core domain and atomically deduplicates inbound events with checkpoints', async () => {
    const directory = await temporaryDirectory()
    const databasePath = path.join(directory, 'domain.sqlite')
    const database = await openMigratedCoreDatabase(databasePath)
    let id = 0
    try {
      const repository = new SqliteCoreRepository(database)
      const core = new CoreService(repository, { now: () => 200, nextUlid: () => `SQL${++id}` })
      const agent = core.createAgent({
        displayName: '小奈',
        persona: '',
        model: { provider: 'deepseek', model: 'v4' },
      })
      const connection = core.createConnection({ adapterKey: 'web', config: {} })
      const channel = core.createChannel({
        connectionId: connection.id,
        platformChannelId: 'main',
        kind: 'web',
      })
      core.createBinding({ channelId: channel.id, agentId: agent.definition.id, triggerPolicy: 'always' })

      const inbound = {
        connectionId: connection.id,
        channelId: channel.id,
        adapterKey: 'web',
        platformEventId: 'event-1',
        platformMessageId: 'platform-inbound-1',
        kind: 'message-created' as const,
        parts: [{ type: 'text' as const, text: '你好' }],
        platformTimestamp: 201,
        receivedAt: 202,
        dedupeKey: 'event:event-1',
        checkpoint: { cursor: 'cursor-1' },
      }
      const first = core.appendInbound(inbound)
      const replays = Array.from({ length: 100 }, () => core.appendInbound(inbound))
      expect(first.inserted).toBe(true)
      expect(replays.every(({ inserted }) => !inserted)).toBe(true)
      expect(replays.at(-1)).toMatchObject({ inserted: false, event: { id: first.event.id } })
      expect(database.prepare('SELECT COUNT(*) AS count FROM channel_events').get()).toEqual({ count: 1 })
      expect(database.prepare('SELECT checkpoint_json FROM adapter_checkpoints').get()).toEqual({
        checkpoint_json: '{"cursor":"cursor-1"}',
      })
      expect(core.resolvePlatformMessage(connection.id, channel.id, 'platform-inbound-1')).toEqual({
        logicalMessageId: first.event.logicalMessageId,
        authoredByAgent: false,
      })
    } finally {
      database.close()
    }

    const reopened = await openMigratedCoreDatabase(databasePath)
    try {
      const row = reopened
        .prepare(
          `SELECT d.id AS agent_id
             FROM agent_definitions d
             JOIN agent_revisions r ON r.id = d.current_revision_id`,
        )
        .get()
      expect(row).toMatchObject({ agent_id: 'agt_SQL1' })
    } finally {
      reopened.close()
    }
  })

  it('persists Connection-scoped platform identities and stable Channel members', async () => {
    const directory = await temporaryDirectory()
    const database = await openMigratedCoreDatabase(path.join(directory, 'identities.sqlite'))
    let id = 0
    try {
      const repository = new SqliteCoreRepository(database)
      const core = new CoreService(repository, { now: () => 500, nextUlid: () => `I${++id}` })
      const connection = core.createConnection({ adapterKey: 'qq-openclaw', config: {} })
      const channel = core.ensureChannel({
        connectionId: connection.id,
        platformChannelId: 'group:openid-1',
        kind: 'group',
        displayName: '旧群名',
        observedAt: 501,
      })
      expect(
        core.ensureChannel({
          connectionId: connection.id,
          platformChannelId: 'group:openid-1',
          kind: 'group',
          displayName: '新群名',
          observedAt: 502,
        }),
      ).toMatchObject({ id: channel.id, displayName: '新群名' })
      const first = core.observeChannelMember({
        connectionId: connection.id,
        channelId: channel.id,
        platformUserId: 'member-openid',
        displayName: '成员甲',
        observedAt: 503,
      })
      const repeated = core.observeChannelMember({
        connectionId: connection.id,
        channelId: channel.id,
        platformUserId: 'member-openid',
        displayName: '成员乙',
        observedAt: 504,
      })
      expect(repeated.identity).toMatchObject({
        id: first.identity.id,
        displayName: '成员乙',
        firstSeenAt: 503,
        lastSeenAt: 504,
        seenCount: 2,
      })
      expect(repeated.member).toMatchObject({
        id: first.member.id,
        displayName: '成员乙',
        firstSeenAt: 503,
        lastSeenAt: 504,
        seenCount: 2,
      })
      expect(core.resolveChannelMemberIdentity(connection.id, channel.id, repeated.member.id)).toMatchObject({
        platformUserId: 'member-openid',
      })
      expect(database.prepare('SELECT COUNT(*) AS count FROM platform_identities').get()).toEqual({ count: 1 })
      expect(database.prepare('SELECT COUNT(*) AS count FROM channel_members').get()).toEqual({ count: 1 })
      await repository.save(connection.id, 'qq-openclaw.gateway-session', { sequence: 9 }, 505)
      await expect(repository.load(connection.id, 'qq-openclaw.gateway-session')).resolves.toEqual({ sequence: 9 })
      await repository.clear(connection.id, 'qq-openclaw.gateway-session')
      await expect(repository.load(connection.id, 'qq-openclaw.gateway-session')).resolves.toBeUndefined()
    } finally {
      database.close()
    }
  })

  it('persists Episode, Admission, Outbox and structured receipts through the Runtime repository', async () => {
    const directory = await temporaryDirectory()
    const database = await openMigratedCoreDatabase(path.join(directory, 'runtime.sqlite'))
    let coreId = 0
    let runtimeId = 0
    try {
      const repository = new SqliteCoreRepository(database)
      const core = new CoreService(repository, { now: () => 300, nextUlid: () => `C${++coreId}` })
      const agent = core.createAgent({
        displayName: '小奈',
        persona: '',
        model: { provider: 'deepseek', model: 'v4' },
      })
      const connection = core.createConnection({ adapterKey: 'web', config: {} })
      const channel = core.createChannel({
        connectionId: connection.id,
        platformChannelId: 'runtime-main',
        kind: 'web',
      })
      core.createBinding({ channelId: channel.id, agentId: agent.definition.id, triggerPolicy: 'always' })

      const sessionDriver: AgentSessionDriver = {
        createSession: () => Promise.resolve('dsh-session-runtime'),
        applyCompatibleRevision: () => Promise.resolve(),
        sessionStatus: () => 'idle',
        findAdmissionMessage: () => undefined,
        createHandoffSummary: ({ revision }) =>
          Promise.resolve({ summary: '交接摘要', provider: revision.model.provider, model: revision.model.model }),
        cancelSession: () => Promise.resolve(),
        admit: ({ admissionId }) => Promise.resolve({ dshMessageId: `dsh-message-${admissionId}` }),
      }
      const adapterContext: AdapterConnectionContext = {
        connectionId: connection.id,
        now: () => 300,
        acceptInbound: () => Promise.reject(new Error('runtime is called directly in this test')),
      }
      const adapter = new FakeAdapterConnection(adapterContext)
      await adapter.start()
      const runtime = new ChannelRuntime(core, repository, repository, sessionDriver, {
        now: () => 300,
        nextUlid: () => `R${++runtimeId}`,
        resolveAdapter: (id) => (id === connection.id ? adapter : undefined),
      })

      await runtime.acceptInbound({
        connectionId: connection.id,
        channelId: channel.id,
        adapterKey: 'web',
        platformEventId: 'runtime-event-1',
        kind: 'message-created',
        parts: [{ type: 'text', text: '请回复' }],
        platformTimestamp: 301,
        receivedAt: 302,
        dedupeKey: 'event:runtime-event-1',
      })
      const episodeRow = database.prepare("SELECT id FROM episodes WHERE status = 'active'").get() as { id: string }
      adapter.queueReceipt({ status: 'sent', platformMessageId: 'web-message-1' })
      const result = await runtime.sendMessage({
        episodeId: episodeRow.id as EpisodeId,
        parts: [{ type: 'text', text: '已收到' }],
        clientRequestId: 'runtime-request-1',
      })
      expect(result.status).toBe('sent')
      expect(database.prepare('SELECT state FROM admissions').get()).toEqual({ state: 'logged-to-session' })
      expect(database.prepare('SELECT state FROM outbound_intents').get()).toEqual({ state: 'sent' })
      const receiptRow = database.prepare('SELECT receipt_json FROM delivery_receipts').get() as {
        receipt_json: string
      }
      expect(JSON.parse(receiptRow.receipt_json)).toEqual({
        status: 'sent',
        platformMessageId: 'web-message-1',
      })
      expect(core.resolvePlatformMessage(connection.id, channel.id, 'web-message-1')).toEqual({
        logicalMessageId: result.logicalMessageId,
        authoredByAgent: true,
      })

      await runtime.sendMessage({
        episodeId: episodeRow.id as EpisodeId,
        parts: [{ type: 'text', text: '不会重复发送' }],
        clientRequestId: 'runtime-request-1',
      })
      expect(adapter.deliveries).toHaveLength(1)
      const [inboundHit] = repository.searchChannelHistory(channel.id, '请回复')
      expect(inboundHit?.entry).toMatchObject({
        source: 'channel-event',
        parts: [{ type: 'text', text: '请回复' }],
      })
      const [outboundHit] = repository.searchChannelHistory(channel.id, '已收到')
      expect(outboundHit?.entry).toMatchObject({
        source: 'outbound-intent',
        parts: [{ type: 'text', text: '已收到' }],
      })
      expect(repository.listChannelHistory(channel.id)).toHaveLength(2)
      const privateChannel = core.createChannel({
        connectionId: connection.id,
        platformChannelId: 'runtime-private',
        kind: 'web',
      })
      core.appendInbound({
        connectionId: connection.id,
        channelId: privateChannel.id,
        adapterKey: 'web',
        platformEventId: 'private-event-1',
        kind: 'message-created',
        parts: [{ type: 'text', text: '另一个频道的秘密内容' }],
        platformTimestamp: 400,
        receivedAt: 400,
        dedupeKey: 'event:private-event-1',
      })
      expect(repository.searchChannelHistory(channel.id, '秘密内容')).toEqual([])
      expect(repository.searchChannelHistory(privateChannel.id, '秘密内容')).toHaveLength(1)
      await adapter.stop()
    } finally {
      database.close()
    }
  })

  it('deduplicates Asset blobs while durably preserving every receive occurrence and journal result', async () => {
    const directory = await temporaryDirectory()
    const databasePath = path.join(directory, 'assets.sqlite')
    const assetRoot = path.join(directory, 'asset-store')
    const database = await openMigratedCoreDatabase(databasePath)
    let coreId = 0
    let assetId = 0
    const receiveCount = 40
    try {
      const repository = new SqliteCoreRepository(database)
      const core = new CoreService(repository, { now: () => 500, nextUlid: () => `A${++coreId}` })
      const connection = core.createConnection({ adapterKey: 'web', config: {} })
      const channel = core.createChannel({
        connectionId: connection.id,
        platformChannelId: 'asset-main',
        kind: 'web',
      })
      const events = Array.from(
        { length: receiveCount },
        (_, index) =>
          core.appendInbound({
            connectionId: connection.id,
            channelId: channel.id,
            adapterKey: 'web',
            platformEventId: `asset-event-${index}`,
            platformMessageId: `asset-message-${index}`,
            kind: 'message-created',
            parts: [{ type: 'text', text: '普通文件' }],
            platformTimestamp: 501 + index,
            receivedAt: 501 + index,
            dedupeKey: `event:asset-event-${index}`,
          }).event,
      )
      const service = new AssetService(repository, assetRoot, {
        now: () => 600,
        nextUlid: () => `ASSET${++assetId}`,
      })
      let enhancementCalls = 0
      const enrichment = new AssetEnrichmentService(
        repository,
        service,
        {
          enhance: ({ blobPath }) => {
            enhancementCalls += 1
            expect(blobPath).toContain('blobs/sha256')
            return Promise.resolve({ summary: '一张包含文字的测试图片', ocrText: '测试文字', tags: ['测试'] })
          },
        },
        { now: () => 800, nextUlid: () => `ENRICH${++assetId}` },
      )
      const pipeline = new AssetIngestionPipeline(service, {
        enrichment,
        specs: [
          {
            enhancerId: 'vision-summary',
            provider: 'test-provider',
            modelId: 'vision-model',
            promptVersion: 1,
            schemaVersion: 1,
          },
        ],
      })
      const bytes = new Uint8Array(
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZQAAAABJRU5ErkJggg==',
          'base64',
        ),
      )

      const commits = await Promise.all(
        events.map((event, index) =>
          pipeline.import({
            bytes,
            occurrence: {
              channelEventId: event.id,
              channelId: channel.id,
              connectionId: connection.id,
              ...(event.platformMessageId === undefined ? {} : { platformMessageId: event.platformMessageId }),
              receivedAt: 700 + index,
              filename: 'clip.mp4',
              declaredMediaType: 'video/mp4',
            },
          }),
        ),
      )

      expect(new Set(commits.map(({ asset }) => asset.id)).size).toBe(1)
      expect(database.prepare('SELECT COUNT(*) AS count FROM assets').get()).toEqual({ count: 1 })
      expect(database.prepare('SELECT COUNT(*) AS count FROM asset_occurrences').get()).toEqual({
        count: receiveCount,
      })
      expect(
        database.prepare('SELECT COUNT(*) AS count FROM asset_operations WHERE state = ?').get('completed'),
      ).toEqual({ count: receiveCount })
      expect(database.prepare('SELECT media_type, receive_count, last_received_at FROM assets').get()).toEqual({
        media_type: 'image/png',
        receive_count: receiveCount,
        last_received_at: 700 + receiveCount - 1,
      })
      expect(database.prepare('SELECT DISTINCT declared_media_type FROM asset_occurrences').all()).toEqual([
        { declared_media_type: 'video/mp4' },
      ])
      const digestPrefixes = await readdir(path.join(assetRoot, 'blobs/sha256'))
      expect(digestPrefixes).toHaveLength(1)
      expect(await readdir(path.join(assetRoot, 'blobs/sha256', digestPrefixes[0]!))).toHaveLength(1)

      expect(database.prepare('SELECT COUNT(*) AS count FROM asset_enrichments').get()).toEqual({ count: 1 })
      expect(await enrichment.drain()).toBe(1)
      expect(enhancementCalls).toBe(1)
      expect(repository.listAssetEnrichments(commits[0]!.asset.id)[0]).toMatchObject({
        state: 'succeeded',
        summary: '一张包含文字的测试图片',
        ocrText: '测试文字',
      })
      enrichment.enqueue(commits[0]!.asset, {
        enhancerId: 'vision-summary',
        provider: 'test-provider',
        modelId: 'vision-model',
        promptVersion: 2,
        schemaVersion: 1,
      })
      expect(repository.claimPendingAssetEnrichment(801)?.state).toBe('running')
      expect(enrichment.recover()).toBe(1)
      expect(await enrichment.drain()).toBe(1)
      expect(enhancementCalls).toBe(2)
      expect(repository.listAssetEnrichments(commits[0]!.asset.id)).toHaveLength(2)
      expect(repository.canAccessAsset(commits[0]!.asset.id, channel.id)).toBe(true)
      expect(repository.canAccessAsset(commits[0]!.asset.id, 'another-channel' as ChannelId)).toBe(false)
    } finally {
      database.close()
    }

    const reopened = await openMigratedCoreDatabase(databasePath)
    try {
      const repository = new SqliteCoreRepository(reopened)
      const service = new AssetService(repository, assetRoot)
      expect(await service.recover()).toEqual([])
      expect(reopened.prepare('SELECT COUNT(*) AS count FROM asset_occurrences').get()).toEqual({
        count: receiveCount,
      })
    } finally {
      reopened.close()
    }
  })
})
