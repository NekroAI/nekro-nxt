import { AssetIdSchema, type AssetId } from '@nekro-nxt/contracts'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { link, mkdir, open, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { fileTypeFromFile } from 'file-type'
import { monotonicFactory } from 'ulid'

export interface AssetRecord {
  readonly id: AssetId
  readonly contentDigest: string
  readonly byteSize: number
  readonly mediaType: string
  readonly createdAt: number
}

export interface AssetRepository {
  ensureAsset(candidate: AssetRecord): AssetRecord
}

export type AssetByteSource = Uint8Array | AsyncIterable<Uint8Array>

export interface AssetServiceOptions {
  readonly maxAssetBytes?: number
  readonly now?: () => number
  readonly nextUlid?: () => string
}

export interface PrepareAssetInput {
  readonly bytes: AssetByteSource
  /** Transport metadata only. It is never trusted as the canonical MIME fact. */
  readonly declaredMediaType?: string
}

/** A durable canonical blob and its database identity, ready to be referenced by a later transaction. */
export interface PreparedAsset {
  readonly asset: AssetRecord
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

/**
 * Owns content-addressed blobs. A blob is durable and atomically published before
 * its Asset row is ensured; Channel Event occurrences remain the caller's transaction.
 */
export class AssetService {
  readonly #repository: AssetRepository
  readonly #root: string
  readonly #maxAssetBytes: number
  readonly #now: () => number
  readonly #nextUlid: () => string

  constructor(repository: AssetRepository, root: string, options: AssetServiceOptions = {}) {
    if (!path.isAbsolute(root)) throw new TypeError('Asset root must be absolute.')
    this.#repository = repository
    this.#root = path.resolve(root)
    this.#maxAssetBytes = options.maxAssetBytes ?? 128 * 1024 * 1024
    if (!Number.isSafeInteger(this.#maxAssetBytes) || this.#maxAssetBytes <= 0) {
      throw new TypeError('Asset maxAssetBytes must be a positive safe integer.')
    }
    this.#now = options.now ?? Date.now
    this.#nextUlid = options.nextUlid ?? monotonicFactory()
  }

  async prepare(input: PrepareAssetInput): Promise<PreparedAsset> {
    const stagingDirectory = this.#resolve('staging')
    await mkdir(stagingDirectory, { recursive: true, mode: 0o700 })
    let temporaryPath = this.#resolve(`staging/${randomUUID()}.tmp`)
    const file = await open(temporaryPath, 'wx', 0o600)
    const hash = createHash('sha256')
    let byteSize = 0
    let closed = false

    try {
      const source = input.bytes instanceof Uint8Array ? [input.bytes] : input.bytes
      for await (const chunk of source) {
        if (!(chunk instanceof Uint8Array)) throw new TypeError('Asset byte source must yield Uint8Array chunks.')
        byteSize += chunk.byteLength
        if (!Number.isSafeInteger(byteSize) || byteSize > this.#maxAssetBytes) {
          throw new Error(`Asset exceeds ${this.#maxAssetBytes} bytes.`)
        }
        hash.update(chunk)
        let offset = 0
        while (offset < chunk.byteLength) {
          const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset)
          if (bytesWritten <= 0) throw new Error('Asset temporary file write made no progress.')
          offset += bytesWritten
        }
      }
      await file.sync()
      await file.close()
      closed = true

      const digestHex = hash.digest('hex')
      const contentDigest = `sha256:${digestHex}`
      const blobDirectory = this.#resolve(`blobs/sha256/${digestHex.slice(0, 2)}`)
      const blobPath = this.#resolve(`blobs/sha256/${digestHex.slice(0, 2)}/${digestHex}`)
      await mkdir(blobDirectory, { recursive: true, mode: 0o700 })

      const publishTemporaryPath = path.join(blobDirectory, `.${digestHex}.${randomUUID()}.tmp`)
      await rename(temporaryPath, publishTemporaryPath)
      temporaryPath = publishTemporaryPath

      let insertedBlob = false
      try {
        await link(temporaryPath, blobPath)
        insertedBlob = true
      } catch (error) {
        if (!isNodeError(error, 'EEXIST')) throw error
      }

      const published = await hashFile(blobPath)
      if (published.digest !== digestHex || published.byteSize !== byteSize) {
        throw new Error(`Existing Asset blob failed digest verification: ${contentDigest}`)
      }
      await unlink(temporaryPath)
      temporaryPath = ''
      if (insertedBlob) await this.#syncDirectory(blobDirectory)

      const detected = await fileTypeFromFile(blobPath).catch(() => undefined)
      const candidate: AssetRecord = {
        id: AssetIdSchema.parse(`ast_${this.#nextUlid()}`),
        contentDigest,
        byteSize,
        mediaType: detected?.mime ?? 'application/octet-stream',
        createdAt: this.#timestamp(),
      }
      const asset = this.#repository.ensureAsset(candidate)
      this.#assertCanonicalAsset(asset, candidate)
      return { asset }
    } finally {
      if (!closed) await file.close().catch(() => undefined)
      if (temporaryPath) {
        await unlink(temporaryPath).catch((error: unknown) => {
          if (!isNodeError(error, 'ENOENT')) throw error
        })
      }
    }
  }

  /** Compatibility name for non-message callers; it still creates no occurrence. */
  import(input: PrepareAssetInput): Promise<PreparedAsset> {
    return this.prepare(input)
  }

  blobPath(asset: Pick<AssetRecord, 'contentDigest'>): string {
    const match = /^sha256:([a-f0-9]{64})$/.exec(asset.contentDigest)
    if (!match) throw new Error(`Invalid Asset digest: ${asset.contentDigest}`)
    const digestHex = match[1]!
    return this.#resolve(`blobs/sha256/${digestHex.slice(0, 2)}/${digestHex}`)
  }

  #assertCanonicalAsset(asset: AssetRecord, candidate: AssetRecord): void {
    if (
      asset.contentDigest !== candidate.contentDigest ||
      asset.byteSize !== candidate.byteSize ||
      asset.mediaType !== candidate.mediaType
    ) {
      throw new Error(`Asset repository returned conflicting metadata for ${candidate.contentDigest}.`)
    }
  }

  async #syncDirectory(directory: string): Promise<void> {
    let handle
    try {
      handle = await open(directory, 'r')
      await handle.sync()
    } catch (error) {
      // Some supported filesystems do not expose directory fsync. The file was
      // still fsynced before its atomic hard-link publication.
      if (
        !isNodeError(error, 'EINVAL') &&
        !isNodeError(error, 'EBADF') &&
        !isNodeError(error, 'ENOTSUP') &&
        !isNodeError(error, 'EPERM') &&
        !isNodeError(error, 'EISDIR')
      ) {
        throw error
      }
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }

  #resolve(relativePath: string): string {
    const target = path.resolve(this.#root, relativePath)
    const rootPrefix = `${this.#root}${path.sep}`
    if (!target.startsWith(rootPrefix)) throw new Error('Asset path escapes the configured root.')
    return target
  }

  #timestamp(): number {
    const value = this.#now()
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Clock must return a non-negative integer.')
    return value
  }
}
