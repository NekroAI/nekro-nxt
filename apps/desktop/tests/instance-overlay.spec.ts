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
  closeCalls: number
  snapshot: { revision: number; currentProfileId: string; profiles: readonly OverlayProfile[] }
  snapshotListener?: (snapshot: OverlayControl['snapshot']) => void
  visibilityListener?: (visibility: unknown) => void
  payload?: Record<string, unknown>
  resolve?: () => void
  reject?: (error: Error) => void
}

declare global {
  interface Window {
    __overlayControl: OverlayControl
    __focusedOverlayNode?: Element
    __compositionEndCount?: number
    __overlayAnimationFrames?: FrameRequestCallback[]
    __flushOverlayAnimationFrames?: () => void
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

const remoteProfile: OverlayProfile = {
  id: 'remote-1',
  kind: 'remote',
  displayName: '北辰实例',
  origin: 'https://remote.example.test:7443',
  addressLabel: 'remote.example.test:7443',
  status: 'ready',
  notificationsEnabled: true,
  requiresAuthentication: true,
  insecureHttp: false,
}

const openOverlayPage = async (profiles: readonly OverlayProfile[] = [localProfile]): Promise<Page> => {
  const page = await browser.newPage({ viewport: { width: 980, height: 632 }, colorScheme: 'dark' })
  await page.setContent('<!doctype html><html lang="zh-CN"><body><main id="app"></main></body></html>')
  await page.addStyleTag({ path: path.join(desktopRoot, 'src/instance-overlay.css') })
  await page.evaluate((providedProfiles) => {
    const control: OverlayControl = {
      addCalls: 0,
      reauthenticateCalls: 0,
      closeCalls: 0,
      snapshot: { revision: 1, currentProfileId: 'local', profiles: providedProfiles },
    }
    window.__overlayControl = control
    window.nxtInstances = {
      list: () => Promise.resolve(control.snapshot),
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
      close: () => {
        control.closeCalls += 1
        return Promise.resolve()
      },
      subscribe: (listener: (snapshot: OverlayControl['snapshot']) => void) => {
        control.snapshotListener = listener
        return () => {
          delete control.snapshotListener
        }
      },
      subscribeVisibility: (listener: (state: unknown) => void) => {
        control.visibilityListener = listener
        listener({ state: 'open', intent: { kind: 'list' } })
        return () => {
          delete control.visibilityListener
        }
      },
    }
  }, profiles)
  await page.addScriptTag({ path: path.join(desktopRoot, 'src/instance-overlay.js'), type: 'module' })
  await page.getByRole('button', { name: /添加远程实例/u }).waitFor()
  return page
}

const deferOverlayAnimationFrames = (page: Page): Promise<void> =>
  page.evaluate(() => {
    const callbacks: FrameRequestCallback[] = []
    window.__overlayAnimationFrames = callbacks
    window.requestAnimationFrame = (callback) => {
      callbacks.push(callback)
      return callbacks.length
    }
    window.__flushOverlayAnimationFrames = () => {
      const pending = callbacks.splice(0)
      const timestamp = performance.now()
      for (const callback of pending) callback(timestamp)
    }
  })

const flushOverlayAnimationFrames = (page: Page): Promise<void> =>
  page.evaluate(() => window.__flushOverlayAnimationFrames?.())

const waitForOverlayAnimationFrame = (page: Page): Promise<void> =>
  page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))

const enterAddDraft = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: /添加远程实例/u }).click()
  await page.locator('#name').fill('客厅服务器')
  await page.locator('#address').fill('https://nxt.example.test:7443')
  await page.locator('#key').fill('draft-secret-value')
}

const publishSnapshot = async (
  page: Page,
  profiles: readonly OverlayProfile[],
  currentProfileId = 'local',
): Promise<void> => {
  await page.evaluate(
    ({ nextProfiles, nextCurrentProfileId }) => {
      const control = window.__overlayControl
      control.snapshot = {
        revision: control.snapshot.revision + 1,
        currentProfileId: nextCurrentProfileId,
        profiles: nextProfiles,
      }
      control.snapshotListener?.(control.snapshot)
    },
    { nextProfiles: profiles, nextCurrentProfileId: currentProfileId },
  )
}

const expectFocusedFieldStableThroughSnapshots = async (
  page: Page,
  selector: string,
  profiles: readonly OverlayProfile[],
): Promise<void> => {
  const before = await page.locator(selector).inputValue()
  const end = Math.max(1, before.length - 1)
  await page.locator(selector).evaluate((element, selectionEnd) => {
    if (!(element instanceof HTMLInputElement)) throw new Error('目标字段不是输入框。')
    window.__focusedOverlayNode = element
    window.__compositionEndCount = 0
    element.addEventListener('compositionend', () => {
      window.__compositionEndCount = (window.__compositionEndCount ?? 0) + 1
    })
    element.focus()
    element.setSelectionRange(1, selectionEnd, 'backward')
    element.dispatchEvent(new CompositionEvent('compositionstart', { data: '月' }))
    element.dispatchEvent(new CompositionEvent('compositionupdate', { data: '月潮' }))
  }, end)

  for (const status of ['ready', 'offline', 'ready'] as const) {
    await publishSnapshot(
      page,
      profiles.map((profile) => ({ ...profile, status })),
    )
  }

  const after = await page.locator(selector).evaluate((element) => {
    if (!(element instanceof HTMLInputElement)) throw new Error('目标字段不是输入框。')
    return {
      sameNode: element === window.__focusedOverlayNode,
      active: document.activeElement === element,
      value: element.value,
      selectionStart: element.selectionStart,
      selectionEnd: element.selectionEnd,
      selectionDirection: element.selectionDirection,
      compositionEndCount: window.__compositionEndCount,
    }
  })
  expect(after).toEqual({
    sameNode: true,
    active: true,
    value: before,
    selectionStart: 1,
    selectionEnd: end,
    selectionDirection: 'backward',
    compositionEndCount: 0,
  })
  await page.locator(selector).dispatchEvent('compositionend', { data: '月潮' })
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

  it('keeps add-form name, address, and key nodes, caret, selection, and composition through status snapshots', async () => {
    const page = await openOverlayPage([localProfile, remoteProfile])
    await enterAddDraft(page)

    for (const selector of ['#name', '#address', '#key']) {
      await expectFocusedFieldStableThroughSnapshots(page, selector, [localProfile, remoteProfile])
    }

    await page.close()
  })

  it('keeps edit and reauthentication fields stable through snapshots and exits only when the target is removed', async () => {
    const page = await openOverlayPage([localProfile, remoteProfile])
    await page.getByRole('button', { name: '北辰实例的更多操作' }).click()
    await page.getByRole('menuitem', { name: '修改名称' }).click()
    await page.locator('#name').fill('北辰工作区')
    await expectFocusedFieldStableThroughSnapshots(page, '#name', [localProfile, remoteProfile])

    await page.getByRole('button', { name: '取消' }).click()
    await page.getByRole('menuitem', { name: '重新认证' }).click()
    await page.locator('#key').fill('synthetic-management-key')
    await expectFocusedFieldStableThroughSnapshots(page, '#key', [localProfile, remoteProfile])

    await publishSnapshot(page, [localProfile])
    await expect(page.getByRole('button', { name: /添加远程实例/u }).isVisible()).resolves.toBe(true)
    await expect(page.locator('#key').count()).resolves.toBe(0)
    await page.close()
  })

  it('opens a Fallback reauthentication intent directly with an empty focused secret and clears it on close', async () => {
    const page = await openOverlayPage([localProfile, remoteProfile])
    await page.evaluate(() => {
      window.__overlayControl.visibilityListener?.({
        state: 'open',
        intent: { kind: 'reauthenticate', profileId: 'remote-1' },
      })
    })
    await waitForOverlayAnimationFrame(page)
    await expect(page.getByRole('heading', { name: '重新认证' }).isVisible()).resolves.toBe(true)
    await expect(page.locator('#key').inputValue()).resolves.toBe('')
    await expect(page.locator('#key').evaluate((element) => document.activeElement === element)).resolves.toBe(true)
    await page.locator('#key').fill('synthetic-management-key')

    await page.evaluate(() => window.__overlayControl.visibilityListener?.({ state: 'closing' }))
    await expect(page.locator('#key').count()).resolves.toBe(0)
    await page.evaluate(() => {
      window.__overlayControl.visibilityListener?.({
        state: 'open',
        intent: { kind: 'reauthenticate', profileId: 'remote-1' },
      })
    })
    await waitForOverlayAnimationFrame(page)
    await expect(page.locator('#key').inputValue()).resolves.toBe('')
    await expect(page.locator('#key').evaluate((element) => document.activeElement === element)).resolves.toBe(true)
    await page.close()
  })

  it('patches list status in place while preserving the focused instance control', async () => {
    const page = await openOverlayPage([localProfile, remoteProfile])
    const remoteButton = page.getByRole('button', { name: /北辰实例/u }).first()
    await remoteButton.focus()
    await remoteButton.evaluate((element) => {
      window.__focusedOverlayNode = element
    })

    await publishSnapshot(page, [localProfile, { ...remoteProfile, status: 'offline' }])
    await expect(remoteButton.getAttribute('aria-current')).resolves.toBe('false')
    await expect(remoteButton.textContent()).resolves.toContain('无法连接')
    await expect(remoteButton.locator('.dot.offline').count()).resolves.toBe(1)
    await publishSnapshot(page, [localProfile, { ...remoteProfile, status: 'ready' }])

    const identity = await remoteButton.evaluate((element) => ({
      sameNode: element === window.__focusedOverlayNode,
      active: document.activeElement === element,
    }))
    expect(identity).toEqual({ sameNode: true, active: true })
    await expect(remoteButton.textContent()).resolves.toContain('运行正常')
    await page.close()
  })

  it('uses backdrop and Escape as one Sheet hierarchy and traps Tab inside the panel', async () => {
    const page = await openOverlayPage([localProfile, remoteProfile])
    await deferOverlayAnimationFrames(page)
    await page.getByRole('button', { name: /添加远程实例/u }).click()
    await page.locator('#key').fill('synthetic-management-key')
    await page.locator('.sheet-backdrop').click({ position: { x: 900, y: 60 } })
    await expect(page.getByRole('button', { name: /添加远程实例/u }).isVisible()).resolves.toBe(true)
    await expect(page.evaluate(() => window.__overlayControl.closeCalls)).resolves.toBe(0)
    await page.getByRole('button', { name: /添加远程实例/u }).click()
    await expect(page.locator('#key').inputValue()).resolves.toBe('')
    await page.keyboard.press('Escape')

    const add = page.getByRole('button', { name: /添加远程实例/u })
    await add.focus()
    await page.keyboard.press('Tab')
    await flushOverlayAnimationFrames(page)
    await expect(page.evaluate(() => document.activeElement?.getAttribute('data-action'))).resolves.toBe('switch')
    await page.locator('.sheet-backdrop').click({ position: { x: 900, y: 60 } })
    await expect(page.evaluate(() => window.__overlayControl.closeCalls)).resolves.toBe(1)
    await page.close()
  })

  it('cancels stale focus callbacks across consecutive mode changes', async () => {
    const page = await openOverlayPage([localProfile, remoteProfile])
    await deferOverlayAnimationFrames(page)
    await page.getByRole('button', { name: /添加远程实例/u }).click()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: '北辰实例的更多操作' }).click()
    await page.getByRole('menuitem', { name: '修改名称' }).click()

    await expect(page.evaluate(() => document.activeElement === document.body)).resolves.toBe(true)
    await flushOverlayAnimationFrames(page)
    await expect(page.getByRole('heading', { name: '修改实例名称' }).isVisible()).resolves.toBe(true)
    await expect(page.locator('#name').evaluate((element) => document.activeElement === element)).resolves.toBe(true)
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
      canReturnLocal: true,
    })
    const page = await browser.newPage({ viewport: { width: 980, height: 680 }, colorScheme: 'dark' })
    await page.setContent(
      renderTrustedFallbackHtml({
        title: '无法连接「远程实例」',
        body: presentation.body,
        actions: presentation.actions,
        platform: 'darwin',
        instance: { displayName: '远程实例', addressLabel: 'secure.example.test', status: presentation.status },
      }),
    )

    await expect(page.getByRole('heading', { name: '无法连接「远程实例」' }).isVisible()).resolves.toBe(true)
    await expect(page.getByText('此客户端的设备会话已经失效，请重新认证。').isVisible()).resolves.toBe(true)
    await expect(page.getByRole('link', { name: '重新认证' }).getAttribute('href')).resolves.toBe(
      'nxt-desktop://reauthenticate',
    )
    await expect(page.getByRole('link', { name: '返回本地实例' }).getAttribute('href')).resolves.toBe(
      'nxt-desktop://local',
    )
    await expect(page.locator('body').textContent()).resolves.not.toContain('nxt:instances:switch')
    await expect(page.locator('body').textContent()).resolves.not.toContain('Error:')
    await page.close()
  })

  it('keeps every production Trusted Fallback state inside minimum and normal Desktop viewports', async () => {
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
    for (const viewport of [
      { width: 980, height: 680 },
      { width: 1360, height: 880 },
    ]) {
      for (const scenario of scenarios) {
        const presentation = trustedFallbackForError(scenario.cause, {
          canReauthenticate: true,
          canReturnLocal: true,
        })
        const page = await browser.newPage({ viewport, colorScheme: 'dark' })
        await page.setContent(
          renderTrustedFallbackHtml({
            title: `无法连接「${scenario.name}」`,
            body: presentation.body,
            actions: presentation.actions,
            platform: 'darwin',
            instance: {
              displayName: scenario.name,
              addressLabel: `${scenario.name}.example.test`,
              status: presentation.status,
            },
          }),
        )
        const geometry = await page.evaluate(() => {
          const workspace = document.querySelector('.workspace')
          const titlebar = document.querySelector('.titlebar')
          const copy = document.querySelector('.reason p:not(.eyebrow)')
          const actions = [...document.querySelectorAll('.actions a')]
          if (
            !(workspace instanceof HTMLElement) ||
            !(titlebar instanceof HTMLElement) ||
            !(copy instanceof HTMLElement) ||
            actions.length === 0
          ) {
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
            workspace: rectangle(workspace),
            titlebar: rectangle(titlebar),
            copy: rectangle(copy),
            actions: actions.map(rectangle),
          }
        })
        const context = `${scenario.name} @ ${viewport.width}x${viewport.height}`
        expect(geometry.scrollWidth, context).toBeLessThanOrEqual(geometry.clientWidth)
        expect(geometry.titlebar.height, context).toBe(48)
        expect(geometry.workspace.left, context).toBeGreaterThanOrEqual(0)
        expect(geometry.workspace.right, context).toBeLessThanOrEqual(geometry.clientWidth)
        expect(geometry.workspace.width, context).toBeGreaterThan(0)
        expect(geometry.copy.width, context).toBeGreaterThan(0)
        expect(geometry.copy.visible, context).toBe(true)
        for (const action of geometry.actions) {
          expect(action.visible, context).toBe(true)
          expect(action.width, context).toBeGreaterThan(0)
          expect(action.height, context).toBeGreaterThan(0)
          expect(action.left, context).toBeGreaterThanOrEqual(geometry.workspace.left)
          expect(action.right, context).toBeLessThanOrEqual(geometry.workspace.right)
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
    expect(source).toContain('<li class="instance-item" data-profile-id=')
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
