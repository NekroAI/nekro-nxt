import { mkdtemp, mkdir, readFile, readdir, rm, statfs, writeFile } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { get as httpsGet } from 'node:https'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChannelRuntime } from '@nekro-nxt/channel-runtime'
import { NekroRuntime } from '../src/bootstrap.js'
import { startNekroServer } from '../src/main.js'
import { acquireDataRootLease } from '../src/data-root-lease.js'
import { HostApiContracts } from '@nekro-nxt/contracts'
import type * as UpgradeBackup from '../src/upgrade-backup.js'
import { createUpgradeBackup } from '../src/upgrade-backup.js'

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof FsPromises>()
  return { ...original, statfs: vi.fn(original.statfs) }
})
vi.mock('../src/upgrade-backup.js', async (importOriginal) => {
  const original = await importOriginal<typeof UpgradeBackup>()
  return { ...original, createUpgradeBackup: vi.fn(original.createUpgradeBackup) }
})

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const fixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'nxt-upgrade-lifecycle-'))
  roots.push(root)
  await mkdir(path.join(root, 'web'))
  const distIndex = path.join(root, 'web', 'index.html')
  await writeFile(distIndex, '<div id="root">Synthetic upgrade</div>')
  return { dataRoot: path.join(root, 'data'), distIndex }
}

describe('upgrade startup and teardown boundaries', () => {
  it('serves a read-only recovery state and preserves the failure until an explicit retry succeeds', async () => {
    const options = {
      ...(await fixture()),
      serveRecovery: true,
      releaseId: 'synthetic-recovery-release',
      managementKey: 'synthetic-recovery-management-key-0001',
    }
    const opening = vi.spyOn(ChannelRuntime.prototype, 'openAdmission')
    opening.mockRejectedValueOnce(new Error('synthetic-private-diagnostic'))
    const first = await startNekroServer(options)
    expect(first.recovery).toBe(true)
    expect(first.secure).toBe(true)
    const certificate = await readFile(path.join(options.dataRoot, 'host/tls/server-cert.pem'), 'utf8')
    const origin = `http://127.0.0.1:${first.port}`
    try {
      const secureStatus = await new Promise<number>((resolve, reject) => {
        httpsGet(`https://127.0.0.1:${first.port}/health/ready`, { ca: certificate }, (response) => {
          response.resume()
          response.once('end', () => resolve(response.statusCode ?? 0))
        }).on('error', reject)
      })
      expect(secureStatus).toBe(503)
      expect((await fetch(`${origin}/health/live`)).status).toBe(200)
      const ready = await fetch(`${origin}/health/ready`)
      expect(ready.status).toBe(503)
      expect(await ready.json()).toMatchObject({ status: 'recovery', reason: 'startup-failed' })
      const page = await fetch(origin)
      expect(page.status).toBe(503)
      const body = await page.text()
      expect(body).toContain('启动未完成')
      expect(body).not.toContain('synthetic-private-diagnostic')
      expect((await fetch(`${origin}/api/snapshot`)).status).toBe(503)
      expect((await fetch(`${origin}/api/recovery/retry`, { method: 'POST' })).status).toBe(405)
      await expect(acquireDataRootLease(options.dataRoot)).rejects.toThrow()
    } finally {
      await first.stop()
    }
    const journal = (await readdir(path.join(options.dataRoot, 'backups'))).find(
      (file) => /^upgrade-.*\.json$/u.test(file) && file !== 'upgrade-progress.json',
    )!
    const before = await readFile(path.join(options.dataRoot, 'backups', journal), 'utf8')
    const calls = opening.mock.calls.length
    const blocked = await startNekroServer(options)
    try {
      expect(blocked.recovery).toBe(true)
      expect(await readFile(path.join(options.dataRoot, 'host/tls/server-cert.pem'), 'utf8')).toBe(certificate)
      expect(opening.mock.calls).toHaveLength(calls)
      expect(await readFile(path.join(options.dataRoot, 'backups', journal), 'utf8')).toBe(before)
    } finally {
      await blocked.stop()
    }
    const retried = await startNekroServer({ ...options, retryUpgrade: true })
    try {
      expect(retried.recovery).not.toBe(true)
      expect((await fetch(`http://127.0.0.1:${retried.port}/health/ready`)).status).toBe(200)
      expect((await fetch(`http://127.0.0.1:${retried.port}/api/snapshot`)).status).toBe(401)
    } finally {
      await retried.stop()
    }
  }, 30_000)

  it('tries again by itself after a failure before any migration step, such as a full disk', async () => {
    const options = {
      ...(await fixture()),
      serveRecovery: true,
      releaseId: 'synthetic-disk-full-release',
      managementKey: 'synthetic-recovery-management-key-0002',
    }
    vi.mocked(createUpgradeBackup).mockRejectedValueOnce(new Error('磁盘空间不足，未修改原始数据。'))
    const first = await startNekroServer(options)
    try {
      expect(first.recovery).toBe(true)
    } finally {
      await first.stop()
    }
    // The operator freed space and restarted with the same command.
    const second = await startNekroServer(options)
    try {
      expect(second.recovery).not.toBe(true)
      expect((await fetch(`http://127.0.0.1:${second.port}/health/ready`)).status).toBe(200)
    } finally {
      await second.stop()
    }
  }, 30_000)

  it('with upgrade backups off, a new release still needs 1 GB free before it migrates; a restart does not', async () => {
    const { dataRoot, distIndex } = await fixture()
    const options = {
      dataRoot,
      distIndex,
      serveRecovery: true,
      managementKey: 'synthetic-recovery-management-key-0003',
    }
    const installed = await startNekroServer({ ...options, releaseId: 'synthetic-unbacked-old' })
    await installed.stop()
    vi.stubEnv('NEKRO_UPGRADE_BACKUP', 'off')
    const real = vi.mocked(statfs).getMockImplementation()!
    const nearlyFull = () =>
      vi.mocked(statfs).mockImplementation(async (...args: Parameters<typeof statfs>) => {
        const actual = await real(...args)
        // One free block: far below 1 GB on any filesystem.
        return Object.assign(actual, { bavail: typeof actual.bavail === 'bigint' ? 1n : 1 })
      })
    try {
      nearlyFull()
      const blocked = await startNekroServer({ ...options, releaseId: 'synthetic-unbacked-new' })
      try {
        expect(blocked.recovery).toBe(true)
      } finally {
        await blocked.stop()
      }
      // Space freed: the failure came before any migration step, so a plain restart tries again.
      vi.mocked(statfs).mockImplementation(real)
      const upgraded = await startNekroServer({ ...options, releaseId: 'synthetic-unbacked-new' })
      try {
        expect(upgraded.recovery).not.toBe(true)
      } finally {
        await upgraded.stop()
      }
      nearlyFull()
      const restarted = await startNekroServer({ ...options, releaseId: 'synthetic-unbacked-new' })
      try {
        expect(restarted.recovery).not.toBe(true)
      } finally {
        await restarted.stop()
      }
    } finally {
      vi.mocked(statfs).mockImplementation(real)
      vi.unstubAllEnvs()
    }
  }, 60_000)

  it('keeps auxiliary failures local and marks core failures unready until the snapshot recovers', async () => {
    const options = await fixture()
    const create = NekroRuntime.create.bind(NekroRuntime)
    let runtime: NekroRuntime | undefined
    vi.spyOn(NekroRuntime, 'create').mockImplementation(async (input) => {
      runtime = await create(input)
      return runtime
    })
    const server = await startNekroServer(options)
    if (runtime === undefined) throw new Error('Fixture did not create runtime')
    const active = runtime
    const origin = `http://127.0.0.1:${server.port}`
    try {
      active.core.createAgent({
        displayName: '虚构视觉智能体',
        persona: '',
        model: { provider: 'synthetic', model: 'synthetic' },
      })
      vi.spyOn(active.host, 'getAgentImageDiagnostics').mockRejectedValue(new Error('fixture image diagnostic failure'))
      vi.spyOn(active.host, 'listAvailableLlmModels').mockRejectedValue(new Error('fixture provider failure'))
      vi.spyOn(active.host, 'getWebSearchCapabilityStatus').mockRejectedValue(
        new Error('fixture optional search failure'),
      )
      const response = await fetch(`${origin}/api/snapshot`)
      expect(response.status).toBe(200)
      const snapshot = HostApiContracts.snapshot.parseResponse(await response.json())
      expect(snapshot.agents[0]?.imageDiagnostics?.blockers).toContain('暂时无法读取视觉状态，请稍后重试。')
      expect(snapshot.capabilityAvailability.webSearch.available).toBe(false)
      expect(snapshot.capabilityAvailability.webSearch.unavailableReason).toBe('检索状态暂时不可用，请稍后重试。')
      expect((await fetch(`${origin}/health/ready`)).status).toBe(200)
      const core = vi.spyOn(active.core, 'listConnections').mockImplementation(() => {
        throw new Error('fixture core unavailable')
      })
      expect((await fetch(`${origin}/api/snapshot`)).status).toBe(500)
      expect((await fetch(`${origin}/health/ready`)).status).toBe(503)
      expect((await fetch(`${origin}/health/live`)).status).toBe(200)
      core.mockRestore()
      expect((await fetch(`${origin}/health/ready`)).status).toBe(200)
      expect((await fetch(`${origin}/api/snapshot`)).status).toBe(200)
    } finally {
      await server.stop()
    }
  })

  it('honors cancellation that arrives at the final activation boundary and releases a quiescent root', async () => {
    const options = { ...(await fixture()), serveRecovery: true }
    const cancellation = new AbortController()
    // eslint-disable-next-line @typescript-eslint/unbound-method -- The captured original is always invoked with call(this) below.
    const open = ChannelRuntime.prototype.openAdmission
    vi.spyOn(ChannelRuntime.prototype, 'openAdmission').mockImplementationOnce(async function (this: ChannelRuntime) {
      await open.call(this)
      cancellation.abort(new Error('synthetic final-stage cancellation'))
    })
    await expect(startNekroServer({ ...options, signal: cancellation.signal })).rejects.toThrow(
      'synthetic final-stage cancellation',
    )
    const release = await acquireDataRootLease(options.dataRoot)
    await release()
    const server = await startNekroServer(options)
    await server.stop()
  })

  it('records failures before coordinator creation without exposing them through the recovery page', async () => {
    const options = { ...(await fixture()), serveRecovery: true, releaseId: 'synthetic-early-failure' }
    await mkdir(options.dataRoot, { recursive: true })
    await writeFile(path.join(options.dataRoot, 'workspaces'), 'synthetic conflict')
    const server = await startNekroServer(options)
    try {
      expect(server.recovery).toBe(true)
      expect(await readFile(path.join(options.dataRoot, 'backups/upgrade-progress.json'), 'utf8')).toContain('recovery')
      const response = await fetch(`http://127.0.0.1:${server.port}`)
      expect(await response.text()).not.toContain(options.dataRoot)
    } finally {
      await server.stop()
    }
  })

  it('preserves an earlier cleanup failure across repeated disposal instead of reporting false quiescence', async () => {
    const { dataRoot } = await fixture()
    await mkdir(dataRoot, { recursive: true })
    const runtime = await NekroRuntime.create({
      coreDatabasePath: path.join(dataRoot, 'core.sqlite'),
      sessionDatabasePath: path.join(dataRoot, 'sessions.sqlite'),
      assetRoot: path.join(dataRoot, 'assets'),
      extensionDataRoot: path.join(dataRoot, 'extension-data'),
      extensionCacheRoot: path.join(dataRoot, 'extension-cache'),
    })
    vi.spyOn(runtime.dshPluginInstaller, 'dispose').mockRejectedValueOnce(new Error('synthetic disposal failure'))
    const first = runtime.dispose()
    expect(runtime.dispose()).toBe(first)
    await expect(first).rejects.toThrow('Nekro Runtime disposal failed.')
    await expect(runtime.dispose()).rejects.toThrow('Nekro Runtime disposal failed.')
  })
})
