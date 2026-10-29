import { LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { HostApiContracts, type JsonValue } from '@nekro-nxt/contracts'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createDataMoveRecord, runDataMove } from '../../desktop/src/data-move.ts'
import { preflightMove } from '../../desktop/src/data-move-plan.ts'
import { verifySqliteIntegrity } from '@nekro-nxt/storage-sqlite'
import {
  DATA_ROOT_MOVED_MARKER,
  prepareDataRootMoveRollover,
  type PendingRolloverStore,
} from '../src/data-root-move.js'
import { startNekroServer, type NekroServerHandle } from '../src/main.js'

const directories: string[] = []
const servers = new Set<NekroServerHandle>()

afterEach(async () => {
  await Promise.all([...servers].map((server) => server.stop()))
  servers.clear()
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 3 })),
  )
})

class QuietModel extends LlmAdapter {
  calls = 0
  override providerInfo(provider: string) {
    return { id: provider, name: 'Data move test provider' }
  }
  override listModels(provider: string) {
    return Promise.resolve([{ provider, id: 'move-model', name: 'Move model' }])
  }
  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 16_000 } })
  }
  override async *stream(): AsyncIterable<StreamChunk> {
    this.calls += 1
    await Promise.resolve()
    yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const readCore = (dataRoot: string, query: string, ...values: string[]) => {
  const database = new DatabaseSync(path.join(dataRoot, 'core.sqlite'), { readOnly: true })
  try {
    return database.prepare(query).all(...values)
  } finally {
    database.close()
  }
}

const EpisodeRowsSchema = z.array(
  z.object({ id: z.string(), status: z.string(), closeReason: z.string().nullable(), session: z.string().nullable() }),
)
const episodes = (dataRoot: string, channelId: string) =>
  EpisodeRowsSchema.parse(
    readCore(
      dataRoot,
      'SELECT id, status, close_reason AS closeReason, dsh_session_id AS session FROM episodes WHERE channel_id = ? ORDER BY created_at, id',
      channelId,
    ),
  )

const start = async (dataRoot: string, distIndex: string, model: QuietModel) => {
  const server = await startNekroServer({
    dataRoot,
    distIndex,
    configureLlm: (context) => {
      context.llm.registerAdapter(['move-provider'], model)
    },
  })
  servers.add(server)
  return { server, origin: `http://127.0.0.1:${server.port}` }
}

const stop = async (server: NekroServerHandle) => {
  await server.stop()
  servers.delete(server)
}

const send = async (origin: string, channelId: string, clientEventId: string) => {
  const response = await fetch(`${origin}/api/channels/${channelId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientEventId, parts: [{ type: 'text', text: '虚构的测试消息' }] }),
  })
  expect(response.status, await response.clone().text()).toBe(200)
}

describe('data root move rollover marker', () => {
  const store = (live: readonly string[]) => {
    let value: { value: JsonValue; revision: number } | undefined
    const fake: PendingRolloverStore = {
      getSystemSetting: (key) =>
        value === undefined ? undefined : { key, value: value.value, revision: value.revision, updatedAt: 0 },
      putSystemSetting: (_key, next, revision) => {
        if (revision !== value?.revision) throw new Error('revision conflict')
        value = { value: next, revision: (value?.revision ?? 0) + 1 }
      },
      listRecoverableEpisodes: () => live.map((id) => ({ id })),
    }
    return fake
  }

  it('turns the marker into a durable list of live episodes and settles each once', async () => {
    const dataRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'nxt-move-marker-')))
    directories.push(dataRoot)
    await mkdir(path.join(dataRoot, 'host'))
    await writeFile(
      path.join(dataRoot, DATA_ROOT_MOVED_MARKER),
      JSON.stringify({ format: 'nxt.data-root-moved', version: 1, movedAt: 1 }),
    )
    const fake = store(['eps_a', 'eps_b'])
    const rollover = await prepareDataRootMoveRollover({ dataRoot, store: fake, now: () => 5 })
    await expect(readFile(path.join(dataRoot, DATA_ROOT_MOVED_MARKER))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(rollover.reasonFor({ id: 'eps_a' })).toBe('incompatible-session-storage')
    expect(rollover.reasonFor({ id: 'eps_c' })).toBeUndefined()
    rollover.settle('eps_a')
    // A restart without the marker keeps what is still pending.
    const again = await prepareDataRootMoveRollover({ dataRoot, store: fake, now: () => 6 })
    expect(again.pending()).toEqual(['eps_b'])
    expect(again.reasonFor({ id: 'eps_a' })).toBeUndefined()
  })

  it('drops pending episodes that ended some other way', async () => {
    const dataRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'nxt-move-marker-')))
    directories.push(dataRoot)
    await mkdir(path.join(dataRoot, 'host'))
    await writeFile(
      path.join(dataRoot, DATA_ROOT_MOVED_MARKER),
      '{"format":"nxt.data-root-moved","version":1,"movedAt":1}',
    )
    const fake = store(['eps_a'])
    await prepareDataRootMoveRollover({ dataRoot, store: fake, now: () => 5 })
    const later = await prepareDataRootMoveRollover({
      dataRoot,
      store: { ...fake, listRecoverableEpisodes: () => [] },
      now: () => 6,
    })
    expect(later.pending()).toEqual([])
  })
})

describe('Desktop data directory move with a real Host', () => {
  it.each(['move', 'copy'] as const)(
    'starts on the new directory after a %s and hands every channel off to a new session',
    async (method) => {
      const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'nxt-data-move-host-')))
      directories.push(directory)
      const userData = path.join(directory, 'old', 'NekroNxt')
      const oldData = path.join(userData, 'data')
      const distIndex = path.join(directory, 'web', 'index.html')
      await mkdir(path.dirname(distIndex), { recursive: true })
      await writeFile(distIndex, '<div id="root"></div>')
      await mkdir(userData, { recursive: true })
      await writeFile(path.join(userData, 'Local State'), '{"os_crypt":{"encrypted_key":"ZmljdGlvbmFs"}}')

      const model = new QuietModel()
      const first = await start(oldData, distIndex, model)
      const created = await fetch(`${first.origin}/api/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          displayName: '迁移测试智能体',
          persona: '',
          model: { provider: 'move-provider', model: 'move-model' },
          capabilities: {
            subagents: false,
            fileTools: true,
            webSearch: false,
            dynamicCreation: false,
            developmentShell: false,
            unrestrictedFileAccess: false,
          },
        }),
      })
      expect(created.status, await created.clone().text()).toBe(201)
      const { agentId, channelId } = HostApiContracts.createAgent.parseResponse(await created.json())
      await send(first.origin, channelId, 'before-move')
      await expect
        .poll(() => episodes(oldData, channelId).filter((row) => row.status === 'active' && row.session).length, {
          timeout: 60_000,
        })
        .toBe(1)
      await expect.poll(() => model.calls, { timeout: 60_000 }).toBeGreaterThan(0)
      const before = episodes(oldData, channelId)[0]!
      await stop(first.server)

      const target = path.join(directory, 'new', 'NXT')
      const preflight = await preflightMove(userData, target, {
        storage: {
          platform: process.platform,
          env: {},
          homedir: '/nonexistent-home',
          readText: () => Promise.resolve(undefined),
          mounts: () => Promise.resolve([]),
          fileSystemType: () => Promise.resolve(undefined),
          windowsDriveType: () => Promise.resolve('Fixed'),
        },
        deviceOf: (candidate) => Promise.resolve(method === 'copy' && candidate !== userData ? 2 : 1),
        availableBytes: () => Promise.resolve(10 ** 12),
      })
      if (!preflight.ok) throw new Error(JSON.stringify(preflight.problem))
      expect(preflight.plan.method).toBe(method)
      await runDataMove(
        { ...createDataMoveRecord(preflight.plan, 1, process.pid), phase: 'moving' },
        { writeRecord: () => Promise.resolve(), checkSqlite: verifySqliteIntegrity },
      )

      const newData = path.join(target, 'data')
      const second = await start(newData, distIndex, model)
      const ready = await fetch(`${second.origin}/health/ready`)
      expect(ready.status).toBe(200)
      const snapshot = HostApiContracts.snapshot.parseResponse(
        await (await fetch(`${second.origin}/api/snapshot`)).json(),
      )
      expect(snapshot.agents.map((agent) => agent.id)).toContain(agentId)
      await send(second.origin, channelId, 'after-move')
      await expect
        .poll(() => episodes(newData, channelId).find((row) => row.id === before.id)?.closeReason, { timeout: 60_000 })
        .toBe('incompatible-session-storage')
      // The rollover commits the old episode's close before the new session opens; wait for the new one to go live.
      await expect
        .poll(() => episodes(newData, channelId).filter((row) => row.status === 'active' && row.session).length, {
          timeout: 60_000,
        })
        .toBe(1)
      const active = episodes(newData, channelId).filter((row) => row.status === 'active')
      expect(active).toHaveLength(1)
      expect(active[0]!.session).not.toBe(before.session)
      expect(readCore(newData, 'SELECT id FROM episode_handoffs WHERE from_episode_id = ?', before.id)).toHaveLength(1)
      // The new session lives under the new workspace path.
      const projects = await readdir(path.join(newData, 'dsh', 'sessions'))
      expect(projects.some((name) => name.includes('new-NXT-data-workspaces'))).toBe(true)
      await stop(second.server)

      // A later restart does not roll the new session over again.
      const third = await start(newData, distIndex, model)
      const callsBefore = model.calls
      await send(third.origin, channelId, 'after-restart')
      await expect.poll(() => model.calls, { timeout: 60_000 }).toBeGreaterThan(callsBefore)
      expect(episodes(newData, channelId).filter((row) => row.status === 'active')[0]!.id).toBe(active[0]!.id)
      await stop(third.server)
    },
    300_000,
  )
})
