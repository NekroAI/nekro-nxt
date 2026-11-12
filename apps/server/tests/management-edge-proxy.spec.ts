import { openMigratedCoreDatabase, SqliteHostSecurityRepository } from '@nekro-nxt/storage-sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { connect, type Socket } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseDevelopmentProxyPages, parseTrustProxy } from '../src/main.ts'
import { parseDevelopmentWebOrigin, startManagementEdge, type ManagementEdgeHandle } from '../src/management-edge.ts'

/** Documentation-range addresses (RFC 5737), assembled so no literal address appears in the source. */
const testAddress = (host: number): string => ['203', '0', '113', String(host)].join('.')

interface Reply {
  readonly status: number
  readonly headers: Record<string, string | string[] | undefined>
  readonly text: string
}

const MANAGEMENT_KEY = 'fixture management key for proxy access 0123456789'

const send = (
  port: number,
  pathname: string,
  input: { readonly method?: string; readonly body?: unknown; readonly headers?: Record<string, string> } = {},
): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const encoded = input.body === undefined ? undefined : JSON.stringify(input.body)
    const request = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path: pathname,
        method: input.method ?? 'GET',
        headers: {
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

const sessionCookies = (reply: Reply): string => {
  const value = reply.headers['set-cookie']
  return (value === undefined ? [] : Array.isArray(value) ? value : [value])
    .map((entry) => entry.split(';')[0] ?? '')
    .join('; ')
}

/** Opens a raw WebSocket-style upgrade and returns the first bytes the other side sends back. */
const upgrade = (port: number, cookie: string | undefined, headers: Record<string, string> = {}): Promise<string> =>
  new Promise((resolve, reject) => {
    const socket: Socket = connect(port, '127.0.0.1', () => {
      socket.write(
        [
          'GET /?token=fixture HTTP/1.1',
          `host: 127.0.0.1:${port}`,
          'connection: Upgrade',
          'upgrade: websocket',
          ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
          ...(cookie === undefined ? [] : [`cookie: ${cookie}`]),
          '',
          '',
        ].join('\r\n'),
      )
    })
    let received = ''
    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString('utf8')
      if (received.includes('\r\n\r\n')) {
        socket.end()
        resolve(received)
      }
    })
    socket.once('error', reject)
    socket.once('close', () => resolve(received))
  })

const listen = async (server: Server): Promise<number> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing port')
  return address.port
}

describe('management edge behind a reverse proxy and in development', () => {
  const roots: string[] = []
  const servers: Server[] = []
  const edges: ManagementEdgeHandle[] = []
  const databases: Awaited<ReturnType<typeof openMigratedCoreDatabase>>[] = []
  afterEach(async () => {
    await Promise.all(edges.splice(0).map((edge) => edge.stop()))
    const closingServers = servers.splice(0)
    for (const server of closingServers) server.closeAllConnections()
    await Promise.all(closingServers.map((server) => new Promise((resolve) => server.close(resolve))))
    for (const database of databases.splice(0)) database.close()
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  const start = async (
    options: {
      readonly trustProxy?: boolean | readonly string[]
      readonly development?: boolean
      readonly builtPagesForProxy?: boolean
    } = {},
  ) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'nxt-edge-proxy-'))
    roots.push(root)
    const database = await openMigratedCoreDatabase(path.join(root, 'core.sqlite'))
    databases.push(database)
    const repository = new SqliteHostSecurityRepository(database)
    const answer = (name: string) => (req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(`${name} ${req.url ?? ''} host=${req.headers.host ?? ''}`)
    }
    const internal = createServer(answer('server'))
    servers.push(internal)
    const internalPort = await listen(internal)
    let developmentWebOrigin: string | undefined
    if (options.development === true) {
      const vite = createServer(answer('vite'))
      vite.on('upgrade', (req: IncomingMessage, socket: Socket) => {
        socket.end(
          `HTTP/1.1 101 Switching Protocols\r\nx-upgraded-by: vite\r\nx-host: ${req.headers.host ?? ''}\r\n\r\n`,
        )
      })
      servers.push(vite)
      developmentWebOrigin = `http://127.0.0.1:${await listen(vite)}`
    }
    const edge = await startManagementEdge({
      host: '127.0.0.1',
      port: 0,
      internalPort,
      dataRoot: root,
      managementKey: MANAGEMENT_KEY,
      releaseId: 'test-release',
      productVersion: '0.0.0',
      repository,
      ...(options.trustProxy === undefined ? {} : { trustProxy: options.trustProxy }),
      ...(developmentWebOrigin === undefined ? {} : { developmentWebOrigin }),
      ...(options.builtPagesForProxy === true ? { developmentBuiltPagesForProxy: true } : {}),
    })
    edges.push(edge)
    return edge
  }

  const login = (port: number, headers: Record<string, string> = {}, managementKey = MANAGEMENT_KEY) =>
    send(port, '/api/management/login', {
      method: 'POST',
      body: { managementKey, acknowledgeInsecure: true },
      headers,
    })

  it('sends pages and hot updates to the dev server only after sign-in, and the Server paths to the Server', async () => {
    const edge = await start({ development: true })
    expect((await send(edge.port, '/src/main.tsx')).status).toBe(401)
    expect((await send(edge.port, '/work', { headers: { accept: 'text/html' } })).status).toBe(302)
    expect(await upgrade(edge.port, undefined)).toMatch(/^HTTP\/1\.1 403/u)

    const cookie = sessionCookies(await login(edge.port))
    expect((await send(edge.port, '/src/main.tsx', { headers: { cookie } })).text).toMatch(
      /^vite \/src\/main\.tsx host=127\.0\.0\.1:\d+$/u,
    )
    expect((await send(edge.port, '/api/snapshot', { headers: { cookie } })).text).toMatch(/^server \/api\/snapshot/u)
    expect((await send(edge.port, '/health/ready', { headers: { cookie } })).text).toMatch(/^server /u)
    const upgraded = await upgrade(edge.port, cookie)
    expect(upgraded).toMatch(/^HTTP\/1\.1 101/u)
    expect(upgraded).toContain('x-upgraded-by: vite')
  })

  it('refuses upgrades outside development even when signed in', async () => {
    const edge = await start()
    const cookie = sessionCookies(await login(edge.port))
    expect(await upgrade(edge.port, cookie)).toMatch(/^HTTP\/1\.1 403/u)
  })

  it('counts sign-in attempts per client behind a trusted proxy, by the address the proxy appended', async () => {
    const edge = await start({ trustProxy: true })
    // The client wrote its own first entry; the proxy appended the real address.
    const attacker = { 'x-forwarded-for': `${testAddress(7)}, ${testAddress(9)}` }
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await login(edge.port, attacker, 'wrong management key 0123456789 abcdefgh')).status).toBe(401)
    }
    expect((await login(edge.port, { 'x-forwarded-for': `${testAddress(8)}, ${testAddress(9)}` })).status).toBe(429)
    expect((await login(edge.port, { 'x-forwarded-for': `${testAddress(10)}` })).status).toBe(200)
  })

  it('takes forwarded headers only from the listed proxy addresses', async () => {
    const wrong = 'wrong management key 0123456789 abcdefgh'
    // This machine is the proxy: the address it appended names the client.
    const listed = await start({ trustProxy: ['127.0.0.1/8', '::1'] })
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await login(listed.port, { 'x-forwarded-for': testAddress(7) }, wrong)).status).toBe(401)
    }
    expect((await login(listed.port, { 'x-forwarded-for': testAddress(8) })).status).toBe(200)

    // The proxy is elsewhere, so a direct connection cannot pick its own address or claim HTTPS.
    const elsewhere = await start({ trustProxy: [testAddress(9)] })
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await login(elsewhere.port, { 'x-forwarded-for': testAddress(attempt + 20) }, wrong)).status).toBe(401)
    }
    expect((await login(elsewhere.port, { 'x-forwarded-for': testAddress(40) })).status).toBe(429)
    const page = await send(elsewhere.port, '/login', { headers: { 'x-forwarded-proto': 'https' } })
    expect(page.text).toContain('"secure":false')
  })

  it('reads the proxy addresses from NEKRO_TRUST_PROXY', () => {
    expect(parseTrustProxy(undefined)).toBe(false)
    expect(parseTrustProxy('0')).toBe(false)
    expect(parseTrustProxy('1')).toBe(true)
    expect(parseTrustProxy(`${testAddress(9)}, ${testAddress(0)}/24,::1`)).toEqual([
      testAddress(9),
      `${testAddress(0)}/24`,
      '::1',
    ])
    for (const input of ['yes', 'proxy.example.test', `${testAddress(9)}/33`, `${testAddress(0)}/8/8`, '::1/129']) {
      expect(() => parseTrustProxy(input)).toThrow('NEKRO_TRUST_PROXY')
    }
  })

  it('gives requests from the trusted proxy the built pages and keeps the dev server for direct ones', async () => {
    const edge = await start({ development: true, trustProxy: ['127.0.0.1', '::1'], builtPagesForProxy: true })
    const cookie = sessionCookies(await login(edge.port))
    const proxied = { cookie, 'x-forwarded-for': testAddress(7), 'x-forwarded-proto': 'https' }
    expect((await send(edge.port, '/live', { headers: proxied })).text).toMatch(/^server \/live/u)
    expect((await send(edge.port, '/assets/index.js', { headers: proxied })).text).toMatch(/^server /u)
    expect((await send(edge.port, '/live', { headers: { cookie } })).text).toMatch(/^vite \/live/u)
    // Built pages have no hot updates to connect to.
    expect(await upgrade(edge.port, cookie, { 'x-forwarded-for': testAddress(7) })).toMatch(/^HTTP\/1\.1 403/u)
    expect(await upgrade(edge.port, cookie)).toMatch(/^HTTP\/1\.1 101/u)

    // Elsewhere the proxy is not trusted, so its headers change nothing.
    const untrusted = await start({ development: true, trustProxy: [testAddress(9)], builtPagesForProxy: true })
    const other = sessionCookies(await login(untrusted.port))
    expect((await send(untrusted.port, '/live', { headers: { ...proxied, cookie: other } })).text).toMatch(
      /^vite \/live/u,
    )
  })

  it('reads NEKRO_DEV_PROXY_PAGES only next to a dev server', () => {
    expect(parseDevelopmentProxyPages(undefined, undefined)).toBe(false)
    expect(parseDevelopmentProxyPages('built', 'http://127.0.0.1:4961')).toBe(true)
    expect(() => parseDevelopmentProxyPages('built', undefined)).toThrow('NEKRO_DEV_WEB_ORIGIN')
    expect(() => parseDevelopmentProxyPages('vite', 'http://127.0.0.1:4961')).toThrow('NEKRO_DEV_PROXY_PAGES')
  })

  it('accepts only a dev server on this machine', () => {
    expect(parseDevelopmentWebOrigin(undefined)).toBeUndefined()
    expect(parseDevelopmentWebOrigin('http://localhost:4961')).toBe('http://127.0.0.1:4961')
    for (const input of [
      'https://127.0.0.1:4961',
      'http://example.test:4961',
      'http://127.0.0.1',
      'http://127.0.0.1:4961/app',
    ]) {
      expect(() => parseDevelopmentWebOrigin(input)).toThrow('NEKRO_DEV_WEB_ORIGIN')
    }
  })
})
