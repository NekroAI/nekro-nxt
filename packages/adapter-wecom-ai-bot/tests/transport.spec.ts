import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer, type RawData } from 'ws'
import { WeComTransportError, WeComWebSocketClient, weComObject } from '../src/transport.ts'
import { createFakeContext, waitFor } from './helpers.ts'

const servers: WebSocketServer[] = []
const text = (raw: RawData): string =>
  Array.isArray(raw)
    ? Buffer.concat(raw).toString('utf8')
    : raw instanceof ArrayBuffer
      ? Buffer.from(raw).toString('utf8')
      : raw.toString('utf8')

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          for (const socket of server.clients) socket.terminate()
          server.close(() => resolve())
        }),
    ),
  )
})

describe('WeCom WebSocket transport', () => {
  it('authenticates and serializes commands sharing one req_id', async () => {
    const server = new WebSocketServer({ port: 0 })
    servers.push(server)
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const received: string[] = []
    server.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const frame = weComObject(JSON.parse(text(raw)))
        if (!frame) return
        const headers = weComObject(frame['headers'])
        const cmd = String(frame['cmd'])
        received.push(cmd)
        const respond = () => socket.send(JSON.stringify({ headers, errcode: 0, errmsg: 'ok' }))
        if (cmd === 'first') setTimeout(respond, 20)
        else respond()
      })
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Fixture server did not bind TCP.')
    const fake = createFakeContext()
    const client = new WeComWebSocketClient({
      context: fake.context,
      botId: 'bot-transport',
      secret: 'secret-transport',
      endpoint: `ws://127.0.0.1:${address.port}/`,
      onFrame: () => Promise.resolve(),
      heartbeatIntervalMs: 60_000,
    })
    await client.start()
    await waitFor(() => client.connected)
    await Promise.all([client.request('first', {}, 'shared-request'), client.request('second', {}, 'shared-request')])
    expect(received).toEqual(['aibot_subscribe', 'first', 'second'])
    await client.stop()
    expect(fake.diagnostics.at(-1)?.status).toBe('stopped')
  })

  it('stops reconnecting after three explicit authentication failures', async () => {
    const server = new WebSocketServer({ port: 0 })
    servers.push(server)
    await new Promise<void>((resolve) => server.once('listening', resolve))
    let attempts = 0
    server.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const frame = weComObject(JSON.parse(text(raw)))
        if (!frame) return
        if (frame['cmd'] !== 'aibot_subscribe') return
        attempts += 1
        socket.send(JSON.stringify({ headers: frame['headers'], errcode: 40001, errmsg: 'invalid credential fixture' }))
      })
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Fixture server did not bind TCP.')
    const fake = createFakeContext()
    const client = new WeComWebSocketClient({
      context: fake.context,
      botId: 'bot-auth-failure',
      secret: 'secret-auth-failure',
      endpoint: `ws://127.0.0.1:${address.port}/`,
      onFrame: () => Promise.resolve(),
      reconnectDelaysMs: [1],
    })
    await client.start()
    await waitFor(() =>
      fake.diagnostics.some(({ status, message }) => status === 'failed' && message?.includes('连续失败')),
    )
    expect(attempts).toBe(3)
    await client.stop()
  })

  it('does not send queued updates after one shared req_id becomes ambiguous', async () => {
    const server = new WebSocketServer({ port: 0 })
    servers.push(server)
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const received: string[] = []
    server.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const frame = weComObject(JSON.parse(text(raw)))
        if (!frame) return
        const cmd = String(frame['cmd'])
        received.push(cmd)
        if (cmd === 'aibot_subscribe') {
          socket.send(JSON.stringify({ headers: frame['headers'], errcode: 0, errmsg: 'ok' }))
        }
      })
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Fixture server did not bind TCP.')
    const fake = createFakeContext()
    const client = new WeComWebSocketClient({
      context: fake.context,
      botId: 'bot-ambiguous',
      secret: 'secret-ambiguous',
      endpoint: `ws://127.0.0.1:${address.port}/`,
      onFrame: () => Promise.resolve(),
      requestTimeoutMs: 20,
      heartbeatIntervalMs: 60_000,
    })
    await client.start()
    await waitFor(() => client.connected)
    const captureFailure = (request: Promise<unknown>): Promise<unknown> =>
      request.then(
        () => undefined,
        (error: unknown) => error,
      )
    const [firstFailure, secondFailure] = await Promise.all([
      captureFailure(client.request('first-update', {}, 'shared-ambiguous')),
      captureFailure(client.request('second-update', {}, 'shared-ambiguous')),
    ])
    expect(firstFailure).toBeInstanceOf(WeComTransportError)
    expect(firstFailure).toMatchObject({ kind: 'unknown' })
    expect(secondFailure).toBeInstanceOf(WeComTransportError)
    expect(secondFailure).toMatchObject({ kind: 'unknown' })
    expect(received).toEqual(['aibot_subscribe', 'first-update'])
    await expect(client.request('third-update', {}, 'shared-ambiguous')).rejects.toMatchObject({ kind: 'unknown' })
    await client.stop()
  })
})
