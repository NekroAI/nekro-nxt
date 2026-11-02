import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { downloadAndUnpack, type RuntimeDownloadState } from './runtime-download.js'

const run = promisify(execFile)

/** The pinned download, with the checksums GitHub publishes for it, so a changed file never runs. */
export interface GithubCliRelease {
  readonly version: string
  readonly baseUrl: string
  readonly artifacts: Readonly<
    Record<string, { readonly file: string; readonly sha256: string; readonly bytes?: number }>
  >
}

const GITHUB_CLI_RELEASE: GithubCliRelease = {
  version: '2.102.0',
  baseUrl: 'https://github.com/cli/cli/releases/download/v2.102.0',
  artifacts: {
    'darwin-arm64': {
      file: 'gh_2.102.0_macOS_arm64.zip',
      bytes: 15_995_994,
      sha256: 'da922c20d1792e5b2cbf375593d7a658acf034c12c84e007e71c76ef959c337e',
    },
    'darwin-x64': {
      file: 'gh_2.102.0_macOS_amd64.zip',
      bytes: 14_483_897,
      sha256: 'b245f24eb2bf5f75b426b4c26da3651a107f8d5b6f4fddfbfccc5679041378b3',
    },
    'linux-arm64': {
      file: 'gh_2.102.0_linux_arm64.tar.gz',
      bytes: 14_413_520,
      sha256: '7862c86c72f43df3a2d93ddde6f473285b4e2af61b494849846827e513ef6484',
    },
    'linux-x64': {
      file: 'gh_2.102.0_linux_amd64.tar.gz',
      bytes: 15_967_030,
      sha256: 'bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386',
    },
    'win32-arm64': {
      file: 'gh_2.102.0_windows_arm64.zip',
      bytes: 14_102_528,
      sha256: '5dcf12aa8525eabd0c46ec414f323ab6cf65229fc2cd46543cc705001bbaf223',
    },
    'win32-x64': {
      file: 'gh_2.102.0_windows_amd64.zip',
      bytes: 15_757_312,
      sha256: 'ae64e556ecc240b200f7eba60d550e4bb60d78e860e69dd88c449405b86067f4',
    },
  },
}

/** A `gh` found on this device or downloaded by NekroNXT. */
export interface FoundGithubCli {
  readonly executable: string
  readonly version: string
}

export interface GithubCliOptions {
  /** `<data root>/runtimes/gh`; the folder is NekroNXT's own and holds nothing else. */
  readonly root: string
  readonly platform?: NodeJS.Platform
  readonly arch?: string
  readonly fetch?: typeof fetch
  /** Another pinned release; tests point it at a local archive. */
  readonly release?: GithubCliRelease
  /** Looks `gh` up on the host's `PATH`; tests replace it. */
  readonly findSystem?: () => Promise<FoundGithubCli | undefined>
}

const systemGithubCli = async (): Promise<FoundGithubCli | undefined> => {
  try {
    const version = /gh version (\S+)/u.exec((await run('gh', ['--version'], { timeout: 10_000 })).stdout)?.[1]
    if (version === undefined) return undefined
    const locator = process.platform === 'win32' ? 'where' : 'which'
    const executable = (await run(locator, ['gh'], { timeout: 10_000 })).stdout.trim().split(/\r?\n/u)[0]
    return executable === undefined || executable === '' ? undefined : { executable, version }
  } catch {
    return undefined
  }
}

/**
 * The GitHub CLIs commands can call: a `gh` the user already has, and the pinned release NekroNXT can download into
 * the data root. Which one commands use is the `github-cli` add-on's choice (`AddonRegistry`). The program carries no
 * login of its own: an account reaches it only through an agent's grant.
 */
export class GithubCli {
  readonly #options: GithubCliOptions
  readonly #release: GithubCliRelease
  readonly #artifact: { readonly file: string; readonly sha256: string; readonly bytes?: number } | undefined
  #system: FoundGithubCli | undefined
  #downloaded: FoundGithubCli | undefined
  #download: RuntimeDownloadState = { state: 'idle' }
  #inflight: Promise<void> | undefined
  readonly #listeners = new Set<() => void>()

  constructor(options: GithubCliOptions) {
    this.#options = options
    this.#release = options.release ?? GITHUB_CLI_RELEASE
    this.#artifact = this.#release.artifacts[`${options.platform ?? process.platform}-${options.arch ?? process.arch}`]
  }

  get releaseVersion(): string {
    return this.#release.version
  }

  /** Looks for a system `gh` and a downloaded one once. */
  async prepare(): Promise<void> {
    this.#system = await (this.#options.findSystem ?? systemGithubCli)()
    const downloaded = await this.#downloadedExecutable()
    this.#downloaded = downloaded === undefined ? undefined : { executable: downloaded, version: this.#release.version }
  }

  system(): FoundGithubCli | undefined {
    return this.#system
  }

  downloaded(): FoundGithubCli | undefined {
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
    if (this.#artifact === undefined) throw new Error('这台设备不能自动下载 GitHub CLI。')
    if (this.#downloaded !== undefined) return
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
      if (executable === undefined) throw new Error('解压后没有找到 GitHub CLI。')
      await run(executable, ['--version'], { timeout: 10_000 })
      this.#downloaded = { executable, version: this.#release.version }
      return { state: 'idle' }
    } catch (error) {
      await rm(versionRoot, { recursive: true, force: true })
      return { state: 'failed', error: error instanceof Error ? error.message : String(error) }
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }

  /** Removes the downloaded program. */
  async removeDownloaded(): Promise<void> {
    if (this.#inflight !== undefined) throw new Error('GitHub CLI 正在下载，完成后再删除。')
    await rm(path.join(this.#options.root, this.#release.version), { recursive: true, force: true })
    this.#downloaded = undefined
    this.#notify()
  }

  /** Release archives hold `bin/gh` either at the top or inside one folder. */
  async #downloadedExecutable(): Promise<string | undefined> {
    const name = (this.#options.platform ?? process.platform) === 'win32' ? 'gh.exe' : 'gh'
    const base = path.join(this.#options.root, this.#release.version)
    const isFile = async (candidate: string): Promise<boolean> => {
      try {
        return (await stat(candidate)).isFile()
      } catch {
        return false
      }
    }
    const top = path.join(base, 'bin', name)
    if (await isFile(top)) return top
    let entries: string[]
    try {
      entries = await readdir(base)
    } catch {
      return undefined
    }
    for (const entry of entries) {
      const nested = path.join(base, entry, 'bin', name)
      if (await isFile(nested)) return nested
    }
    return undefined
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
