import { createServer as createHttpServer, type IncomingMessage, type RequestListener } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { createServer as createNetServer } from 'node:net'
import type { Duplex } from 'node:stream'

/** One listener preserves the management edge's HTTP/TLS behavior, including during recovery. */
export async function startHttpListener(options: {
  readonly host: '127.0.0.1' | '0.0.0.0'
  readonly port: number
  readonly handler: RequestListener
  /** WebSocket and other upgrade requests; without it they are refused. */
  readonly upgrade?: (request: IncomingMessage, socket: Duplex, head: Buffer) => void
  readonly tls?: { readonly key: string; readonly cert: string }
}) {
  const plain = createHttpServer(options.handler)
  const tls = options.tls === undefined ? undefined : createHttpsServer(options.tls, options.handler)
  for (const server of [plain, tls]) {
    server?.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (options.upgrade === undefined) socket.destroy()
      else options.upgrade(request, socket, head)
    })
  }
  const sockets = new Set<Duplex>()
  const listener = createNetServer((socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.once('data', (chunk: Buffer) => {
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
        }
      })()),
  }
}
