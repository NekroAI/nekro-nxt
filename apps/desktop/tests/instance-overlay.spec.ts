import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  InstanceOperationError,
  invokeTrustedInstanceOperation,
  toTrustedInstanceError,
  trustedInstanceFailure,
} from '../src/instance-operation-error.ts'
import { renderTrustedFallbackHtml, trustedFallbackForError } from '../src/trusted-fallback.ts'

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let browser: Browser

interface OverlayControl {
  addCalls: number
  reauthenticateCalls: number
  payload?: Record<string, unknown>
  resolve?: () => void
  reject?: (error: Error) => void
}

declare global {
  interface Window {
    __overlayControl: OverlayControl
    nxtInstances: Record<string, unknown>
  }
}

beforeAll(async () => {
  browser = await chromium.launch({ headless: true })
})

afterAll(async () => browser.close())

interface OverlayProfile {
  readonly id: string
  readonly kind: 'local' | 'remote'
  readonly displayName: string
  readonly origin?: string
  readonly addressLabel: string
  readonly status: string
  readonly notificationsEnabled: boolean
  readonly requiresAuthentication: boolean
  readonly insecureHttp: boolean
}

const localProfile: OverlayProfile = {
  id: 'local',
  kind: 'local',
  displayName: '本地实例',
  addressLabel: '此设备',
  status: 'ready',
  notificationsEnabled: true,
  requiresAuthentication: false,
  insecureHttp: false,
}

const openOverlayPage = async (profiles: readonly OverlayProfile[] = [localProfile]): Promise<Page> => {
  const page = await browser.newPage({ viewport: { width: 344, height: 480 }, colorScheme: 'dark' })
  await page.setContent('<!doctype html><html lang="zh-CN"><body><main id="app"></main></body></html>')
  await page.addStyleTag({ path: path.join(desktopRoot, 'src/instance-overlay.css') })
  await page.evaluate((providedProfiles) => {
    const control: OverlayControl = { addCalls: 0, reauthenticateCalls: 0 }
    window.__overlayControl = control
    window.nxtInstances = {
      list: () => Promise.resolve({ currentProfileId: 'local', profiles: providedProfiles }),
      add: (payload: Record<string, unknown>) => {
        control.addCalls += 1
        control.payload = payload
        return new Promise<void>((resolve, reject) => {
          control.resolve = resolve
          control.reject = reject
        })
      },
      switchTo: () => Promise.resolve(),
      retry: () => Promise.resolve(),
      update: () => Promise.resolve(),
      reauthenticate: (payload: Record<string, unknown>) => {
        control.reauthenticateCalls += 1
        control.payload = payload
        return Promise.resolve()
      },
      remove: () => Promise.resolve(),
      close: () => Promise.resolve(),
      subscribe: () => () => undefined,
      subscribeVisibility: (listener: (state: string) => void) => {
        listener('open')
        return () => undefined
      },
    }
  }, profiles)
  await page.addScriptTag({ path: path.join(desktopRoot, 'src/instance-overlay.js'), type: 'module' })
  await page.getByRole('button', { name: /添加远程实例/u }).waitFor()
  return page
}

const enterAddDraft = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: /添加远程实例/u }).click()
  await page.locator('#name').fill('客厅服务器')
  await page.locator('#address').fill('https://nxt.example.test:7443')
  await page.locator('#key').fill('draft-secret-value')
}

describe('Desktop instance overlay accessibility contract', { timeout: 15_000 }, () => {
  it('confirms explicit remote HTTP before the first bridge call and invalidates confirmation after edits', async () => {
    const page = await openOverlayPage()
    await page.getByRole('button', { name: /添加远程实例/u }).click()
    await page.locator('#name').fill('远程 HTTP 实例')
    await page.locator('#address').fill('http://nxt.example.test:80')
    await page.locator('#key').fill('draft-secret-value')
    await page.getByRole('button', { name: '连接并添加' }).click()
    await expect(
      page.getByText('HTTP 连接未加密。管理密钥和设备凭据可能在传输途中被截获或篡改。').isVisible(),
    ).resolves.toBe(true)
    await expect(
      page.evaluate(() => {
        return window.__overlayControl.addCalls
      }),
    ).resolves.toBe(0)

    await page.getByRole('button', { name: '返回检查' }).click()
    await expect(page.locator('#address').inputValue()).resolves.toBe('http://nxt.example.test:80')
    await expect(page.locator('#key').inputValue()).resolves.toBe('draft-secret-value')
    await page.getByRole('button', { name: '连接并添加' }).click()
    await page.getByRole('button', { name: '仍要继续' }).click()
    await expect
      .poll(() =>
        page.evaluate(() => {
          return window.__overlayControl.addCalls
        }),
      )
      .toBe(1)
    const firstPayload = await page.evaluate(() => {
      return window.__overlayControl.payload
    })
    expect(firstPayload).toMatchObject({
      address: 'http://nxt.example.test',
      confirmedInsecureHttpOrigin: 'http://nxt.example.test',
    })
    await page.evaluate(() => {
      window.__overlayControl.reject?.(new Error('测试失败'))
    })
    await page.getByRole('alert').waitFor()

    await page.locator('#address').fill('http://other.example.test:8080')
    await page.getByRole('button', { name: '连接并添加' }).click()
    await expect(page.getByRole('button', { name: '仍要继续' }).isVisible()).resolves.toBe(true)
    await expect(
      page.evaluate(() => {
        return window.__overlayControl.addCalls
      }),
    ).resolves.toBe(1)
    await page.getByRole('button', { name: '仍要继续' }).click()
    await expect
      .poll(() =>
        page.evaluate(() => {
          return window.__overlayControl.addCalls
        }),
      )
      .toBe(2)
    await page.close()
  })

  it('rejects an unknown scheme locally without calling the bridge', async () => {
    const page = await openOverlayPage()
    await page.getByRole('button', { name: /添加远程实例/u }).click()
    await page.locator('#address').fill('ftp://nxt.example.test')
    await page.getByRole('button', { name: '连接并添加' }).click()
    await expect(page.getByRole('alert').textContent()).resolves.toBe('服务器地址只支持 HTTPS 或 HTTP。')
    await expect(
      page.evaluate(() => {
        return window.__overlayControl.addCalls
      }),
    ).resolves.toBe(0)
    await page.close()
  })

  it('warns again before reauthenticating a saved explicit HTTP profile', async () => {
    const remote: OverlayProfile = {
      id: 'remote-http',
      kind: 'remote',
      displayName: 'HTTP 实例',
      origin: 'http://nxt.example.test:8080',
      addressLabel: 'http://nxt.example.test:8080',
      status: 'authentication-required',
      notificationsEnabled: true,
      requiresAuthentication: true,
      insecureHttp: true,
    }
    const page = await openOverlayPage([localProfile, remote])
    await page.getByRole('button', { name: 'HTTP 实例的更多操作' }).click()
    await page.getByRole('menuitem', { name: '重新认证' }).click()
    await expect(page.getByText('此实例使用未加密 HTTP；重新认证前会再次确认传输风险。').isVisible()).resolves.toBe(
      true,
    )
    await page.locator('#key').fill('m'.repeat(32))
    await page.getByRole('button', { name: '重新认证' }).click()
    await expect(page.getByRole('button', { name: '仍要继续' }).isVisible()).resolves.toBe(true)
    await expect(
      page.evaluate(() => {
        return window.__overlayControl.reauthenticateCalls
      }),
    ).resolves.toBe(0)
    await page.getByRole('button', { name: '仍要继续' }).click()
    await expect
      .poll(() =>
        page.evaluate(() => {
          return window.__overlayControl.reauthenticateCalls
        }),
      )
      .toBe(1)
    await page.close()
  })

  it('preserves actual inputs through pending and rejected submission while omitting an empty optional key', async () => {
    const page = await openOverlayPage()
    await enterAddDraft(page)
    await page.getByRole('button', { name: '连接并添加' }).click()
    await expect(page.getByRole('button', { name: '正在连接…' }).isDisabled()).resolves.toBe(true)
    await page.evaluate(() => {
      window.__overlayControl.reject?.(new Error('管理密钥不正确，请检查后重试。'))
    })
    await page.getByRole('alert').waitFor()
    await expect(
      Promise.all([
        page.locator('#name').inputValue(),
        page.locator('#address').inputValue(),
        page.locator('#key').inputValue(),
      ]),
    ).resolves.toEqual(['客厅服务器', 'https://nxt.example.test:7443', 'draft-secret-value'])

    await page.getByRole('button', { name: '取消' }).click()
    await page.getByRole('button', { name: /添加远程实例/u }).click()
    await page.locator('#address').fill('http://127.0.0.1:4960')
    await page.getByRole('button', { name: '连接并添加' }).click()
    const payload = await page.evaluate(() => {
      return window.__overlayControl.payload
    })
    expect(payload).toEqual({ displayName: '', address: 'http://127.0.0.1:4960' })
    await page.close()
  })

  it.each([
    { action: 'cancel', settle: 'reject' },
    { action: 'escape', settle: 'resolve' },
  ] as const)('discards and scrubs a pending draft on $action, ignoring late $settle', async ({ action, settle }) => {
    const page = await openOverlayPage()
    const pageErrors: Error[] = []
    page.on('pageerror', (error) => pageErrors.push(error))
    await enterAddDraft(page)
    await page.getByRole('button', { name: '连接并添加' }).click()
    if (action === 'cancel') await page.getByRole('button', { name: '取消' }).click()
    else await page.keyboard.press('Escape')
    await page.getByRole('button', { name: /添加远程实例/u }).waitFor()
    await page.evaluate((outcome) => {
      if (outcome === 'resolve') window.__overlayControl.resolve?.()
      else window.__overlayControl.reject?.(new Error('late rejection'))
    }, settle)
    await page.waitForTimeout(30)
    await expect(page.getByRole('button', { name: /添加远程实例/u }).isVisible()).resolves.toBe(true)
    await page.getByRole('button', { name: /添加远程实例/u }).click()
    await expect(page.locator('#key').inputValue()).resolves.toBe('')
    await expect(page.locator('#address').inputValue()).resolves.toBe('')
    expect(pageErrors).toEqual([])
    await page.close()
  })

  it('serializes concise trusted errors without leaking Electron IPC wrapper details', async () => {
    const wrapped = new Error("Error invoking remote method 'nxt:instances:add': Error: connect ECONNREFUSED")
    const fallback = trustedInstanceFailure(wrapped)
    const rejected = toTrustedInstanceError(
      new InstanceOperationError('management-key-rejected', '管理密钥不正确，请检查后重试。'),
    )

    expect(fallback).toEqual({
      ok: false,
      error: { code: 'operation-failed', message: '无法完成实例操作，请稍后重试。' },
    })
    expect(rejected).toEqual({ code: 'management-key-rejected', message: '管理密钥不正确，请检查后重试。' })
    expect(JSON.stringify([fallback, rejected])).not.toContain('nxt:instances:add')
    expect(JSON.stringify([fallback, rejected])).not.toContain('Error:')

    const boundaryError = await invokeTrustedInstanceOperation(() => Promise.reject(wrapped), 'add', {
      address: 'https://nxt.example.test',
    }).catch((error: unknown) => error)
    expect(boundaryError).toBeInstanceOf(Error)
    if (!(boundaryError instanceof Error)) throw new Error('trusted boundary 应返回 Error。')
    expect(boundaryError.message).toBe('无法完成实例操作，请稍后重试。')
    expect(boundaryError.message).not.toContain('nxt:instances:add')
    expect(boundaryError.message).not.toContain('Error:')
  })

  it('renders actionable Trusted Fallback DOM without exposing internal diagnostics', async () => {
    const diagnostic = "Error invoking remote method 'nxt:instances:switch': Error: private stack"
    const presentation = trustedFallbackForError(new InstanceOperationError('authentication-required', diagnostic), {
      canReauthenticate: true,
    })
    const page = await browser.newPage({ viewport: { width: 720, height: 480 }, colorScheme: 'dark' })
    await page.setContent(renderTrustedFallbackHtml('无法连接「远程实例」', presentation.body, presentation.actions))

    await expect(page.getByRole('heading', { name: '无法连接「远程实例」' }).isVisible()).resolves.toBe(true)
    await expect(page.getByText('此客户端的设备会话已经失效，请重新认证。').isVisible()).resolves.toBe(true)
    await expect(page.getByRole('link', { name: '重新认证' }).getAttribute('href')).resolves.toBe(
      'nxt-desktop://reauthenticate',
    )
    await expect(page.locator('body').textContent()).resolves.not.toContain('nxt:instances:switch')
    await expect(page.locator('body').textContent()).resolves.not.toContain('Error:')
    await page.close()
  })

  it('keeps every production Trusted Fallback state inside narrow and normal viewports', async () => {
    const scenarios = [
      { name: 'generic', cause: new Error('internal generic diagnostic') },
      {
        name: 'authentication',
        cause: new InstanceOperationError('authentication-required', 'internal authentication diagnostic'),
      },
      {
        name: 'incompatible',
        cause: new InstanceOperationError('incompatible-instance', 'internal incompatible diagnostic'),
      },
    ]
    for (const width of [320, 344, 480, 720]) {
      for (const scenario of scenarios) {
        const presentation = trustedFallbackForError(scenario.cause, { canReauthenticate: true })
        const page = await browser.newPage({ viewport: { width, height: 480 }, colorScheme: 'dark' })
        await page.setContent(
          renderTrustedFallbackHtml(`无法连接「${scenario.name}」`, presentation.body, presentation.actions),
        )
        const geometry = await page.evaluate(() => {
          const card = document.querySelector('.card')
          const copy = document.querySelector('.card p')
          const actions = [...document.querySelectorAll('.actions a')]
          if (!(card instanceof HTMLElement) || !(copy instanceof HTMLElement) || actions.length === 0) {
            throw new Error('Trusted Fallback DOM 不完整。')
          }
          const rectangle = (element: Element) => {
            const bounds = element.getBoundingClientRect()
            const style = getComputedStyle(element)
            return {
              left: bounds.left,
              right: bounds.right,
              top: bounds.top,
              bottom: bounds.bottom,
              width: bounds.width,
              height: bounds.height,
              visible: style.display !== 'none' && style.visibility !== 'hidden',
            }
          }
          return {
            clientWidth: document.documentElement.clientWidth,
            clientHeight: document.documentElement.clientHeight,
            scrollWidth: document.documentElement.scrollWidth,
            card: rectangle(card),
            copy: rectangle(copy),
            actions: actions.map(rectangle),
          }
        })
        const context = `${scenario.name} @ ${width}x480`
        expect(geometry.scrollWidth, context).toBeLessThanOrEqual(geometry.clientWidth)
        expect(geometry.card.left, context).toBeGreaterThanOrEqual(0)
        expect(geometry.card.right, context).toBeLessThanOrEqual(geometry.clientWidth)
        expect(geometry.card.width, context).toBeGreaterThan(0)
        expect(geometry.copy.width, context).toBeGreaterThan(0)
        expect(geometry.copy.visible, context).toBe(true)
        for (const action of geometry.actions) {
          expect(action.visible, context).toBe(true)
          expect(action.width, context).toBeGreaterThan(0)
          expect(action.height, context).toBeGreaterThan(0)
          expect(action.left, context).toBeGreaterThanOrEqual(geometry.card.left)
          expect(action.right, context).toBeLessThanOrEqual(geometry.card.right)
          expect(action.top, context).toBeGreaterThanOrEqual(0)
          expect(action.bottom, context).toBeLessThanOrEqual(geometry.clientHeight)
        }
        await page.close()
      }
    }
  })

  it('uses adjacent native controls with valid list and popup semantics', async () => {
    const source = await readFile(path.join(desktopRoot, 'src/instance-overlay.js'), 'utf8')

    expect(source).toContain('<ul class="list" aria-label="服务实例列表">')
    expect(source).toContain('<li class="instance-item">')
    expect(source).toContain('<button class="more"')
    expect(source).toContain('aria-haspopup="menu"')
    expect(source).toContain("aria-expanded=\"${menuOpen ? 'true' : 'false'}\"")
    expect(source).toContain('role="menu"')
    expect(source).toContain('role="menuitem"')
    expect(source).not.toContain('role="button"')
    expect(source).not.toContain('tabindex="0"')

    const instanceButton = source.match(/<button class="instance[\s\S]*?<\/button>/u)?.[0] ?? ''
    expect(instanceButton).not.toContain('class="more"')
    expect(instanceButton.match(/<button/gu)).toHaveLength(1)
  })

  it('uses a bidirectional trigger-aligned transition and reduced-motion fallback', async () => {
    const [script, stylesheet, markup] = await Promise.all([
      readFile(path.join(desktopRoot, 'src/instance-overlay.js'), 'utf8'),
      readFile(path.join(desktopRoot, 'src/instance-overlay.css'), 'utf8'),
      readFile(path.join(desktopRoot, 'src/instance-overlay.html'), 'utf8'),
    ])
    expect(markup).toContain('data-visibility="closed"')
    expect(script).toContain('bridge.subscribeVisibility')
    expect(script).toContain("dataset.visibility = 'closing'")
    expect(stylesheet).toContain('transform-origin: left bottom')
    expect(stylesheet).toContain('--motion-enter: 160ms')
    expect(stylesheet).toContain('--motion-exit: 100ms')
    expect(stylesheet).toContain('@media (prefers-reduced-motion: reduce)')
  })

  it('keeps native Enter/Space activation and implements popup arrow/Escape focus restoration', async () => {
    const source = await readFile(path.join(desktopRoot, 'src/instance-overlay.js'), 'utf8')

    expect(source).toContain("event.key === 'ArrowDown' || event.key === 'ArrowUp'")
    expect(source).toContain('menu.querySelectorAll(\'[role="menuitem"]\')')
    expect(source).toContain("if (event.key === 'Escape')")
    expect(source).toContain("focusControl(profileId ? 'more' : 'add', profileId)")
    expect(source).not.toMatch(/event\.key === ['"](?:Enter| )['"]/u)
  })

  it('keeps address fields out of existing-Profile update and reauthentication IPC', async () => {
    const overlay = await readFile(path.join(desktopRoot, 'src/instance-overlay.js'), 'utf8')
    const manager = await readFile(path.join(desktopRoot, 'src/instance-manager.ts'), 'utf8')

    const reauthentication = overlay.match(/bridge\.reauthenticate\(\{[\s\S]*?\}\)/u)?.[0] ?? ''
    expect(reauthentication).not.toContain('address')
    expect(manager).toContain("if ('origin' in value)")
    expect(manager).toContain("if ('address' in value || 'origin' in value)")
  })
})
