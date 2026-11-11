import { useEffect, useState, useSyncExternalStore } from 'react'
import { inClientShell } from './android-shell.js'
import { registerServiceWorker } from './service-worker.js'

/**
 * Adding the instance to the home screen as an app (PWA). Chrome offers its own install dialog through
 * `beforeinstallprompt`; iPhone and iPad add apps only from the share menu, so there the page shows the steps.
 */
export type HomeScreenState =
  /** Opened from the home screen, or inside the desktop or Android app. */
  | 'installed'
  /** Browsers install only an app whose Service Worker runs: a trusted HTTPS address. */
  | 'insecure'
  /** The browser holds an install dialog the page can open. */
  | 'prompt'
  /** iPhone and iPad: share menu → 添加到主屏幕. */
  | 'apple'
  /** Other browsers: their own menu has 安装应用 or 添加到主屏幕. */
  | 'menu'

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>
  readonly userChoice: Promise<{ readonly outcome: 'accepted' | 'dismissed' }>
}

const isInstallPrompt = (event: Event): event is InstallPromptEvent =>
  'prompt' in event && typeof event.prompt === 'function'

export const standalone = (): boolean =>
  window.matchMedia('(display-mode: standalone)').matches ||
  (navigator as Navigator & { readonly standalone?: boolean }).standalone === true

export const appleTouchDevice = (): boolean =>
  /iPad|iPhone|iPod/u.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

let deferred: InstallPromptEvent | undefined
let installed = false
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((listener) => listener())
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Installed at startup: Chrome fires the event once, before any page asks for it. */
export const captureInstallPrompt = (): void => {
  window.addEventListener('beforeinstallprompt', (event) => {
    // The page offers it itself, from the hint or the side menu, instead of Chrome's own bar.
    event.preventDefault()
    if (isInstallPrompt(event)) deferred = event
    emit()
  })
  window.addEventListener('appinstalled', () => {
    installed = true
    deferred = undefined
    emit()
  })
}

const browserState = (): Exclude<HomeScreenState, 'insecure'> => {
  if (installed || inClientShell() || standalone()) return 'installed'
  if (deferred !== undefined) return 'prompt'
  return appleTouchDevice() ? 'apple' : 'menu'
}

/** Nothing until the Service Worker has answered whether this address can be installed. */
export const useHomeScreen = (): HomeScreenState | undefined => {
  const state = useSyncExternalStore(subscribe, browserState, () => 'installed' as const)
  const [secure, setSecure] = useState<boolean>()
  useEffect(() => {
    let live = true
    void registerServiceWorker().then((worker) => {
      if (live) setSecure(worker !== undefined)
    })
    return () => {
      live = false
    }
  }, [])
  if (state === 'installed') return state
  if (secure === undefined) return undefined
  return secure ? state : 'insecure'
}

/** Opens the browser's install dialog; false when it has none to offer any more. */
export const openInstallPrompt = async (): Promise<boolean> => {
  const event = deferred
  if (event === undefined) return false
  // Chrome lets the page use each event once.
  deferred = undefined
  emit()
  await event.prompt()
  await event.userChoice
  return true
}
