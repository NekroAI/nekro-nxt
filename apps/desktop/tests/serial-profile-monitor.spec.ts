import { describe, expect, it, vi } from 'vitest'
import { SerialProfileMonitor, type ProfileMonitorTarget } from '../src/serial-profile-monitor.ts'

const target = (overrides: Partial<ProfileMonitorTarget> = {}): ProfileMonitorTarget => ({
  id: 'remote-1',
  kind: 'remote',
  generation: 1,
  notificationsEnabled: true,
  status: 'connecting',
  ...overrides,
})

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('Desktop serial profile monitor', () => {
  it('schedules the next remote poll only after the complete current cycle settles', async () => {
    const firstProbe = deferred<'ready'>()
    const scheduled: Array<() => void> = []
    let probeCalls = 0
    const monitor = new SerialProfileMonitor({
      getTargets: () => [target({ notificationsEnabled: false })],
      isCurrent: () => true,
      probeRemote: () => {
        probeCalls += 1
        return probeCalls === 1 ? firstProbe.promise : Promise.resolve('ready')
      },
      statusFromProbeError: () => 'offline',
      commitRemoteStatus: vi.fn(),
      readNotifications: () => Promise.resolve(undefined),
      commitNotifications: vi.fn(),
      schedule: (callback) => {
        scheduled.push(callback)
        return callback
      },
      clearSchedule: vi.fn(),
    })

    monitor.start()
    await vi.waitFor(() => expect(probeCalls).toBe(1))
    expect(scheduled).toHaveLength(0)

    firstProbe.resolve('ready')
    await monitor.settled()
    expect(scheduled).toHaveLength(1)
    scheduled.shift()?.()
    await vi.waitFor(() => expect(probeCalls).toBe(2))
    await monitor.settled()
    expect(scheduled).toHaveLength(1)
    monitor.stop()
  })

  it('rejects a late result after the profile generation changes', async () => {
    const probe = deferred<'ready'>()
    let generation = 4
    const commitRemoteStatus = vi.fn()
    const readNotifications = vi.fn(() => Promise.resolve({ cursor: 1 }))
    const monitor = new SerialProfileMonitor({
      getTargets: () => [target({ generation })],
      isCurrent: (candidate) => candidate.generation === generation,
      probeRemote: () => probe.promise,
      statusFromProbeError: () => 'offline',
      commitRemoteStatus,
      readNotifications,
      commitNotifications: vi.fn(),
      schedule: () => 1,
      clearSchedule: vi.fn(),
    })

    monitor.start()
    await vi.waitFor(() => expect(readNotifications).not.toHaveBeenCalled())
    generation += 1
    probe.resolve('ready')
    await monitor.settled()

    expect(commitRemoteStatus).not.toHaveBeenCalled()
    expect(readNotifications).not.toHaveBeenCalled()
    monitor.stop()
  })

  it('keeps successful health when notification endpoint or JSON reading fails', async () => {
    const commitRemoteStatus = vi.fn()
    const onNotificationError = vi.fn()
    const monitor = new SerialProfileMonitor({
      getTargets: () => [target()],
      isCurrent: () => true,
      probeRemote: () => Promise.resolve('ready'),
      statusFromProbeError: () => 'offline',
      commitRemoteStatus,
      readNotifications: () => Promise.reject(new Error('invalid notification response')),
      commitNotifications: vi.fn(),
      onNotificationError,
      schedule: () => 1,
      clearSchedule: vi.fn(),
    })

    monitor.start()
    await monitor.settled()

    expect(commitRemoteStatus).toHaveBeenCalledOnce()
    expect(commitRemoteStatus).toHaveBeenCalledWith(expect.objectContaining({ id: 'remote-1' }), 'ready')
    expect(onNotificationError).toHaveBeenCalledOnce()
    monitor.stop()
  })

  it('reads local notifications without probing or writing local Host health', async () => {
    const commitRemoteStatus = vi.fn()
    const commitNotifications = vi.fn()
    const monitor = new SerialProfileMonitor({
      getTargets: () => [target({ id: 'local', kind: 'local', status: 'ready' })],
      isCurrent: () => true,
      probeRemote: vi.fn(() => Promise.resolve('ready' as const)),
      statusFromProbeError: () => 'offline',
      commitRemoteStatus,
      readNotifications: () => Promise.resolve({ cursor: 2 }),
      commitNotifications,
      schedule: () => 1,
      clearSchedule: vi.fn(),
    })

    monitor.start()
    await monitor.settled()

    expect(commitRemoteStatus).not.toHaveBeenCalled()
    expect(commitNotifications).toHaveBeenCalledOnce()
    monitor.stop()
  })

  it.each(['getTargets', 'commitRemoteStatus'] as const)(
    'contains an unexpected %s throw, settles, and runs the next scheduled cycle',
    async (throwingCallback) => {
      const scheduled: Array<() => void> = []
      let recovered = false
      let successfulCycles = 0
      const onCycleError = vi.fn(() => {
        throw new Error('diagnostic callback must also stay contained')
      })
      const monitor = new SerialProfileMonitor<void>({
        getTargets: () => {
          if (throwingCallback === 'getTargets' && !recovered) throw new Error('unexpected target failure')
          return [target({ notificationsEnabled: false })]
        },
        isCurrent: () => true,
        probeRemote: () => Promise.resolve('ready'),
        statusFromProbeError: () => 'offline',
        commitRemoteStatus: () => {
          if (throwingCallback === 'commitRemoteStatus' && !recovered) {
            throw new Error('unexpected commit failure')
          }
          successfulCycles += 1
        },
        readNotifications: () => Promise.resolve(),
        commitNotifications: vi.fn(),
        onCycleError,
        schedule: (callback) => {
          scheduled.push(callback)
          return callback
        },
        clearSchedule: vi.fn(),
      })

      monitor.start()
      await expect(monitor.settled()).resolves.toBeUndefined()
      expect(onCycleError).toHaveBeenCalledOnce()
      expect(scheduled).toHaveLength(1)

      recovered = true
      scheduled.shift()?.()
      await expect(monitor.settled()).resolves.toBeUndefined()
      expect(successfulCycles).toBe(1)
      expect(scheduled).toHaveLength(1)
      monitor.stop()
      await expect(monitor.settled()).resolves.toBeUndefined()
    },
  )
})
