import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { OneBotWebSocketClient, type OneBotActionError } from '../src/transport.ts'
import { createFakeContext, waitFor } from './helpers.ts'

const servers: WebSocketServer[] = []
const RequestSchema = z.record(z.string(), z.unknown())
const decodeRequest = (raw: RawData): Record<string, unknown> =>
  RequestSchema.parse(
    JSON.parse(
      Array.isArray(raw)
        ? Buffer.concat(raw).toString('utf8')
        : raw instanceof ArrayBuffer
          ? Buffer.from(raw).toString('utf8')
          : raw.toString('utf8'),
    ),
  )

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          for (const client of server.clients) client.terminate()
          server.close(() => resolve())
        }),
    ),
  )
})

const serve = async (onConnection: (socket: WebSocket, authorization: string | undefined) => void) => {
  const server = new WebSocketServer({ port: 0 })
  servers.push(server)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  server.on('connection', (socket, request) => onConnection(socket, request.headers.authorization))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test WebSocket did not bind TCP.')
  return `ws://127.0.0.1:${address.port}/universal`
}

describe('OneBot forward WebSocket transport', () => {
  it('uses Bearer Authorization and correlates out-of-order replies by echo', async () => {
    const requests: Record<string, unknown>[] = []
    let authorization: string | undefined
    const endpoint = await serve((socket, header) => {
      authorization = header
      socket.on('message', (raw) => {
        const request = decodeRequest(raw)
        requests.push(request)
        const action = request['action']
        if (action === 'get_login_info')
          socket.send(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: '90001' }, echo: request['echo'] }))
        else if (action === 'get_version_info')
          socket.send(
            JSON.stringify({
              status: 'ok',
              retcode: 0,
              data: { app_name: 'Synthetic OneBot', app_version: '1.0.0', protocol_version: 'v11' },
              echo: request['echo'],
            }),
          )
        else if (requests.filter((item) => item['action'] === 'custom').length === 2) {
          for (const item of requests.filter((candidate) => candidate['action'] === 'custom').reverse()) {
            socket.send(JSON.stringify({ status: 'ok', retcode: 0, data: item['params'], echo: item['echo'] }))
          }
        }
      })
    })
    const fake = createFakeContext()
    const client = new OneBotWebSocketClient({
      context: fake.context,
      endpoint,
      accessToken: 'fixture-token',
      onEvent: () => Promise.resolve(),
      reconnectDelaysMs: [5],
    })
    await client.start()
    await waitFor(() => client.connected)
    const first = client.call('custom', { order: 1 })
    const second = client.call('custom', { order: 2 })
    await expect(Promise.all([first, second])).resolves.toEqual([{ order: 1 }, { order: 2 }])
    expect(authorization).toBe('Bearer fixture-token')
    expect(requests.every((request) => typeof request['echo'] === 'string')).toBe(true)
    await client.stop()
  })

  it('caches only explicit unsupported optional actions', async () => {
    const endpoint = await serve((socket) => {
      socket.on('message', (raw) => {
        const request = decodeRequest(raw)
        const action = request['action']
        const response =
          action === 'get_login_info'
            ? { status: 'ok', retcode: 0, data: { user_id: '90002' }, echo: request['echo'] }
            : action === 'get_version_info'
              ? { status: 'ok', retcode: 0, data: {}, echo: request['echo'] }
              : { status: 'failed', retcode: 1404, message: 'unsupported action', data: null, echo: request['echo'] }
        socket.send(JSON.stringify(response))
      })
    })
    const fake = createFakeContext()
    const client = new OneBotWebSocketClient({ context: fake.context, endpoint, onEvent: () => Promise.resolve() })
    await client.start()
    await waitFor(() => client.connected)
    await expect(client.callOptional('send_poke', {})).rejects.toMatchObject({
      kind: 'unsupported',
    } satisfies Partial<OneBotActionError>)
    expect(client.optionalCapability('send_poke')).toBe('unsupported')
    await expect(client.callOptional('send_poke', {})).rejects.toMatchObject({ submitted: false })
    await client.stop()
  })

  it('rejects an Endpoint that changes the locked self account', async () => {
    const endpoint = await serve((socket) => {
      socket.on('message', (raw) => {
        const request = decodeRequest(raw)
        const data = request['action'] === 'get_login_info' ? { user_id: 'replacement-account' } : {}
        socket.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: request['echo'] }))
      })
    })
    const fake = createFakeContext()
    fake.states.set('onebot-11/account-lock', { selfId: 'locked-account' })
    const client = new OneBotWebSocketClient({
      context: fake.context,
      endpoint,
      onEvent: () => Promise.resolve(),
      reconnectDelaysMs: [5],
    })
    await client.start()
    await waitFor(() =>
      fake.diagnostics.some(({ status, message }) => status === 'failed' && message?.includes('另一个账号') === true),
    )
    expect(client.connected).toBe(false)
    await client.stop()
  })

  it('marks a submitted Action unknown when the socket closes before its receipt and then reconnects', async () => {
    let connections = 0
    const endpoint = await serve((socket) => {
      connections += 1
      socket.on('message', (raw) => {
        const request = decodeRequest(raw)
        const action = request['action']
        if (action === 'get_login_info' || action === 'get_version_info') {
          socket.send(
            JSON.stringify({
              status: 'ok',
              retcode: 0,
              data: action === 'get_login_info' ? { user_id: '90003' } : {},
              echo: request['echo'],
            }),
          )
        } else socket.terminate()
      })
    })
    const fake = createFakeContext()
    const client = new OneBotWebSocketClient({
      context: fake.context,
      endpoint,
      onEvent: () => Promise.resolve(),
      reconnectDelaysMs: [5],
    })
    await client.start()
    await waitFor(() => client.connected)
    await expect(client.call('custom', {})).rejects.toMatchObject({ kind: 'unknown', submitted: true })
    await waitFor(() => connections >= 2 && client.connected)
    await client.stop()
    const settledConnections = connections
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(connections).toBe(settledConnections)
  })

  it('times out submitted Actions as unknown and serializes inbound event handling', async () => {
    let releaseFirst: (() => void) | undefined
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const eventOrder: string[] = []
    const endpoint = await serve((socket) => {
      socket.on('message', (raw) => {
        const request = decodeRequest(raw)
        const action = request['action']
        if (action === 'get_login_info' || action === 'get_version_info') {
          socket.send(
            JSON.stringify({
              status: 'ok',
              retcode: 0,
              data: action === 'get_login_info' ? { user_id: '90004' } : {},
              echo: request['echo'],
            }),
          )
          if (action === 'get_version_info') {
            socket.send(JSON.stringify({ post_type: 'notice', sequence: 1 }))
            socket.send(JSON.stringify({ post_type: 'notice', sequence: 2 }))
          }
        }
      })
    })
    const fake = createFakeContext()
    const client = new OneBotWebSocketClient({
      context: fake.context,
      endpoint,
      requestTimeoutMs: 20,
      onEvent: async (event) => {
        const sequence = Number(event['sequence'])
        eventOrder.push(`start:${sequence}`)
        if (sequence === 1) await firstBlocked
        eventOrder.push(`finish:${sequence}`)
      },
    })
    await client.start()
    await waitFor(() => eventOrder.includes('start:1'))
    expect(eventOrder).toEqual(['start:1'])
    releaseFirst!()
    await waitFor(() => eventOrder.length === 4)
    expect(eventOrder).toEqual(['start:1', 'finish:1', 'start:2', 'finish:2'])
    await expect(client.call('never-replied', {})).rejects.toMatchObject({ kind: 'unknown', submitted: true })
    await client.stop()
  })
})
