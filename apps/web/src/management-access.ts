/**
 * Browser access through the Server's management edge: the CSRF token the edge sets for mutations, the sign-in page
 * the edge serves, and whether this page travels unencrypted. Desktop manages its own remote sessions, so none of
 * this redirects inside Desktop; the Android shell renews the session itself.
 */

import { inAndroidShell, postToAndroidShell } from './android-shell.js'

const CSRF_COOKIE = 'nxt_csrf'
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/** The edge's CSRF token; absent on a direct local Host, which needs none. */
export const managementCsrfToken = (): string | undefined => {
  if (typeof document === 'undefined') return undefined
  for (const item of document.cookie.split(';')) {
    const [name, ...value] = item.trim().split('=')
    if (name === CSRF_COOKIE && value.length > 0) return value.join('=')
  }
  return undefined
}

/**
 * Sends a plain browser whose sign-in ended to the edge's sign-in page, returning here afterwards. The Android shell
 * opens a new session from its own device credential instead; Desktop handles it without the page.
 */
export const redirectToSignIn = (): void => {
  if (typeof window === 'undefined' || window.nekroDesktopShell !== undefined) return
  if (inAndroidShell()) {
    postToAndroidShell({ type: 'session-expired' })
    return
  }
  if (window.location.pathname === '/login') return
  window.location.assign(`/login?next=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`)
}

/**
 * Whether this page is still signed in, for transports that cannot see the status of their own failure (event
 * streams). Only pages that signed in through the edge ask (it set the CSRF cookie, or the Android shell opened the
 * session); a direct local Host has no sign-in to lose.
 */
export const checkSignedIn = async (): Promise<void> => {
  if (!inAndroidShell() && managementCsrfToken() === undefined) return
  try {
    const response = await fetch('/api/management/session', { cache: 'no-store', credentials: 'same-origin' })
    if (response.status !== 401) return
    const body: unknown = await response.json().catch(() => undefined)
    const code =
      typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'object' && body.error
        ? (body.error as { readonly code?: unknown }).code
        : undefined
    if (code === 'authentication_required') redirectToSignIn()
  } catch {
    // Offline: the stream's own reconnect and the connection status cover it.
  }
}

const isLoopback = (): boolean => typeof window === 'undefined' || LOOPBACK_HOSTS.has(window.location.hostname)

/** How a plain browser names the Server it shows: 「本机」 on this computer, otherwise the address it was opened at. */
export const browserInstanceName = (): string => (isLoopback() ? '本机' : window.location.host)

/** Plain HTTP to another machine; loopback stays on the same computer and is not flagged. */
export const isUnencryptedRemoteConnection = (): boolean =>
  typeof window !== 'undefined' && window.location.protocol === 'http:' && !LOOPBACK_HOSTS.has(window.location.hostname)
