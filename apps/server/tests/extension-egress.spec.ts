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
    expect(received).toHaveLength(0)
  })

  it('sets a default user agent that the extension may override', async () => {
    const egress = egressFor({ mode: 'unrestricted' })
    await egress.fetch(`http://api.example.com:${port}/json`)
    await egress.fetch(`http://api.example.com:${port}/json`, { headers: { 'user-agent': 'FixtureAgent/1' } })
    expect(received.map(({ headers }) => headers['user-agent'])).toEqual(['NekroNXT-Extension', 'FixtureAgent/1'])
  })
})
