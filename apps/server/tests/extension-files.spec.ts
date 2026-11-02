import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AssetIdSchema, ExtensionIdSchema, type ExtensionCapabilities } from '@nekro-nxt/contracts'
import { AssetService, CoreService } from '@nekro-nxt/core'
import { localExtensions, openMigratedCoreDatabase, SqliteCoreRepository } from '@nekro-nxt/storage-sqlite'
import { EXTENSION_TEMP_FILE_TTL_MS, ExtensionFileStore } from '../src/extension-files.js'
import {
  createHostLayerNxt,
  createNxtHostService,
  type NxtServiceBackends,
  type NxtServiceBinding,
} from '../src/extension-host-service.js'
import { ExtensionLibrary, sqliteLibraryRegistry } from '../src/extension-library.js'
import { unusedNxtBackends } from './fixtures/unused-nxt-backends.js'

const directories: string[] = []
const stores: ExtensionFileStore[] = []
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.dispose()))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const temporary = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), prefix))
  directories.push(directory)
  return directory
}

const MiB = 1024 * 1024
const quota = { tempBytes: 4 * MiB, cacheBytes: 2 * MiB }
const bytes = (size: number, fill = 7) => new Uint8Array(size).fill(fill)

const fileStore = async (clock: { now: number }, root?: string) => {
  const store = new ExtensionFileStore({
    root: root ?? path.join(await temporary('nekro-nxt-files-'), 'files'),
    blobPath: () => {
      throw new Error('no assets')
    },
    now: () => clock.now,
  })
  stores.push(store)
  await store.start()
  return store
}

describe('extension work files', () => {
  it('writes, reads in ranges, lists and deletes files of one owner', async () => {
    const clock = { now: 1000 }
    const store = await fileStore(clock)
    const written = await store.write(
      'ext_A',
      { bytes: new TextEncoder().encode('示例内容'), name: 'a/../note.txt' },
      quota,
    )
    expect(written).toMatchObject({
      byteSize: 12,
      kind: 'temp',
      name: 'note.txt',
      expiresAt: 1000 + EXTENSION_TEMP_FILE_TTL_MS,
    })
    expect(written.fileId).toMatch(/^file_[a-f0-9]{32}$/u)
    const head = await store.read('ext_A', written.fileId, 0, 6)
    expect(new TextDecoder().decode(head.bytes)).toBe('示例')
    expect(head.eof).toBe(false)
    const tail = await store.read('ext_A', written.fileId, 6, 100)
    expect(new TextDecoder().decode(tail.bytes)).toBe('内容')
    expect(tail.eof).toBe(true)
    expect(await store.delete('ext_A', written.fileId)).toBe(true)
    expect(await store.stat('ext_A', written.fileId)).toBeUndefined()
    await expect(store.read('ext_A', written.fileId, 0, 1)).rejects.toThrow('找不到文件')
  })

  it('keeps every owner to its own files', async () => {
    const store = await fileStore({ now: 1 })
    const written = await store.write('ext_A', { bytes: bytes(10) }, quota)
    expect(await store.stat('ext_B', written.fileId)).toBeUndefined()
    await expect(store.read('ext_B', written.fileId, 0, 10)).rejects.toThrow('找不到文件')
    expect(await store.delete('ext_B', written.fileId)).toBe(false)
    await expect(store.cachePut('ext_B', 'key', written.fileId, quota)).rejects.toThrow('找不到文件')
    await expect(store.resolvePath('ext_B', written.fileId)).rejects.toThrow('找不到文件')
  })

  it('refuses temporary files over the quota and expires them after a day', async () => {
    const clock = { now: 0 }
    const store = await fileStore(clock)
    const first = await store.write('ext_A', { bytes: bytes(3 * MiB) }, quota)
    await expect(store.write('ext_A', { bytes: bytes(2 * MiB) }, quota)).rejects.toThrow('临时文件已满')
    // Another owner has its own quota.
    await store.write('ext_B', { bytes: bytes(2 * MiB) }, quota)
    clock.now = EXTENSION_TEMP_FILE_TTL_MS - 1
    expect(await store.sweep()).toBe(0)
    clock.now = EXTENSION_TEMP_FILE_TTL_MS
    expect(await store.sweep()).toBe(2)
    expect(await store.stat('ext_A', first.fileId)).toBeUndefined()
    await store.write('ext_A', { bytes: bytes(3 * MiB) }, quota)
  })

  it('keeps cached files past expiry and evicts the least recently used when full', async () => {
    const clock = { now: 0 }
    const store = await fileStore(clock)
    const one = await store.write('ext_A', { bytes: bytes(MiB) }, quota)
    const two = await store.write('ext_A', { bytes: bytes(MiB) }, quota)
    expect(await store.cachePut('ext_A', 'frames/one', one.fileId, quota)).toMatchObject({
      kind: 'cache',
      cacheKey: 'frames/one',
    })
    clock.now = 10
    await store.cachePut('ext_A', 'frames/two', two.fileId, quota)
    clock.now = 20
    expect(await store.cacheGet('ext_A', 'frames/one')).toMatchObject({ fileId: one.fileId })
    // Cached files no longer count against the temporary quota.
    expect(store.usage('ext_A')).toEqual({ tempBytes: 0, cacheBytes: 2 * MiB })
    clock.now = 30
    const three = await store.write('ext_A', { bytes: bytes(MiB) }, quota)
    await store.cachePut('ext_A', 'frames/three', three.fileId, quota)
    expect(await store.cacheGet('ext_A', 'frames/two')).toBeUndefined()
    expect(await store.cacheGet('ext_A', 'frames/one')).toMatchObject({ fileId: one.fileId })
    clock.now = 2 * EXTENSION_TEMP_FILE_TTL_MS
    expect(await store.sweep()).toBe(0)
    expect(await store.cacheGet('ext_A', 'frames/three')).toMatchObject({ fileId: three.fileId })
    // Replacing a key removes the file it held.
    const four = await store.write('ext_A', { bytes: bytes(10) }, quota)
    await store.cachePut('ext_A', 'frames/three', four.fileId, quota)
    expect(await store.stat('ext_A', three.fileId)).toBeUndefined()
    expect(await store.cacheDelete('ext_A', 'frames/three')).toBe(true)
    expect(await store.stat('ext_A', four.fileId)).toBeUndefined()
    const huge = await store.write('ext_A', { bytes: bytes(3 * MiB) }, quota)
    await expect(store.cachePut('ext_A', 'huge', huge.fileId, quota)).rejects.toThrow('比缓存容量')
    await expect(store.cacheGet('ext_A', 'bad key with spaces')).rejects.toThrow('缓存键')
  })

  it('finds the files of an earlier run and drops what expired meanwhile', async () => {
    const clock = { now: 0 }
    const root = path.join(await temporary('nekro-nxt-files-'), 'files')
    const before = await fileStore(clock, root)
    const kept = await before.write('ext_A', { bytes: bytes(5) }, quota)
    const cached = await before.write('ext_A', { bytes: bytes(6) }, quota)
    await before.cachePut('ext_A', 'kept', cached.fileId, quota)
    await before.dispose()
    clock.now = EXTENSION_TEMP_FILE_TTL_MS + 1
    const after = await fileStore(clock, root)
    expect(await after.stat('ext_A', kept.fileId)).toBeUndefined()
    expect(await after.cacheGet('ext_A', 'kept')).toMatchObject({ fileId: cached.fileId, byteSize: 6 })
  })

  it('hands host services a path and takes their output back as a file', async () => {
    const store = await fileStore({ now: 1 })
    const input = await store.write('ext_A', { bytes: bytes(4, 1), name: 'in.bin' }, quota)
    const resolved = await store.resolvePath('ext_A', input.fileId)
    expect(resolved.readOnly).toBe(false)
    expect([...(await readFile(resolved.path))]).toEqual([1, 1, 1, 1])
    const output = path.join(await temporary('nekro-nxt-output-'), 'frame.jpg')
    await writeFile(output, Buffer.from([9, 9]))
    const imported = await store.importPath('ext_A', output, { mediaType: 'image/jpeg', move: true }, quota)
    expect(imported).toMatchObject({ byteSize: 2, mediaType: 'image/jpeg', name: 'frame.jpg' })
    await expect(readFile(output)).rejects.toThrow()
    expect([...(await store.read('ext_A', imported.fileId, 0, 10)).bytes]).toEqual([9, 9])
  })
})

const extensionId = ExtensionIdSchema.parse('ext_FILESFIXTURE00000000000000')

const productSetup = async () => {
  const directory = await temporary('nekro-nxt-files-product-')
  const database = await openMigratedCoreDatabase(path.join(directory, 'core.sqlite'))
  const repository = new SqliteCoreRepository(database)
  database.db
    .insert(localExtensions)
    .values({ id: extensionId, provides: ['agent'], slug: 'files', displayName: '示例', description: '', createdAt: 1 })
    .run()
  let sequence = 0
  const core = new CoreService(repository, { now: () => 5, nextUlid: () => `C${String(++sequence).padStart(25, '0')}` })
  const connection = core.createConnection({ adapterKey: 'fixture-alpha', config: {} })
  const roomA = core.createChannel({ connectionId: connection.id, platformChannelId: 'room-a', kind: 'group' })
  const roomB = core.createChannel({ connectionId: connection.id, platformChannelId: 'room-b', kind: 'group' })
  const assetService = new AssetService(repository, path.join(directory, 'assets'), {
    now: () => 10,
    nextUlid: () => `A${String(++sequence).padStart(25, '0')}`,
  })
  const library = new ExtensionLibrary({
    registry: sqliteLibraryRegistry(repository.extensionLibrary),
    assets: repository,
    assetService,
    now: () => 100,
  })
  const files = new ExtensionFileStore({
    root: path.join(directory, 'extension-files'),
    blobPath: (contentDigest) => assetService.blobPath({ contentDigest }),
  })
  stores.push(files)
  const backends: NxtServiceBackends = { ...unusedNxtBackends(), library, files }
  const binding = (
    channelId: string,
    capabilities: ExtensionCapabilities | undefined,
    mode: NxtServiceBinding['mode'] = 'activation',
  ): NxtServiceBinding => ({
    mode,
    agentId: 'agt_FIXTURE',
    ownerKey: extensionId,
    displayName: '示例',
    channelId,
    capabilities: () => capabilities,
    config: () => ({}),
    declaredSecrets: () => ({ config: [], hostConfig: [] }),
  })
  const inChannel = async (content: Uint8Array, channelId: typeof roomA.id) => {
    const prepared = await assetService.prepare({ bytes: content })
    repository.grantAssetAccess({ assetId: prepared.asset.id, channelId, source: 'agent-tool', grantedAt: 6 })
    return prepared.asset
  }
  return { repository, backends, files, binding, roomA, roomB, inChannel }
}

describe('reading channel files', () => {
  it('reads Assets the channel can see in chunks and nothing else', async () => {
    const { backends, binding, roomA, roomB, inChannel } = await productSetup()
    const content = new TextEncoder().encode('第一行\n第二行\n')
    const asset = await inChannel(content, roomA.id)
    const reader = createNxtHostService(binding(roomA.id, { assets: { read: true } }), backends)
    expect(await reader.assets.stat(asset.id)).toEqual({ byteSize: content.byteLength, mediaType: asset.mediaType })
    const first = await reader.assets.read(asset.id, { length: 10 })
    expect(first).toMatchObject({ eof: false, byteSize: content.byteLength })
    const rest = await reader.assets.read(asset.id, { offset: 10 })
    expect(rest.eof).toBe(true)
    expect(Buffer.concat([Buffer.from(first.base64, 'base64'), Buffer.from(rest.base64, 'base64')]).toString()).toBe(
      '第一行\n第二行\n',
    )
    await expect(reader.assets.read(asset.id, { length: 5 * MiB })).rejects.toThrow('每次最多读 4 MiB')
    await expect(reader.assets.read(asset.id, { offset: -1 })).rejects.toThrow('offset')

    const elsewhere = createNxtHostService(binding(roomB.id, { assets: { read: true } }), backends)
    await expect(elsewhere.assets.read(asset.id)).rejects.toThrow('不在当前频道或扩展资源库里')
    const undeclared = createNxtHostService(binding(roomA.id, { assets: { write: true } }), backends)
    await expect(undeclared.assets.stat(asset.id)).rejects.toThrow('read: true')
    const aborted = new AbortController()
    aborted.abort()
    await expect(reader.assets.read(asset.id, { signal: aborted.signal })).rejects.toThrow()
  })

  it('lets the host instance read library Assets only', async () => {
    const { backends, binding, roomA, inChannel } = await productSetup()
    const asset = await inChannel(new Uint8Array([1, 2, 3]), roomA.id)
    const host = createHostLayerNxt(binding('', { assets: { read: true } }, 'host'), backends)
    await expect(host.assets.read(asset.id)).rejects.toThrow('不在当前频道或扩展资源库里')
    const agent = createNxtHostService(binding(roomA.id, { assets: { library: {} } }), backends)
    await agent.assets.keep(asset.id)
    expect(Buffer.from((await host.assets.read(asset.id)).base64, 'base64')).toEqual(Buffer.from([1, 2, 3]))
  })
})

describe('nxt.files', () => {
  it('shares files between the host instance and agent attachments of one extension', async () => {
    const { backends, binding, roomA } = await productSetup()
    const agent = createNxtHostService(binding(roomA.id, { files: {} }), backends)
    const host = createHostLayerNxt(binding('', { files: {} }, 'host'), backends)
    const written = await agent.files.write({ text: '中间结果', name: 'step.txt' })
    expect(written).toMatchObject({ mediaType: 'text/plain; charset=utf-8', name: 'step.txt', kind: 'temp' })
    expect(Buffer.from((await host.files.read(written.fileId)).base64, 'base64').toString()).toBe('中间结果')
    await host.files.cache.put('summary', written.fileId)
    expect(await agent.files.cache.get('summary')).toMatchObject({ fileId: written.fileId, kind: 'cache' })
    await expect(agent.files.write({ text: 'a', base64: 'YQ==' })).rejects.toThrow('只能提供 base64 或 text')
    const undeclared = createNxtHostService(binding(roomA.id, { assets: { write: true } }), backends)
    await expect(undeclared.files.write({ text: 'x' })).rejects.toThrow('files（工作文件）')
  })

  it('makes files of visible Assets without copying and turns files into Assets where declared', async () => {
    const { repository, backends, files, binding, roomA, roomB, inChannel } = await productSetup()
    const asset = await inChannel(new TextEncoder().encode('原始文件'), roomA.id)
    const inB = createNxtHostService(binding(roomB.id, { files: {} }), backends)
    await expect(inB.files.fromAsset(asset.id)).rejects.toThrow('不在当前频道或扩展资源库里')
    const inA = createNxtHostService(binding(roomA.id, { files: {}, assets: { write: true } }), backends)
    const view = await inA.files.fromAsset(asset.id)
    expect(view).toMatchObject({ assetId: asset.id, byteSize: asset.byteSize })
    expect(files.usage(extensionId)).toEqual({ tempBytes: 0, cacheBytes: 0 })
    expect(Buffer.from((await inA.files.read(view.fileId)).base64, 'base64').toString()).toBe('原始文件')
    // Deleting the view leaves the Asset in place.
    expect(await inA.files.delete(view.fileId)).toBe(true)
    expect(
      Buffer.from((await inA.files.read((await inA.files.fromAsset(asset.id)).fileId)).base64, 'base64').toString(),
    ).toBe('原始文件')

    const made = await inA.files.write({ base64: Buffer.from('生成的内容').toString('base64') })
    const saved = await inA.files.toAsset(made.fileId)
    expect(repository.canAccessAsset(AssetIdSchema.parse(saved.assetId), roomA.id)).toBe(true)
    await expect(inA.files.toAsset(made.fileId, { library: true })).rejects.toThrow('扩展资源库')
    const readOnly = createNxtHostService(binding(roomA.id, { files: {} }), backends)
    await expect(readOnly.files.toAsset(made.fileId)).rejects.toThrow('assets（生成频道文件）')
  })

  it('keeps dynamic runs small whatever the declaration asks for', async () => {
    const { backends, binding, roomA } = await productSetup()
    const dynamic = createNxtHostService(
      binding(roomA.id, { files: { tempQuotaBytes: 8 * 1024 * MiB } }, 'dynamic'),
      backends,
    )
    await expect(dynamic.files.write({ base64: Buffer.alloc(65 * MiB).toString('base64') })).rejects.toThrow(
      '临时文件已满（上限 64 MB）',
    )
  })
})
