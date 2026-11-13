import type * as FileOperations from 'node:fs/promises'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChannelRuntime } from '@nekro-nxt/channel-runtime'
import { startNekroServer } from '../src/main.js'

const faults = vi.hoisted(() => ({ noSpace: false }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FileOperations>()
  return {
    ...actual,
    statfs: async (filename: string) => {
      const result = await actual.statfs(filename, { bigint: true })
      return faults.noSpace ? { ...result, bavail: 0n } : result
    },
  }
})

const roots: string[] = []
afterEach(async () => {
  faults.noSpace = false
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const fixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'nxt-upgrade-disk-space-'))
  roots.push(root)
  await mkdir(path.join(root, 'web'))
  const distIndex = path.join(root, 'web', 'index.html')
  await writeFile(distIndex, '<div id="root">Synthetic upgrade</div>')
  return { dataRoot: path.join(root, 'data'), distIndex, serveRecovery: true }
}

describe('upgrade stopped by a full disk', () => {
  it('starts normally on the next ordinary start once space is free', async () => {
    const options = { ...(await fixture()), releaseId: 'synthetic-disk-space-release' }

    faults.noSpace = true
    const full = await startNekroServer(options)
    try {
      expect(full.recovery).toBe(true)
      expect((await fetch(`http://127.0.0.1:${full.port}/health/ready`)).status).toBe(503)
      expect(await readFile(path.join(options.dataRoot, 'backups/upgrade-progress.json'), 'utf8')).toContain(
        '磁盘空间不足',
      )
    } finally {
      await full.stop()
    }

    // Still full: the same reason is reported again instead of anything being half done.
    const stillFull = await startNekroServer(options)
    try {
      expect(stillFull.recovery).toBe(true)
    } finally {
      await stillFull.stop()
    }

    faults.noSpace = false
    const freed = await startNekroServer(options)
    try {
      expect(freed.recovery).not.toBe(true)
      expect((await fetch(`http://127.0.0.1:${freed.port}/health/ready`)).status).toBe(200)
    } finally {
      await freed.stop()
    }
  }, 30_000)

  it('still waits for an explicit retry when an earlier upgrade step was left unfinished', async () => {
    const options = { ...(await fixture()), releaseId: 'synthetic-low-space-after-step-failure' }
    const opening = vi.spyOn(ChannelRuntime.prototype, 'openAdmission')
    opening.mockRejectedValueOnce(new Error('synthetic step failure'))
    const failedStep = await startNekroServer(options)
    expect(failedStep.recovery).toBe(true)
    await failedStep.stop()

    // With the restore point of the first start removed, the retry has to take a new one and finds no room for it.
    const backups = path.join(options.dataRoot, 'backups')
    const restorePoints = (await readdir(backups)).filter((name) => name.startsWith('runtime-'))
    expect(restorePoints).toHaveLength(1)
    await rm(path.join(backups, restorePoints[0]!), { recursive: true })
    faults.noSpace = true
    const retriedWhileFull = await startNekroServer({ ...options, retryUpgrade: true })
    expect(retriedWhileFull.recovery).toBe(true)
    await retriedWhileFull.stop()

    faults.noSpace = false
    const calls = opening.mock.calls.length
    const blocked = await startNekroServer(options)
    try {
      expect(blocked.recovery).toBe(true)
      expect(opening.mock.calls).toHaveLength(calls)
    } finally {
      await blocked.stop()
    }
    const retried = await startNekroServer({ ...options, retryUpgrade: true })
    try {
      expect(retried.recovery).not.toBe(true)
    } finally {
      await retried.stop()
    }
  }, 30_000)
})
