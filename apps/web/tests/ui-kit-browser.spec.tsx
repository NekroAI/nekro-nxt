import react from '@vitejs/plugin-react'
import { chromium, expect as expectPage, type Browser, type Page } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Connect, type ViteDevServer } from 'vite'

const harnessModule = `
  import React, { useState } from 'react'
  import { createRoot } from 'react-dom/client'
  import { NotificationCenter, notify } from '/src/components/notifications.tsx'
  import { Button, Dialog, IconButton, NxtMotionProvider, Tooltip } from '/src/ui-kit/index.tsx'
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

  function Root() {
    const [reduce, setReduce] = useState(false)
    return <NxtMotionProvider reducedMotion={reduce}>
      <Button id="reduce-ui" onClick={() => setReduce(true)}>减少动态</Button>
      <Harness />
    </NxtMotionProvider>
  }

  createRoot(document.querySelector('#root')).render(<Root />)
`

const motionHarnessModule = `
  import React, { useEffect, useState } from 'react'
  import { createRoot } from 'react-dom/client'
  import { Button, NxtMotionProvider, StageCrossfade } from '/src/ui-kit/index.tsx'
  import '/src/ui-kit/tokens.css'

  function TrackedPage({ page }) {
    useEffect(() => {
      window.__motionMounts ??= {}
      window.__motionMounts[page] = (window.__motionMounts[page] ?? 0) + 1
      document.documentElement.dataset.motionMounts = JSON.stringify(window.__motionMounts)
    }, [page])
    return <div><p id="label" style={{ fontSize: 28 }}>{page === 'a' ? '页面甲' : '页面乙'}</p><button id={'inside-' + page}>页内操作</button></div>
  }

  function Harness() {
    const [page, setPage] = useState('a')
    const [reduce, setReduce] = useState(false)
    return (
      <NxtMotionProvider reducedMotion={reduce}>
        <Button id="to-a" onClick={() => setPage('a')}>去A</Button>
        <Button id="to-b" onClick={() => setPage('b')}>去B</Button>
        <Button id="reduce" onClick={() => setReduce(true)}>减少动态</Button>
        <div style={{ height: 240, overflow: 'hidden' }}>
          <StageCrossfade swapKey={page}>
            <TrackedPage page={page} />
          </StageCrossfade>
        </div>
      </NxtMotionProvider>
    )
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
            const page =
              (path: string, script: string): Connect.NextHandleFunction =>
              (_request, response, next) => {
                void viteServer
                  .transformIndexHtml(
                    path,
                    '<!doctype html><html><body><div id="root"></div><script type="module" src="' +
                      script +
                      '"></script></body></html>',
                  )
                  .then((html) => {
                    response.setHeader('Content-Type', 'text/html')
                    response.end(html)
                  })
                  .catch(next)
              }
            viteServer.middlewares.use(
              '/__ui-kit_harness__',
              page('/__ui-kit_harness__', '/virtual-ui-kit-harness.tsx'),
            )
            viteServer.middlewares.use(
              '/__motion_harness__',
              page('/__motion_harness__', '/virtual-motion-harness.tsx'),
            )
          },
          resolveId(id) {
            if (id === '/virtual-ui-kit-harness.tsx' || id === '/virtual-motion-harness.tsx') return id
            return undefined
          },
          load(id) {
            if (id === '/virtual-ui-kit-harness.tsx') return harnessModule
            if (id === '/virtual-motion-harness.tsx') return motionHarnessModule
            return undefined
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
      const text = message.text()
      if (
        (message.type() === 'error' || message.type() === 'warning') &&
        !text.startsWith('You have Reduced Motion enabled on your device.')
      ) {
        browserErrors.push(text)
      }
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

  it('opens and closes dialogs without a fade when app Reduced Motion is enabled', async () => {
    await page.goto(`${baseUrl}/__ui-kit_harness__`, { waitUntil: 'domcontentloaded' })
    await page.locator('#reduce-ui').click()
    await page.locator('#short-dialog-trigger').click()
    const dialog = page.getByRole('dialog')
    await expectPage(dialog).toBeVisible()
    expect(
      await dialog.evaluate((element) =>
        element.getAnimations({ subtree: true }).some((animation) => animation.playState === 'running'),
      ),
    ).toBe(false)
    await page.keyboard.press('Escape')
    await expectPage(dialog).toHaveCount(0)
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

  it('actually interpolates opacity when the route key changes', async () => {
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.goto(`${baseUrl}/__motion_harness__`, { waitUntil: 'domcontentloaded' })
    await expectPage(page.getByText('页面甲')).toBeVisible()
    await page.locator('#to-b').click()
    const samples: number[] = []
    let overlap = false
    let outgoingOnTop = false
    for (let step = 0; step < 20; step += 1) {
      await page.waitForTimeout(16)
      const layers = await page.locator('[data-stage-layer]').evaluateAll((nodes) =>
        nodes.map((node) => ({
          phase: node.getAttribute('data-stage-layer'),
          opacity: Number(getComputedStyle(node).opacity),
          zIndex: Number(getComputedStyle(node).zIndex),
        })),
      )
      samples.push(...layers.map((layer) => layer.opacity))
      const outgoing = layers.find((layer) => layer.phase === 'out')
      const incoming = layers.find((layer) => layer.phase === 'in')
      if (outgoing && incoming) {
        overlap = true
        if (outgoing.zIndex > incoming.zIndex) outgoingOnTop = true
      }
    }
    await expectPage(page.getByText('页面乙')).toBeVisible()
    expect(overlap, 'expected outgoing and incoming layers to overlap').toBe(true)
    expect(outgoingOnTop, 'expected the outgoing layer to sit above the incoming layer').toBe(true)
    expect(
      samples.some((value) => value > 0.02 && value < 0.97),
      `expected a mid-transition opacity, got ${samples.join(', ')}`,
    ).toBe(true)
  }, 20_000)

  it('preserves the outgoing subtree and removes it from interaction and accessibility', async () => {
    await page.goto(`${baseUrl}/__motion_harness__`, { waitUntil: 'domcontentloaded' })
    await page.locator('#to-b').click()
    const outgoing = page.locator('[data-stage-layer="out"]')
    await expectPage(outgoing).toHaveAttribute('inert', '')
    await expectPage(outgoing).toHaveAttribute('aria-hidden', 'true')
    expect(await page.evaluate(() => document.documentElement.dataset['motionMounts'] ?? '')).toBe('{"a":1,"b":1}')
  }, 20_000)

  it('makes stage changes instant when the app Reduced Motion setting is enabled', async () => {
    await page.goto(`${baseUrl}/__motion_harness__`, { waitUntil: 'domcontentloaded' })
    await page.locator('#reduce').click()
    await page.locator('#to-b').click()
    await expectPage(page.getByText('页面乙')).toBeVisible()
    await expectPage(page.getByText('页面甲')).toHaveCount(0)
    await expectPage(page.locator('[data-stage-layer]')).toHaveCount(0)
  }, 20_000)

  it('keeps the latest route mounted after rapid key changes', async () => {
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.goto(`${baseUrl}/__motion_harness__`, { waitUntil: 'domcontentloaded' })
    await expectPage(page.getByText('页面甲')).toBeVisible()
    for (let step = 0; step < 12; step += 1) {
      await page.locator('#to-b').click()
      await page.locator('#to-a').click()
    }
    await page.locator('#to-b').click()
    await expectPage(page.locator('[data-stage-layer="in"] #label')).toHaveText('页面乙', { timeout: 3_000 })
    expect(await page.locator('[data-stage-layer="in"]').count()).toBe(1)
    await expectPage(page.locator('[data-stage-layer="out"]')).toHaveCount(0, { timeout: 3_000 })
  }, 20_000)
})
