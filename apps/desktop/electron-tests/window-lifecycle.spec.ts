import { _electron, expect, test, type ElectronApplication } from '@playwright/test'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(path.join(desktopRoot, 'package.json'))

// The only Host is a synthetic loopback service. No real data, credentials or Server runtime are used.
const fixture = `
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root = process.env.NEKRO_DATA;
await mkdir(root, { recursive: true });
const html = '<!doctype html><html lang="zh-CN" data-theme="light"><meta charset="utf-8"><title>窗口生命周期验收</title><style>body{margin:0;background:#f5f2ee;color:#14243d;font:18px system-ui}header{height:48px;background:#14243d;color:white;padding-left:100px;line-height:48px}main{padding:64px}h1{font-size:32px}p{line-height:1.8}button{padding:12px 20px;border:1px solid #14243d;border-radius:6px;background:white}</style><header>NekroNXT · 合成验收工作区</header><main><h1>窗口已恢复</h1><p>本窗口仅使用临时合成数据。关闭窗口后，本地 Host 继续运行。</p><label>未提交草稿 <input id="draft" value="合成草稿"></label><p><button onclick="document.querySelector(\\'#count\\').textContent=Number(document.querySelector(\\'#count\\').textContent)+1">交互检查</button> <span id="count">0</span></p></main></html>';
const server = createServer((req, res) => {
  if (req.url.startsWith('/health/ready')) {
    const ready = existsSync(path.join(root, 'allow-ready'));
    res.writeHead(ready ? 200 : 503, {'content-type':'application/json'});
    res.end(JSON.stringify({status:ready?'ready':'starting',releaseId:process.env.NEKRO_RELEASE_ID}));
  } else if (req.url.startsWith('/api/')) {
    res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({items:[],cursor:0}));
  } else { res.writeHead(200, {'content-type':'text/html'}); res.end(html); }
});
server.listen(Number(process.env.NEKRO_PORT), '127.0.0.1', async () => {
  await writeFile(path.join(root,'host.json'),JSON.stringify({pid:process.pid,origin:'http://127.0.0.1:'+process.env.NEKRO_PORT}));
});
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await writeFile(path.join(root,'cancel-received'),'yes');
  if (process.env.NXT_FIXTURE_IGNORE_CANCEL === '1') return;
  await new Promise(resolve => setTimeout(resolve, 300));
  await new Promise(resolve => server.close(resolve));
  await writeFile(path.join(root,'stopped'),'yes');
  process.exit(0);
}
process.on('SIGTERM', () => { void stop(); });
process.parentPort?.on('message', ({data}) => { if(data.action==='cancel') void stop(); });
`

const launch = async (ignoreCancel = false) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'nxt-window-lifecycle-'))
  const staged = path.join(temporary, 'desktop')
  await cp(path.join(desktopRoot, 'dist'), staged, {
    recursive: true,
    filter: (source) => source !== path.join(desktopRoot, 'dist', 'runtime'),
  })
  await symlink(path.join(desktopRoot, 'node_modules'), path.join(staged, 'node_modules'), 'junction')
  await mkdir(path.join(staged, 'runtime', 'dist'), { recursive: true })
  await writeFile(path.join(staged, 'runtime', 'dist', 'main.mjs'), fixture)
  await writeFile(
    path.join(staged, 'product-release.json'),
    JSON.stringify({
      format: 'nxt.product-release',
      channel: 'preview',
      baseVersion: '0.1.0',
      version: '0.1.0-test',
      commit: '1'.repeat(40),
      releaseId: 'desktop-window-fixture',
      dshVersion: '0.1.7-rc.2',
    }),
  )
  const executablePath: unknown = require('electron')
  if (typeof executablePath !== 'string') throw new Error('Electron executable is unavailable')
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE') env[key] = value
  const userData = path.join(temporary, 'user-data')
  const electron = await _electron.launch({
    executablePath,
    args: [path.join(staged, 'main.mjs')],
    env: {
      ...env,
      NEKRO_DESKTOP_USER_DATA: userData,
      NXT_FIXTURE_IGNORE_CANCEL: ignoreCancel ? '1' : '0',
    },
  })
  const data = path.join(userData, 'data')
  const errors: string[] = []
  electron.process().stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString()
    if (/Uncaught|UnhandledPromiseRejection|Error occurred in handler/u.test(text)) errors.push(text)
  })
  const record = (page: ReturnType<ElectronApplication['windows']>[number]) => {
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })
  }
  electron.windows().forEach(record)
  electron.on('window', record)
  return { temporary, data, electron, errors }
}

const readHost = async (data: string): Promise<{ pid: number; origin: string }> => {
  await expect.poll(() => readFile(path.join(data, 'host.json'), 'utf8').catch(() => '')).not.toBe('')
  const value: unknown = JSON.parse(await readFile(path.join(data, 'host.json'), 'utf8'))
  if (typeof value !== 'object' || value === null) throw new Error('host.json is not an object')
  const { pid, origin } = value as { pid?: unknown; origin?: unknown }
  if (typeof pid !== 'number' || typeof origin !== 'string') throw new Error('host.json is missing pid or origin')
  return { pid, origin }
}
const assertStopped = async (pid: number, origin: string) => {
  await expect
    .poll(() => {
      try {
        process.kill(pid, 0)
        return false
      } catch {
        return true
      }
    })
    .toBe(true)
  await expect
    .poll(async () =>
      fetch(`${origin}/health/ready`).then(
        () => false,
        () => true,
      ),
    )
    .toBe(true)
}
const productWindow = async (electron: ElectronApplication) => {
  await expect
    .poll(() => electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getTitle())))
    .toEqual(['NekroNXT — 本地实例'])
}
const saveWindow = async (electron: ElectronApplication, name: string) => {
  const base64 = await electron.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0]!.capturePage()).toPNG().toString('base64'),
  )
  await writeFile(test.info().outputPath(name), Buffer.from(base64, 'base64'))
}

// Uses native BrowserWindow close and the actual app activate handler on macOS.
// A physical Dock click and Windows Explorer's tray still require target-platform acceptance.
test('macOS keeps hidden startup through handoff, restores its product and stops Host on explicit quit', async () => {
  test.skip(process.platform !== 'darwin', 'macOS native lifecycle')
  const { electron, data, temporary, errors } = await launch()
  let closed = false
  try {
    const startup = await electron.firstWindow()
    await expect(startup.getByRole('heading', { name: '正在启动', exact: true })).toBeVisible()
    const host = await readHost(data)
    await startup.screenshot({ path: test.info().outputPath('startup-visible.png') })
    await electron.evaluate(({ app, BrowserWindow }) => {
      const shown: number[] = []
      Object.assign(globalThis, { nxtTestShown: shown })
      app.on('browser-window-created', (_event, window) => window.on('show', () => shown.push(window.id)))
      BrowserWindow.getAllWindows()[0]!.close()
    })
    expect(
      await electron.evaluate(({ BrowserWindow, app }) => ({
        visible: BrowserWindow.getAllWindows()[0]!.isVisible(),
        destroyed: BrowserWindow.getAllWindows()[0]!.isDestroyed(),
        dock: app.dock?.isVisible(),
      })),
    ).toEqual({ visible: false, destroyed: false, dock: true })
    await writeFile(path.join(data, 'allow-ready'), 'yes')
    await productWindow(electron)
    expect(
      await electron.evaluate(({ BrowserWindow }) => ({
        visible: BrowserWindow.getAllWindows()[0]!.isVisible(),
        shown: Reflect.get(globalThis, 'nxtTestShown') as unknown,
      })),
    ).toEqual({ visible: false, shown: [] })
    expect((await fetch(`${host.origin}/health/ready`)).ok).toBe(true)
    await electron.evaluate(({ app }) => app.emit('activate'))
    await expect
      .poll(() => electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible()))
      .toBe(true)
    const product = electron
      .context()
      .pages()
      .find((page) => page.url().startsWith(host.origin))!
    await expect(product.getByRole('heading', { name: '窗口已恢复' })).toBeVisible()
    await product.locator('#draft').fill('隐藏后仍保留的合成草稿')
    await product.getByRole('button', { name: '交互检查' }).click()
    await expect(product.locator('#count')).toHaveText('1')
    await saveWindow(electron, 'product-after-activate.png')
    const id = await electron.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]!
      w.close()
      return w.id
    })
    expect(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible())).toBe(false)
    expect((await fetch(`${host.origin}/health/ready`)).ok).toBe(true)
    await electron.evaluate(({ app }) => app.emit('activate'))
    expect(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.id)).toBe(id)
    await expect(product.locator('#draft')).toHaveValue('隐藏后仍保留的合成草稿')
    const presentation: unknown = await product.evaluate('window.nekroDesktopShell.getCurrentInstancePresentation()')
    expect(presentation).toMatchObject({ status: 'ready' })
    await saveWindow(electron, 'product-reopened.png')
    const quit = electron.waitForEvent('close')
    await electron.evaluate(({ app }) => {
      app.quit()
      app.quit()
    })
    await quit
    closed = true
    expect(await readFile(path.join(data, 'stopped'), 'utf8')).toBe('yes')
    await assertStopped(host.pid, host.origin)
    expect(errors).toEqual([])
  } finally {
    if (!closed) await electron.close()
    await rm(temporary, { recursive: true, force: true })
  }
})

test('explicit quit terminates a ready Host that ignores cooperative cancellation', async () => {
  const { electron, data, temporary, errors } = await launch(true)
  let closed = false
  try {
    await electron.firstWindow()
    const host = await readHost(data)
    await writeFile(path.join(data, 'allow-ready'), 'yes')
    await productWindow(electron)
    const quit = electron.waitForEvent('close')
    await electron.evaluate(({ app }) => app.quit())
    await expect.poll(() => readFile(path.join(data, 'cancel-received'), 'utf8').catch(() => '')).toBe('yes')
    // The real 15-second production grace period is used; no test-only shutdown policy.
    await quit
    closed = true
    expect(await readFile(path.join(data, 'stopped'), 'utf8').catch(() => '')).toBe('')
    await assertStopped(host.pid, host.origin)
    expect(errors).toEqual([])
  } finally {
    if (!closed) await electron.close()
    await rm(temporary, { recursive: true, force: true })
  }
})
