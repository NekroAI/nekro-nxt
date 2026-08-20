import { createWebAdapterConnection } from '@nekro-nxt/adapter-web'
import { ChannelRuntime, type AgentSessionDriver } from '@nekro-nxt/channel-runtime'
import { AssetService, CoreService } from '@nekro-nxt/core'
import { AssetIdSchema, EpisodeIdSchema } from '@nekro-nxt/contracts'
import { openMigratedCoreDatabase, SqliteCoreRepository } from '@nekro-nxt/storage-sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MODEL_ASSET_MAX_BYTES, assertChannelAssetAccess, createChannelAsset } from '../src/index.ts'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const createFixture = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-channel-asset-'))
  directories.push(directory)
  const database = await openMigratedCoreDatabase(path.join(directory, 'core.sqlite'))
  const repository = new SqliteCoreRepository(database)
  let sequence = 0
  const core = new CoreService(repository, { now: () => 100, nextUlid: () => `A${++sequence}` })
  const connection = core.createConnection({ adapterKey: 'web', config: {} })
  const currentChannel = core.createChannel({
    connectionId: connection.id,
    platformChannelId: 'current',
    kind: 'web',
  })
  const otherChannel = core.createChannel({
    connectionId: connection.id,
    platformChannelId: 'other',
    kind: 'web',
  })
  const assetService = new AssetService(repository, path.join(directory, 'assets'), {
    now: () => 200,
    nextUlid: () => `CONTENT${++sequence}`,
  })
  return { database, repository, core, connection, currentChannel, otherChannel, assetService }
}

const executeAssetCreate = async (
  fixture: Awaited<ReturnType<typeof createFixture>>,
  args: { readonly encoding: 'utf8' | 'base64'; readonly content: string },
) =>
  createChannelAsset({
    channelId: fixture.currentChannel.id,
    encoding: args.encoding,
    content: args.content,
    assets: fixture.repository,
    assetService: fixture.assetService,
    grantedAt: 300,
  })

describe('model-created channel Assets', () => {
  it('creates UTF-8 and base64 Assets, returns detected metadata, and grants only the current Channel', async () => {
    const fixture = await createFixture()
    try {
      const utf8Content = '生成的 UTF-8 内容：你好，频道。'
      const utf8 = await executeAssetCreate(fixture, { encoding: 'utf8', content: utf8Content })
      expect(utf8).toMatchObject({
        byteSize: new TextEncoder().encode(utf8Content).byteLength,
      })
      expect(utf8.assetId).toMatch(/^ast_/u)
      expect(utf8.mediaType).toEqual(expect.any(String))
      const utf8AssetId = AssetIdSchema.parse(utf8.assetId)
      expect(fixture.repository.canAccessAsset(utf8AssetId, fixture.currentChannel.id)).toBe(true)
      expect(fixture.repository.canAccessAsset(utf8AssetId, fixture.otherChannel.id)).toBe(false)
      expect(fixture.repository.listChannelEvents(fixture.currentChannel.id)).toHaveLength(0)

      const png = await executeAssetCreate(fixture, {
        encoding: 'base64',
        content: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZQAAAABJRU5ErkJggg==',
      })
      expect(png).toMatchObject({ byteSize: 67, mediaType: 'image/png' })
      const pngAssetId = AssetIdSchema.parse(png.assetId)
      expect(fixture.repository.canAccessAsset(pngAssetId, fixture.currentChannel.id)).toBe(true)
      expect(fixture.repository.canAccessAsset(pngAssetId, fixture.otherChannel.id)).toBe(false)
    } finally {
      fixture.database.close()
    }
  })

  it('rejects oversized UTF-8 and malformed or unsupported base64 input with explicit errors', async () => {
    const fixture = await createFixture()
    try {
      await expect(
        executeAssetCreate(fixture, { encoding: 'utf8', content: 'x'.repeat(MODEL_ASSET_MAX_BYTES + 1) }),
      ).rejects.toThrow(`asset_create UTF-8 content exceeds ${MODEL_ASSET_MAX_BYTES} bytes.`)
      await expect(executeAssetCreate(fixture, { encoding: 'base64', content: 'not valid base64!' })).rejects.toThrow(
        'asset_create base64 content is invalid',
      )
      await expect(
        createChannelAsset({
          channelId: fixture.currentChannel.id,
          encoding: 'hex',
          content: '00',
          assets: fixture.repository,
          assetService: fixture.assetService,
          grantedAt: 300,
        }),
      ).rejects.toThrow('encoding')
    } finally {
      fixture.database.close()
    }
  })

  it('rejects a file part when the Asset belongs to another Channel', async () => {
    const fixture = await createFixture()
    try {
      const created = await executeAssetCreate(fixture, { encoding: 'utf8', content: 'private current channel' })
      expect(() =>
        assertChannelAssetAccess(
          [{ type: 'file', assetId: AssetIdSchema.parse(created.assetId) }],
          fixture.otherChannel.id,
          fixture.repository,
        ),
      ).toThrow('current Channel')
    } finally {
      fixture.database.close()
    }
  })

  it('passes a created Asset through the authorized Channel Runtime path to the Adapter', async () => {
    const fixture = await createFixture()
    const agent = fixture.core.createAgent({
      displayName: '资源发送智能体',
      persona: '',
      model: { provider: 'test', model: 'test' },
    })
    const opened = fixture.core.appendInbound({
      connectionId: fixture.connection.id,
      channelId: fixture.currentChannel.id,
      adapterKey: 'web',
      kind: 'control',
      parts: [],
      platformTimestamp: 400,
      receivedAt: 400,
      dedupeKey: 'asset-test-open',
    }).event
    const episodeId = EpisodeIdSchema.parse('eps_ASSETDELIVERY')
    fixture.repository.createEpisode({
      id: episodeId,
      channelId: fixture.currentChannel.id,
      agentId: agent.definition.id,
      agentRevisionId: agent.revision.id,
      status: 'opening',
      openedAtEventId: opened.id,
      createdAt: 401,
    })
    fixture.repository.activateEpisode(episodeId, 'dsh-asset-test')

    const runtimeRef: { current?: ChannelRuntime } = {}
    const web = createWebAdapterConnection(
      fixture.connection.id,
      () => {
        if (!runtimeRef.current) return Promise.reject(new Error('Channel Runtime is not ready.'))
        return Promise.reject(new Error('Inbound is not used by this test.'))
      },
      () => 500,
    )
    const adapterParts: unknown[] = []
    web.subscribe(({ request }) => {
      adapterParts.push(...request.parts)
    })
    let deliverySequence = 0
    const sessionDriver: AgentSessionDriver = {
      createSession: () => Promise.reject(new Error('not used')),
      applyCompatibleRevision: () => Promise.reject(new Error('not used')),
      sessionStatus: () => 'idle',
      findAdmissionMessage: () => undefined,
      createHandoffSummary: () => Promise.reject(new Error('not used')),
      cancelSession: () => Promise.reject(new Error('not used')),
      admit: () => Promise.reject(new Error('not used')),
      notifyConsoleOutbound: () => Promise.reject(new Error('not used')),
    }
    const runtime = new ChannelRuntime(fixture.core, fixture.repository, fixture.repository, sessionDriver, {
      now: () => 500,
      nextUlid: () => `DELIVERY${++deliverySequence}`,
      resolveAdapter: (connectionId) => (connectionId === fixture.connection.id ? web : undefined),
    })
    runtimeRef.current = runtime
    try {
      await web.start()
      const created = await executeAssetCreate(fixture, { encoding: 'utf8', content: 'file body' })
      const parts = [{ type: 'file' as const, assetId: created.assetId, name: 'generated.txt' }]
      assertChannelAssetAccess(parts, fixture.currentChannel.id, fixture.repository)
      const result = await runtime.sendMessage({
        episodeId,
        parts,
        sourceTurnId: 'call_asset_test',
        clientRequestId: 'asset-test-send',
      })
      expect(result).toMatchObject({ status: 'sent' })
      expect(adapterParts).toEqual([{ type: 'file', assetId: created.assetId, name: 'generated.txt' }])
    } finally {
      await web.stop()
      fixture.database.close()
    }
  })
})
