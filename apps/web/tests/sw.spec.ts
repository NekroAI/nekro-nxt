import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'

const ORIGIN = 'https://nxt.example.test'

interface FakeResponse {
  readonly status: number
  readonly type: string
  readonly label: string
  clone(): FakeResponse
}
interface FakeRequest {
  readonly url: string
  readonly method: string
  readonly mode: string
}
type Listener = (event: Record<string, unknown>) => void

const response = (label: string, status = 200, type = 'basic'): FakeResponse => ({
  status,
  type,
  label,
  clone: () => response(label, status, type),
})
const request = (path: string, init: { method?: string; mode?: string; origin?: string } = {}): FakeRequest => ({
  url: `${init.origin ?? ORIGIN}${path}`,
  method: init.method ?? 'GET',
  mode: init.mode ?? 'no-cors',
})

/** A cache that lists its entries in the order they were written, like the real one. */
class FakeCache {
  readonly entries = new Map<string, FakeResponse>()
  readonly keyOf = (input: FakeRequest | string): string =>
    typeof input === 'string' ? `${ORIGIN}${input}` : input.url
  add(input: string): Promise<void> {
    this.entries.set(this.keyOf(input), response(`precached ${input}`))
    return Promise.resolve()
  }
  put(input: FakeRequest, value: FakeResponse): Promise<void> {
    this.entries.set(this.keyOf(input), value)
    return Promise.resolve()
  }
  match(input: FakeRequest | string): Promise<FakeResponse | undefined> {
    return Promise.resolve(this.entries.get(this.keyOf(input)))
  }
  keys(): Promise<{ url: string }[]> {
    return Promise.resolve([...this.entries.keys()].map((url) => ({ url })))
  }
  delete(input: { url: string }): Promise<boolean> {
    return Promise.resolve(this.entries.delete(input.url))
  }
}

interface Harness {
  readonly stores: Map<string, FakeCache>
  readonly fetch: ReturnType<typeof vi.fn<(input: FakeRequest) => Promise<FakeResponse>>>
  readonly showNotification: ReturnType<typeof vi.fn>
  readonly clients: {
    claim: ReturnType<typeof vi.fn>
    matchAll: ReturnType<typeof vi.fn>
    openWindow: ReturnType<typeof vi.fn>
  }
  readonly skipWaiting: ReturnType<typeof vi.fn>
  dispatch(type: string, event: Record<string, unknown>): void
}

const source = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8')

const load = (options: { failOpen?: (name: string) => boolean } = {}): Harness => {
  const listeners = new Map<string, Listener>()
  const stores = new Map<string, FakeCache>()
  const fetchMock = vi.fn<(input: FakeRequest) => Promise<FakeResponse>>()
  const showNotification = vi.fn(() => Promise.resolve())
  const clients = {
    claim: vi.fn(() => Promise.resolve()),
    matchAll: vi.fn(() => Promise.resolve([])),
    openWindow: vi.fn(() => Promise.resolve()),
  }
  const skipWaiting = vi.fn(() => Promise.resolve())
  const scope = {
    location: new URL(`${ORIGIN}/sw.js`),
    registration: { showNotification },
    clients,
    skipWaiting,
    fetch: fetchMock,
    caches: {
      open: (name: string) => {
        if (options.failOpen?.(name) === true) return Promise.reject(new Error('quota'))
        let store = stores.get(name)
        if (store === undefined) {
          store = new FakeCache()
          stores.set(name, store)
        }
        return Promise.resolve(store)
      },
      keys: () => Promise.resolve([...stores.keys()]),
      delete: (name: string) => Promise.resolve(stores.delete(name)),
    },
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
  }
  runInNewContext(source, { self: scope, URL })
  return {
    stores,
    fetch: fetchMock,
    showNotification,
    clients,
    skipWaiting,
    dispatch: (type, event) => {
      const listener = listeners.get(type)
      if (listener === undefined) throw new Error(`no ${type} listener`)
      listener(event)
    },
  }
}

/** Dispatches a fetch event and returns what the worker answered with, or `undefined` when it left the request alone. */
const fetchEvent = async (
  worker: Harness,
  input: FakeRequest,
): Promise<{ answered: boolean; value?: FakeResponse; waits: Promise<unknown>[] }> => {
  let answer: Promise<FakeResponse> | undefined
  const waits: Promise<unknown>[] = []
  worker.dispatch('fetch', {
    request: input,
    respondWith: (value: Promise<FakeResponse>) => (answer = value),
    waitUntil: (value: Promise<unknown>) => waits.push(value),
  })
  if (answer === undefined) return { answered: false, waits }
  return { answered: true, value: await answer, waits }
}

/** Runs the event's waitUntil promises, e.g. the cache write after a response was already returned. */
const settle = async (waits: readonly Promise<unknown>[]): Promise<void> => {
  await Promise.all(waits)
}

const lifecycle = async (worker: Harness, type: 'install' | 'activate'): Promise<void> => {
  const waits: Promise<unknown>[] = []
  worker.dispatch(type, { waitUntil: (value: Promise<unknown>) => waits.push(value) })
  await settle(waits)
}

describe('service worker: hashed files', () => {
  it('fetches a file under /assets/ once, then serves it from the cache without a request', async () => {
    const worker = load()
    worker.fetch.mockResolvedValue(response('index-abc.js'))

    const first = await fetchEvent(worker, request('/assets/index-abc.js'))
    await settle(first.waits)
    expect(first.value?.label).toBe('index-abc.js')
    expect(worker.fetch).toHaveBeenCalledTimes(1)
    expect(worker.stores.get('nxt-assets-v1')?.entries.size).toBe(1)

    const second = await fetchEvent(worker, request('/assets/index-abc.js'))
    expect(second.value?.label).toBe('index-abc.js')
    expect(worker.fetch).toHaveBeenCalledTimes(1)
  })

  it('does not cache responses that are not a plain 200', async () => {
    const worker = load()
    for (const [path, status, type] of [
      ['/assets/missing.js', 404, 'basic'],
      ['/assets/partial.js', 206, 'basic'],
      ['/assets/opaque.js', 200, 'opaque'],
    ] as const) {
      worker.fetch.mockResolvedValueOnce(response(path, status, type))
      const result = await fetchEvent(worker, request(path))
      await settle(result.waits)
      expect(result.value?.status).toBe(status)
    }
    expect([...(worker.stores.get('nxt-assets-v1')?.entries.keys() ?? [])]).toEqual([])
  })

  it('lets a file that is neither cached nor reachable fail as it would without the worker', async () => {
    const worker = load()
    worker.fetch.mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(fetchEvent(worker, request('/assets/gone.js'))).rejects.toThrow('Failed to fetch')
  })

  it('trims to 240 entries, oldest first, once there are more than 300', async () => {
    const worker = load()
    worker.fetch.mockImplementation((input) => Promise.resolve(response(input.url)))
    const paths = Array.from({ length: 301 }, (_, index) => `/assets/f${String(index).padStart(3, '0')}.js`)
    for (const path of paths.slice(0, 300)) {
      const result = await fetchEvent(worker, request(path))
      await settle(result.waits)
    }
    expect(worker.stores.get('nxt-assets-v1')?.entries.size).toBe(300)

    const last = await fetchEvent(worker, request(paths[300] ?? ''))
    await settle(last.waits)
    const kept = [...(worker.stores.get('nxt-assets-v1')?.entries.keys() ?? [])]
    expect(kept).toHaveLength(240)
    expect(kept[0]).toBe(`${ORIGIN}${paths[61]}`)
    expect(kept.at(-1)).toBe(`${ORIGIN}${paths[300]}`)
  })
})

describe('service worker: pages', () => {
  it('returns what the network answered for a navigation, including error statuses, and caches nothing', async () => {
    const worker = load()
    await lifecycle(worker, 'install')
    for (const status of [200, 401, 502]) {
      const served = response(`page ${status}`, status)
      worker.fetch.mockResolvedValueOnce(served)
      const result = await fetchEvent(worker, request('/settings', { mode: 'navigate' }))
      expect(result.value).toBe(served)
    }
    expect(worker.stores.has('nxt-assets-v1')).toBe(false)
    expect(worker.stores.get('nxt-shell-v1')?.entries.size).toBe(1)
  })

  it('shows the offline page when the instance cannot be reached', async () => {
    const worker = load()
    await lifecycle(worker, 'install')
    worker.fetch.mockRejectedValue(new TypeError('Failed to fetch'))
    const result = await fetchEvent(worker, request('/', { mode: 'navigate' }))
    expect(result.value?.label).toBe('precached /offline.html')
  })

  it('leaves API calls, event streams, other methods and other origins to the browser', async () => {
    const worker = load()
    for (const input of [
      request('/api/events'),
      request('/api/agents'),
      request('/site.webmanifest'),
      request('/login/app.js'),
      request('/api/agents', { method: 'POST' }),
      request('/assets/index-abc.js', { method: 'POST' }),
      request('/assets/index-abc.js', { origin: 'https://cdn.example.test' }),
      request('/', { mode: 'navigate', origin: 'https://other.example.test' }),
    ]) {
      expect((await fetchEvent(worker, input)).answered, `${input.method} ${input.url}`).toBe(false)
    }
    expect(worker.fetch).not.toHaveBeenCalled()
  })
})

describe('service worker: caches', () => {
  it('installs even when the offline page cannot be cached', async () => {
    const worker = load({ failOpen: (name) => name === 'nxt-shell-v1' })
    await expect(lifecycle(worker, 'install')).resolves.toBeUndefined()
    expect(worker.skipWaiting).toHaveBeenCalled()
  })

  it('removes older nxt- caches on activation and keeps the current ones and foreign ones', async () => {
    const worker = load()
    for (const name of ['nxt-assets-v0', 'nxt-shell-v0', 'nxt-assets-v1', 'nxt-shell-v1', 'other-cache']) {
      worker.stores.set(name, new FakeCache())
    }
    await lifecycle(worker, 'activate')
    expect([...worker.stores.keys()].sort()).toEqual(['nxt-assets-v1', 'nxt-shell-v1', 'other-cache'])
    expect(worker.clients.claim).toHaveBeenCalled()
  })
})

describe('service worker: notifications', () => {
  it('shows a pushed notification with its route', async () => {
    const worker = load()
    const waits: Promise<unknown>[] = []
    worker.dispatch('push', {
      data: { json: () => ({ title: '需要处理', body: '有一条新消息', tag: 'm1', route: '/channels/1' }) },
      waitUntil: (value: Promise<unknown>) => waits.push(value),
    })
    await settle(waits)
    expect(worker.showNotification).toHaveBeenCalledWith('需要处理', {
      body: '有一条新消息',
      tag: 'm1',
      renotify: true,
      icon: '/pwa-192.png',
      data: { route: '/channels/1' },
    })
  })

  it('focuses an open window and sends it the route when a notification is clicked', async () => {
    const worker = load()
    const open = { url: `${ORIGIN}/`, focus: vi.fn(() => Promise.resolve()), postMessage: vi.fn() }
    worker.clients.matchAll.mockResolvedValue([open])
    const waits: Promise<unknown>[] = []
    worker.dispatch('notificationclick', {
      notification: { close: vi.fn(), data: { route: '/channels/1?x=1' } },
      waitUntil: (value: Promise<unknown>) => waits.push(value),
    })
    await settle(waits)
    expect(open.focus).toHaveBeenCalled()
    expect(open.postMessage).toHaveBeenCalledWith({ type: 'nekro-nxt:open-route', route: '/channels/1?x=1' })
    expect(worker.clients.openWindow).not.toHaveBeenCalled()
  })
})

describe('registerServiceWorker', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  const stubBrowser = (options: { secure: boolean; worker: boolean; desktop?: boolean }) => {
    const register = vi.fn(() => Promise.resolve({}))
    const registration = { scope: '/' }
    vi.stubGlobal('window', {
      isSecureContext: options.secure,
      ...(options.desktop === true ? { nekroDesktopShell: {} } : {}),
    })
    vi.stubGlobal(
      'navigator',
      options.worker ? { serviceWorker: { register, ready: Promise.resolve(registration) } } : {},
    )
    return { register, registration }
  }
  const loadRegister = async () => (await import('../src/service-worker.js')).registerServiceWorker

  it('registers /sw.js at the root scope', async () => {
    const { register, registration } = stubBrowser({ secure: true, worker: true })
    await expect((await loadRegister())()).resolves.toBe(registration)
    expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/' })
  })

  it('registers only once however often it is called', async () => {
    const { register } = stubBrowser({ secure: true, worker: true })
    const registerServiceWorker = await loadRegister()
    await Promise.all([registerServiceWorker(), registerServiceWorker()])
    await registerServiceWorker()
    expect(register).toHaveBeenCalledTimes(1)
  })

  it('registers nothing without Service Worker support, outside a secure context or in the desktop shell', async () => {
    for (const options of [
      { secure: true, worker: false },
      { secure: false, worker: true },
      { secure: true, worker: true, desktop: true },
    ]) {
      vi.resetModules()
      const { register } = stubBrowser(options)
      await expect((await loadRegister())()).resolves.toBeUndefined()
      expect(register).not.toHaveBeenCalled()
    }
  })

  it('only warns when registration fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { register } = stubBrowser({ secure: true, worker: true })
    register.mockRejectedValueOnce(new Error('untrusted certificate'))
    await expect((await loadRegister())()).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
