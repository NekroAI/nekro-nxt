import { eq, sql } from 'drizzle-orm'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ExtensionIdSchema } from '@nekro-nxt/contracts'
import { AssetService, CoreService } from '@nekro-nxt/core'
import {
  ExtensionLibraryQuotaError,
  localExtensions,
  openMigratedCoreDatabase,
  SqliteCoreRepository,
} from '../src/index.ts'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const extensionId = ExtensionIdSchema.parse('ext_STICKERSFIXTURE0000000000')
const otherExtensionId = ExtensionIdSchema.parse('ext_OTHERFIXTURE00000000000000')

const open = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-library-index-'))
  directories.push(directory)
  const database = await openMigratedCoreDatabase(path.join(directory, 'core.sqlite'))
  const repository = new SqliteCoreRepository(database)
  for (const id of [extensionId, otherExtensionId]) {
    database.db
      .insert(localExtensions)
      .values({ id, provides: ['agent'], slug: id.toLowerCase(), displayName: id, description: '', createdAt: 1 })
      .run()
  }
  let sequence = 0
  const assets = new AssetService(repository, path.join(directory, 'assets'), {
    now: () => 10,
    nextUlid: () => `ASSET${String(++sequence).padStart(21, '0')}`,
  })
  return { database, repository, assets, directory }
}

describe('extension asset library', () => {
  it('keeps an Asset once, pages newest first and enforces the byte quota', async () => {
    const { repository, assets } = await open()
    const first = await assets.prepare({ bytes: new TextEncoder().encode('first picture bytes') })
    const second = await assets.prepare({ bytes: new TextEncoder().encode('second picture') })

    const kept = repository.extensionLibrary.keepLibraryAsset({
      extensionId,
      assetId: first.asset.id,
      addedAt: 100,
      quotaBytes: 1024,
    })
    expect(kept).toMatchObject({ assetId: first.asset.id, existed: false, byteSize: first.asset.byteSize })
    expect(
      repository.extensionLibrary.keepLibraryAsset({
        extensionId,
        assetId: first.asset.id,
        addedAt: 200,
        quotaBytes: 1024,
      }),
    ).toMatchObject({ existed: true, addedAt: 100 })

    expect(() =>
      repository.extensionLibrary.keepLibraryAsset({
        extensionId,
        assetId: second.asset.id,
        addedAt: 150,
        quotaBytes: first.asset.byteSize + 1,
      }),
    ).toThrow(ExtensionLibraryQuotaError)

    repository.extensionLibrary.keepLibraryAsset({ extensionId, assetId: second.asset.id, addedAt: 150, quotaBytes: 1024 })
    const page = repository.extensionLibrary.listLibraryAssets(extensionId, { limit: 1 })
    expect(page.assets.map(({ assetId }) => assetId)).toEqual([second.asset.id])
    expect(page.next).toBeDefined()
    const rest = repository.extensionLibrary.listLibraryAssets(extensionId, { limit: 1, after: page.next! })
    expect(rest.assets.map(({ assetId }) => assetId)).toEqual([first.asset.id])
    expect(rest.next).toBeUndefined()

    expect(repository.extensionLibrary.listLibraryAssets(otherExtensionId, { limit: 10 }).assets).toEqual([])
    expect(repository.extensionLibrary.releaseLibraryAsset(extensionId, first.asset.id)).toBe(true)
    expect(repository.extensionLibrary.releaseLibraryAsset(extensionId, first.asset.id)).toBe(false)
    expect(repository.extensionLibrary.libraryUsage(extensionId)).toEqual({ count: 1, bytes: second.asset.byteSize })
  })

  it('lets a library grant coexist with the channel grant source', async () => {
    const { repository, assets } = await open()
    let sequence = 0
    const core = new CoreService(repository, { now: () => 5, nextUlid: () => `C${++sequence}` })
    const connection = core.createConnection({ adapterKey: 'fixture-alpha', config: {} })
    const channel = core.createChannel({ connectionId: connection.id, platformChannelId: 'room', kind: 'internal' })
    const prepared = await assets.prepare({ bytes: new TextEncoder().encode('sticker') })
    const grant = repository.grantAssetAccess({
      assetId: prepared.asset.id,
      channelId: channel.id,
      source: 'extension-library',
      grantedAt: 6,
    })
    expect(grant.source).toBe('extension-library')
    expect(repository.canAccessAsset(prepared.asset.id, channel.id)).toBe(true)
  })
})

describe('extension search index', () => {
  const document = (documentId: string, text: string, filters: { field: string; value: string }[]) => ({
    extensionId,
    collection: 'stickers',
    documentId,
    fields: { meaning: text },
    keywords: [text, '', '', ''],
    filters,
    updatedAt: 1,
  })

  it('matches keywords inside one collection and applies grouped filters', async () => {
    const { repository } = await open()
    const index = repository.extensionIndex
    index.upsertIndexDocument(document('a', '加班 疲惫', [{ field: 'scope', value: 'public' }]))
    index.upsertIndexDocument(
      document('b', '加班 熬夜', [
        { field: 'scope', value: 'local' },
        { field: 'sources', value: 'room-1' },
      ]),
    )
    index.upsertIndexDocument(document('c', '开心', [{ field: 'scope', value: 'public' }]))
    index.upsertIndexDocument({ ...document('a', '加班', []), extensionId: otherExtensionId })

    const search = (filter: { field: string; value: string }[][]) =>
      index
        .searchIndexKeywords({
          extensionId,
          collection: 'stickers',
          match: '"加班"',
          weights: [2, 1, 1, 1],
          filter,
          limit: 10,
        })
        .map(({ documentId }) => documentId)
        .sort()

    expect(search([])).toEqual(['a', 'b'])
    expect(search([[{ field: 'scope', value: 'public' }]])).toEqual(['a'])
    expect(
      search([
        [
          { field: 'scope', value: 'public' },
          { field: 'sources', value: 'room-1' },
        ],
      ]),
    ).toEqual(['a', 'b'])
    expect(index.countIndexDocuments(extensionId, 'stickers')).toBe(3)
  })

  it('replaces keywords on update and removes keyword rows when documents or extensions are deleted', async () => {
    const { database, repository } = await open()
    const index = repository.extensionIndex
    const keywordRows = () =>
      database.db.all<{ count: number }>(sql`SELECT count(*) AS count FROM extension_index_fts`)[0]!.count
    const rowId = index.upsertIndexDocument(document('a', '委屈', []))
    expect(index.upsertIndexDocument(document('a', '开心', []))).toBe(rowId)
    expect(
      index.searchIndexKeywords({
        extensionId,
        collection: 'stickers',
        match: '"委屈"',
        weights: [1],
        filter: [],
        limit: 5,
      }),
    ).toEqual([])
    index.putIndexVector({ rowId, space: 'space-1', vector: Buffer.from([1, 2, 3]), scale: 0.5, textDigest: 'd1' })
    expect(index.listIndexVectors({ extensionId, collection: 'stickers', space: 'space-1', filter: [] })).toHaveLength(1)
    expect(index.deleteIndexDocument(extensionId, 'stickers', 'a')).toBe(true)
    expect(keywordRows()).toBe(0)
    expect(index.countIndexVectors('space-1').vectors).toBe(0)

    index.upsertIndexDocument(document('b', '生气', []))
    expect(keywordRows()).toBe(1)
    database.db.delete(localExtensions).where(eq(localExtensions.id, extensionId)).run()
    expect(keywordRows()).toBe(0)
  })

  it('lists documents whose vector in a space is missing and drops other spaces', async () => {
    const { repository } = await open()
    const index = repository.extensionIndex
    const first = index.upsertIndexDocument(document('a', '委屈', []))
    index.upsertIndexDocument(document('b', '开心', []))
    index.putIndexVector({ rowId: first, space: 'old', vector: Buffer.from([1]), scale: 1, textDigest: 'x' })
    index.putIndexVector({ rowId: first, space: 'new', vector: Buffer.from([1]), scale: 1, textDigest: 'y' })
    const candidates = index.listIndexEmbeddingCandidates('new', { afterRowId: 0, limit: 10 })
    expect(candidates.map(({ vectorDigest }) => vectorDigest)).toEqual(['y', null])
    expect(candidates[0]!.fields).toEqual({ meaning: '委屈' })
    expect(index.deleteIndexVectorsExcept(['new'])).toBe(1)
    expect(index.countIndexVectors('new')).toEqual({ vectors: 1, documents: 2 })
  })
})
