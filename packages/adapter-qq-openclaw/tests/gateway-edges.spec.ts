import type { QQGatewaySocket, QQGatewayCheckpoint, QQGatewayCheckpointStore, QQGatewayClock } from '../src/gateway.ts'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { QQGatewayClient, parseQQGatewayPayload } from '../src/gateway.ts'

const gatewayCommandSchema = z.object({ op: z.number(), d: z.unknown() }).passthrough()

const parseSentCommand = (sent: readonly string[], index: number) => {
  const payload = sent[index]
  if (payload === undefined) throw new Error(`Expected Gateway command at index ${index}.`)
  return gatewayCommandSchema.parse(JSON.parse(payload))
}

const socketFrom = (
  payloads: readonly unknown[],
  sent: string[],
  closed: Array<{ readonly code?: number; readonly reason?: string }>,
): QQGatewaySocket => ({
  messages: {
    [Symbol.asyncIterator]() {
      let index = 0
      return {
        next: () => {
          const payload = payloads[index++]
          return Promise.resolve(
            payload === undefined
              ? { done: true as const, value: undefined }
              : { done: false as const, value: JSON.stringify(payload) },
          )
        },
      }
    },
  },
  send: (payload) => {
    sent.push(payload)
    return Promise.resolve()
  },
  close: (code, reason) => {
    closed.push({ ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) })
    return Promise.resolve()
  },
})

const checkpointStore = (initial?: QQGatewayCheckpoint) => {
  let checkpoint = initial
  let cleared = 0
  const store: QQGatewayCheckpointStore = {
    load: () => Promise.resolve(checkpoint),
    save: (value) => {
      checkpoint = value
      return Promise.resolve()
    },
    clear: () => {
      checkpoint = undefined
      cleared += 1
      return Promise.resolve()
    },
  }
  return {
    store,
    get checkpoint() {
      return checkpoint
    },
    get cleared() {
      return cleared
    },
  }
}

const clockFrom = (now = 1_000): QQGatewayClock => ({
  now: () => now,
  sleep: () => Promise.resolve(),
  setInterval: () => () => {},
})

const makeClient = (overrides: Partial<ConstructorParameters<typeof QQGatewayClient>[0]> = {}) =>
  new QQGatewayClient({
    appId: 'app',
    access: {
      gatewayUrl: () => Promise.resolve('wss://gateway.test'),
      accessToken: () => Promise.resolve('token'),
    },
    sockets: { connect: () => Promise.resolve(socketFrom([], [], [])) },
    checkpoints: checkpointStore().store,
    clock: clockFrom(),
    onDispatch: () => Promise.resolve(true),
    ...overrides,
  })

describe('QQ Gateway lifecycle and malformed boundaries', () => {
  it('handles heartbeat scheduling, unknown payloads, READY without a sequence, and malformed READY data', async () => {
    expect(() => parseQQGatewayPayload('[]')).toThrow()
    const sent: string[] = []
    const closed: Array<{ readonly code?: number; readonly reason?: string }> = []
    let heartbeat: (() => void) | undefined
    const statuses: string[] = []
    const socket = socketFrom(
      [
        { op: 10, d: { heartbeat_interval: 999 } },
        { op: 42, d: null },
        { op: 11 },
        { op: 0, t: 'READY', d: { session_id: 'session-no-sequence' } },
        { op: 0, d: null },
      ],
      sent,
      closed,
    )
    const client = makeClient({
      sockets: { connect: () => Promise.resolve(socket) },
      clock: {
        ...clockFrom(),
        setInterval: (callback) => {
          heartbeat = callback
          return () => {}
        },
      },
      onStatus: (status) => statuses.push(status.state),
      onDispatch: (eventType, data) => {
        expect(eventType).toBe('')
        expect(data).toEqual({})
        return Promise.resolve(true)
      },
    })
    await expect(client.connectOnce(new AbortController().signal)).resolves.toBe('closed')
    expect(heartbeat).toBeDefined()
    heartbeat?.()
    heartbeat?.()
    expect(parseSentCommand(sent, 0)).toMatchObject({ op: 2, d: { token: 'QQBot token' } })
    expect(parseSentCommand(sent, 1)).toEqual({ op: 1, d: null })
    expect(closed).toContainEqual({ code: 4000, reason: 'heartbeat acknowledgement timeout' })
    expect(statuses).toContain('connected')

    const invalidReady = makeClient({
      sockets: {
        connect: () =>
          Promise.resolve(
            socketFrom(
              [
                { op: 10, d: {} },
                { op: 0, t: 'READY', s: 1, d: {} },
              ],
              [],
              [],
            ),
          ),
      },
    })
    await expect(invalidReady.connectOnce(new AbortController().signal)).rejects.toThrow('omitted session_id')
  })

  it('drops stale resume state, exercises RESUMED without a session, and stops a running loop deterministically', async () => {
    const stale = checkpointStore({ appId: 'app', sessionId: 'stale-session', sequence: 4, savedAt: 0 })
    const sent: string[] = []
    const client = makeClient({
      checkpoints: stale.store,
      clock: clockFrom(1_000),
      resumeTtlMs: 100,
      sockets: {
        connect: () =>
          Promise.resolve(socketFrom([{ op: 10, d: {} }, { op: 0, t: 'RESUMED', s: 1 }, { op: 7 }], sent, [])),
      },
    })
    await expect(client.connectOnce(new AbortController().signal)).resolves.toBe('reconnect')
    expect(parseSentCommand(sent, 0)).toMatchObject({ op: 2 })
    expect(stale.cleared).toBe(1)
    expect(stale.checkpoint).toBeUndefined()

    let resolveConnected: (() => void) | undefined
    const connected = new Promise<void>((resolve) => {
      resolveConnected = resolve
    })
    const statuses: string[] = []
    const runningSocket = socketFrom(
      [
        { op: 10, d: {} },
        { op: 0, t: 'READY', s: 1, d: { session_id: 'running' } },
      ],
      [],
      [],
    )
    const running = makeClient({
      sockets: { connect: () => Promise.resolve(runningSocket) },
      clock: {
        ...clockFrom(),
        sleep: (_delay, signal) =>
          new Promise<void>((resolve) => {
            if (signal.aborted) resolve()
            else signal.addEventListener('abort', () => resolve(), { once: true })
          }),
      },
      onStatus: (status) => {
        statuses.push(status.state)
        if (status.state === 'connected') resolveConnected?.()
      },
    })
    await running.start()
    await connected
    await expect(running.start()).rejects.toThrow('already running')
    await running.stop()
    await running.stop()
    expect(statuses).toContain('stopped')
  })

  it('reports non-Error poison dispatches and exposes reconnect errors without waiting on real time', async () => {
    const quarantined: unknown[] = []
    let resolveStopped: (() => void) | undefined
    const stopped = new Promise<void>((resolve) => {
      resolveStopped = resolve
    })
    const statuses: string[] = []
    const client = makeClient({
      sockets: {
        connect: () => Promise.reject(new Error('connect failed')),
      },
      onDispatch: () => Promise.reject(new Error('poison dispatch')),
      maxDispatchAttempts: 1,
      onQuarantine: (input) => {
        quarantined.push(input)
        return Promise.resolve()
      },
      onStatus: (status) => {
        statuses.push(status.state)
        if (status.state === 'reconnecting' && status.lastError === 'connect failed') {
          void client.stop().then(() => resolveStopped?.())
        }
      },
    })
    await client.start()
    await stopped
    await client.stop()
    expect(statuses).toContain('reconnecting')
    expect(quarantined).toEqual([])

    const poisonStatuses: Array<{ readonly state: string; readonly lastError?: string }> = []
    const poison = makeClient({
      sockets: {
        connect: () =>
          Promise.resolve(socketFrom([{ op: 10, d: {} }, { op: 0, t: 'POISON', s: 1, d: {} }, { op: 7 }], [], [])),
      },
      maxDispatchAttempts: 1,
      onDispatch: () => Promise.reject(new Error('bad dispatch')),
      onQuarantine: (input) => {
        quarantined.push(input)
        return Promise.resolve()
      },
      onStatus: (status) => poisonStatuses.push(status),
    })
    await expect(poison.connectOnce(new AbortController().signal)).resolves.toBe('reconnect')
    expect(quarantined).toEqual([expect.objectContaining({ eventType: 'POISON', errorSummary: 'bad dispatch' })])
    expect(poisonStatuses.some(({ lastError }) => lastError?.includes('Quarantined POISON'))).toBe(true)
    expect(() => makeClient({ maxDispatchAttempts: 0 })).toThrow('positive integer')
  })
})
