import type { AssetId, AssetOccurrenceId, ChannelEventId, ChannelId, ConnectionId } from '@nekro-nxt/contracts'
import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, open, stat, unlink } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import { fileTypeFromBuffer, fileTypeFromFile } from 'file-type'
import { monotonicFactory } from 'ulid'

export type AssetBlobState = 'present' | 'evicted' | 'missing' | 'quarantined'

export interface AssetRecord {
  readonly id: AssetId
  readonly contentDigest: string
  readonly byteSize: number
  readonly mediaType: string
  readonly blobState: AssetBlobState
  readonly firstReceivedAt: number
  readonly lastReceivedAt: number
  readonly receiveCount: number
  readonly lastAccessedAt?: number
  readonly storageFormatVersion: 1
}

export interface AssetOccurrenceRecord {
  readonly id: AssetOccurrenceId
  readonly assetId: AssetId
  readonly channelEventId: ChannelEventId
  readonly channelId: ChannelId
  readonly connectionId: ConnectionId
  readonly platformMessageId?: string
  readonly receivedAt: number
  readonly filename?: string
  readonly declaredMediaType?: string
}

export interface AssetOccurrenceInput extends Omit<AssetOccurrenceRecord, 'id' | 'assetId'> {
  readonly id?: AssetOccurrenceId
}

export interface AssetOperationRecord {
  readonly id: string
  readonly state: 'running' | 'completed' | 'failed'
  readonly stagingRelativePath: string
  readonly blobRelativePath: string
  readonly candidate: AssetRecord
  readonly occurrence: AssetOccurrenceInput & { readonly id: AssetOccurrenceId }
  readonly createdAt: number
  readonly completedAt?: number
  readonly errorSummary?: string
}

export interface AssetReceiptCommit {
  readonly asset: AssetRecord
  readonly occurrence: AssetOccurrenceRecord
  readonly insertedAsset: boolean
}

export interface AssetRepository {
  reserveAsset(candidate: AssetRecord): AssetRecord
  beginAssetOperation(operation: AssetOperationRecord): void
  completeAssetOperation(operationId: string, completedAt: number): AssetReceiptCommit
  failAssetOperation(operationId: string, errorSummary: string, completedAt: number): void
  listPendingAssetOperations(): readonly AssetOperationRecord[]
  getAssetByDigest(contentDigest: string): AssetRecord | undefined
}

export interface AssetEnrichmentRecord {
  readonly id: string
  readonly assetId: AssetId
  readonly enhancerId: string
  readonly provider: string
  readonly modelId: string
  readonly promptVersion: number
  readonly schemaVersion: number
  readonly state: 'pending' | 'running' | 'succeeded' | 'failed'
  readonly summary?: string
  readonly ocrText?: string
  readonly tags?: readonly string[]
  readonly inputDigest: string
  readonly attemptCount: number
  readonly failureKind?: string
  readonly errorSummary?: string
  readonly createdAt: number
  readonly updatedAt: number
}

export interface AssetEnrichmentRepository {
  ensureAssetEnrichment(record: AssetEnrichmentRecord): {
    readonly record: AssetEnrichmentRecord
    readonly inserted: boolean
  }
  claimPendingAssetEnrichment(updatedAt: number): AssetEnrichmentRecord | undefined
  completeAssetEnrichment(
    id: string,
    result: { readonly summary: string; readonly ocrText?: string; readonly tags?: readonly string[] },
    updatedAt: number,
  ): AssetEnrichmentRecord
  failAssetEnrichment(id: string, failureKind: string, errorSummary: string, updatedAt: number): AssetEnrichmentRecord
  resetRunningAssetEnrichments(updatedAt: number): number
  getAssetById(id: AssetId): AssetRecord | undefined
  listAssetEnrichments(assetId: AssetId): readonly AssetEnrichmentRecord[]
  canAccessAsset(assetId: AssetId, channelId: ChannelId): boolean
}

export interface ImageEnhancer {
  enhance(input: {
    readonly asset: AssetRecord
    readonly blobPath: string
    readonly signal: AbortSignal
  }): Promise<{ readonly summary: string; readonly ocrText?: string; readonly tags?: readonly string[] }>
}

export interface AssetEnrichmentSpec {
  readonly enhancerId: string
  readonly provider: string
  readonly modelId: string
  readonly promptVersion: number
  readonly schemaVersion: number
}

export type AssetByteSource = Uint8Array | AsyncIterable<Uint8Array>

export interface AssetServiceOptions {
  readonly maxAssetBytes?: number
  readonly now?: () => number
  readonly nextUlid?: () => string
}

export interface ImportAssetInput {
  readonly bytes: AssetByteSource
  readonly occurrence: AssetOccurrenceInput
  readonly preferredAssetId?: AssetId
}

export interface PreparedAssetImport {
  readonly asset: AssetRecord
  commit(occurrence: AssetOccurrenceInput): Promise<AssetReceiptCommit>
}

const isNodeError = (error: unknown, code: string): boolean =>
  error instanceof Error && 'code' in error && error.code === code

const hashFile = async (filename: string): Promise<{ readonly digest: string; readonly byteSize: number }> => {
  const hash = createHash('sha256')
  let byteSize = 0
  for await (const chunk of createReadStream(filename) as AsyncIterable<Buffer>) {
    hash.update(chunk)
    byteSize += chunk.byteLength
  }
  return { digest: hash.digest('hex'), byteSize }
}

/** Content-addressed live blob owner with a recoverable SQLite journal seam. */
export class AssetService {
  readonly #repository: AssetRepository
  readonly #root: string
  readonly #maxAssetBytes: number
  readonly #now: () => number
  readonly #nextUlid: () => string

  constructor(repository: AssetRepository, root: string, options: AssetServiceOptions = {}) {
    if (!path.isAbsolute(root)) throw new TypeError('Asset root must be absolute.')
    this.#repository = repository
    this.#root = root
    this.#maxAssetBytes = options.maxAssetBytes ?? 128 * 1024 * 1024
    if (!Number.isSafeInteger(this.#maxAssetBytes) || this.#maxAssetBytes <= 0) {
      throw new TypeError('Asset maxAssetBytes must be a positive safe integer.')
    }
    this.#now = options.now ?? Date.now
    this.#nextUlid = options.nextUlid ?? monotonicFactory()
  }

  async import(input: ImportAssetInput): Promise<AssetReceiptCommit> {
    await this.#prepareDirectories()
    const stagingRelativePath = `staging/${randomUUID()}.blob`
    const stagingPath = this.#resolve(stagingRelativePath)
    const file = await open(stagingPath, 'wx', 0o600)
    const hash = createHash('sha256')
    let byteSize = 0
    try {
      const source = input.bytes instanceof Uint8Array ? [input.bytes] : input.bytes
      for await (const rawChunk of source) {
        const chunk = rawChunk instanceof Uint8Array ? rawChunk : new Uint8Array(rawChunk)
        byteSize += chunk.byteLength
        if (byteSize > this.#maxAssetBytes) throw new Error(`Asset exceeds ${this.#maxAssetBytes} bytes.`)
        hash.update(chunk)
        let offset = 0
        while (offset < chunk.byteLength) {
          const result = await file.write(chunk, offset, chunk.byteLength - offset)
          offset += result.bytesWritten
        }
      }
      await file.sync()
    } catch (error) {
      await file.close()
      await unlink(stagingPath).catch(() => undefined)
      throw error
    }
    await file.close()

    const digestHex = hash.digest('hex')
    const contentDigest = `sha256:${digestHex}`
    const blobRelativePath = `blobs/sha256/${digestHex.slice(0, 2)}/${digestHex}`
    const receivedAt = input.occurrence.receivedAt
    if (!Number.isSafeInteger(receivedAt) || receivedAt < 0) {
      await unlink(stagingPath).catch(() => undefined)
      throw new TypeError('Asset receivedAt must be a non-negative integer.')
    }
    let detected: Awaited<ReturnType<typeof fileTypeFromFile>>
    try {
      detected = await fileTypeFromFile(stagingPath)
    } catch {
      detected = undefined
    }
    const operation: AssetOperationRecord = {
      id: `aop_${this.#nextUlid()}`,
      state: 'running',
      stagingRelativePath,
      blobRelativePath,
      candidate: {
        id: input.preferredAssetId ?? (`ast_${this.#nextUlid()}` as AssetId),
        contentDigest,
        byteSize,
        mediaType: detected?.mime ?? 'application/octet-stream',
        blobState: 'present',
        firstReceivedAt: receivedAt,
        lastReceivedAt: receivedAt,
        receiveCount: 1,
        storageFormatVersion: 1,
      },
      occurrence: {
        ...input.occurrence,
        id: input.occurrence.id ?? (`aoc_${this.#nextUlid()}` as AssetOccurrenceId),
      },
      createdAt: this.#timestamp(),
    }
    try {
      this.#repository.beginAssetOperation(operation)
    } catch (error) {
      await unlink(stagingPath).catch(() => undefined)
      throw error
    }
    return this.#finish(operation)
  }

  /** Reserves the canonical Asset identity before its referencing Channel Event is committed. */
  async prepare(input: {
    readonly bytes: Uint8Array
    readonly receivedAt: number
    readonly declaredMediaType?: string
  }): Promise<PreparedAssetImport> {
    if (!Number.isSafeInteger(input.receivedAt) || input.receivedAt < 0) {
      throw new TypeError('Asset receivedAt must be a non-negative integer.')
    }
    if (input.bytes.byteLength > this.#maxAssetBytes) {
      throw new Error(`Asset exceeds ${this.#maxAssetBytes} bytes.`)
    }
    const digestHex = createHash('sha256').update(input.bytes).digest('hex')
    const detected = await fileTypeFromBuffer(input.bytes).catch(() => undefined)
    const candidate: AssetRecord = {
      id: `ast_${this.#nextUlid()}` as AssetId,
      contentDigest: `sha256:${digestHex}`,
      byteSize: input.bytes.byteLength,
      mediaType: detected?.mime ?? input.declaredMediaType ?? 'application/octet-stream',
      blobState: 'missing',
      firstReceivedAt: input.receivedAt,
      lastReceivedAt: input.receivedAt,
      receiveCount: 0,
      storageFormatVersion: 1,
    }
    const asset = this.#repository.reserveAsset(candidate)
    return {
      asset,
      commit: async (occurrence) => {
        const result = await this.import({ bytes: input.bytes, occurrence, preferredAssetId: asset.id })
        if (result.asset.id !== asset.id) {
          throw new Error('Prepared Asset identity changed while committing its occurrence.')
        }
        return result
      },
    }
  }

  async recover(): Promise<readonly AssetReceiptCommit[]> {
    await this.#prepareDirectories()
    const commits: AssetReceiptCommit[] = []
    for (const operation of this.#repository.listPendingAssetOperations()) {
      try {
        commits.push(await this.#finish(operation))
      } catch (error) {
        this.#repository.failAssetOperation(
          operation.id,
          error instanceof Error ? error.message : String(error),
          this.#timestamp(),
        )
      }
    }
    return commits
  }

  blobPath(asset: AssetRecord): string {
    const digestHex = asset.contentDigest.replace(/^sha256:/, '')
    if (!/^[a-f0-9]{64}$/.test(digestHex)) throw new Error(`Invalid Asset digest: ${asset.contentDigest}`)
    return this.#resolve(`blobs/sha256/${digestHex.slice(0, 2)}/${digestHex}`)
  }

  async #finish(operation: AssetOperationRecord): Promise<AssetReceiptCommit> {
    const stagingPath = this.#resolve(operation.stagingRelativePath)
    const blobPath = this.#resolve(operation.blobRelativePath)
    await mkdir(path.dirname(blobPath), { recursive: true, mode: 0o700 })
    let blobExists = true
    try {
      await stat(blobPath)
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error
      blobExists = false
    }
    if (!blobExists) {
      try {
        await link(stagingPath, blobPath)
      } catch (error) {
        if (!isNodeError(error, 'EEXIST')) throw error
      }
    }
    {
      const existing = await hashFile(blobPath)
      const expected = operation.candidate.contentDigest.replace(/^sha256:/, '')
      if (existing.digest !== expected || existing.byteSize !== operation.candidate.byteSize) {
        throw new Error(`Existing Asset blob failed digest verification: ${operation.candidate.contentDigest}`)
      }
    }
    await unlink(stagingPath).catch((error: unknown) => {
      if (!isNodeError(error, 'ENOENT')) throw error
    })
    return this.#repository.completeAssetOperation(operation.id, this.#timestamp())
  }

  async #prepareDirectories(): Promise<void> {
    await mkdir(this.#resolve('staging'), { recursive: true, mode: 0o700 })
    await mkdir(this.#resolve('blobs/sha256'), { recursive: true, mode: 0o700 })
  }

  #resolve(relativePath: string): string {
    const target = path.resolve(this.#root, relativePath)
    const rootPrefix = `${path.resolve(this.#root)}${path.sep}`
    if (!target.startsWith(rootPrefix)) throw new Error('Asset journal path escapes the configured root.')
    return target
  }

  #timestamp(): number {
    const value = this.#now()
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Clock must return a non-negative integer.')
    return value
  }
}

/** Recoverable, single-key image enrichment queue; processors receive only the canonical Asset blob. */
export class AssetEnrichmentService {
  readonly #repository: AssetEnrichmentRepository
  readonly #assetService: AssetService
  readonly #enhancer: ImageEnhancer
  readonly #now: () => number
  readonly #nextUlid: () => string

  constructor(
    repository: AssetEnrichmentRepository,
    assetService: AssetService,
    enhancer: ImageEnhancer,
    options: Pick<AssetServiceOptions, 'now' | 'nextUlid'> = {},
  ) {
    this.#repository = repository
    this.#assetService = assetService
    this.#enhancer = enhancer
    this.#now = options.now ?? Date.now
    this.#nextUlid = options.nextUlid ?? monotonicFactory()
  }

  enqueue(asset: AssetRecord, spec: AssetEnrichmentSpec): AssetEnrichmentRecord {
    if (!asset.mediaType.startsWith('image/'))
      throw new Error(`Only image Assets can enter image enrichment: ${asset.id}`)
    const timestamp = this.#timestamp()
    return this.#repository.ensureAssetEnrichment({
      id: `aen_${this.#nextUlid()}`,
      assetId: asset.id,
      enhancerId: spec.enhancerId,
      provider: spec.provider,
      modelId: spec.modelId,
      promptVersion: spec.promptVersion,
      schemaVersion: spec.schemaVersion,
      state: 'pending',
      inputDigest: asset.contentDigest,
      attemptCount: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    }).record
  }

  recover(): number {
    return this.#repository.resetRunningAssetEnrichments(this.#timestamp())
  }

  async drain(signal: AbortSignal = new AbortController().signal): Promise<number> {
    let completed = 0
    while (!signal.aborted) {
      const task = this.#repository.claimPendingAssetEnrichment(this.#timestamp())
      if (!task) break
      const asset = this.#repository.getAssetById(task.assetId)
      if (!asset || asset.contentDigest !== task.inputDigest || asset.blobState !== 'present') {
        this.#repository.failAssetEnrichment(
          task.id,
          'asset-unavailable',
          'Canonical Asset blob is unavailable.',
          this.#timestamp(),
        )
        continue
      }
      try {
        const result = await this.#enhancer.enhance({
          asset,
          blobPath: this.#assetService.blobPath(asset),
          signal,
        })
        this.#repository.completeAssetEnrichment(task.id, result, this.#timestamp())
        completed += 1
      } catch (error) {
        this.#repository.failAssetEnrichment(
          task.id,
          signal.aborted ? 'aborted' : 'processor-error',
          error instanceof Error ? error.message : String(error),
          this.#timestamp(),
        )
      }
    }
    return completed
  }

  #timestamp(): number {
    const value = this.#now()
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Clock must return a non-negative integer.')
    return value
  }
}

/** Inbound media coordinator: commits the Asset/Occurrence first, then idempotently schedules configured image derivations. */
export class AssetIngestionPipeline {
  readonly #assets: AssetService
  readonly #enrichment: AssetEnrichmentService | undefined
  readonly #specs: readonly AssetEnrichmentSpec[]

  constructor(
    assets: AssetService,
    options: { readonly enrichment?: AssetEnrichmentService; readonly specs?: readonly AssetEnrichmentSpec[] } = {},
  ) {
    this.#assets = assets
    this.#enrichment = options.enrichment
    this.#specs = options.specs ?? []
    if (this.#specs.length > 0 && !this.#enrichment) {
      throw new TypeError('Asset enrichment specs require an enrichment service.')
    }
  }

  async import(input: ImportAssetInput): Promise<AssetReceiptCommit> {
    const commit = await this.#assets.import(input)
    if (commit.asset.mediaType.startsWith('image/') && this.#enrichment) {
      for (const spec of this.#specs) this.#enrichment.enqueue(commit.asset, spec)
    }
    return commit
  }
}
