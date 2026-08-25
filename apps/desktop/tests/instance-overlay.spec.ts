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
  editConnectionCalls: number
  reauthenticateCalls: number
  closeCalls: number
  closePayload?: unknown
  snapshot: { revision: number; currentProfileId: string; profiles: readonly OverlayProfile[] }
  snapshotListener?: (snapshot: OverlayControl['snapshot']) => void
  visibilityListener?: (visibility: unknown) => void
  payload?: Record<string, unknown>
  resolve?: (value?: unknown) => void
  reject?: (error: Error) => void
}

declare global {
  interface Window {
    __overlayControl: OverlayControl
    __focusedOverlayNode?: Element
    __compositionEndCount?: number
    __overlayAnimationFrames?: FrameRequestCallback[]
    __flushOverlayAnimationFrames?: () => void
    __overlayNodes?: Record<string, HTMLInputElement>
    __selectionBefore?: Record<string, { value: string; selectionStart: number | null; selectionEnd: number | null }>
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

const httpRemoteProfile: OverlayProfile = {
  id: 'remote-http',
  kind: 'remote',
  displayName: 'HTTP 实例',
  origin: 'http://nxt.example.test:8080',
  addressLabel: 'http://nxt.example.test:8080',
  status: 'ready',
  notificationsEnabled: true,
  requiresAuthentication: true,
  insecureHttp: true,
}

const openOverlayPage = async (profiles: readonly OverlayProfile[] = [localProfile]): Promise<Page> => {
  const page = await browser.newPage({ viewport: { width: 980, height: 632 }, colorScheme: 'dark' })
  await page.setContent('<!doctype html><html lang="zh-CN"><body><main id="app"></main></body></html>')
  await page.addStyleTag({ path: path.join(desktopRoot, 'src/instance-overlay.css') })
  await page.evaluate((providedProfiles) => {
    const control: OverlayControl = {
      addCalls: 0,
      editConnectionCalls: 0,
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
        return new Promise<unknown>((resolve, reject) => {
          control.resolve = resolve
          control.reject = reject
        })
      },
      editConnection: (payload: Record<string, unknown>) => {
        control.editConnectionCalls += 1
        control.payload = payload
        return new Promise<unknown>((resolve, reject) => {
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
      close: (input: unknown) => {
        control.closeCalls += 1
        control.closePayload = input
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

const openEditForm = async (page: Page, profileId = remoteProfile.id): Promise<void> => {
  await page.getByRole('button', { name: /的更多操作/u }).click()
  await page.getByRole('menuitem', { name: '编辑连接' }).click()
  await page.getByRole('heading', { name: '编辑连接' }).waitFor()
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

  it('reconfirms explicit HTTP before reauthenticating via the Fallback intent', async () => {
    const page = await openOverlayPage([localProfile, httpRemoteProfile])
    await page.evaluate(() => {
      window.__overlayControl.visibilityListener?.({
        state: 'open',
        intent: { kind: 'reauthenticate', profileId: 'remote-http' },
      })
    })
    await waitForOverlayAnimationFrame(page)
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
    const payload = await page.evaluate(() => {
      return window.__overlayControl.payload
    })
    expect(payload).toMatchObject({
      profileId: 'remote-http',
      managementKey: 'm'.repeat(32),
      confirmedInsecureHttpOrigin: 'http://nxt.example.test:8080',
    })
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
    await openEditForm(page)
    await expect(page.locator('#address').inputValue()).resolves.toBe('https://remote.example.test:7443')

    await page.locator('#name').fill('北辰工作区')
    await expectFocusedFieldStableThroughSnapshots(page, '#name', [localProfile, remoteProfile])
    await expectFocusedFieldStableThroughSnapshots(page, '#address', [localProfile, remoteProfile])
    await page.locator('#key').fill('synthetic-management-key')
    await expectFocusedFieldStableThroughSnapshots(page, '#key', [localProfile, remoteProfile])

    await page.getByRole('button', { name: '取消' }).click()
    await page.evaluate(() => {
      window.__overlayControl.visibilityListener?.({
        state: 'open',
        intent: { kind: 'reauthenticate', profileId: 'remote-1' },
      })
    })
    await waitForOverlayAnimationFrame(page)
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

  it('uses backdrop and Escape as one Sheet hierarchy with restoreControl hints and traps Tab', async () => {
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

    await page.keyboard.press('Escape')
    await expect.poll(() => page.evaluate(() => window.__overlayControl.closeCalls)).toBe(1)
    await expect(page.evaluate(() => window.__overlayControl.closePayload)).resolves.toEqual({ restoreControl: true })

    await page.getByRole('button', { name: /添加远程实例/u }).click()
    await page.keyboard.press('Escape')
    await page.locator('.sheet-backdrop').click({ position: { x: 900, y: 60 } })
    await expect.poll(() => page.evaluate(() => window.__overlayControl.closeCalls)).toBe(2)
    await expect(page.evaluate(() => window.__overlayControl.closePayload)).resolves.toEqual({ restoreControl: false })
    await page.close()
  })

  it('cancels stale focus callbacks across consecutive mode changes', async () => {
    const page = await openOverlayPage([localProfile, remoteProfile])
    await deferOverlayAnimationFrames(page)
    await page.getByRole('button', { name: /添加远程实例/u }).click()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: '北辰实例的更多操作' }).click()
    await page.getByRole('menuitem', { name: '编辑连接' }).click()

    await expect(page.evaluate(() => document.activeElement === document.body)).resolves.toBe(true)
    await flushOverlayAnimationFrames(page)
    await expect(page.getByRole('heading', { name: '编辑连接' }).isVisible()).resolves.toBe(true)
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
    expect(source).toContain('class="menu"')
    expect(source).toContain('role="menu"')
    expect(source).toContain('role="menuitem"')
    expect(source).toContain('data-action="retry"')
    expect(source).toContain('data-action="edit"')
    expect(source).toContain('data-action="notifications"')
    expect(source).toContain('data-action="confirm-remove"')
    expect(source).not.toContain('role="button"')
    expect(source).not.toContain('tabindex="0"')

    const instanceButton = source.match(/<button class="instance[\s\S]*?<\/button>/u)?.[0] ?? ''
    expect(instanceButton).not.toContain('class="more"')
    expect(instanceButton.match(/<button/gu)).toHaveLength(1)
  })

  it('uses a bidirectional trigger-aligned transition, ui-kit tokens, and reduced-motion fallback', async () => {
    const [script, stylesheet, markup] = await Promise.all([
      readFile(path.join(desktopRoot, 'src/instance-overlay.js'), 'utf8'),
      readFile(path.join(desktopRoot, 'src/instance-overlay.css'), 'utf8'),
      readFile(path.join(desktopRoot, 'src/instance-overlay.html'), 'utf8'),
    ])
    expect(markup).toContain('data-visibility="closed"')
    expect(script).toContain('bridge.subscribeVisibility')
    expect(script).toContain("dataset.visibility = 'closing'")
    expect(stylesheet).toContain('transform-origin: left bottom')
    expect(stylesheet).toContain('transform-origin: top right')
    expect(stylesheet).toContain('--motion-enter: 160ms')
    expect(stylesheet).toContain('--motion-exit: 100ms')
    expect(stylesheet).toContain('@media (prefers-reduced-motion: reduce)')
    expect(stylesheet).not.toContain('linear-gradient')
    expect(stylesheet).not.toContain('.panel::before')
    expect(stylesheet).toContain('--nxt-bg-surface: #fffdf9')
    expect(stylesheet).toContain('--nxt-bg-elevated: #29425f')
  })

  it('keeps native Enter/Space activation and implements popup arrow/Escape focus restoration', async () => {
    const source = await readFile(path.join(desktopRoot, 'src/instance-overlay.js'), 'utf8')

    expect(source).toContain("event.key === 'ArrowDown' || event.key === 'ArrowUp'")
    expect(source).toContain('menu.querySelectorAll(\'[role="menuitem"]\')')
    expect(source).toContain("if (event.key === 'Escape')")
    expect(source).toContain("focusControl(profileId ? 'more' : 'add', profileId)")
    expect(source).not.toMatch(/event\.key === ['"](?:Enter| )['"]/u)
  })

  it('routes address and optional key through editConnection and keeps reauthentication address-free', async () => {
    const overlay = await readFile(path.join(desktopRoot, 'src/instance-overlay.js'), 'utf8')
    const preload = await readFile(path.join(desktopRoot, 'src/overlay-preload.ts'), 'utf8')

    expect(preload).toContain("editConnection: (input: unknown) => invoke('editConnection', input)")
    expect(preload).toContain("close: (input?: unknown) => invoke('close', input)")
    expect(overlay).toContain("if (mode.kind === 'edit') result = await bridge.editConnection(operationPayload)")
    expect(overlay).toContain('bridge.update({ profileId: id, notificationsEnabled: !profile.notificationsEnabled })')

    for (const fragment of [
      'profileId: mode.profileId,',
      'displayName: mode.draft.displayName,',
      'address: normalized.origin,',
      "mode.draft.managementKey.trim() === '' ? {} : { managementKey: mode.draft.managementKey }",
      '...(normalized.insecureRemoteHttp ? { confirmedInsecureHttpOrigin: normalized.origin } : {}),',
    ]) {
      expect(overlay, 'edit payload 应包含 ' + fragment).toContain(fragment)
    }

    const reauthPayload =
      overlay.match(/profileId: mode\.profileId,\n\s+managementKey: mode\.draft\.managementKey[\s\S]{0,120}/u)?.[0] ??
      ''
    expect(reauthPayload).not.toContain('address')
    expect(reauthPayload).not.toContain('displayName')
    expect(overlay).toContain('result.saved === false')
    expect(overlay).toContain('bridge.close({ restoreControl: true })')
    expect(overlay).toContain('bridge.close({ restoreControl: false })')
  })

  it('prefills the edit connection form and submits profileId, name, address, and optional key through editConnection', async () => {
    const page = await openOverlayPage([localProfile, remoteProfile])
    await openEditForm(page)
    await expect(page.locator('#name').inputValue()).resolves.toBe('北辰实例')
    await expect(page.locator('#address').inputValue()).resolves.toBe('https://remote.example.test:7443')
    await expect(page.locator('#key').inputValue()).resolves.toBe('')

    await page.locator('#name').fill('北辰工作区')
    await page.locator('#key').fill('rotated-management-key')
    await page.getByRole('button', { name: '保存更改' }).click()
    await expect.poll(() => page.evaluate(() => window.__overlayControl.editConnectionCalls)).toBe(1)
    const payload = await page.evaluate(() => window.__overlayControl.payload)
    expect(payload).toEqual({
      profileId: 'remote-1',
      displayName: '北辰工作区',
      address: 'https://remote.example.test:7443',
      managementKey: 'rotated-management-key',
    })

    await page.evaluate(() => window.__overlayControl.resolve?.({ saved: true }))
    await publishSnapshot(page, [localProfile, remoteProfile])
    await expect(page.getByRole('button', { name: /添加远程实例/u }).isVisible()).resolves.toBe(true)

    await openEditForm(page)
    await page.getByRole('button', { name: '保存更改' }).click()
    await expect.poll(() => page.evaluate(() => window.__overlayControl.editConnectionCalls)).toBe(2)
    const secondPayload = await page.evaluate(() => window.__overlayControl.payload)
    expect(secondPayload).toEqual({
      profileId: 'remote-1',
      displayName: '北辰实例',
      address: 'https://remote.example.test:7443',
    })
    await page.close()
  })

  it('keeps the edit form when the manager reports saved:false and continues on the next submit', async () => {
    const page = await openOverlayPage([localProfile, remoteProfile])
    await openEditForm(page)
    await page.locator('#name').fill('北辰工作区')
    await page.locator('#address').fill('https://moved.example.test:8443')
    await page.getByRole('button', { name: '保存更改' }).click()
    await expect.poll(() => page.evaluate(() => window.__overlayControl.editConnectionCalls)).toBe(1)

    await page.evaluate(() => window.__overlayControl.resolve?.({ saved: false }))
    await expect(page.getByRole('heading', { name: '编辑连接' }).isVisible()).resolves.toBe(true)
    await expect(page.locator('#name').inputValue()).resolves.toBe('北辰工作区')
    await expect(page.locator('#address').inputValue()).resolves.toBe('https://moved.example.test:8443')
    await expect(page.getByRole('button', { name: '保存更改' }).isEnabled()).resolves.toBe(true)

    await page.getByRole('button', { name: '保存更改' }).click()
    await expect.poll(() => page.evaluate(() => window.__overlayControl.editConnectionCalls)).toBe(2)
    await page.evaluate(() => window.__overlayControl.resolve?.({ saved: true }))
    await publishSnapshot(page, [localProfile, remoteProfile])
    await expect(page.getByRole('button', { name: /添加远程实例/u }).isVisible()).resolves.toBe(true)
    await page.close()
  })

  it('invalidates an HTTP risk confirmation when the edit address changes', async () => {
    const page = await openOverlayPage([localProfile, httpRemoteProfile])
    await openEditForm(page, httpRemoteProfile.id)
    await expect(page.locator('#address').inputValue()).resolves.toBe('http://nxt.example.test:8080')

    await page.getByRole('button', { name: '保存更改' }).click()
    await expect.poll(() => page.evaluate(() => window.__overlayControl.editConnectionCalls)).toBe(1)
    const kept = await page.evaluate(() => window.__overlayControl.payload)
    expect(kept).toEqual({
      profileId: 'remote-http',
      displayName: 'HTTP 实例',
      address: 'http://nxt.example.test:8080',
      confirmedInsecureHttpOrigin: 'http://nxt.example.test:8080',
    })
    await page.evaluate(() => window.__overlayControl.resolve?.({ saved: true }))
    await publishSnapshot(page, [localProfile, httpRemoteProfile])

    await openEditForm(page, httpRemoteProfile.id)
    await page.locator('#address').fill('http://other.example.test:9090')
    await page.getByRole('button', { name: '保存更改' }).click()
    await expect(page.getByRole('button', { name: '仍要继续' }).isVisible()).resolves.toBe(true)
    await expect(page.evaluate(() => window.__overlayControl.editConnectionCalls)).resolves.toBe(1)
    await page.getByRole('button', { name: '仍要继续' }).click()
    await expect.poll(() => page.evaluate(() => window.__overlayControl.editConnectionCalls)).toBe(2)
    const changed = await page.evaluate(() => window.__overlayControl.payload)
    expect(changed).toMatchObject({
      profileId: 'remote-http',
      address: 'http://other.example.test:9090',
      confirmedInsecureHttpOrigin: 'http://other.example.test:9090',
    })
    await page.close()
  })

  it('keeps edit inputs, focus, and selection through pending and rejected submission without rebuilding the form', async () => {
    const page = await openOverlayPage([localProfile, remoteProfile])
    await openEditForm(page)
    await page.locator('#name').fill('北辰工作区')
    await page.locator('#key').fill('rotated-management-key')
    await page.locator('#key').click()
    await page.locator('#key').evaluate((element) => {
      if (!(element instanceof HTMLInputElement)) throw new Error('目标字段不是输入框。')
      element.setSelectionRange(2, 8, 'backward')
    })
    await page.evaluate(() => {
      const inputs = [...document.querySelectorAll('form[data-form="current"] input')]
      window.__overlayNodes = Object.fromEntries(inputs.map((input) => [input.getAttribute('name'), input]))
      window.__selectionBefore = Object.fromEntries(
        inputs.map((input) => {
          const element = input as HTMLInputElement
          return [
            input.getAttribute('name'),
            { value: element.value, selectionStart: element.selectionStart, selectionEnd: element.selectionEnd },
          ]
        }),
      )
    })

    await page.getByRole('button', { name: '保存更改' }).click()
    await expect(page.getByRole('button', { name: '正在保存…' }).isDisabled()).resolves.toBe(true)
    await page.evaluate(() => {
      window.__overlayControl.reject?.(new Error('无法连接服务器，请检查地址、端口和网络状态。'))
    })
    await page.getByRole('alert').waitFor()

    const state = await page.evaluate(() => {
      const inputs = [...document.querySelectorAll('form[data-form="current"] input[name]')]
      const map: Record<
        string,
        { sameNode: boolean; value: string; selectionStart: number | null; selectionEnd: number | null }
      > = {}
      for (const input of inputs) {
        map[input.name] = {
          sameNode: input === window.__overlayNodes?.[input.name],
          value: input.value,
          selectionStart: input.selectionStart,
          selectionEnd: input.selectionEnd,
        }
      }
      return {
        map,
        error: document.querySelector('[data-error]')?.textContent,
        alertVisible: Boolean(
          document.querySelector('[data-error]') && !document.querySelector('[data-error]')?.hasAttribute('hidden'),
        ),
      }
    })
    const selectionBefore = await page.evaluate(() => window.__selectionBefore)
    for (const name of ['displayName', 'address', 'managementKey']) {
      expect(state.map[name]?.sameNode, name + ' 不应被重建').toBe(true)
      expect(state.map[name]?.value, name + ' 值').toBe(selectionBefore[name].value)
      expect(state.map[name]?.selectionStart, name + ' 选区起点').toBe(selectionBefore[name].selectionStart)
      expect(state.map[name]?.selectionEnd, name + ' 选区终点').toBe(selectionBefore[name].selectionEnd)
    }
    // 重点：提交期间设置的关键字段选区在失败后仍在原文位置
    expect(state.map.managementKey?.selectionStart).toBe(2)
    expect(state.map.managementKey?.selectionEnd).toBe(8)
    expect(state.error).toBe('无法连接服务器，请检查地址、端口和网络状态。')
    expect(state.alertVisible).toBe(true)
    await page.close()
  })

  it('shows address errors in place without rebuilding edit inputs or losing the caret', async () => {
    const page = await openOverlayPage([localProfile, remoteProfile])
    await openEditForm(page)
    await page.locator('#address').fill('ftp://nxt.example.test')
    await page.locator('#address').evaluate((element) => {
      if (!(element instanceof HTMLInputElement)) throw new Error('目标字段不是输入框。')
      element.setSelectionRange(4, 12, 'forward')
    })
    await page.getByRole('button', { name: '保存更改' }).click()
    await expect(page.getByRole('alert').textContent()).resolves.toBe('服务器地址只支持 HTTPS 或 HTTP。')
    await expect(page.evaluate(() => window.__overlayControl.editConnectionCalls)).resolves.toBe(0)
    const stable = await page.locator('#address').evaluate((element) => {
      if (!(element instanceof HTMLInputElement)) throw new Error('目标字段不是输入框。')
      return {
        inputKeepsSelection:
          element.selectionStart === 4 && element.selectionEnd === 12 && element.value === 'ftp://nxt.example.test',
        submitFocused: document.activeElement?.getAttribute('data-submit') === '' && document.activeElement !== element,
      }
    })
    expect(stable).toEqual({ inputKeepsSelection: true, submitFocused: true })
    await page.close()
  })

  it('opens the row menu as an absolute floating layer that does not squeeze the list and closes on outside clicks', async () => {
    const page = await openOverlayPage([localProfile, remoteProfile])
    const panel = page.locator('.panel')
    const firstRow = page.locator('.instance-row').first()
    const secondRow = page.locator('.instance-row').nth(1)
    const rectsBefore = await page.evaluate(() => {
      const panel = document.querySelector('.panel')
      const rows = [...document.querySelectorAll('.instance-row')]
      const offset = (element: Element) => {
        const next = element as HTMLElement
        return { left: next.offsetLeft, top: next.offsetTop, width: next.offsetWidth, height: next.offsetHeight }
      }
      return { panel: panel instanceof HTMLElement ? offset(panel) : null, rows: rows.map(offset) }
    })

    await page.getByRole('button', { name: '北辰实例的更多操作' }).click()
    const menu = page.getByRole('menu')
    await expect(menu.isVisible()).resolves.toBe(true)
    await page.waitForTimeout(180)
    const menuInfo = await page.evaluate(() => {
      const menuElement = document.querySelector('.menu')
      const more = document.querySelector('[data-action="more"]')
      if (!(menuElement instanceof HTMLElement) || !(more instanceof HTMLElement)) throw new Error('浮层菜单不完整。')
      const m = menuElement.getBoundingClientRect()
      const b = more.getBoundingClientRect()
      return {
        position: getComputedStyle(menuElement).position,
        left: m.left,
        top: m.top,
        right: m.right,
        bottom: m.bottom,
        width: m.width,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        triggerLeft: b.left,
        triggerTop: b.top,
        triggerBottom: b.bottom,
        triggerRight: b.right,
      }
    })
    expect(menuInfo.position).toBe('absolute')
    expect(menuInfo.width).toBeGreaterThan(0)
    expect(menuInfo.left).toBeGreaterThanOrEqual(0)
    expect(menuInfo.right).toBeLessThanOrEqual(menuInfo.innerWidth)
    expect(menuInfo.top).toBeGreaterThanOrEqual(0)
    expect(menuInfo.bottom).toBeLessThanOrEqual(menuInfo.innerHeight)
    const onRight = menuInfo.left >= menuInfo.triggerRight + 2
    const onLeft = menuInfo.right <= menuInfo.triggerLeft - 2
    expect(onRight || onLeft, '菜单应贴在触发按钮侧面，避免遮挡实例列表').toBe(true)

    const rectsAfter = await page.evaluate(() => {
      const panel = document.querySelector('.panel')
      const rows = [...document.querySelectorAll('.instance-row')]
      const offset = (element: Element) => {
        const next = element as HTMLElement
        return { left: next.offsetLeft, top: next.offsetTop, width: next.offsetWidth, height: next.offsetHeight }
      }
      return { panel: panel instanceof HTMLElement ? offset(panel) : null, rows: rows.map(offset) }
    })
    expect(rectsAfter).toEqual(rectsBefore)

    await firstRow.click({ position: { x: 40, y: 20 } })
    await expect(menu.count()).resolves.toBe(0)
    await expect(page.evaluate(() => window.__overlayControl.closeCalls)).resolves.toBe(0)
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-action'))).toBe('more')

    await page.locator('.sheet-backdrop').click({ position: { x: 900, y: 60 } })
    await expect.poll(() => page.evaluate(() => window.__overlayControl.closeCalls)).toBe(1)
    await expect(page.evaluate(() => window.__overlayControl.closePayload)).resolves.toEqual({ restoreControl: false })
    await page.close()
  })

  it('flips the floating menu upward when the trigger sits near the window bottom', async () => {
    const page = await openOverlayPage([localProfile, remoteProfile])
    await page.setViewportSize({ width: 980, height: 320 })
    await page.getByRole('button', { name: '北辰实例的更多操作' }).click()
    const menu = page.getByRole('menu')
    await expect(menu.isVisible()).resolves.toBe(true)
    await page.waitForTimeout(180)
    const geometry = await page.evaluate(() => {
      const menuElement = document.querySelector('.menu')
      const more = document.querySelector('[data-action="more"]')
      if (!(menuElement instanceof HTMLElement) || !(more instanceof HTMLElement)) throw new Error('浮层菜单不完整。')
      const m = menuElement.getBoundingClientRect()
      const b = more.getBoundingClientRect()
      return {
        menuTop: m.top,
        menuBottom: m.bottom,
        triggerTop: b.top,
        triggerBottom: b.bottom,
        innerHeight: window.innerHeight,
      }
    })
    expect(geometry.menuBottom).toBeLessThanOrEqual(geometry.innerHeight)
    expect(geometry.menuTop).toBeGreaterThanOrEqual(0)
    // 下方空间不足时向上生长，底边不超过触发器底边。
    expect(geometry.menuTop).toBeLessThan(geometry.triggerTop)
    expect(geometry.menuBottom).toBeLessThanOrEqual(geometry.triggerBottom + 2)
    await page.close()
  })

  it('sizes the panel to content with a max height and scrolls the instance list independently', async () => {
    const manyProfiles: readonly OverlayProfile[] = [
      localProfile,
      ...Array.from({ length: 11 }, (_, index) => ({
        id: `remote-${index + 1}`,
        kind: 'remote' as const,
        displayName: `实例 ${index + 1}`,
        origin: `https://r${index + 1}.example.test`,
        addressLabel: `r${index + 1}.example.test`,
        status: 'ready',
        notificationsEnabled: true,
        requiresAuthentication: false,
        insecureHttp: false,
      })),
    ]
    const page = await openOverlayPage([localProfile])
    const panelRect = () =>
      page.locator('.panel').evaluate((element) => {
        const r = element.getBoundingClientRect()
        return { width: r.width, height: r.height }
      })

    await expect.poll(async () => (await panelRect()).width).toBe(344)
    const compact = await panelRect()
    expect(compact.width).toBe(344)
    expect(compact.height).toBeLessThan(480)

    await publishSnapshot(page, manyProfiles)
    await expect.poll(async () => (await panelRect()).height).toBe(480)
    const list = await page.evaluate(() => {
      const element = document.querySelector('.list')
      if (!(element instanceof HTMLElement)) throw new Error('列表缺失。')
      return {
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        overflowY: getComputedStyle(element).overflowY,
        insidePanel:
          element.getBoundingClientRect().bottom <= document.querySelector('.panel')!.getBoundingClientRect().bottom,
      }
    })
    expect(list.overflowY).toBe('auto')
    expect(list.scrollHeight).toBeGreaterThan(list.clientHeight)
    expect(list.insidePanel).toBe(true)
    await page.close()
  })

  it('keeps every row pixel on a pointer cursor without dead zones beside the more button', async () => {
    const page = await openOverlayPage([localProfile, remoteProfile])
    const samples = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.instance-row')]
      const results: { row: number; x: number; cursor: string; tag: string }[] = []
      rows.forEach((row, index) => {
        const rect = row.getBoundingClientRect()
        const y = rect.top + rect.height / 2
        for (let x = rect.left + 2; x <= rect.right - 2; x += 4) {
          const element = document.elementFromPoint(x, y)
          if (element === null) continue
          results.push({ row: index, x: Math.round(x), cursor: getComputedStyle(element).cursor, tag: element.tagName })
        }
      })
      return results
    })
    expect(samples.length).toBeGreaterThan(0)
    for (const sample of samples) {
      expect(sample.cursor, `row ${sample.row} x=${sample.x} 命中 ${sample.tag}`).toBe('pointer')
    }
    await page.close()
  })
})
