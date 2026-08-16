import type { AssetId } from '@nekro-nxt/contracts'
import { AssetService, CoreService } from '@nekro-nxt/core'
import { openMigratedCoreDatabase, SqliteCoreRepository } from '@nekro-nxt/storage-sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { QQCoreBridge, QQRemoteAssetImporter } from '../src/qq-openclaw.ts'

describe('QQ product bridge', () => {
  it('persists target/member identity, resolves quotes and forwards attachment context without database access', async () => {
    const database = await openMigratedCoreDatabase(':memory:')
    try {
      const repository = new SqliteCoreRepository(database)
      let id = 0
      const core = new CoreService(repository, { now: () => 100, nextUlid: () => `Q${++id}` })
      const connection = core.createConnection({ adapterKey: 'qq-openclaw', config: {} })
      const imported: unknown[] = []
      const bridge = new QQCoreBridge(core, {
        import: (input) => {
          imported.push(input)
          return Promise.resolve({
            assetId: 'asset-1' as AssetId,
            mediaType: input.mediaType ?? 'application/octet-stream',
            ...(input.fileName === undefined ? {} : { fileName: input.fileName }),
          })
        },
      })
      const target = { kind: 'group' as const, openId: 'group-openid' }
      const channelId = await bridge.ensureTarget({
        connectionId: connection.id,
        target,
        displayName: '测试群',
        observedAt: 101,
      })
      const memberId = await bridge.ensureMember({
        connectionId: connection.id,
        channelId,
        openId: 'member-openid',
        displayName: '成员甲',
        observedAt: 102,
      })
      await expect(bridge.resolveTarget(connection.id, channelId)).resolves.toEqual(target)
      await expect(bridge.resolveMemberOpenId(connection.id, channelId, memberId)).resolves.toBe('member-openid')

      const inbound = core.appendInbound({
        connectionId: connection.id,
        channelId,
        adapterKey: 'qq-openclaw',
        platformEventId: 'GROUP_MESSAGE_CREATE:qq-message-1',
        platformMessageId: 'qq-message-1',
        kind: 'message-created',
        senderMemberId: memberId,
        parts: [{ type: 'text', text: '原消息' }],
        platformTimestamp: 103,
        receivedAt: 103,
        dedupeKey: 'qq:message-1',
      })
      await expect(
        bridge.resolveQuote({
          connectionId: connection.id,
          target,
          platformReference: 'qq-message-1',
        }),
      ).resolves.toEqual({ messageId: inbound.event.logicalMessageId, authoredByAgent: false })
      await expect(
        bridge.resolvePlatformMessageId(connection.id, channelId, inbound.event.logicalMessageId),
      ).resolves.toBe('qq-message-1')

      await bridge.importAttachment({
        url: 'https://cdn.test/video.mp4',
        mediaType: 'video/mp4',
        fileName: 'video.mp4',
        connectionId: connection.id,
        channelId,
        platformMessageId: 'qq-message-2',
        receivedAt: 104,
        attachmentIndex: 0,
        signal: new AbortController().signal,
      })
      expect(imported).toEqual([
        expect.objectContaining({
          mediaType: 'video/mp4',
          platformMessageId: 'qq-message-2',
          channelId,
          receivedAt: 104,
        }),
      ])
    } finally {
      database.close()
    }
  })

  it('reserves, finalizes and replay-deduplicates remote media around the Channel Event commit', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-qq-assets-'))
    const database = await openMigratedCoreDatabase(':memory:')
    try {
      const repository = new SqliteCoreRepository(database)
      let id = 0
      const core = new CoreService(repository, { now: () => 200, nextUlid: () => `M${++id}` })
      const connection = core.createConnection({ adapterKey: 'qq-openclaw', config: {} })
      const channel = core.createChannel({
        connectionId: connection.id,
        platformChannelId: 'group:media',
        kind: 'group',
      })
      const event = core.appendInbound({
        connectionId: connection.id,
        channelId: channel.id,
        adapterKey: 'qq-openclaw',
        platformMessageId: 'media-message',
        kind: 'message-created',
        parts: [{ type: 'text', text: '媒体占位事实' }],
        platformTimestamp: 201,
        receivedAt: 201,
        dedupeKey: 'media-message',
      })
      const assetService = new AssetService(repository, directory, { now: () => 202, nextUlid: () => `A${++id}` })
      const fetchAsset: typeof fetch = () =>
        Promise.resolve(
          new Response(new Uint8Array([1, 2, 3]), {
            headers: { 'content-type': 'video/mp4', 'content-length': '3' },
          }),
        )
      const importer = new QQRemoteAssetImporter(assetService, {
        fetch: fetchAsset,
      })
      const input = {
        url: 'https://cdn.test/video.mp4',
        fileName: 'video.mp4',
        mediaType: 'video/mp4',
        connectionId: connection.id,
        channelId: channel.id,
        platformMessageId: 'media-message',
        receivedAt: 201,
        attachmentIndex: 0,
        signal: new AbortController().signal,
      }
      const first = await importer.import(input)
      const replay = await importer.import(input)
      expect(replay.assetId).toBe(first.assetId)
      await first.finalize?.(event.event.id)
      await replay.finalize?.(event.event.id)
      expect(database.prepare('SELECT COUNT(*) AS count FROM assets').get()).toEqual({ count: 1 })
      expect(database.prepare('SELECT receive_count FROM assets').get()).toEqual({ receive_count: 1 })
      expect(database.prepare('SELECT COUNT(*) AS count FROM asset_occurrences').get()).toEqual({ count: 1 })
    } finally {
      database.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
