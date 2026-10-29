import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { StorageFacts } from '../src/storage-location.ts'

/** A fictional Desktop userData with every kind of entry a move treats differently. */
export const createUserDataFixture = async (): Promise<{ readonly root: string; readonly userData: string }> => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'nxt-data-move-')))
  const userData = path.join(root, 'old', 'NekroNxt Preview')
  const data = path.join(userData, 'data')
  const write = async (relative: string, content: string | Buffer) => {
    const file = path.join(userData, relative)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, content)
  }
  await write('Local State', JSON.stringify({ os_crypt: { encrypted_key: 'ZmljdGlvbmFs' } }))
  await write('instance-profiles.json', JSON.stringify({ selected: 'local' }))
  await write('instance-credentials.json', JSON.stringify({ sealed: 'ZmljdGlvbmFs' }))
  await write('local-host-port.json', JSON.stringify({ port: 49152 }))
  await write('Local Storage/leveldb/000003.log', Buffer.alloc(4096, 7))
  await write('Cache/Cache_Data/data_0', Buffer.alloc(200_000, 1))
  await write('Partitions/remote-1/Code Cache/js/index', 'cache')
  await write('Partitions/remote-1/Cookies', 'cookies')
  await write('SingletonLock', 'host-1')
  await write('data/backups/runtime-a/manifest.json', JSON.stringify({ roots: [{ key: 'data', target: data }] }))
  await write('data/logs/host.log', 'log line')
  await write('data/runtimes/node/bin/node', 'binary')
  await write('data/workspaces/agent-1/notes.md', '# 虚构笔记\n')
  await write('data/assets/a1/content.bin', Buffer.alloc(70_000, 3))
  await write(
    'data/dsh/session-storage.json',
    JSON.stringify({
      formatVersion: 1,
      sessionCompatibilityId: 'jsonl-v4',
      sessionRoot: path.join(data, 'dsh', 'sessions'),
    }),
  )
  await write(
    'data/sessions.sqlite.nekro-nxt-reset-required.json',
    JSON.stringify({
      archivePath: path.join(data, 'dsh', 'session-archives', 'schema17-abc'),
      manifest: { originalPath: path.join(data, 'sessions.sqlite'), sessionRoot: path.join(data, 'dsh', 'sessions') },
    }),
  )
  await write(
    'data/dsh/session-archives/schema17-abc/manifest.json',
    JSON.stringify({
      originalPath: path.join(data, 'sessions.sqlite'),
      sessionRoot: path.join(data, 'dsh', 'sessions'),
      other: '/elsewhere/data',
    }),
  )
  await write('data/dsh/sessions/--example--/s1/events.jsonl', '{"type":"header"}\n')
  await mkdir(path.join(data, 'workspaces', 'agent-1', 'node_modules'), { recursive: true })
  await symlink('../notes.md', path.join(data, 'workspaces', 'agent-1', 'node_modules', 'notes-link'))
  const database = new DatabaseSync(path.join(data, 'core.sqlite'))
  database.exec(
    "CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT); INSERT INTO agents VALUES ('agent-1', '虚构智能体')",
  )
  database.close()
  return { root, userData }
}

export const localStorageFacts = (): StorageFacts => ({
  platform: process.platform,
  env: {},
  homedir: '/nonexistent-home',
  readText: () => Promise.resolve(undefined),
  mounts: () => Promise.resolve([]),
  fileSystemType: () => Promise.resolve(undefined),
  windowsDriveType: () => Promise.resolve('Fixed'),
})

/** The check the server runs for Desktop (`--check-sqlite`), inline so desktop tests need no server process. */
export const checkSqliteIntegrity = (file: string): void => {
  const database = new DatabaseSync(file, { readOnly: true })
  try {
    const rows = database.prepare('PRAGMA integrity_check').all()
    if (rows.length !== 1 || rows[0]?.['integrity_check'] !== 'ok')
      throw new Error(`SQLite integrity_check failed: ${String(rows[0]?.['integrity_check'] ?? 'no result')}`)
  } finally {
    database.close()
  }
}
