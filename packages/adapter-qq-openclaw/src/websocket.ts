import WebSocket, { type RawData } from 'ws'
import type { QQGatewaySocket, QQGatewaySocketFactory } from './gateway.js'

interface QueueWaiter {
  readonly resolve: (value: IteratorResult<string>) => void
  readonly reject: (error: Error) => void
}

class WebSocketMessageQueue implements AsyncIterable<string> {
  readonly #values: string[] = []
  readonly #waiters: QueueWaiter[] = []
  #ended = false
  #error: Error | undefined

  push(value: string): void {
    const waiter = this.#waiters.shift()
    if (waiter) waiter.resolve({ done: false, value })
    else if (!this.#ended) this.#values.push(value)
  }

  end(): void {
    this.#ended = true
    for (const waiter of this.#waiters.splice(0)) waiter.resolve({ done: true, value: undefined })
  }

  fail(error: Error): void {
    this.#error = error
    this.#ended = true
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error)
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: () => {
        const value = this.#values.shift()
        if (value !== undefined) return Promise.resolve({ done: false, value })
        if (this.#error !== undefined) return Promise.reject(this.#error)
        if (this.#ended) return Promise.resolve({ done: true, value: undefined })
        return new Promise<IteratorResult<string>>((resolve, reject) => {
          this.#waiters.push({ resolve, reject })
        })
      },
    }
  }
}

const rawText = (data: RawData): string =>
  typeof data === 'string'
    ? data
    : Array.isArray(data)
      ? Buffer.concat(data).toString('utf8')
      : data instanceof ArrayBuffer
        ? Buffer.from(new Uint8Array(data)).toString('utf8')
        : Buffer.from(data).toString('utf8')

/** Node WebSocket implementation used by both Desktop main process and Server Host. */
export class QQNodeWebSocketFactory implements QQGatewaySocketFactory {
  async connect(url: string, signal: AbortSignal): Promise<QQGatewaySocket> {
    if (signal.aborted) throw signal.reason
    const socket = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      const opened = (): void => {
        cleanup()
        resolve()
      }
      const failed = (error: Error): void => {
        cleanup()
        reject(new Error('QQ Gateway WebSocket connection failed.', { cause: error }))
      }
      const aborted = (): void => {
        cleanup()
        socket.close(1000, 'aborted')
        reject(signal.reason instanceof Error ? signal.reason : new Error('QQ Gateway connection aborted.'))
      }
      const cleanup = (): void => {
        socket.off('open', opened)
        socket.off('error', failed)
        signal.removeEventListener('abort', aborted)
      }
      socket.once('open', opened)
      socket.once('error', failed)
      signal.addEventListener('abort', aborted, { once: true })
    })

    const queue = new WebSocketMessageQueue()
    socket.on('message', (data) => queue.push(rawText(data)))
    socket.on('error', (error) => queue.fail(new Error('QQ Gateway WebSocket failed.', { cause: error })))
    socket.on('close', () => queue.end())
    const abort = (): void => socket.close(1000, 'aborted')
    signal.addEventListener('abort', abort, { once: true })

    return {
      messages: queue,
      send: (payload) =>
        new Promise<void>((resolve, reject) => {
          if (socket.readyState !== WebSocket.OPEN) {
            reject(new Error('QQ Gateway WebSocket is not open.'))
            return
          }
          socket.send(payload, (error) => (error ? reject(error) : resolve()))
        }),
      close: (code = 1000, reason = 'closed') => {
        signal.removeEventListener('abort', abort)
        if (socket.readyState === WebSocket.CLOSED) return Promise.resolve()
        return new Promise<void>((resolve) => {
          socket.once('close', () => resolve())
          socket.close(code, reason)
        })
      },
    }
  }
}
