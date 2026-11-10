// NekroNXT push worker: it only shows pushed notifications and opens their page. It does not intercept requests or
// keep anything offline.

self.addEventListener('install', () => {
  void self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = {}
  }
  const title = typeof data.title === 'string' && data.title ? data.title : 'NekroNXT'
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof data.body === 'string' ? data.body : '',
      // The same source replaces its earlier notification instead of stacking.
      ...(typeof data.tag === 'string' ? { tag: data.tag, renotify: true } : {}),
      icon: '/pwa-192.png',
      data: { route: typeof data.route === 'string' ? data.route : '/' },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const requested = new URL(event.notification.data?.route ?? '/', self.location.origin)
  const target = requested.origin === self.location.origin ? requested : new URL('/', self.location.origin)
  const route = `${target.pathname}${target.search}${target.hash}`
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const open = windows.find((client) => new URL(client.url).origin === self.location.origin)
      if (open !== undefined) {
        await open.focus()
        // The page moves within the app; a full reload would drop what it was showing.
        open.postMessage({ type: 'nekro-nxt:open-route', route })
        return
      }
      await self.clients.openWindow(target.href)
    })(),
  )
})
