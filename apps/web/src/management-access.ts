/**
 * Browser access through the Server's management edge: the CSRF token the edge sets for mutations, the sign-in page
 * the edge serves, and whether this page travels unencrypted. Desktop manages its own remote sessions, so none of
 * this redirects inside Desktop.
 */

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

/** Sends a plain browser whose sign-in ended to the edge's sign-in page, returning here afterwards. */
export const redirectToSignIn = (): void => {
  if (typeof window === 'undefined' || window.nekroDesktopShell !== undefined) return
  if (window.location.pathname === '/login') return
  window.location.assign(`/login?next=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`)
}

const isLoopback = (): boolean => typeof window === 'undefined' || LOOPBACK_HOSTS.has(window.location.hostname)

/** How a plain browser names the Server it shows: 「本机」 on this computer, otherwise the address it was opened at. */
export const browserInstanceName = (): string => (isLoopback() ? '本机' : window.location.host)

/** Plain HTTP to another machine; loopback stays on the same computer and is not flagged. */
export const isUnencryptedRemoteConnection = (): boolean =>
  typeof window !== 'undefined' && window.location.protocol === 'http:' && !LOOPBACK_HOSTS.has(window.location.hostname)
