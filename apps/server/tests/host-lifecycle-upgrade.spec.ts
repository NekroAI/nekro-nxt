import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChannelRuntime } from '@nekro-nxt/channel-runtime'
import { NekroRuntime } from '../src/bootstrap.js'
import { startNekroServer } from '../src/main.js'
import { acquireDataRootLease } from '../src/data-root-lease.js'

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
  it('honors cancellation that arrives at the final activation boundary and releases a quiescent root', async () => {
    const options = await fixture()
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
