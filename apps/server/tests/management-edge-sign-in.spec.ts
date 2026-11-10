import { HostApiContracts } from '@nekro-nxt/contracts'
import { openMigratedCoreDatabase, SqliteHostSecurityRepository } from '@nekro-nxt/storage-sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, request as httpRequest, type Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { normalizeLoginCode } from '../src/login-requests.ts'
import { startManagementEdge, type ManagementEdgeHandle } from '../src/management-edge.ts'

interface Reply {
  readonly status: number
  readonly headers: Record<string, string | string[] | undefined>
  readonly text: string
}

const MANAGEMENT_KEY = 'fixture management key for sign-in codes 0123456789'
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'

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

const setCookies = (reply: Reply): readonly string[] => {
  const value = reply.headers['set-cookie']
  return value === undefined ? [] : Array.isArray(value) ? value : [value]
}
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
const json = (reply: Reply): unknown => JSON.parse(reply.text)

describe('signing in with codes, passkeys and the key switch', () => {
  const roots: string[] = []
  const servers: Server[] = []
  const edges: ManagementEdgeHandle[] = []
  afterEach(async () => {
    await Promise.all(edges.splice(0).map((edge) => edge.stop()))
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))))
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  const start = async (publicOrigin?: string) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'nxt-edge-sign-in-'))
    roots.push(root)
    const repository = new SqliteHostSecurityRepository(await openMigratedCoreDatabase(path.join(root, 'core.sqlite')))
    const internal = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
    servers.push(internal)
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
      ...(publicOrigin === undefined ? {} : { publicOrigin: () => publicOrigin }),
    })
    edges.push(edge)
    // The administrator's first browser, signed in with the key.
    const signedIn = await send(edge.port, '/api/management/login', {
      method: 'POST',
      body: { managementKey: MANAGEMENT_KEY, acknowledgeInsecure: true },
    })
    const cookies = setCookies(signedIn)
    const admin = {
      cookie: cookieHeader(cookies),
      origin: `http://127.0.0.1:${edge.port}`,
      'x-nxt-csrf': cookieValue(cookies, 'nxt_csrf')!,
    }
    return { edge, admin }
  }

  const poll = (port: number, secret: string) =>
    send(port, '/api/management/login-requests/poll', {
      method: 'POST',
      body: { secret },
      headers: { 'user-agent': IPHONE },
    })

  it('signs in a new device that scanned a code the signed-in device showed, once it is approved', async () => {
    const { edge, admin } = await start('https://nxt.example.test')
    const invite = HostApiContracts.createLoginInvite.parseResponse(
      json(await send(edge.port, '/api/management/login-invites', { method: 'POST', headers: admin })),
    )
    // The code points at the access address, where the phone can reach the instance.
    expect(invite.url).toBe(`https://nxt.example.test/login?code=${invite.code}`)
    expect(invite.qrSvg).toMatch(/^<svg/u)

    const page = await send(edge.port, `/login?code=${invite.code}`)
    expect(page.text).toContain(`const initialCode = "${invite.code}"`)

    const claimed = await send(edge.port, '/api/management/login-requests/claim', {
      method: 'POST',
      body: { code: invite.code.toLowerCase().replace('-', ''), acknowledgeInsecure: true },
      headers: { 'user-agent': IPHONE },
    })
    const { secret } = z.object({ secret: z.string() }).parse(json(claimed))
    expect(JSON.parse((await poll(edge.port, secret)).text)).toEqual({ state: 'waiting' })
    // Scanning the same invite twice does not hand out a second session.
    expect(
      (
        await send(edge.port, '/api/management/login-requests/claim', {
          method: 'POST',
          body: { code: invite.code, acknowledgeInsecure: true },
        })
      ).status,
    ).toBe(404)

    const seen = HostApiContracts.getLoginRequest.parseResponse(
      json(await send(edge.port, `/api/management/login-requests/${invite.code}`, { headers: admin })),
    )
    expect(seen).toMatchObject({ kind: 'invite', state: 'waiting', requesterLabel: '浏览器 · Safari · iOS' })
    expect(
      (
        await send(edge.port, `/api/management/login-requests/${invite.code}/decision`, {
          method: 'POST',
          body: { approve: true },
          headers: admin,
        })
      ).status,
    ).toBe(200)

    const approved = await poll(edge.port, secret)
    expect(JSON.parse(approved.text)).toMatchObject({ authenticated: true, state: 'approved' })
    const phone = cookieHeader(setCookies(approved))
    expect(phone).toContain('nxt_device=')
    expect((await send(edge.port, '/api/management/session', { headers: { cookie: phone } })).status).toBe(200)
    // The session is picked up once.
    expect(JSON.parse((await poll(edge.port, secret)).text)).toEqual({ state: 'expired' })
    const devices = HostApiContracts.listManagementDevices.parseResponse(
      json(await send(edge.port, '/api/management/devices', { headers: admin })),
    )
    expect(devices.devices.map((device) => device.label)).toContain('浏览器 · Safari · iOS')
  })

  it('signs in a device that showed its own code once a signed-in device approves it, and not after a refusal', async () => {
    const { edge, admin } = await start()
    const request = async () =>
      z.object({ code: z.string(), secret: z.string(), url: z.string(), qrSvg: z.string() }).parse(
        json(
          await send(edge.port, '/api/management/login-requests', {
            method: 'POST',
            body: { acknowledgeInsecure: true },
            headers: { 'user-agent': IPHONE },
          }),
        ),
      )
    const first = await request()
    expect(first.url).toBe(`http://127.0.0.1:${edge.port}/settings/access?approve=${first.code}`)
    expect(first.qrSvg).toMatch(/^<svg/u)
    const decide = (code: string, approve: boolean, headers: Record<string, string>) =>
      send(edge.port, `/api/management/login-requests/${code}/decision`, { method: 'POST', body: { approve }, headers })

    // Nobody signed in can approve.
    expect((await decide(first.code, true, { origin: admin.origin })).status).toBe(401)
    expect((await decide(first.code, false, admin)).status).toBe(200)
    expect(JSON.parse((await poll(edge.port, first.secret)).text)).toEqual({ state: 'rejected' })
    expect((await decide(first.code, true, admin)).status).toBe(409)

    const second = await request()
    expect((await decide(second.code, true, admin)).status).toBe(200)
    expect(JSON.parse((await poll(edge.port, second.secret)).text)).toMatchObject({ state: 'approved' })
  })

  it('keeps the key for recovery when key sign-in is off, and offers passkeys only where browsers allow them', async () => {
    const { edge, admin } = await start()
    const view = HostApiContracts.getManagementSignIn.parseResponse(
      json(await send(edge.port, '/api/management/sign-in', { headers: admin })),
    )
    // A bare IP address over HTTP cannot hold passkeys.
    expect(view).toEqual({ keySignIn: true, rpId: '127.0.0.1', passkeysAvailable: false, passkeys: [] })
    expect((await send(edge.port, '/api/management/passkeys/options', { method: 'POST', headers: admin })).status).toBe(
      400,
    )
    const localhost = await send(edge.port, '/api/management/sign-in', {
      headers: { ...admin, host: `localhost:${edge.port}` },
    })
    expect(JSON.parse(localhost.text)).toMatchObject({ rpId: 'localhost', passkeysAvailable: true })

    expect(
      (await send(edge.port, '/api/management/sign-in', { method: 'PUT', body: { keySignIn: false }, headers: admin }))
        .status,
    ).toBe(200)
    const login = (recovery: boolean) =>
      send(edge.port, '/api/management/login', {
        method: 'POST',
        body: { managementKey: MANAGEMENT_KEY, acknowledgeInsecure: true, recovery },
      })
    expect((await login(false)).status).toBe(403)
    const recovered = await login(true)
    expect(recovered.status).toBe(200)
    expect(JSON.parse(recovered.text)).toMatchObject({ next: '/settings/access?recovered=1' })
    const page = await send(edge.port, '/login')
    expect(page.text).toContain('用管理密钥找回')
    expect(page.text).toContain('const recovery = true')
  })

  it('reads typed codes in any case and with or without the dash', () => {
    expect(normalizeLoginCode('abcd efgh')).toBe('ABCD-EFGH')
    expect(normalizeLoginCode('ABCD-EFG1')).toBeUndefined()
    expect(normalizeLoginCode('ABC')).toBeUndefined()
  })
})
