import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createExtensionEgress,
  EXTENSION_FETCH_DEFAULT_TIMEOUT_MS,
  ExtensionEgressError,
  type ExtensionEgressPolicy,
} from '../src/extension-egress.js'

interface Received {
  readonly url: string
  readonly method: string
  readonly headers: IncomingMessage['headers']
  readonly body: Buffer
}

let server: Server
let port = 0
const received: Received[] = []

const readBody = (request: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })

beforeEach(async () => {
  received.length = 0
  server = createServer((request, response) => {
    void readBody(request).then((body) => {
      received.push({ url: request.url ?? '', method: request.method ?? '', headers: request.headers, body })
      const url = request.url ?? '/'
      if (url === '/json') {
        response.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'session=fixture' })
        response.end('{"ok":true}')
      } else if (url === '/xhtml') {
        response.writeHead(200, { 'content-type': 'application/xhtml+xml; charset=utf-8' })
        response.end('<html xmlns="http://www.w3.org/1999/xhtml"><body>页面</body></html>')
      } else if (url === '/binary') {
        response.writeHead(200, { 'content-type': 'image/png' })
        response.end(Buffer.from([0, 255, 1, 254]))
      } else if (url === '/large') {
        response.writeHead(200, { 'content-type': 'text/plain' })
        response.end('x'.repeat(2048))
      } else if (url === '/chunked') {
        // No content-length: the size is only known while reading.
        response.writeHead(200, { 'content-type': 'video/mp4' })
        response.write('v'.repeat(1500))
        setTimeout(() => response.end('v'.repeat(1500)), 10)
      } else if (url === '/slow') {
        setTimeout(() => response.end('late'), 500)
      } else if (url === '/echo') {
        response.writeHead(200, { 'content-type': 'application/octet-stream' })
        response.end(body)
      } else if (url.startsWith('/redirect-to/')) {
        response.writeHead(302, { location: decodeURIComponent(url.slice('/redirect-to/'.length)) })
        response.end()
      } else if (url.startsWith('/temporary-to/')) {
        response.writeHead(307, { location: decodeURIComponent(url.slice('/temporary-to/'.length)) })
        response.end()
      } else if (url.startsWith('/json?')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{"ok":true}')
      } else if (url === '/see-other') {
        response.writeHead(303, { location: '/json' })
        response.end()
      } else if (url === '/loop') {
        response.writeHead(302, { location: '/loop' })
        response.end()
      } else {
        response.writeHead(404)
        response.end()
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Fixture server has no TCP port.')
  port = address.port
})

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

/** Fictional public hostnames resolve to the local fixture server; the private check is the only test seam. */
const egressFor = (policy: ExtensionEgressPolicy, options: { readonly realPrivateCheck?: boolean } = {}) =>
  createExtensionEgress({
    policy,
    timeoutMs: 200,
    maxResponseBytes: 1024,
    resolve: () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]),
    ...(options.realPrivateCheck === true ? {} : { isPrivateAddress: () => false }),
  })

const failure = async (promise: Promise<unknown>): Promise<ExtensionEgressError> => {
  try {
    await promise
  } catch (error) {
    if (error instanceof ExtensionEgressError) return error
    throw error
  }
  throw new Error('Expected the request to fail.')
}

describe('extension egress', () => {
  it('allows declared domains and wildcard subdomains, rejecting the bare wildcard domain', async () => {
    const egress = egressFor({ mode: 'domains', domains: ['api.example.com', '*.cdn.example.com'] })
    expect((await egress.fetch(`http://api.example.com:${port}/json`)).status).toBe(200)
    expect((await egress.fetch(`http://img.cdn.example.com:${port}/json`)).status).toBe(200)
    expect((await failure(egress.fetch(`http://cdn.example.com:${port}/json`))).code).toBe('policy-denied')
    expect((await failure(egress.fetch(`http://other.example.org:${port}/json`))).message).toContain(
      'permissions.capabilities.network.domains',
    )
  })

  it('returns text for textual content, base64 otherwise, and strips set-cookie', async () => {
    const egress = egressFor({ mode: 'unrestricted' })
    const json = await egress.fetch(`http://data.example.com:${port}/json`)
    expect(json).toMatchObject({ status: 200, text: '{"ok":true}', contentType: 'application/json' })
    expect(json.headers['set-cookie']).toBeUndefined()
    const xhtml = await egress.fetch(`http://data.example.com:${port}/xhtml`)
    expect(xhtml.text).toContain('页面')
    expect(xhtml.base64).toBeUndefined()
    const binary = await egress.fetch(`http://data.example.com:${port}/binary`)
    expect(binary.text).toBeUndefined()
    expect(Buffer.from(binary.base64 ?? '', 'base64')).toEqual(Buffer.from([0, 255, 1, 254]))
  })

  it('blocks private addresses in every mode unless the user configured that exact host', async () => {
    for (const policy of [{ mode: 'unrestricted' }, { mode: 'domains', domains: ['intranet.example.com'] }] as const) {
      const egress = egressFor(policy, { realPrivateCheck: true })
      expect((await failure(egress.fetch(`http://intranet.example.com:${port}/json`))).code).toBe('private-address')
    }
    const configured = egressFor(
      { mode: 'config', hosts: [`intranet.example.com:${port}`] },
      { realPrivateCheck: true },
    )
    expect((await configured.fetch(`http://intranet.example.com:${port}/json`)).status).toBe(200)
    expect((await failure(configured.fetch(`http://other.example.com:${port}/json`))).code).toBe('policy-denied')
    // A host only the agent provided may be reached on the public internet, never on a private network.
    const provided = egressFor(
      { mode: 'config', hosts: [`intranet.example.com:${port}`], privateHosts: [] },
      { realPrivateCheck: true },
    )
    expect((await failure(provided.fetch(`http://intranet.example.com:${port}/json`))).code).toBe('private-address')
  })

  it('lets unrestricted mode reach a private address only when it is a configured host a person entered', async () => {
    // `*.localhost` names count as private by name, so public names still reach the fixture server.
    const nas = `nas.localhost:${port}`
    const open = egressFor({ mode: 'unrestricted', hosts: [nas] })
    expect((await open.fetch(`http://${nas}/json`)).status).toBe(200)
    expect((await open.fetch(`http://images.example.com:${port}/json`)).status).toBe(200)
    expect((await failure(open.fetch(`http://other.localhost:${port}/json`))).code).toBe('private-address')
    // The port is part of the configured host.
    expect((await failure(open.fetch(`http://nas.localhost:${port + 1}/json`))).code).toBe('private-address')

    // Without address fields, and for addresses only the agent provided, private hosts stay blocked.
    for (const policy of [
      { mode: 'unrestricted' },
      { mode: 'unrestricted', hosts: [nas], privateHosts: [] },
    ] as const) {
      expect((await failure(egressFor(policy).fetch(`http://${nas}/json`))).code).toBe('private-address')
    }
    // Defaults count like in `config` mode: without `privateHosts`, every configured host was entered by a person.
    const config = egressFor({ mode: 'config', hosts: [nas] })
    expect((await config.fetch(`http://${nas}/json`)).status).toBe(200)
  })

  it('lets unrestricted mode reach a configured loopback or LAN address and no other', async () => {
    const loopback = egressFor({ mode: 'unrestricted', hosts: [`127.0.0.1:${port}`] }, { realPrivateCheck: true })
    expect((await loopback.fetch(`http://127.0.0.1:${port}/json`)).status).toBe(200)

    const lan = egressFor({ mode: 'unrestricted', hosts: ['192.168.1.20:8080'] }, { realPrivateCheck: true })
    expect((await failure(lan.fetch('http://192.168.1.21:8080/json'))).code).toBe('private-address')
    expect((await failure(lan.fetch('http://192.168.1.20:8081/json'))).code).toBe('private-address')
    expect((await failure(lan.fetch(`http://127.0.0.1:${port}/json`))).code).toBe('private-address')

    // A configured name that resolves to the local network is allowed; DNS answers for other names are not.
    const resolved = createExtensionEgress({
      policy: { mode: 'unrestricted', hosts: [`nas.example.lan:${port}`] },
      timeoutMs: 200,
      maxResponseBytes: 1024,
      resolve: () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]),
    })
    expect((await resolved.fetch(`http://nas.example.lan:${port}/json`)).status).toBe(200)
    expect((await failure(resolved.fetch(`http://rebind.example.com:${port}/json`))).code).toBe('private-address')
  })

  it('checks every redirect hop against the configured hosts in unrestricted mode', async () => {
    const nas = `nas.localhost:${port}`
    const open = egressFor({ mode: 'unrestricted', hosts: [nas] })
    const toOther = encodeURIComponent(`http://other.localhost:${port}/json`)
    expect((await failure(open.fetch(`http://images.example.com:${port}/redirect-to/${toOther}`))).code).toBe(
      'private-address',
    )
    const toConfigured = encodeURIComponent(`http://${nas}/json`)
    expect((await open.fetch(`http://images.example.com:${port}/redirect-to/${toConfigured}`)).status).toBe(200)
    // From the configured host, a redirect elsewhere on the local network is still blocked.
    expect((await failure(open.fetch(`http://${nas}/redirect-to/${toOther}`))).code).toBe('private-address')
  })

  it('re-checks policy on every redirect hop and drops credentials across origins', async () => {
    const domains = egressFor({ mode: 'domains', domains: ['api.example.com'] })
    const escape = encodeURIComponent(`http://evil.example.net:${port}/json`)
    expect((await failure(domains.fetch(`http://api.example.com:${port}/redirect-to/${escape}`))).code).toBe(
      'policy-denied',
    )

    received.length = 0
    const open = egressFor({ mode: 'unrestricted' })
    const crossOrigin = encodeURIComponent(`http://other.example.net:${port}/json`)
    await open.fetch(`http://api.example.com:${port}/redirect-to/${crossOrigin}`, {
      headers: { authorization: 'Bearer fixture-token', 'x-trace': 'kept' },
    })
    const [first, second] = received
    expect(first?.headers['authorization']).toBe('Bearer fixture-token')
    expect(second?.headers['authorization']).toBeUndefined()
    expect(second?.headers['x-trace']).toBe('kept')
  })

  it('turns 303 into GET without a body and stops redirect loops', async () => {
    const egress = egressFor({ mode: 'unrestricted' })
    await egress.fetch(`http://api.example.com:${port}/see-other`, { method: 'POST', body: 'payload' })
    expect(received.map(({ method }) => method)).toEqual(['POST', 'GET'])
    expect(received[1]?.body.byteLength).toBe(0)
    expect((await failure(egress.fetch(`http://api.example.com:${port}/loop`))).code).toBe('too-many-redirects')
  })

  it('sends binary bodies byte for byte', async () => {
    const egress = egressFor({ mode: 'unrestricted' })
    const bytes = Buffer.from([0, 128, 255, 10])
    const response = await egress.fetch(`http://api.example.com:${port}/echo`, {
      method: 'POST',
      bodyBase64: bytes.toString('base64'),
    })
    expect(Buffer.from(response.base64 ?? '', 'base64')).toEqual(bytes)
  })

  it('enforces response size and timeout limits', async () => {
    const egress = egressFor({ mode: 'unrestricted' })
    expect((await failure(egress.fetch(`http://api.example.com:${port}/large`))).code).toBe('response-too-large')
    const timeout = await failure(egress.fetch(`http://api.example.com:${port}/slow`))
    expect(timeout.code).toBe('timeout')
    expect(timeout.message).toBe(
      '请求在 0.2 秒内没有收到响应。接口本来就慢时，可以在调用时传 timeoutMs 放宽等待，最多 600000（10 分钟）。',
    )
  })

  it('lets one call wait longer with timeoutMs, within 1 second to 10 minutes', async () => {
    expect(EXTENSION_FETCH_DEFAULT_TIMEOUT_MS).toBe(100_000)
    const egress = egressFor({ mode: 'unrestricted' })
    const slow = await egress.fetch(`http://api.example.com:${port}/slow`, { timeoutMs: 1_000 })
    expect(Buffer.from(slow.base64 ?? '', 'base64').toString()).toBe('late')
    for (const timeoutMs of [999, 600_001, 1500.5, Number.NaN]) {
      const refused = await failure(egress.fetch(`http://api.example.com:${port}/json`, { timeoutMs }))
      expect(refused.code).toBe('invalid-request')
      expect(refused.message).toContain('timeoutMs 要是 1000 到 600000 之间的整数毫秒')
    }
    expect(received).toHaveLength(1)
  })

  it('rejects malformed requests before any connection', async () => {
    const egress = egressFor({ mode: 'unrestricted' })
    expect((await failure(egress.fetch('ftp://api.example.com/file'))).code).toBe('invalid-protocol')
    expect((await failure(egress.fetch(`http://user:secret@api.example.com:${port}/json`))).code).toBe(
      'invalid-request',
    )
    expect(
      (await failure(egress.fetch(`http://api.example.com:${port}/json`, { headers: { host: 'spoofed.example' } })))
        .code,
    ).toBe('invalid-request-header')
    expect(
      (await failure(egress.fetch(`http://api.example.com:${port}/json`, { body: 'a', bodyBase64: 'YQ==' }))).code,
    ).toBe('invalid-request')
    expect((await failure(egress.fetch('/relative/path'))).message).toContain('https:// 开头的完整地址')
    expect(received).toHaveLength(0)
  })

  it('reads protocol-relative addresses as HTTPS', async () => {
    const egress = egressFor({ mode: 'domains', domains: ['api.example.com'] })
    // The policy check runs on the resolved host, so a denial proves the address was understood.
    const denied = await failure(egress.fetch('//img.example.org/shot.jpg'))
    expect(denied.code).toBe('policy-denied')
    expect(denied.message).toContain('img.example.org')
  })

  it('sets a default user agent that the extension may override', async () => {
    const egress = egressFor({ mode: 'unrestricted' })
    await egress.fetch(`http://api.example.com:${port}/json`)
    await egress.fetch(`http://api.example.com:${port}/json`, { headers: { 'user-agent': 'FixtureAgent/1' } })
    expect(received.map(({ headers }) => headers['user-agent'])).toEqual(['NekroNXT-Extension', 'FixtureAgent/1'])
  })
})

describe('credential placeholders', () => {
  const token = '{{nxt-credential:0123456789abcdef01234567}}'
  const other = '{{nxt-credential:fedcba9876543210fedcba98}}'
  const secrets = [
    { token, value: 'weather-fixture-key', domains: ['api.example.com'] },
    { token: other, value: 'mirror-fixture-key', domains: ['*.mirror.example.org'] },
  ]

  it('fills a credential into the URL, headers and body only for its own domains', async () => {
    const egress = egressFor({ mode: 'unrestricted' })
    const response = await egress.fetch(
      `http://api.example.com:${port}/echo`,
      { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: `{"key":"${token}"}` },
      secrets,
    )
    expect(received[0]?.headers['authorization']).toBe('Bearer weather-fixture-key')
    expect(Buffer.from(response.base64 ?? '', 'base64').toString()).toBe('{"key":"weather-fixture-key"}')

    const query = await egress.fetch(`http://api.example.com:${port}/json?key=${token}`, undefined, secrets)
    expect(received[1]?.url).toBe('/json?key=weather-fixture-key')
    // The final URL handed back to the extension carries the placeholder again, not the value.
    expect(query.url).toContain(token)
    expect(query.url).not.toContain('weather-fixture-key')

    const wrongHost = await failure(
      egress.fetch(`http://api.example.com:${port}/json`, { headers: { 'x-key': other } }, secrets),
    )
    expect(wrongHost.code).toBe('policy-denied')
    expect(wrongHost.message).not.toContain('mirror-fixture-key')
    await egress.fetch(`http://eu.mirror.example.org:${port}/json`, { headers: { 'x-key': other } }, secrets)
    expect(received.at(-1)?.headers['x-key']).toBe('mirror-fixture-key')
    expect((await failure(egress.fetch(`http://${token}.example.com:${port}/json`, undefined, secrets))).code).toBe(
      'invalid-url',
    )
    expect(received).toHaveLength(3)
  })

  it('does not carry a filled credential to another host on a redirect', async () => {
    const egress = egressFor({ mode: 'unrestricted' })
    const away = encodeURIComponent(`http://elsewhere.example.net:${port}/json`)
    await egress.fetch(
      `http://api.example.com:${port}/redirect-to/${away}`,
      { headers: { 'x-api-key': token, 'x-trace': 'kept' } },
      secrets,
    )
    const [first, second] = received
    expect(first?.headers['x-api-key']).toBe('weather-fixture-key')
    expect(second?.headers['x-api-key']).toBeUndefined()
    expect(second?.headers['x-trace']).toBe('kept')
    expect(JSON.stringify(second?.headers)).not.toContain('weather-fixture-key')

    received.length = 0
    const withBody = await failure(
      egress.fetch(
        `http://api.example.com:${port}/temporary-to/${away}`,
        { method: 'POST', body: `key=${token}` },
        secrets,
      ),
    )
    expect(withBody.code).toBe('policy-denied')
    expect(received).toHaveLength(1)
    expect(received[0]?.body.toString()).toBe('key=weather-fixture-key')
  })
})

describe('downloads into a file', () => {
  let directory = ''
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-egress-'))
  })
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })
  const policy: ExtensionEgressPolicy = { mode: 'domains', domains: ['media.example.com'] }

  it('streams a body bigger than the memory limit into the target file', async () => {
    const egress = egressFor(policy)
    expect((await failure(egress.fetch(`http://media.example.com:${port}/large`))).code).toBe('response-too-large')
    const target = path.join(directory, 'large')
    const result = await egress.download(`http://media.example.com:${port}/redirect-to/%2Flarge`, undefined, [], {
      path: target,
      maxBytes: 4096,
    })
    expect(result).toMatchObject({ status: 200, contentType: 'text/plain', byteSize: 2048 })
    expect(result.url).toBe(`http://media.example.com:${port}/large`)
    expect(await readFile(target, 'utf8')).toBe('x'.repeat(2048))
  })

  it('stops past the limit and leaves no partial file', async () => {
    const egress = egressFor(policy)
    for (const route of ['/large', '/chunked']) {
      const target = path.join(directory, route.slice(1))
      const error = await failure(
        egress.download(`http://media.example.com:${port}${route}`, undefined, [], {
          path: target,
          maxBytes: 1000,
        }),
      )
      expect(error).toMatchObject({ code: 'response-too-large', limitBytes: 1000 })
      expect(existsSync(target)).toBe(false)
    }
    const whole = path.join(directory, 'whole')
    await egress.download(`http://media.example.com:${port}/chunked`, undefined, [], { path: whole, maxBytes: 3000 })
    expect((await readFile(whole)).byteLength).toBe(3000)
  })

  it('writes nothing for an error status and keeps the network policy', async () => {
    const egress = egressFor(policy)
    const target = path.join(directory, 'missing')
    expect(
      await egress.download(`http://media.example.com:${port}/missing`, undefined, [], {
        path: target,
        maxBytes: 4096,
      }),
    ).toMatchObject({ status: 404, byteSize: 0 })
    expect(existsSync(target)).toBe(false)
    const denied = await failure(
      egress.download(`http://other.example.com:${port}/large`, undefined, [], { path: target, maxBytes: 4096 }),
    )
    expect(denied.code).toBe('policy-denied')
    expect(received.map(({ url }) => url)).toEqual(['/missing'])
  })

  it('stops when the caller cancels', async () => {
    const controller = new AbortController()
    const target = path.join(directory, 'slow')
    const pending = egressFor(policy).download(`http://media.example.com:${port}/chunked`, undefined, [], {
      path: target,
      maxBytes: 4096,
      signal: controller.signal,
    })
    controller.abort()
    expect((await failure(pending)).code).toBe('aborted')
    expect(existsSync(target)).toBe(false)
  })
})
