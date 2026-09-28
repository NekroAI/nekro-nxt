import { writeFileSync } from 'node:fs'
import type * as FileOperations from 'node:fs/promises'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, readlink, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
    expect(first.entries.some((entry) => entry.path.startsWith('backups'))).toBe(false)
    expect(await createUpgradeBackup(options)).toEqual(first)
    const directory = path.join(options.dataRoot, 'backups', first.backupId)
    expect((await stat(path.join(directory, 'roots/data/dsh/.credentials.yaml'))).mode & 0o777).toBe(0o600)
    await writeFile(path.join(directory, 'roots/data/dsh/.credentials.yaml'), 'corrupt')
    await expect(createUpgradeBackup(options)).rejects.toThrow('校验失败')
    expect(await readFile(path.join(options.dataRoot, 'dsh/.credentials.yaml'), 'utf8')).toBe(
      'synthetic-credential-reference',
    )
  })

  it('preserves symlinks without reading their targets and rejects modified parent links in a backup', async () => {
    const options = await fixture()
    await symlink('/synthetic/unmanaged/target', path.join(options.dataRoot, 'workspaces', 'external-link'))
    const manifest = await createUpgradeBackup(options)
    const directory = path.join(options.dataRoot, 'backups', manifest.backupId)
    expect(await readlink(path.join(directory, 'roots/data/workspaces/external-link'))).toBe(
      '/synthetic/unmanaged/target',
    )
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

  it('backs up committed WAL data and restores symlinks and executable modes', async () => {
    const options = await fixture()
    await writeFile(path.join(options.dataRoot, 'workspaces/synthetic-agent/run.sh'), '#!/bin/sh\nexit 0\n', {
      mode: 0o700,
    })
    await symlink('run.sh', path.join(options.dataRoot, 'workspaces/synthetic-agent/run-link'))
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
    expect((await stat(path.join(options.dataRoot, 'workspaces/synthetic-agent/run.sh'))).mode & 0o777).toBe(0o700)
    expect(await readlink(path.join(options.dataRoot, 'workspaces/synthetic-agent/run-link'))).toBe('run.sh')
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
