import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, rm, rmdir, stat, statfs, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { classifyStorageLocation, isSameOrInside, type StorageFacts, type SyncProvider } from './storage-location.js'

/**
 * What a data-directory move carries and what it leaves. Upgrade recovery points (`data/backups`) stay with the old
 * directory: their manifests name the old root, so they cannot restore into the new one. A copy also skips content
 * the app rebuilds by itself; a same-volume move renames everything else, caches included.
 */
export const KEPT_IN_PLACE = ['data/backups'] as const
const CHROMIUM_LOCKS = /^(?:Singleton(?:Lock|Socket|Cookie)|lockfile)$/u
const REBUILDABLE_DATA = [
  'data/logs',
  'data/extension-cache',
  'data/runtimes',
  'data/dsh/plugin-staging',
  'data/dsh/request-images',
  'data/dsh/pnpm-store',
] as const
const ELECTRON_CACHES = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'GraphiteDawnCache',
  'GrShaderCache',
  'ShaderCache',
])

/** Relative paths always use `/`, whatever the platform. */
const toPosix = (relative: string): string => relative.split(path.sep).join('/')

export const isRebuildable = (relative: string): boolean => {
  const posix = toPosix(relative)
  if (REBUILDABLE_DATA.some((entry) => posix === entry || posix.startsWith(`${entry}/`))) return true
  const segments = posix.split('/')
  if (segments[0] === 'Crashpad') return true
  // Electron caches sit at the root for the local view and under Partitions/<name>/ for remote instances.
  if (ELECTRON_CACHES.has(segments[0]!)) return true
  return segments[0] === 'Partitions' && segments.length >= 3 && ELECTRON_CACHES.has(segments[2]!)
}

export type MoveMethod = 'move' | 'copy'

/**
 * Top-level units the move handles one by one: every root entry except `data` and Chromium's lock files, then every
 * entry of `data/` except `backups`. A failed move is undone unit by unit.
 */
export const listMoveUnits = async (source: string): Promise<readonly string[]> => {
  const units: string[] = []
  for (const name of (await readdir(source)).sort()) {
    if (CHROMIUM_LOCKS.test(name)) continue
    if (name !== 'data') {
      units.push(name)
      continue
    }
    const data = path.join(source, 'data')
    if (!(await lstat(data)).isDirectory()) {
      units.push(name)
      continue
    }
    for (const child of (await readdir(data)).sort()) {
      const relative = `data/${child}`
      if (!(KEPT_IN_PLACE as readonly string[]).includes(relative)) units.push(relative)
    }
  }
  return units
}

export interface ScanResult {
  readonly bytes: number
  readonly files: number
  /** Longest relative path among the entries that move, for the Windows length check. */
  readonly longestRelative: number
}

const errorCode = (error: unknown): unknown =>
  error instanceof Error && 'code' in error ? (error as { code: unknown }).code : undefined

/** Sizes what a move carries. `copy` leaves out rebuildable content; symbolic links count as entries, not targets. */
export const scanMove = async (
  source: string,
  units: readonly string[],
  method: MoveMethod,
  signal?: AbortSignal,
): Promise<ScanResult> => {
  let bytes = 0
  let files = 0
  let longestRelative = 0
  const visit = async (relative: string): Promise<void> => {
    signal?.throwIfAborted()
    if (method === 'copy' && isRebuildable(relative)) return
    let info
    try {
      info = await lstat(path.join(source, relative))
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return
      throw error
    }
    longestRelative = Math.max(longestRelative, relative.length)
    if (info.isDirectory()) {
      for (const child of await readdir(path.join(source, relative))) await visit(path.join(relative, child))
      return
    }
    files += 1
    if (info.isFile()) bytes += info.size
  }
  for (const unit of units) await visit(unit)
  return { bytes, files, longestRelative }
}

/** Total size of a directory tree, for Settings → 存储. Unreadable entries are skipped. */
export const directorySize = async (root: string, signal?: AbortSignal): Promise<number> => {
  let bytes = 0
  const visit = async (target: string): Promise<void> => {
    signal?.throwIfAborted()
    try {
      const info = await lstat(target)
      if (info.isDirectory()) for (const child of await readdir(target)) await visit(path.join(target, child))
      else if (info.isFile()) bytes += info.size
    } catch {
      // A file that disappears or cannot be read does not change what the user decides.
    }
  }
  await visit(root)
  return bytes
}

export type PreflightProblem =
  | { readonly code: 'not-absolute' }
  | { readonly code: 'same-directory' }
  | { readonly code: 'inside-source' }
  | { readonly code: 'contains-source' }
  | { readonly code: 'not-empty' }
  | { readonly code: 'not-directory' }
  | { readonly code: 'not-writable' }
  | { readonly code: 'network' }
  | { readonly code: 'sync'; readonly provider: SyncProvider }
  | { readonly code: 'insufficient-space'; readonly requiredBytes: number; readonly availableBytes: number }
  | { readonly code: 'path-too-long'; readonly longest: number }

export interface MovePlan {
  readonly source: string
  readonly target: string
  readonly method: MoveMethod
  readonly units: readonly string[]
  readonly bytes: number
  readonly files: number
  readonly estimatedSeconds: number
}

export type PreflightResult =
  { readonly ok: true; readonly plan: MovePlan } | { readonly ok: false; readonly problem: PreflightProblem }

/** Files the system creates in any folder it shows; an otherwise empty target may contain them. */
const IGNORABLE = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '.localized'])

export interface PreflightEnvironment {
  readonly storage: StorageFacts
  /** Overridable for tests; defaults to `statfs` of the nearest existing directory. */
  readonly availableBytes?: (directory: string) => Promise<number>
  /** Overridable for tests; defaults to the `dev` of `stat`. Equal devices mean a same-volume rename. */
  readonly deviceOf?: (directory: string) => Promise<number>
  readonly signal?: AbortSignal
}

const nearestExisting = async (target: string): Promise<string> => {
  let current = path.resolve(target)
  for (;;) {
    try {
      await stat(current)
      return current
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
      const parent = path.dirname(current)
      if (parent === current) return current
      current = parent
    }
  }
}

const probeWritable = async (target: string, existing: string): Promise<boolean> => {
  try {
    if (existing === target) {
      const probe = path.join(target, `.nekro-nxt-write-check-${randomUUID()}`)
      await writeFile(probe, '', { flag: 'wx', mode: 0o600 })
      await rm(probe, { force: true })
    } else {
      // The target will be created inside `existing`; create and remove a sibling to prove that works.
      const probe = path.join(existing, `.nekro-nxt-write-check-${randomUUID()}`)
      await mkdir(probe)
      await rmdir(probe)
    }
    return true
  } catch {
    return false
  }
}

const COPY_BYTES_PER_SECOND = 80 * 1024 * 1024
const COPY_SECONDS_PER_FILE = 0.002

export const preflightMove = async (
  sourceInput: string,
  targetInput: string,
  environment: PreflightEnvironment,
): Promise<PreflightResult> => {
  const platform = environment.storage.platform
  const fail = (problem: PreflightProblem): PreflightResult => ({ ok: false, problem })
  if (!path.isAbsolute(targetInput)) return fail({ code: 'not-absolute' })
  const source = path.resolve(sourceInput)
  const target = path.resolve(targetInput)
  if (isSameOrInside(platform, target, source) && isSameOrInside(platform, source, target))
    return fail({ code: 'same-directory' })
  if (isSameOrInside(platform, source, target)) return fail({ code: 'inside-source' })
  if (isSameOrInside(platform, target, source)) return fail({ code: 'contains-source' })

  const existing = await nearestExisting(target)
  if (existing === target) {
    if (!(await stat(target)).isDirectory()) return fail({ code: 'not-directory' })
    if ((await readdir(target)).some((name) => !IGNORABLE.has(name))) return fail({ code: 'not-empty' })
  } else if (!(await stat(existing)).isDirectory()) {
    return fail({ code: 'not-directory' })
  }

  const location = await classifyStorageLocation(target, environment.storage)
  if (location.kind === 'network') return fail({ code: 'network' })
  if (location.kind === 'sync') return fail({ code: 'sync', provider: location.provider })
  if (!(await probeWritable(target, existing))) return fail({ code: 'not-writable' })

  const deviceOf = environment.deviceOf ?? (async (directory: string) => (await stat(directory)).dev)
  const method: MoveMethod = (await deviceOf(source)) === (await deviceOf(existing)) ? 'move' : 'copy'
  const units = await listMoveUnits(source)
  const scan = await scanMove(source, units, method, environment.signal)
  if (method === 'copy') {
    const requiredBytes = Math.ceil(scan.bytes * 1.1)
    const availableBytes = await (
      environment.availableBytes ??
      (async (directory: string) => {
        const info = await statfs(directory)
        return info.bavail * info.bsize
      })
    )(existing)
    if (availableBytes < requiredBytes) return fail({ code: 'insufficient-space', requiredBytes, availableBytes })
  }
  if (platform === 'win32') {
    // Moving to a longer path must not push existing files past the classic 260-character limit.
    const longest = target.length + 1 + scan.longestRelative
    if (target.length > source.length && longest > 260) return fail({ code: 'path-too-long', longest })
  }
  const estimatedSeconds =
    method === 'move'
      ? Math.max(1, Math.ceil(units.length * 0.05))
      : Math.max(1, Math.ceil(scan.bytes / COPY_BYTES_PER_SECOND + scan.files * COPY_SECONDS_PER_FILE))
  return {
    ok: true,
    plan: { source, target, method, units, bytes: scan.bytes, files: scan.files, estimatedSeconds },
  }
}
