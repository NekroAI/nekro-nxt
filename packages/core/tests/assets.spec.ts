import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AssetRecord, AssetRepository } from '../src/assets.ts'
import { AssetService } from '../src/assets.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

class MemoryAssetRepository implements AssetRepository {
  readonly assets = new Map<string, AssetRecord>()
  readonly occurrences: unknown[] = []
  ensureCalls = 0
  failure: Error | undefined
  conflictingMetadata = false

  ensureAsset(candidate: AssetRecord): AssetRecord {
    this.ensureCalls += 1
    if (this.failure) throw this.failure
    if (this.conflictingMetadata) return { ...candidate, mediaType: 'application/octet-stream' }
    const existing = this.assets.get(candidate.contentDigest)
    if (existing) return existing
    this.assets.set(candidate.contentDigest, candidate)
    return candidate
  }
}

const createRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-assets-'))
  temporaryDirectories.push(root)
  return root
}

describe('AssetService', () => {
  it('atomically publishes identical concurrent content once and ensures one canonical Asset', async () => {
    const root = await createRoot()
    const repository = new MemoryAssetRepository()
    let id = 0
    const service = new AssetService(repository, root, { now: () => 1000, nextUlid: () => `ID${++id}` })
    const bytes = new TextEncoder().encode('same content')

    const prepared = await Promise.all(Array.from({ length: 40 }, () => service.prepare({ bytes })))

    expect(new Set(prepared.map(({ asset }) => asset.id)).size).toBe(1)
    expect(repository.assets.size).toBe(1)
    const [prefix] = await readdir(path.join(root, 'blobs/sha256'))
    expect(await readdir(path.join(root, 'blobs/sha256', prefix!))).toHaveLength(1)
    expect(await readdir(path.join(root, 'staging'))).toEqual([])
    await expect(stat(service.blobPath(prepared[0]!.asset))).resolves.toMatchObject({ size: bytes.byteLength })
  })

  it('derives MIME and byte size from the bytes and enforces the configured size limit', async () => {
    const root = await createRoot()
    const repository = new MemoryAssetRepository()
    const service = new AssetService(repository, root, { maxAssetBytes: 12, now: () => 7, nextUlid: () => 'ONE' })
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00, 0x00, 0x00, 0x00])

    const prepared = await service.prepare({ bytes: gif, declaredMediaType: 'video/mp4' })

    expect(prepared.asset).toMatchObject({
      byteSize: gif.byteLength,
      mediaType: 'image/gif',
      createdAt: 7,
    })
    await expect(service.prepare({ bytes: new Uint8Array(13) })).rejects.toThrow('exceeds 12 bytes')
    expect(repository.ensureCalls).toBe(1)
    expect(await readdir(path.join(root, 'staging'))).toEqual([])
  })

  it('publishes the blob before Repository.ensureAsset and never inserts an occurrence on failure', async () => {
    const root = await createRoot()
    const repository = new MemoryAssetRepository()
    repository.failure = new Error('database unavailable')
    const service = new AssetService(repository, root, { now: () => 8, nextUlid: () => 'FAIL' })

    await expect(service.prepare({ bytes: new TextEncoder().encode('orphan allowed') })).rejects.toThrow(
      'database unavailable',
    )

    expect(repository.occurrences).toEqual([])
    expect(repository.assets.size).toBe(0)
    const [prefix] = await readdir(path.join(root, 'blobs/sha256'))
    expect(await readdir(path.join(root, 'blobs/sha256', prefix!))).toHaveLength(1)
  })

  it('rejects relative roots and never resolves a malformed digest as a filesystem path', async () => {
    const root = await createRoot()
    const repository = new MemoryAssetRepository()
    expect(() => new AssetService(repository, 'relative/assets')).toThrow('root must be absolute')
    expect(() => new AssetService(repository, root, { maxAssetBytes: 0 })).toThrow('positive safe integer')

    const service = new AssetService(repository, root)
    expect(() => service.blobPath({ contentDigest: 'sha256:../../outside' })).toThrow('Invalid Asset digest')
  })

  it('supports the import alias and rejects conflicting canonical metadata', async () => {
    const root = await createRoot()
    const repository = new MemoryAssetRepository()
    const service = new AssetService(repository, root, { nextUlid: () => 'IMPORT', now: () => 10 })
    const imported = await service.import({ bytes: new TextEncoder().encode('imported') })
    expect(imported.asset.contentDigest).toMatch(/^sha256:[a-f0-9]{64}$/u)

    repository.conflictingMetadata = true
    await expect(
      service.prepare({
        bytes: new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00, 0x00, 0x00, 0x00]),
      }),
    ).rejects.toThrow('conflicting metadata')
    expect(await readdir(path.join(root, 'staging'))).toEqual([])
  })
})
