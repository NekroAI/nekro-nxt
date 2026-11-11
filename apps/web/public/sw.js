// NekroNXT worker: shows pushed notifications and opens their page. Beyond that it only caches the hashed files under
// /assets/ (their content never changes) and answers a page load with /offline.html when the instance cannot be
// reached. Pages and API calls always go to the network.

const SHELL_CACHE = 'nxt-shell-v1'
const ASSET_CACHE = 'nxt-assets-v1'
const OFFLINE_URL = '/offline.html'
const ASSET_LIMIT = 300
const ASSET_KEEP = 240

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const cache = await self.caches.open(SHELL_CACHE)
        await cache.add(OFFLINE_URL)
      } catch {
        // A failed precache only means no offline page; the worker still installs.
      }
    })(),
  )
  void self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const current = [SHELL_CACHE, ASSET_CACHE]
      const names = await self.caches.keys()
      await Promise.all(
        names
          .filter((name) => name.startsWith('nxt-') && !current.includes(name))
          .map((name) => self.caches.delete(name)),
      )
      await self.clients.claim()
    })(),
  )
})

const trimAssets = async (cache) => {
  const keys = await cache.keys()
  if (keys.length <= ASSET_LIMIT) return
  // Keys come back in the order they were written, so the oldest go first.
  await Promise.all(keys.slice(0, keys.length - ASSET_KEEP).map((key) => cache.delete(key)))
}

const cachedAsset = async (event) => {
  const cache = await self.caches.open(ASSET_CACHE)
  const hit = await cache.match(event.request)
  if (hit !== undefined) return hit
  const response = await self.fetch(event.request)
  if (response.status === 200 && response.type === 'basic') {
    event.waitUntil(
      cache
        .put(event.request, response.clone())
        .then(() => trimAssets(cache))
        .catch(() => undefined),
    )
  }
  return response
}

const pageOrOffline = async (request) => {
  try {
    return await self.fetch(request)
  } catch (error) {
    const cache = await self.caches.open(SHELL_CACHE)
    const offline = await cache.match(OFFLINE_URL)
    if (offline !== undefined) return offline
    throw error
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cachedAsset(event))
  } else if (request.mode === 'navigate') {
    event.respondWith(pageOrOffline(request))
  }
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
