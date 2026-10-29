import { createServer, type IncomingMessage, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createExtensionEgress, ExtensionEgressError, type ExtensionEgressPolicy } from '../src/extension-egress.js'

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
    expect((await failure(egress.fetch(`http://api.example.com:${port}/slow`))).code).toBe('timeout')
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
