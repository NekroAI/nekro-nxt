import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AssetOccurrenceId, ChannelEventId, ChannelId, ConnectionId } from '@nekro-nxt/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import type { AssetOperationRecord, AssetReceiptCommit, AssetRecord, AssetRepository } from '../src/assets.ts'
import { AssetService } from '../src/assets.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

class MemoryAssetRepository implements AssetRepository {
  readonly operations = new Map<string, AssetOperationRecord>()
  readonly assets = new Map<string, AssetRecord>()
  readonly occurrences: AssetReceiptCommit['occurrence'][] = []

  reserveAsset(candidate: AssetRecord): AssetRecord {
    const existing = this.assets.get(candidate.contentDigest)
    if (existing) return existing
    this.assets.set(candidate.contentDigest, candidate)
    return candidate
  }

  beginAssetOperation(operation: AssetOperationRecord): void {
    this.operations.set(operation.id, structuredClone(operation))
  }

  completeAssetOperation(operationId: string, completedAt: number): AssetReceiptCommit {
    const operation = this.operations.get(operationId)
    if (!operation) throw new Error(`unknown operation ${operationId}`)
    const existingOccurrence = this.occurrences.find(({ id }) => id === operation.occurrence.id)
    if (existingOccurrence) {
      const asset = [...this.assets.values()].find(({ id }) => id === existingOccurrence.assetId)
      if (!asset) throw new Error('missing asset')
      return { asset, occurrence: existingOccurrence, insertedAsset: false }
    }
    const existing = this.assets.get(operation.candidate.contentDigest)
    const asset = existing
      ? {
          ...existing,
          lastReceivedAt: Math.max(existing.lastReceivedAt, operation.occurrence.receivedAt),
          receiveCount: existing.receiveCount + 1,
          blobState: 'present' as const,
        }
      : operation.candidate
    this.assets.set(asset.contentDigest, asset)
    const occurrence = { ...operation.occurrence, assetId: asset.id }
    this.occurrences.push(occurrence)
    this.operations.set(operationId, { ...operation, state: 'completed', completedAt })
    return { asset, occurrence, insertedAsset: existing === undefined }
  }

  failAssetOperation(operationId: string, errorSummary: string, completedAt: number): void {
    const operation = this.operations.get(operationId)
    if (operation) this.operations.set(operationId, { ...operation, state: 'failed', errorSummary, completedAt })
  }

  listPendingAssetOperations() {
    return [...this.operations.values()].filter(({ state }) => state === 'running')
  }

  getAssetByDigest(contentDigest: string) {
    return this.assets.get(contentDigest)
  }
}

describe('AssetService', () => {
  it('stores identical concurrent media bytes once while preserving every occurrence', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-assets-'))
    temporaryDirectories.push(root)
    const repository = new MemoryAssetRepository()
    let id = 0
    const service = new AssetService(repository, root, { now: () => 1000, nextUlid: () => `ID${++id}` })
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

    const commits = await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        service.import({
          bytes,
          occurrence: {
            channelEventId: `event-${index}` as ChannelEventId,
            channelId: 'channel-1' as ChannelId,
            connectionId: 'connection-1' as ConnectionId,
            receivedAt: 1000 + index,
            filename: 'sticker.png',
            declaredMediaType: 'image/png',
          },
        }),
      ),
    )

    expect(new Set(commits.map(({ asset }) => asset.id)).size).toBe(1)
    expect(repository.assets.size).toBe(1)
    expect(repository.occurrences).toHaveLength(100)
    expect([...repository.assets.values()][0]).toMatchObject({ receiveCount: 100, lastReceivedAt: 1099 })
    const [prefix] = await readdir(path.join(root, 'blobs/sha256'))
    expect(await readdir(path.join(root, 'blobs/sha256', prefix!))).toHaveLength(1)
  })

  it('uses detected bytes rather than a declared video MIME as the canonical media type', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-assets-'))
    temporaryDirectories.push(root)
    const repository = new MemoryAssetRepository()
    const service = new AssetService(repository, root, { now: () => 1, nextUlid: () => 'ONE' })
    const commit = await service.import({
      bytes: new TextEncoder().encode('plain file'),
      occurrence: {
        channelEventId: 'event-1' as ChannelEventId,
        channelId: 'channel-1' as ChannelId,
        connectionId: 'connection-1' as ConnectionId,
        receivedAt: 1,
        declaredMediaType: 'video/mp4',
      },
    })
    expect(commit.asset.mediaType).toBe('application/octet-stream')
    expect(commit.occurrence.declaredMediaType).toBe('video/mp4')
    expect(service.blobPath(commit.asset)).toContain('blobs/sha256')
  })

  it('reserves a stable Asset before the event and commits a replay-safe occurrence afterward', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-assets-'))
    temporaryDirectories.push(root)
    const repository = new MemoryAssetRepository()
    let id = 0
    const service = new AssetService(repository, root, { now: () => 10, nextUlid: () => `P${++id}` })
    const bytes = new TextEncoder().encode('prepared media')
    const first = await service.prepare({ bytes, receivedAt: 10, declaredMediaType: 'video/mp4' })
    const replay = await service.prepare({ bytes, receivedAt: 10, declaredMediaType: 'video/mp4' })
    expect(replay.asset.id).toBe(first.asset.id)
    const occurrence = {
      id: 'occurrence-stable' as AssetOccurrenceId,
      channelEventId: 'event-1' as ChannelEventId,
      channelId: 'channel-1' as ChannelId,
      connectionId: 'connection-1' as ConnectionId,
      platformMessageId: 'platform-1',
      receivedAt: 10,
    }
    await first.commit(occurrence)
    await replay.commit(occurrence)
    expect(repository.occurrences).toHaveLength(1)
    expect(repository.getAssetByDigest(first.asset.contentDigest)).toMatchObject({ receiveCount: 1 })
  })
})
