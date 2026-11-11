import { useSyncExternalStore } from 'react'

/**
 * The Android app (apps/android) shows this web in a system WebView. It injects `nekroAndroidShell` for the
 * instance's own origin only (WebViewCompat.addWebMessageListener), so the page can tell the shell what the native
 * side cannot see for itself. The shell parses them in `WebShellActivity.onPageMessage`; keep both in step. What the
 * shell knows about the phone comes back as `window.nekroAndroidState` and the `nekro-android-state` event.
 */
export type AndroidShellMessage =
  /** Whether an overlay is open, so the system back gesture closes it before it leaves the page. */
  | { readonly type: 'overlay'; readonly open: boolean }
  /** The management session ended; the shell opens a new one from its saved device credential and reloads. */
  | { readonly type: 'session-expired' }
  /** The theme the user chose, for the status bar and navigation bar icons. */
  | { readonly type: 'theme'; readonly theme: 'light' | 'dark' }
  /** A file made in the page (blob), base64 encoded; the shell writes it to Downloads. */
  | { readonly type: 'save-file'; readonly name: string; readonly mime: string; readonly data: string }
  /** Turns the background connection for notifications on or off (asks for the notification permission first). */
  | { readonly type: 'background-notifications'; readonly enabled: boolean }
  /** Opens the system page that exempts the app from battery optimization. */
  | { readonly type: 'battery-settings' }
  /** Opens the shell's own screen for switching or adding instances. */
  | { readonly type: 'switch-instance' }

/** The phone as the shell sees it. */
export interface AndroidShellState {
  /** The background connection that shows notifications while the app is closed. */
  readonly backgroundNotifications: boolean
  /** The system may stop the app in the background while battery optimization applies to it. */
  readonly batteryOptimized: boolean
  /** Whether the system lets the app post notifications at all. */
  readonly notificationsAllowed: boolean
}

const STATE_EVENT = 'nekro-android-state'

interface AndroidShellBridge {
  postMessage(message: string): void
}

declare global {
  interface Window {
    readonly nekroAndroidShell?: AndroidShellBridge
    readonly nekroAndroidState?: AndroidShellState
  }
}

export const inAndroidShell = (): boolean => typeof window !== 'undefined' && window.nekroAndroidShell !== undefined

/** Desktop or Android: an app that signs in by itself and shows its own notifications. */
export const inClientShell = (): boolean =>
  typeof window !== 'undefined' && (window.nekroDesktopShell !== undefined || window.nekroAndroidShell !== undefined)

export const postToAndroidShell = (message: AndroidShellMessage): void => {
  if (typeof window === 'undefined') return
  window.nekroAndroidShell?.postMessage(JSON.stringify(message))
}

const subscribeState = (listener: () => void): (() => void) => {
  window.addEventListener(STATE_EVENT, listener)
  return () => window.removeEventListener(STATE_EVENT, listener)
}

/** The shell's report on this phone; undefined outside the Android app. */
export const useAndroidShellState = (): AndroidShellState | undefined =>
  useSyncExternalStore(
    subscribeState,
    () => (typeof window === 'undefined' ? undefined : window.nekroAndroidState),
    () => undefined,
  )
