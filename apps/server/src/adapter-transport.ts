import type { AdapterTransportService, AdapterWebSocketConnection, AdapterWebSocketEvent } from '@nekro-nxt/adapter-sdk'
import WebSocket, { type RawData } from 'ws'

const websocketData = (data: RawData): string | Uint8Array => {
  if (typeof data === 'string') return data
  if (Array.isArray(data)) {
    const joined = Buffer.concat(data)
    return new Uint8Array(joined.buffer, joined.byteOffset, joined.byteLength)
  }
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}

export const createProductionAdapterTransport = (fetchImpl: typeof fetch = fetch): AdapterTransportService => ({
  request: async (input) => {
    const body = input.body instanceof Uint8Array ? Uint8Array.from(input.body).buffer : input.body
    const response = await fetchImpl(input.url, {
      method: input.method ?? 'GET',
      ...(input.headers === undefined ? {} : { headers: input.headers }),
      ...(body === undefined ? {} : { body }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: new Uint8Array(await response.arrayBuffer()),
    }
  },
  connectWebSocket: (input) => {
    const listeners = new Set<(event: AdapterWebSocketEvent) => void>()
    const publish = (event: AdapterWebSocketEvent): void => {
      for (const listener of listeners) listener(event)
    }
    const protocols =
      input.protocols === undefined || typeof input.protocols === 'string' ? input.protocols : [...input.protocols]
    const socket = new WebSocket(input.url, protocols, {
      ...(input.headers === undefined ? {} : { headers: input.headers }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    socket.on('open', () => publish({ type: 'open' }))
    socket.on('message', (data) => publish({ type: 'message', data: websocketData(data) }))
    socket.on('close', (code, reason) => publish({ type: 'close', code, reason: reason.toString('utf8') }))
    socket.on('error', (error) => publish({ type: 'error', message: error.message }))
    const connection: AdapterWebSocketConnection = {
      send: (data) =>
        new Promise<void>((resolve, reject) => {
          socket.send(data, (error) => (error ? reject(error) : resolve()))
        }),
      close: (code, reason) =>
        new Promise<void>((resolve) => {
          if (socket.readyState === WebSocket.CLOSED) return resolve()
          socket.once('close', () => resolve())
          socket.close(code, reason)
        }),
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    }
    return Promise.resolve(connection)
  },
})
