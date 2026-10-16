import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Browser } from 'playwright-core'

/**
 * The headless Chromium that loads and checks creation candidates when no NekroNXT page is open. It is optional:
 * Playwright's own installer downloads it into `<data root>/runtimes/chromium` on request, and without it candidates
 * that may run without asking still run, with their interface marked as unchecked.
 */
/** Same shape as the other downloadable programs (`CodeRunAvailability`), so pages show it the same way. */
export interface VerificationBrowserStatus {
  readonly available: boolean
  readonly source?: 'downloaded'
  readonly version?: string
  /** Present while it is not usable: to install it, or why it failed to install or start. */
  readonly download?: {
    readonly version: string
    readonly state: 'idle' | 'downloading' | 'failed'
    readonly receivedBytes?: number
    readonly totalBytes?: number
    readonly error?: string
  }
}

const PRODUCT = 'Chromium'

export interface VerificationBrowserOptions {
  /** `<data root>/runtimes/chromium`; the folder is NekroNXT's own and holds nothing else. */
  readonly root: string
  /** Runs the installer; tests replace it. Resolves when the process exits, with its exit code. */
  readonly install?: (root: string, onLine: (line: string) => void) => Promise<number>
  /** Starts the browser; tests replace it. */
  readonly launch?: (executablePath: string) => Promise<Browser>
}

const EXECUTABLES = new Set(['chrome-headless-shell', 'chrome-headless-shell.exe'])

/** `node <playwright-core>/cli.js install chromium-headless-shell`, with the browsers folder pointed at `root`. */
const runInstaller = (root: string, onLine: (line: string) => void): Promise<number> =>
  new Promise((resolve, reject) => {
    const require = createRequire(import.meta.url)
    const cli = path.join(path.dirname(require.resolve('playwright-core/package.json')), 'cli.js')
    const child = spawn(process.execPath, [cli, 'install', 'chromium-headless-shell'], {
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: root, PLAYWRIGHT_SKIP_BROWSER_GC: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let buffer = ''
    const feed = (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const lines = buffer.split(/\r|\n/u)
      buffer = lines.pop() ?? ''
      for (const line of lines) if (line.trim()) onLine(line)
    }
    child.stdout.on('data', feed)
    child.stderr.on('data', feed)
    child.on('error', reject)
    child.on('close', (code) => resolve(code ?? 1))
  })

const launchChromium = async (executablePath: string): Promise<Browser> => {
  const { chromium } = await import('playwright-core')
  return chromium.launch({ executablePath, headless: true })
}

/** Installer progress lines look like `|■■■■     |  40% of 92.4 MiB`. */
const progressOf = (line: string): { readonly receivedBytes: number; readonly totalBytes: number } | undefined => {
  const match = /(\d+)%\s+of\s+([\d.]+)\s*(KiB|MiB|GiB)/u.exec(line)
  if (!match) return undefined
  const unit = match[3] === 'GiB' ? 1024 ** 3 : match[3] === 'KiB' ? 1024 : 1024 ** 2
  const totalBytes = Math.round(Number(match[2]) * unit)
  return { receivedBytes: Math.round((totalBytes * Number(match[1])) / 100), totalBytes }
}

export class VerificationBrowser {
  readonly #options: VerificationBrowserOptions
  #executable: string | undefined
  #problem: string | undefined
  #download: NonNullable<VerificationBrowserStatus['download']> = { version: PRODUCT, state: 'idle' }
  #inflight: Promise<void> | undefined
  readonly #listeners = new Set<() => void>()

  constructor(options: VerificationBrowserOptions) {
    this.#options = options
  }

  /** Looks for an installed browser; later calls reuse the answer. */
  async prepare(): Promise<void> {
    this.#executable = await this.#findExecutable()
  }

  status(): VerificationBrowserStatus {
    if (this.#executable !== undefined && this.#problem === undefined && this.#download.state !== 'downloading')
      return { available: true, source: 'downloaded', version: PRODUCT }
    // Installed but unable to start: show why, with the same retry as a failed download.
    const download =
      this.#problem !== undefined && this.#download.state !== 'downloading'
        ? { version: PRODUCT, state: 'failed' as const, error: this.#problem }
        : this.#download
    return { available: false, download }
  }

  /** Starts the installer; progress and the outcome arrive through `status()` and `subscribe()`. */
  startDownload(): VerificationBrowserStatus {
    if (this.#executable !== undefined && this.#problem === undefined) return this.status()
    this.#inflight ??= this.#runInstall().finally(() => {
      this.#inflight = undefined
    })
    return this.status()
  }

  async #runInstall(): Promise<void> {
    this.#setDownload({ version: PRODUCT, state: 'downloading', receivedBytes: 0 })
    let last = ''
    // The installer also fetches a small helper after the browser; only the largest file drives the progress.
    let largest = 0
    try {
      const code = await (this.#options.install ?? runInstaller)(this.#options.root, (line) => {
        last = line
        const progress = progressOf(line)
        if (!progress || progress.totalBytes < largest) return
        largest = progress.totalBytes
        this.#setDownload({ version: PRODUCT, state: 'downloading', ...progress })
      })
      if (code !== 0) throw new Error(last.trim() || `安装程序退出（代码 ${code}）。`)
      this.#executable = await this.#findExecutable()
      if (this.#executable === undefined) throw new Error('安装完成后没有找到浏览器。')
      this.#problem = undefined
      this.#setDownload({ version: PRODUCT, state: 'idle' })
    } catch (error) {
      this.#setDownload({
        version: PRODUCT,
        state: 'failed',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /** Removes the downloaded browser; candidates then run with their interface unchecked. */
  async removeDownloaded(): Promise<VerificationBrowserStatus> {
    if (this.#inflight !== undefined) throw new Error('浏览器正在下载，完成后再删除。')
    await rm(this.#options.root, { recursive: true, force: true })
    this.#executable = undefined
    this.#problem = undefined
    this.#notify()
    return this.status()
  }

  /**
   * Starts the browser. A start that fails (missing system libraries, a damaged download) is remembered as the
   * problem shown in the status, so the next candidate does not try again until the browser is reinstalled.
   */
  async launch(): Promise<Browser | undefined> {
    const executable = this.#executable
    if (executable === undefined || this.#problem !== undefined) return undefined
    try {
      return await (this.#options.launch ?? launchChromium)(executable)
    } catch (error) {
      this.#problem = `无法启动：${error instanceof Error ? error.message.split('\n')[0] : String(error)}`
      this.#notify()
      return undefined
    }
  }

  async #findExecutable(): Promise<string | undefined> {
    const search = async (directory: string, depth: number): Promise<string | undefined> => {
      let entries: string[]
      try {
        entries = await readdir(directory)
      } catch {
        return undefined
      }
      for (const entry of entries) {
        const candidate = path.join(directory, entry)
        if (EXECUTABLES.has(entry)) {
          try {
            if ((await stat(candidate)).isFile()) return candidate
          } catch {
            // A broken link is not a browser.
          }
        }
      }
      if (depth === 0) return undefined
      for (const entry of entries) {
        const found = await search(path.join(directory, entry), depth - 1)
        if (found !== undefined) return found
      }
      return undefined
    }
    return search(this.#options.root, 3)
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #notify(): void {
    for (const listener of this.#listeners) listener()
  }

  #setDownload(download: NonNullable<VerificationBrowserStatus['download']>): void {
    this.#download = download
    this.#notify()
  }
}
