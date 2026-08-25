import { describe, expect, it, vi } from 'vitest'
import {
  assertExactTrustedUrl,
  assertTrustedOverlayIpcEvent,
  installExactTrustedNavigationGuard,
  LatestTrustedLoad,
  OverlayLoadRestoreGate,
  runLatestTrustedLoadAction,
} from '../src/trusted-view-navigation.ts'

describe('Desktop trusted View navigation boundary', () => {
  it('allows only the exact trusted renderer URL and blocks external navigation and redirects', () => {
    const listeners = new Map<string, (event: { preventDefault(): void }, target: string) => void>()
    const expected = 'file:///Applications/NekroNXT/instance-overlay.html'
    const mainFrame = { url: expected }
    installExactTrustedNavigationGuard(
      { mainFrame, getURL: () => expected, on: (event, listener) => listeners.set(event, listener) },
      () => expected,
    )

    const allowed = vi.fn()
    listeners.get('will-navigate')?.({ preventDefault: allowed }, expected)
    expect(allowed).not.toHaveBeenCalled()

    for (const eventName of ['will-navigate', 'will-redirect']) {
      const preventDefault = vi.fn()
      listeners.get(eventName)?.({ preventDefault }, 'https://external.example.test/steal')
      expect(preventDefault, eventName).toHaveBeenCalledOnce()
    }
    expect(() => assertExactTrustedUrl(expected, expected)).not.toThrow()
    expect(() => assertExactTrustedUrl('https://external.example.test/', expected)).toThrow()
  })

  it('converts an exact Fallback action into a callback without allowing it to navigate', () => {
    const listeners = new Map<string, (event: { preventDefault(): void }, target: string) => void>()
    const action = vi.fn()
    const expected = 'data:text/html,trusted'
    const mainFrame = { url: expected }
    installExactTrustedNavigationGuard(
      { mainFrame, getURL: () => expected, on: (event, listener) => listeners.set(event, listener) },
      () => expected,
      () => new Map([['nxt-desktop://reauthenticate', action]]),
    )
    const preventDefault = vi.fn()
    listeners.get('will-navigate')?.({ preventDefault }, 'nxt-desktop://reauthenticate')
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(action).toHaveBeenCalledOnce()

    const redirect = vi.fn()
    listeners.get('will-redirect')?.({ preventDefault: redirect }, 'nxt-desktop://reauthenticate')
    expect(redirect).toHaveBeenCalledOnce()
    expect(action).toHaveBeenCalledOnce()
  })

  it('rejects an action from an old Fallback page and binds the current page action to its own profile', () => {
    const listeners = new Map<string, (event: { preventDefault(): void }, target: string) => void>()
    const expected = 'data:text/html,new-profile'
    let current = 'data:text/html,old-profile'
    const mainFrame = { url: current }
    const oldProfileAction = vi.fn()
    const newProfileAction = vi.fn()
    installExactTrustedNavigationGuard(
      { mainFrame, getURL: () => current, on: (event, listener) => listeners.set(event, listener) },
      () => expected,
      () => new Map([['nxt-desktop://retry', newProfileAction]]),
    )

    const blocked = vi.fn()
    listeners.get('will-navigate')?.({ preventDefault: blocked }, 'nxt-desktop://retry')
    expect(blocked).toHaveBeenCalledOnce()
    expect(oldProfileAction).not.toHaveBeenCalled()
    expect(newProfileAction).not.toHaveBeenCalled()

    current = expected
    mainFrame.url = expected
    const accepted = vi.fn()
    listeners.get('will-navigate')?.({ preventDefault: accepted }, 'nxt-desktop://retry')
    expect(accepted).toHaveBeenCalledOnce()
    expect(newProfileAction).toHaveBeenCalledOnce()
  })

  it('allows a Fallback view to replace its loading document with the current result document', () => {
    const listeners = new Map<string, (event: { preventDefault(): void }, target: string) => void>()
    const loadingUrl = 'data:text/html,loading-profile'
    const resultUrl = 'data:text/html,failed-profile'
    const mainFrame = { url: loadingUrl }
    installExactTrustedNavigationGuard(
      { mainFrame, getURL: () => loadingUrl, on: (event, listener) => listeners.set(event, listener) },
      () => resultUrl,
    )

    const resultNavigation = vi.fn()
    listeners.get('will-navigate')?.({ preventDefault: resultNavigation }, resultUrl)
    expect(resultNavigation).not.toHaveBeenCalled()

    const externalNavigation = vi.fn()
    listeners.get('will-navigate')?.({ preventDefault: externalNavigation }, 'https://external.example.test/')
    expect(externalNavigation).toHaveBeenCalledOnce()
  })

  it('keeps the second Fallback load alive when the first cancelled load rejects late', async () => {
    const loads = new LatestTrustedLoad<{ readonly profileId: string }>()
    let rejectFirst!: (cause: Error) => void
    const firstPromise = new Promise<void>((_resolve, reject) => {
      rejectFirst = reject
    })
    const first = loads.begin({ profileId: 'remote-old' })
    let closed = false
    const handledFirst = firstPromise.catch(() => {
      if (loads.isCurrent(first)) closed = true
    })
    const second = loads.begin({ profileId: 'remote-new' })

    rejectFirst(new Error('ERR_ABORTED'))
    await handledFirst
    expect(loads.isCurrent(first)).toBe(false)
    expect(loads.isCurrent(second)).toBe(true)
    expect(closed).toBe(false)

    const targetedProfiles: string[] = []
    expect(runLatestTrustedLoadAction(loads, first, ({ profileId }) => targetedProfiles.push(profileId))).toBe(false)
    expect(runLatestTrustedLoadAction(loads, second, ({ profileId }) => targetedProfiles.push(profileId))).toBe(true)
    expect(targetedProfiles).toEqual(['remote-new'])
  })

  it('restores Overlay visibility once per trusted document/intent and never for a closed or external load', () => {
    const gate = new OverlayLoadRestoreGate()
    const expectedUrl = 'file:///Applications/NekroNXT/instance-overlay.html'
    gate.updateIntent()
    gate.beginDocument()
    expect(gate.decide({ open: true, actualUrl: expectedUrl, expectedUrl })).toBe('send-open')
    expect(gate.decide({ open: true, actualUrl: expectedUrl, expectedUrl })).toBe('skip')
    gate.beginDocument()
    expect(gate.decide({ open: true, actualUrl: expectedUrl, expectedUrl })).toBe('send-open')
    gate.beginDocument()
    expect(gate.decide({ open: false, actualUrl: expectedUrl, expectedUrl })).toBe('skip')
    expect(gate.decide({ open: true, actualUrl: 'https://external.example.test/', expectedUrl })).toBe('untrusted')
  })

  it('rejects a wrong URL, wrong sender, and child frame before trusted Overlay IPC operations run', () => {
    const expectedUrl = 'file:///Applications/NekroNXT/instance-overlay.html'
    const mainFrame = { url: expectedUrl }
    const valid = {
      sender: { id: 31, mainFrame, getURL: () => expectedUrl },
      senderFrame: mainFrame,
    }
    expect(() => assertTrustedOverlayIpcEvent(valid, 31, expectedUrl)).not.toThrow()
    expect(() =>
      assertTrustedOverlayIpcEvent({ ...valid, senderFrame: { url: expectedUrl } }, 31, expectedUrl),
    ).toThrow()
    expect(() =>
      assertTrustedOverlayIpcEvent(
        { ...valid, sender: { ...valid.sender, getURL: () => 'https://external.example.test/' } },
        31,
        expectedUrl,
      ),
    ).toThrow()
    expect(() => assertTrustedOverlayIpcEvent(valid, 99, expectedUrl)).toThrow()
  })
})
