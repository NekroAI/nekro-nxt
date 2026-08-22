import { describe, expect, it, vi } from 'vitest'
import { HostSupervisor, type SupervisedHostProcess } from '../src/host-supervisor.ts'

class FakeHostProcess implements SupervisedHostProcess {
  readonly #exitListeners: Array<(code: number) => void> = []
  readonly #exitOnKill: boolean
  exited = false
  killCalls = 0

  constructor(options: { exitOnKill?: boolean } = {}) {
    this.#exitOnKill = options.exitOnKill ?? true
  }

  once(event: 'exit', listener: (code: number) => void): void {
    expect(event).toBe('exit')
    this.#exitListeners.push(listener)
  }

  kill(): boolean {
    this.killCalls += 1
    if (this.#exitOnKill) this.exit(0)
    return true
  }

  exit(code: number): void {
    if (this.exited) return
    this.exited = true
    for (const listener of this.#exitListeners) listener(code)
  }
}

const immediateDelay = (_delayMs: number, signal: AbortSignal): Promise<void> =>
  signal.aborted
    ? Promise.reject(new Error('Desktop Host delay was aborted.', { cause: signal.reason }))
    : Promise.resolve()

describe('Desktop Host supervisor', () => {
  it('restarts an exited Host on the same origin and reports recovery', async () => {
    const origins: string[] = []
    const processes: FakeHostProcess[] = []
    const recovered: number[] = []
    const supervisor = new HostSupervisor({
      origin: 'http://127.0.0.1:41234',
      spawnHost: (origin) => {
        origins.push(origin)
        const process = new FakeHostProcess()
        processes.push(process)
        return process
      },
      waitUntilReady: () => Promise.resolve(),
      delay: immediateDelay,
      onRecovered: (attempt) => recovered.push(attempt),
    })

    await supervisor.start()
    processes[0]!.exit(17)

    await vi.waitFor(() => expect(processes).toHaveLength(2))
    expect(origins).toEqual(['http://127.0.0.1:41234', 'http://127.0.0.1:41234'])
    expect(recovered).toEqual([1])

    await supervisor.stop()
  })

  it('kills a replacement that fails readiness and keeps retrying within budget', async () => {
    const processes: FakeHostProcess[] = []
    const readiness = [
      () => Promise.resolve(),
      () => Promise.reject(new Error('migration failed')),
      () => Promise.resolve(),
    ]
    const notices: Array<{ attempt: number; delayMs: number }> = []
    const recovered: number[] = []
    const supervisor = new HostSupervisor({
      origin: 'http://127.0.0.1:41235',
      spawnHost: () => {
        const process = new FakeHostProcess()
        processes.push(process)
        return process
      },
      waitUntilReady: () => readiness.shift()?.() ?? Promise.reject(new Error('unexpected readiness call')),
      delay: immediateDelay,
      onRestarting: ({ attempt, delayMs }) => notices.push({ attempt, delayMs }),
      onRecovered: (attempt) => recovered.push(attempt),
    })

    await supervisor.start()
    processes[0]!.exit(9)

    await vi.waitFor(() => expect(processes).toHaveLength(3))
    expect(processes[1]!.killCalls).toBe(1)
    expect(notices).toEqual([
      { attempt: 1, delayMs: 500 },
      { attempt: 2, delayMs: 1_000 },
    ])
    expect(recovered).toEqual([2])

    await supervisor.stop()
  })

  it('stops after five restart attempts inside the crash window', async () => {
    const processes: FakeHostProcess[] = []
    const delays: number[] = []
    const fatal: Error[] = []
    let readinessCalls = 0
    const supervisor = new HostSupervisor({
      origin: 'http://127.0.0.1:41236',
      spawnHost: () => {
        const process = new FakeHostProcess()
        processes.push(process)
        return process
      },
      waitUntilReady: () => {
        readinessCalls += 1
        return readinessCalls > 1 ? Promise.reject(new Error('replacement never became ready')) : Promise.resolve()
      },
      delay: async (delayMs, signal) => {
        delays.push(delayMs)
        await immediateDelay(delayMs, signal)
      },
      now: () => 10_000,
      onFatal: (error) => fatal.push(error),
    })

    await supervisor.start()
    processes[0]!.exit(21)

    await vi.waitFor(() => expect(fatal).toHaveLength(1))
    expect(processes).toHaveLength(6)
    expect(delays).toEqual([500, 1_000, 2_000, 5_000, 5_000])
    expect(fatal[0]!.message).toContain('failed more than 5 times within 60000 ms')

    await supervisor.stop()
  })

  it('cancels a pending backoff without spawning another Host when stopped', async () => {
    const processes: FakeHostProcess[] = []
    let backoffStarted!: () => void
    const backoff = new Promise<void>((resolve) => {
      backoffStarted = resolve
    })
    const supervisor = new HostSupervisor({
      origin: 'http://127.0.0.1:41237',
      spawnHost: () => {
        const process = new FakeHostProcess()
        processes.push(process)
        return process
      },
      waitUntilReady: () => Promise.resolve(),
      delay: async (_delayMs, signal) => {
        backoffStarted()
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new Error('Desktop Host delay was aborted.', { cause: signal.reason })),
            { once: true },
          )
        })
      },
    })

    await supervisor.start()
    processes[0]!.exit(11)
    await backoff
    await supervisor.stop()

    expect(processes).toHaveLength(1)
  })

  it('waits for the current Host exit while stopping', async () => {
    const process = new FakeHostProcess({ exitOnKill: false })
    const supervisor = new HostSupervisor({
      origin: 'http://127.0.0.1:41238',
      spawnHost: () => process,
      waitUntilReady: () => Promise.resolve(),
    })
    await supervisor.start()

    let stopped = false
    const stop = supervisor.stop().then(() => {
      stopped = true
    })
    await Promise.resolve()
    expect(process.killCalls).toBe(1)
    expect(stopped).toBe(false)

    process.exit(0)
    await stop
    expect(stopped).toBe(true)
  })
})
