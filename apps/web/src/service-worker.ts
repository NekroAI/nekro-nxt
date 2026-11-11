/**
 * The page's one Service Worker: it carries push notifications, caches the hashed files and shows the offline page.
 * Desktop loads the instance inside its own shell and never registers it.
 */
let registration: Promise<ServiceWorkerRegistration | undefined> | undefined

/** Registers the worker once per page; resolves to nothing where it cannot run, e.g. an untrusted certificate. */
export const registerServiceWorker = (): Promise<ServiceWorkerRegistration | undefined> => {
  registration ??=
    window.nekroDesktopShell !== undefined || !window.isSecureContext || !('serviceWorker' in navigator)
      ? Promise.resolve(undefined)
      : navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(
          async () => await navigator.serviceWorker.ready,
          (error: unknown) => {
            console.warn('Service Worker 注册失败：', error)
            return undefined
          },
        )
  return registration
}
