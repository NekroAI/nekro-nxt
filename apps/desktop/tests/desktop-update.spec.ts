import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ProductDownload, ProductUpdateStatus } from '@nekro-nxt/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DesktopUpdates, type DesktopUpdatesOptions } from '../src/desktop-update.ts'

const content = new TextEncoder().encode('fixture installer bytes')
const sha256 = createHash('sha256').update(content).digest('hex')
const MIRROR = 'https://downloads.example/nxt/desktop/stable/files/v0.8.0/nekro-nxt-win-x64-v0.8.0-setup.exe'
const GITHUB = 'https://github.com/dl/nekro-nxt-win-x64-v0.8.0-setup.exe'

const download = (overrides: Partial<ProductDownload> = {}): ProductDownload => ({
  platform: 'win',
  arch: 'x64',
  name: 'nekro-nxt-win-x64-v0.8.0-setup.exe',
  size: content.length,
  sha256,
  urls: [MIRROR, GITHUB],
  ...overrides,
})

const status = (downloads: readonly ProductDownload[]): ProductUpdateStatus => ({
  channel: 'stable',
  currentVersion: '0.7.0',
  state: 'available',
  autoCheck: true,
  latest: {
    version: '0.8.0',
    url: 'https://github.com/NekroAI/nekro-nxt/releases/tag/v0.8.0',
    downloads: [...downloads],
  },
})

const urlOf = (input: string | URL | Request) => (input instanceof Request ? input.url : input.toString())

/** Serves bytes per URL; a URL mapped to `stall` opens a body that never sends anything. */
const sources = (routes: Record<string, Uint8Array | number | 'stall'>) => {
  const requested: string[] = []
  const fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = urlOf(input)
    requested.push(url)
    const route = routes[url]
    if (route === undefined || typeof route === 'number')
      return Promise.resolve(new Response(null, { status: route ?? 404 }))
    if (route === 'stall') {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason))
        },
      })
      return Promise.resolve(new Response(body))
    }
    return Promise.resolve(new Response(new Uint8Array(route)))
  }
  return { fetch, requested }
}

describe('desktop updates', () => {
  let directory: string
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'nxt-update-'))
  })
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  const build = (overrides: Partial<DesktopUpdatesOptions>) =>
    new DesktopUpdates({
      platform: 'win',
      arch: 'x64',
      directory,
      readStatus: () => Promise.resolve(status([download()])),
      quitAndInstall: () => undefined,
      openInstaller: () => Promise.resolve(),
      stallMs: 50,
      ...overrides,
    })

  it('downloads from the first source, checks it, and opens it only after the app has quit', async () => {
    const net = sources({ [MIRROR]: content })
    let afterQuit: (() => Promise<void>) | undefined
    const openInstaller = vi.fn(() => Promise.resolve())
    const updates = build({
      fetch: net.fetch,
      quitAndInstall: (after) => {
        afterQuit = after
      },
      openInstaller,
    })
    const seen: string[] = []
    updates.subscribe((state) => seen.push(state.phase))
    await expect(updates.download()).resolves.toEqual({ phase: 'ready', version: '0.8.0' })
    expect(net.requested).toEqual([MIRROR])
    expect(seen[0]).toBe('downloading')
    const file = path.join(directory, 'nekro-nxt-win-x64-v0.8.0-setup.exe')
    expect(await readFile(file)).toEqual(Buffer.from(content))

    expect(updates.install()).toEqual({ phase: 'installing', version: '0.8.0' })
    expect(openInstaller).not.toHaveBeenCalled()
    await afterQuit?.()
    expect(openInstaller).toHaveBeenCalledWith(file, 'win')
  })

  it('falls through to the next source when one fails, stalls or sends the wrong bytes', async () => {
    for (const broken of [503, 'stall', new TextEncoder().encode('tampered bytes here!!!')] as const) {
      const net = sources({ [MIRROR]: broken, [GITHUB]: content })
      const updates = build({ fetch: net.fetch })
      const sourcesSeen = new Set<string>()
      updates.subscribe((state) => {
        if (state.phase === 'downloading') sourcesSeen.add(state.source)
      })
      await expect(updates.download()).resolves.toMatchObject({ phase: 'ready' })
      expect(net.requested).toEqual([MIRROR, GITHUB])
      expect([...sourcesSeen]).toEqual(['社区镜像', 'GitHub'])
      await rm(path.join(directory, 'nekro-nxt-win-x64-v0.8.0-setup.exe'))
    }
  })

  it('says why every source failed, and leaves no partial file', async () => {
    const updates = build({ fetch: sources({ [MIRROR]: 500, [GITHUB]: 404 }).fetch })
    await expect(updates.download()).resolves.toEqual({
      phase: 'failed',
      version: '0.8.0',
      error: '下载失败。社区镜像：返回 500；GitHub：返回 404',
    })
    expect(await readFile(path.join(directory, 'nekro-nxt-win-x64-v0.8.0-setup.exe.part')).catch(() => 'gone')).toBe(
      'gone',
    )
    expect(() => updates.install()).toThrow('还没有下载完成')
  })

  it('offers nothing to a machine without its own installer, and reuses one already downloaded', async () => {
    const mac = build({ platform: 'mac', arch: 'arm64', fetch: sources({}).fetch })
    await expect(mac.download()).resolves.toMatchObject({
      phase: 'failed',
      error: expect.stringContaining('适合这台设备') as unknown,
    })

    await writeFile(path.join(directory, 'nekro-nxt-win-x64-v0.8.0-setup.exe'), content)
    const net = sources({})
    await expect(build({ fetch: net.fetch }).download()).resolves.toEqual({ phase: 'ready', version: '0.8.0' })
    expect(net.requested).toEqual([])
  })

  it('goes back to idle when the download is cancelled', async () => {
    const updates = build({ fetch: sources({ [MIRROR]: 'stall' }).fetch, stallMs: 10_000 })
    const pending = updates.download()
    await vi.waitFor(() => expect(updates.state.phase).toBe('downloading'))
    updates.cancel()
    await expect(pending).resolves.toEqual({ phase: 'idle' })
  })
})
