import { openMigratedCoreDatabase } from '@nekro-nxt/storage-sqlite'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  defaultReleaseId,
  ensureReleaseSqliteBackup,
  parseListenHost,
  parseManagementKey,
  parseReleaseId,
  startNekroServer,
} from '../src/main.js'

const temporaryDirectories: string[] = []

const createTemporaryRoot = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-production-entry-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('Server production entry', () => {
  it('keeps loopback as the default and only accepts the explicit container bind host', () => {
    expect(parseListenHost(undefined)).toBe('127.0.0.1')
    expect(parseListenHost('0.0.0.0')).toBe('0.0.0.0')
    expect(() => parseListenHost('localhost')).toThrow('NEKRO_HOST 无效')
    expect(parseManagementKey(undefined)).toBeUndefined()
    expect(() => parseManagementKey(undefined, true)).toThrow('NEKRO_MANAGEMENT_KEY')
    expect(() => parseManagementKey('short')).toThrow('至少需要 32 个字符')
    expect(parseManagementKey('a'.repeat(32), true)).toBe('a'.repeat(32))
  })

  it('uses the package identity by default and validates an injected release identity', async () => {
    const packageJson: unknown = JSON.parse(
      await readFile(path.resolve(import.meta.dirname, '../../../package.json'), 'utf8'),
    )
    if (
      typeof packageJson !== 'object' ||
      packageJson === null ||
      !('name' in packageJson) ||
      typeof packageJson.name !== 'string' ||
      !('version' in packageJson) ||
      typeof packageJson.version !== 'string'
    ) {
      throw new TypeError('根 package.json 缺少有效名称或版本。')
    }
    expect(defaultReleaseId()).toBe(`@nekro-nxt/server@${packageJson.version}`)
    expect(parseReleaseId(' release-test-2 ')).toBe('release-test-2')
    expect(() => parseReleaseId('   ')).toThrow('NEKRO_RELEASE_ID')
  })

  it('publishes non-sensitive live and ready probes with the immutable release identity', async () => {
    const directory = await createTemporaryRoot()
    const dataRoot = path.join(directory, 'data')
    const distIndex = path.join(directory, 'web', 'index.html')
    await mkdir(path.dirname(distIndex), { recursive: true })
    await writeFile(distIndex, '<div id="root"></div>', 'utf8')

    const handle = await startNekroServer({
      dataRoot,
      distIndex,
      releaseId: 'release-health-test',
    })
    try {
      const origin = `http://127.0.0.1:${handle.port}`
      const live = await fetch(`${origin}/health/live`)
      const ready = await fetch(`${origin}/health/ready`)
      expect(live.status).toBe(200)
      expect(live.headers.get('cache-control')).toBe('no-store')
      await expect(live.json()).resolves.toEqual({ status: 'live', releaseId: 'release-health-test' })
      await expect(ready.json()).resolves.toEqual({ status: 'ready', releaseId: 'release-health-test' })

      const rejected = await fetch(`${origin}/health/ready`, { method: 'POST' })
      expect(rejected.status).toBe(405)
    } finally {
      await handle.stop()
    }
  })

  it('backs up only existing SQLite lanes once per release before opening the runtime', async () => {
    const dataRoot = path.join(await createTemporaryRoot(), 'data')
    await mkdir(dataRoot, { recursive: true })
    const core = await openMigratedCoreDatabase(path.join(dataRoot, 'core.sqlite'))
    core.close()
    const sessions = await openMigratedCoreDatabase(path.join(dataRoot, 'sessions.sqlite'))
    sessions.close()

    const first = await ensureReleaseSqliteBackup(dataRoot, 'release-backup-test')
    expect(first.databases).toEqual(['core', 'sessions'])
    const destination = path.join(dataRoot, 'backups', first.backupId)
    expect((await stat(path.join(destination, 'core.sqlite'))).size).toBeGreaterThan(0)
    expect((await stat(path.join(destination, 'sessions.sqlite'))).size).toBeGreaterThan(0)
    const manifestBefore = await readFile(path.join(destination, 'manifest.json'), 'utf8')

    const second = await ensureReleaseSqliteBackup(dataRoot, 'release-backup-test')
    expect(second).toEqual(first)
    expect(await readFile(path.join(destination, 'manifest.json'), 'utf8')).toBe(manifestBefore)
    expect(JSON.parse(await readFile(path.join(destination, 'release.json'), 'utf8'))).toEqual(first)
  })

  it('ignores an interrupted staging directory and atomically publishes a complete release backup', async () => {
    const dataRoot = path.join(await createTemporaryRoot(), 'data')
    const backupRoot = path.join(dataRoot, 'backups')
    await mkdir(path.join(backupRoot, 'release-interrupted.staging-orphan', 'backup'), { recursive: true })
    await writeFile(
      path.join(backupRoot, 'release-interrupted.staging-orphan', 'backup', 'partial.sqlite'),
      'partial',
      'utf8',
    )

    const result = await ensureReleaseSqliteBackup(dataRoot, 'release-after-interruption')
    const destination = path.join(backupRoot, result.backupId)
    expect(result.databases).toEqual([])
    await expect(stat(destination)).resolves.toMatchObject({})
    expect(JSON.parse(await readFile(path.join(destination, 'release.json'), 'utf8'))).toEqual(result)
  })
})
