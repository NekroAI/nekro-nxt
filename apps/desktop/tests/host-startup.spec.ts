import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  allowedStartupActions,
  HostStartupMonitor,
  parseHostUpgradeProgress,
  restoreHostBackup,
  waitForHostReady,
  type HostStartupObservation,
  type HostUpgradeProgress,
} from '../src/host-startup.ts'
import { HostSupervisor, type SupervisedHostProcess } from '../src/host-supervisor.ts'

const identity = { releaseId: 'test-release', runId: 'test-run', pid: 321 }
const backupId = `runtime-${'a'.repeat(32)}`
const progress = (
  updatedAt: number,
  status: HostUpgradeProgress['status'] = { phase: 'backup' },
): HostUpgradeProgress => ({
  format: 'nxt.host-upgrade-progress',
  version: 1,
  ...identity,
  updatedAt,
  status,
})

afterEach(() => vi.useRealTimers())

describe('Desktop upgrade readiness', () => {
  it('keeps a progressing upgrade alive beyond 60 seconds and requires matching HTTP readiness', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const observations: HostStartupObservation[] = []
    const controller = new AbortController()
    const task = waitForHostReady({
      origin: 'http://127.0.0.1:4000',
      identity: () => identity,
      signal: controller.signal,
      readProgress: () =>
        Promise.resolve(
          progress(Date.now(), {
            phase: Date.now() >= 180_000 ? 'ready' : 'backup',
            progress: { completed: Date.now(), total: 200_000, unit: 'bytes' },
          }),
        ),
      probeReady: () =>
        Promise.resolve(
          Date.now() < 180_000
            ? { status: 'ready', releaseId: 'old-release' }
            : { status: 'ready', releaseId: identity.releaseId },
        ),
      onObservation: (observation) => observations.push(observation),
    })
    let ready = false
    void task.then(() => {
      ready = true
    })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(ready).toBe(false)
    expect(observations.at(-1)?.stalled).toBe(false)
    await vi.advanceTimersByTimeAsync(60_000)
    await task
    expect(ready).toBe(true)
    expect(observations.at(-1)?.progress?.status.phase).toBe('ready')
  })

  it.each(['missing', 'wrong-pid', 'wrong-run', 'wrong-release', 'future', 'stale', 'idle'])(
    'does not extend normal startup for %s progress',
    async (kind) => {
      vi.useFakeTimers()
      vi.setSystemTime(100_000)
      const candidate = progress(100_000)
      const value =
        kind === 'missing'
          ? undefined
          : {
              ...candidate,
              ...(kind === 'wrong-pid' ? { pid: 999 } : {}),
              ...(kind === 'wrong-run' ? { runId: 'previous-run' } : {}),
              ...(kind === 'wrong-release' ? { releaseId: 'previous-release' } : {}),
              ...(kind === 'future' ? { updatedAt: 999_000 } : {}),
              ...(kind === 'stale' ? { updatedAt: 0 } : {}),
              ...(kind === 'idle' ? { status: { phase: 'idle' } } : {}),
            }
      const task = waitForHostReady({
        origin: 'http://127.0.0.1:4000',
        identity: () => identity,
        signal: new AbortController().signal,
        readProgress: () => Promise.resolve(value),
        probeReady: () => Promise.resolve(undefined),
        onObservation: () => undefined,
      })
      const rejected = expect(task).rejects.toThrow(/60 秒/u)
      await vi.advanceTimersByTimeAsync(60_000)
      await rejected
    },
  )

  it('fails after the last valid heartbeat expires, including a temporarily unreadable progress file', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const task = waitForHostReady({
      origin: 'http://127.0.0.1:4000',
      identity: () => identity,
      signal: new AbortController().signal,
      readProgress: () => {
        if (Date.now() >= 45_000) return Promise.reject(new Error('partial or missing file'))
        return Promise.resolve(progress(Date.now()))
      },
      probeReady: () => Promise.resolve(undefined),
      onObservation: () => undefined,
    })
    const rejected = expect(task).rejects.toThrow('升级进度心跳已中断超过 60 秒')
    await vi.advanceTimersByTimeAsync(105_000)
    await rejected
  })

  it('shows stalled work without treating regular heartbeats as progress or terminating the child', () => {
    const monitor = new HostStartupMonitor(0)
    for (let now = 0; now < 120_000; now += 5_000) {
      expect(monitor.observe(progress(now), identity, now).stalled).toBe(false)
    }
    expect(monitor.observe(progress(120_000), identity, 120_000).stalled).toBe(true)
    expect(
      monitor.observe(progress(125_000, { phase: 'migrating', currentStepId: 'new-step' }), identity, 125_000).stalled,
    ).toBe(false)
  })

  it('ignores regressing timestamps and unknown phases or malformed counters', () => {
    const monitor = new HostStartupMonitor(10_000)
    monitor.observe(progress(20_000), identity, 20_000)
    expect(monitor.observe(progress(15_000), identity, 25_000).progress?.updatedAt).toBe(20_000)
    expect(parseHostUpgradeProgress({ ...progress(0), status: { phase: 'future-format' } })).toBeUndefined()
    expect(
      parseHostUpgradeProgress({
        ...progress(0),
        status: { phase: 'backup', progress: { completed: 20, total: 10, unit: 'bytes' } },
      }),
    ).toBeUndefined()
    expect(parseHostUpgradeProgress({ ...progress(0), pid: 0 })).toBeUndefined()
  })

  it('reports a recovery point before rejecting and never accepts its HTTP ready response', async () => {
    const onObservation = vi.fn<(observation: HostStartupObservation) => void>()
    const probeReady = vi.fn(() => Promise.resolve({ status: 'ready', releaseId: identity.releaseId }))
    await expect(
      waitForHostReady({
        origin: 'http://127.0.0.1:4000',
        identity: () => identity,
        signal: new AbortController().signal,
        readProgress: () =>
          Promise.resolve(progress(10_000, { phase: 'recovery', backupId, errorSummary: 'fixture migration failed' })),
        probeReady,
        onObservation,
        now: () => 10_000,
      }),
    ).rejects.toThrow('fixture migration failed')
    expect(onObservation.mock.lastCall?.[0].progress?.status.backupId).toBe(backupId)
    expect(probeReady).not.toHaveBeenCalled()
  })

  it('aborts a polling task without another probe', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const probeReady = vi.fn(() => Promise.resolve(undefined))
    const task = waitForHostReady({
      origin: 'http://127.0.0.1:4000',
      identity: () => identity,
      signal: controller.signal,
      readProgress: () => Promise.resolve(undefined),
      probeReady,
      onObservation: () => undefined,
    })
    const rejected = expect(task).rejects.toThrow('safe stop')
    await vi.advanceTimersByTimeAsync(1_000)
    const count = probeReady.mock.calls.length
    controller.abort(new Error('safe stop'))
    await rejected
    await vi.advanceTimersByTimeAsync(60_000)
    expect(probeReady).toHaveBeenCalledTimes(count)
  })

  it('a child exit interrupts a live upgrade and cancels its readiness polling', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    let exit!: (code: number) => void
    let readinessSignal!: AbortSignal
    const kill = vi.fn(() => true)
    const supervisor = new HostSupervisor({
      origin: 'http://127.0.0.1:4000',
      spawnHost: () => ({
        once: (_event, listener) => {
          exit = listener
        },
        kill,
      }),
      waitUntilReady: (origin, signal) => {
        readinessSignal = signal
        return waitForHostReady({
          origin,
          signal,
          identity: () => identity,
          readProgress: () => Promise.resolve(progress(Date.now())),
          probeReady: () => Promise.resolve(undefined),
          onObservation: () => undefined,
        })
      },
    })
    const task = supervisor.start()
    const rejected = expect(task).rejects.toThrow('exited before readiness (code 7)')
    await vi.advanceTimersByTimeAsync(90_000)
    exit(7)
    await rejected
    expect(readinessSignal.aborted).toBe(true)
    expect(kill).not.toHaveBeenCalled()
  })
})

describe('Desktop offline restore', () => {
  it('waits for Host shutdown, passes an argv array, and waits for exit zero before success', async () => {
    let stopped!: () => void
    let exit!: (code: number) => void
    const child: SupervisedHostProcess = {
      once: (_event, listener) => {
        exit = listener
      },
      kill: () => true,
    }
    const spawnRestore = vi.fn(() => child)
    const task = restoreHostBackup({
      backupId,
      stopHost: () =>
        new Promise<void>((resolve) => {
          stopped = resolve
        }),
      spawnRestore,
    })
    let restored = false
    void task.then(() => {
      restored = true
    })
    expect(spawnRestore).not.toHaveBeenCalled()
    stopped()
    await Promise.resolve()
    expect(spawnRestore).toHaveBeenCalledWith(['--restore-upgrade', backupId])
    expect(restored).toBe(false)
    exit(0)
    await task
    expect(restored).toBe(true)
  })

  it('does not report success or spawn a normal Host when restore fails', async () => {
    let exit!: (code: number) => void
    const spawnRestore = vi.fn(() => ({
      once: (_event: 'exit', listener: (code: number) => void) => {
        exit = listener
      },
      kill: () => true,
    }))
    const task = restoreHostBackup({ backupId, stopHost: () => Promise.resolve(), spawnRestore })
    const rejected = expect(task).rejects.toThrow('退出码 2')
    await Promise.resolve()
    exit(2)
    await rejected
    expect(spawnRestore).toHaveBeenCalledTimes(1)
  })

  it('rejects an invalid backup ID before stopping or forking', async () => {
    const stopHost = vi.fn()
    const spawnRestore = vi.fn()
    await expect(restoreHostBackup({ backupId: '../other-data', stopHost, spawnRestore })).rejects.toThrow('标识无效')
    expect(stopHost).not.toHaveBeenCalled()
    expect(spawnRestore).not.toHaveBeenCalled()
  })

  it('does not expose retry or restore while committing, and only offers exit after restoration', () => {
    expect(allowedStartupActions({ mode: 'starting', diagnostics: '' })).toEqual(['cancel'])
    expect(allowedStartupActions({ mode: 'restoring', diagnostics: '' })).toEqual([])
    expect(allowedStartupActions({ mode: 'cancelling', diagnostics: '' })).toEqual([])
    expect(allowedStartupActions({ mode: 'restored', diagnostics: '' })).toEqual(['exit'])
    expect(
      allowedStartupActions({
        mode: 'failed',
        diagnostics: '',
        observation: { progress: progress(0, { phase: 'recovery', backupId }), stalled: false },
      }),
    ).toEqual(['retry', 'restore', 'exit'])
    expect(allowedStartupActions({ mode: 'failed', diagnostics: '' })).toEqual(['retry', 'exit'])
  })
})
