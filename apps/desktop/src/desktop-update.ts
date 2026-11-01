import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import type { ProductDownload, ProductUpdateStatus } from '@nekro-nxt/contracts'

/** What Settings → 关于 shows while the desktop app fetches and opens its next installer. */
export type DesktopUpdateState =
  | { readonly phase: 'idle' }
  | {
      readonly phase: 'downloading'
      readonly version: string
      readonly received: number
      readonly total: number
      readonly source: string
    }
  | { readonly phase: 'ready'; readonly version: string }
  | { readonly phase: 'installing'; readonly version: string }
  | { readonly phase: 'failed'; readonly version?: string; readonly error: string }

export type DesktopPlatform = ProductDownload['platform']

export interface DesktopUpdatesOptions {
  readonly platform: DesktopPlatform
  readonly arch: ProductDownload['arch']
  /** Where installers are kept until they are opened. */
  readonly directory: string
  /** The local Host's update status: same build as this app, so its release is this app's next one. */
  readonly readStatus: () => Promise<ProductUpdateStatus>
  /** Quits through the normal path, so the Host stops and releases the data directory before `afterQuit` runs. */
  readonly quitAndInstall: (afterQuit: () => Promise<void>) => void
  /** Opens the downloaded installer for the platform; runs after the app's Host has stopped. */
  readonly openInstaller: (file: string, platform: DesktopPlatform) => Promise<void>
  readonly fetch?: typeof fetch
  /** A source that sends nothing for this long is dropped for the next one. */
  readonly stallMs?: number
  readonly now?: () => number
}

const STALL_MS = 30_000
const PROGRESS_INTERVAL_MS = 250

export const sourceLabel = (url: string): string => {
  const host = new URL(url).hostname
  return host === 'github.com' || host.endsWith('.githubusercontent.com') ? 'GitHub' : '社区镜像'
}

/** Picks this machine's installer; a Mac without its own architecture build gets none rather than the wrong one. */
export const pickDownload = (
  status: ProductUpdateStatus,
  platform: DesktopPlatform,
  arch: ProductDownload['arch'],
): ProductDownload | undefined =>
  status.latest?.downloads?.find((download) => download.platform === platform && download.arch === arch)

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * Downloads the installer of the newer release, checks its size and SHA-256, and opens it once the app has quit.
 * Sources are tried in the order the Host lists them; a failed or stalled source falls through to the next one.
 */
export class DesktopUpdates {
  readonly #options: DesktopUpdatesOptions
  readonly #fetch: typeof fetch
  readonly #now: () => number
  readonly #listeners = new Set<(state: DesktopUpdateState) => void>()
  #state: DesktopUpdateState = { phase: 'idle' }
  #controller: AbortController | undefined
  #ready: { readonly file: string; readonly version: string } | undefined

  constructor(options: DesktopUpdatesOptions) {
    this.#options = options
    this.#fetch = options.fetch ?? fetch
    this.#now = options.now ?? Date.now
  }

  get state(): DesktopUpdateState {
    return this.#state
  }

  get platform(): DesktopPlatform {
    return this.#options.platform
  }

  subscribe(listener: (state: DesktopUpdateState) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async download(): Promise<DesktopUpdateState> {
    if (this.#state.phase === 'downloading' || this.#state.phase === 'installing') return this.#state
    let version: string | undefined
    const controller = new AbortController()
    this.#controller = controller
    try {
      const status = await this.#options.readStatus()
      if (status.state !== 'available' || status.latest === undefined) throw new Error('当前没有可用的更新。')
      version = status.latest.version
      const download = pickDownload(status, this.#options.platform, this.#options.arch)
      if (download === undefined) throw new Error('这个版本没有适合这台设备的安装包，请到发布页手动下载。')
      await mkdir(this.#options.directory, { recursive: true })
      const file = path.join(this.#options.directory, path.basename(download.name))
      if (await this.#verified(file, download)) {
        this.#ready = { file, version }
        return this.#set({ phase: 'ready', version })
      }
      const failures: string[] = []
      for (const url of download.urls) {
        controller.signal.throwIfAborted()
        try {
          await this.#fetchTo(url, file, download, version, controller.signal)
          this.#ready = { file, version }
          return this.#set({ phase: 'ready', version })
        } catch (error) {
          if (controller.signal.aborted) throw error
          failures.push(`${sourceLabel(url)}：${describe(error)}`)
        }
      }
      throw new Error(`下载失败。${failures.join('；')}`)
    } catch (error) {
      if (controller.signal.aborted) return this.#set({ phase: 'idle' })
      return this.#set({ phase: 'failed', ...(version === undefined ? {} : { version }), error: describe(error) })
    } finally {
      if (this.#controller === controller) this.#controller = undefined
    }
  }

  cancel(): DesktopUpdateState {
    this.#controller?.abort()
    return this.#state
  }

  /** Quits the app and opens the installer once the local Host has stopped. */
  install(): DesktopUpdateState {
    const ready = this.#ready
    if (this.#state.phase !== 'ready' || ready === undefined) throw new Error('安装包还没有下载完成。')
    this.#set({ phase: 'installing', version: ready.version })
    this.#options.quitAndInstall(async () => {
      try {
        await this.#options.openInstaller(ready.file, this.#options.platform)
      } catch (error) {
        console.error('[nekro-nxt] 打开安装包失败：', error)
      }
    })
    return this.#state
  }

  async #verified(file: string, download: ProductDownload): Promise<boolean> {
    try {
      if ((await stat(file)).size !== download.size) return false
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(file)) if (Buffer.isBuffer(chunk)) hash.update(chunk)
      return hash.digest('hex') === download.sha256
    } catch {
      return false
    }
  }

  async #fetchTo(
    url: string,
    file: string,
    download: ProductDownload,
    version: string,
    cancelled: AbortSignal,
  ): Promise<void> {
    const source = sourceLabel(url)
    const stallMs = this.#options.stallMs ?? STALL_MS
    const attempt = new AbortController()
    const abort = () => attempt.abort(cancelled.reason)
    cancelled.addEventListener('abort', abort, { once: true })
    let stall: ReturnType<typeof setTimeout> | undefined
    const armStall = () => {
      clearTimeout(stall)
      stall = setTimeout(() => attempt.abort(new Error('长时间没有收到数据')), stallMs)
    }
    const partial = `${file}.part`
    try {
      armStall()
      this.#set({ phase: 'downloading', version, received: 0, total: download.size, source })
      const response = await this.#fetch(url, { signal: attempt.signal, redirect: 'follow' })
      if (!response.ok || response.body === null) throw new Error(`返回 ${response.status}`)
      const hash = createHash('sha256')
      let received = 0
      let reported = 0
      const output = createWriteStream(partial)
      const written = new Promise<void>((resolve, reject) => {
        output.once('finish', resolve)
        output.once('error', reject)
      })
      try {
        const reader = response.body.getReader()
        while (true) {
          const { done, value: bytes } = await reader.read()
          if (done) break
          armStall()
          received += bytes.length
          if (received > download.size) throw new Error('收到的数据比安装包大')
          hash.update(bytes)
          if (!output.write(bytes)) await new Promise<void>((resolve) => output.once('drain', () => resolve()))
          if (this.#now() - reported >= PROGRESS_INTERVAL_MS) {
            reported = this.#now()
            this.#set({ phase: 'downloading', version, received, total: download.size, source })
          }
        }
      } finally {
        output.end()
        await written
      }
      if (received !== download.size) throw new Error('安装包不完整')
      if (hash.digest('hex') !== download.sha256) throw new Error('安装包校验失败')
      await rename(partial, file)
    } catch (error) {
      await rm(partial, { force: true })
      const stalled: unknown = attempt.signal.aborted && !cancelled.aborted ? attempt.signal.reason : undefined
      throw stalled instanceof Error ? stalled : error
    } finally {
      clearTimeout(stall)
      cancelled.removeEventListener('abort', abort)
    }
  }

  #set(state: DesktopUpdateState): DesktopUpdateState {
    this.#state = state
    for (const listener of this.#listeners) listener(state)
    return state
  }
}
