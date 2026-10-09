import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, rename, unlink } from 'node:fs/promises'
import { hostname } from 'node:os'
import path from 'node:path'
import { acquireSqliteFileLease } from '@nekro-nxt/storage-sqlite'
import { z } from 'zod'
import { prepareUpgradeBackupDirectory, syncUpgradeDirectory, writeUpgradeJson } from './upgrade-backup.js'

const leaseSchema = z
  .object({
    format: z.literal('nxt.host-data-root-lease'),
    version: z.union([z.literal(1), z.literal(2)]),
    pid: z.number().int().positive(),
    hostname: z.string().min(1),
    token: z.string().uuid(),
  })
  .strict()
const code = (error: unknown): unknown => (error instanceof Error && 'code' in error ? error.code : undefined)
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return code(error) !== 'ESRCH'
  }
}
const readOwner = async (filename: string): Promise<z.infer<typeof leaseSchema> | undefined> => {
  let handle
  try {
    handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
    const info = await handle.stat()
    if (!info.isFile() || info.nlink !== 1) throw new Error('Data root lock path conflict.')
    return leaseSchema.parse(JSON.parse(await handle.readFile('utf8')))
  } catch (error) {
    if (code(error) === 'ENOENT') return undefined
    throw error
  } finally {
    await handle?.close()
  }
}

/** SQLite owns the OS lock, so death releases ownership without a second stale-reclaim lock. */
export async function acquireDataRootLease(dataRoot: string): Promise<() => Promise<void>> {
  const directory = await prepareUpgradeBackupDirectory(dataRoot)
  const databasePath = path.join(directory, 'host-lease.sqlite')
  const databaseInfo = await lstat(databasePath).catch((error: unknown) => {
    if (code(error) === 'ENOENT') return undefined
    throw error
  })
  if (
    databaseInfo !== undefined &&
    (!databaseInfo.isFile() || databaseInfo.isSymbolicLink() || databaseInfo.nlink !== 1)
  )
    throw new Error('Data root lock database path conflict.')
  let unlock: () => void
  try {
    unlock = acquireSqliteFileLease(databasePath)
  } catch (cause) {
    throw new Error('数据目录正被另一个 NekroNXT 使用，请先关闭它。', { cause })
  }
  const filename = path.join(directory, 'host.lock')
  const token = randomUUID()
  try {
    const previous = await readOwner(filename)
    if (previous !== undefined) {
      // v2 ownership is the OS lock already acquired above; container hostnames and PIDs can be reused.
      if (previous.version === 1 && (previous.hostname !== hostname() || alive(previous.pid)))
        throw new Error('数据目录正被另一个 NekroNXT 使用，请先关闭它。')
      // Legacy reclamation had no owner metadata. Never guess that an active old binary has stopped.
      if (
        previous.version === 1 &&
        (await lstat(`${filename}.reclaim`).then(
          () => true,
          (error: unknown) => {
            if (code(error) === 'ENOENT') return false
            throw error
          },
        ))
      )
        throw new Error('旧版数据根锁回收尚未确认结束，请保留 .reclaim 现场并停止旧宿主后处理。')
      await rename(filename, `${filename}.stale-${previous.token}-${randomUUID()}`)
      await syncUpgradeDirectory(directory)
    }
    await writeUpgradeJson(filename, {
      format: 'nxt.host-data-root-lease',
      version: 2,
      pid: process.pid,
      hostname: hostname(),
      token,
    })
  } catch (error) {
    unlock()
    throw error
  }
  let task: Promise<void> | undefined
  return () =>
    (task ??= (async () => {
      try {
        const current = await readOwner(filename)
        if (current?.token !== token || current.version !== 2) throw new Error('Data root lock ownership changed.')
        await unlink(filename)
        await syncUpgradeDirectory(directory)
      } finally {
        unlock()
      }
    })())
}
