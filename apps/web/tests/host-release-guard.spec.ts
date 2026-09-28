import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostApiContracts } from '@nekro-nxt/contracts'
import { HostReleaseGuard } from '../src/host-release-guard.js'
import { callHostApi } from '../src/host-api-client.js'

afterEach(() => vi.unstubAllGlobals())
const reply = (body: unknown) => ({ ok: true, status: 200, json: () => Promise.resolve(body) })

describe('same-origin release guard', () => {
  it('rejects an old cached bundle before any mutation is sent and latches until refresh', async () => {
    const guard = new HostReleaseGuard('release-old')
    const fetch = vi.fn<(path: string) => Promise<ReturnType<typeof reply>>>(() =>
      Promise.resolve(reply({ status: 'live', releaseId: 'release-new' })),
    )
    vi.stubGlobal('fetch', fetch)
    await expect(
      callHostApi(HostApiContracts.testSystemNotification, {}, undefined, { releaseGuard: guard }),
    ).rejects.toMatchObject({ kind: 'release-mismatch', commitState: 'rejected' })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]?.[0]).toBe('/health/live')
    guard.observe('release-old')
    expect(guard.getSnapshot().mismatch).toBe(true)
  })

  it('rechecks an existing tab after reconnect, even when no fresh snapshot has arrived', async () => {
    const guard = new HostReleaseGuard()
    guard.observe('release-a')
    guard.reconnect()
    expect(guard.getSnapshot().checking).toBe(true)
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(reply({ releaseId: 'release-b' }))),
    )
    await expect(guard.beforeMutation()).rejects.toThrow('服务已升级')
    expect(guard.getSnapshot()).toMatchObject({ checking: false, mismatch: true })
  })

  it('accepts the current Host and attaches the release identity to the dispatched operation', async () => {
    const guard = new HostReleaseGuard('release-current')
    const fetch = vi.fn<(path: string, options?: RequestInit) => Promise<ReturnType<typeof reply>>>((path) =>
      Promise.resolve(reply(path === '/health/live' ? { releaseId: 'release-current' } : { ok: true })),
    )
    vi.stubGlobal('fetch', fetch)
    const contract = { ...HostApiContracts.testSystemNotification, parseResponse: (value: unknown) => value }
    await expect(callHostApi(contract, {}, undefined, { releaseGuard: guard })).resolves.toEqual({ ok: true })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ headers: { 'x-nekro-client-release': 'release-current' } })
  })

  it('blocks an unverified version without treating the operation as possibly committed', async () => {
    const guard = new HostReleaseGuard('release-current')
    const fetch = vi.fn(() => Promise.reject(new Error('offline')))
    vi.stubGlobal('fetch', fetch)
    await expect(
      callHostApi(HostApiContracts.testSystemNotification, {}, undefined, { releaseGuard: guard }),
    ).rejects.toMatchObject({ kind: 'network', commitState: 'rejected' })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(guard.getSnapshot().mismatch).toBe(false)
  })

  it('does not publish an incompatible snapshot into the existing draft-owning product state', async () => {
    const guard = new HostReleaseGuard('release-a')
    const decode = vi.fn((body: unknown) => body)
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(reply({ productMetadata: { releaseId: 'release-b' } }))),
    )
    await expect(
      callHostApi({ ...HostApiContracts.snapshot, parseResponse: decode }, {}, undefined, { releaseGuard: guard }),
    ).rejects.toMatchObject({ kind: 'release-mismatch' })
    expect(decode).not.toHaveBeenCalled()
  })

  it('keeps different document origins independent, without comparing their releases', () => {
    const local = new HostReleaseGuard('release-local')
    const remote = new HostReleaseGuard('release-remote')
    local.observe('release-local')
    remote.observe('release-remote')
    expect(local.getSnapshot().mismatch).toBe(false)
    expect(remote.getSnapshot().mismatch).toBe(false)
  })
})

it('latches a Host-side release rejection when the version changes after preflight', async () => {
  const guard = new HostReleaseGuard('release-a')
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string) =>
      Promise.resolve(
        path === '/health/live'
          ? reply({ releaseId: 'release-a' })
          : {
              ok: false,
              status: 409,
              json: () => Promise.resolve({ error: { code: 'release-mismatch', message: '刷新页面后重试。' } }),
            },
      ),
    ),
  )
  await expect(
    callHostApi(HostApiContracts.testSystemNotification, {}, undefined, { releaseGuard: guard }),
  ).rejects.toMatchObject({ kind: 'release-mismatch', commitState: 'rejected' })
  expect(guard.getSnapshot().mismatch).toBe(true)
})
