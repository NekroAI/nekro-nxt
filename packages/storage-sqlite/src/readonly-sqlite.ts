import { lstatSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

const optionalInfo = (filename: string) => {
  try {
    return lstatSync(filename)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}

/** No new source sidecars. Never use immutable when it would hide committed WAL. */
export function openReadOnlySqlite(filename: string): DatabaseSync {
  const wal = optionalInfo(`${filename}-wal`)
  if (wal !== undefined && (!wal.isFile() || wal.isSymbolicLink()))
    throw new Error('SQLite WAL must be a regular file.')
  const hasWal = wal !== undefined && wal.size > 0
  if (hasWal) {
    const sharedMemory = optionalInfo(`${filename}-shm`)
    if (!sharedMemory?.isFile() || sharedMemory.isSymbolicLink())
      throw new Error(
        'SQLite WAL has no readable shared memory; recover the source database before read-only preflight.',
      )
  }
  const uri = pathToFileURL(filename)
  uri.search = hasWal ? '?mode=ro' : '?mode=ro&immutable=1'
  return new DatabaseSync(uri.href, { readOnly: true })
}
