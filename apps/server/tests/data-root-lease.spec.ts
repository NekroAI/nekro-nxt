import { fork } from 'node:child_process'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { acquireDataRootLease } from '../src/data-root-lease.js'

const directories: string[] = []
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  await Promise.all(directories.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const fixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'nxt-root-lease-'))
  directories.push(root)
  await mkdir(path.join(root, 'backups'))
  return root
}
const lease = (pid: number, version = 1, host = hostname()) => ({
  format: 'nxt.host-data-root-lease',
  version,
  pid,
  hostname: host,
  token: randomUUID(),
})
const ownerFile = (root: string) => path.join(root, 'backups', 'host.lock')

describe('data-root lifetime lease', () => {
  it('allows one owner across concurrent contenders and idempotent release', async () => {
    const root = await fixture()
    const results = await Promise.allSettled([
      acquireDataRootLease(root),
      acquireDataRootLease(root),
      acquireDataRootLease(root),
    ])
    const owners = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
    expect(owners).toHaveLength(1)
    await Promise.all([owners[0]!(), owners[0]!()])
    const release = await acquireDataRootLease(root)
    await release()
    expect((await readdir(path.join(root, 'backups'))).filter((name) => name.includes('.reclaim'))).toEqual([])
  })

  it('refuses living legacy owners, foreign hosts, and malformed metadata without overwriting', async () => {
    const root = await fixture()
    for (const value of [
      JSON.stringify(lease(process.pid)),
      JSON.stringify(lease(2_000_000_000, 1, 'synthetic-foreign-host')),
      '{broken',
    ]) {
      await writeFile(ownerFile(root), value)
      await expect(acquireDataRootLease(root)).rejects.toThrow()
      expect(await readFile(ownerFile(root), 'utf8')).toBe(value)
    }
  })

  it('archives an obsolete legacy owner and preserves prior stale records', async () => {
    const root = await fixture()
    await writeFile(ownerFile(root), JSON.stringify(lease(2_000_000_000)))
    const release = await acquireDataRootLease(root)
    await release()
    expect(
      (await readdir(path.join(root, 'backups'))).filter((name) => name.startsWith('host.lock.stale-')),
    ).toHaveLength(1)
  })

  it.each([
    { name: 'a changed container hostname', pid: 2_000_000_000, host: 'synthetic-old-container' },
    { name: 'a reused current PID', pid: process.pid, host: hostname() },
  ])('takes over stale v2 metadata with $name only after obtaining the OS lock', async ({ pid, host }) => {
    const root = await fixture()
    const previous = lease(pid, 2, host)
    const previousJson = JSON.stringify(previous)
    await writeFile(ownerFile(root), previousJson)

    const release = await acquireDataRootLease(root)
    try {
      const current: unknown = JSON.parse(await readFile(ownerFile(root), 'utf8'))
      expect(current).toMatchObject({ version: 2, pid: process.pid, hostname: hostname() })
      expect(current).not.toMatchObject({ token: previous.token })
      const archives = (await readdir(path.join(root, 'backups'))).filter((name) =>
        name.startsWith(`host.lock.stale-${previous.token}-`),
      )
      expect(archives).toHaveLength(1)
      expect(await readFile(path.join(root, 'backups', archives[0]!), 'utf8')).toBe(previousJson)
      await expect(acquireDataRootLease(root)).rejects.toThrow('另一个 Host')
    } finally {
      await release()
    }
  })

  it('rejects a substituted owner on release without deleting it', async () => {
    const root = await fixture()
    const release = await acquireDataRootLease(root)
    const replacement = JSON.stringify(lease(process.pid, 2))
    await writeFile(ownerFile(root), replacement)
    await expect(release()).rejects.toThrow('所有权发生变化')
    expect(await readFile(ownerFile(root), 'utf8')).toBe(replacement)
  })

  it('refuses symlinked lock files and directories', async () => {
    const root = await fixture()
    const unmanaged = path.join(root, 'unmanaged.txt')
    await writeFile(unmanaged, 'not a lock')
    await symlink(unmanaged, path.join(root, 'backups', 'host-lease.sqlite'))
    await expect(acquireDataRootLease(root)).rejects.toThrow('路径冲突')
    expect(await readFile(unmanaged, 'utf8')).toBe('not a lock')
  })

  it('releases the native lock on process death and reclaims the stale owner without a reclaim lock', async () => {
    const root = await fixture()
    const require = createRequire(new URL('../../../packages/storage-sqlite/package.json', import.meta.url))
    const sqliteModule = require.resolve('better-sqlite3')
    const script = path.join(root, 'child.cjs')
    await writeFile(
      script,
      `const Sqlite = require(${JSON.stringify(sqliteModule)}); const db = new Sqlite(process.argv[2], {timeout:0}); db.pragma('journal_mode=DELETE'); db.exec('BEGIN EXCLUSIVE'); process.send('locked'); setInterval(()=>{if(!db.inTransaction)process.exit(2)},1000);`,
    )
    const child = fork(script, [path.join(root, 'backups', 'host-lease.sqlite')], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
    cleanups.push(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const exit = once(child, 'exit')
        child.kill()
        await exit
      }
    })
    expect((await once(child, 'message'))[0]).toBe('locked')
    if (child.pid === undefined) throw new Error('fixture child has no PID')
    await writeFile(ownerFile(root), JSON.stringify(lease(child.pid, 2)))
    await expect(acquireDataRootLease(root)).rejects.toThrow('另一个 Host')
    const exit = once(child, 'exit')
    child.kill('SIGKILL')
    await exit
    const release = await acquireDataRootLease(root)
    await release()
    expect(
      (await readdir(path.join(root, 'backups'))).filter((name) => name.startsWith('host.lock.stale-')),
    ).toHaveLength(1)
  })
})
