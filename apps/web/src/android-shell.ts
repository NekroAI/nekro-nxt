/**
 * The Android app (apps/android) shows this web in a system WebView. It injects `nekroAndroidShell` for the
 * instance's own origin only (WebViewCompat.addWebMessageListener), so the page can tell the shell what the native
 * side cannot see for itself. Both sides parse these messages; keep them in step with `ShellMessages.kt`.
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

interface AndroidShellBridge {
  postMessage(message: string): void
}

declare global {
  interface Window {
    readonly nekroAndroidShell?: AndroidShellBridge
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
