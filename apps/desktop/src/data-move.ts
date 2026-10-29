import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  utimes,
} from 'node:fs/promises'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { isRebuildable, type MoveMethod, type MovePlan } from './data-move-plan.js'

/**
 * Carries a Desktop userData to a new directory and undoes it on failure. The record (`data-move.json`) is the journal:
 * it is written before every step that changes the disk, so a crash at any point leaves enough to finish or undo.
 */
export type DataMovePhase = 'requested' | 'moving' | 'switched' | 'completed' | 'failed'

export interface DataMoveFailure {
  readonly message: string
  /** Relative to userData, when one file is to blame. */
  readonly file?: string
}

export interface DataMoveRecord {
  readonly format: 'nxt.desktop-data-move'
  readonly version: 1
  readonly id: string
  readonly phase: DataMovePhase
  readonly method: MoveMethod
  readonly source: string
  readonly target: string
  readonly units: readonly string[]
  readonly bytes: number
  readonly requestedAt: number
  /** The process working on the move and when it last wrote; a live owner blocks a second launch. */
  readonly pid: number
  readonly heartbeatAt: number
  /** True when the target did not exist before the move, so undoing it removes the directory too. */
  readonly createdTarget?: boolean
  /** Original contents of files rewritten in place (same-volume move), restored if the move is undone. */
  readonly rewrites?: readonly { readonly file: string; readonly original: string }[]
  readonly failure?: DataMoveFailure
  readonly finishedAt?: number
  /** Settings → 存储 stops showing the old directory once the user says it is gone. */
  readonly noticeDismissed?: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
const PHASES: readonly DataMovePhase[] = ['requested', 'moving', 'switched', 'completed', 'failed']

const isPhase = (value: unknown): value is DataMovePhase => PHASES.some((phase) => phase === value)
const isSafeUnit = (unit: unknown): unit is string =>
  typeof unit === 'string' && unit.length > 0 && !path.isAbsolute(unit) && !unit.split(/[\\/]/u).includes('..')
const optionalString = (value: unknown): value is string | undefined => value === undefined || typeof value === 'string'

export const parseDataMoveRecord = (text: string): DataMoveRecord => {
  const value: unknown = JSON.parse(text)
  const invalid = () => new Error('Desktop data move record is invalid.')
  if (!isRecord(value) || value['format'] !== 'nxt.desktop-data-move' || value['version'] !== 1) throw invalid()
  const { id, phase, method, source, target, units, bytes, requestedAt, pid, heartbeatAt } = value
  if (
    typeof id !== 'string' ||
    !isPhase(phase) ||
    (method !== 'move' && method !== 'copy') ||
    typeof source !== 'string' ||
    !path.isAbsolute(source) ||
    typeof target !== 'string' ||
    !path.isAbsolute(target) ||
    !Array.isArray(units) ||
    !units.every(isSafeUnit) ||
    typeof bytes !== 'number' ||
    typeof requestedAt !== 'number' ||
    typeof pid !== 'number' ||
    typeof heartbeatAt !== 'number'
  )
    throw invalid()
  const rewrites: { file: string; original: string }[] = []
  if (value['rewrites'] !== undefined) {
    if (!Array.isArray(value['rewrites'])) throw invalid()
    for (const entry of value['rewrites'] as unknown[]) {
      if (!isRecord(entry) || !isSafeUnit(entry['file']) || typeof entry['original'] !== 'string') throw invalid()
      rewrites.push({ file: entry['file'], original: entry['original'] })
    }
  }
  const failure = value['failure']
  if (
    failure !== undefined &&
    (!isRecord(failure) || typeof failure['message'] !== 'string' || !optionalString(failure['file']))
  )
    throw invalid()
  return {
    format: 'nxt.desktop-data-move',
    version: 1,
    id,
    phase,
    method,
    source,
    target,
    units,
    bytes,
    requestedAt,
    pid,
    heartbeatAt,
    ...(typeof value['createdTarget'] === 'boolean' ? { createdTarget: value['createdTarget'] } : {}),
    ...(value['rewrites'] === undefined ? {} : { rewrites }),
    ...(failure === undefined
      ? {}
      : {
          failure: {
            message: String(failure['message']),
            ...(typeof failure['file'] === 'string' ? { file: failure['file'] } : {}),
          },
        }),
    ...(typeof value['finishedAt'] === 'number' ? { finishedAt: value['finishedAt'] } : {}),
    ...(value['noticeDismissed'] === true ? { noticeDismissed: true } : {}),
  }
}

/** The record without the journaled originals, once nothing can be undone any more. */
export const withoutRewrites = (record: DataMoveRecord): DataMoveRecord => {
  const { rewrites, ...rest } = record
  void rewrites
  return rest
}

export const createDataMoveRecord = (plan: MovePlan, now: number, pid: number): DataMoveRecord => ({
  format: 'nxt.desktop-data-move',
  version: 1,
  id: randomUUID(),
  phase: 'requested',
  method: plan.method,
  source: plan.source,
  target: plan.target,
  units: plan.units,
  bytes: plan.bytes,
  requestedAt: now,
  pid,
  heartbeatAt: now,
})

/** Writes through a temporary file and a rename, so a reader sees the old or the new content, never a mix. */
export const writeFileAtomic = async (file: string, content: string): Promise<void> => {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${randomUUID()}`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(content)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporary, file)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

export const serializeDataMoveRecord = (record: DataMoveRecord): string => `${JSON.stringify(record, null, 2)}\n`

export class DataMoveError extends Error {
  readonly file: string | undefined
  constructor(message: string, file?: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'DataMoveError'
    this.file = file
  }
}

export interface DataMoveProgress {
  readonly step: 'transferring' | 'verifying' | 'rewriting' | 'switching'
  readonly completedBytes: number
  readonly totalBytes: number
  readonly current?: string
}

export interface DataMoveIo {
  readonly writeRecord: (record: DataMoveRecord) => Promise<void>
  readonly onProgress?: (progress: DataMoveProgress) => void
  /** Throws when the SQLite file at the path fails `integrity_check`. */
  readonly checkSqlite: (file: string) => void | Promise<void>
  readonly now?: () => number
  readonly signal?: AbortSignal
}

const errorCode = (error: unknown): unknown =>
  error instanceof Error && 'code' in error ? (error as { code: unknown }).code : undefined
const exists = async (target: string): Promise<boolean> => {
  try {
    await lstat(target)
    return true
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false
    throw error
  }
}
const nativeRelative = (relative: string): string => relative.split('/').join(path.sep)
const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Reads a file and returns its SHA-256, for verifying a copy against its source. */
const sha256File = async (file: string): Promise<string> => {
  const hash = createHash('sha256')
  await pipeline(createReadStream(file), hash)
  return hash.digest('hex')
}

/** Paths a moved data root has to name anew. `sessionRoot`, reset markers and archive manifests are checked on start. */
export const PATH_RECORD_FILES = (dataRelative: string): readonly string[] => [
  `${dataRelative}/dsh/session-storage.json`,
  `${dataRelative}/sessions.sqlite.nekro-nxt-reset-required.json`,
]
const ARCHIVE_DIRECTORY = 'data/dsh/session-archives'
export const DATA_ROOT_MOVED_MARKER = 'data/host/data-root-moved.json'

/** Replaces the old data root at the start of any string with the new one, everywhere in a JSON value. */
export const rewriteJsonPaths = (value: unknown, prefixes: readonly string[], replacement: string): unknown => {
  if (typeof value === 'string') {
    for (const prefix of prefixes) {
      if (value === prefix) return replacement
      if (value.startsWith(prefix + path.sep) || value.startsWith(`${prefix}/`))
        return replacement + value.slice(prefix.length)
    }
    return value
  }
  if (Array.isArray(value)) return value.map((item) => rewriteJsonPaths(item, prefixes, replacement))
  if (isRecord(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, rewriteJsonPaths(item, prefixes, replacement)]),
    )
  return value
}

/** Files under the target whose content names the old data root. */
export const pathRecordFiles = async (target: string): Promise<readonly string[]> => {
  const files = [...PATH_RECORD_FILES('data')]
  try {
    for (const archive of await readdir(path.join(target, nativeRelative(ARCHIVE_DIRECTORY))))
      files.push(`${ARCHIVE_DIRECTORY}/${archive}/manifest.json`)
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error
  }
  const present: string[] = []
  for (const file of files) if (await exists(path.join(target, nativeRelative(file)))) present.push(file)
  return present
}

const sourcePrefixes = async (source: string): Promise<readonly string[]> => {
  const prefixes = new Set([path.join(source, 'data')])
  try {
    prefixes.add(path.join(await realpath(source), 'data'))
  } catch {
    // The source may already be gone after a move; the plain path is the one the Host used.
  }
  return [...prefixes].sort((left, right) => right.length - left.length)
}

class Transfer {
  completedBytes = 0
  constructor(
    readonly record: DataMoveRecord,
    readonly io: DataMoveIo,
  ) {}

  report(step: DataMoveProgress['step'], current?: string): void {
    this.io.onProgress?.({
      step,
      completedBytes: this.completedBytes,
      totalBytes: this.record.bytes,
      ...(current === undefined ? {} : { current }),
    })
  }

  async copyEntry(relative: string): Promise<void> {
    this.io.signal?.throwIfAborted()
    if (isRebuildable(relative.split(path.sep).join('/'))) return
    const from = path.join(this.record.source, relative)
    const to = path.join(this.record.target, relative)
    let info
    try {
      info = await lstat(from)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return
      throw new DataMoveError(`无法读取：${describe(error)}`, relative, { cause: error })
    }
    try {
      if (info.isDirectory()) {
        await mkdir(to, { mode: info.mode & 0o777 })
        for (const child of (await readdir(from)).sort()) await this.copyEntry(path.join(relative, child))
        await utimes(to, info.atime, info.mtime)
        return
      }
      if (info.isSymbolicLink()) {
        const link = await readlink(from)
        const type =
          process.platform === 'win32' && (await stat(from).catch(() => undefined))?.isDirectory() ? 'junction' : 'file'
        await symlink(link, to, type)
        if ((await readlink(to)) !== link) throw new Error('symbolic link changed while copying')
        return
      }
      if (!info.isFile()) return
      this.report('transferring', relative)
      const hash = createHash('sha256')
      const counter = new Transform({
        transform: (chunk: Buffer, _encoding, callback) => {
          hash.update(chunk)
          this.completedBytes += chunk.length
          callback(null, chunk)
        },
      })
      await pipeline(createReadStream(from), counter, createWriteStream(to, { flags: 'wx', mode: info.mode & 0o777 }))
      await chmod(to, info.mode & 0o777)
      await utimes(to, info.atime, info.mtime)
      const expected = hash.digest('hex')
      const written = await stat(to)
      if (written.size !== info.size) throw new Error(`size ${written.size} differs from ${info.size}`)
      if ((await sha256File(to)) !== expected) throw new Error('SHA-256 differs from the source')
    } catch (error) {
      if (error instanceof DataMoveError) throw error
      throw new DataMoveError(`复制失败：${describe(error)}`, relative, { cause: error })
    }
  }
}

const touch = (record: DataMoveRecord, io: DataMoveIo, change: Partial<DataMoveRecord>): DataMoveRecord => ({
  ...record,
  ...change,
  pid: process.pid,
  heartbeatAt: (io.now ?? Date.now)(),
})

/**
 * Runs the move described by the record, which must already be in the `moving` phase on disk. Returns the record ready
 * to switch over; the caller writes the pointer, then marks it completed. Throws `DataMoveError` without undoing
 * anything, so that the caller can record the failure first and then call `undoDataMove`.
 */
export const runDataMove = async (initial: DataMoveRecord, io: DataMoveIo): Promise<DataMoveRecord> => {
  let record = initial
  const save = async (change: Partial<DataMoveRecord>) => {
    record = touch(record, io, change)
    await io.writeRecord(record)
  }
  const createdTarget = !(await exists(record.target))
  await save({ createdTarget })
  try {
    await mkdir(record.target, { recursive: true })
    if (record.units.some((unit) => unit.startsWith('data/')))
      await mkdir(path.join(record.target, 'data'), { recursive: true })
  } catch (error) {
    throw new DataMoveError(`无法创建目标目录：${describe(error)}`, undefined, { cause: error })
  }

  const transfer = new Transfer(record, io)
  if (record.method === 'move') {
    for (const [index, unit] of record.units.entries()) {
      io.signal?.throwIfAborted()
      transfer.completedBytes = Math.round((record.bytes * index) / Math.max(1, record.units.length))
      transfer.report('transferring', unit)
      try {
        await rename(path.join(record.source, nativeRelative(unit)), path.join(record.target, nativeRelative(unit)))
      } catch (error) {
        if (errorCode(error) === 'ENOENT') continue
        throw new DataMoveError(
          errorCode(error) === 'EBUSY' || errorCode(error) === 'EPERM'
            ? '文件正被其他程序占用'
            : `无法移动：${describe(error)}`,
          unit,
          { cause: error },
        )
      }
    }
    transfer.completedBytes = record.bytes
  } else {
    for (const unit of record.units) await transfer.copyEntry(nativeRelative(unit))
    transfer.report('verifying')
    const dataDirectory = path.join(record.target, 'data')
    const databases = (await readdir(dataDirectory).catch(() => [] as string[])).filter((name) =>
      name.endsWith('.sqlite'),
    )
    for (const name of databases) {
      try {
        await io.checkSqlite(path.join(dataDirectory, name))
      } catch (error) {
        throw new DataMoveError(`数据库检查未通过：${describe(error)}`, `data/${name}`, { cause: error })
      }
    }
  }

  transfer.report('rewriting')
  const prefixes = await sourcePrefixes(record.source)
  const replacement = path.join(record.target, 'data')
  const files = await pathRecordFiles(record.target)
  const originals: { file: string; original: string }[] = []
  for (const file of files)
    originals.push({ file, original: await readFile(path.join(record.target, nativeRelative(file)), 'utf8') })
  // Journal the originals first: an undone same-volume move puts them back before renaming the files home.
  await save({ rewrites: originals })
  for (const { file, original } of originals) {
    try {
      const next = rewriteJsonPaths(JSON.parse(original), prefixes, replacement)
      await writeFileAtomic(path.join(record.target, nativeRelative(file)), `${JSON.stringify(next, null, 2)}\n`)
    } catch (error) {
      throw new DataMoveError(`无法更新路径记录：${describe(error)}`, file, { cause: error })
    }
  }
  if (record.units.some((unit) => unit.startsWith('data/'))) {
    await writeFileAtomic(
      path.join(record.target, nativeRelative(DATA_ROOT_MOVED_MARKER)),
      `${JSON.stringify({ format: 'nxt.data-root-moved', version: 1, movedAt: (io.now ?? Date.now)() })}\n`,
    )
  }
  return record
}

/**
 * Puts the source back the way it was and removes what the move created in the target. Safe to run more than once
 * and after a crash at any point before the switch.
 */
export const undoDataMove = async (record: DataMoveRecord): Promise<void> => {
  const target = (relative: string) => path.join(record.target, nativeRelative(relative))
  const source = (relative: string) => path.join(record.source, nativeRelative(relative))
  if (record.method === 'move') {
    await rm(target(DATA_ROOT_MOVED_MARKER), { force: true })
    for (const { file, original } of record.rewrites ?? []) {
      if (await exists(target(file))) await writeFileAtomic(target(file), original)
    }
    for (const unit of [...record.units].reverse()) {
      if ((await exists(target(unit))) && !(await exists(source(unit)))) {
        if (unit.startsWith('data/')) await mkdir(path.join(record.source, 'data'), { recursive: true })
        await rename(target(unit), source(unit))
      }
    }
  } else {
    await rm(target(DATA_ROOT_MOVED_MARKER), { force: true })
    for (const unit of record.units) await rm(target(unit), { recursive: true, force: true })
  }
  // Only directories the move made are removed, and only when nothing else ended up in them.
  for (const directory of [
    path.join(record.target, 'data', 'host'),
    path.join(record.target, 'data'),
    ...(record.createdTarget === true ? [record.target] : []),
  ]) {
    try {
      await rmdir(directory)
    } catch (error) {
      if (errorCode(error) !== 'ENOENT' && errorCode(error) !== 'ENOTEMPTY' && errorCode(error) !== 'EEXIST')
        throw error
    }
  }
}

/** A live process that wrote the record recently still owns the move. */
export const moveOwnerAlive = (
  record: DataMoveRecord,
  now: number,
  isAlive: (pid: number) => boolean,
  staleAfterMs = 30_000,
): boolean => record.pid !== process.pid && now - record.heartbeatAt < staleAfterMs && isAlive(record.pid)

export const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return errorCode(error) === 'EPERM'
  }
}

export type StartupDecision =
  /** Nothing to do; start on the resolved userData. */
  | { readonly kind: 'normal' }
  /** The move was requested and handed to this migration-mode launch. */
  | { readonly kind: 'migrate'; readonly record: DataMoveRecord }
  /** Another live process is moving the data right now. */
  | { readonly kind: 'busy'; readonly record: DataMoveRecord }
  /** A move stopped before the switch; undo it before anything opens the old directory. */
  | { readonly kind: 'undo'; readonly record: DataMoveRecord }
  /** The pointer already names the target; only the record is behind. */
  | { readonly kind: 'finish'; readonly record: DataMoveRecord }
  /** The requesting process ended before migration mode started; nothing on disk changed. */
  | { readonly kind: 'abandon'; readonly record: DataMoveRecord }

export const decideStartup = (input: {
  readonly record: DataMoveRecord | undefined
  readonly migrationFlag: boolean
  /** The userData the pointer (or default) names right now. */
  readonly pointerRoot: string
  readonly ownerAlive: boolean
}): StartupDecision => {
  const { record } = input
  if (record === undefined || record.phase === 'completed' || record.phase === 'failed') return { kind: 'normal' }
  if (record.phase === 'switched' || path.resolve(input.pointerRoot) === path.resolve(record.target))
    return { kind: 'finish', record }
  // The requesting process may still be exiting when the relaunch it started reads the record.
  if (input.migrationFlag && record.phase === 'requested') return { kind: 'migrate', record }
  if (input.ownerAlive) return { kind: 'busy', record }
  if (record.phase === 'requested') return { kind: 'abandon', record }
  return { kind: 'undo', record }
}

/** Removes the migration-mode userData left by a finished or abandoned move. */
export const removeMigrationSession = async (directory: string): Promise<void> => {
  await rm(directory, { recursive: true, force: true }).catch(() => undefined)
}

export const readDataMoveRecord = async (file: string): Promise<DataMoveRecord | undefined> => {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined
    throw error
  }
  try {
    return parseDataMoveRecord(text)
  } catch {
    return undefined
  }
}

export const writeDataMoveRecord = (file: string, record: DataMoveRecord): Promise<void> =>
  writeFileAtomic(file, serializeDataMoveRecord(record))

/** Ensures the pointer names `target`, written atomically; the switch-over point of a move. */
export const writeDataLocationPointer = async (file: string, content: string): Promise<void> => {
  await writeFileAtomic(file, content)
}

export const describeFailure = (error: unknown): DataMoveFailure =>
  error instanceof DataMoveError
    ? { message: error.message, ...(error.file === undefined ? {} : { file: error.file }) }
    : { message: describe(error) }
