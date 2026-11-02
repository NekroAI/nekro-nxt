import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, mkdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { downloadAndUnpack, type RuntimeDownloadState } from './runtime-download.js'

const run = promisify(execFile)

/** Node that `run_code` programs need: the host's own Node 22+ strips their types. */
const MINIMUM_MAJOR = 22

/** The pinned download, with the checksums nodejs.org publishes for it, so a changed file never runs. */
export interface CodeRunNodeRelease {
  readonly version: string
  readonly baseUrl: string
  readonly artifacts: Readonly<
    Record<string, { readonly file: string; readonly sha256: string; readonly bytes?: number }>
  >
}

const NODE_RELEASE: CodeRunNodeRelease = {
  version: '24.21.0',
  baseUrl: 'https://nodejs.org/dist/v24.21.0',
  artifacts: {
    'darwin-arm64': {
      file: 'node-v24.21.0-darwin-arm64.tar.gz',
      bytes: 52_909_993,
      sha256: 'bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057',
    },
    'darwin-x64': {
      file: 'node-v24.21.0-darwin-x64.tar.gz',
      bytes: 54_203_979,
      sha256: '1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097',
    },
    'linux-arm64': {
      file: 'node-v24.21.0-linux-arm64.tar.gz',
      bytes: 57_824_078,
      sha256: '724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5',
    },
    'linux-x64': {
      file: 'node-v24.21.0-linux-x64.tar.gz',
      bytes: 58_088_022,
      sha256: '6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff',
    },
    'win32-arm64': {
      file: 'node-v24.21.0-win-arm64.zip',
      bytes: 33_679_608,
      sha256: '8779b1bde1d39f8d420e3b57aa657b39891af434d3de44a919044cec06785921',
    },
    'win32-x64': {
      file: 'node-v24.21.0-win-x64.zip',
      bytes: 37_618_919,
      sha256: '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541',
    },
  },
}

/** A Node found on this device or downloaded by NXT. */
export interface FoundNode {
  readonly executable: string
  readonly version: string
}

export interface CodeRunNodeOptions {
  /** `<data root>/runtimes/node`; the folder is NXT's own and holds nothing else. */
  readonly root: string
  /** True inside the desktop app, whose own executable is not a usable Node. */
  readonly embedded: boolean
  readonly platform?: NodeJS.Platform
  readonly arch?: string
  readonly fetch?: typeof fetch
  /** Another pinned release; tests point it at a local archive. */
  readonly release?: CodeRunNodeRelease
}

const majorOf = (version: string): number => Number(/^v?(\d+)\./u.exec(version.trim())?.[1] ?? 0)

/**
 * The Nodes that can run `run_code` programs: the server's own, one on the PATH, and the pinned release NXT can
 * download into its data root (the desktop app, whose own executable is not a usable Node). Which one programs use is
 * the `node` add-on's choice (`AddonRegistry`).
 */
export class CodeRunNode {
  readonly #options: CodeRunNodeOptions
  readonly #release: CodeRunNodeRelease
  readonly #artifact: { readonly file: string; readonly sha256: string; readonly bytes?: number } | undefined
  #system: FoundNode | undefined
  #downloaded: FoundNode | undefined
  #download: RuntimeDownloadState = { state: 'idle' }
  #inflight: Promise<void> | undefined
  readonly #listeners = new Set<() => void>()

  constructor(options: CodeRunNodeOptions) {
    this.#options = options
    this.#release = options.release ?? NODE_RELEASE
    this.#artifact = this.#release.artifacts[`${options.platform ?? process.platform}-${options.arch ?? process.arch}`]
  }

  /** True inside the desktop app; only there NXT offers to download Node. */
  get embedded(): boolean {
    return this.#options.embedded
  }

  get releaseVersion(): string {
    return this.#release.version
  }

  /** Looks for a downloaded and a system Node once (desktop app only). */
  async prepare(): Promise<void> {
    if (!this.#options.embedded) return
    const downloaded = await this.#downloadedExecutable()
    this.#downloaded = downloaded === undefined ? undefined : { executable: downloaded, version: this.#release.version }
    this.#system = await this.#systemNode()
  }

  /** The server's own Node; programs then run with this process. Absent inside the desktop app. */
  bundled(): { readonly version: string } | undefined {
    return this.#options.embedded ? undefined : { version: process.versions.node }
  }

  system(): FoundNode | undefined {
    return this.#system
  }

  downloaded(): FoundNode | undefined {
    return this.#downloaded
  }

  /** The pinned download, or `undefined` where this device has no build to download. */
  download(): RuntimeDownloadState | undefined {
    return this.#artifact === undefined ? undefined : this.#download
  }

  /** Size of the pinned archive for this device, when known. */
  downloadBytes(): number | undefined {
    return this.#artifact?.bytes
  }

  /** Starts the pinned download; progress and the outcome arrive through `download()` and `subscribe()`. */
  startDownload(): void {
    if (this.#artifact === undefined || !this.#options.embedded) {
      throw new Error('这台设备不能自动下载运行环境。')
    }
    if (this.#downloaded !== undefined) return
    // The final state is published only after the staging folder is gone, so a retry or removal can follow at once.
    this.#inflight ??= this.#runDownload(this.#artifact).then((final) => {
      this.#inflight = undefined
      this.#setDownload(final)
    })
  }

  async #runDownload(artifact: { readonly file: string; readonly sha256: string }): Promise<RuntimeDownloadState> {
    const versionRoot = path.join(this.#options.root, this.#release.version)
    const staging = path.join(this.#options.root, `.staging-${randomUUID()}`)
    this.#setDownload({ state: 'downloading', receivedBytes: 0 })
    try {
      await mkdir(staging, { recursive: true })
      const extracted = path.join(staging, 'extracted')
      await downloadAndUnpack({
        url: `${this.#release.baseUrl}/${artifact.file}`,
        sha256: artifact.sha256,
        archive: path.join(staging, artifact.file),
        destination: extracted,
        ...(this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch }),
        onProgress: (progress) => this.#setDownload({ state: 'downloading', ...progress }),
      })
      await rm(versionRoot, { recursive: true, force: true })
      await rename(extracted, versionRoot)
      const executable = await this.#downloadedExecutable()
      if (executable === undefined) throw new Error('解压后没有找到 Node 程序。')
      const version = (await run(executable, ['--version'], { timeout: 10_000 })).stdout.trim()
      if (majorOf(version) < MINIMUM_MAJOR) throw new Error(`下载的 Node ${version} 版本过低。`)
      this.#downloaded = { executable, version: this.#release.version }
      return { state: 'idle' }
    } catch (error) {
      // An unpacked Node that failed its check must not be picked up on the next start.
      await rm(versionRoot, { recursive: true, force: true })
      return { state: 'failed', error: error instanceof Error ? error.message : String(error) }
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }

  /** Removes the downloaded Node; agents that already started programs keep the one they loaded until restart. */
  async removeDownloaded(): Promise<void> {
    if (this.#inflight !== undefined) throw new Error('运行环境正在下载，完成后再删除。')
    await rm(path.join(this.#options.root, this.#release.version), { recursive: true, force: true })
    this.#downloaded = undefined
    this.#notify()
  }

  async #downloadedExecutable(): Promise<string | undefined> {
    if (this.#artifact === undefined) return undefined
    const folder = this.#artifact.file.replace(/\.(tar\.gz|zip)$/u, '')
    const base = path.join(this.#options.root, this.#release.version, folder)
    const executable =
      (this.#options.platform ?? process.platform) === 'win32'
        ? path.join(base, 'node.exe')
        : path.join(base, 'bin', 'node')
    try {
      await access(executable)
      return (await stat(executable)).isFile() ? executable : undefined
    } catch {
      return undefined
    }
  }

  async #systemNode(): Promise<FoundNode | undefined> {
    try {
      const probe = await run('node', ['-p', 'process.execPath + "\\n" + process.version'], { timeout: 10_000 })
      const [executable, version] = probe.stdout.trim().split('\n')
      if (executable === undefined || version === undefined || majorOf(version) < MINIMUM_MAJOR) return undefined
      return { executable, version: version.replace(/^v/u, '') }
    } catch {
      return undefined
    }
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #notify(): void {
    for (const listener of this.#listeners) listener()
  }

  #setDownload(download: RuntimeDownloadState): void {
    this.#download = download
    this.#notify()
  }
}
