import { describe, expect, it, vi } from 'vitest'
import type { InstanceProfile } from '../src/instance-profiles.ts'
import type { RemoteFetch } from '../src/remote-navigation.ts'
import { probeRemoteProfile, tryRevokeRemoteDevice } from '../src/remote-session.ts'
import { SerialProfileMonitor, type ProfileMonitorTarget } from '../src/serial-profile-monitor.ts'
import { SerialTaskQueue } from '../src/serial-task-queue.ts'

const origin = 'http://remote.example.test:4960'
const profile: InstanceProfile = {
  id: 'remote-1',
  kind: 'remote',
  displayName: '北辰实例',
  origin,
  transport: 'explicit-http-v1',
  observedInstanceId: 'nxt_instance_01H00000000000000000000031',
  credentialRef: 'credential-1',
  partition: 'persist:nxt-instance-remote-1',
  notificationsEnabled: false,
  lastRoute: '/work',
  addedAt: 1,
  lastSelectedAt: 1,
}

class UrlResponse extends Response {
  readonly #url: string

  constructor(url: string, body: BodyInit | null, init?: ResponseInit) {
    super(body, init)
    this.#url = url
  }

  override get url(): string {
    return this.#url
  }
}

const descriptor = {
  format: 'nxt.instance-descriptor',
  descriptorVersion: 1,
  instanceId: profile.observedInstanceId,
  releaseId: 'nxt.test-release',
  productVersion: '0.0.0-test',
  managementProtocol: 2,
  desktopChromeProtocol: 1,
  transport: 'explicit-http-v1',
}

const neverUntilAborted = (signal: AbortSignal | null | undefined): Promise<Response> =>
  new Promise((_resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('测试请求已取消。'))
      return
    }
    signal?.addEventListener(
      'abort',
      () => reject(signal.reason instanceof Error ? signal.reason : new Error('测试请求已取消。')),
      { once: true },
    )
  })

describe('Desktop remote session cancellation', () => {
  it.each(['descriptor', 'management-session'] as const)(
    'times out a hung %s request and lets the serial monitor continue to the next profile',
    async (hungStage) => {
      const targets: readonly ProfileMonitorTarget[] = [
        { id: 'remote-1', kind: 'remote', generation: 1, notificationsEnabled: false, status: 'connecting' },
        { id: 'remote-2', kind: 'remote', generation: 1, notificationsEnabled: false, status: 'connecting' },
      ]
      const fetcher = vi.fn<RemoteFetch>((url, init) => {
        if (url.endsWith('/health/ready')) return Promise.resolve(new UrlResponse(url, '{}', { status: 200 }))
        if (url.endsWith('/.well-known/nekro-nxt') && hungStage === 'descriptor') {
          return neverUntilAborted(init?.signal)
        }
        if (url.endsWith('/.well-known/nekro-nxt')) {
          return Promise.resolve(new UrlResponse(url, JSON.stringify(descriptor), { status: 200 }))
        }
        return neverUntilAborted(init?.signal)
      })
      const commits: string[] = []
      const monitor = new SerialProfileMonitor<void>({
        getTargets: () => targets,
        isCurrent: () => true,
        probeRemote: async (target, signal) => {
          if (target.id === 'remote-2') return 'ready'
          return probeRemoteProfile({
            profile,
            fetcher,
            credential: { deviceId: 'device-1', deviceSecret: 's'.repeat(32) },
            signal,
            requestTimeoutMs: 20,
            probeTimeoutMs: 200,
          })
        },
        statusFromProbeError: () => 'offline',
        commitRemoteStatus: (target, status) => commits.push(`${target.id}:${status}`),
        readNotifications: () => Promise.resolve(),
        commitNotifications: vi.fn(),
        schedule: () => 1,
        clearSchedule: vi.fn(),
      })

      monitor.start()
      await monitor.settled()
      expect(commits).toEqual(['remote-1:offline', 'remote-2:ready'])
      monitor.stop()
    },
  )

  it('aborts a hung post-health session chain on stop and can truly settle without a late commit', async () => {
    const commitRemoteStatus = vi.fn()
    let sessionStarted = false
    const fetcher: RemoteFetch = (url, init) => {
      if (url.endsWith('/health/ready')) return Promise.resolve(new UrlResponse(url, '{}', { status: 200 }))
      if (url.endsWith('/.well-known/nekro-nxt')) {
        return Promise.resolve(new UrlResponse(url, JSON.stringify(descriptor), { status: 200 }))
      }
      sessionStarted = true
      return neverUntilAborted(init?.signal)
    }
    const monitor = new SerialProfileMonitor<void>({
      getTargets: () => [
        { id: 'remote-1', kind: 'remote', generation: 1, notificationsEnabled: false, status: 'connecting' },
      ],
      isCurrent: () => true,
      probeRemote: async (_target, signal) => {
        return probeRemoteProfile({
          profile,
          fetcher,
          credential: { deviceId: 'device-1', deviceSecret: 's'.repeat(32) },
          signal,
          requestTimeoutMs: 60_000,
          probeTimeoutMs: 60_000,
        })
      },
      statusFromProbeError: () => 'offline',
      commitRemoteStatus,
      readNotifications: () => Promise.resolve(),
      commitNotifications: vi.fn(),
      schedule: () => 1,
      clearSchedule: vi.fn(),
    })

    monitor.start()
    await vi.waitFor(() => expect(sessionStarted).toBe(true))
    monitor.stop()
    await expect(monitor.settled()).resolves.toBeUndefined()
    expect(commitRemoteStatus).not.toHaveBeenCalled()
  })

  it.each(['management-get', 'delete'] as const)(
    'bounds a hung revoke %s with one deadline and lets queued local removal cleanup continue',
    async (hungStage) => {
      let managementGets = 0
      const fetcher: RemoteFetch = (url, init) => {
        if (url.endsWith('/.well-known/nekro-nxt')) {
          return Promise.resolve(new UrlResponse(url, JSON.stringify(descriptor), { status: 200 }))
        }
        if (init?.method === 'DELETE') {
          return hungStage === 'delete'
            ? neverUntilAborted(init.signal)
            : Promise.resolve(new UrlResponse(url, '{}', { status: 204 }))
        }
        managementGets += 1
        if (managementGets === 1) return Promise.resolve(new UrlResponse(url, '{}', { status: 200 }))
        if (hungStage === 'management-get') return neverUntilAborted(init?.signal)
        return Promise.resolve(new UrlResponse(url, JSON.stringify({ csrfToken: 'csrf-test-token' }), { status: 200 }))
      }
      const queue = new SerialTaskQueue()
      let localCleanupFinished = false

      await queue.run(async () => {
        await tryRevokeRemoteDevice({
          profile,
          fetcher,
          credential: { deviceId: 'device-1', deviceSecret: 's'.repeat(32) },
          totalTimeoutMs: 20,
        })
        localCleanupFinished = true
      })

      expect(localCleanupFinished).toBe(true)
      expect(managementGets).toBe(2)
    },
  )
})
