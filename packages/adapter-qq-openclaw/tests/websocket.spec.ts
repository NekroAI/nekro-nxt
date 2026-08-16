import type WebSocket from 'ws'
import { type RawData, WebSocketServer } from 'ws'
import { describe, expect, it } from 'vitest'
import { QQNodeWebSocketFactory } from '../src/index.ts'

describe('QQ Node WebSocket factory', () => {
  it('provides an AsyncIterable socket and reaches a closed state', async () => {
    const server = new WebSocketServer({ port: 0 })
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const address = server.address()
    if (typeof address === 'string' || address === null) throw new Error('WebSocket test server has no TCP port.')
    const connected = new Promise<WebSocket>((resolve) => server.once('connection', resolve))
    const socket = await new QQNodeWebSocketFactory().connect(
      `ws://localhost:${address.port}`,
      new AbortController().signal,
    )
    const peer = await connected
    const received = new Promise<RawData>((resolve) => peer.once('message', resolve))
    await socket.send('client-message')
    const clientPayload = await received
    const clientText = Array.isArray(clientPayload)
      ? Buffer.concat(clientPayload).toString('utf8')
      : clientPayload instanceof ArrayBuffer
        ? Buffer.from(new Uint8Array(clientPayload)).toString('utf8')
        : Buffer.from(clientPayload).toString('utf8')
    expect(clientText).toBe('client-message')

    const next = socket.messages[Symbol.asyncIterator]().next()
    peer.send('server-message')
    await expect(next).resolves.toEqual({ done: false, value: 'server-message' })
    await socket.close()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  })
})
