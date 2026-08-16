import type { AdapterRuntimeStateStore } from '@nekro-nxt/adapter-sdk'
import type { ConnectionId, JsonValue } from '@nekro-nxt/contracts'
import { describe, expect, it } from 'vitest'
import {
  createQQGatewayCheckpointStore,
  QQGatewayClient,
  type QQGatewayCheckpoint,
  type QQGatewayCheckpointStore,
  type QQGatewayClock,
  type QQGatewaySocket,
} from '../src/gateway.ts'

const fakeClock = (now = 1_000): QQGatewayClock => ({
  now: () => now,
  sleep: () => Promise.resolve(),
  setInterval: () => () => {},
})

const socketFrom = (payloads: readonly unknown[], sent: string[]): QQGatewaySocket => ({
  messages: {
    [Symbol.asyncIterator]() {
      let index = 0
      return {
        next: () => {
          const payload = payloads[index]
          index += 1
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
  close: () => Promise.resolve(),
})

describe('QQ Gateway resume and checkpoints', () => {
  it('persists a validated Connection-scoped resume checkpoint and clears corrupt state', async () => {
    const connectionId = 'connection-qq' as ConnectionId
    let value: JsonValue | undefined
    let clears = 0
    const states: AdapterRuntimeStateStore = {
      load: () => Promise.resolve(value),
      save: (_connectionId, _key, next) => {
        value = next
        return Promise.resolve()
      },
      clear: () => {
        value = undefined
        clears += 1
        return Promise.resolve()
      },
    }
    const store = createQQGatewayCheckpointStore(connectionId, states)
    await store.save({ appId: 'app', sessionId: 'session', sequence: 3, savedAt: 100 })
    await expect(store.load()).resolves.toEqual({ appId: 'app', sessionId: 'session', sequence: 3, savedAt: 100 })
    value = { appId: 'app', sequence: 'invalid' }
    await expect(store.load()).resolves.toBeUndefined()
    expect(clears).toBe(1)
  })

  it('stops at the first uncommitted dispatch and resumes without skipping its sequence', async () => {
    let checkpoint: QQGatewayCheckpoint | undefined
    let clears = 0
    const store: QQGatewayCheckpointStore = {
      load: () => Promise.resolve(checkpoint),
      save: (value) => {
        checkpoint = value
        return Promise.resolve()
      },
      clear: () => {
        checkpoint = undefined
        clears += 1
        return Promise.resolve()
      },
    }
    const firstSent: string[] = []
    const committed: string[] = []
    const first = new QQGatewayClient({
      appId: 'app-1',
      access: {
        gatewayUrl: () => Promise.resolve('wss://gateway.test'),
        accessToken: () => Promise.resolve('token-1'),
      },
      sockets: {
        connect: () =>
          Promise.resolve(
            socketFrom(
              [
                { op: 10, d: { heartbeat_interval: 45_000 } },
                { op: 0, t: 'READY', s: 1, d: { session_id: 'session-1' } },
                { op: 0, t: 'GROUP_MESSAGE_CREATE', s: 2, d: { id: 'not-committed' } },
                { op: 0, t: 'GROUP_MESSAGE_CREATE', s: 3, d: { id: 'committed' } },
                { op: 7 },
              ],
              firstSent,
            ),
          ),
      },
      checkpoints: store,
      clock: fakeClock(),
      onDispatch: (_type, data) => {
        const id = String(data.id)
        committed.push(id)
        return Promise.resolve(id === 'committed')
      },
    })
    await expect(first.connectOnce(new AbortController().signal)).resolves.toBe('reconnect')
    expect(JSON.parse(firstSent[0]!)).toMatchObject({ op: 2, d: { token: 'QQBot token-1' } })
    expect(committed).toEqual(['not-committed'])
    expect(checkpoint).toEqual({ appId: 'app-1', sessionId: 'session-1', sequence: 1, savedAt: 1_000 })

    const resumeSent: string[] = []
    const resumed = new QQGatewayClient({
      appId: 'app-1',
      access: {
        gatewayUrl: () => Promise.resolve('wss://gateway.test'),
        accessToken: () => Promise.resolve('token-2'),
      },
      sockets: {
        connect: () =>
          Promise.resolve(socketFrom([{ op: 10, d: {} }, { op: 0, t: 'RESUMED', s: 4, d: {} }, { op: 7 }], resumeSent)),
      },
      checkpoints: store,
      clock: fakeClock(1_100),
      onDispatch: () => Promise.resolve(true),
    })
    await resumed.connectOnce(new AbortController().signal)
    expect(JSON.parse(resumeSent[0]!)).toEqual({
      op: 6,
      d: { token: 'QQBot token-2', session_id: 'session-1', seq: 1 },
    })
    expect(checkpoint?.sequence).toBe(4)
    expect(clears).toBe(0)
  })

  it('discards stale or invalid sessions instead of guessing a resume', async () => {
    let checkpoint: QQGatewayCheckpoint | undefined = {
      appId: 'other-app',
      sessionId: 'foreign-session',
      sequence: 9,
      savedAt: 1,
    }
    let clears = 0
    const sent: string[] = []
    const client = new QQGatewayClient({
      appId: 'app-1',
      access: {
        gatewayUrl: () => Promise.resolve('wss://gateway.test'),
        accessToken: () => Promise.resolve('token'),
      },
      sockets: {
        connect: () => Promise.resolve(socketFrom([{ op: 10, d: {} }, { op: 9 }], sent)),
      },
      checkpoints: {
        load: () => Promise.resolve(checkpoint),
        save: (value) => {
          checkpoint = value
          return Promise.resolve()
        },
        clear: () => {
          clears += 1
          checkpoint = undefined
          return Promise.resolve()
        },
      },
      clock: fakeClock(10_000),
      onDispatch: () => Promise.resolve(true),
    })
    await expect(client.connectOnce(new AbortController().signal)).resolves.toBe('invalid-session')
    expect(JSON.parse(sent[0]!)).toMatchObject({ op: 2 })
    expect(clears).toBe(2)
    expect(checkpoint).toBeUndefined()
  })

  it('does not dispatch or regress the durable checkpoint for duplicate and late sequences', async () => {
    let checkpoint: QQGatewayCheckpoint | undefined
    const dispatched: string[] = []
    const client = new QQGatewayClient({
      appId: 'app',
      access: {
        gatewayUrl: () => Promise.resolve('wss://gateway.test'),
        accessToken: () => Promise.resolve('token'),
      },
      sockets: {
        connect: () =>
          Promise.resolve(
            socketFrom(
              [
                { op: 10, d: {} },
                { op: 0, t: 'READY', s: 1, d: { session_id: 'session' } },
                { op: 0, t: 'GROUP_MESSAGE_CREATE', s: 2, d: { id: 'first' } },
                { op: 0, t: 'GROUP_MESSAGE_CREATE', s: 2, d: { id: 'duplicate' } },
                { op: 0, t: 'GROUP_MESSAGE_CREATE', s: 3, d: { id: 'next' } },
                { op: 0, t: 'GROUP_MESSAGE_CREATE', s: 2, d: { id: 'late' } },
                { op: 7 },
              ],
              [],
            ),
          ),
      },
      checkpoints: {
        load: () => Promise.resolve(checkpoint),
        save: (value) => {
          checkpoint = value
          return Promise.resolve()
        },
        clear: () => Promise.resolve(),
      },
      clock: fakeClock(),
      onDispatch: (_type, data) => {
        dispatched.push(String(data.id))
        return Promise.resolve(true)
      },
    })
    await client.connectOnce(new AbortController().signal)
    expect(dispatched).toEqual(['first', 'next'])
    expect(checkpoint?.sequence).toBe(3)
  })

  it('quarantines a deterministic poison dispatch after bounded retries instead of blocking forever', async () => {
    let checkpoint: QQGatewayCheckpoint | undefined
    let attempts = 0
    const quarantined: Array<{
      readonly eventType: string
      readonly sequence?: number
      readonly errorSummary: string
    }> = []
    const sockets = [
      socketFrom(
        [
          { op: 10, d: {} },
          { op: 0, t: 'READY', s: 1, d: { session_id: 'session' } },
          { op: 0, t: 'GROUP_MESSAGE_CREATE', s: 2, d: { id: 'poison' } },
        ],
        [],
      ),
      socketFrom(
        [
          { op: 10, d: {} },
          { op: 0, t: 'GROUP_MESSAGE_CREATE', s: 2, d: { id: 'poison' } },
        ],
        [],
      ),
      socketFrom([{ op: 10, d: {} }, { op: 0, t: 'GROUP_MESSAGE_CREATE', s: 2, d: { id: 'poison' } }, { op: 7 }], []),
    ]
    const client = new QQGatewayClient({
      appId: 'app',
      access: {
        gatewayUrl: () => Promise.resolve('wss://gateway.test'),
        accessToken: () => Promise.resolve('token'),
      },
      sockets: {
        connect: () => {
          const socket = sockets.shift()
          return socket ? Promise.resolve(socket) : Promise.reject(new Error('No Fake Gateway socket remains.'))
        },
      },
      checkpoints: {
        load: () => Promise.resolve(checkpoint),
        save: (value) => {
          checkpoint = value
          return Promise.resolve()
        },
        clear: () => Promise.resolve(),
      },
      clock: fakeClock(),
      maxDispatchAttempts: 3,
      onDispatch: () => {
        attempts += 1
        return Promise.reject(new Error(`malformed dispatch ${'x'.repeat(1000)}`))
      },
      onQuarantine: (input) => {
        quarantined.push(input)
        return Promise.resolve()
      },
    })
    await expect(client.connectOnce(new AbortController().signal)).rejects.toThrow('malformed dispatch')
    await expect(client.connectOnce(new AbortController().signal)).rejects.toThrow('malformed dispatch')
    await expect(client.connectOnce(new AbortController().signal)).resolves.toBe('reconnect')
    expect(attempts).toBe(3)
    expect(quarantined).toEqual([expect.objectContaining({ eventType: 'GROUP_MESSAGE_CREATE', sequence: 2 })])
    expect(quarantined[0]?.errorSummary.length).toBeLessThanOrEqual(512)
    expect(checkpoint?.sequence).toBe(2)
  })
})
