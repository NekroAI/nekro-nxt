import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { CoreService } from '@nekro-nxt/core'
import {
  AdmissionIdSchema,
  AssetIdSchema,
  AuthoringAttemptIdSchema,
  AuthoringTaskIdSchema,
  EpisodeIdSchema,
  HostApiContracts,
  LogicalMessageIdSchema,
  OutboundIntentIdSchema,
  PhysicalDeliveryIdSchema,
} from '@nekro-nxt/contracts'
import { DSH_RUNTIME_FINGERPRINT } from '@nekro-nxt/dsh-compat/release'
import { openCoreDatabase, SqliteCoreRepository } from '@nekro-nxt/storage-sqlite'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { startNekroServer, type NekroServerHandle } from '../src/main.js'
import { NekroJsonlSessionPersistence } from '../src/dsh-session-persistence.js'
import { restoreUpgradeBackup, verifyUpgradeBackup } from '../src/upgrade-backup.js'

const directories: string[] = []
const servers = new Set<NekroServerHandle>()
afterEach(async () => {
  for (const server of servers) await server.stop()
  servers.clear()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

/** A synthetic model exercising the real DSH loop, Tools and internal Adapter. */
class UpgradeModel extends LlmAdapter {
  readonly calls: GenerateOptions[] = []
  allowRetiredModel = false
  override providerInfo(provider: string) {
    return { id: provider, name: '升级验收模型' }
  }
  override listModels(provider: string) {
    return Promise.resolve([
      { provider, id: 'upgrade-model', name: '升级验收模型', inputModalities: ['text'] as const },
    ])
  }
  override resolveModel(provider: string, model: string) {
    if (model === 'retired-model' && !this.allowRetiredModel)
      return Promise.reject(new Error('Synthetic removed model'))
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      inputModalities: ['text'] as const,
      context: { contextWindow: 128_000 },
    })
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    await Promise.resolve()
    this.calls.push(options)
    const lastUser = options.messages.findLastIndex((message) => message.role === 'user')
    if (options.messages.slice(lastUser + 1).some((message) => message.role === 'tool')) {
      yield { type: 'usage', usage: { inputTokens: 16, outputTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const turnKey = createHash('sha256').update(JSON.stringify(options.messages[lastUser])).digest('hex').slice(0, 16)
    const callId = ToolCallId(`upgrade-send-${turnKey}-${this.calls.length}`)
    const arguments_ = JSON.stringify({
      target: { type: 'current' },
      parts: [{ type: 'text', text: '升级后的通信工具已成功发送。' }],
    })
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id: callId, name: 'send_channel_message', argumentsDelta: arguments_ }
    yield {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: callId, name: 'send_channel_message', arguments: arguments_ },
    }
    yield { type: 'usage', usage: { inputTokens: 16, outputTokens: 8 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

const readCore = (dataRoot: string, query: string, ...values: (string | number)[]) => {
  const database = new DatabaseSync(path.join(dataRoot, 'core.sqlite'), { readOnly: true })
  try {
    return database.prepare(query).all(...values)
  } finally {
    database.close()
  }
}

const createLegacyFixture = async () => {
  const rawDirectory = await mkdtemp(path.join(tmpdir(), 'nxt-host-upgrade-'))
  const directory = await realpath(rawDirectory)
  directories.push(directory)
  const dataRoot = path.join(directory, 'data')
  const distIndex = path.join(directory, 'web/index.html')
  await mkdir(dataRoot, { recursive: true })
  await mkdir(path.dirname(distIndex), { recursive: true })
  await writeFile(distIndex, '<!doctype html><html><body><main id="root">Synthetic upgrade entry</main></body></html>')
  const migrations = path.resolve(import.meta.dirname, '../../../packages/storage-sqlite/migrations')
  const journal = z
    .object({ entries: z.array(z.object({ idx: z.number(), when: z.number(), tag: z.string() })) })
    .parse(JSON.parse(await readFile(path.join(migrations, 'meta/_journal.json'), 'utf8')))
  // Load disk inputs before opening SQLite. A test timeout must not race an
  // awaited fixture read while teardown is trying to remove an open Windows DB.
  const sources = await Promise.all(
    journal.entries
      .filter(({ idx }) => idx <= 24)
      .map(async (entry) => ({
        ...entry,
        sql: await readFile(path.join(migrations, `${entry.tag}.sql`), 'utf8'),
      })),
  )
  const sessionSql = await readFile(new URL('./fixtures/dsh-sqlite-schema17.sql', import.meta.url), 'utf8')
  const legacy = new DatabaseSync(path.join(dataRoot, 'core.sqlite'))
  try {
    // Match Core's transactional migration setup, avoiding hundreds of fixture-only fsyncs.
    legacy.exec(
      'PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE; CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC)',
    )
    for (const entry of sources) {
      legacy.exec(entry.sql)
      legacy
        .prepare('INSERT INTO __drizzle_migrations(hash, created_at) VALUES (?, ?)')
        .run(createHash('sha256').update(entry.sql).digest('hex'), entry.when)
    }
    expect(legacy.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    legacy.exec('COMMIT')
  } finally {
    legacy.close()
  }
  const database = openCoreDatabase(path.join(dataRoot, 'core.sqlite'))
  const repository = new SqliteCoreRepository(database)
  let sequence = 0
  const core = new CoreService(repository, {
    now: () => 1000,
    nextUlid: () => `UPGRADE${String(++sequence).padStart(5, '0')}`,
  })
  const connection = core.createConnection({ adapterKey: 'web', config: {} })
  const agent = core.createAgentWithChannel(
    {
      displayName: '升级保留智能体',
      persona: '仅通过通信工具发言。',
      model: { provider: 'upgrade-provider', model: 'upgrade-model' },
    },
    { connectionId: connection.id, kind: 'internal', triggerPolicy: 'always' },
  )
  const isolated = core.createAgentWithChannel(
    {
      displayName: '待修复模型智能体',
      persona: '保留原模型。',
      model: { provider: 'upgrade-provider', model: 'retired-model' },
    },
    { connectionId: connection.id, kind: 'internal', triggerPolicy: 'always' },
  )
  const old = core.appendInbound({
    connectionId: connection.id,
    channelId: agent.channel.id,
    adapterKey: 'web',
    kind: 'message-created',
    parts: [{ type: 'text', text: '升级前聊天必须保留。' }],
    receivedAt: 1001,
    platformTimestamp: 1001,
    dedupeKey: 'legacy-admitted',
  }).event
  const backlog = core.appendInbound({
    connectionId: connection.id,
    channelId: agent.channel.id,
    adapterKey: 'web',
    kind: 'message-created',
    parts: [{ type: 'text', text: '升级前积压不得自动补答。' }],
    receivedAt: 1002,
    platformTimestamp: 1002,
    dedupeKey: 'legacy-backlog',
  }).event
  const episodeId = EpisodeIdSchema.parse('eps_UPGRADELEGACY')
  repository.createEpisode({
    id: episodeId,
    channelId: agent.channel.id,
    agentId: agent.definition.id,
    agentRevisionId: agent.revision.id,
    status: 'opening',
    openedAtEventId: old.id,
    createdAt: 1001,
  })
  repository.activateEpisode(episodeId, 'synthetic-upgrade-session')
  const admissionId = AdmissionIdSchema.parse('adm_UPGRADELEGACY')
  repository.createAdmission({
    id: admissionId,
    episodeId,
    eventIds: [old.id],
    mode: 'followup',
    state: 'claimed',
    createdAt: 1001,
  })
  const taskId = AuthoringTaskIdSchema.parse('aut_UPGRADELEGACY')
  repository.createAuthoringTask({
    task: {
      id: taskId,
      agentId: agent.definition.id,
      channelId: agent.channel.id,
      episodeId,
      initiatingEventId: old.id,
      pluginKey: 'synthetic-upgrade-plugin',
      title: '保留候选源码',
      requirementSummary: '升级后保留源文件',
      status: 'working',
      approvalPolicy: 'risk-stable',
      revision: 1,
      createdAt: 1001,
      updatedAt: 1001,
    },
    attempt: {
      id: AuthoringAttemptIdSchema.parse('aua_UPGRADELEGACY'),
      taskId,
      ordinal: 1,
      name: '源文件',
      purpose: '保留',
      snapshotDigest: 'a'.repeat(64),
      riskDigest: 'b'.repeat(64),
      sourcePath: path.join(dataRoot, 'workspaces', agent.definition.id, 'authoring/source.ts'),
      state: 'awaiting-approval',
      host: { status: 'pending', waitingFor: [] },
      client: { status: 'absent', waitingFor: [] },
      createdAt: 1001,
    },
    event: { taskId, sequence: 1, kind: 'task-created', payload: {}, createdAt: 1001 },
  })
  const outboundId = OutboundIntentIdSchema.parse('out_UPGRADELEGACY')
  const deliveryId = PhysicalDeliveryIdSchema.parse('phy_UPGRADELEGACY')
  repository.createOutboundPlan(
    {
      id: outboundId,
      logicalMessageId: LogicalMessageIdSchema.parse('msg_UPGRADELEGACY'),
      agentRevisionId: agent.revision.id,
      episodeId,
      parts: [{ type: 'text', text: '升级前已经成功投递。' }],
      state: 'planned',
      createdAt: 1001,
    },
    [
      {
        id: deliveryId,
        intentId: outboundId,
        sequence: 0,
        parts: [{ type: 'text', text: '升级前已经成功投递。' }],
        state: 'planned',
      },
    ],
  )
  repository.markIntentSending(outboundId)
  repository.markDeliverySending(deliveryId)
  repository.recordDeliveryReceipt(deliveryId, { status: 'sent', platformMessageId: 'synthetic-legacy-delivery' }, 1002)
  repository.completeOutboundIntent(outboundId, 'sent')
  const asset = repository.ensureAsset({
    id: AssetIdSchema.parse('ast_UPGRADELEGACY'),
    contentDigest: createHash('sha256').update('synthetic-upgrade-asset').digest('hex'),
    byteSize: 23,
    mediaType: 'text/plain',
    createdAt: 1000,
  })
  repository.grantAssetAccess({ assetId: asset.id, channelId: agent.channel.id, source: 'agent-tool', grantedAt: 1000 })
  database.close()
  const sessions = new DatabaseSync(path.join(dataRoot, 'sessions.sqlite'))
  try {
    sessions.exec('PRAGMA foreign_keys=OFF')
    sessions.exec(sessionSql)
    expect(sessions.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  } finally {
    sessions.close()
  }
  const files = {
    'dsh/settings.yaml': '{}\n',
    'dsh/.credentials.yaml': '{}\n',
    'credentials/synthetic-secret.json': '{"value":"synthetic-upgrade-secret"}',
    'assets/synthetic.txt': 'synthetic-upgrade-asset',
    'extension-data/synthetic-extension/source.ts': 'export const retained = true\n',
    'dsh/plugin-packages/synthetic-package/package.json': '{"name":"synthetic-upgrade-package","version":"1.0.0"}',
    [`workspaces/${agent.definition.id}/authoring/source.ts`]: 'export const candidate = true\n',
    'extension-cache/disposable.mjs': 'cache-only',
    'dsh/plugin-staging/disposable.txt': 'staging-only',
    'dsh/request-images/disposable.txt': 'request-only',
  }
  for (const [name, content] of Object.entries(files)) {
    const filename = path.join(dataRoot, name)
    await mkdir(path.dirname(filename), { recursive: true })
    await writeFile(filename, content, { mode: 0o600 })
  }
  return {
    directory,
    rawDirectory,
    dataRoot,
    distIndex,
    agent,
    isolated,
    episodeId,
    admissionId,
    taskId,
    outboundId,
    old,
    backlog,
    asset,
    files,
  }
}

const start = async (
  fixture: Awaited<ReturnType<typeof createLegacyFixture>>,
  model: UpgradeModel,
  releaseId = 'synthetic-upgrade-release',
) => {
  const server = await startNekroServer({
    dataRoot: fixture.dataRoot,
    distIndex: fixture.distIndex,
    releaseId,
    configureLlm(context) {
      context.llm.registerAdapter(['upgrade-provider'], model)
    },
  })
  servers.add(server)
  return { server, origin: `http://127.0.0.1:${server.port}` }
}
const stop = async (server: NekroServerHandle) => {
  await server.stop()
  servers.delete(server)
}
const snapshot = async (origin: string) => {
  const response = await fetch(`${origin}/api/snapshot`)
  if (response.status !== 200) throw new Error(`HTTP ${response.status}: ${await response.text()}`)
  return HostApiContracts.snapshot.parseResponse(await response.json())
}
const send = async (origin: string, channelId: string, clientEventId: string, text: string) => {
  const response = await fetch(`${origin}/api/channels/${channelId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientEventId, parts: [{ type: 'text', text }] }),
  })
  if (response.status !== 200) throw new Error(`HTTP ${response.status}: ${await response.text()}`)
  return HostApiContracts.sendChannelMessage.parseResponse(await response.json())
}
const messages = async (origin: string, channelId: string) => {
  const response = await fetch(`${origin}/api/channels/${channelId}/messages?limit=40`)
  if (response.status !== 200) throw new Error(`HTTP ${response.status}: ${await response.text()}`)
  return HostApiContracts.listChannelMessages.parseResponse(await response.json()).messages
}
const sentCount = async (origin: string, channelId: string) =>
  (await messages(origin, channelId)).filter((message) => message.deliveryState === 'sent').length
const storedSession = (dataRoot: string, channelId: string) =>
  z
    .object({ id: z.string(), dsh_session_id: z.string() })
    .parse(
      readCore(
        dataRoot,
        "SELECT id, dsh_session_id FROM episodes WHERE channel_id = ? AND status = 'active'",
        channelId,
      )[0],
    )
const readSession = async (root: string, id: string) => {
  const context = new Context()
  try {
    await context.plugin(NekroJsonlSessionPersistence, { root })
    const handle = await context.sessionPersistence.open(SessionId(id), 'read')
    try {
      return (await handle.read()).events
    } finally {
      await handle.close()
    }
  } finally {
    await context.fiber.dispose()
  }
}
const recoveryPoints = async (dataRoot: string) =>
  Promise.all(
    (await readdir(path.join(dataRoot, 'backups')))
      .filter((name) => /^runtime-[a-f0-9]{32}$/u.test(name))
      .map((name) => verifyUpgradeBackup(path.join(dataRoot, 'backups', name))),
  )

describe('production Host DSH upgrade', () => {
  it.each([16, 18])(
    'rejects unknown Session schema %i before backup and before changing legacy Core',
    async (schema) => {
      const fixture = await createLegacyFixture()
      const legacy = new DatabaseSync(path.join(fixture.dataRoot, 'sessions.sqlite'))
      legacy.exec(`PRAGMA user_version = ${schema}`)
      legacy.close()
      const coreBefore = createHash('sha256')
        .update(await readFile(path.join(fixture.dataRoot, 'core.sqlite')))
        .digest('hex')
      const sessionBefore = await readFile(path.join(fixture.dataRoot, 'sessions.sqlite'))
      const journalBefore = readCore(
        fixture.dataRoot,
        'SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at',
      )
      await expect(start(fixture, new UpgradeModel())).rejects.toThrow(/unsupported/u)
      expect(
        createHash('sha256')
          .update(await readFile(path.join(fixture.dataRoot, 'core.sqlite')))
          .digest('hex'),
      ).toBe(coreBefore)
      expect(await readFile(path.join(fixture.dataRoot, 'sessions.sqlite'))).toEqual(sessionBefore)
      expect(
        readCore(fixture.dataRoot, 'SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at'),
      ).toEqual(journalBefore)
      expect(await recoveryPoints(fixture.dataRoot)).toEqual([])
      expect(readCore(fixture.dataRoot, 'SELECT status FROM episodes WHERE id = ?', fixture.episodeId)).toEqual([
        { status: 'active' },
      ])
    },
    30_000,
  )

  it('backs up legacy data, resets only old context, runs Tools, reloads JSONL and restores the complete old generation', async () => {
    const fixture = await createLegacyFixture()
    const model = new UpgradeModel()
    const { server, origin } = await start(fixture, model)
    expect(await (await fetch(`${origin}/health/ready`)).json()).toEqual({
      status: 'ready',
      releaseId: 'synthetic-upgrade-release',
    })
    const initial = await snapshot(origin)
    expect(initial.upgrade).toMatchObject({ resetContexts: true, sessionCompatibilityId: 'jsonl-v4' })
    expect(initial.agents.map(({ id }) => id)).toEqual(
      expect.arrayContaining([fixture.agent.definition.id, fixture.isolated.definition.id]),
    )
    expect(initial.channels.find(({ id }) => id === fixture.agent.channel.id)?.boundAgentId).toBe(
      fixture.agent.definition.id,
    )
    expect(await messages(origin, fixture.agent.channel.id)).toHaveLength(3)
    expect(model.calls).toEqual([])
    expect(
      readCore(fixture.dataRoot, 'SELECT status, close_reason FROM episodes WHERE id = ?', fixture.episodeId),
    ).toEqual([{ status: 'closed', close_reason: 'incompatible-session-storage' }])
    expect(readCore(fixture.dataRoot, 'SELECT state FROM admissions WHERE id = ?', fixture.admissionId)).toEqual([
      { state: 'cancelled' },
    ])
    expect(
      readCore(fixture.dataRoot, 'SELECT status FROM dynamic_authoring_tasks WHERE id = ?', fixture.taskId),
    ).toEqual([{ status: 'interrupted' }])
    expect(readCore(fixture.dataRoot, 'SELECT count(*) AS count FROM dsh_session_resets')).toEqual([{ count: 1 }])
    expect(
      readCore(
        fixture.dataRoot,
        'SELECT bound_at FROM channel_bindings WHERE channel_id = ?',
        fixture.agent.channel.id,
      ),
    ).toEqual([{ bound_at: 1000 }])
    expect(readCore(fixture.dataRoot, 'SELECT id FROM assets WHERE id = ?', fixture.asset.id)).toEqual([
      { id: fixture.asset.id },
    ])
    const [backup] = await recoveryPoints(fixture.dataRoot)
    if (!backup) throw new Error('Upgrade did not publish a recovery point')
    expect(backup.runtimeFingerprint).toBe(DSH_RUNTIME_FINGERPRINT)
    expect(initial.upgrade?.backupId).toBe(backup.backupId)
    expect(await verifyUpgradeBackup(path.join(fixture.rawDirectory, 'data/backups', backup.backupId))).toEqual(backup)
    for (const [name, content] of Object.entries(fixture.files).filter(([name]) => !name.includes('disposable'))) {
      expect(backup.entries.some((entry) => entry.root === 'data' && entry.path === name)).toBe(true)
      expect(await readFile(path.join(fixture.dataRoot, 'backups', backup.backupId, 'roots/data', name), 'utf8')).toBe(
        content,
      )
    }
    expect(backup.entries.filter((entry) => entry.sqlite).map(({ path: filename }) => filename)).toEqual(
      expect.arrayContaining(['core.sqlite', 'sessions.sqlite']),
    )
    expect(backup.entries.some((entry) => entry.path.includes('disposable') || entry.path.startsWith('backups/'))).toBe(
      false,
    )
    const credentialBackup = path.join(fixture.dataRoot, 'backups', backup.backupId, 'roots/data/dsh/.credentials.yaml')
    if (process.platform !== 'win32') expect((await stat(credentialBackup)).mode & 0o777).toBe(0o600)
    // Windows access follows ACLs, not POSIX mode bits. Verify usability without
    // claiming that stat.mode establishes an ACL or exposing secrets in metadata.
    await access(credentialBackup, constants.R_OK)
    expect(
      await readFile(path.join(fixture.dataRoot, 'backups', backup.backupId, 'manifest.json'), 'utf8'),
    ).not.toContain('synthetic-upgrade-secret')
    await send(origin, fixture.agent.channel.id, 'new-after-upgrade', '新引擎首条消息。')
    await expect.poll(() => sentCount(origin, fixture.agent.channel.id), { timeout: 10_000 }).toBe(2)
    await expect
      .poll(
        async () => (await snapshot(origin)).agents.find(({ id }) => id === fixture.agent.definition.id)?.runtimeStatus,
        { timeout: 10_000 },
      )
      .toBe('idle')
    expect(model.calls.some((call) => call.messages.some((message) => message.role === 'tool'))).toBe(true)
    expect(JSON.stringify(model.calls)).not.toContain('升级前积压不得自动补答。')
    const current = storedSession(fixture.dataRoot, fixture.agent.channel.id)
    await stop(server)
    const events = await readSession(path.join(fixture.dataRoot, 'dsh/sessions'), current.dsh_session_id)
    expect(events.some((event) => event.type === 'user/message')).toBe(true)
    expect(JSON.stringify(events)).toContain('升级后的通信工具已成功发送。')
    const reloadedModel = new UpgradeModel()
    const second = await start(fixture, reloadedModel)
    expect((await snapshot(second.origin)).upgrade?.resetContexts).toBe(false)
    expect(storedSession(fixture.dataRoot, fixture.agent.channel.id)).toEqual(current)
    expect(await recoveryPoints(fixture.dataRoot)).toHaveLength(1)
    expect(reloadedModel.calls).toEqual([])
    expect(await sentCount(second.origin, fixture.agent.channel.id)).toBe(2)
    await send(second.origin, fixture.agent.channel.id, 'new-after-reload', 'JSONL恢复后的第二条消息。')
    await expect.poll(() => sentCount(second.origin, fixture.agent.channel.id), { timeout: 10_000 }).toBe(3)
    await expect
      .poll(
        async () =>
          (await snapshot(second.origin)).agents.find(({ id }) => id === fixture.agent.definition.id)?.runtimeStatus,
        { timeout: 10_000 },
      )
      .toBe('idle')
    expect(JSON.stringify(reloadedModel.calls)).toContain('新引擎首条消息。')
    expect(readCore(fixture.dataRoot, 'SELECT count(*) AS count FROM dsh_session_resets')).toEqual([{ count: 1 }])
    await stop(second.server)
    expect(
      (await readSession(path.join(fixture.dataRoot, 'dsh/sessions'), current.dsh_session_id)).length,
    ).toBeGreaterThan(events.length)
    const patch = await start(fixture, new UpgradeModel(), 'synthetic-product-patch')
    expect((await snapshot(patch.origin)).upgrade?.resetContexts).toBe(false)
    expect(storedSession(fixture.dataRoot, fixture.agent.channel.id)).toEqual(current)
    await stop(patch.server)
    const patchBackup = (await recoveryPoints(fixture.dataRoot)).find(
      ({ releaseId }) => releaseId === 'synthetic-product-patch',
    )
    expect(patchBackup?.sourceRuntimeFingerprint).toBe(DSH_RUNTIME_FINGERPRINT)
    expect(patchBackup?.entries.some(({ path: filename }) => filename.startsWith('dsh/sessions/'))).toBe(true)
    await writeFile(path.join(fixture.dataRoot, 'assets/synthetic.txt'), 'new generation')
    await restoreUpgradeBackup({ dataRoot: fixture.dataRoot, backupId: backup.backupId })
    expect(readCore(fixture.dataRoot, 'SELECT status FROM episodes WHERE id = ?', fixture.episodeId)).toEqual([
      { status: 'active' },
    ])
    expect(readCore(fixture.dataRoot, 'SELECT state FROM admissions WHERE id = ?', fixture.admissionId)).toEqual([
      { state: 'claimed' },
    ])
    expect(readCore(fixture.dataRoot, 'SELECT count(*) AS count FROM channel_events')).toEqual([{ count: 2 }])
    expect(readCore(fixture.dataRoot, "SELECT name FROM sqlite_schema WHERE name = 'dsh_session_resets'")).toEqual([])
    const old = new DatabaseSync(path.join(fixture.dataRoot, 'sessions.sqlite'), { readOnly: true })
    try {
      expect(old.prepare('PRAGMA user_version').get()).toEqual({ user_version: 17 })
      expect(old.prepare('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' })
    } finally {
      old.close()
    }
    for (const [name, content] of Object.entries(fixture.files).filter(([name]) => !name.includes('disposable')))
      expect(await readFile(path.join(fixture.dataRoot, name), 'utf8')).toBe(content)
    await expect(stat(path.join(fixture.dataRoot, 'dsh/sessions'))).rejects.toMatchObject({ code: 'ENOENT' })
    const displaced = path.join(fixture.dataRoot, 'backups', `before-restore-${backup.backupId}`, 'data')
    expect(await readFile(path.join(displaced, 'assets/synthetic.txt'), 'utf8')).toBe('new generation')
    expect((await readSession(path.join(displaced, 'dsh/sessions'), current.dsh_session_id)).length).toBeGreaterThan(
      events.length,
    )
  }, 60_000)

  it('backs up and restores only configured owned external workspace directories', async () => {
    const fixture = await createLegacyFixture()
    const externalRoot = path.join(fixture.directory, 'external-workspaces')
    const owned = path.join(externalRoot, fixture.agent.definition.id)
    const other = path.join(externalRoot, 'unmanaged-sibling')
    await mkdir(owned, { recursive: true })
    await mkdir(other, { recursive: true })
    await writeFile(path.join(owned, 'source.ts'), 'owned-before-upgrade')
    await writeFile(path.join(other, 'source.ts'), 'unmanaged-before-upgrade')
    const server = await startNekroServer({
      dataRoot: fixture.dataRoot,
      distIndex: fixture.distIndex,
      developmentWorkspaceRoot: externalRoot,
      releaseId: 'synthetic-external-workspace-upgrade',
      configureLlm(context) {
        context.llm.registerAdapter(['upgrade-provider'], new UpgradeModel())
      },
    })
    servers.add(server)
    const [backup] = await recoveryPoints(fixture.dataRoot)
    if (!backup) throw new Error('Missing external workspace recovery point')
    const externalRoots = backup.roots.filter(({ key }) => key !== 'data')
    expect(externalRoots.map(({ target }) => target)).toEqual([owned])
    expect(
      backup.entries.some(({ root, path: filename }) => root === externalRoots[0]?.key && filename === 'source.ts'),
    ).toBe(true)
    expect(backup.entries.some(({ path: filename }) => filename.includes('unmanaged-sibling'))).toBe(false)
    await stop(server)
    await writeFile(path.join(owned, 'source.ts'), 'owned-new-generation')
    await writeFile(path.join(other, 'source.ts'), 'unmanaged-new-generation')
    await restoreUpgradeBackup({ dataRoot: fixture.dataRoot, backupId: backup.backupId, externalRoots })
    expect(await readFile(path.join(owned, 'source.ts'), 'utf8')).toBe('owned-before-upgrade')
    expect(await readFile(path.join(other, 'source.ts'), 'utf8')).toBe('unmanaged-new-generation')
  }, 30_000)

  it('isolates one incompatible model while preserving inbound and allows explicit repair without changing its Revision', async () => {
    const fixture = await createLegacyFixture()
    const model = new UpgradeModel()
    const { server, origin } = await start(fixture, model)
    const initial = await snapshot(origin)
    expect(initial.upgrade?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          objectKind: 'agent',
          objectId: fixture.isolated.definition.id,
          status: 'isolated',
          retryable: true,
        }),
        expect.objectContaining({ objectKind: 'agent', objectId: fixture.agent.definition.id, status: 'compatible' }),
      ]),
    )
    const inbound = await send(origin, fixture.isolated.channel.id, 'isolated-inbound', '隔离时仍然保存这条消息。')
    expect(inbound.inserted).toBe(true)
    expect(await messages(origin, fixture.isolated.channel.id)).toHaveLength(1)
    expect(model.calls).toEqual([])
    expect(
      readCore(fixture.dataRoot, 'SELECT id FROM episodes WHERE agent_id = ?', fixture.isolated.definition.id),
    ).toEqual([])
    model.allowRetiredModel = true
    const retried = await fetch(`${origin}/api/runtime/compatibility/retry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ objectKind: 'agent', objectId: fixture.isolated.definition.id }),
    })
    expect(retried.status, await retried.clone().text()).toBe(200)
    expect(HostApiContracts.retryRuntimeCompatibility.parseResponse(await retried.json()).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ objectId: fixture.isolated.definition.id, status: 'compatible' }),
      ]),
    )
    await expect.poll(() => sentCount(origin, fixture.isolated.channel.id), { timeout: 10_000 }).toBe(1)
    expect(
      readCore(
        fixture.dataRoot,
        'SELECT revision_id AS current_revision_id FROM agent_current_revisions WHERE agent_id = ?',
        fixture.isolated.definition.id,
      ),
    ).toEqual([{ current_revision_id: fixture.isolated.revision.id }])
    await stop(server)
  }, 30_000)
})
