import { HostApiContracts } from '@nekro-nxt/contracts'
import { openMigratedCoreDatabase, SqliteHostSecurityRepository } from '@nekro-nxt/storage-sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { once } from 'node:events'
import { createConnection } from 'node:net'
import { connect as connectTls } from 'node:tls'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { browserDeviceLabel, startManagementEdge, type ManagementEdgeHandle } from '../src/management-edge.ts'

interface Reply {
  readonly status: number
  readonly headers: Record<string, string | string[] | undefined>
  readonly text: string
}

const MANAGEMENT_KEY = 'fixture management key for browser login 0123456789'
const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'

const send = (
  protocol: 'http' | 'https',
  port: number,
  pathname: string,
  input: {
    readonly method?: string
    readonly body?: unknown
    readonly headers?: Record<string, string>
  } = {},
): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const encoded = input.body === undefined ? undefined : JSON.stringify(input.body)
    const request = (protocol === 'https' ? httpsRequest : httpRequest)(
      {
        hostname: '127.0.0.1',
        port,
        path: pathname,
        method: input.method ?? 'GET',
        rejectUnauthorized: false,
        headers: {
          'user-agent': CHROME_MAC,
          ...(encoded === undefined
            ? {}
            : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(encoded)) }),
          ...input.headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          }),
        )
      },
    )
    request.once('error', reject)
    request.end(encoded)
  })

const setCookies = (reply: Reply): readonly string[] => {
  const value = reply.headers['set-cookie']
  return value === undefined ? [] : Array.isArray(value) ? value : [value]
}

/** `name=value` pairs a browser would send back. */
const cookieHeader = (cookies: readonly string[]): string =>
  cookies
    .map((entry) => entry.split(';')[0] ?? '')
    .filter((pair) => !pair.endsWith('='))
    .join('; ')

const cookieValue = (cookies: readonly string[], name: string): string | undefined =>
  cookies
    .map((entry) => entry.split(';')[0] ?? '')
    .find((pair) => pair.startsWith(`${name}=`))
    ?.slice(name.length + 1)

describe('browser sign-in through the management edge', () => {
  const roots: string[] = []
  const internals: Server[] = []
  const edges: ManagementEdgeHandle[] = []
  const databases: Awaited<ReturnType<typeof openMigratedCoreDatabase>>[] = []
  afterEach(async () => {
    await Promise.all(edges.splice(0).map((edge) => edge.stop()))
    await Promise.all(internals.splice(0).map((server) => new Promise((resolve) => server.close(resolve))))
    for (const database of databases.splice(0)) database.close()
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  const start = async (options: { readonly trustProxy?: boolean } = {}) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'nxt-edge-browser-'))
    roots.push(root)
    const database = await openMigratedCoreDatabase(path.join(root, 'core.sqlite'))
    databases.push(database)
    const repository = new SqliteHostSecurityRepository(database)
    const internal = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          method: req.method,
          viewer: req.headers['x-nxt-viewer'] ?? null,
          proto: req.headers['x-forwarded-proto'] ?? null,
        }),
      )
    })
    internals.push(internal)
    await new Promise<void>((resolve) => internal.listen(0, '127.0.0.1', resolve))
    const address = internal.address()
    if (address === null || typeof address === 'string') throw new Error('missing internal port')
    const edge = await startManagementEdge({
      host: '127.0.0.1',
      port: 0,
      internalPort: address.port,
      dataRoot: root,
      managementKey: MANAGEMENT_KEY,
      releaseId: 'test-release',
      productVersion: '0.0.0',
      repository,
      ...(options.trustProxy === true ? { trustProxy: true } : {}),
    })
    edges.push(edge)
    return { edge, repository }
  }

  const login = (protocol: 'http' | 'https', port: number, acknowledgeInsecure = protocol === 'http') =>
    send(protocol, port, '/api/management/login', {
      method: 'POST',
      body: { managementKey: MANAGEMENT_KEY, acknowledgeInsecure },
    })

  it('closes idle connections before they select HTTP or TLS', async () => {
    const { edge } = await start()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const socket = createConnection({ host: '127.0.0.1', port: edge.port })
    const closed = once(socket, 'close')
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      await once(socket, 'connect')
      // The client can connect before the server accepts the socket on Windows.
      await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0))
      await vi.advanceTimersByTimeAsync(10_000)
      vi.useRealTimers()
      const timedOut = new Promise<boolean>((resolve) => {
        deadline = setTimeout(() => resolve(false), 1000)
      })
      expect(await Promise.race([closed.then(() => true), timedOut])).toBe(true)
    } finally {
      vi.useRealTimers()
      if (deadline !== undefined) clearTimeout(deadline)
      socket.destroy()
      await closed
    }
  })

  it.each(['http', 'https'] as const)(
    'expires incomplete headers after the connection selects %s',
    async (protocol) => {
      const { edge } = await start()
      const socket =
        protocol === 'http'
          ? createConnection({ host: '127.0.0.1', port: edge.port })
          : connectTls({ host: '127.0.0.1', port: edge.port, rejectUnauthorized: false })
      const closed = once(socket, 'close')
      let response = ''
      socket.on('data', (chunk: Buffer) => {
        response += chunk.toString('utf8')
      })
      let deadline: ReturnType<typeof setTimeout> | undefined
      try {
        await once(socket, protocol === 'http' ? 'connect' : 'secureConnect')
        socket.write('GET /login HTTP/1.1\r\nHost: fixture.test\r\nX-Pending: ')
        const timedOut = new Promise<boolean>((resolve) => {
          deadline = setTimeout(() => resolve(false), 12_500)
        })
        expect(await Promise.race([closed.then(() => true), timedOut])).toBe(true)
        expect(response).toContain('408 Request Timeout')
      } finally {
        if (deadline !== undefined) clearTimeout(deadline)
        socket.destroy()
        await closed
      }
    },
    20_000,
  )

  it.each(['http', 'https'] as const)(
    'accepts a slowly received login body after complete %s headers',
    async (protocol) => {
      const { edge } = await start()
      const socket =
        protocol === 'http'
          ? createConnection({ host: '127.0.0.1', port: edge.port })
          : connectTls({ host: '127.0.0.1', port: edge.port, rejectUnauthorized: false })
      const closed = once(socket, 'close')
      let response = ''
      socket.on('data', (chunk: Buffer) => {
        response += chunk.toString('utf8')
      })
      let deadline: ReturnType<typeof setTimeout> | undefined
      try {
        await once(socket, protocol === 'http' ? 'connect' : 'secureConnect')
        const body = JSON.stringify({ managementKey: MANAGEMENT_KEY, acknowledgeInsecure: true })
        socket.write(
          `POST /api/management/login HTTP/1.1\r\nHost: fixture.test\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body.slice(0, 1)}`,
        )
        // A complete header ends its deadline; receiving the body may take longer than ten seconds.
        await new Promise<void>((resolve) => setTimeout(resolve, 10_500))
        socket.write(body.slice(1))
        const timedOut = new Promise<boolean>((resolve) => {
          deadline = setTimeout(() => resolve(false), 1500)
        })
        expect(await Promise.race([closed.then(() => true), timedOut])).toBe(true)
        expect(response).toContain('200 OK')
      } finally {
        if (deadline !== undefined) clearTimeout(deadline)
        socket.destroy()
        await closed
      }
    },
    20_000,
  )

  it('serves plain HTTP on the same port, asks to accept the risk and keeps the browser signed in', async () => {
    const { edge, repository } = await start()
    const page = await send('http', edge.port, '/channels/chn_fixture?tab=1', { headers: { accept: 'text/html' } })
    expect(page.status).toBe(302)
    expect(page.headers['location']).toBe('/login?next=%2Fchannels%2Fchn_fixture%3Ftab%3D1')
    expect((await send('http', edge.port, '/api/snapshot')).status).toBe(401)

    const loginPage = await send('http', edge.port, '/login?next=%2Fchannels')
    expect(loginPage.status).toBe(200)
    expect(loginPage.text).toContain('当前连接未加密')
    expect(loginPage.text).toContain('"/channels"')

    expect((await login('http', edge.port, false)).status).toBe(400)
    const wrong = await send('http', edge.port, '/api/management/login', {
      method: 'POST',
      body: { managementKey: 'not the key', acknowledgeInsecure: true },
    })
    expect(wrong.status).toBe(401)

    const signedIn = await login('http', edge.port)
    expect(signedIn.status).toBe(200)
    const cookies = setCookies(signedIn)
    const device = cookies.find((entry) => entry.startsWith('nxt_device='))
    expect(device).toMatch(/HttpOnly/u)
    expect(device).toMatch(/Max-Age=2592000/u)
    expect(cookies.every((entry) => !/Secure/u.test(entry))).toBe(true)
    const csrf = cookieValue(cookies, 'nxt_csrf')!
    const browser = cookieHeader(cookies)

    const proxied = await send('http', edge.port, '/api/snapshot', { headers: { cookie: browser } })
    expect(proxied.status).toBe(200)
    const forwarded = z.object({ viewer: z.string(), proto: z.string() }).parse(JSON.parse(proxied.text))
    const deviceId = forwarded.viewer.replace('device:', '')
    expect(forwarded.proto).toBe('http')
    const origin = `http://127.0.0.1:${edge.port}`
    expect(
      (
        await send('http', edge.port, '/api/agents', {
          method: 'POST',
          body: {},
          headers: { cookie: browser, origin, 'x-nxt-csrf': csrf },
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await send('http', edge.port, '/api/agents', {
          method: 'POST',
          body: {},
          headers: { cookie: browser, origin: `https://127.0.0.1:${edge.port}`, 'x-nxt-csrf': csrf },
        })
      ).status,
    ).toBe(403)

    // After a restart the in-memory session is gone; the device cookie alone opens a new one.
    const deviceOnly = `nxt_device=${cookieValue(cookies, 'nxt_device')!}`
    const renewed = await send('http', edge.port, '/', { headers: { cookie: deviceOnly, accept: 'text/html' } })
    expect(renewed.status).toBe(200)
    expect(setCookies(renewed).some((entry) => entry.startsWith('nxt_session='))).toBe(true)
    // The device cookie comes back with the same value and a fresh 30 days.
    const renewedDevice = setCookies(renewed).find((entry) => entry.startsWith('nxt_device='))
    expect(renewedDevice?.startsWith(`${deviceOnly}; `)).toBe(true)
    expect(renewedDevice).toMatch(/Max-Age=2592000; HttpOnly/u)
    expect((await send('http', edge.port, '/login', { headers: { cookie: deviceOnly } })).status).toBe(302)

    const listed = HostApiContracts.listManagementDevices.parseResponse(
      JSON.parse((await send('http', edge.port, '/api/management/devices', { headers: { cookie: browser } })).text),
    )
    expect(listed.devices).toEqual([
      expect.objectContaining({ id: deviceId, label: '浏览器 · Chrome · macOS', current: true }),
    ])
    expect(listed.devices[0]?.lastUsedAt).toBeGreaterThan(0)

    const loggedOut = await send('http', edge.port, '/api/management/session', {
      method: 'DELETE',
      headers: { cookie: browser, origin, 'x-nxt-csrf': csrf },
    })
    expect(loggedOut.status).toBe(200)
    expect(setCookies(loggedOut).some((entry) => entry.startsWith('nxt_device=;'))).toBe(true)
    expect(repository.listDevices()[0]?.revokedAt).toBeDefined()
    expect((await send('http', edge.port, '/api/snapshot', { headers: { cookie: deviceOnly } })).status).toBe(401)
  })

  it('passes only the community sign-in callback through without a session', async () => {
    const { edge } = await start()
    const callback = await send('http', edge.port, '/community/callback?code=c&state=s', {
      headers: { accept: 'text/html' },
    })
    expect(callback.status).toBe(200)
    expect(JSON.parse(callback.text)).toMatchObject({ method: 'GET', viewer: null })
    expect((await send('http', edge.port, '/community/other', { headers: { accept: 'text/html' } })).status).toBe(302)
    expect((await send('http', edge.port, '/api/community/status')).status).toBe(401)
  })

  it('skips the risk notice and marks cookies Secure over HTTPS or a trusted HTTPS proxy', async () => {
    const { edge } = await start()
    const page = await send('https', edge.port, '/login')
    expect(page.status).toBe(200)
    expect(page.text).not.toContain('当前连接未加密')
    const signedIn = await login('https', edge.port)
    expect(signedIn.status).toBe(200)
    expect(setCookies(signedIn).every((entry) => /Secure/u.test(entry))).toBe(true)
    expect((await send('https', edge.port, '/.well-known/nekro-nxt')).status).toBe(200)

    const proxied = await start({ trustProxy: true })
    const forwarded = { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'nxt.example.com' }
    const behindProxy = await send('http', proxied.edge.port, '/login', { headers: forwarded })
    expect(behindProxy.text).not.toContain('当前连接未加密')
    const proxyLogin = await send('http', proxied.edge.port, '/api/management/login', {
      method: 'POST',
      body: { managementKey: MANAGEMENT_KEY },
      headers: forwarded,
    })
    expect(proxyLogin.status).toBe(200)
    const cookies = setCookies(proxyLogin)
    expect(cookies.every((entry) => /Secure/u.test(entry))).toBe(true)
    const mutation = await send('http', proxied.edge.port, '/api/agents', {
      method: 'POST',
      body: {},
      headers: {
        ...forwarded,
        cookie: cookieHeader(cookies),
        origin: 'https://nxt.example.com',
        'x-nxt-csrf': cookieValue(cookies, 'nxt_csrf')!,
      },
    })
    expect(mutation.status).toBe(200)
    // Without trustProxy the same headers change nothing.
    expect((await send('http', edge.port, '/login', { headers: forwarded })).text).toContain('当前连接未加密')
  })

  it('limits login attempts per address and names browsers by their User-Agent', async () => {
    const { edge } = await start()
    const attempts = []
    for (let index = 0; index < 11; index += 1) {
      attempts.push(
        (
          await send('http', edge.port, '/api/management/login', {
            method: 'POST',
            body: { managementKey: 'wrong', acknowledgeInsecure: true },
          })
        ).status,
      )
    }
    expect(attempts.slice(0, 10).every((status) => status === 401)).toBe(true)
    expect(attempts[10]).toBe(429)
    expect(browserDeviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Gecko/20100101 Firefox/131.0')).toBe(
      '浏览器 · Firefox · Windows',
    )
    expect(browserDeviceLabel(undefined)).toBe('浏览器')
  })
})
