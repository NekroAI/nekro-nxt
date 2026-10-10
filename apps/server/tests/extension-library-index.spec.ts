import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AssetIdSchema,
  ExtensionIdSchema,
  type ExtensionCapabilities,
  type ExtensionIndexCollection,
} from '@nekro-nxt/contracts'
import { AssetService, CoreService } from '@nekro-nxt/core'
import { localExtensions, openMigratedCoreDatabase, SqliteCoreRepository } from '@nekro-nxt/storage-sqlite'
import { memoryNxtJobs, memoryNxtStorage } from '../src/extension-host-backends.js'
import {
  createHostLayerNxt,
  createNxtHostService,
  type NxtServiceBackends,
  type NxtServiceBinding,
} from '../src/extension-host-service.js'
import { differenceHash, hashDistance } from '../src/extension-image-info.js'
import { sqliteIndexEngine, type IndexVectorProvider } from '../src/extension-index.js'
import { ExtensionLibrary, sqliteLibraryRegistry } from '../src/extension-library.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const extensionId = ExtensionIdSchema.parse('ext_STICKERSFIXTURE0000000000')

const STICKERS: ExtensionIndexCollection = {
  name: 'stickers',
  fields: [
    { name: 'meaning', weight: 2 },
    { name: 'caption', weight: 1.5 },
    { name: 'description', weight: 1 },
  ],
  filters: ['scope', 'sources'],
}

/** A picture with a bright diagonal, so resized copies keep the same structure. */
const picture = (size: number, flip = false): Promise<Buffer> =>
  sharp({
    create: { width: size, height: size, channels: 3, background: '#203040' },
  })
    .composite([
      {
        input: Buffer.from(
          `<svg width="${size}" height="${size}"><polygon points="${flip ? `${size},0 ${size},${size} 0,${size}` : `0,0 ${size},0 0,${size}`}" fill="#f0e0a0"/></svg>`,
        ),
      },
    ])
    .png()
    .toBuffer()

const setup = async (options: { readonly vectors?: IndexVectorProvider } = {}) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-library-'))
  directories.push(directory)
  const database = await openMigratedCoreDatabase(path.join(directory, 'core.sqlite'))
  const repository = new SqliteCoreRepository(database)
  database.db
    .insert(localExtensions)
    .values({
      id: extensionId,
      provides: ['agent'],
      slug: 'stickers',
      displayName: '表情包',
      description: '',
      createdAt: 1,
    })
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
  const modelCalls: unknown[] = []
  const backends: NxtServiceBackends = {
    fetch: () => Promise.reject(new Error('no network')),
    storage: memoryNxtStorage(() => 1),
    jobs: memoryNxtJobs(),
    platform: {
      catalog: () => Promise.reject(new Error('no platform')),
      invoke: () => Promise.reject(new Error('no platform')),
      raw: () => Promise.reject(new Error('no platform')),
      selfPlatformUserId: () => Promise.resolve(undefined),
    },
    secret: () => Promise.resolve(undefined),
    createAsset: () => Promise.reject(new Error('not used')),
    callContext: () => Promise.reject(new Error('not used')),
    members: { describe: () => Promise.resolve(undefined) },
    complete: () => Promise.reject(new Error('not used')),
    history: { list: () => Promise.resolve({ messages: [] }), search: () => Promise.resolve([]) },
    library,
    index: sqliteIndexEngine(repository.extensionIndex, options.vectors, () => 1),
    models: {
      list: () =>
        Promise.resolve([
          {
            ref: 'fixture:vision-1',
            provider: 'fixture',
            providerName: '示例',
            model: 'vision-1',
            name: '示例视觉模型',
            vision: true,
          },
        ]),
      complete: (_binding, request) => {
        modelCalls.push(request)
        return Promise.resolve({ text: '{"meaning":"表达开心"}' })
      },
    },
  }
  const binding = (
    channelId: string,
    capabilities: ExtensionCapabilities = { assets: { library: {} }, index: { collections: [STICKERS] } },
  ): NxtServiceBinding => ({
    mode: 'activation',
    agentId: 'agt_FIXTURE',
    ownerKey: extensionId,
    displayName: '表情包',
    channelId,
    capabilities: () => capabilities,
    config: () => ({}),
  })
  const inChannel = async (bytes: Buffer, channelId: typeof roomA.id) => {
    const prepared = await assetService.prepare({ bytes })
    repository.grantAssetAccess({ assetId: prepared.asset.id, channelId, source: 'agent-tool', grantedAt: 6 })
    return prepared.asset
  }
  return { repository, backends, binding, roomA, roomB, inChannel, assetService, modelCalls }
}

describe('image info', () => {
  it('keeps resized copies within a few bits and tells different pictures apart', async () => {
    const original = await differenceHash(await picture(256))
    const resized = await differenceHash(
      await sharp(await picture(256))
        .resize(97)
        .jpeg({ quality: 60 })
        .toBuffer(),
    )
    const different = await differenceHash(await picture(256, true))
    expect(original).toMatch(/^[0-9a-f]{16}$/u)
    expect(hashDistance(original, resized)).toBeLessThanOrEqual(4)
    expect(hashDistance(original, different)).toBeGreaterThan(16)
  })
})

describe('extension asset library', () => {
  it('keeps only pictures the current channel can see and attaches them anywhere afterwards', async () => {
    const { repository, backends, binding, roomA, roomB, inChannel } = await setup()
    const asset = await inChannel(await picture(64), roomA.id)
    const fromB = createNxtHostService(binding(roomB.id), backends)
    await expect(fromB.assets.keep(asset.id)).rejects.toThrow('不在当前频道里')

    const fromA = createNxtHostService(binding(roomA.id), backends)
    expect(await fromA.assets.keep(asset.id)).toMatchObject({ assetId: asset.id, mediaType: 'image/png' })
    expect(repository.canAccessAsset(asset.id, roomB.id)).toBe(false)
    expect(await fromB.assets.attach(asset.id)).toMatchObject({ assetId: asset.id })
    expect(repository.canAccessAsset(asset.id, roomB.id)).toBe(true)

    const info = await fromB.image.info(asset.id)
    expect(info).toMatchObject({ mediaType: 'image/png', width: 64, height: 64, frames: 1 })
    expect(await fromB.assets.release(asset.id)).toBe(true)
    await expect(fromB.assets.attach(asset.id)).rejects.toThrow('不在这个扩展的资源库里')
  })

  it('stores created pictures straight into the library and enforces the quota', async () => {
    const { repository, backends, binding, roomA } = await setup()
    const small = createNxtHostService(
      binding(roomA.id, { assets: { library: { quotaBytes: 1024 * 1024 } } }),
      backends,
    )
    const bytes = await picture(32)
    const created = await small.assets.create({ base64: bytes.toString('base64') }, { library: true })
    expect(repository.canAccessAsset(AssetIdSchema.parse(created.assetId), roomA.id)).toBe(false)
    expect(repository.extensionLibrary.libraryUsage(extensionId).count).toBe(1)

    const tight = createNxtHostService(binding(roomA.id, { assets: { library: { quotaBytes: 1024 * 1024 } } }), {
      ...backends,
      library: backends.library,
    })
    const large = await sharp({
      create: { width: 1400, height: 1400, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 60 } },
    })
      .png()
      .toBuffer()
    await expect(tight.assets.create({ base64: large.toString('base64') }, { library: true })).rejects.toThrow(
      '资源库已满',
    )
  })

  it('names the missing declaration instead of failing obscurely', async () => {
    const { backends, binding, roomA } = await setup()
    const plain = createNxtHostService(binding(roomA.id, { assets: { write: true } }), backends)
    await expect(plain.assets.keep('ast_MISSING')).rejects.toThrow('assets 中加入 library')
    await expect(plain.index.query('stickers', '开心')).rejects.toThrow('index')
  })
})

describe('extension search index', () => {
  it('searches declared fields with grouped filters and rejects undeclared names', async () => {
    const { backends, binding, roomA } = await setup()
    const nxt = createNxtHostService(binding(roomA.id), backends)
    await nxt.index.upsert('stickers', 's1', {
      fields: { meaning: '加班到深夜，累得不想说话', description: '趴在电脑前的猫' },
      filters: { scope: 'public', sources: ['room-a'] },
    })
    await nxt.index.upsert('stickers', 's2', {
      fields: { meaning: '加班结束了很开心', caption: '下班' },
      filters: { scope: 'local', sources: ['room-b'] },
    })
    await nxt.index.upsert('stickers', 's3', { fields: { meaning: '撒娇求摸头' }, filters: { scope: 'public' } })

    expect((await nxt.index.query('stickers', '加班太累了')).hits.map(({ id }) => id).sort()).toEqual(['s1', 's2'])
    const visibleInA = await nxt.index.query('stickers', '加班', {
      filter: [
        [
          { field: 'scope', value: 'public' },
          { field: 'sources', value: 'room-a' },
        ],
      ],
    })
    expect(visibleInA).toMatchObject({ mode: 'keyword', hits: [{ id: 's1' }] })
    expect(await nxt.index.count('stickers')).toBe(3)
    expect(await nxt.index.delete('stickers', 's1')).toBe(true)
    expect((await nxt.index.query('stickers', '加班')).hits.map(({ id }) => id)).toEqual(['s2'])

    await expect(nxt.index.upsert('stickers', 's4', { fields: { title: '开心' } })).rejects.toThrow(
      '没有声明文本字段 title',
    )
    await expect(nxt.index.upsert('stickers', 'bad id!', { fields: {} })).rejects.toThrow('文档 id')
    await expect(nxt.index.query('stickers', '开心', { filter: [[{ field: 'owner', value: 'x' }]] })).rejects.toThrow(
      '没有声明过滤项 owner',
    )
    await expect(nxt.index.query('memes', '开心')).rejects.toThrow('没有声明索引 memes')
  })

  it('fuses vectors with keywords when the Host provides them and explains a fallback', async () => {
    const vector = (values: readonly number[]) => Float32Array.from(values)
    let available = true
    const provider: IndexVectorProvider = {
      queryVector: () =>
        Promise.resolve(available ? { space: 'test-space', vector: vector([1, 0]) } : { degraded: '模型正在下载' }),
      documentsChanged: () => undefined,
    }
    const { repository, backends, binding, roomA } = await setup({ vectors: provider })
    const nxt = createNxtHostService(binding(roomA.id), backends)
    await nxt.index.upsert('stickers', 'tired', { fields: { meaning: '加班好累' } })
    await nxt.index.upsert('stickers', 'exhausted', { fields: { meaning: '电量耗尽，瘫在床上' } })
    const rows = repository.extensionIndex.getIndexDocumentRowIds(extensionId, 'stickers', ['tired', 'exhausted'])
    repository.extensionIndex.putIndexVector({
      rowId: rows.get('exhausted')!,
      space: 'test-space',
      vector: Buffer.from([127, 0]),
      scale: 1 / 127,
      textDigest: 'x',
    })
    repository.extensionIndex.putIndexVector({
      rowId: rows.get('tired')!,
      space: 'test-space',
      vector: Buffer.from([0, 127]),
      scale: 1 / 127,
      textDigest: 'y',
    })

    const hybrid = await nxt.index.query('stickers', '加班')
    expect(hybrid.mode).toBe('hybrid')
    expect(hybrid.hits.map(({ id }) => id).sort()).toEqual(['exhausted', 'tired'])

    available = false
    expect(await nxt.index.query('stickers', '加班')).toEqual({
      mode: 'keyword',
      degraded: '模型正在下载',
      hits: [{ id: 'tired', score: 1 }],
    })
  })
})

describe('host-layer model calls', () => {
  it('uses a configured model by reference, checks pictures and limits the rate', async () => {
    const { backends, roomA, inChannel, modelCalls } = await setup()
    const asset = await inChannel(await picture(48), roomA.id)
    const hostLayer = (maxCallsPerMinute: number) =>
      createHostLayerNxt(
        {
          mode: 'host',
          agentId: '',
          ownerKey: extensionId,
          displayName: '表情包',
          channelId: '',
          capabilities: () => ({ assets: { library: {} }, models: { maxCallsPerMinute, maxOutputTokens: 512 } }),
          config: () => ({}),
        },
        backends,
      )
    const nxt = hostLayer(1)
    expect(await nxt.models.list()).toEqual([expect.objectContaining({ ref: 'fixture:vision-1', vision: true })])
    const image = { role: 'user' as const, content: [{ type: 'image' as const, assetId: asset.id }] }
    await expect(nxt.models.complete({ model: 'fixture:vision-1', messages: [image] })).rejects.toThrow(
      '不在当前频道或扩展资源库里',
    )

    await backends.library.import(extensionId, await picture(48), 1024 * 1024 * 1024)
    expect(await nxt.models.complete({ model: 'fixture:vision-1', messages: [image], maxOutputTokens: 9000 })).toEqual({
      text: '{"meaning":"表达开心"}',
    })
    expect(modelCalls).toEqual([expect.objectContaining({ provider: 'fixture', modelId: 'vision-1' })])
    await expect(nxt.models.complete({ model: 'fixture:vision-1', messages: [image] })).rejects.toThrow('每分钟最多')
    await expect(hostLayer(5).models.complete({ model: 'gone:model', messages: [image] })).rejects.toThrow(
      '找不到这个模型',
    )
  })
})
