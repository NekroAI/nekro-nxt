import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, chmod, mkdir, open, readFile, readdir, rename, stat, unlink, type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { backup, type DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { openReadOnlySqlite } from './readonly-sqlite.js'

export const DSH_SESSION_APPLICATION_ID = 1_146_308_688
export const DSH_SESSION_SCHEMA_PREVIOUS = 15
/** Last supported legacy SQLite schema; new sessions use JSONL. */
export const DSH_SESSION_SCHEMA_CURRENT = 17
export const DSH_SESSION_COMPATIBILITY_ID = 'jsonl-v4'
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u)
const legacySchema = z.union([z.literal(15), z.literal(17)])

export const DshSessionArchiveManifestSchema = z
  .object({
    formatVersion: z.literal(2),
    migrationId: z.string().min(1),
    originalPath: z.string().min(1),
    originalSchema: legacySchema,
    targetCompatibilityId: z.literal(DSH_SESSION_COMPATIBILITY_ID),
    sessionRoot: z.string().min(1),
    archivedAt: z.string().datetime(),
    databaseSize: z.number().int().nonnegative(),
    databaseSha256: hashSchema,
    sourceSha256: hashSchema,
    sourceFiles: z.array(z.object({ suffix: z.enum(['', '-wal']), sha256: hashSchema }).strict()).min(1),
  })
  .strict()
export type DshSessionArchiveManifest = z.infer<typeof DshSessionArchiveManifestSchema>

interface PreparedSessionRoot {
  readonly sessionRoot: string
  readonly sessionCompatibilityId: typeof DSH_SESSION_COMPATIBILITY_ID
}
export type DshSessionStoragePreparation = PreparedSessionRoot &
  (
    | { readonly kind: 'new' }
    | { readonly kind: 'compatible' }
    | {
        readonly kind: 'archived'
        readonly schemaVersion: 15 | 17
        readonly migrationId: string
        readonly archivePath: string
        readonly manifest: DshSessionArchiveManifest
      }
  )
export interface DshSessionStorageOptions {
  /** Legacy file, under the same exclusively leased data root as Core. */
  readonly databasePath: string
  readonly sessionRoot?: string
  readonly sessionCompatibilityId?: string
  readonly now?: () => Date
  readonly onProgress?: (
    phase: 'archive-published' | 'reset-pending' | 'source-retired' | 'target-prepared',
  ) => void | Promise<void>
}
const ResetMarkerSchema = z
  .object({ archivePath: z.string().min(1), manifest: DshSessionArchiveManifestSchema })
  .strict()
type ResetMarker = z.infer<typeof ResetMarkerSchema>
const StorageIdentitySchema = z
  .object({
    formatVersion: z.literal(1),
    sessionCompatibilityId: z.literal(DSH_SESSION_COMPATIBILITY_ID),
    sessionRoot: z.string().min(1),
    migrationId: z.string().min(1).optional(),
  })
  .strict()
const LockSchema = z.object({ pid: z.number().int().positive(), acquiredAt: z.string().datetime() }).strict()
const resetMarkerPath = (databasePath: string): string => `${databasePath}.nekro-nxt-reset-required.json`
const identityPath = (databasePath: string): string =>
  path.join(path.dirname(databasePath), 'dsh', 'session-storage.json')

const errorCode = (error: unknown): string | undefined =>
  error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
const exists = async (target: string): Promise<boolean> => {
  try {
    await access(target)
    return true
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false
    throw error
  }
}
const sha256File = async (target: string): Promise<string> =>
  await new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const input = createReadStream(target)
    input.on('data', (chunk) => hash.update(chunk))
    input.once('error', reject)
    input.once('end', () => resolve(hash.digest('hex')))
  })
const syncDirectory = async (directory: string): Promise<void> => {
  // Windows does not expose directory fsync. Atomic rename still prevents partial JSON.
  if (process.platform === 'win32') return
  const handle = await open(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}
const writeJson = async (target: string, value: unknown): Promise<void> => {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  const temporary = `${target}.tmp-${randomUUID()}`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, target)
  await syncDirectory(path.dirname(target))
}
const readJson = async (target: string): Promise<unknown> => JSON.parse(await readFile(target, 'utf8')) as unknown
const integerField = (row: unknown, key: string): number => {
  if (row !== null && typeof row === 'object' && key in row) {
    const value = Reflect.get(row, key) as unknown
    if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  }
  throw new Error(`DSH Session database has invalid ${key}.`)
}
const verifyDatabase = (database: DatabaseSync, expectedSchema?: number): 15 | 17 => {
  const schema = integerField(database.prepare('PRAGMA user_version').get(), 'user_version')
  const applicationId = integerField(database.prepare('PRAGMA application_id').get(), 'application_id')
  if (applicationId !== DSH_SESSION_APPLICATION_ID)
    throw new Error(`DSH Session database has application id ${applicationId}; expected ${DSH_SESSION_APPLICATION_ID}.`)
  if ((schema !== 15 && schema !== 17) || (expectedSchema !== undefined && schema !== expectedSchema))
    throw new Error(`DSH Session database schema ${schema} is unsupported; expected 15 or 17.`)
  const check = database.prepare('PRAGMA quick_check').all()
  if (check.length !== 1 || check[0]?.['quick_check'] !== 'ok')
    throw new Error('DSH Session database failed quick_check.')
  return schema
}
const verifyArchive = async (
  { archivePath, manifest }: ResetMarker,
  databasePath: string,
  sessionRoot: string,
): Promise<void> => {
  const archiveRoot = path.join(path.dirname(databasePath), 'dsh', 'session-archives')
  if (
    path.dirname(archivePath) !== archiveRoot ||
    manifest.originalPath !== databasePath ||
    manifest.sessionRoot !== sessionRoot
  )
    throw new Error('DSH Session archive does not belong to this storage root.')
  const sourceDigest = createHash('sha256').update(JSON.stringify(manifest.sourceFiles)).digest('hex')
  if (
    sourceDigest !== manifest.sourceSha256 ||
    manifest.migrationId !== `sqlite-${manifest.originalSchema}-to-${DSH_SESSION_COMPATIBILITY_ID}:${sourceDigest}` ||
    manifest.sourceFiles.filter(({ suffix }) => suffix === '').length !== 1 ||
    new Set(manifest.sourceFiles.map(({ suffix }) => suffix)).size !== manifest.sourceFiles.length
  )
    throw new Error('DSH Session archive migration identity mismatch.')
  const snapshotPath = path.join(archivePath, 'sessions.sqlite')
  if (
    (await stat(snapshotPath)).size !== manifest.databaseSize ||
    (await sha256File(snapshotPath)) !== manifest.databaseSha256
  )
    throw new Error('DSH Session archive checksum mismatch; original storage was not retired.')
  const snapshot = openReadOnlySqlite(snapshotPath)
  try {
    verifyDatabase(snapshot, manifest.originalSchema)
  } finally {
    snapshot.close()
  }
}
const acquireUpgradeLock = async (lockPath: string, now: () => Date): Promise<FileHandle> => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: now().toISOString() }))
        await handle.sync()
      } catch (error) {
        await handle.close()
        throw error
      }
      return handle
    } catch (error) {
      if (errorCode(error) !== 'EEXIST' || attempt > 0) throw error
      // An unreadable lock is not proof that its owner died.
      const owner = LockSchema.parse(await readJson(lockPath))
      let alive = true
      try {
        process.kill(owner.pid, 0)
      } catch (probeError) {
        if (errorCode(probeError) === 'ESRCH') alive = false
        else if (errorCode(probeError) !== 'EPERM') throw probeError
      }
      if (alive) throw new Error(`Another NekroNXT Server process (${owner.pid}) owns the DSH Session startup lock.`)
      await rename(lockPath, `${lockPath}.stale-${randomUUID()}`)
    }
  }
  throw new Error('Unable to acquire the DSH Session startup lock.')
}

const sourceFiles = async (databasePath: string): Promise<DshSessionArchiveManifest['sourceFiles']> => {
  const files: DshSessionArchiveManifest['sourceFiles'] = []
  for (const suffix of ['', '-wal'] as const) {
    if (await exists(`${databasePath}${suffix}`))
      files.push({ suffix, sha256: await sha256File(`${databasePath}${suffix}`) })
  }
  return files
}
const retireSource = async (databasePath: string, marker: ResetMarker): Promise<void> => {
  // Validate every remaining file first, including a WAL left by interruption between renames.
  for (const file of marker.manifest.sourceFiles) {
    const target = `${databasePath}${file.suffix}`
    if ((await exists(target)) && (await sha256File(target)) !== file.sha256)
      throw new Error('DSH Session source changed after archive; refusing to retire it.')
  }
  for (const suffix of ['', '-wal', '-shm'] as const) {
    const source = `${databasePath}${suffix}`
    if (!(await exists(source))) continue
    if (suffix !== '-shm' && !marker.manifest.sourceFiles.some((file) => file.suffix === suffix))
      throw new Error('Unexpected DSH Session source file appeared after archive.')
    const destination = path.join(marker.archivePath, `original-sessions.sqlite${suffix}`)
    if (await exists(destination)) throw new Error('DSH Session archive already contains a different original source.')
    await rename(source, destination)
  }
  await syncDirectory(path.dirname(databasePath))
  await syncDirectory(marker.archivePath)
}

/** Called only after Core's transaction and migration receipt have committed. Safe to repeat. */
export const completeDshSessionStoragePreparation = async (
  databasePath: string,
  migrationId: string,
): Promise<void> => {
  const identity = StorageIdentitySchema.parse(await readJson(identityPath(databasePath)))
  if (identity.migrationId !== migrationId) throw new Error('DSH Session completion migration ID mismatch.')
  const markerPath = resetMarkerPath(databasePath)
  if (!(await exists(markerPath))) return
  const marker = ResetMarkerSchema.parse(await readJson(markerPath))
  if (marker.manifest.migrationId !== migrationId) throw new Error('DSH Session reset marker migration ID mismatch.')
  await verifyArchive(marker, databasePath, identity.sessionRoot)
  if ((await exists(databasePath)) || (await exists(`${databasePath}-wal`)))
    throw new Error('DSH Session original source has not been retired.')
  await unlink(markerPath)
  await syncDirectory(path.dirname(markerPath))
}

/** Read-only validation before full backup and before Core applies any migration. */
export const preflightDshSessionStorage = async (
  options: Pick<DshSessionStorageOptions, 'databasePath' | 'sessionRoot' | 'sessionCompatibilityId'>,
): Promise<void> => {
  const databasePath = path.resolve(options.databasePath)
  const sessionRoot = options.sessionRoot ?? path.join(path.dirname(databasePath), 'dsh', 'sessions')
  if (databasePath !== options.databasePath || path.resolve(sessionRoot) !== sessionRoot)
    throw new TypeError('DSH Session storage paths must be absolute.')
  if ((options.sessionCompatibilityId ?? DSH_SESSION_COMPATIBILITY_ID) !== DSH_SESSION_COMPATIBILITY_ID)
    throw new Error('Unknown DSH Session compatibility ID; no migration is registered.')
  const identity = (await exists(identityPath(databasePath)))
    ? StorageIdentitySchema.parse(await readJson(identityPath(databasePath)))
    : undefined
  if (identity !== undefined && identity.sessionRoot !== sessionRoot)
    throw new Error('DSH Session storage root changed without a registered migration.')
  const marker = (await exists(resetMarkerPath(databasePath)))
    ? ResetMarkerSchema.parse(await readJson(resetMarkerPath(databasePath)))
    : undefined
  if (marker !== undefined) {
    if (identity?.migrationId !== undefined && identity.migrationId !== marker.manifest.migrationId)
      throw new Error('DSH Session reset marker conflicts with current storage identity.')
    await verifyArchive(marker, databasePath, sessionRoot)
  }
  if (await exists(databasePath)) {
    if (identity !== undefined && marker === undefined)
      throw new Error('Legacy DSH Session database reappeared after JSONL initialization.')
    const database = openReadOnlySqlite(databasePath)
    try {
      verifyDatabase(database)
    } finally {
      database.close()
    }
  }
  if (
    identity === undefined &&
    marker === undefined &&
    (await exists(sessionRoot)) &&
    (await readdir(sessionRoot)).length > 0
  )
    throw new Error('Unidentified non-empty DSH Session root; refusing to reset or adopt it.')
}

/**
 * Prepare storage while Host holds the data-root lease and before any Session is opened.
 * Only explicitly known legacy formats may reset Core; build/version changes never do.
 * The caller must create the complete Host backup before invoking this function.
 */
export const prepareDshSessionStorage = async (
  options: DshSessionStorageOptions,
): Promise<DshSessionStoragePreparation> => {
  const databasePath = path.resolve(options.databasePath)
  const sessionRoot = options.sessionRoot ?? path.join(path.dirname(databasePath), 'dsh', 'sessions')
  if (databasePath !== options.databasePath || path.resolve(sessionRoot) !== sessionRoot)
    throw new TypeError('DSH Session storage paths must be absolute.')
  if ((options.sessionCompatibilityId ?? DSH_SESSION_COMPATIBILITY_ID) !== DSH_SESSION_COMPATIBILITY_ID)
    throw new Error('Unknown DSH Session compatibility ID; no migration is registered.')
  const prepared = { sessionRoot, sessionCompatibilityId: DSH_SESSION_COMPATIBILITY_ID } as const
  const now = options.now ?? (() => new Date())
  await mkdir(path.dirname(databasePath), { recursive: true, mode: 0o700 })
  const lockPath = `${databasePath}.nekro-nxt-startup.lock`
  const lock = await acquireUpgradeLock(lockPath, now)
  try {
    const identityFile = identityPath(databasePath)
    const identity = (await exists(identityFile))
      ? StorageIdentitySchema.parse(await readJson(identityFile))
      : undefined
    if (identity !== undefined && identity.sessionRoot !== sessionRoot)
      throw new Error('DSH Session storage root changed without a registered migration.')
    const markerFile = resetMarkerPath(databasePath)
    let marker = (await exists(markerFile)) ? ResetMarkerSchema.parse(await readJson(markerFile)) : undefined
    if (
      marker !== undefined &&
      identity?.migrationId !== undefined &&
      identity.migrationId !== marker.manifest.migrationId
    )
      throw new Error('DSH Session reset marker conflicts with current storage identity.')
    if (marker === undefined && identity !== undefined) {
      if (await exists(databasePath))
        throw new Error('Legacy DSH Session database reappeared after JSONL initialization.')
      await mkdir(sessionRoot, { recursive: true, mode: 0o700 })
      return { kind: 'compatible', ...prepared }
    }
    if (marker === undefined && (await exists(sessionRoot)) && (await readdir(sessionRoot)).length > 0)
      throw new Error('Unidentified non-empty DSH Session root; refusing to reset or adopt it.')
    if (marker === undefined && (await exists(databasePath))) {
      const database = openReadOnlySqlite(databasePath)
      try {
        const originalSchema = verifyDatabase(database)
        const files = await sourceFiles(databasePath)
        const sourceSha256 = createHash('sha256').update(JSON.stringify(files)).digest('hex')
        const migrationId = `sqlite-${originalSchema}-to-${DSH_SESSION_COMPATIBILITY_ID}:${sourceSha256}`
        const archiveRoot = path.join(path.dirname(databasePath), 'dsh', 'session-archives')
        await mkdir(archiveRoot, { recursive: true, mode: 0o700 })
        const archivePath = path.join(archiveRoot, `schema${originalSchema}-${sourceSha256}`)
        if (await exists(archivePath)) {
          const manifest = DshSessionArchiveManifestSchema.parse(
            await readJson(path.join(archivePath, 'manifest.json')),
          )
          if (manifest.migrationId !== migrationId || manifest.sourceSha256 !== sourceSha256)
            throw new Error('DSH Session archive source identity mismatch.')
          marker = { archivePath, manifest }
        } else {
          const stagingPath = path.join(archiveRoot, `.staging-${randomUUID()}`)
          await mkdir(stagingPath, { mode: 0o700 })
          const snapshotPath = path.join(stagingPath, 'sessions.sqlite')
          await backup(database, snapshotPath)
          await chmod(snapshotPath, 0o600)
          const manifest: DshSessionArchiveManifest = {
            formatVersion: 2,
            migrationId,
            originalPath: databasePath,
            originalSchema,
            targetCompatibilityId: DSH_SESSION_COMPATIBILITY_ID,
            sessionRoot,
            archivedAt: now().toISOString(),
            databaseSize: (await stat(snapshotPath)).size,
            databaseSha256: await sha256File(snapshotPath),
            sourceSha256,
            sourceFiles: files,
          }
          const snapshot = openReadOnlySqlite(snapshotPath)
          try {
            verifyDatabase(snapshot, originalSchema)
          } finally {
            snapshot.close()
          }
          // Detect a live legacy writer instead of retiring a stale snapshot.
          if (JSON.stringify(await sourceFiles(databasePath)) !== JSON.stringify(files))
            throw new Error('DSH Session source changed while creating its archive.')
          await writeJson(path.join(stagingPath, 'manifest.json'), manifest)
          await rename(stagingPath, archivePath)
          await syncDirectory(archiveRoot)
          marker = { archivePath, manifest }
          await options.onProgress?.('archive-published')
        }
      } finally {
        database.close()
      }
    }
    if (marker !== undefined) {
      await verifyArchive(marker, databasePath, sessionRoot)
      await writeJson(markerFile, marker)
      await options.onProgress?.('reset-pending')
      await retireSource(databasePath, marker)
      await options.onProgress?.('source-retired')
    }
    await writeJson(identityFile, {
      formatVersion: 1,
      ...prepared,
      ...(marker === undefined ? {} : { migrationId: marker.manifest.migrationId }),
    })
    await mkdir(sessionRoot, { recursive: true, mode: 0o700 })
    await options.onProgress?.('target-prepared')
    return marker === undefined
      ? { kind: 'new', ...prepared }
      : {
          kind: 'archived',
          ...prepared,
          schemaVersion: marker.manifest.originalSchema,
          migrationId: marker.manifest.migrationId,
          archivePath: marker.archivePath,
          manifest: marker.manifest,
        }
  } finally {
    await lock.close()
    await unlink(lockPath)
  }
}
