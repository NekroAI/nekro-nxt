import { chromium, type Browser, type BrowserContextOptions, type Page } from '@playwright/test'
import { HostApiContracts } from '@nekro-nxt/contracts'
import { openMigratedCoreDatabase, SqliteHostSecurityRepository } from '@nekro-nxt/storage-sqlite'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import QRCode from 'qrcode'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { startManagementEdge, type ManagementEdgeHandle } from '../src/management-edge.ts'

const MANAGEMENT_KEY = 'fixture management key for the login page 0123456789'
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
const PHONE: BrowserContextOptions = {
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  userAgent: IPHONE,
}

/** A camera that keeps filming `text` as a QR code: one grey-scale Y4M frame Chrome's fake capture device loops. */
const qrCameraFile = async (directory: string, text: string): Promise<string> => {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' })
  const width = 640
  const height = 480
  const cell = 8
  const side = (modules.size + 8) * cell
  const left = (width - side) / 2
  const top = (height - side) / 2
  const luma = Buffer.alloc(width * height, 235)
  for (let y = 0; y < modules.size; y += 1) {
    for (let x = 0; x < modules.size; x += 1) {
      if (!modules.get(y, x)) continue
      for (let row = 0; row < cell; row += 1) {
        const start = (top + (y + 4) * cell + row) * width + left + (x + 4) * cell
        luma.fill(16, start, start + cell)
      }
    }
  }
  const chroma = Buffer.alloc((width / 2) * (height / 2) * 2, 128)
  const file = path.join(directory, `camera-${Date.now()}.y4m`)
  await writeFile(
    file,
    Buffer.concat([Buffer.from(`YUV4MPEG2 W${width} H${height} F30:1 Ip A1:1 C420jpeg\nFRAME\n`), luma, chroma]),
  )
  return file
}

/** The login page in a phone or a computer, each with its own preferred way in and the others one step away. */
describe('the login page on phones and computers', () => {
  let browser: Browser
  let root: string
  let internal: Server
  let edge: ManagementEdgeHandle
  let database: Awaited<ReturnType<typeof openMigratedCoreDatabase>>
  const launched: Browser[] = []

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'nxt-edge-login-page-'))
    database = await openMigratedCoreDatabase(path.join(root, 'core.sqlite'))
    const repository = new SqliteHostSecurityRepository(database)
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

  afterEach(async () => {
    await Promise.all(launched.splice(0).map((item) => item.close()))
  })

  afterAll(async () => {
    await browser?.close()
    await edge?.stop()
    await new Promise((resolve) => internal?.close(resolve))
    database?.close()
    await rm(root, { recursive: true, force: true })
  })

  /** A signed-in administrator who can show invite codes and allow sign-ins. */
  const administrator = async () => {
    const origin = `http://localhost:${edge.port}`
    const context = await browser.newContext()
    const signedIn = await context.request.post(`${origin}/api/management/login`, {
      data: { managementKey: MANAGEMENT_KEY, acknowledgeInsecure: true },
    })
    expect(signedIn.status()).toBe(200)
    const csrf = (await context.cookies()).find((entry) => entry.name === 'nxt_csrf')?.value ?? ''
    const headers = { 'x-nxt-csrf': csrf, origin }
    return {
      invite: async () =>
        HostApiContracts.createLoginInvite.parseResponse(
          await (await context.request.post(`${origin}/api/management/login-invites`, { headers })).json(),
        ),
      allow: async (code: string) =>
        (
          await context.request.post(`${origin}/api/management/login-requests/${code}/decision`, {
            data: { approve: true },
            headers,
          })
        ).status(),
      close: () => context.close(),
    }
  }

  const securityViolations = (page: Page): string[] => {
    const messages: string[] = []
    page.on('console', (message) => {
      if (message.text().includes('Content Security Policy')) messages.push(message.text())
    })
    return messages
  }

  it('leads a phone to scanning, and signs it in from the code a signed-in device shows', async () => {
    const admin = await administrator()
    const invite = await admin.invite()
    const camera = await chromium.launch({
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        `--use-file-for-fake-video-capture=${await qrCameraFile(root, invite.url)}`,
      ],
    })
    launched.push(camera)
    const context = await camera.newContext(PHONE)
    await context.grantPermissions(['camera'])
    const page = await context.newPage()
    const violations = securityViolations(page)
    await page.goto(`http://localhost:${edge.port}/login`)
    await page.getByRole('button', { name: '我了解风险，继续' }).click()

    // Scanning is the one button; this phone's own code is a quiet link.
    await page.getByRole('button', { name: '扫码登录' }).waitFor()
    await expect(page.locator('#qr').isVisible()).resolves.toBe(false)
    await expect(page.getByRole('button', { name: '显示本机登录码' }).isVisible()).resolves.toBe(true)
    await expect(page.getByRole('button', { name: '输入登录码' }).isVisible()).resolves.toBe(true)
    await expect(page.getByRole('button', { name: '使用管理密钥' }).isVisible()).resolves.toBe(true)

    await page.getByRole('button', { name: '扫码登录' }).click()
    await page.getByRole('heading', { name: '等待确认' }).waitFor({ timeout: 15_000 })
    expect(await admin.allow(invite.code)).toBe(200)
    await page.waitForURL(`http://localhost:${edge.port}/`, { timeout: 10_000 })
    expect(violations).toEqual([])
    await admin.close()
  }, 60_000)

  it('shows a phone its own code and why, when the page cannot reach the camera', async () => {
    // Plain HTTP on a network address: browsers keep the camera from the page.
    const lan = await chromium.launch({
      args: ['--host-resolver-rules=MAP nxt-lan.test 127.0.0.1', '--proxy-server=direct://'],
    })
    launched.push(lan)
    const insecure = await (await lan.newContext(PHONE)).newPage()
    await insecure.goto(`http://nxt-lan.test:${edge.port}/login`)
    await insecure.getByRole('button', { name: '我了解风险，继续' }).click()
    await insecure.getByText('页面里扫码需要 HTTPS 连接。').waitFor()
    await expect
      .poll(async () => (await insecure.locator('#shown-code').innerText()).trim(), { timeout: 10_000 })
      .toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/u)
    await expect(insecure.getByText('或用系统相机扫描已登录设备上的二维码').isVisible()).resolves.toBe(true)
    await expect(insecure.getByRole('button', { name: '扫码登录' }).count()).resolves.toBe(0)

    // Camera refused: the page falls back the same way and keeps scanning one link away.
    const context = await browser.newContext(PHONE)
    const page = await context.newPage()
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError'))
    })
    await page.goto(`http://localhost:${edge.port}/login`)
    await page.getByRole('button', { name: '我了解风险，继续' }).click()
    await page.getByRole('button', { name: '扫码登录' }).click()
    await page.getByText('没有相机权限。可以在浏览器设置里允许后再扫码。').waitFor()
    await expect
      .poll(async () => (await page.locator('#shown-code').innerText()).trim(), { timeout: 10_000 })
      .toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/u)
    await expect(page.getByRole('button', { name: '扫码登录' }).isVisible()).resolves.toBe(true)
    await context.close()
  }, 60_000)

  it('leads a computer with its own code and offers scanning when the camera can be used', async () => {
    const admin = await administrator()
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    await page.goto(`http://localhost:${edge.port}/login`)
    await page.getByRole('button', { name: '我了解风险，继续' }).click()
    const shown = page.locator('#shown-code')
    await expect
      .poll(async () => (await shown.innerText()).trim(), { timeout: 10_000 })
      .toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/u)
    // No passkey on this address yet, so the code stands alone with the quiet links under it.
    await expect(page.getByRole('button', { name: '使用通行密钥' }).isVisible()).resolves.toBe(false)
    await expect(page.getByRole('button', { name: '显示本机登录码' }).isVisible()).resolves.toBe(false)
    await expect(page.getByRole('button', { name: '扫码登录' }).isVisible()).resolves.toBe(true)
    expect(await admin.allow((await shown.innerText()).trim())).toBe(200)
    await page.waitForURL(`http://localhost:${edge.port}/`, { timeout: 10_000 })
    await context.close()
    await admin.close()
  }, 60_000)

  it('reaches under a phone notch and colours the status bar like the page in either scheme', async () => {
    for (const colorScheme of ['light', 'dark'] as const) {
      const context = await browser.newContext({ ...PHONE, colorScheme })
      const page = await context.newPage()
      const violations = securityViolations(page)
      await page.goto(`http://localhost:${edge.port}/login`)
      await expect(page.locator('meta[name="viewport"]').getAttribute('content')).resolves.toContain(
        'viewport-fit=cover',
      )
      const look = await page.evaluate(() => {
        const active = [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')].filter(
          (meta) => matchMedia(meta.media).matches,
        )
        const body = getComputedStyle(document.body)
        // Normalises the meta's hex the way computed styles report colours.
        const probe = document.createElement('i')
        probe.style.color = active[0]?.content ?? ''
        document.body.append(probe)
        const themeColor = getComputedStyle(probe).color
        probe.remove()
        return { count: active.length, themeColor, background: body.backgroundColor, padding: body.padding }
      })
      expect(look.count).toBe(1)
      expect(look.themeColor).toBe(look.background)
      // Without a notch the page keeps its usual margin.
      expect(look.padding).toBe('16px')
      expect(violations).toEqual([])
      await context.close()
    }
  }, 60_000)

  it('keeps every field at 16px or more on a phone, so iOS does not zoom in, and leaves computers as they were', async () => {
    const sizes = async (options: BrowserContextOptions) => {
      const context = await browser.newContext(options)
      const page = await context.newPage()
      await page.goto(`http://localhost:${edge.port}/login`)
      const result = await page
        .locator('input')
        .evaluateAll((inputs) =>
          inputs.map((input) => ({ id: input.id, size: Number.parseFloat(getComputedStyle(input).fontSize) })),
        )
      await context.close()
      return result
    }
    const phone = await sizes(PHONE)
    expect(phone.length).toBeGreaterThan(0)
    for (const field of phone) expect(field.size, field.id).toBeGreaterThanOrEqual(16)
    const computer = await sizes({ viewport: { width: 1280, height: 800 } })
    expect(computer.find((field) => field.id === 'key')?.size).toBe(14)
  }, 60_000)
})
