import { createServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertSameOriginRemoteUrl,
  fetchSameOriginRemote,
  installSameOriginNavigationGuard,
} from '../src/remote-navigation.ts'
import type { RemoteFetch } from '../src/remote-navigation.ts'

const servers: ReturnType<typeof createServer>[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

const listen = async (server: ReturnType<typeof createServer>): Promise<string> => {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  servers.push(server)
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('测试 HTTP Server 未获得端口。')
  return `http://127.0.0.1:${address.port}`
}

describe('Desktop remote navigation boundary', () => {
  it('uses redirect:error and never forwards a device secret to a redirected origin', async () => {
    let redirectedRequests = 0
    let redirectedBody = ''
    const targetOrigin = await listen(
      createServer((request, response) => {
        redirectedRequests += 1
        request.setEncoding('utf8')
        request.on('data', (chunk: string) => (redirectedBody += chunk))
        request.on('end', () => response.end('{}'))
      }),
    )
    const sourceOrigin = await listen(
      createServer((_request, response) => {
        response.writeHead(307, { location: `${targetOrigin}/capture` })
        response.end()
      }),
    )

    await expect(
      fetchSameOriginRemote(fetch, sourceOrigin, '/api/management/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceSecret: 'must-not-leak' }),
      }),
    ).rejects.toThrow()
    expect(redirectedRequests).toBe(0)
    expect(redirectedBody).toBe('')
  })

  it('rejects a mismatched final response URL and guards both navigation event types', async () => {
    const origin = 'https://nxt.example.test:7443'
    class OtherOriginResponse extends Response {
      override get url(): string {
        return 'https://other.example.test/result'
      }
    }
    const fetcher = vi.fn<RemoteFetch>(() => Promise.resolve(new OtherOriginResponse('{}')))
    await expect(fetchSameOriginRemote(fetcher, origin, '/api/management/session')).rejects.toMatchObject({
      code: 'unsafe-redirect',
    })
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' })

    const listeners = new Map<string, (event: { preventDefault(): void }, target: string) => void>()
    installSameOriginNavigationGuard({ on: (event, listener) => listeners.set(event, listener) }, origin)
    for (const eventName of ['will-navigate', 'will-redirect']) {
      const preventDefault = vi.fn()
      listeners.get(eventName)?.({ preventDefault }, 'http://127.0.0.1:4960/steal')
      expect(preventDefault, eventName).toHaveBeenCalledOnce()
    }
    expect(() => assertSameOriginRemoteUrl(origin, `${origin}/work`)).not.toThrow()
    expect(() => assertSameOriginRemoteUrl(origin, 'https://other.example.test/work')).toThrow(
      expect.objectContaining({ code: 'unsafe-redirect' }),
    )
  })
})
