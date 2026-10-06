import { chromium, expect, test, type Browser, type Page } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Connect, type ViteDevServer } from 'vite'

/** Behaviour of the redesigned kit (Decision 2026-10-06 §7) in a real browser, outside the product. */
const harnessModule = `
  import React, { useState } from 'react'
  import { createRoot } from 'react-dom/client'
  import { installStableCursorIntent } from '/src/cursor-stability.ts'
  import {
    Button, ConfirmDialog, Dialog, IconButton, Popover, Segmented, Select, Toaster, TooltipProvider, toast,
  } from '/src/ui-kit/index.ts'
  import '/src/ui-kit/tokens.css'

  installStableCursorIntent()
  document.documentElement.dataset.ui = 'next'

  function Harness() {
    const [dialog, setDialog] = useState(false)
    const [media, setMedia] = useState(false)
    const [confirm, setConfirm] = useState(false)
    const [fail, setFail] = useState(true)
    const [choice, setChoice] = useState('')
    const [mode, setMode] = useState('a')
    const [sequence, setSequence] = useState(0)
    return <TooltipProvider><main style={{ padding: 24, display: 'grid', gap: 12, justifyItems: 'start' }}>
      <Button id="open-dialog" onClick={() => setDialog(true)}>打开对话框</Button>
      <Button id="open-media" onClick={() => setMedia(true)}>打开预览</Button>
      <Button id="open-confirm" onClick={() => setConfirm(true)}>删除</Button>
      <Button id="cursor-control"><span id="cursor-copy">稳定指针</span></Button>
      <input id="cursor-text" aria-label="指针测试输入框" />
      <IconButton id="icon" label="新建内置频道"><span>+</span></IconButton>
      <div style={{ width: 240 }}>
        <Select aria-label="识图模型" value={choice} onValueChange={setChoice}
          options={[{ value: '', label: '跟随主模型' }, { value: 'vision', label: '识图模型甲' }, { value: 'off', label: '不识图', disabled: true }]} />
      </div>
      <output id="choice">{choice === '' ? '空' : choice}</output>
      <Popover label="需要关注" trigger={<Button id="popover-trigger">关注</Button>}>
        <p>一条提醒</p><Button id="inside-popover">处理</Button>
      </Popover>
      <Segmented label="范围" value={mode} onChange={setMode}
        options={[{ value: 'a', label: '全部频道' }, { value: 'b', label: '只看未接线的频道' }]} />
      <Button id="grouped" onClick={() => { const next = sequence + 1; setSequence(next); toast('同步结果 ' + next, { group: 'sync' }) }}>分组通知</Button>
      <Button id="failure" onClick={() => toast('保存失败', { tone: 'bad', group: 'save' })}>错误通知</Button>
      <Dialog open={dialog} onOpenChange={setDialog} title="测试对话框"
        actions={<Button onClick={() => setDialog(false)}>完成</Button>}>
        <p>短内容</p>
      </Dialog>
      <Dialog open={media} onOpenChange={setMedia} title="很长的文件名.pdf" media closeLabel="关闭预览">
        <div id="tall" style={{ height: 3000 }}>可滚动内容</div>
      </Dialog>
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title="删除这个频道？" confirmLabel="删除" danger
        onConfirm={() => new Promise((resolve, reject) => setTimeout(() => fail ? (setFail(false), reject(new Error('频道正在使用'))) : resolve(undefined), 300))}>
        <p>删除后无法恢复。</p>
      </ConfirmDialog>
      <Toaster />
    </main></TooltipProvider>
  }

  createRoot(document.querySelector('#root')).render(<Harness />)
`

test.describe('ui-kit browser behaviour', () => {
  test.describe.configure({ mode: 'default', timeout: 30_000 })
  let server: ViteDevServer
  let browser: Browser
  let page: Page
  let baseUrl: string
  let cacheDirectory: string
  const browserErrors: string[] = []

  test.beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), 'nxt-ui-kit-browser-'))
    server = await createServer({
      root: fileURLToPath(new URL('../', import.meta.url)),
      configFile: false,
      cacheDir: cacheDirectory,
      logLevel: 'silent',
      plugins: [
        react(),
        {
          name: 'ui-kit-browser-harness',
          configureServer(viteServer) {
            const handler: Connect.NextHandleFunction = (_request, response, next) => {
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
            }
            viteServer.middlewares.use('/__ui-kit_harness__', handler)
          },
          resolveId: (id) => (id === '/virtual-ui-kit-harness.tsx' ? id : undefined),
          load: (id) => (id === '/virtual-ui-kit-harness.tsx' ? harnessModule : undefined),
        },
      ],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const address = server.httpServer?.address()
    if (!address || typeof address === 'string') throw new Error('Vite test server did not expose a TCP port.')
    baseUrl = `http://127.0.0.1:${address.port}`
    browser = await chromium.launch({ headless: true })
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    page.on('pageerror', (error) => browserErrors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') browserErrors.push(message.text())
    })
  })

  test.beforeEach(async () => {
    await page.goto(`${baseUrl}/__ui-kit_harness__`)
    await expect(page.locator('#open-dialog')).toBeVisible()
  })

  test.afterAll(async () => {
    await page?.close()
    await browser?.close()
    await server?.close()
    if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true })
  })

  test('a dialog closes on Escape and gives focus back to its opener', async () => {
    await page.locator('#open-dialog').click()
    await expect(page.getByRole('dialog', { name: '测试对话框' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.locator('#open-dialog')).toBeFocused()
    expect(browserErrors).toEqual([])
  })

  test('a media dialog stays inside the window, scrolls its body and closes from its title row', async () => {
    await page.locator('#open-media').click()
    const dialog = page.getByRole('dialog', { name: '很长的文件名.pdf' })
    await expect(dialog).toBeVisible()
    const box = await dialog.boundingBox()
    expect(box && box.y + box.height).toBeLessThanOrEqual(800)
    const body = page.locator('#tall').locator('..')
    expect(await body.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
    await dialog.getByRole('button', { name: '关闭预览' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.locator('#open-media')).toBeFocused()
  })

  test('a confirmation stays open while it runs and shows a failure in place', async () => {
    await page.locator('#open-confirm').click()
    const dialog = page.getByRole('dialog', { name: '删除这个频道？' })
    await dialog.getByRole('button', { name: '删除' }).click()
    // While confirming, Escape does not dismiss the dialog.
    await page.keyboard.press('Escape')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('alert')).toHaveText('频道正在使用')
    await dialog.getByRole('button', { name: '删除' }).click()
    await expect(dialog).toHaveCount(0)
  })

  test('a select opens the product list, chooses by keyboard and keeps an empty value as a real option', async () => {
    const select = page.getByRole('combobox', { name: '识图模型' })
    await expect(select).toHaveText('跟随主模型')
    await select.click()
    await expect(page.getByRole('option', { name: '不识图' })).toHaveAttribute('data-disabled', '')
    // Radix ignores keys for a moment after a pointer open (it guards against a drag selecting on release).
    const first = page.getByRole('option', { name: '跟随主模型' })
    const vision = page.getByRole('option', { name: '识图模型甲' })
    await expect(async () => {
      if (await first.evaluate((element) => element === document.activeElement)) await page.keyboard.press('ArrowDown')
      await expect(vision).toBeFocused({ timeout: 100 })
    }).toPass()
    await page.keyboard.press('Enter')
    await expect(page.locator('#choice')).toHaveText('vision')
    await expect(select).toHaveText('识图模型甲')
    await select.click()
    await page.getByRole('option', { name: '跟随主模型' }).click()
    await expect(page.locator('#choice')).toHaveText('空')
    await expect(select).toBeFocused()
  })

  test('a popover opens under its trigger and Escape returns focus to it', async () => {
    const trigger = page.locator('#popover-trigger')
    await trigger.click()
    const panel = page.getByRole('dialog', { name: '需要关注' })
    await expect(panel.getByText('一条提醒')).toBeVisible()
    const [panelBox, triggerBox] = [await panel.boundingBox(), await trigger.boundingBox()]
    expect(panelBox && triggerBox && panelBox.y).toBeGreaterThanOrEqual(
      (triggerBox?.y ?? 0) + (triggerBox?.height ?? 0),
    )
    await page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
    await expect(trigger).toBeFocused()
  })

  test('notifications of one group replace each other, announce themselves and close by hand', async () => {
    await page.locator('#grouped').click()
    await page.locator('#grouped').click()
    await expect(page.getByRole('status').filter({ hasText: '同步结果' })).toHaveCount(1)
    await expect(page.getByRole('status').filter({ hasText: '同步结果 2' })).toBeVisible()
    await page.locator('#failure').click()
    const failure = page.getByRole('alert').filter({ hasText: '保存失败' })
    await expect(failure).toBeVisible()
    await failure.getByRole('button', { name: '关闭通知' }).click()
    await expect(failure).toHaveCount(0)
    // Confirmations leave on their own; failures stay longer for reading.
    await expect(page.getByRole('status').filter({ hasText: '同步结果' })).toHaveCount(0, { timeout: 5_000 })
  })

  test('the segmented indicator animates its move and lands on the new option', async () => {
    const indicator = page.getByRole('radiogroup', { name: '范围' }).locator('span[aria-hidden="true"]')
    const target = page.getByRole('radio', { name: '只看未接线的频道' })
    // Frame-by-frame sliding is covered by the motion audit; here the move must be a transition, not a jump.
    // Transitions switch on two frames after mount, so the first paint never slides in from the corner.
    await expect(async () => {
      const transition = await indicator.evaluate((element) => {
        const style = getComputedStyle(element)
        return { property: style.transitionProperty, duration: style.transitionDuration }
      })
      expect(transition.property).toMatch(/transform|all/u)
      expect(Number.parseFloat(transition.duration)).toBeGreaterThan(0)
    }).toPass()
    await target.click()
    await expect(target).toHaveAttribute('aria-checked', 'true')
    await expect(async () => {
      const [indicatorBox, targetBox] = [await indicator.boundingBox(), await target.boundingBox()]
      expect(Math.abs((indicatorBox?.x ?? 0) - (targetBox?.x ?? 0))).toBeLessThan(2)
      expect(Math.abs((indicatorBox?.width ?? 0) - (targetBox?.width ?? 0))).toBeLessThan(2)
    }).toPass()
  })

  test('controls keep the hand cursor across their descendants and text fields keep the caret', async () => {
    await page.locator('#cursor-copy').hover()
    await expect(page.locator('html')).toHaveAttribute('data-nxt-cursor', 'pointer')
    expect(await page.locator('#cursor-copy').evaluate((element) => getComputedStyle(element).cursor)).toBe('pointer')
    await page.locator('#cursor-text').hover()
    await expect(page.locator('html')).toHaveAttribute('data-nxt-cursor', 'text')
    expect(await page.locator('#cursor-text').evaluate((element) => getComputedStyle(element).cursor)).toBe('text')
  })

  test('an icon button names itself for screen readers and on hover', async () => {
    const button = page.getByRole('button', { name: '新建内置频道' })
    await expect(button).toHaveAttribute('title', '新建内置频道')
    await expect(button).toHaveAttribute('type', 'button')
  })
})
