import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, open, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Node that `run_code` programs need: the host's own Node 22+ strips their types. */
const MINIMUM_MAJOR = 22

/** The pinned download, with the checksums nodejs.org publishes for it, so a changed file never runs. */
export interface CodeRunNodeRelease {
  readonly version: string
  readonly baseUrl: string
  readonly artifacts: Readonly<Record<string, { readonly file: string; readonly sha256: string }>>
}

const NODE_RELEASE: CodeRunNodeRelease = {
  version: '24.21.0',
  baseUrl: 'https://nodejs.org/dist/v24.21.0',
  artifacts: {
    'darwin-arm64': {
      file: 'node-v24.21.0-darwin-arm64.tar.gz',
      sha256: 'bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057',
    },
    'darwin-x64': {
      file: 'node-v24.21.0-darwin-x64.tar.gz',
      sha256: '1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097',
    },
    'linux-arm64': {
      file: 'node-v24.21.0-linux-arm64.tar.gz',
      sha256: '724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5',
    },
    'linux-x64': {
      file: 'node-v24.21.0-linux-x64.tar.gz',
      sha256: '6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff',
    },
    'win32-arm64': {
      file: 'node-v24.21.0-win-arm64.zip',
      sha256: '8779b1bde1d39f8d420e3b57aa657b39891af434d3de44a919044cec06785921',
    },
    'win32-x64': {
      file: 'node-v24.21.0-win-x64.zip',
      sha256: '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541',
    },
  },
}

export type CodeRunNodeSource = 'host' | 'system' | 'downloaded'

export interface CodeRunNodeStatus {
  readonly available: boolean
  readonly source?: CodeRunNodeSource
  readonly version?: string
  /** Present where NXT can fetch a Node itself (the desktop app). */
  readonly download?: {
    readonly version: string
    readonly state: 'idle' | 'downloading' | 'failed'
    readonly receivedBytes?: number
    readonly totalBytes?: number
    readonly error?: string
  }
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
 * Finds the Node that runs `run_code` programs. The server uses its own Node. The desktop app prefers a Node it
 * downloaded, then one on the PATH, and otherwise offers to download the pinned release into its data root.
 */
export class CodeRunNode {
  readonly #options: CodeRunNodeOptions
  readonly #release: CodeRunNodeRelease
  readonly #artifact: { readonly file: string; readonly sha256: string } | undefined
  #resolved: { readonly source: CodeRunNodeSource; readonly executable?: string; readonly version: string } | undefined
  #download: NonNullable<CodeRunNodeStatus['download']> | undefined
  #inflight: Promise<void> | undefined
  readonly #listeners = new Set<() => void>()

  constructor(options: CodeRunNodeOptions) {
    this.#options = options
    this.#release = options.release ?? NODE_RELEASE
    this.#artifact = this.#release.artifacts[`${options.platform ?? process.platform}-${options.arch ?? process.arch}`]
    if (!options.embedded) this.#resolved = { source: 'host', version: process.versions.node }
    else if (this.#artifact !== undefined) this.#download = { version: this.#release.version, state: 'idle' }
  }

  /** Looks for a downloaded or system Node once; later calls reuse the answer. */
  async prepare(): Promise<void> {
    if (this.#resolved !== undefined || !this.#options.embedded) return
    const downloaded = await this.#downloadedExecutable()
    if (downloaded !== undefined) {
      this.#resolved = { source: 'downloaded', executable: downloaded, version: this.#release.version }
      return
    }
    const system = await this.#systemNode()
    if (system !== undefined) this.#resolved = { source: 'system', ...system }
  }

  /** What `DshHostRuntime` launches programs with: `{}` is this process, `undefined` means none yet. */
  executable(): { readonly executable?: string } | undefined {
    const resolved = this.#resolved
    if (resolved === undefined) return undefined
    return resolved.executable === undefined ? {} : { executable: resolved.executable }
  }

  status(): CodeRunNodeStatus {
    const resolved = this.#resolved
    return {
      available: resolved !== undefined,
      ...(resolved === undefined ? {} : { source: resolved.source, version: resolved.version }),
      ...(this.#download === undefined || resolved !== undefined ? {} : { download: this.#download }),
    }
  }

  /** Starts the pinned download; progress and the outcome arrive through `status()` and `subscribe()`. */
  startDownload(): CodeRunNodeStatus {
    if (this.#artifact === undefined || this.#download === undefined) {
      throw new Error('这台设备不能自动下载运行环境。')
    }
    if (this.#resolved !== undefined) return this.status()
    // The final state is published only after the staging folder is gone, so a retry or removal can follow at once.
    this.#inflight ??= this.#runDownload(this.#artifact).then((final) => {
      this.#inflight = undefined
      this.#setDownload(final)
    })
    return this.status()
  }

  async #runDownload(artifact: {
    readonly file: string
    readonly sha256: string
  }): Promise<NonNullable<CodeRunNodeStatus['download']>> {
    const versionRoot = path.join(this.#options.root, this.#release.version)
    const staging = path.join(this.#options.root, `.staging-${randomUUID()}`)
    this.#setDownload({ version: this.#release.version, state: 'downloading', receivedBytes: 0 })
    try {
      await mkdir(staging, { recursive: true })
      const archive = path.join(staging, artifact.file)
      const url = `${this.#release.baseUrl}/${artifact.file}`
      const response = await (this.#options.fetch ?? fetch)(url)
      if (!response.ok || response.body === null) throw new Error(`下载失败（HTTP ${response.status}）。`)
      const total = Number(response.headers.get('content-length') ?? 0) || undefined
      const hash = createHash('sha256')
      let received = 0
      let reported = 0
      const reader = response.body.getReader()
      const file = await open(archive, 'w')
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          hash.update(value)
          await file.write(value)
          received += value.length
          // Report about every 2 MB so the page moves without flooding it.
          if (received - reported >= 2 * 1024 * 1024) {
            reported = received
            this.#setDownload({
              version: this.#release.version,
              state: 'downloading',
              receivedBytes: received,
              ...(total === undefined ? {} : { totalBytes: total }),
            })
          }
        }
      } finally {
        await file.close()
      }
      if (hash.digest('hex') !== artifact.sha256) throw new Error('下载的文件校验不通过，已丢弃。')
      const extracted = path.join(staging, 'extracted')
      await mkdir(extracted)
      // macOS, Linux and Windows 10+ all ship a `tar` that reads both .tar.gz and .zip.
      await run('tar', ['-xf', archive, '-C', extracted])
      await rm(archive)
      await rm(versionRoot, { recursive: true, force: true })
      await rename(extracted, versionRoot)
      const executable = await this.#downloadedExecutable()
      if (executable === undefined) throw new Error('解压后没有找到 Node 程序。')
      const version = (await run(executable, ['--version'], { timeout: 10_000 })).stdout.trim()
      if (majorOf(version) < MINIMUM_MAJOR) throw new Error(`下载的 Node ${version} 版本过低。`)
      this.#resolved = { source: 'downloaded', executable, version: this.#release.version }
      return { version: this.#release.version, state: 'idle' }
    } catch (error) {
      // An unpacked Node that failed its check must not be picked up on the next start.
      await rm(versionRoot, { recursive: true, force: true })
      return {
        version: this.#release.version,
        state: 'failed',
        error: error instanceof Error ? error.message : String(error),
      }
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }

  /** Removes the downloaded Node; agents that already started programs keep the one they loaded until restart. */
  async removeDownloaded(): Promise<CodeRunNodeStatus> {
    if (this.#inflight !== undefined) throw new Error('运行环境正在下载，完成后再删除。')
    await rm(path.join(this.#options.root, this.#release.version), { recursive: true, force: true })
    if (this.#resolved?.source === 'downloaded') {
      this.#resolved = undefined
      const system = await this.#systemNode()
      if (system !== undefined) this.#resolved = { source: 'system', ...system }
    }
    this.#notify()
    return this.status()
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

  async #systemNode(): Promise<{ readonly executable: string; readonly version: string } | undefined> {
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

  #setDownload(download: NonNullable<CodeRunNodeStatus['download']>): void {
    this.#download = download
    this.#notify()
  }
}
