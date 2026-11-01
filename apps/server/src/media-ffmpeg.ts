import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, mkdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { createGunzip } from 'node:zlib'
import { downloadPinnedFile, type RuntimeDownloadState } from './runtime-download.js'

const run = promisify(execFile)

export type MediaProgramName = 'ffmpeg' | 'ffprobe'
export const MEDIA_PROGRAMS: readonly MediaProgramName[] = ['ffmpeg', 'ffprobe']

/** One gzip-compressed executable of the pinned build. */
export interface MediaArtifact {
  readonly file: string
  readonly bytes: number
  readonly sha256: string
}

/** The pinned ffmpeg-static build: per platform both programs, with the checksums GitHub publishes for them. */
export interface MediaRelease {
  readonly version: string
  /** Sources tried in order for each file. */
  readonly sources: readonly ((file: string) => string)[]
  /** `<platform>-<arch>` of the build to fetch, keyed by this device's `<platform>-<arch>`. */
  readonly builds: Readonly<Record<string, string>>
  readonly artifacts: Readonly<Record<string, Readonly<Record<MediaProgramName, MediaArtifact>>>>
}

const MEDIA_RELEASE: MediaRelease = {
  version: 'b6.1.1',
  sources: [
    (file) => `https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/${file}`,
    (file) => `https://cdn.npmmirror.com/binaries/ffmpeg-static/b6.1.1/${file}`,
  ],
  // Windows on ARM runs the x64 build.
  builds: {
    'darwin-arm64': 'darwin-arm64',
    'darwin-x64': 'darwin-x64',
    'linux-arm64': 'linux-arm64',
    'linux-x64': 'linux-x64',
    'win32-x64': 'win32-x64',
    'win32-arm64': 'win32-x64',
  },
  artifacts: {
    'darwin-arm64': {
      ffmpeg: {
        file: 'ffmpeg-darwin-arm64.gz',
        bytes: 19_246_198,
        sha256: '8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa',
      },
      ffprobe: {
        file: 'ffprobe-darwin-arm64.gz',
        bytes: 19_207_077,
        sha256: 'd986a8ec7b030899fe66a8a288ed809a3543338705a3ce178cfb85869c5d80be',
      },
    },
    'darwin-x64': {
      ffmpeg: {
        file: 'ffmpeg-darwin-x64.gz',
        bytes: 25_296_431,
        sha256: '929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106',
      },
      ffprobe: {
        file: 'ffprobe-darwin-x64.gz',
        bytes: 25_239_438,
        sha256: 'd4da574d6e2e197bd259b47d69cf262df9e312af24ad960444f6d806d3d4c186',
      },
    },
    'linux-arm64': {
      ffmpeg: {
        file: 'ffmpeg-linux-arm64.gz',
        bytes: 25_568_691,
        sha256: '754a678672298bc68156adff58aa7385a592c2b30b1d0ae8750c45c915c4bac0',
      },
      ffprobe: {
        file: 'ffprobe-linux-arm64.gz',
        bytes: 25_493_573,
        sha256: '2ab6aba60ee84412dff9188720703376cb4e7aaf7e0b5e43aa8249f2acae5bf8',
      },
    },
    'linux-x64': {
      ffmpeg: {
        file: 'ffmpeg-linux-x64.gz',
        bytes: 29_354_986,
        sha256: 'bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa',
      },
      ffprobe: {
        file: 'ffprobe-linux-x64.gz',
        bytes: 29_276_839,
        sha256: '25d9b6ccb05e3d9de9e04e31e2506d8dd7f9f0418981965ac6df12e8d3afd067',
      },
    },
    'win32-x64': {
      ffmpeg: {
        file: 'ffmpeg-win32-x64.gz',
        bytes: 29_581_307,
        sha256: '8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77',
      },
      ffprobe: {
        file: 'ffprobe-win32-x64.gz',
        bytes: 29_521_644,
        sha256: 'f309e6223ad89d2fe54bccd420a7709b66fd27540674e92309578ed491a43c8d',
      },
    },
  },
}

/** An ffmpeg and ffprobe pair found on this device or downloaded by NekroNXT. */
export interface FoundMediaPrograms {
  readonly ffmpeg: string
  readonly ffprobe: string
  readonly version: string
  /** Why a downloaded pair that is present cannot run. */
  readonly problem?: string
}

export interface MediaFfmpegOptions {
  /** `<data root>/runtimes/media`; the folder is NekroNXT's own and holds nothing else. */
  readonly root: string
  readonly platform?: NodeJS.Platform
  readonly arch?: string
  readonly fetch?: typeof fetch
  /** Another pinned release; tests point it at local files. */
  readonly release?: MediaRelease
  /** The `PATH` searched first; defaults to the server's own. */
  readonly pathEnv?: string | undefined
  /** Folders searched after `PATH`; defaults to where package managers install ffmpeg. */
  readonly searchDirectories?: readonly string[]
  readonly isFile?: (file: string) => Promise<boolean>
  /** The version an executable reports, or `undefined` when it does not run; tests replace it. */
  readonly versionOf?: (executable: string) => Promise<string | undefined>
}

const UNRUNNABLE = '下载的 ffmpeg 不能在这台设备上运行。'

const isFile = async (file: string): Promise<boolean> => {
  try {
    return (await stat(file)).isFile()
  } catch {
    return false
  }
}

/** `ffmpeg version 7.0.2-static …` → `7.0.2-static`. */
const ffmpegVersion = async (executable: string): Promise<string | undefined> => {
  try {
    const { stdout } = await run(executable, ['-hide_banner', '-version'], { timeout: 10_000 })
    return /^ff(?:mpeg|probe) version (\S+)/mu.exec(stdout)?.[1]
  } catch {
    return undefined
  }
}

/** Where package managers and installers usually put ffmpeg on each platform. */
export const commonMediaDirectories = (
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] => {
  if (platform === 'darwin') return ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin', '/usr/bin']
  if (platform === 'win32') {
    const join = (...parts: string[]) => path.win32.join(...parts)
    return [
      ...(env['ProgramFiles'] === undefined ? [] : [join(env['ProgramFiles'], 'ffmpeg', 'bin')]),
      ...(env['LOCALAPPDATA'] === undefined ? [] : [join(env['LOCALAPPDATA'], 'Microsoft', 'WinGet', 'Links')]),
      ...(env['USERPROFILE'] === undefined ? [] : [join(env['USERPROFILE'], 'scoop', 'shims')]),
      ...(env['ProgramData'] === undefined ? [] : [join(env['ProgramData'], 'chocolatey', 'bin')]),
      'C:\\ffmpeg\\bin',
    ]
  }
  return ['/usr/bin', '/usr/local/bin', '/home/linuxbrew/.linuxbrew/bin', '/snap/bin']
}

/**
 * The ffmpeg this device already has: both programs, found on `PATH` first and then in the usual install folders. A
 * folder holding both wins, so the two come from the same install; otherwise the first of each that runs.
 */
export const findSystemMediaPrograms = async (input: {
  readonly platform: NodeJS.Platform
  readonly pathEnv: string | undefined
  readonly searchDirectories: readonly string[]
  readonly isFile: (file: string) => Promise<boolean>
  readonly versionOf: (executable: string) => Promise<string | undefined>
}): Promise<FoundMediaPrograms | undefined> => {
  const delimiter = input.platform === 'win32' ? ';' : ':'
  const join = (...parts: string[]) => (input.platform === 'win32' ? path.win32 : path.posix).join(...parts)
  const suffix = input.platform === 'win32' ? '.exe' : ''
  const directories = [
    ...new Set([...(input.pathEnv ?? '').split(delimiter).filter((entry) => entry !== ''), ...input.searchDirectories]),
  ]
  const found = new Map<string, string | undefined>()
  const runs = async (file: string): Promise<string | undefined> => {
    if (!found.has(file)) found.set(file, (await input.isFile(file)) ? await input.versionOf(file) : undefined)
    return found.get(file)
  }
  for (const directory of directories) {
    const ffmpeg = join(directory, `ffmpeg${suffix}`)
    const ffprobe = join(directory, `ffprobe${suffix}`)
    const version = await runs(ffmpeg)
    if (version !== undefined && (await runs(ffprobe)) !== undefined) return { ffmpeg, ffprobe, version }
  }
  let first: { ffmpeg: string; version: string } | undefined
  let ffprobe: string | undefined
  for (const directory of directories) {
    const candidate = join(directory, `ffmpeg${suffix}`)
    const version = first === undefined ? await runs(candidate) : undefined
    if (version !== undefined) first = { ffmpeg: candidate, version }
    const probe = join(directory, `ffprobe${suffix}`)
    if (ffprobe === undefined && (await runs(probe)) !== undefined) ffprobe = probe
  }
  return first === undefined || ffprobe === undefined ? undefined : { ...first, ffprobe }
}

/**
 * The ffmpeg and ffprobe media processing can use: a pair this device already has, and the pinned ffmpeg-static
 * build NekroNXT can download into the data root. Which one runs is the `media` add-on's choice (`AddonRegistry`).
 */
export class MediaFfmpeg {
  readonly #options: MediaFfmpegOptions
  readonly #release: MediaRelease
  readonly #build: string | undefined
  readonly #artifacts: Readonly<Record<MediaProgramName, MediaArtifact>> | undefined
  readonly #suffix: string
  #system: FoundMediaPrograms | undefined
  #downloaded: FoundMediaPrograms | undefined
  #download: RuntimeDownloadState = { state: 'idle' }
  #inflight: Promise<void> | undefined
  readonly #listeners = new Set<() => void>()

  constructor(options: MediaFfmpegOptions) {
    this.#options = options
    this.#release = options.release ?? MEDIA_RELEASE
    const platform = options.platform ?? process.platform
    this.#build = this.#release.builds[`${platform}-${options.arch ?? process.arch}`]
    this.#artifacts = this.#build === undefined ? undefined : this.#release.artifacts[this.#build]
    this.#suffix = platform === 'win32' ? '.exe' : ''
  }

  get releaseVersion(): string {
    return this.#release.version
  }

  /** The license text published with this device's build. */
  get licenseUrl(): string {
    return this.#build === undefined
      ? 'https://github.com/eugeneware/ffmpeg-static'
      : `https://github.com/eugeneware/ffmpeg-static/releases/download/${this.#release.version}/${this.#build}.LICENSE`
  }

  /** Looks for a system pair and a downloaded one once. */
  async prepare(): Promise<void> {
    const platform = this.#options.platform ?? process.platform
    const check = this.#options.isFile ?? isFile
    const versionOf = this.#options.versionOf ?? ffmpegVersion
    this.#system = await findSystemMediaPrograms({
      platform,
      pathEnv: 'pathEnv' in this.#options ? this.#options.pathEnv : process.env['PATH'],
      searchDirectories: this.#options.searchDirectories ?? commonMediaDirectories(platform),
      isFile: check,
      versionOf,
    })
    this.#downloaded = await this.#findDownloaded()
  }

  system(): FoundMediaPrograms | undefined {
    return this.#system
  }

  downloaded(): FoundMediaPrograms | undefined {
    return this.#downloaded
  }

  /** The pinned download, or `undefined` where this device has no build to download. */
  download(): RuntimeDownloadState | undefined {
    return this.#artifacts === undefined ? undefined : this.#download
  }

  /** Size of both compressed programs for this device. */
  downloadBytes(): number | undefined {
    return this.#artifacts === undefined
      ? undefined
      : MEDIA_PROGRAMS.reduce((total, name) => total + this.#artifacts![name].bytes, 0)
  }

  /** The folder the download is unpacked into. */
  get directory(): string {
    return path.join(this.#options.root, this.#release.version)
  }

  /** Starts the pinned download; progress and the outcome arrive through `download()` and `subscribe()`. */
  startDownload(): void {
    const artifacts = this.#artifacts
    if (artifacts === undefined) throw new Error('这台设备不能自动下载 ffmpeg。')
    if (this.#downloaded !== undefined) return
    this.#inflight ??= this.#runDownload(artifacts).then((final) => {
      this.#inflight = undefined
      this.#setDownload(final)
    })
  }

  async #runDownload(artifacts: Readonly<Record<MediaProgramName, MediaArtifact>>): Promise<RuntimeDownloadState> {
    const staging = path.join(this.#options.root, `.staging-${randomUUID()}`)
    const totalBytes = MEDIA_PROGRAMS.reduce((total, name) => total + artifacts[name].bytes, 0)
    let doneBytes = 0
    let reported = 0
    const report = (receivedBytes: number) => {
      // About every 2 MB, so the page moves without flooding it.
      if (receivedBytes !== totalBytes && receivedBytes - reported < 2 * 1024 * 1024) return
      reported = receivedBytes
      this.#setDownload({ state: 'downloading', receivedBytes, totalBytes })
    }
    this.#setDownload({ state: 'downloading', receivedBytes: 0, totalBytes })
    try {
      await mkdir(staging, { recursive: true })
      for (const name of MEDIA_PROGRAMS) {
        const artifact = artifacts[name]
        const archive = path.join(staging, artifact.file)
        await downloadPinnedFile({
          target: archive,
          bytes: artifact.bytes,
          sha256: artifact.sha256,
          urls: this.#release.sources.map((source) => source(artifact.file)),
          ...(this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch }),
          onProgress: (received) => report(doneBytes + received),
        })
        doneBytes += artifact.bytes
        const executable = path.join(staging, `${name}${this.#suffix}`)
        await pipeline(createReadStream(archive), createGunzip(), createWriteStream(executable))
        await chmod(executable, 0o755)
        await rm(archive)
      }
      await rm(this.directory, { recursive: true, force: true })
      await rename(staging, this.directory)
      const found = await this.#findDownloaded()
      if (found === undefined || found.problem !== undefined) throw new Error(UNRUNNABLE)
      this.#downloaded = found
      return { state: 'idle' }
    } catch (error) {
      await rm(this.directory, { recursive: true, force: true })
      return { state: 'failed', error: error instanceof Error ? error.message : String(error) }
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }

  /** Removes the downloaded programs. */
  async removeDownloaded(): Promise<void> {
    if (this.#inflight !== undefined) throw new Error('ffmpeg 正在下载，完成后再删除。')
    await rm(this.directory, { recursive: true, force: true })
    this.#downloaded = undefined
    this.#notify()
  }

  async #findDownloaded(): Promise<FoundMediaPrograms | undefined> {
    const check = this.#options.isFile ?? isFile
    const versionOf = this.#options.versionOf ?? ffmpegVersion
    const ffmpeg = path.join(this.directory, `ffmpeg${this.#suffix}`)
    const ffprobe = path.join(this.directory, `ffprobe${this.#suffix}`)
    if (!(await check(ffmpeg)) || !(await check(ffprobe))) return undefined
    const version = await versionOf(ffmpeg)
    return version === undefined
      ? { ffmpeg, ffprobe, version: this.#release.version, problem: UNRUNNABLE }
      : { ffmpeg, ffprobe, version }
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
