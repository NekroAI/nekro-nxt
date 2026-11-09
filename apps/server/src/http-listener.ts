import { createServer as createHttpServer, type RequestListener } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { createServer as createNetServer } from 'node:net'
import type { Duplex } from 'node:stream'

/** One listener preserves the management edge's HTTP/TLS behavior, including during recovery. */
export async function startHttpListener(options: {
  readonly host: '127.0.0.1' | '0.0.0.0'
  readonly port: number
  readonly handler: RequestListener
  readonly tls?: { readonly key: string; readonly cert: string }
}) {
  const httpOptions = { headersTimeout: 10_000, requestTimeout: 300_000, connectionsCheckingInterval: 1000 }
  const plain = createHttpServer(httpOptions, options.handler)
  const tls =
    options.tls === undefined ? undefined : createHttpsServer({ ...options.tls, ...httpOptions }, options.handler)
  const sockets = new Set<Duplex>()
  const listener = createNetServer((socket) => {
    sockets.add(socket)
    // Until a first byte arrives, neither HTTP's header deadline nor TLS's handshake deadline owns this socket.
    const firstByteDeadline = setTimeout(() => socket.destroy(), 10_000)
    firstByteDeadline.unref()
    socket.once('error', () => socket.destroy())
    socket.once('close', () => {
      clearTimeout(firstByteDeadline)
      sockets.delete(socket)
    })
    socket.once('data', (chunk: Buffer) => {
      clearTimeout(firstByteDeadline)
      socket.pause()
      socket.unshift(chunk)
      ;(chunk[0] === 0x16 && tls !== undefined ? tls : plain).emit('connection', socket)
      process.nextTick(() => socket.resume())
    })
  })
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject)
    listener.listen(options.port, options.host, () => {
      listener.off('error', reject)
      // Forward the listener lifecycle too: Node starts HTTP request/header deadline
      // tracking on `listening`, not when a socket is handed to `connection`.
      plain.emit('listening')
      tls?.emit('listening')
      resolve()
    })
  })
  const address = listener.address()
  if (address === null || typeof address === 'string') throw new Error('HTTP listener has no bound port.')
  let stopped: Promise<void> | undefined
  return {
    port: address.port,
    stop: (): Promise<void> =>
      (stopped ??= (async () => {
        plain.closeIdleConnections()
        tls?.closeIdleConnections()
        const closed = new Promise<void>((resolve, reject) =>
          listener.close((error) => (error ? reject(error) : resolve())),
        )
        const timeout = setTimeout(() => {
          for (const socket of sockets) socket.destroy()
          plain.closeAllConnections()
          tls?.closeAllConnections()
        }, 5000)
        timeout.unref()
        try {
          await closed
        } finally {
          clearTimeout(timeout)
          for (const socket of sockets) socket.destroy()
          sockets.clear()
          // close() releases the HTTP deadline trackers even though the TCP handle
          // belongs to the outer listener.
          plain.close()
          tls?.close()
        }
      })()),
  }
}
