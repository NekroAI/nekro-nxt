import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostApiContracts } from '@nekro-nxt/contracts'
import { callHostApi, HostRequestError, workspaceApi } from '../src/host-api-client.js'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('shared Host API transport', () => {
  it('sends a typed request and decodes the response once', async () => {
    const response = { notifications: [], cursor: 0 }
    const decode = vi.fn(() => response)
    const contract = { ...HostApiContracts.listClientNotifications, parseResponse: decode }
    const fetch = vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(response) }))
    vi.stubGlobal('fetch', fetch)
    await expect(callHostApi(contract, {}, undefined)).resolves.toEqual(response)
    expect(decode).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('decodes a download through its binary contract', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    const fetch = vi.fn(() =>
      Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(bytes.buffer) }),
    )
    vi.stubGlobal('fetch', fetch)
    await expect(
      callHostApi(
        HostApiContracts.exportExtensionRevision,
        { extensionId: 'ext_fixture', revisionId: 'xrv_fixture' },
        undefined,
      ),
    ).resolves.toEqual(bytes)
    expect(fetch.mock.calls).toHaveLength(1)
  })

  it('cancels before dispatch without marking a mutation outcome unknown', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const controller = new AbortController()
    controller.abort()
    await expect(
      callHostApi(HostApiContracts.testSystemNotification, {}, undefined, { signal: controller.signal }),
    ).rejects.toMatchObject({ kind: 'aborted', commitState: 'rejected' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not retry a mutation whose response is lost', async () => {
    const fetch = vi.fn(() => Promise.reject(new TypeError('offline')))
    vi.stubGlobal('fetch', fetch)
    await expect(callHostApi(HostApiContracts.testSystemNotification, {}, undefined)).rejects.toMatchObject({
      kind: 'network',
      commitState: 'unknown',
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('aborts timed-out reads and distinguishes them from mutation failures', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, options: RequestInit) =>
          new Promise((_resolve, reject) => {
            options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
          }),
      ),
    )
    const result = callHostApi(HostApiContracts.listClientNotifications, {}, undefined, { timeoutMs: 25 }).catch(
      (cause: unknown) => cause,
    )
    await vi.advanceTimersByTimeAsync(25)
    expect(await result).toBeInstanceOf(HostRequestError)
    expect(await result).toMatchObject({ kind: 'timeout', commitState: 'not-applicable' })
  })
})

describe('workspace read models', () => {
  it('builds activity and pending requests from the shared contracts', async () => {
    const fetch = vi.fn((input: string) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve(
            input.startsWith('/api/activity')
              ? { from: 0, to: 600_000, bucketMs: 300_000, channels: [] }
              : { channelId: 'chn_FIXTURE', items: [] },
          ),
      }),
    )
    vi.stubGlobal('fetch', fetch)
    await expect(workspaceApi.getChannelActivity({ window: '2h', bucket: '5m' })).resolves.toMatchObject({
      bucketMs: 300_000,
    })
    await expect(workspaceApi.getChannelPending('chn_FIXTURE')).resolves.toEqual({
      channelId: 'chn_FIXTURE',
      items: [],
    })
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      '/api/activity?window=2h&bucket=5m',
      '/api/channels/chn_FIXTURE/pending',
    ])
    expect(workspaceApi.agentAvatarUrl('agt_FIXTURE')).toBe('/api/agents/agt_FIXTURE/avatar')
  })
})
