import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  access,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
  type FileHandle,
} from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { backup, DatabaseSync } from 'node:sqlite'
import { z } from 'zod'

export const DSH_SESSION_APPLICATION_ID = 1_146_308_688
export const DSH_SESSION_SCHEMA_PREVIOUS = 15
export const DSH_SESSION_SCHEMA_CURRENT = 17
export const DSH_VERSION_PREVIOUS = '0.1.0-rc.6'
export const DSH_VERSION_CURRENT = '0.1.1-rc.1'

export const DshSessionArchiveManifestSchema = z
  .object({
    formatVersion: z.literal(1),
    originalPath: z.string().min(1),
    originalSchema: z.literal(DSH_SESSION_SCHEMA_PREVIOUS),
    targetSchema: z.literal(DSH_SESSION_SCHEMA_CURRENT),
    originalDshVersion: z.literal(DSH_VERSION_PREVIOUS),
    targetDshVersion: z.literal(DSH_VERSION_CURRENT),
    archivedAt: z.string().datetime(),
    databaseSize: z.number().int().nonnegative(),
    databaseSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    sourceSize: z.number().int().nonnegative(),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict()

export type DshSessionArchiveManifest = z.infer<typeof DshSessionArchiveManifestSchema>

export type DshSessionStoragePreparation =
  | { readonly kind: 'new' }
  | { readonly kind: 'compatible'; readonly schemaVersion: typeof DSH_SESSION_SCHEMA_CURRENT }
  | {
      readonly kind: 'archived'
      readonly schemaVersion: typeof DSH_SESSION_SCHEMA_PREVIOUS
      readonly archivePath: string
      readonly manifest: DshSessionArchiveManifest
    }

interface DshSessionStorageOptions {
  readonly databasePath: string
  readonly now?: () => Date
}

const DshSessionResetMarkerSchema = z
  .object({ archivePath: z.string().min(1), manifest: DshSessionArchiveManifestSchema })
  .strict()
const DshSessionLockSchema = z.object({ pid: z.number().int().positive(), acquiredAt: z.string().datetime() }).strict()
type DshSessionResetMarker = z.infer<typeof DshSessionResetMarkerSchema>

const resetMarkerPath = (databasePath: string): string => `${databasePath}.nekro-nxt-reset-required.json`

const exists = async (target: string): Promise<boolean> => {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

const sha256File = async (target: string): Promise<string> =>
  await new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256')
    const input = createReadStream(target)
    input.on('data', (chunk) => hash.update(chunk))
    input.once('error', reject)
    input.once('end', () => resolve(hash.digest('hex')))
  })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const errorCode = (error: unknown): string | undefined => {
  if (!isRecord(error)) return undefined
  return typeof error['code'] === 'string' ? error['code'] : undefined
}

const integerField = (row: unknown, key: string): number => {
  if (!isRecord(row)) {
    throw new Error(`DSH Session storage identity query returned no ${key}.`)
  }
  const value = row[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`DSH Session storage identity ${key} is not an integer.`)
  }
  return value
}

const verifyArchiveSnapshot = (snapshotPath: string): void => {
  const snapshot = new DatabaseSync(snapshotPath, { readOnly: true })
  try {
    const version = integerField(snapshot.prepare('PRAGMA user_version').get(), 'user_version')
    const applicationId = integerField(snapshot.prepare('PRAGMA application_id').get(), 'application_id')
    const quickCheck = snapshot.prepare('PRAGMA quick_check').get()
    const quickCheckValue = isRecord(quickCheck) ? quickCheck['quick_check'] : undefined
    if (version !== DSH_SESSION_SCHEMA_PREVIOUS || applicationId !== DSH_SESSION_APPLICATION_ID) {
      throw new Error(
        `Archived DSH Session snapshot identity mismatch (schema ${version}, application id ${applicationId}).`,
      )
    }
    if (quickCheckValue !== 'ok') {
      throw new Error(`Archived DSH Session snapshot failed quick_check: ${String(quickCheckValue)}`)
    }
  } finally {
    snapshot.close()
  }
}

const isProcessAlive = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return errorCode(error) === 'EPERM'
  }
}

const acquireUpgradeLock = async (lockPath: string, now: () => Date): Promise<FileHandle> => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx', 0o600)
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, acquiredAt: now().toISOString() })}\n`)
      return handle
    } catch (error) {
      if (errorCode(error) !== 'EEXIST' || attempt > 0) throw error
      let ownerPid = 0
      try {
        const owner = DshSessionLockSchema.safeParse(JSON.parse(await readFile(lockPath, 'utf8')))
        if (owner.success) ownerPid = owner.data.pid
      } catch {
        // An unreadable lock is conservatively treated as stale only when no
        // live owner can be identified from it.
      }
      if (isProcessAlive(ownerPid)) {
        throw new Error(`Another NekroNxt Server process (${ownerPid}) owns the DSH Session startup lock.`)
      }
      await rename(lockPath, `${lockPath}.stale-${now().toISOString().replaceAll(/[:.]/gu, '')}`)
    }
  }
  throw new Error('Unable to acquire the DSH Session startup lock.')
}

const archiveDirectoryName = (now: Date): string =>
  `${now.toISOString().replaceAll(/[-:.]/gu, '')}-schema${DSH_SESSION_SCHEMA_PREVIOUS}`

const findMatchingArchive = async (
  archiveRoot: string,
  originalPath: string,
  sourceSha256: string,
): Promise<{ readonly path: string; readonly manifest: DshSessionArchiveManifest } | undefined> => {
  if (!(await exists(archiveRoot))) return undefined
  const entries = await readdir(archiveRoot, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith(`-schema${DSH_SESSION_SCHEMA_PREVIOUS}`)) continue
    const archivePath = path.join(archiveRoot, entry.name)
    try {
      const manifest = DshSessionArchiveManifestSchema.safeParse(
        JSON.parse(await readFile(path.join(archivePath, 'manifest.json'), 'utf8')),
      )
      if (
        manifest.success &&
        manifest.data.originalPath === originalPath &&
        manifest.data.sourceSha256 === sourceSha256
      ) {
        return { path: archivePath, manifest: manifest.data }
      }
    } catch {
      // A partial or administrator-modified archive never authorizes removal
      // of the source database; a fresh verified archive is created instead.
    }
  }
  return undefined
}

const moveOriginalDatabase = async (databasePath: string, archivePath: string): Promise<void> => {
  const targets = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
  const moved: { readonly from: string; readonly to: string }[] = []
  try {
    for (const source of targets) {
      if (!(await exists(source))) continue
      const suffix = source.slice(databasePath.length)
      const destination = path.join(archivePath, `original-sessions.sqlite${suffix}`)
      await rename(source, destination)
      moved.push({ from: source, to: destination })
    }
  } catch (error) {
    for (const entry of moved.reverse()) {
      await rename(entry.to, entry.from).catch(() => undefined)
    }
    throw error
  }
}

const writeResetMarker = async (
  databasePath: string,
  archivePath: string,
  manifest: DshSessionArchiveManifest,
): Promise<void> => {
  await writeFile(resetMarkerPath(databasePath), `${JSON.stringify({ archivePath, manifest }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
}

const readResetMarker = async (databasePath: string): Promise<DshSessionResetMarker | undefined> => {
  const markerPath = resetMarkerPath(databasePath)
  if (!(await exists(markerPath))) return undefined
  const value = DshSessionResetMarkerSchema.safeParse(JSON.parse(await readFile(markerPath, 'utf8')))
  if (!value.success) {
    throw new Error(`DSH Session reset marker is invalid: ${markerPath}`)
  }
  return value.data
}

/** Clear the durable reset marker after Core Episode retirement commits. */
export const completeDshSessionStoragePreparation = async (databasePath: string): Promise<void> => {
  await unlink(resetMarkerPath(databasePath))
}

/**
 * Validate the DSH-owned SQLite file before rc.1 mounts its persistence
 * provider. Schema 15 is snapshotted and moved aside; unknown ownership is
 * never guessed or rewritten.
 */
export const prepareDshSessionStorage = async (
  options: DshSessionStorageOptions,
): Promise<DshSessionStoragePreparation> => {
  const databasePath = path.resolve(options.databasePath)
  if (databasePath !== options.databasePath) throw new TypeError('DSH Session database path must be absolute.')
  const now = options.now ?? (() => new Date())
  await mkdir(path.dirname(databasePath), { recursive: true })
  const lockPath = `${databasePath}.nekro-nxt-startup.lock`
  const lock = await acquireUpgradeLock(lockPath, now)
  try {
    const pendingReset = await readResetMarker(databasePath)
    if (!(await exists(databasePath))) {
      if (pendingReset !== undefined) {
        return {
          kind: 'archived',
          schemaVersion: DSH_SESSION_SCHEMA_PREVIOUS,
          archivePath: pendingReset.archivePath,
          manifest: pendingReset.manifest,
        }
      }
      return { kind: 'new' }
    }
    const sourceStat = await stat(databasePath)
    if (sourceStat.size === 0) {
      if (pendingReset !== undefined) {
        return {
          kind: 'archived',
          schemaVersion: DSH_SESSION_SCHEMA_PREVIOUS,
          archivePath: pendingReset.archivePath,
          manifest: pendingReset.manifest,
        }
      }
      return { kind: 'new' }
    }

    const database = new DatabaseSync(databasePath, { timeout: 5_000 })
    let userVersion = 0
    let applicationId = 0
    let userObjectCount = 0
    try {
      database.exec('PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 5000;')
      userVersion = integerField(database.prepare('PRAGMA user_version').get(), 'user_version')
      applicationId = integerField(database.prepare('PRAGMA application_id').get(), 'application_id')
      userObjectCount = integerField(
        database.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").get(),
        'count',
      )
      if (userVersion === DSH_SESSION_SCHEMA_CURRENT) {
        if (applicationId !== DSH_SESSION_APPLICATION_ID) {
          throw new Error(
            `DSH Session database has application id ${applicationId}; expected ${DSH_SESSION_APPLICATION_ID}.`,
          )
        }
        if (pendingReset !== undefined) {
          return {
            kind: 'archived',
            schemaVersion: DSH_SESSION_SCHEMA_PREVIOUS,
            archivePath: pendingReset.archivePath,
            manifest: pendingReset.manifest,
          }
        }
        return { kind: 'compatible', schemaVersion: DSH_SESSION_SCHEMA_CURRENT }
      }
      if (userVersion === 0) {
        throw new Error(
          `DSH Session database is non-empty but unversioned (application id ${applicationId}, objects ${userObjectCount}).`,
        )
      }
      if (applicationId !== DSH_SESSION_APPLICATION_ID) {
        throw new Error(
          `DSH Session database has application id ${applicationId}; expected ${DSH_SESSION_APPLICATION_ID}.`,
        )
      }
      if (userVersion !== DSH_SESSION_SCHEMA_PREVIOUS) {
        throw new Error(
          `DSH Session database schema ${userVersion} is unsupported; expected ${DSH_SESSION_SCHEMA_PREVIOUS} or ${DSH_SESSION_SCHEMA_CURRENT}.`,
        )
      }

      database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
      const archiveRoot = path.join(path.dirname(databasePath), 'dsh', 'session-archives')
      await mkdir(archiveRoot, { recursive: true })
      const sourceSha256 = await sha256File(databasePath)
      const existing = await findMatchingArchive(archiveRoot, databasePath, sourceSha256)
      if (existing !== undefined) {
        database.close()
        await writeResetMarker(databasePath, existing.path, existing.manifest)
        await moveOriginalDatabase(databasePath, existing.path)
        return {
          kind: 'archived',
          schemaVersion: DSH_SESSION_SCHEMA_PREVIOUS,
          archivePath: existing.path,
          manifest: existing.manifest,
        }
      }

      const archiveName = archiveDirectoryName(now())
      const stagingPath = path.join(archiveRoot, `.${archiveName}.staging-${process.pid}`)
      const archivePath = path.join(archiveRoot, archiveName)
      await mkdir(stagingPath, { recursive: false })
      const snapshotPath = path.join(stagingPath, 'sessions.sqlite')
      await backup(database, snapshotPath)
      verifyArchiveSnapshot(snapshotPath)
      const snapshotStat = await stat(snapshotPath)
      const manifest: DshSessionArchiveManifest = {
        formatVersion: 1,
        originalPath: databasePath,
        originalSchema: DSH_SESSION_SCHEMA_PREVIOUS,
        targetSchema: DSH_SESSION_SCHEMA_CURRENT,
        originalDshVersion: DSH_VERSION_PREVIOUS,
        targetDshVersion: DSH_VERSION_CURRENT,
        archivedAt: now().toISOString(),
        databaseSize: snapshotStat.size,
        databaseSha256: await sha256File(snapshotPath),
        sourceSize: sourceStat.size,
        sourceSha256,
      }
      await writeFile(path.join(stagingPath, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      })
      await rename(stagingPath, archivePath)
      database.close()
      await writeResetMarker(databasePath, archivePath, manifest)
      await moveOriginalDatabase(databasePath, archivePath)
      return {
        kind: 'archived',
        schemaVersion: DSH_SESSION_SCHEMA_PREVIOUS,
        archivePath,
        manifest,
      }
    } finally {
      try {
        database.close()
      } catch {
        // The migration path closes before moving the source file.
      }
    }
  } finally {
    await lock.close().catch(() => undefined)
    await unlink(lockPath).catch(() => undefined)
  }
}
