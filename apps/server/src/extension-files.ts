import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { copyFile, mkdir, open, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { NxtFileRecord } from '@nekro-nxt/extension-sdk'
import { z } from 'zod'
import { NxtCapabilityError } from './extension-host-service.js'

/** Temporary files expire this long after they were written. */
export const EXTENSION_TEMP_FILE_TTL_MS = 24 * 60 * 60 * 1000
/** The same cap as one Asset, so every file can become one. */
export const EXTENSION_FILE_MAX_BYTES = 128 * 1024 * 1024
const SWEEP_INTERVAL_MS = 10 * 60 * 1000
const FILE_ID_PATTERN = /^file_[a-f0-9]{32}$/u
const CACHE_KEY_PATTERN = /^[\p{L}\p{N}._:/-]{1,256}$/u

/** One file as stored next to its bytes; `asset` files point at an Asset blob and own no bytes. */
const StoredFileSchema = z
  .object({
    fileId: z.string().regex(FILE_ID_PATTERN),
    owner: z.string().min(1),
    byteSize: z.number().int().nonnegative(),
    mediaType: z.string().min(1),
    name: z.string().min(1).max(255).optional(),
    createdAt: z.number().int().nonnegative(),
    lastUsedAt: z.number().int().nonnegative(),
    cacheKey: z.string().optional(),
    asset: z
      .object({ assetId: z.string().min(1), contentDigest: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict()
type StoredFile = z.output<typeof StoredFileSchema>

export interface ExtensionFileQuota {
  readonly tempBytes: number
  readonly cacheBytes: number
}

export interface ExtensionFileAsset {
  readonly id: string
  readonly contentDigest: string
  readonly byteSize: number
  readonly mediaType: string
}

const isMissing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT'

const cleanName = (name: string | undefined): string | undefined => {
  const base = name === undefined ? '' : path.basename(name.trim()).slice(0, 255)
  return base === '' || base === '.' || base === '..' ? undefined : base
}

const formatBytes = (bytes: number): string =>
  bytes >= 1024 * 1024 * 1024
    ? `${+(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
    : `${Math.max(1, Math.round(bytes / 1024 / 1024))} MB`

/** What `nxt.files` and the host services that run programs need from the store. */
export type ExtensionFiles = Pick<
  ExtensionFileStore,
  | 'write'
  | 'importPath'
  | 'resolvePath'
  | 'fromAsset'
  | 'read'
  | 'stat'
  | 'delete'
  | 'cacheGet'
  | 'cachePut'
  | 'cacheDelete'
>

/**
 * Work files of extensions (附加功能 F5) under one rebuildable directory: `<root>/<owner digest>/<fileId>.bin` with a
 * `.json` record beside it. A `fileId` resolves only for the owner that created it. Temporary files expire after
 * {@link EXTENSION_TEMP_FILE_TTL_MS}; a file put into the cache stays until its key is replaced or deleted, or the
 * cache quota evicts it (least recently used first). Files made from an Asset reference its blob and own no bytes.
 *
 * Host services that run programs (media, speech, commands) exchange data with extensions through
 * {@link resolvePath} and {@link importPath}, so extension code never sees a host path.
 */
export class ExtensionFileStore {
  readonly #root: string
  readonly #now: () => number
  readonly #blobPath: (contentDigest: string) => string
  readonly #files = new Map<string, StoredFile>()
  #started: Promise<void> | undefined
  #timer: NodeJS.Timeout | undefined

  constructor(input: {
    readonly root: string
    /** Where an Asset's bytes are; files made from Assets read them from there. */
    readonly blobPath: (contentDigest: string) => string
    readonly now?: () => number
  }) {
    if (!path.isAbsolute(input.root)) throw new TypeError('Extension file root must be absolute.')
    this.#root = path.resolve(input.root)
    this.#blobPath = input.blobPath
    this.#now = input.now ?? Date.now
  }

  /** Loads the records left from earlier runs, drops expired files and sweeps periodically from then on. */
  start(): Promise<void> {
    this.#started ??= (async () => {
      await mkdir(this.#root, { recursive: true, mode: 0o700 })
      for (const directory of await readdir(this.#root)) {
        const ownerRoot = path.join(this.#root, directory)
        let names: string[]
        try {
          names = await readdir(ownerRoot)
        } catch {
          continue
        }
        for (const name of names) {
          if (!name.endsWith('.json')) continue
          try {
            const parsed = StoredFileSchema.parse(JSON.parse(await readFile(path.join(ownerRoot, name), 'utf8')))
            if (this.#ownerDirectory(parsed.owner) === ownerRoot) this.#files.set(this.#key(parsed), parsed)
          } catch {
            // A record cut short by a crash; its bytes go with it below.
            await rm(path.join(ownerRoot, name), { force: true })
            await rm(path.join(ownerRoot, name.replace(/\.json$/u, '.bin')), { force: true })
          }
        }
      }
      await this.sweep()
      this.#timer = setInterval(() => void this.sweep().catch(() => undefined), SWEEP_INTERVAL_MS)
      this.#timer.unref()
    })()
    return this.#started
  }

  async dispose(): Promise<void> {
    if (this.#timer !== undefined) clearInterval(this.#timer)
    this.#timer = undefined
    await this.#started?.catch(() => undefined)
  }

  /** Removes temporary files past their expiry; cached files stay. */
  async sweep(): Promise<number> {
    const cutoff = this.#now() - EXTENSION_TEMP_FILE_TTL_MS
    const expired = [...this.#files.values()].filter((file) => file.cacheKey === undefined && file.createdAt <= cutoff)
    for (const file of expired) await this.#remove(file)
    return expired.length
  }

  async write(
    owner: string,
    input: { readonly bytes: Uint8Array; readonly name?: string | undefined; readonly mediaType?: string | undefined },
    quota: ExtensionFileQuota,
  ): Promise<NxtFileRecord> {
    await this.start()
    if (input.bytes.byteLength > EXTENSION_FILE_MAX_BYTES) {
      throw new NxtCapabilityError(`单个文件最多 ${formatBytes(EXTENSION_FILE_MAX_BYTES)}。`)
    }
    this.#reserveTemp(owner, input.bytes.byteLength, quota)
    const file = this.#newRecord(owner, input.bytes.byteLength, input.mediaType, input.name)
    await mkdir(this.#ownerDirectory(owner), { recursive: true, mode: 0o700 })
    const handle = await open(this.#dataPath(file), 'wx', 0o600)
    try {
      await handle.writeFile(input.bytes)
    } finally {
      await handle.close()
    }
    await this.#persist(file)
    return this.#view(file)
  }

  /**
   * Makes a host file a temporary file of `owner`: moved when `move` is set (the caller made it for this), copied
   * otherwise. For host services that produce output files.
   */
  async importPath(
    owner: string,
    hostPath: string,
    options: { readonly name?: string; readonly mediaType?: string; readonly move?: boolean },
    quota: ExtensionFileQuota,
  ): Promise<NxtFileRecord> {
    await this.start()
    const info = await stat(hostPath)
    if (!info.isFile()) throw new Error(`Not a regular file: ${hostPath}`)
    if (info.size > EXTENSION_FILE_MAX_BYTES) {
      throw new NxtCapabilityError(`单个文件最多 ${formatBytes(EXTENSION_FILE_MAX_BYTES)}。`)
    }
    this.#reserveTemp(owner, info.size, quota)
    const file = this.#newRecord(owner, info.size, options.mediaType, options.name ?? path.basename(hostPath))
    await mkdir(this.#ownerDirectory(owner), { recursive: true, mode: 0o700 })
    if (options.move === true) {
      try {
        await rename(hostPath, this.#dataPath(file))
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EXDEV')) throw error
        await copyFile(hostPath, this.#dataPath(file))
        await unlink(hostPath)
      }
    } else {
      await pipeline(createReadStream(hostPath), createWriteStream(this.#dataPath(file), { flags: 'wx', mode: 0o600 }))
    }
    await this.#persist(file)
    return this.#view(file)
  }

  /**
   * The host path of a file, for host services to read; never handed to extension code. Files made from an Asset
   * resolve to the Asset blob, which callers must not modify.
   */
  async resolvePath(
    owner: string,
    fileId: string,
  ): Promise<{ readonly path: string; readonly file: NxtFileRecord; readonly readOnly: boolean }> {
    const file = await this.#require(owner, fileId)
    this.#touch(file)
    return { path: this.#bytesPath(file), file: this.#view(file), readOnly: file.asset !== undefined }
  }

  /** A read-only file over an Asset blob; the bytes are not copied and do not count against the temp quota. */
  async fromAsset(owner: string, asset: ExtensionFileAsset, name?: string): Promise<NxtFileRecord> {
    await this.start()
    const file: StoredFile = {
      ...this.#newRecord(owner, asset.byteSize, asset.mediaType, name),
      asset: { assetId: asset.id, contentDigest: asset.contentDigest },
    }
    this.#files.set(this.#key(file), file)
    await mkdir(this.#ownerDirectory(owner), { recursive: true, mode: 0o700 })
    await this.#persist(file)
    return this.#view(file)
  }

  async read(
    owner: string,
    fileId: string,
    offset: number,
    length: number,
  ): Promise<{ readonly bytes: Buffer; readonly eof: boolean }> {
    const file = await this.#require(owner, fileId)
    this.#touch(file)
    return readRange(this.#bytesPath(file), file.byteSize, offset, length)
  }

  async stat(owner: string, fileId: string): Promise<NxtFileRecord | undefined> {
    await this.start()
    const file = this.#files.get(`${owner}\0${fileId}`)
    return file === undefined ? undefined : this.#view(file)
  }

  async delete(owner: string, fileId: string): Promise<boolean> {
    await this.start()
    const file = this.#files.get(`${owner}\0${fileId}`)
    if (file === undefined) return false
    await this.#remove(file)
    return true
  }

  async cacheGet(owner: string, key: string): Promise<NxtFileRecord | undefined> {
    await this.start()
    const file = this.#cached(owner, checkedCacheKey(key))
    if (file === undefined) return undefined
    this.#touch(file)
    await this.#persist(file)
    return this.#view(file)
  }

  /** Keeps a file under `key`; the previous file of that key is removed, then least recently used entries if full. */
  async cachePut(owner: string, key: string, fileId: string, quota: ExtensionFileQuota): Promise<NxtFileRecord> {
    const checked = checkedCacheKey(key)
    const file = await this.#require(owner, fileId)
    const size = ownedBytes(file)
    if (size > quota.cacheBytes) {
      throw new NxtCapabilityError(`这个文件比缓存容量（${formatBytes(quota.cacheBytes)}）还大。`)
    }
    const previous = this.#cached(owner, checked)
    if (previous !== undefined && previous.fileId !== file.fileId) await this.#remove(previous)
    let used = [...this.#files.values()]
      .filter((entry) => entry.owner === owner && entry.cacheKey !== undefined && entry.fileId !== file.fileId)
      .reduce((total, entry) => total + ownedBytes(entry), 0)
    const evictable = [...this.#files.values()]
      .filter((entry) => entry.owner === owner && entry.cacheKey !== undefined && entry.fileId !== file.fileId)
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt)
    for (const entry of evictable) {
      if (used + size <= quota.cacheBytes) break
      used -= ownedBytes(entry)
      await this.#remove(entry)
    }
    const kept: StoredFile = { ...file, cacheKey: checked, lastUsedAt: this.#now() }
    this.#files.set(this.#key(kept), kept)
    await this.#persist(kept)
    return this.#view(kept)
  }

  async cacheDelete(owner: string, key: string): Promise<boolean> {
    await this.start()
    const file = this.#cached(owner, checkedCacheKey(key))
    if (file === undefined) return false
    await this.#remove(file)
    return true
  }

  /** Bytes of temporary and cached files `owner` holds; Asset files own none. */
  usage(owner: string): { readonly tempBytes: number; readonly cacheBytes: number } {
    let tempBytes = 0
    let cacheBytes = 0
    for (const file of this.#files.values()) {
      if (file.owner !== owner) continue
      if (file.cacheKey === undefined) tempBytes += ownedBytes(file)
      else cacheBytes += ownedBytes(file)
    }
    return { tempBytes, cacheBytes }
  }

  #reserveTemp(owner: string, bytes: number, quota: ExtensionFileQuota): void {
    const used = this.usage(owner).tempBytes
    if (used + bytes > quota.tempBytes) {
      throw new NxtCapabilityError(
        `临时文件已满（上限 ${formatBytes(quota.tempBytes)}），请先删除不用的文件，或把要留的文件放进缓存。`,
      )
    }
  }

  #newRecord(owner: string, byteSize: number, mediaType: string | undefined, name: string | undefined): StoredFile {
    const now = this.#now()
    const cleaned = cleanName(name)
    const file: StoredFile = {
      fileId: `file_${randomBytes(16).toString('hex')}`,
      owner,
      byteSize,
      mediaType: mediaType?.trim() || 'application/octet-stream',
      ...(cleaned === undefined ? {} : { name: cleaned }),
      createdAt: now,
      lastUsedAt: now,
    }
    this.#files.set(this.#key(file), file)
    return file
  }

  async #require(owner: string, fileId: string): Promise<StoredFile> {
    await this.start()
    const file = typeof fileId === 'string' ? this.#files.get(`${owner}\0${fileId}`) : undefined
    if (file === undefined) throw new NxtCapabilityError(`找不到文件 ${String(fileId)}，可能已过期或被删除。`)
    return file
  }

  #cached(owner: string, key: string): StoredFile | undefined {
    for (const file of this.#files.values()) if (file.owner === owner && file.cacheKey === key) return file
    return undefined
  }

  #touch(file: StoredFile): void {
    this.#files.set(this.#key(file), { ...file, lastUsedAt: this.#now() })
  }

  async #persist(file: StoredFile): Promise<void> {
    const current = this.#files.get(this.#key(file)) ?? file
    const target = this.#recordPath(current)
    const temporary = `${target}.${randomBytes(4).toString('hex')}.tmp`
    await writeFile(temporary, JSON.stringify(current), { mode: 0o600 })
    await rename(temporary, target)
  }

  async #remove(file: StoredFile): Promise<void> {
    this.#files.delete(this.#key(file))
    await rm(this.#recordPath(file), { force: true })
    if (file.asset === undefined) await rm(this.#dataPath(file), { force: true })
  }

  #view(file: StoredFile): NxtFileRecord {
    const current = this.#files.get(this.#key(file)) ?? file
    return {
      fileId: current.fileId,
      byteSize: current.byteSize,
      mediaType: current.mediaType,
      ...(current.name === undefined ? {} : { name: current.name }),
      kind: current.cacheKey === undefined ? 'temp' : 'cache',
      ...(current.asset === undefined ? {} : { assetId: current.asset.assetId }),
      createdAt: current.createdAt,
      ...(current.cacheKey === undefined ? { expiresAt: current.createdAt + EXTENSION_TEMP_FILE_TTL_MS } : {}),
      ...(current.cacheKey === undefined ? {} : { cacheKey: current.cacheKey }),
    }
  }

  #key(file: Pick<StoredFile, 'owner' | 'fileId'>): string {
    return `${file.owner}\0${file.fileId}`
  }

  #ownerDirectory(owner: string): string {
    return path.join(this.#root, createHash('sha256').update(owner).digest('hex').slice(0, 32))
  }

  #recordPath(file: StoredFile): string {
    return path.join(this.#ownerDirectory(file.owner), `${file.fileId}.json`)
  }

  #dataPath(file: StoredFile): string {
    return path.join(this.#ownerDirectory(file.owner), `${file.fileId}.bin`)
  }

  #bytesPath(file: StoredFile): string {
    return file.asset === undefined ? this.#dataPath(file) : this.#blobPath(file.asset.contentDigest)
  }
}

const ownedBytes = (file: StoredFile): number => (file.asset === undefined ? file.byteSize : 0)

const checkedCacheKey = (key: string): string => {
  if (typeof key !== 'string' || !CACHE_KEY_PATTERN.test(key)) {
    throw new NxtCapabilityError('缓存键必须是 1–256 个字母、数字或 . _ : / - 字符。')
  }
  return key
}

/** Reads `length` bytes at `offset` of a file whose size is known; a missing file reads as an error. */
export const readRange = async (
  filename: string,
  byteSize: number,
  offset: number,
  length: number,
): Promise<{ readonly bytes: Buffer; readonly eof: boolean }> => {
  const start = Math.min(offset, byteSize)
  const count = Math.max(0, Math.min(length, byteSize - start))
  let handle
  try {
    handle = await open(filename, 'r')
  } catch (error) {
    if (isMissing(error)) throw new NxtCapabilityError('文件的内容已经不在了。')
    throw error
  }
  try {
    const bytes = Buffer.alloc(count)
    let read = 0
    while (read < count) {
      const { bytesRead } = await handle.read(bytes, read, count - read, start + read)
      if (bytesRead === 0) break
      read += bytesRead
    }
    return { bytes: read === count ? bytes : bytes.subarray(0, read), eof: start + read >= byteSize }
  } finally {
    await handle.close()
  }
}
