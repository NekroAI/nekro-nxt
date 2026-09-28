import { writeFileSync } from 'node:fs'
import type * as FileOperations from 'node:fs/promises'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, readlink, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  createUpgradeBackup,
  restoreUpgradeBackup,
  verifyUpgradeBackup,
  writeUpgradeJson,
} from '../src/upgrade-backup.js'

const faults = vi.hoisted(() => ({ noSpace: false, failSync: false }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FileOperations>()
  return {
    ...actual,
    statfs: async (filename: string) => {
      const result = await actual.statfs(filename, { bigint: true })
      return faults.noSpace ? { ...result, bavail: 0n } : result
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      if (faults.failSync && String(args[0]).includes('atomic-state.json.')) {
        handle.sync = () => Promise.reject(new Error('synthetic fsync failure'))
      }
      return handle
    },
  }
})

const directories: string[] = []
afterEach(async () => {
  faults.noSpace = false
  faults.failSync = false
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})
const fixture = async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'nxt-upgrade-backup-'))
  directories.push(dataRoot)
  await mkdir(path.join(dataRoot, 'dsh'), { recursive: true })
  await mkdir(path.join(dataRoot, 'dsh', 'pnpm-store'), { recursive: true })
  await writeFile(path.join(dataRoot, 'dsh', 'pnpm-store', 'synthetic-cache'), 'rebuildable package cache')
  await mkdir(path.join(dataRoot, 'workspaces', 'synthetic-agent'), { recursive: true })
  await mkdir(path.join(dataRoot, 'extension-cache'), { recursive: true })
  await writeFile(path.join(dataRoot, 'dsh', '.credentials.yaml'), 'synthetic-credential-reference', { mode: 0o600 })
  await writeFile(path.join(dataRoot, 'workspaces', 'synthetic-agent', 'note.txt'), 'before upgrade')
  await writeFile(path.join(dataRoot, 'extension-cache', 'discard.mjs'), 'disposable')
  const database = new DatabaseSync(path.join(dataRoot, 'core.sqlite'))
  database.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE facts (value TEXT); INSERT INTO facts VALUES ('synthetic-channel-history');",
  )
  database.close()
  return { dataRoot, releaseId: 'synthetic-release', runtimeFingerprint: 'synthetic-runtime' }
}

describe('complete upgrade recovery points', () => {
  it('backs up durable files and SQLite, excludes caches, and reuses only a verified recovery point', async () => {
    const options = await fixture()
    const first = await createUpgradeBackup(options)
    expect(first.entries.map((entry) => entry.path)).toContain('dsh/.credentials.yaml')
    expect(first.entries.some((entry) => entry.path.startsWith('extension-cache'))).toBe(false)
    expect(first.entries.some((entry) => entry.path.startsWith('dsh/pnpm-store'))).toBe(false)
    expect(first.entries.some((entry) => entry.path.startsWith('backups'))).toBe(false)
    expect(await createUpgradeBackup(options)).toEqual(first)
    const directory = path.join(options.dataRoot, 'backups', first.backupId)
    const credentials = path.join(directory, 'roots/data/dsh/.credentials.yaml')
    const credentialsInfo = await stat(credentials)
    expect(credentialsInfo.isFile()).toBe(true)
    expect(credentialsInfo.nlink).toBe(1)
    expect(await readFile(credentials, 'utf8')).toBe('synthetic-credential-reference')
    // Windows inherits the configured data root's ACL; stat.mode cannot prove ACL privacy.
    if (process.platform !== 'win32') {
      expect((await stat(directory)).mode & 0o777).toBe(0o700)
      expect(credentialsInfo.mode & 0o777).toBe(0o600)
    }
    await writeFile(path.join(directory, 'roots/data/dsh/.credentials.yaml'), 'corrupt')
    await expect(createUpgradeBackup(options)).rejects.toThrow('校验失败')
    expect(await readFile(path.join(options.dataRoot, 'dsh/.credentials.yaml'), 'utf8')).toBe(
      'synthetic-credential-reference',
    )
  })

  it('preserves symlinks without reading their targets and rejects modified parent links in a backup', async () => {
    const options = await fixture()
    const sourceLink = path.join(options.dataRoot, 'workspaces', 'external-link')
    await symlink('/synthetic/unmanaged/target', sourceLink)
    const sourceTarget = await readlink(sourceLink)
    const manifest = await createUpgradeBackup(options)
    const directory = path.join(options.dataRoot, 'backups', manifest.backupId)
    expect(await readlink(path.join(directory, 'roots/data/workspaces/external-link'))).toBe(sourceTarget)
    await restoreUpgradeBackup({ dataRoot: options.dataRoot, backupId: manifest.backupId })
    expect(await readlink(sourceLink)).toBe(sourceTarget)
    await rm(path.join(directory, 'roots/data/dsh'), { recursive: true })
    await symlink(path.join(options.dataRoot, 'dsh'), path.join(directory, 'roots/data/dsh'))
    await expect(verifyUpgradeBackup(directory)).rejects.toThrow('校验失败')
  })

  it('restores the old generation offline and preserves the failed generation', async () => {
    const options = await fixture()
    const manifest = await createUpgradeBackup(options)
    await writeFile(path.join(options.dataRoot, 'workspaces/synthetic-agent/note.txt'), 'failed new generation')
    await writeFile(path.join(options.dataRoot, 'new-config.yaml'), 'new-generation-only')
    const database = new DatabaseSync(path.join(options.dataRoot, 'core.sqlite'))
    database.exec("INSERT INTO facts VALUES ('new-fact');")
    database.close()
    await restoreUpgradeBackup({ dataRoot: options.dataRoot, backupId: manifest.backupId })
    expect(await readFile(path.join(options.dataRoot, 'workspaces/synthetic-agent/note.txt'), 'utf8')).toBe(
      'before upgrade',
    )
    const restored = new DatabaseSync(path.join(options.dataRoot, 'core.sqlite'), { readOnly: true })
    expect(
      restored
        .prepare('SELECT value FROM facts')
        .all()
        .map((row) => row['value']),
    ).toEqual(['synthetic-channel-history'])
    restored.close()
    expect(
      await readFile(
        path.join(options.dataRoot, 'backups', `before-restore-${manifest.backupId}`, 'data/new-config.yaml'),
        'utf8',
      ),
    ).toBe('new-generation-only')
    await expect(readFile(path.join(options.dataRoot, 'new-config.yaml'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(restoreUpgradeBackup({ dataRoot: options.dataRoot, backupId: manifest.backupId })).rejects.toThrow(
      '已完成',
    )
  })

  it('cancels before mutation and refuses overlapping external roots', async () => {
    const options = await fixture()
    const abort = new AbortController()
    abort.abort(new Error('synthetic cancellation'))
    await expect(createUpgradeBackup({ ...options, signal: abort.signal })).rejects.toThrow('synthetic cancellation')
    await expect(
      createUpgradeBackup({
        ...options,
        externalRoots: [{ key: 'external', target: path.join(options.dataRoot, 'workspaces') }],
      }),
    ).rejects.toThrow('不得重叠')
    expect(await readFile(path.join(options.dataRoot, 'workspaces/synthetic-agent/note.txt'), 'utf8')).toBe(
      'before upgrade',
    )
  })
})

describe('reinstalling a release after rollback', () => {
  it('captures post-restore data, reuses that new point on restart, and advances again after its restore', async () => {
    const options = await fixture()
    const backupRoot = path.join(options.dataRoot, 'backups')
    const note = path.join(options.dataRoot, 'workspaces/synthetic-agent/note.txt')
    const first = await createUpgradeBackup(options)
    const firstManifest = await readFile(path.join(backupRoot, first.backupId, 'manifest.json'), 'utf8')
    await restoreUpgradeBackup({ dataRoot: options.dataRoot, backupId: first.backupId })
    await writeFile(note, 'data B written by the old program')
    const database = new DatabaseSync(path.join(options.dataRoot, 'core.sqlite'))
    try {
      database.exec("INSERT INTO facts VALUES ('post-restore-fact-B');")
    } finally {
      database.close()
    }

    const second = await createUpgradeBackup(options)
    expect(second.backupId).not.toBe(first.backupId)
    expect(
      await readFile(path.join(backupRoot, second.backupId, 'roots/data/workspaces/synthetic-agent/note.txt'), 'utf8'),
    ).toBe('data B written by the old program')
    await writeFile(note, 'candidate changes after the second backup')
    expect(await createUpgradeBackup(options)).toEqual(second)
    expect(await readFile(path.join(backupRoot, first.backupId, 'manifest.json'), 'utf8')).toBe(firstManifest)
    expect(await verifyUpgradeBackup(path.join(backupRoot, first.backupId))).toEqual(first)

    await restoreUpgradeBackup({ dataRoot: options.dataRoot, backupId: second.backupId })
    expect(await readFile(note, 'utf8')).toBe('data B written by the old program')
    const restored = new DatabaseSync(path.join(options.dataRoot, 'core.sqlite'), { readOnly: true })
    try {
      expect(restored.prepare('SELECT value FROM facts').all()).toContainEqual({ value: 'post-restore-fact-B' })
    } finally {
      restored.close()
    }
    await writeFile(note, 'data C after the second rollback')
    const third = await createUpgradeBackup(options)
    expect([first.backupId, second.backupId]).not.toContain(third.backupId)
    expect(await createUpgradeBackup(options)).toEqual(third)
    expect(
      await readFile(path.join(backupRoot, third.backupId, 'roots/data/workspaces/synthetic-agent/note.txt'), 'utf8'),
    ).toBe('data C after the second rollback')
    expect(await verifyUpgradeBackup(path.join(backupRoot, second.backupId))).toEqual(second)
  })

  it.each(['preparing', 'displacing', 'restoring'])(
    'refuses to reuse or create a point while restore is %s',
    async (phase) => {
      const options = await fixture()
      const first = await createUpgradeBackup(options)
      const stopAt =
        phase === 'preparing' ? 'stage:data/core.sqlite' : phase === 'displacing' ? 'prepared' : 'displaced'
      await expect(
        restoreUpgradeBackup({
          dataRoot: options.dataRoot,
          backupId: first.backupId,
          onCheckpoint: (step) => {
            if (step === stopAt) throw new Error('interrupted rollback')
          },
        }),
      ).rejects.toThrow('interrupted rollback')
      await expect(createUpgradeBackup(options)).rejects.toThrow('恢复尚未完成')
      expect(
        (await readdir(path.join(options.dataRoot, 'backups'))).filter((name) => /^runtime-[a-f0-9]{32}$/u.test(name)),
      ).toEqual([first.backupId])
    },
  )

  it.each([
    { field: 'version', value: 99 },
    { field: 'phase', value: 'unknown' },
    { field: 'backupId', value: `runtime-${'f'.repeat(32)}` },
    { field: 'roots', value: [] },
    { field: 'manifestSha256', value: '0'.repeat(64) },
  ])('refuses unknown or mismatched restore metadata: $field', async ({ field, value }) => {
    const options = await fixture()
    const first = await createUpgradeBackup(options)
    await restoreUpgradeBackup({ dataRoot: options.dataRoot, backupId: first.backupId })
    const journalPath = path.join(options.dataRoot, 'backups', `restore-${first.backupId}.json`)
    const journal = z.record(z.string(), z.unknown()).parse(JSON.parse(await readFile(journalPath, 'utf8')))
    await writeUpgradeJson(journalPath, { ...journal, [field]: value })
    const note = path.join(options.dataRoot, 'workspaces/synthetic-agent/note.txt')
    await writeFile(note, 'post-restore data must remain intact')
    await expect(createUpgradeBackup(options)).rejects.toThrow()
    expect(await readFile(note, 'utf8')).toBe('post-restore data must remain intact')
    expect(
      (await readdir(path.join(options.dataRoot, 'backups'))).filter((name) => /^runtime-[a-f0-9]{32}$/u.test(name)),
    ).toEqual([first.backupId])
  })
})

describe('interrupted restore and independent workspaces', () => {
  it.each(['prepared', 'displaced:data/core.sqlite', 'displaced', 'restored:data/core.sqlite'])(
    'resumes after %s without losing the failed generation',
    async (step) => {
      const options = await fixture()
      const manifest = await createUpgradeBackup(options)
      await writeFile(path.join(options.dataRoot, 'new-config.yaml'), 'failed generation')
      const backupRoot = path.join(options.dataRoot, 'backups')
      await writeFile(path.join(backupRoot, 'host.lock'), 'synthetic-held-lease')
      await expect(
        restoreUpgradeBackup({
          dataRoot: options.dataRoot,
          backupId: manifest.backupId,
          onCheckpoint: (current) => {
            if (current === step) throw new Error('injected interruption')
          },
        }),
      ).rejects.toThrow('injected interruption')
      await restoreUpgradeBackup({ dataRoot: options.dataRoot, backupId: manifest.backupId })
      expect(await readFile(path.join(options.dataRoot, 'workspaces/synthetic-agent/note.txt'), 'utf8')).toBe(
        'before upgrade',
      )
      expect(
        await readFile(path.join(backupRoot, `before-restore-${manifest.backupId}`, 'data/new-config.yaml'), 'utf8'),
      ).toBe('failed generation')
      expect(await readFile(path.join(backupRoot, 'host.lock'), 'utf8')).toBe('synthetic-held-lease')
    },
  )

  it('refuses to overwrite files created after partial installation', async () => {
    const options = await fixture()
    const manifest = await createUpgradeBackup(options)
    await expect(
      restoreUpgradeBackup({
        dataRoot: options.dataRoot,
        backupId: manifest.backupId,
        onCheckpoint: (step) => {
          if (step === 'restored:data/core.sqlite') throw new Error('pause')
        },
      }),
    ).rejects.toThrow('pause')
    await writeFile(path.join(options.dataRoot, 'core.sqlite'), 'independent replacement')
    await expect(restoreUpgradeBackup({ dataRoot: options.dataRoot, backupId: manifest.backupId })).rejects.toThrow(
      '未覆盖',
    )
    expect(await readFile(path.join(options.dataRoot, 'core.sqlite'), 'utf8')).toBe('independent replacement')
  })

  it('refuses changed failed files rather than claiming that they were preserved', async () => {
    const options = await fixture()
    const manifest = await createUpgradeBackup(options)
    await expect(
      restoreUpgradeBackup({
        dataRoot: options.dataRoot,
        backupId: manifest.backupId,
        onCheckpoint: (step) => {
          if (step === 'displaced:data/core.sqlite') throw new Error('pause')
        },
      }),
    ).rejects.toThrow('pause')
    const archived = path.join(options.dataRoot, 'backups', `before-restore-${manifest.backupId}`, 'data/core.sqlite')
    await writeFile(archived, 'modified failed generation')
    await expect(restoreUpgradeBackup({ dataRoot: options.dataRoot, backupId: manifest.backupId })).rejects.toThrow(
      '失败现场校验失败',
    )
    expect(await readFile(archived, 'utf8')).toBe('modified failed generation')
  })

  it('restores an explicit external child after Core displacement without enumerating Core', async () => {
    const options = await fixture()
    const external = await mkdtemp(path.join(tmpdir(), 'nxt-owned-workspaces-'))
    directories.push(external)
    const target = path.join(external, 'synthetic-agent')
    await mkdir(target)
    await writeFile(path.join(target, 'source.ts'), 'old source')
    await writeFile(path.join(external, 'unmanaged.txt'), 'leave alone')
    const manifest = await createUpgradeBackup({ ...options, externalRoots: [{ key: 'workspace-0', target }] })
    await writeFile(path.join(target, 'source.ts'), 'new source')
    await expect(
      restoreUpgradeBackup({
        dataRoot: options.dataRoot,
        backupId: manifest.backupId,
        externalWorkspaceRoot: external,
        onCheckpoint: (step) => {
          if (step === 'displaced') throw new Error('pause')
        },
      }),
    ).rejects.toThrow('pause')
    await restoreUpgradeBackup({
      dataRoot: options.dataRoot,
      backupId: manifest.backupId,
      externalWorkspaceRoot: external,
    })
    expect(await readFile(path.join(target, 'source.ts'), 'utf8')).toBe('old source')
    expect(
      await readFile(path.join(`${target}.nxt-before-${manifest.backupId}`, 'workspace-0/source.ts'), 'utf8'),
    ).toBe('new source')
    expect(await readFile(path.join(external, 'unmanaged.txt'), 'utf8')).toBe('leave alone')
  })

  it('rejects unapproved external roots and preexisting restore work directories before displacement', async () => {
    const options = await fixture()
    const manifest = await createUpgradeBackup(options)
    const conflicting = path.join(options.dataRoot, 'backups', `before-restore-${manifest.backupId}`)
    await mkdir(conflicting)
    await writeFile(path.join(conflicting, 'keep.txt'), 'independent data')
    await expect(restoreUpgradeBackup({ dataRoot: options.dataRoot, backupId: manifest.backupId })).rejects.toThrow(
      '路径冲突',
    )
    expect(await readFile(path.join(conflicting, 'keep.txt'), 'utf8')).toBe('independent data')
    expect(await readFile(path.join(options.dataRoot, 'workspaces/synthetic-agent/note.txt'), 'utf8')).toBe(
      'before upgrade',
    )
  })

  it('fails safely on newly appearing target files after displacement', async () => {
    const options = await fixture()
    const manifest = await createUpgradeBackup(options)
    await expect(
      restoreUpgradeBackup({
        dataRoot: options.dataRoot,
        backupId: manifest.backupId,
        onCheckpoint: (step) => {
          if (step === 'displaced') throw new Error('pause')
        },
      }),
    ).rejects.toThrow('pause')
    await writeFile(path.join(options.dataRoot, 'surprise.txt'), 'another writer')
    await expect(restoreUpgradeBackup({ dataRoot: options.dataRoot, backupId: manifest.backupId })).rejects.toThrow(
      '未识别文件',
    )
    expect(await readFile(path.join(options.dataRoot, 'surprise.txt'), 'utf8')).toBe('another writer')
  })
})

describe('backup validation boundaries', () => {
  it('normalizes parent aliases consistently for create, verify and restore', async () => {
    const options = await fixture()
    const aliasRoot = await mkdtemp(path.join(tmpdir(), 'nxt-parent-alias-'))
    directories.push(aliasRoot)
    const parent = path.join(aliasRoot, 'parent')
    await symlink(path.dirname(options.dataRoot), parent)
    const aliasedDataRoot = path.join(parent, path.basename(options.dataRoot))
    const manifest = await createUpgradeBackup(options)
    expect(await createUpgradeBackup({ ...options, dataRoot: aliasedDataRoot })).toEqual(manifest)
    expect(await verifyUpgradeBackup(path.join(aliasedDataRoot, 'backups', manifest.backupId))).toEqual(manifest)
    await restoreUpgradeBackup({ dataRoot: aliasedDataRoot, backupId: manifest.backupId })
    expect(await readFile(path.join(options.dataRoot, 'workspaces/synthetic-agent/note.txt'), 'utf8')).toBe(
      'before upgrade',
    )
  })

  it('binds the manifest checksum and rejects undeclared files', async () => {
    const options = await fixture()
    const manifest = await createUpgradeBackup(options)
    const directory = path.join(options.dataRoot, 'backups', manifest.backupId)
    await writeFile(path.join(directory, 'roots/data/unlisted.txt'), 'not in manifest')
    await expect(verifyUpgradeBackup(directory)).rejects.toThrow('清单校验失败')
    await rm(path.join(directory, 'roots/data/unlisted.txt'))
    await writeFile(
      path.join(directory, 'manifest.json'),
      JSON.stringify({ ...manifest, runtimeFingerprint: 'tampered' }),
    )
    await expect(verifyUpgradeBackup(directory)).rejects.toThrow('清单校验失败')
  })

  it('reuses a stable migration across product rebuilds while retaining original source metadata', async () => {
    const options = await fixture()
    const first = await createUpgradeBackup({
      ...options,
      migrationId: 'session-jsonl-v4',
      sourceRuntimeFingerprint: 'synthetic-source',
    })
    const second = await createUpgradeBackup({
      ...options,
      releaseId: 'rebuilt-product',
      migrationId: 'session-jsonl-v4',
      sourceRuntimeFingerprint: 'synthetic-source',
    })
    expect(second).toEqual(first)
    expect(second.sourceRuntimeFingerprint).toBe('synthetic-source')
  })

  it('rejects root aliases and control-directory links without reading their targets', async () => {
    const options = await fixture()
    const alias = path.join(options.dataRoot, 'alias')
    await symlink(path.join(options.dataRoot, 'workspaces'), alias)
    await expect(createUpgradeBackup({ ...options, externalRoots: [{ key: 'alias', target: alias }] })).rejects.toThrow(
      '符号链接',
    )
    await rm(alias)
    await rm(path.join(options.dataRoot, 'backups'), { recursive: true })
    const external = await mkdtemp(path.join(tmpdir(), 'nxt-unmanaged-backups-'))
    directories.push(external)
    await symlink(external, path.join(options.dataRoot, 'backups'))
    await expect(createUpgradeBackup(options)).rejects.toThrow('符号链接')
    expect(await readdir(external)).toEqual([])
  })

  it('detects same-sized file replacement and newly added directory contents during backup', async () => {
    const options = await fixture()
    let changed = false
    await expect(
      createUpgradeBackup({
        ...options,
        onProgress: () => {
          if (changed) return
          changed = true
          writeFileSync(path.join(options.dataRoot, 'workspaces/synthetic-agent/note.txt'), 'changed values')
          writeFileSync(path.join(options.dataRoot, 'workspaces/synthetic-agent/added.txt'), 'new')
        },
      }),
    ).rejects.toThrow('发生变化')
    expect(
      (await readdir(path.join(options.dataRoot, 'backups'))).filter((name) => /^runtime-[a-f0-9]{32}$/u.test(name)),
    ).toEqual([])
    expect(await readFile(path.join(options.dataRoot, 'workspaces/synthetic-agent/note.txt'), 'utf8')).toBe(
      'changed values',
    )
  })

  it('backs up committed WAL data and restores symlinks and platform file modes', async () => {
    const options = await fixture()
    const script = path.join(options.dataRoot, 'workspaces/synthetic-agent/run.sh')
    const sourceLink = path.join(options.dataRoot, 'workspaces/synthetic-agent/run-link')
    await writeFile(script, '#!/bin/sh\nexit 0\n', {
      mode: 0o700,
    })
    const sourceMode = (await stat(script)).mode & 0o777
    if (process.platform !== 'win32') expect(sourceMode).toBe(0o700)
    await symlink('run.sh', sourceLink)
    const sourceTarget = await readlink(sourceLink)
    const database = new DatabaseSync(path.join(options.dataRoot, 'core.sqlite'))
    database.exec("PRAGMA wal_autocheckpoint=0; INSERT INTO facts VALUES ('wal-fact');")
    let manifest
    try {
      manifest = await createUpgradeBackup(options)
    } finally {
      database.close()
    }
    await restoreUpgradeBackup({ dataRoot: options.dataRoot, backupId: manifest.backupId })
    const restored = new DatabaseSync(path.join(options.dataRoot, 'core.sqlite'), { readOnly: true })
    try {
      expect(restored.prepare('SELECT value FROM facts').all()).toContainEqual({ value: 'wal-fact' })
    } finally {
      restored.close()
    }
    expect((await stat(script)).mode & 0o777).toBe(sourceMode)
    expect(await readlink(sourceLink)).toBe(sourceTarget)
  })
})

describe('space and durable publication failures', () => {
  it('rejects insufficient backup or restore space without displacing original files', async () => {
    const options = await fixture()
    faults.noSpace = true
    await expect(createUpgradeBackup(options)).rejects.toThrow('磁盘空间不足')
    expect(await readFile(path.join(options.dataRoot, 'workspaces/synthetic-agent/note.txt'), 'utf8')).toBe(
      'before upgrade',
    )
    faults.noSpace = false
    const manifest = await createUpgradeBackup(options)
    await writeFile(path.join(options.dataRoot, 'workspaces/synthetic-agent/note.txt'), 'failed generation')
    faults.noSpace = true
    await expect(restoreUpgradeBackup({ dataRoot: options.dataRoot, backupId: manifest.backupId })).rejects.toThrow(
      '磁盘空间不足',
    )
    expect(await readFile(path.join(options.dataRoot, 'workspaces/synthetic-agent/note.txt'), 'utf8')).toBe(
      'failed generation',
    )
    faults.noSpace = false
    await restoreUpgradeBackup({ dataRoot: options.dataRoot, backupId: manifest.backupId })
    expect(await readFile(path.join(options.dataRoot, 'workspaces/synthetic-agent/note.txt'), 'utf8')).toBe(
      'before upgrade',
    )
  })

  it('does not publish an unflushed JSON file and removes its incomplete temporary', async () => {
    const options = await fixture()
    const target = path.join(options.dataRoot, 'atomic-state.json')
    await writeUpgradeJson(target, { phase: 'old' })
    faults.failSync = true
    await expect(writeUpgradeJson(target, { phase: 'new' })).rejects.toThrow('fsync failure')
    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ phase: 'old' })
    expect((await readdir(options.dataRoot)).filter((name) => name.startsWith('atomic-state.json.'))).toEqual([])
  })

  it('resumes a cancelled file staging operation without touching the live generation', async () => {
    const options = await fixture()
    const manifest = await createUpgradeBackup(options)
    const controller = new AbortController()
    await expect(
      restoreUpgradeBackup({
        dataRoot: options.dataRoot,
        backupId: manifest.backupId,
        signal: controller.signal,
        onCheckpoint: (step) => {
          if (step === 'stage:data/core.sqlite') controller.abort(new Error('safe cancel'))
        },
      }),
    ).rejects.toThrow('safe cancel')
    expect(await readFile(path.join(options.dataRoot, 'workspaces/synthetic-agent/note.txt'), 'utf8')).toBe(
      'before upgrade',
    )
    await restoreUpgradeBackup({ dataRoot: options.dataRoot, backupId: manifest.backupId })
  })
})
