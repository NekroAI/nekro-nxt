import { count } from 'drizzle-orm'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AssetService, CoreService } from '@nekro-nxt/core'
import { assetChannelGrants, channelEvents, openMigratedCoreDatabase, SqliteCoreRepository } from '../src/index.ts'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('channel-scoped Asset grants', () => {
  it('persists a model-created grant without creating a Channel Event and restores it after reopen', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-asset-grant-'))
    directories.push(directory)
    const filename = path.join(directory, 'core.sqlite')
    const database = await openMigratedCoreDatabase(filename)
    const repository = new SqliteCoreRepository(database)
    let sequence = 0
    const core = new CoreService(repository, { now: () => 100, nextUlid: () => `G${++sequence}` })
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
    const prepared = await new AssetService(repository, path.join(directory, 'assets'), {
      now: () => 101,
      nextUlid: () => 'CONTENT',
    }).prepare({ bytes: new TextEncoder().encode('model output') })

    const grant = repository.grantAssetAccess({
      assetId: prepared.asset.id,
      channelId: currentChannel.id,
      source: 'agent-tool',
      grantedAt: 102,
    })
    expect(grant).toEqual({
      assetId: prepared.asset.id,
      channelId: currentChannel.id,
      source: 'agent-tool',
      grantedAt: 102,
    })
    expect(repository.canAccessAsset(prepared.asset.id, currentChannel.id)).toBe(true)
    expect(repository.canAccessAsset(prepared.asset.id, otherChannel.id)).toBe(false)
    expect(database.db.select({ value: count() }).from(assetChannelGrants).get()?.value).toBe(1)
    expect(database.db.select({ value: count() }).from(channelEvents).get()?.value).toBe(0)
    database.close()

    const reopened = await openMigratedCoreDatabase(filename)
    try {
      const reopenedRepository = new SqliteCoreRepository(reopened)
      expect(reopenedRepository.canAccessAsset(prepared.asset.id, currentChannel.id)).toBe(true)
      expect(reopenedRepository.canAccessAsset(prepared.asset.id, otherChannel.id)).toBe(false)
    } finally {
      reopened.close()
    }
  })
})
