import react from '@vitejs/plugin-react'
import { chromium, expect as expectPage, type Browser, type Page } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type ViteDevServer } from 'vite'

const harnessModule = `
  import React, { useState } from 'react'
  import { createRoot } from 'react-dom/client'
  import { NotificationCenter, notify } from '/src/components/notifications.tsx'
  import { Button, Dialog, IconButton, Tooltip } from '/src/ui-kit/index.tsx'
  import '/src/ui-kit/tokens.css'

  function Harness() {
    const [open, setOpen] = useState(false)
    const [pending, setPending] = useState(false)
    const [longContent, setLongContent] = useState(true)
    const [notificationSequence, setNotificationSequence] = useState(0)
    return <Tooltip.Provider>
      <main>
      <Button id="dialog-trigger" onClick={() => { setLongContent(true); setPending(false); setOpen(true) }}>打开对话框</Button>
      <IconButton id="icon-button" label="新建网页频道"><span>+</span></IconButton>
      <Button id="short-dialog-trigger" onClick={() => { setLongContent(false); setPending(false); setOpen(true) }}>打开短对话框</Button>
      <Button id="pending-trigger" onClick={() => { setLongContent(true); setPending(true); setOpen(true) }}>打开待处理对话框</Button>
      <Button id="grouped-notification" onClick={() => {
        const next = notificationSequence + 1
        setNotificationSequence(next)
        notify('同步结果 ' + next, 'success', 'sync-result')
      }}>显示分组通知</Button>
      <Button id="error-notification" onClick={() => notify('保存失败', 'error', 'save-error')}>显示错误通知</Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="测试对话框"
        description="验证键盘和滚动行为。"
        pending={pending}
        footer={<Button onClick={() => setOpen(false)}>完成</Button>}
      >
        <div style={{ height: longContent ? 1200 : 20 }}>{longContent ? '可滚动内容' : '短内容'}</div>
      </Dialog>
      <NotificationCenter />
    </main>
    </Tooltip.Provider>
  }

  createRoot(document.querySelector('#root')).render(<Harness />)
`

describe.sequential('ui-kit Dialog browser behavior', { timeout: 30_000 }, () => {
  let server: ViteDevServer
  let browser: Browser
  let page: Page
  let baseUrl: string
  const browserErrors: string[] = []

  beforeAll(async () => {
    server = await createServer({
      root: fileURLToPath(new URL('../', import.meta.url)),
      configFile: false,
      logLevel: 'silent',
      plugins: [
        react(),
        {
          name: 'ui-kit-browser-harness',
          configureServer(viteServer) {
            viteServer.middlewares.use('/__ui-kit_harness__', (_request, response, next) => {
              void viteServer
                .transformIndexHtml(
                  '/__ui-kit_harness__',
                  '<!doctype html><html><body><div id="root"></div><script type="module" src="/virtual-ui-kit-harness.tsx"></script></body></html>',
                )
                .then((html) => {
                  response.setHeader('Content-Type', 'text/html')
                  response.end(html)
                })
                .catch(next)
            })
          },
          resolveId(id) {
            return id === '/virtual-ui-kit-harness.tsx' ? id : undefined
          },
          load(id) {
            return id === '/virtual-ui-kit-harness.tsx' ? harnessModule : undefined
          },
        },
      ],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const address = server.httpServer?.address()
    if (!address || typeof address === 'string') throw new Error('Vite test server did not expose a TCP port.')
    baseUrl = `http://127.0.0.1:${address.port}`
    browser = await chromium.launch({ headless: true })
    page = await browser.newPage()
    page.on('pageerror', (error) => browserErrors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') browserErrors.push(message.text())
    })
  }, 30_000)

  afterAll(async () => {
    await page?.close()
    await browser?.close()
    await server?.close()
  })

  it('closes on Escape and restores focus to the opener', async () => {
    await page.goto(`${baseUrl}/__ui-kit_harness__`, { waitUntil: 'domcontentloaded' })
    try {
      await page.waitForSelector('#dialog-trigger', { state: 'visible', timeout: 3_000 })
    } catch (error) {
      const moduleResponse = await page.request.get(`${baseUrl}/virtual-ui-kit-harness.tsx`)
      throw new Error(
        `${String(error)}\nBrowser errors: ${browserErrors.join('\n')}\nModule response: ${await moduleResponse.text()}\n${await page.content()}`,
      )
    }
    expect(browserErrors).toEqual([])
    const trigger = page.locator('#dialog-trigger')
    await trigger.click()
    await expectPage(page.getByRole('dialog')).toBeVisible()

    await page.keyboard.press('Escape')
    await expectPage(page.getByRole('dialog')).toBeHidden()
    await expectPage(trigger).toBeFocused()
  }, 20_000)

  it('renders an independently scrollable body inside a viewport-bounded surface', async () => {
    await page.locator('#dialog-trigger').click()
    const dialog = page.getByRole('dialog')
    const body = dialog.locator('[data-nxt-dialog-region="body"]')

    await expectPage(dialog.locator('[data-nxt-dialog-region="header"]')).toBeVisible()
    await expectPage(body).toBeVisible()
    await expectPage(dialog.locator('[data-nxt-dialog-region="footer"]')).toBeVisible()
    expect(await body.evaluate((element) => getComputedStyle(element).overflowY)).toBe('auto')
    expect(await body.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
    await expectPage(body).toHaveAttribute('tabindex', '0')
    await expectPage(body).toHaveAttribute('role', 'region')
    expect(await dialog.evaluate((element) => getComputedStyle(element).maxHeight)).not.toBe('none')
    await page.keyboard.press('Escape')
  }, 20_000)

  it('does not add a Tab stop when the dialog body does not overflow', async () => {
    await page.locator('#short-dialog-trigger').click()
    const body = page.getByRole('dialog').locator('[data-nxt-dialog-region="body"]')
    expect(await body.evaluate((element) => element.scrollHeight <= element.clientHeight)).toBe(true)
    expect(await body.getAttribute('tabindex')).toBeNull()
    expect(await body.getAttribute('role')).toBeNull()
    await page.keyboard.press('Escape')
  }, 20_000)

  it('does not close from Escape while pending', async () => {
    await page.locator('#pending-trigger').click()
    const dialog = page.getByRole('dialog')
    await page.keyboard.press('Escape')
    await expectPage(dialog).toBeVisible()
    await expectPage(dialog.getByRole('button', { name: '关闭对话框' })).toBeDisabled()
  }, 20_000)

  it('forwards the tooltip content ref so IconButton hover does not warn', async () => {
    await page.goto(`${baseUrl}/__ui-kit_harness__`, { waitUntil: 'domcontentloaded' })
    const trigger = page.locator('#icon-button')
    await trigger.hover()
    await expectPage(page.getByRole('tooltip', { name: '新建网页频道' })).toBeVisible()
    expect(browserErrors.filter((message) => message.includes('Function components cannot be given refs'))).toEqual([])
  }, 20_000)

  it('groups repeated notifications, exposes live semantics, and supports manual dismissal', async () => {
    await page.goto(`${baseUrl}/__ui-kit_harness__`, { waitUntil: 'domcontentloaded' })
    const grouped = page.locator('#grouped-notification')
    await grouped.click()
    await grouped.click()

    const status = page.getByRole('status')
    await expectPage(status).toHaveCount(1)
    await expectPage(status).toContainText('同步结果 2')
    await expectPage(status).not.toContainText('同步结果 1')

    await page.locator('#error-notification').click()
    const alert = page.getByRole('alert')
    await expectPage(alert).toContainText('保存失败')
    await alert.getByRole('button', { name: '关闭通知' }).click()
    await expectPage(alert).toHaveCount(0)
    expect(browserErrors).toEqual([])
  }, 20_000)

  it('automatically dismisses transient success notifications', async () => {
    await page.locator('#grouped-notification').click()
    await expectPage(page.getByRole('status')).toBeVisible()
    await expectPage(page.getByRole('status')).toHaveCount(0, { timeout: 5_000 })
  }, 20_000)
})
