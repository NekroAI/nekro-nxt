import { chromium, type Browser } from '@playwright/test'
import { openMigratedCoreDatabase, SqliteHostSecurityRepository } from '@nekro-nxt/storage-sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startManagementEdge, type ManagementEdgeHandle } from '../src/management-edge.ts'

const MANAGEMENT_KEY = 'fixture management key for passkeys 0123456789'

/**
 * A real WebAuthn round trip: Chrome's virtual authenticator creates a passkey for `localhost` against a running edge,
 * then the login page signs in with it. Nothing is mocked between the browser and the verification.
 */
describe('signing in through the login page', () => {
  let browser: Browser
  let root: string
  let internal: Server
  let edge: ManagementEdgeHandle
  let repository: SqliteHostSecurityRepository

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'nxt-edge-passkey-'))
    repository = new SqliteHostSecurityRepository(await openMigratedCoreDatabase(path.join(root, 'core.sqlite')))
    internal = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<!doctype html><title>signed in</title><h1>signed in</h1>')
    })
    await new Promise<void>((resolve) => internal.listen(0, '127.0.0.1', resolve))
    const address = internal.address()
    if (address === null || typeof address === 'string') throw new Error('missing internal port')
    edge = await startManagementEdge({
      host: '127.0.0.1',
      port: 0,
      internalPort: address.port,
      dataRoot: root,
      managementKey: MANAGEMENT_KEY,
      releaseId: 'test-release',
      productVersion: '0.0.0',
      repository,
    })
    browser = await chromium.launch()
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    await edge?.stop()
    await new Promise((resolve) => internal?.close(resolve))
    await rm(root, { recursive: true, force: true })
  })

  it('adds a passkey from a signed-in browser and signs a new browser in with it', async () => {
    const origin = `http://localhost:${edge.port}`
    const context = await browser.newContext()
    const page = await context.newPage()
    const cdp = await context.newCDPSession(page)
    await cdp.send('WebAuthn.enable')
    await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    })

    // Sign in with the key, then register a passkey the way the settings page does.
    await page.goto(`${origin}/login`)
    await page.getByRole('button', { name: '我了解风险，继续' }).click()
    await page.getByRole('button', { name: '使用管理密钥' }).click()
    await page.getByLabel('管理密钥').fill(MANAGEMENT_KEY)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.waitForURL(`${origin}/`)
    const registered = await page.evaluate(async () => {
      const csrf = /(?:^|; )nxt_csrf=([^;]+)/u.exec(document.cookie)?.[1] ?? ''
      const headers = { 'content-type': 'application/json', 'x-nxt-csrf': csrf }
      const decode = (value: string) =>
        Uint8Array.from(
          atob(value.replace(/-/gu, '+').replace(/_/gu, '/') + '='.repeat((4 - (value.length % 4)) % 4)),
          (c) => c.charCodeAt(0),
        )
      const encode = (buffer: ArrayBuffer) =>
        btoa(String.fromCharCode(...new Uint8Array(buffer)))
          .replace(/\+/gu, '-')
          .replace(/\//gu, '_')
          .replace(/=+$/u, '')
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the server's WebAuthn options JSON.
      const options = (await (await fetch('/api/management/passkeys/options', { method: 'POST', headers })).json()) as {
        challenge: string
        user: { id: string; name: string; displayName: string }
        rp: { id: string; name: string }
        pubKeyCredParams: PublicKeyCredentialParameters[]
        authenticatorSelection: AuthenticatorSelectionCriteria
      }
      const credential = await navigator.credentials.create({
        publicKey: {
          ...options,
          challenge: decode(options.challenge),
          user: { ...options.user, id: decode(options.user.id) },
          excludeCredentials: [],
        },
      })
      if (!(credential instanceof PublicKeyCredential)) throw new Error('no credential')
      const response = credential.response
      if (!(response instanceof AuthenticatorAttestationResponse)) throw new Error('no attestation')
      const saved = await fetch('/api/management/passkeys', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          label: '测试用通行密钥',
          response: {
            id: credential.id,
            rawId: encode(credential.rawId),
            type: credential.type,
            clientExtensionResults: credential.getClientExtensionResults(),
            response: {
              clientDataJSON: encode(response.clientDataJSON),
              attestationObject: encode(response.attestationObject),
              transports: response.getTransports(),
            },
          },
        }),
      })
      return { status: saved.status, body: (await saved.json()) as unknown }
    })
    expect(registered).toMatchObject({ status: 200, body: { label: '测试用通行密钥', rpId: 'localhost' } })

    // A computer without cookies, same authenticator: the passkey sits under this browser's own code and signs in.
    await context.clearCookies()
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`${origin}/login`)
    await page.getByRole('button', { name: '我了解风险，继续' }).click()
    await expect
      .poll(async () => (await page.locator('#shown-code').innerText()).trim(), { timeout: 10_000 })
      .toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/u)
    await page.getByRole('button', { name: '使用通行密钥' }).click()
    await page.waitForURL(`${origin}/`)
    await expect(page.getByRole('heading', { name: 'signed in' }).isVisible()).resolves.toBe(true)
    expect(repository.listPasskeys('localhost')[0]?.lastUsedAt).toEqual(expect.any(Number))
    expect(repository.listDevices()).toHaveLength(2)
    await context.close()
  }, 60_000)
  it('signs a browser in from the code its login page shows, once a signed-in device allows it', async () => {
    const origin = `http://localhost:${edge.port}`
    const admin = await browser.newContext()
    const adminPage = await admin.newPage()
    await adminPage.goto(`${origin}/login`)
    await adminPage.request.post(`${origin}/api/management/login`, {
      data: { managementKey: MANAGEMENT_KEY, acknowledgeInsecure: true },
    })
    const csrf = (await admin.cookies()).find((entry) => entry.name === 'nxt_csrf')?.value ?? ''

    const computer = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await computer.newPage()
    await page.goto(`${origin}/login`)
    await page.getByRole('button', { name: '我了解风险，继续' }).click()
    // This address already has a passkey: it is offered beside the code, which still works on its own.
    await page.getByRole('button', { name: '使用通行密钥' }).waitFor()
    const shown = page.locator('#shown-code')
    await expect
      .poll(async () => (await shown.innerText()).trim(), { timeout: 10_000 })
      .toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/u)
    const code = (await shown.innerText()).trim()
    const decided = await adminPage.request.post(`${origin}/api/management/login-requests/${code}/decision`, {
      data: { approve: true },
      headers: { 'x-nxt-csrf': csrf, origin },
    })
    expect(decided.status()).toBe(200)
    await page.waitForURL(`${origin}/`, { timeout: 10_000 })
    await expect(page.getByRole('heading', { name: 'signed in' }).isVisible()).resolves.toBe(true)
    await admin.close()
    await computer.close()
  }, 60_000)
})
