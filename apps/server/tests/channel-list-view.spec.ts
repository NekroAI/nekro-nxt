import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { AgentIdSchema, ChannelIdSchema, HostApiContracts, type JsonValue } from '@nekro-nxt/contracts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NekroRuntime } from '../src/bootstrap.js'
import { readChannelListView, writeChannelListView } from '../src/channel-list-view.js'
import { createNekroHostApi } from '../src/host-api.js'

const maple = AgentIdSchema.parse('agt_maple')
const clerk = AgentIdSchema.parse('agt_clerk')
const lobby = ChannelIdSchema.parse('chn_lobby')
const notes = ChannelIdSchema.parse('chn_notes')
const gone = ChannelIdSchema.parse('chn_gone')

const memoryStore = () => {
  const rows = new Map<string, { value: JsonValue; revision: number }>()
  const revisions: Array<number | undefined> = []
  return {
    rows,
    revisions,
    get: (key: string) => rows.get(key),
    put: (key: string, value: JsonValue, expectedRevision: number | undefined) => {
      revisions.push(expectedRevision)
      rows.set(key, { value, revision: (rows.get(key)?.revision ?? 0) + 1 })
    },
  }
}

describe('channel list view store', () => {
  const known = { channelIds: new Set<string>([lobby, notes]), agentIds: new Set<string>([maple, clerk]) }

  it('starts empty and keeps pin order and collapsed groups as written', () => {
    const store = memoryStore()
    expect(readChannelListView(store, known)).toEqual({ pinnedChannelIds: [], collapsedGroupIds: [] })
    writeChannelListView(store, { pinnedChannelIds: [notes, lobby], collapsedGroupIds: ['unbound', clerk] }, known)
    expect(readChannelListView(store, known)).toEqual({
      pinnedChannelIds: [notes, lobby],
      collapsedGroupIds: ['unbound', clerk],
    })
    writeChannelListView(store, { pinnedChannelIds: [lobby], collapsedGroupIds: [] }, known)
    expect(store.revisions).toEqual([undefined, 1])
    expect(readChannelListView(store, known)).toEqual({ pinnedChannelIds: [lobby], collapsedGroupIds: [] })
  })

  it('drops duplicates and ids of deleted channels and agents', () => {
    const store = memoryStore()
    const saved = writeChannelListView(
      store,
      {
        pinnedChannelIds: [lobby, gone, lobby],
        collapsedGroupIds: [maple, AgentIdSchema.parse('agt_gone'), maple],
      },
      known,
    )
    expect(saved).toEqual({ pinnedChannelIds: [lobby], collapsedGroupIds: [maple] })
    // A channel deleted after it was pinned disappears on read without a write.
    expect(readChannelListView(store, { ...known, channelIds: new Set<string>([notes]) })).toEqual({
      pinnedChannelIds: [],
      collapsedGroupIds: [maple],
    })
  })

  it('reads a malformed record as empty', () => {
    const store = memoryStore()
    store.rows.set('console.channelListView', { value: { pinnedChannelIds: 'lobby' }, revision: 3 })
    expect(readChannelListView(store, known)).toEqual({ pinnedChannelIds: [], collapsedGroupIds: [] })
  })
})

const temporaryDirectories: string[] = []
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('channel list view API', () => {
  it('saves the view for every device, returns it in the snapshot and rejects malformed input', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nxt-channel-list-view-'))
    temporaryDirectories.push(directory)
    const runtime = await NekroRuntime.create({
      coreDatabasePath: path.join(directory, 'core.sqlite'),
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      assetRoot: path.join(directory, 'assets'),
      extensionDataRoot: path.join(directory, 'extension-data'),
      extensionCacheRoot: path.join(directory, 'extension-cache'),
    })
    const seeded = runtime.core.createAgentWithChannel(
      { displayName: '置顶测试', persona: '', model: { provider: 'test-provider', model: 'chat-model' } },
      { connectionId: runtime.internalConnectionId, kind: 'internal', triggerPolicy: 'always' },
    )
    await runtime.start()
    const webContext = new Context()
    await webContext.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const api = createNekroHostApi(webContext.webServer, runtime)
    cleanups.push(async () => {
      api.dispose()
      await webContext.fiber.dispose()
      await runtime.dispose()
    })
    const origin = `http://127.0.0.1:${api.port}`
    const put = (body: unknown) =>
      fetch(`${origin}/api/channel-list-view`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })

    const initial = await fetch(`${origin}/api/channel-list-view`)
    expect(HostApiContracts.getChannelListView.parseResponse(await initial.json())).toEqual({
      pinnedChannelIds: [],
      collapsedGroupIds: [],
    })

    const saved = await put({ pinnedChannelIds: [seeded.channel.id, gone], collapsedGroupIds: [seeded.definition.id] })
    expect(saved.status, await saved.clone().text()).toBe(200)
    const expected = { pinnedChannelIds: [seeded.channel.id], collapsedGroupIds: [seeded.definition.id] }
    expect(HostApiContracts.updateChannelListView.parseResponse(await saved.json())).toEqual(expected)

    // A paired device reads the same arrangement as the local console.
    const fromDevice = await fetch(`${origin}/api/snapshot`, { headers: { 'x-nxt-viewer': 'device:nxt_device_A1' } })
    expect(HostApiContracts.snapshot.parseResponse(await fromDevice.json()).channelListView).toEqual(expected)
    const local = await fetch(`${origin}/api/channel-list-view`)
    expect(HostApiContracts.getChannelListView.parseResponse(await local.json())).toEqual(expected)

    expect((await put({ pinnedChannelIds: ['not-a-channel'], collapsedGroupIds: [] })).status).toBe(400)
    expect((await put({ pinnedChannelIds: [], collapsedGroupIds: [], extra: true })).status).toBe(400)
  })
})
