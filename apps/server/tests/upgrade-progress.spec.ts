import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type * as BackupOperations from '../src/upgrade-backup.js'
import { createUpgradeProgress, markUpgradeProgressFailure } from '../src/upgrade-progress.js'

const faults = vi.hoisted(() => ({ remaining: 0 }))
vi.mock('../src/upgrade-backup.js', async (importOriginal) => {
  const actual = await importOriginal<typeof BackupOperations>()
  return {
    ...actual,
    writeUpgradeJson: async (filename: string, value: unknown) => {
      if (faults.remaining > 0) {
        faults.remaining -= 1
        throw new Error('synthetic I/O error')
      }
      await actual.writeUpgradeJson(filename, value)
    },
  }
})
const directories: string[] = []
const file = (root: string) => path.join(root, 'backups', 'upgrade-progress.json')
const snapshotSchema = z
  .object({
    releaseId: z.string(),
    runId: z.string(),
    pid: z.number(),
    updatedAt: z.number(),
    status: z
      .object({
        phase: z.string(),
        backupId: z.string().optional(),
        currentStepId: z.string().optional(),
        errorSummary: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough()
const snapshot = async (root: string) => snapshotSchema.parse(JSON.parse(await readFile(file(root), 'utf8')))
const fixture = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nxt-progress-'))
  directories.push(root)
  return root
}
afterEach(async () => {
  faults.remaining = 0
  vi.useRealTimers()
  vi.unstubAllEnvs()
  await Promise.all(directories.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('owned upgrade progress', () => {
  it('publishes the launch identity, serializes heartbeats, and stops writing after close', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)
    vi.stubEnv('NEKRO_UPGRADE_RUN_ID', 'synthetic-launch')
    const root = await fixture()
    const writer = createUpgradeProgress(root, 'synthetic-release')
    await writer.update({ phase: 'backup' })
    writer.progress(8, 16)
    await vi.advanceTimersByTimeAsync(5_000)
    await writer.update({ phase: 'checking', backupId: 'synthetic-backup' })
    expect(await snapshot(root)).toMatchObject({
      releaseId: 'synthetic-release',
      runId: 'synthetic-launch',
      pid: process.pid,
      updatedAt: 105_000,
    })
    await writer.update({ phase: 'ready', backupId: 'synthetic-backup' })
    const closing = writer.close()
    expect(writer.close()).toBe(closing)
    await closing
    const closed = await readFile(file(root), 'utf8')
    writer.progress(16, 16)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await readFile(file(root), 'utf8')).toBe(closed)
    await expect(writer.update({ phase: 'migrating' })).rejects.toThrow('已关闭')
  })

  it('recovers from a failed write instead of permanently poisoning the publication chain', async () => {
    const root = await fixture()
    const writer = createUpgradeProgress(root, 'synthetic-release')
    faults.remaining = 1
    await expect(writer.update({ phase: 'backup' })).rejects.toThrow('synthetic I/O error')
    await writer.update({ phase: 'recovery', errorSummary: 'backup failed' })
    await writer.close()
    expect((await snapshot(root)).status).toMatchObject({ phase: 'recovery', errorSummary: 'backup failed' })
  })

  it('marks post-runtime Web failure while retaining recovery identity and blocks late terminal regression', async () => {
    const root = await fixture()
    const writer = createUpgradeProgress(root, 'synthetic-release')
    await writer.update({ phase: 'ready', backupId: 'synthetic-backup', currentStepId: 'activate' })
    await expect(writer.update({ phase: 'checking' })).rejects.toThrow('终态')
    await writer.close()
    await markUpgradeProgressFailure(root, 'synthetic-release', 'Web failed')
    expect((await snapshot(root)).status).toMatchObject({
      phase: 'recovery',
      backupId: 'synthetic-backup',
      currentStepId: 'activate',
      errorSummary: 'Web failed',
    })
  })

  it.each(['pid', 'releaseId', 'runId'])('does not overwrite another Host with a different %s', async (field) => {
    const root = await fixture()
    const writer = createUpgradeProgress(root, 'synthetic-release')
    await writer.update({ phase: 'ready' })
    await writer.close()
    const other = { ...(await snapshot(root)), [field]: field === 'pid' ? process.pid + 10_000 : 'another-host' }
    await writeFile(file(root), JSON.stringify(other))
    const before = await readFile(file(root), 'utf8')
    await markUpgradeProgressFailure(root, 'synthetic-release', 'late error')
    expect(await readFile(file(root), 'utf8')).toBe(before)
  })

  it('requires writer quiescence before an outer failure and never invents another launch identity', async () => {
    const root = await fixture()
    await markUpgradeProgressFailure(root, 'unstarted-release', 'error')
    await expect(readFile(file(root))).rejects.toMatchObject({ code: 'ENOENT' })
    const writer = createUpgradeProgress(root, 'synthetic-release')
    await writer.update({ phase: 'preflight' })
    await expect(markUpgradeProgressFailure(root, 'synthetic-release', 'error')).rejects.toThrow('先关闭')
    expect(() => createUpgradeProgress(root, 'another-release')).toThrow('已有')
    await writer.close()
  })
})
