import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { downloadPinnedFile, type RuntimeDownloadState } from './runtime-download.js'

const run = promisify(execFile)

/**
 * The pinned PortableGit, with the size and checksum GitHub publishes for it, so a changed file never runs. MinGit is
 * smaller but carries no bash; PortableGit brings bash and the usual commands (`mv`, `rm`, `grep`) with Git itself.
 * `scripts/runtime-mirror.json` lists the same files for the copy on NekroAI's download mirror.
 */
export interface GitBashRelease {
  readonly version: string
  readonly tag: string
  readonly artifacts: Readonly<
    Record<string, { readonly file: string; readonly sha256: string; readonly bytes: number }>
  >
}

/** Git for Windows names its releases `<Git version>.windows.<build>`, and PortableGit `<Git version>.<build>`. */
const GIT_VERSION = '2.56.0'
const GIT_FOR_WINDOWS_BUILD = 4

export const GIT_BASH_RELEASE: GitBashRelease = {
  version: GIT_VERSION,
  tag: `v${GIT_VERSION}.windows.${GIT_FOR_WINDOWS_BUILD}`,
  artifacts: {
    'win32-x64': {
      file: `PortableGit-${GIT_VERSION}.${GIT_FOR_WINDOWS_BUILD}-64-bit.7z.exe`,
      bytes: 60_087_472,
      sha256: 'b1f3e52216e2ed6882d1bebfd4d3fdf319bec40d2edbbf9fd26ec4fd3fce7ed1',
    },
    'win32-arm64': {
      file: `PortableGit-${GIT_VERSION}.${GIT_FOR_WINDOWS_BUILD}-arm64.7z.exe`,
      bytes: 59_668_120,
      sha256: '044110f9d951858452ddb5e4b5415ea0f2b5b2598e794d6fec77fe28b9aa8cc0',
    },
  },
}

/** Where a release file sits on NekroAI's download mirror, under its base such as `https://dl.nekro.ai/nxt`. */
export const gitBashMirrorPath = (release: GitBashRelease, file: string): string =>
  `runtimes/git-for-windows/${release.tag}/${file}`

/** A Git for Windows installation: its `bin` folder holds `bash.exe` and `git.exe`. */
export interface FoundGitBash {
  readonly root: string
  readonly bash: string
  readonly git: string
  readonly version?: string
}

export interface GitBashOptions {
  /** `<data root>/runtimes/git`; the folder is NekroNXT's own and holds nothing else. */
  readonly root: string
  /** Base of NekroAI's download mirror, tried before GitHub; unset downloads from GitHub only. */
  readonly mirror?: string
  readonly arch?: string
  readonly fetch?: typeof fetch
  /** Another pinned release; tests point it at a local file. */
  readonly release?: GitBashRelease
  /** Looks for an installed Git for Windows; tests replace it. */
  readonly findSystem?: () => Promise<FoundGitBash | undefined>
  /** Unpacks the self-extracting archive into `destination`; tests replace it. */
  readonly unpack?: (archive: string, destination: string) => Promise<void>
}

const isFile = async (candidate: string): Promise<boolean> => {
  try {
    return (await stat(candidate)).isFile()
  } catch {
    return false
  }
}

/** The installation at `root`, when its `bin` folder has both programs; the version comes from its Git. */
export const gitBashAt = async (root: string): Promise<FoundGitBash | undefined> => {
  const bash = path.join(root, 'bin', 'bash.exe')
  const git = path.join(root, 'bin', 'git.exe')
  if (!(await isFile(bash)) || !(await isFile(git))) return undefined
  try {
    const version = /git version (\d+\.\d+\.\d+)/u.exec(
      (await run(git, ['--version'], { timeout: 10_000 })).stdout,
    )?.[1]
    return { root, bash, git, ...(version === undefined ? {} : { version }) }
  } catch {
    return undefined
  }
}

/**
 * Installation roots of the `git.exe` programs on `PATH` (`<root>\cmd`, `<root>\bin`, `<root>\mingw64\bin`), then the
 * usual install folders. `bash.exe` on `PATH` is never followed: `C:\Windows\System32\bash.exe` is the launcher of
 * the Windows Subsystem for Linux, which cannot run commands in a Windows folder (#96).
 */
export const gitRootCandidates = (
  gitOnPath: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): string[] => {
  const roots: string[] = []
  for (const executable of gitOnPath) {
    const folder = path.win32.dirname(executable)
    const parent = path.win32.dirname(folder)
    const name = path.win32.basename(folder).toLowerCase()
    if (name === 'cmd') roots.push(parent)
    else if (name === 'bin')
      roots.push(path.win32.basename(parent).toLowerCase() === 'mingw64' ? path.win32.dirname(parent) : parent)
  }
  for (const base of [
    env['ProgramW6432'],
    env['ProgramFiles'],
    env['LOCALAPPDATA'] && `${env['LOCALAPPDATA']}\\Programs`,
  ]) {
    if (base) roots.push(path.win32.join(base, 'Git'))
  }
  return [...new Set(roots)]
}

const systemGitBash = async (): Promise<FoundGitBash | undefined> => {
  let onPath: string[] = []
  try {
    onPath = (await run('where', ['git'], { timeout: 10_000 })).stdout.split(/\r?\n/u).filter((line) => line !== '')
  } catch {
    // No Git on PATH; the usual install folders are still looked at.
  }
  for (const root of gitRootCandidates(onPath)) {
    const found = await gitBashAt(root)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * PortableGit is a 7-Zip self-extracting archive. It runs from its own folder by a relative name so that no space in
 * the data root's path reaches its command line.
 */
const unpackPortableGit = async (archive: string, destination: string): Promise<void> => {
  await run(`.\\${path.basename(archive)}`, ['-y', `-o${path.relative(path.dirname(archive), destination)}`], {
    cwd: path.dirname(archive),
    timeout: 10 * 60 * 1000,
    windowsHide: true,
  })
}

/**
 * The bash agents' commands run with on Windows (#96): a Git for Windows the user already has, or the pinned
 * PortableGit NekroNXT downloads into the data root. Which one is used is the `git-bash` add-on's choice
 * (`AddonRegistry`). Other platforms bring their own bash and never use this.
 */
export class GitBash {
  readonly #options: GitBashOptions
  readonly #release: GitBashRelease
  readonly #artifact: { readonly file: string; readonly sha256: string; readonly bytes: number } | undefined
  #system: FoundGitBash | undefined
  #downloaded: FoundGitBash | undefined
  #download: RuntimeDownloadState = { state: 'idle' }
  #inflight: Promise<void> | undefined
  readonly #listeners = new Set<() => void>()

  constructor(options: GitBashOptions) {
    this.#options = options
    this.#release = options.release ?? GIT_BASH_RELEASE
    this.#artifact = this.#release.artifacts[`win32-${options.arch ?? process.arch}`]
  }

  get releaseVersion(): string {
    return this.#release.version
  }

  /** Looks for an installed Git for Windows and a downloaded one once. */
  async prepare(): Promise<void> {
    this.#system = await (this.#options.findSystem ?? systemGitBash)()
    this.#downloaded = await this.#findDownloaded()
  }

  system(): FoundGitBash | undefined {
    return this.#system
  }

  downloaded(): FoundGitBash | undefined {
    return this.#downloaded
  }

  /** The pinned download, or `undefined` where this device has no build to download. */
  download(): RuntimeDownloadState | undefined {
    return this.#artifact === undefined ? undefined : this.#download
  }

  downloadBytes(): number | undefined {
    return this.#artifact?.bytes
  }

  /** Download sources in the order they are tried: the mirror first, as GitHub is hard to reach in some places. */
  sources(file: string): string[] {
    const github = `https://github.com/git-for-windows/git/releases/download/${this.#release.tag}/${file}`
    const mirror = this.#options.mirror?.replace(/\/+$/u, '')
    return mirror === undefined ? [github] : [`${mirror}/${gitBashMirrorPath(this.#release, file)}`, github]
  }

  /** Starts the pinned download; progress and the outcome arrive through `download()` and `subscribe()`. */
  startDownload(): void {
    if (this.#artifact === undefined) throw new Error('这台设备不能自动下载 Git 与 Bash。')
    if (this.#downloaded !== undefined) return
    this.#inflight ??= this.#runDownload(this.#artifact).then((final) => {
      this.#inflight = undefined
      this.#setDownload(final)
    })
  }

  async #runDownload(artifact: {
    readonly file: string
    readonly sha256: string
    readonly bytes: number
  }): Promise<RuntimeDownloadState> {
    const versionRoot = path.join(this.#options.root, this.#release.version)
    const staging = path.join(this.#options.root, `.staging-${randomUUID()}`)
    this.#setDownload({ state: 'downloading', receivedBytes: 0, totalBytes: artifact.bytes })
    try {
      const archive = path.join(staging, artifact.file)
      let reported = 0
      await downloadPinnedFile(
        { target: archive, bytes: artifact.bytes, sha256: artifact.sha256, urls: this.sources(artifact.file) },
        {
          ...(this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch }),
          onProgress: (received) => {
            // Report about every 2 MB so the page moves without flooding it.
            if (received - reported < 2 * 1024 * 1024) return
            reported = received
            this.#setDownload({ state: 'downloading', receivedBytes: received, totalBytes: artifact.bytes })
          },
        },
      )
      const extracted = path.join(staging, 'extracted')
      await mkdir(extracted, { recursive: true })
      await (this.#options.unpack ?? unpackPortableGit)(archive, extracted)
      await rm(versionRoot, { recursive: true, force: true })
      await rename(extracted, versionRoot)
      const found = await this.#findDownloaded()
      if (found === undefined) throw new Error('解压后没有找到 bash.exe 和 git.exe。')
      this.#downloaded = found
      return { state: 'idle' }
    } catch (error) {
      await rm(versionRoot, { recursive: true, force: true })
      return { state: 'failed', error: error instanceof Error ? error.message : String(error) }
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }

  /** Removes the downloaded PortableGit. */
  async removeDownloaded(): Promise<void> {
    if (this.#inflight !== undefined) throw new Error('Git 与 Bash 正在下载，完成后再删除。')
    await rm(path.join(this.#options.root, this.#release.version), { recursive: true, force: true })
    this.#downloaded = undefined
    this.#notify()
  }

  async #findDownloaded(): Promise<FoundGitBash | undefined> {
    const found = await gitBashAt(path.join(this.#options.root, this.#release.version))
    return found === undefined ? undefined : { ...found, version: found.version ?? this.#release.version }
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
