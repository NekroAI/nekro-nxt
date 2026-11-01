import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AssetService, CoreService } from '@nekro-nxt/core'
import { openMigratedCoreDatabase, SqliteCoreRepository } from '@nekro-nxt/storage-sqlite'
import { saveAssetToWorkspace } from '../src/asset-save-tool.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const setup = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'nxt-asset-save-'))
  directories.push(root)
  const database = await openMigratedCoreDatabase(path.join(root, 'core.sqlite'))
  const repository = new SqliteCoreRepository(database)
  const core = new CoreService(repository)
  const connection = core.createConnection({ adapterKey: 'fixture-alpha', config: {} })
  const roomA = core.createChannel({ connectionId: connection.id, platformChannelId: 'room-a', kind: 'group' })
  const roomB = core.createChannel({ connectionId: connection.id, platformChannelId: 'room-b', kind: 'group' })
  const assetService = new AssetService(repository, path.join(root, 'assets'))
  const workspace = path.join(root, 'workspace')
  await mkdir(workspace)
  const { asset } = await assetService.prepare({ bytes: new TextEncoder().encode('示例语音文字稿') })
  repository.grantAssetAccess({ assetId: asset.id, channelId: roomA.id, source: 'agent-tool', grantedAt: 1 })
  const save = (input: { readonly assetId?: string; readonly path?: string; readonly channelId?: typeof roomA.id }) =>
    saveAssetToWorkspace({
      channelId: input.channelId ?? roomA.id,
      assetId: input.assetId ?? asset.id,
      path: input.path,
      workspace,
      assets: repository,
      assetService,
    })
  return { root, database, workspace, asset, roomB, save }
}

describe('asset_save_to_workspace', () => {
  it('copies a channel file into the workspace without overwriting anything', async () => {
    const { database, workspace, asset, save } = await setup()
    try {
      const first = await save({})
      expect(first).toEqual({ path: `attachments/${asset.id}`, byteSize: asset.byteSize, mediaType: asset.mediaType })
      expect(await readFile(path.join(workspace, first.path), 'utf8')).toBe('示例语音文字稿')
      expect((await save({})).path).toBe(`attachments/${asset.id}-2`)

      await writeFile(path.join(workspace, 'notes.txt'), '自己写的笔记')
      expect((await save({ path: 'notes.txt' })).path).toBe('notes-2.txt')
      expect(await readFile(path.join(workspace, 'notes.txt'), 'utf8')).toBe('自己写的笔记')
      expect((await save({ path: 'clips/' })).path).toBe(`clips/${asset.id}`)
      expect((await save({ path: 'clips/raw/voice.silk' })).path).toBe('clips/raw/voice.silk')
    } finally {
      database.close()
    }
  })

  it('stays inside the workspace and the current channel', async () => {
    const { root, database, workspace, roomB, save } = await setup()
    try {
      await expect(save({ path: '../outside.txt' })).rejects.toThrow('工作区里的位置')
      await expect(save({ path: path.join(root, 'outside.txt') })).rejects.toThrow('工作区里的位置')
      await mkdir(path.join(root, 'elsewhere'))
      await symlink(path.join(root, 'elsewhere'), path.join(workspace, 'link'))
      await expect(save({ path: 'link/escape.txt' })).rejects.toThrow('工作区里的位置')
      await expect(save({ channelId: roomB.id })).rejects.toThrow('当前频道里找不到资源')
      await expect(save({ assetId: 'not-an-asset' })).rejects.toThrow('当前频道里找不到资源')
    } finally {
      database.close()
    }
  })
})
