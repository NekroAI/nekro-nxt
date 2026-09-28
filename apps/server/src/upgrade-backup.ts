import { createHash, randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, readlink, realpath, rename, rm, statfs, symlink } from 'node:fs/promises'
import path from 'node:path'
import { createSqliteFileSnapshot, verifySqliteSnapshot } from '@nekro-nxt/storage-sqlite'
import { z } from 'zod'

const relativePath = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !path.isAbsolute(value) &&
      !/[\\\0:]/u.test(value) &&
      value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
  )
const basename = relativePath.refine((value) => !value.includes('/'))
const rootSchema = z.object({ key: z.string().regex(/^[a-z][a-z0-9-]*$/u), target: z.string().min(1) }).strict()
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u)
const backupIdSchema = z.string().regex(/^runtime-[a-f0-9]{32}$/u)
const entrySchema = z
  .object({
    root: z.string(),
    path: relativePath,
    kind: z.enum(['directory', 'file', 'symlink']),
    mode: z.number().int().min(0).max(0o777),
    size: z.number().int().nonnegative(),
    sha256: hashSchema.optional(),
    link: z.string().optional(),
    sqlite: z.boolean().optional(),
  })
  .strict()
export const UpgradeBackupManifestSchema = z
  .object({
    format: z.literal('nxt.full-upgrade-backup'),
    version: z.literal(1),
    backupId: backupIdSchema,
    releaseId: z.string().min(1),
    runtimeFingerprint: z.string().min(1),
    sourceRuntimeFingerprint: z.string().min(1).optional(),
    migrationId: z.string().min(1).optional(),
    createdAt: z.number().int().nonnegative(),
    roots: z.array(rootSchema).min(1),
    entries: z.array(entrySchema),
    excluded: z.array(z.string()),
  })
  .strict()
export type UpgradeBackupManifest = z.infer<typeof UpgradeBackupManifestSchema>
type BackupEntry = UpgradeBackupManifest['entries'][number]
type BackupRoot = UpgradeBackupManifest['roots'][number]
export interface UpgradeBackupOptions {
  readonly dataRoot: string
  readonly releaseId: string
  readonly runtimeFingerprint: string
  /** Supplied by the owner from a public runtime identity, never inferred from a private DSH database. */
  readonly sourceRuntimeFingerprint?: string
  /** A stable owner migration ID; retries across product rebuilds can reuse the same verified point. */
  readonly migrationId?: string
  readonly externalRoots?: readonly { readonly key: string; readonly target: string }[]
  readonly signal?: AbortSignal
  readonly onProgress?: (completed: number, total: number) => void
}

const EXCLUDED = ['backups', 'extension-cache', 'dsh/plugin-staging', 'dsh/request-images'] as const
const errorCode = (error: unknown): unknown => (error instanceof Error && 'code' in error ? error.code : undefined)
const exists = async (filename: string): Promise<boolean> => {
  try {
    await lstat(filename)
    return true
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false
    throw error
  }
}
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const isWithin = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}
const sameRoots = (a: readonly BackupRoot[], b: readonly BackupRoot[]): boolean =>
  JSON.stringify([...a].sort((x, y) => x.key.localeCompare(y.key))) ===
  JSON.stringify([...b].sort((x, y) => x.key.localeCompare(y.key)))

export const syncUpgradeDirectory = async (directory: string): Promise<void> => {
  let handle
  try {
    handle = await open(directory, 'r')
    await handle.sync()
  } catch (error) {
    // Windows does not expose directory fsync through Node; file flush still remains mandatory.
    if (!(
      process.platform === 'win32' &&
      ['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR', 'EACCES'].includes(String(errorCode(error)))
    ))
      throw error
  } finally {
    await handle?.close()
  }
}
const realDirectory = async (directory: string): Promise<string> => {
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('恢复点目录校验失败：目录不能是符号链接。')
  return realpath(directory)
}
/** Resolves ordinary ancestor aliases (e.g. macOS /var), but never follows the owned directory itself. */
export const prepareUpgradeBackupDirectory = async (dataRoot: string): Promise<string> => {
  await mkdir(dataRoot, { recursive: true, mode: 0o700 })
  const root = await realDirectory(dataRoot)
  const directory = path.join(root, 'backups')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if ((await realDirectory(directory)) !== directory) throw new Error('备份目录身份发生变化。')
  await syncUpgradeDirectory(root)
  return directory
}

/** Same-directory temporary, file flush, atomic publish and parent-directory flush. */
export const writeUpgradeJson = async (filename: string, value: unknown): Promise<void> => {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 })
  await realDirectory(path.dirname(filename))
  if (await exists(filename)) {
    const info = await lstat(filename)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('升级状态文件路径冲突。')
  }
  const temporary = `${filename}.${randomUUID()}.tmp`
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, filename)
    await syncUpgradeDirectory(path.dirname(filename))
  } finally {
    await rm(temporary, { force: true })
  }
}

const statIdentity = (info: Stats): string =>
  JSON.stringify([info.dev, info.ino, info.mode, info.size, info.mtimeMs, info.ctimeMs])
const fileDigest = async (filename: string): Promise<string> => {
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    if (!before.isFile()) throw new Error('恢复点文件校验失败。')
    const hash = createHash('sha256')
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      if (!Buffer.isBuffer(chunk)) throw new Error('校验数据流格式无效。')
      hash.update(chunk)
    }
    if (
      statIdentity(before) !== statIdentity(await handle.stat()) ||
      statIdentity(before) !== statIdentity(await lstat(filename))
    )
      throw new Error('校验期间文件发生变化。')
    return hash.digest('hex')
  } finally {
    await handle.close()
  }
}
const rootsFor = async (options: Pick<UpgradeBackupOptions, 'dataRoot' | 'externalRoots'>): Promise<BackupRoot[]> => {
  const requested = [{ key: 'data', target: path.resolve(options.dataRoot) }, ...(options.externalRoots ?? [])]
  const roots: BackupRoot[] = []
  const keys = new Set<string>()
  for (const root of requested) {
    rootSchema.parse(root)
    if (!path.isAbsolute(root.target) || keys.has(root.key)) throw new Error('恢复点根目录身份无效。')
    keys.add(root.key)
    roots.push({ key: root.key, target: await realDirectory(root.target) })
  }
  for (let i = 0; i < roots.length; i += 1)
    for (let j = i + 1; j < roots.length; j += 1) {
      if (isWithin(roots[i]!.target, roots[j]!.target) || isWithin(roots[j]!.target, roots[i]!.target))
        throw new Error('恢复点根目录不得重叠。')
    }
  return roots
}
const excluded = (root: string, relative: string): boolean =>
  root === 'data' &&
  (EXCLUDED.some((item) => relative === item || relative.startsWith(`${item}/`)) ||
    /^(?:core|sessions)\.sqlite-(?:wal|shm)$/u.test(relative))

interface Inventory {
  entries: BackupEntry[]
  identities: Map<string, string>
  sqliteWalBytes: number
}
const inventory = async (
  roots: readonly BackupRoot[],
  applyExclusions: boolean,
  skipBackupControl = false,
): Promise<Inventory> => {
  const entries: BackupEntry[] = []
  const identities = new Map<string, string>()
  let sqliteWalBytes = 0
  const walk = async (root: BackupRoot, relative = ''): Promise<void> => {
    const directory = path.join(root.target, relative)
    const parentBefore = await lstat(directory)
    if (!parentBefore.isDirectory() || parentBefore.isSymbolicLink()) throw new Error('备份期间目录发生变化。')
    identities.set(`${root.key}/${relative}`, JSON.stringify([parentBefore.dev, parentBefore.ino, parentBefore.mode]))
    for (const name of (await readdir(directory)).sort()) {
      const candidate = relative ? `${relative}/${name}` : name
      if (
        (applyExclusions && excluded(root.key, candidate)) ||
        (skipBackupControl && root.key === 'data' && candidate === 'backups')
      )
        continue
      relativePath.parse(candidate)
      const filename = path.join(root.target, candidate)
      const info = await lstat(filename)
      identities.set(`${root.key}/${candidate}`, statIdentity(info))
      const common = { root: root.key, path: candidate, mode: info.mode & 0o777, size: info.size }
      if (info.isSymbolicLink()) entries.push({ ...common, kind: 'symlink', link: await readlink(filename) })
      else if (info.isDirectory()) {
        entries.push({ ...common, size: 0, kind: 'directory' })
        await walk(root, candidate)
      } else if (info.isFile()) {
        const sqlite = root.key === 'data' && /^(core|sessions)\.sqlite$/u.test(candidate)
        entries.push({ ...common, kind: 'file', ...(sqlite ? { sqlite: true } : {}) })
        if (sqlite && applyExclusions) {
          const wal = `${filename}-wal`
          const walInfo = await lstat(wal).catch((error: unknown) => {
            if (errorCode(error) === 'ENOENT') return undefined
            throw error
          })
          if (walInfo?.isSymbolicLink()) throw new Error('SQLite WAL 不能是符号链接。')
          identities.set(`${root.key}/${candidate}-wal`, walInfo && walInfo.size > 0 ? statIdentity(walInfo) : 'empty')
          sqliteWalBytes += walInfo?.size ?? 0
        }
      } else if (!(applyExclusions && info.isSocket()))
        throw new Error(`恢复点不支持特殊文件：${root.key}/${candidate}`)
    }
    const after = await lstat(directory)
    if (parentBefore.dev !== after.dev || parentBefore.ino !== after.ino) throw new Error('备份期间目录发生变化。')
  }
  for (const root of roots) await walk(root)
  return { entries, identities, sqliteWalBytes }
}
const sameInventory = (a: Inventory, b: Inventory): boolean =>
  JSON.stringify([...a.identities].sort()) === JSON.stringify([...b.identities].sort()) &&
  JSON.stringify(a.entries) === JSON.stringify(b.entries)

/** Every owned parent must still be a directory before using a relative manifest path. */
const safeEntryPath = async (base: string, relative: string): Promise<string> => {
  relativePath.parse(relative)
  if ((await realDirectory(base)) !== base) throw new Error('恢复点根目录身份发生变化。')
  let current = base
  for (const name of relative.split('/').slice(0, -1)) {
    current = path.join(current, name)
    if ((await realDirectory(current)) !== current) throw new Error('恢复点目录结构无效。')
  }
  return path.join(base, relative)
}
const copyFileVerified = async (
  source: string,
  target: string,
  options: {
    expectedIdentity?: string
    expectedHash?: string
    signal?: AbortSignal
    mode?: number
    onBytes?: (count: number) => void
  } = {},
): Promise<{ size: number; sha256: string }> => {
  options.signal?.throwIfAborted()
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await input.stat()
    if (
      !before.isFile() ||
      (options.expectedIdentity !== undefined && statIdentity(before) !== options.expectedIdentity)
    )
      throw new Error('备份期间源文件发生变化，请停止写入后重试。')
    const output = await open(target, 'wx', 0o600)
    const hash = createHash('sha256')
    let size = 0
    try {
      for await (const chunk of input.createReadStream({ autoClose: false })) {
        options.signal?.throwIfAborted()
        if (!Buffer.isBuffer(chunk)) throw new Error('备份数据流格式无效。')
        await output.writeFile(chunk)
        hash.update(chunk)
        size += chunk.length
        options.onBytes?.(chunk.length)
      }
      if (
        statIdentity(before) !== statIdentity(await input.stat()) ||
        statIdentity(before) !== statIdentity(await lstat(source))
      )
        throw new Error('备份期间源文件发生变化，请停止写入后重试。')
      const sha256 = hash.digest('hex')
      if (options.expectedHash !== undefined && options.expectedHash !== sha256) throw new Error('恢复文件校验失败。')
      await output.chmod(options.mode ?? 0o600)
      await output.sync()
      return { size, sha256 }
    } finally {
      await output.close()
    }
  } finally {
    await input.close()
  }
}
const requireSpace = async (directory: string, bytes: number): Promise<void> => {
  const filesystem = await statfs(directory, { bigint: true })
  const required = BigInt(Math.ceil(bytes * 1.1)) + 16n * 1024n * 1024n
  if (filesystem.bavail * filesystem.bsize < required) throw new Error('磁盘空间不足，未修改原始数据。')
}
const syncTreeDirectories = async (root: string): Promise<void> => {
  for (const name of await readdir(root)) {
    const child = path.join(root, name)
    if ((await lstat(child)).isDirectory()) await syncTreeDirectories(child)
  }
  await syncUpgradeDirectory(root)
}
const readCheckedJson = async (filename: string): Promise<unknown> => {
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.nlink !== 1) throw new Error('升级状态文件路径冲突。')
    return JSON.parse(await handle.readFile('utf8'))
  } finally {
    await handle.close()
  }
}

const verifyEntries = async (
  roots: readonly BackupRoot[],
  entries: readonly BackupEntry[],
  backupStorage: boolean,
  skipBackupControl = false,
): Promise<void> => {
  const found = await inventory(roots, false, skipBackupControl)
  const actual = new Map(found.entries.map((entry) => [`${entry.root}/${entry.path}`, entry]))
  if (actual.size !== entries.length) throw new Error('恢复点文件清单校验失败：存在缺失或额外文件。')
  const directories = new Set<string>()
  const seen = new Set<string>()
  for (const entry of entries) {
    const key = `${entry.root}/${entry.path}`
    if (seen.has(key)) throw new Error('恢复点文件身份重复。')
    seen.add(key)
    const root = roots.find((item) => item.key === entry.root)
    if (!root || (entry.path.includes('/') && !directories.has(`${entry.root}/${path.posix.dirname(entry.path)}`)))
      throw new Error('恢复点父目录清单无效。')
    const current = actual.get(key)
    if (!current || current.kind !== entry.kind) throw new Error('恢复点目录校验失败或文件类型冲突。')
    const filename = await safeEntryPath(root.target, entry.path)
    if (!backupStorage && current.mode !== entry.mode && entry.kind !== 'symlink')
      throw new Error('恢复点权限校验失败。')
    if (entry.kind === 'directory') directories.add(key)
    else if (entry.kind === 'symlink') {
      if (entry.link === undefined || current.link !== entry.link) throw new Error('恢复点链接校验失败。')
    } else {
      if (
        current.size !== entry.size ||
        (await lstat(filename)).nlink !== 1 ||
        (await fileDigest(filename)) !== entry.sha256
      )
        throw new Error('恢复点内容校验失败。')
      if (entry.sqlite) verifySqliteSnapshot(filename)
    }
  }
}

export async function verifyUpgradeBackup(directory: string): Promise<UpgradeBackupManifest> {
  directory = await realDirectory(directory)
  const manifestPath = path.join(directory, 'manifest.json')
  const checksum = z
    .object({ sha256: hashSchema })
    .strict()
    .parse(await readCheckedJson(path.join(directory, 'manifest.sha256')))
  if ((await fileDigest(manifestPath)) !== checksum.sha256) throw new Error('恢复点清单校验失败。')
  const manifest = UpgradeBackupManifestSchema.parse(await readCheckedJson(manifestPath))
  const keys = new Set<string>()
  for (const root of manifest.roots) {
    if (keys.has(root.key) || !path.isAbsolute(root.target) || path.resolve(root.target) !== root.target)
      throw new Error('恢复点根目录身份无效。')
    keys.add(root.key)
  }
  if (!keys.has('data') || manifest.entries.some((entry) => excluded(entry.root, entry.path)))
    throw new Error('恢复点包含受保护或未知路径。')
  await realDirectory(path.join(directory, 'roots'))
  if (JSON.stringify((await readdir(path.join(directory, 'roots'))).sort()) !== JSON.stringify([...keys].sort()))
    throw new Error('恢复点根目录清单校验失败。')
  const stored = manifest.roots.map((root) => ({ ...root, target: path.join(directory, 'roots', root.key) }))
  await verifyEntries(stored, manifest.entries, true)
  return manifest
}

/** Caller holds the data-root lease before any storage or extension owner is activated. */
export async function createUpgradeBackup(options: UpgradeBackupOptions): Promise<UpgradeBackupManifest> {
  options.signal?.throwIfAborted()
  const backupRoot = await prepareUpgradeBackupDirectory(options.dataRoot)
  const roots = await rootsFor(options)
  let backupId = `runtime-${digest(JSON.stringify([options.migrationId ?? options.releaseId, options.runtimeFingerprint, roots])).slice(0, 32)}`
  const assertIdentity = (existing: UpgradeBackupManifest): void => {
    if (
      existing.backupId !== backupId ||
      existing.runtimeFingerprint !== options.runtimeFingerprint ||
      !sameRoots(existing.roots, roots) ||
      existing.migrationId !== options.migrationId ||
      (options.migrationId === undefined && existing.releaseId !== options.releaseId)
    )
      throw new Error('恢复点身份与本次升级不匹配。')
  }
  // A completed rollback ends this point's reuse lifetime. Follow immutable restore IDs
  // so reinstalling the same release captures data written by the old program afterwards.
  while (true) {
    options.signal?.throwIfAborted()
    const directory = path.join(backupRoot, backupId)
    const journalPath = path.join(backupRoot, `restore-${backupId}.json`)
    if (await exists(journalPath)) {
      const journal = restoreJournalSchema.parse(await readCheckedJson(journalPath))
      if (journal.backupId !== backupId || !sameRoots(journal.roots, roots))
        throw new Error('恢复 journal 身份不匹配，不能复用恢复点。')
      if (journal.phase !== 'complete') throw new Error('恢复尚未完成，请先完成恢复后再升级。')
      await realDirectory(directory)
      const manifestPath = path.join(directory, 'manifest.json')
      // Only prior manifests are needed to traverse generations; no live-data or old payload scan.
      if (journal.manifestSha256 !== (await fileDigest(manifestPath)))
        throw new Error('恢复 journal 与恢复点清单不匹配。')
      assertIdentity(UpgradeBackupManifestSchema.parse(await readCheckedJson(manifestPath)))
      backupId = `runtime-${digest(JSON.stringify(['after-restore', backupId, journal.restoreId])).slice(0, 32)}`
      continue
    }
    if (!(await exists(directory))) break
    const existing = await verifyUpgradeBackup(directory)
    assertIdentity(existing)
    return existing
  }
  const destination = path.join(backupRoot, backupId)
  const initial = await inventory(roots, true)
  const entries = initial.entries.map((entry) => ({ ...entry }))
  const total =
    entries.filter(({ kind }) => kind === 'file').reduce((sum, entry) => sum + entry.size, 0) + initial.sqliteWalBytes
  await requireSpace(backupRoot, total)
  const staging = `${destination}.staging-${randomUUID()}`
  await mkdir(staging, { mode: 0o700 })
  let completed = 0
  try {
    for (const root of roots) await mkdir(path.join(staging, 'roots', root.key), { recursive: true, mode: 0o700 })
    for (const entry of entries) {
      options.signal?.throwIfAborted()
      const root = roots.find(({ key }) => key === entry.root)!
      const source = await safeEntryPath(root.target, entry.path)
      const target = path.join(staging, 'roots', entry.root, entry.path)
      if (entry.kind === 'directory') {
        await mkdir(target, { mode: 0o700 })
        continue
      }
      if (entry.kind === 'symlink') {
        await symlink(entry.link!, target)
        continue
      }
      if (entry.sqlite) {
        const before = await lstat(source)
        if (
          statIdentity(before) !== initial.identities.get(`${entry.root}/${entry.path}`) ||
          !before.isFile() ||
          before.isSymbolicLink()
        )
          throw new Error('SQLite 源文件在备份前发生变化。')
        await createSqliteFileSnapshot(source, target)
        const handle = await open(target, 'r+')
        try {
          await handle.chmod(0o600)
          await handle.sync()
        } finally {
          await handle.close()
        }
        verifySqliteSnapshot(target)
        entry.size = (await lstat(target)).size
        entry.sha256 = await fileDigest(target)
        completed += entry.size
        options.onProgress?.(Math.min(completed, total), total)
      } else {
        Object.assign(
          entry,
          await copyFileVerified(source, target, {
            expectedIdentity: initial.identities.get(`${entry.root}/${entry.path}`)!,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            onBytes: (count) => {
              completed += count
              options.onProgress?.(Math.min(completed, total), total)
            },
          }),
        )
      }
    }
    const finalInventory = await inventory(roots, true)
    if (!sameInventory(initial, finalInventory)) {
      throw new Error('备份期间源文件或目录发生变化，请停止写入后重试。')
    }
    const manifest: UpgradeBackupManifest = {
      format: 'nxt.full-upgrade-backup',
      version: 1,
      backupId,
      releaseId: options.releaseId,
      runtimeFingerprint: options.runtimeFingerprint,
      createdAt: Date.now(),
      roots,
      entries,
      ...(options.sourceRuntimeFingerprint === undefined
        ? {}
        : { sourceRuntimeFingerprint: options.sourceRuntimeFingerprint }),
      ...(options.migrationId === undefined ? {} : { migrationId: options.migrationId }),
      excluded: [...EXCLUDED, 'SQLite WAL/SHM (included through SQLite backup)', 'Unix sockets'],
    }
    await writeUpgradeJson(path.join(staging, 'manifest.json'), manifest)
    await writeUpgradeJson(path.join(staging, 'manifest.sha256'), {
      sha256: await fileDigest(path.join(staging, 'manifest.json')),
    })
    await verifyUpgradeBackup(staging)
    await syncTreeDirectories(staging)
    options.signal?.throwIfAborted()
    if (await exists(destination)) throw new Error('恢复点发布路径冲突。')
    await rename(staging, destination)
    await syncUpgradeDirectory(backupRoot)
    options.onProgress?.(total, total)
    return manifest
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

const moveSchema = z.object({ root: z.string(), name: basename, sha256: hashSchema }).strict()
const restoreJournalSchema = z
  .object({
    format: z.literal('nxt.upgrade-restore'),
    version: z.literal(2),
    backupId: backupIdSchema,
    restoreId: z.string().uuid(),
    manifestSha256: hashSchema,
    roots: z.array(rootSchema),
    phase: z.enum(['preparing', 'displacing', 'restoring', 'complete']),
    moves: z.array(moveSchema),
  })
  .strict()
type RestoreJournal = z.infer<typeof restoreJournalSchema>
const ownerSchema = z.object({ restoreId: z.string().uuid(), backupId: backupIdSchema, root: z.string() }).strict()
const subtreeDigest = async (filename: string): Promise<string> => {
  const info = await lstat(filename)
  if (info.isSymbolicLink()) return digest(JSON.stringify(['symlink', await readlink(filename)]))
  if (info.isFile()) return digest(JSON.stringify(['file', info.mode & 0o777, info.size, await fileDigest(filename)]))
  if (!info.isDirectory()) throw new Error('恢复现场包含不支持的特殊文件。')
  const children: Array<[string, string]> = []
  for (const name of (await readdir(filename)).sort())
    children.push([name, await subtreeDigest(path.join(filename, name))])
  const after = await lstat(filename)
  if (statIdentity(info) !== statIdentity(after)) throw new Error('恢复现场在校验期间发生变化。')
  return digest(JSON.stringify(['directory', info.mode & 0o777, children]))
}

const expectedSubtreeDigests = (entries: readonly BackupEntry[]): Map<string, string> => {
  const hashes = new Map<string, string>()
  const children = new Map<string, Array<[string, string]>>()
  // Verified manifests are parent-before-child. One reverse pass avoids quadratic scans of large workspaces.
  for (const entry of [...entries].reverse()) {
    const key = `${entry.root}/${entry.path}`
    const sha256 =
      entry.kind === 'file'
        ? digest(JSON.stringify(['file', entry.mode, entry.size, entry.sha256]))
        : entry.kind === 'symlink'
          ? digest(JSON.stringify(['symlink', entry.link]))
          : digest(
              JSON.stringify([
                'directory',
                entry.mode,
                (children.get(key) ?? []).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
              ]),
            )
    hashes.set(key, sha256)
    const parent = `${entry.root}/${path.posix.dirname(entry.path)}`
    const siblings = children.get(parent) ?? []
    siblings.push([path.posix.basename(entry.path), sha256])
    children.set(parent, siblings)
  }
  return hashes
}
const workDirectory = (backupRoot: string, root: BackupRoot, backupId: string): string =>
  root.key === 'data' ? path.join(backupRoot, `restore-stage-${backupId}`) : `${root.target}.nxt-restore-${backupId}`
const failureDirectory = (backupRoot: string, root: BackupRoot, backupId: string): string =>
  root.key === 'data' ? path.join(backupRoot, `before-restore-${backupId}`) : `${root.target}.nxt-before-${backupId}`
const initializeOwnedDirectory = async (directory: string, identity: z.infer<typeof ownerSchema>): Promise<void> => {
  if (!(await exists(directory))) {
    await mkdir(directory, { mode: 0o700 })
    await syncUpgradeDirectory(path.dirname(directory))
  }
  if ((await realDirectory(directory)) !== directory) throw new Error('恢复工作目录路径冲突。')
  const marker = path.join(directory, 'owner.json')
  if (await exists(marker)) {
    if (JSON.stringify(ownerSchema.parse(await readCheckedJson(marker))) !== JSON.stringify(identity))
      throw new Error('恢复工作目录属于另一次操作。')
  } else {
    for (const name of await readdir(directory)) {
      if (!/^owner\.json\.[a-f0-9-]{36}\.tmp$/u.test(name))
        throw new Error('恢复工作目录存在未识别的现场，已保留并停止。')
      await rm(path.join(directory, name))
    }
    await writeUpgradeJson(marker, identity)
  }
}
const renamePreserving = async (source: string, target: string): Promise<void> => {
  await realDirectory(path.dirname(source))
  await realDirectory(path.dirname(target))
  if (await exists(target)) throw new Error('恢复现场存在重名文件，已保留两份数据并停止。')
  await rename(source, target)
  await syncUpgradeDirectory(path.dirname(source))
  await syncUpgradeDirectory(path.dirname(target))
}

export interface RestoreUpgradeBackupOptions extends Pick<
  UpgradeBackupOptions,
  'dataRoot' | 'externalRoots' | 'signal'
> {
  readonly backupId: string
  /** Configured allowlist parent, for retries after Core has already been displaced. */
  readonly externalWorkspaceRoot?: string
  /** Safe phase checkpoints; useful for host progress and deterministic interruption tests. */
  readonly onCheckpoint?: (step: string) => void | Promise<void>
}
/** Offline only; caller owns the data-root lease and exits after success. */
export async function restoreUpgradeBackup(options: RestoreUpgradeBackupOptions): Promise<UpgradeBackupManifest> {
  options.signal?.throwIfAborted()
  const backupId = backupIdSchema.parse(options.backupId)
  const backupRoot = await prepareUpgradeBackupDirectory(options.dataRoot)
  const directory = path.join(backupRoot, backupId)
  const manifest = await verifyUpgradeBackup(directory)
  if (manifest.backupId !== backupId) throw new Error('恢复点身份与路径不匹配。')
  let externalRoots = options.externalRoots
  if (externalRoots === undefined && options.externalWorkspaceRoot !== undefined) {
    const allowed = await realDirectory(path.resolve(options.externalWorkspaceRoot))
    externalRoots = manifest.roots.filter((root) => root.key !== 'data')
    if (externalRoots.some((root) => path.dirname(root.target) !== allowed))
      throw new Error('恢复点外置工作区不在配置的直属子目录中。')
  }
  const roots = await rootsFor({
    dataRoot: options.dataRoot,
    ...(externalRoots === undefined ? {} : { externalRoots }),
  })
  if (!sameRoots(manifest.roots, roots)) throw new Error('恢复目标与原始根目录不匹配。')
  const journalPath = path.join(backupRoot, `restore-${backupId}.json`)
  const manifestSha256 = await fileDigest(path.join(directory, 'manifest.json'))
  const subtreeHashes = expectedSubtreeDigests(manifest.entries)
  let journal: RestoreJournal
  if (await exists(journalPath)) {
    journal = restoreJournalSchema.parse(await readCheckedJson(journalPath))
    if (journal.backupId !== backupId || journal.manifestSha256 !== manifestSha256 || !sameRoots(journal.roots, roots))
      throw new Error('恢复 journal 身份不匹配。')
    if (journal.phase === 'complete') throw new Error('该恢复已完成；请启动匹配的旧程序，不要重复覆盖当前数据。')
  } else {
    const moves: RestoreJournal['moves'] = []
    for (const root of roots) {
      for (const reserved of [
        workDirectory(backupRoot, root, backupId),
        failureDirectory(backupRoot, root, backupId),
      ]) {
        if (
          (await exists(reserved)) ||
          roots.some(
            (other) => isWithin(reserved, other.target) || (isWithin(other.target, reserved) && other.key !== 'data'),
          )
        )
          throw new Error('恢复工作目录与现有路径冲突。')
      }
      for (const name of (await readdir(root.target)).sort()) {
        if (root.key === 'data' && name === 'backups') continue
        basename.parse(name)
        moves.push({ root: root.key, name, sha256: await subtreeDigest(path.join(root.target, name)) })
      }
    }
    journal = {
      format: 'nxt.upgrade-restore',
      version: 2,
      backupId,
      restoreId: randomUUID(),
      manifestSha256,
      roots,
      phase: 'preparing',
      moves,
    }
    await writeUpgradeJson(journalPath, journal)
  }
  const checkpoint = async (name: string): Promise<void> => {
    await options.onCheckpoint?.(name)
    options.signal?.throwIfAborted()
  }
  const moveNames = new Set<string>()
  for (const move of journal.moves) {
    const key = `${move.root}/${move.name}`
    if (
      !roots.some((root) => root.key === move.root) ||
      moveNames.has(key) ||
      (move.root === 'data' && move.name === 'backups')
    )
      throw new Error('恢复 journal 路径无效。')
    moveNames.add(key)
  }
  for (const root of roots) {
    const identity = { restoreId: journal.restoreId, backupId, root: root.key }
    await initializeOwnedDirectory(workDirectory(backupRoot, root, backupId), identity)
    await initializeOwnedDirectory(failureDirectory(backupRoot, root, backupId), identity)
    await mkdir(path.join(failureDirectory(backupRoot, root, backupId), root.key), { recursive: true, mode: 0o700 })
    await realDirectory(path.join(failureDirectory(backupRoot, root, backupId), root.key))
  }
  const stagedRoots = roots.map((root) => ({
    ...root,
    target: path.join(workDirectory(backupRoot, root, backupId), 'tree'),
  }))
  const verifyFailedGeneration = async (): Promise<void> => {
    for (const root of roots) {
      const previous = path.join(failureDirectory(backupRoot, root, backupId), root.key)
      await realDirectory(previous)
      const moves = journal.moves.filter((move) => move.root === root.key)
      if (JSON.stringify((await readdir(previous)).sort()) !== JSON.stringify(moves.map((move) => move.name).sort()))
        throw new Error('已保留的失败现场清单校验失败。')
      for (const move of moves) {
        if ((await subtreeDigest(path.join(previous, move.name))) !== move.sha256)
          throw new Error('已保留的失败现场校验失败。')
      }
    }
  }
  if (journal.phase === 'preparing') {
    // Sum all roots on the same filesystem before copying anything or moving live data.
    for (const root of stagedRoots) {
      await mkdir(root.target, { recursive: true, mode: 0o700 })
      if ((await realDirectory(root.target)) !== root.target) throw new Error('恢复暂存目录身份发生变化。')
    }
    const space = new Map<number, { target: string; bytes: number }>()
    for (const root of roots) {
      const dev = (await lstat(root.target)).dev
      const previous = space.get(dev) ?? { target: root.target, bytes: 0 }
      for (const entry of manifest.entries.filter((item) => item.root === root.key && item.kind === 'file')) {
        const work = workDirectory(backupRoot, root, backupId)
        await rm(path.join(work, `copy-${digest(entry.path)}.tmp`), { force: true })
        const staged = await safeEntryPath(path.join(work, 'tree'), entry.path).catch((error: unknown) => {
          if (errorCode(error) === 'ENOENT') return undefined
          throw error
        })
        const info =
          staged === undefined
            ? undefined
            : await lstat(staged).catch((error: unknown) => {
                if (errorCode(error) === 'ENOENT') return undefined
                throw error
              })
        if (info === undefined) previous.bytes += entry.size
        else if (
          staged === undefined ||
          !info.isFile() ||
          info.isSymbolicLink() ||
          info.size !== entry.size ||
          (await fileDigest(staged)) !== entry.sha256
        )
          throw new Error('恢复暂存文件冲突，已保留现场。')
      }
      space.set(dev, previous)
    }
    for (const group of space.values()) await requireSpace(group.target, group.bytes)
    for (const entry of manifest.entries) {
      options.signal?.throwIfAborted()
      const root = stagedRoots.find((item) => item.key === entry.root)!
      const target = await safeEntryPath(root.target, entry.path)
      if (await exists(target)) {
        const info = await lstat(target)
        if (
          entry.kind === 'directory'
            ? !info.isDirectory() || info.isSymbolicLink()
            : entry.kind === 'symlink'
              ? !info.isSymbolicLink() || (await readlink(target)) !== entry.link
              : !info.isFile() ||
                info.isSymbolicLink() ||
                info.size !== entry.size ||
                (await fileDigest(target)) !== entry.sha256
        )
          throw new Error('恢复暂存文件冲突，已保留现场。')
        continue
      }
      if (entry.kind === 'directory') await mkdir(target, { mode: 0o700 })
      else if (entry.kind === 'symlink') await symlink(entry.link!, target)
      else {
        const temporary = path.join(
          workDirectory(
            backupRoot,
            roots.find((item) => item.key === entry.root)!,
            backupId,
          ),
          `copy-${digest(entry.path)}.tmp`,
        )
        // Only this restore's owned scratch file may be discarded; target and failed generations never are.
        await rm(temporary, { force: true })
        const source = await safeEntryPath(path.join(directory, 'roots', entry.root), entry.path)
        await copyFileVerified(source, temporary, {
          expectedHash: entry.sha256!,
          mode: entry.mode,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        })
        await renamePreserving(temporary, target)
      }
      await checkpoint(`stage:${entry.root}/${entry.path}`)
    }
    for (const entry of [...manifest.entries].reverse())
      if (entry.kind === 'directory')
        await chmod(
          await safeEntryPath(stagedRoots.find((root) => root.key === entry.root)!.target, entry.path),
          entry.mode,
        )
    await verifyEntries(stagedRoots, manifest.entries, false)
    for (const root of stagedRoots) await syncTreeDirectories(root.target)
    journal.phase = 'displacing'
    await writeUpgradeJson(journalPath, journal)
    await checkpoint('prepared')
  }
  if (journal.phase === 'displacing') {
    await verifyEntries(stagedRoots, manifest.entries, false)
    for (const root of roots) {
      const previous = path.join(failureDirectory(backupRoot, root, backupId), root.key)
      const planned = journal.moves.filter((move) => move.root === root.key)
      for (const name of [...(await readdir(root.target)), ...(await readdir(previous))]) {
        if (root.key === 'data' && name === 'backups') continue
        if (!planned.some((move) => move.name === name)) throw new Error('恢复期间出现新的现场文件，已保留并停止。')
      }
      for (const move of planned) {
        const source = path.join(root.target, move.name)
        const target = path.join(previous, move.name)
        if (await exists(source)) {
          if (await exists(target)) throw new Error('恢复现场存在重名文件，已保留两份数据并停止。')
          if ((await subtreeDigest(source)) !== move.sha256) throw new Error('恢复前的现场文件发生变化，已停止。')
          await renamePreserving(source, target)
          await checkpoint(`displaced:${root.key}/${move.name}`)
        }
        if (!(await exists(target)) || (await subtreeDigest(target)) !== move.sha256)
          throw new Error('已保留的失败现场校验失败。')
      }
    }
    journal.phase = 'restoring'
    await writeUpgradeJson(journalPath, journal)
    await checkpoint('displaced')
  }
  await verifyFailedGeneration()
  for (const root of roots) {
    const staged = stagedRoots.find((item) => item.key === root.key)!
    const names = manifest.entries
      .filter((entry) => entry.root === root.key && !entry.path.includes('/'))
      .map((entry) => entry.path)
    for (const name of await readdir(root.target))
      if (!(root.key === 'data' && name === 'backups') && !names.includes(name))
        throw new Error('恢复期间目标出现未识别文件，已保留并停止。')
    for (const name of names) {
      const source = path.join(staged.target, name)
      const target = path.join(root.target, name)
      const expected = subtreeHashes.get(`${root.key}/${name}`)
      if (await exists(source)) {
        if ((await subtreeDigest(source)) !== expected) throw new Error('恢复暂存内容校验失败。')
        await renamePreserving(source, target)
      }
      // A crash after rename is resolved by verifying the installed subtree, never overwriting it.
      if (!(await exists(target)) || (await subtreeDigest(target)) !== expected)
        throw new Error('恢复目标校验失败，已保留现场且未覆盖。')
      await checkpoint(`restored:${root.key}/${name}`)
    }
  }
  // Verify the complete installed generation, ignoring only the coordinator's own backups directory.
  await verifyEntries(roots, manifest.entries, false, true)
  await verifyFailedGeneration()
  for (const root of roots) await syncUpgradeDirectory(root.target)
  journal.phase = 'complete'
  await writeUpgradeJson(journalPath, journal)
  await checkpoint('complete')
  return manifest
}
