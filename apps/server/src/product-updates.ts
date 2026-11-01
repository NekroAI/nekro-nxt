import type { JsonValue, ProductDownload, ProductUpdateStatus } from '@nekro-nxt/contracts'
import { z } from 'zod'

/** How often a host looks for a newer release on its own; a manual check is always allowed. */
export const PRODUCT_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000
const CHECK_TIMEOUT_MS = 10_000
const SETTING_KEY = 'product.updates'

export type ReleaseChannel = ProductUpdateStatus['channel']

/**
 * Release builds carry `<version>+<commit12>`: a plain `X.Y.Z` version is a Stable build, a prerelease suffix a
 * Preview build. Anything else (a source checkout) is a development build and is never compared.
 */
export const releaseIdentity = (
  releaseId: string,
): { readonly channel: ReleaseChannel; readonly version: string; readonly commit?: string } => {
  const match = /^(\d+\.\d+\.\d+)(-[0-9A-Za-z.-]+)?\+([0-9a-f]{7,40})$/u.exec(releaseId.trim())
  if (match === null) return { channel: 'development', version: releaseId.trim() }
  const [, core, prerelease, commit] = match
  return prerelease === undefined
    ? { channel: 'stable', version: core!, commit: commit! }
    : { channel: 'preview', version: `${core!}${prerelease}`, commit: commit! }
}

const semverParts = (version: string): readonly number[] | undefined => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/u.exec(version.trim())
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])]
}

export const isNewerVersion = (candidate: string, current: string): boolean => {
  const next = semverParts(candidate)
  const now = semverParts(current)
  if (next === undefined || now === undefined) return false
  for (let index = 0; index < 3; index += 1) {
    if (next[index]! !== now[index]!) return next[index]! > now[index]!
  }
  return false
}

const GitHubReleaseSchema = z
  .object({
    tag_name: z.string().optional(),
    name: z.string().nullable().optional(),
    html_url: z.string().url().optional(),
    published_at: z.string().nullable().optional(),
    updated_at: z.string().nullable().optional(),
    body: z.string().nullable().optional(),
    assets: z
      .array(
        z
          .object({
            name: z.string(),
            size: z.number(),
            digest: z.string().nullable().optional(),
            browser_download_url: z.string().url(),
          })
          .loose(),
      )
      .optional(),
  })
  .loose()

type GitHubRelease = z.output<typeof GitHubReleaseSchema>

/** What the CI writes next to the installers it copies to the community mirror. */
const MirrorManifestSchema = z
  .object({
    format: z.literal('nxt.desktop-mirror'),
    version: z.literal(1),
    channel: z.enum(['stable', 'preview']),
    releaseVersion: z.string(),
    commit: z.string().regex(/^[0-9a-f]{7,40}$/u),
    publishedAt: z.number().int().nonnegative(),
    releaseUrl: z.string().url(),
    files: z.array(
      z
        .object({
          platform: z.enum(['mac', 'win', 'linux']),
          arch: z.enum(['arm64', 'x64']),
          name: z.string().min(1),
          size: z.number().int().positive(),
          sha256: z.string().regex(/^[a-f0-9]{64}$/u),
          path: z.string().min(1),
        })
        .strict(),
    ),
  })
  .loose()

/** One source's view of the newest release on the channel. */
interface ReleaseCandidate {
  readonly version: string
  readonly commit?: string
  readonly url: string
  readonly publishedAt?: number
  readonly downloads: readonly ProductDownload[]
}

const PLATFORMS = ['mac', 'win', 'linux'] as const
const ARCHITECTURES = ['arm64', 'x64'] as const
const INSTALLER = /^nekro-nxt(?:-preview)?-(mac|win|linux)-(arm64|x64)-v.+\.(?:dmg|exe|AppImage)$/u

/** Installers among a GitHub release's assets; one without a published digest cannot be checked and is left out. */
export const githubDownloads = (release: GitHubRelease): ProductDownload[] =>
  (release.assets ?? []).flatMap((asset) => {
    const match = INSTALLER.exec(asset.name)
    const sha256 = /^sha256:([a-f0-9]{64})$/u.exec(asset.digest ?? '')?.[1]
    if (match === null || sha256 === undefined || !Number.isSafeInteger(asset.size) || asset.size <= 0) return []
    const platform = PLATFORMS.find((value) => value === match[1])
    const arch = ARCHITECTURES.find((value) => value === match[2])
    if (platform === undefined || arch === undefined) return []
    return [{ platform, arch, name: asset.name, size: asset.size, sha256, urls: [asset.browser_download_url] }]
  })

/** The same installer from both sources: the mirror goes first, GitHub stays as the fallback. */
const mergeDownloads = (mirror: readonly ProductDownload[], github: readonly ProductDownload[]): ProductDownload[] => {
  const byName = new Map(github.map((download) => [download.name, download]))
  const merged = mirror.map((download) => {
    const other = byName.get(download.name)
    byName.delete(download.name)
    if (other === undefined) return download
    // Two sources disagreeing on the content: trust neither copy of the mirror.
    if (other.sha256 !== download.sha256 || other.size !== download.size) return other
    return { ...download, urls: [...download.urls, ...other.urls] }
  })
  return [...merged, ...byName.values()]
}

export interface ProductUpdatesOptions {
  readonly releaseId: string
  /** `owner/name` on GitHub. */
  readonly repository: string
  readonly settings: {
    get(key: string): { readonly value: JsonValue; readonly revision: number } | undefined
    put(key: string, value: JsonValue, expectedRevision: number | undefined): void
  }
  /** Community site that mirrors the installers for those who cannot reach GitHub; omitted, only GitHub is used. */
  readonly mirror?: string
  readonly fetch?: typeof fetch
  readonly now?: () => number
  readonly onChange?: (status: ProductUpdateStatus) => void
}

/**
 * Tells the admin whether a newer release exists on the build's own channel. One anonymous GET to the public GitHub
 * API, cached on the host so every browser and the desktop app share it; nothing about this instance is sent.
 */
export class ProductUpdates {
  readonly #options: ProductUpdatesOptions
  readonly #identity: ReturnType<typeof releaseIdentity>
  readonly #fetch: typeof fetch
  readonly #now: () => number
  #timer: ReturnType<typeof setInterval> | undefined
  #inflight: Promise<ProductUpdateStatus> | undefined
  #result: Pick<ProductUpdateStatus, 'state' | 'latest' | 'checkedAt' | 'error'> = { state: 'unknown' }

  constructor(options: ProductUpdatesOptions) {
    this.#options = options
    this.#identity = releaseIdentity(options.releaseId)
    this.#fetch = options.fetch ?? fetch
    this.#now = options.now ?? Date.now
  }

  get autoCheck(): boolean {
    const value = this.#options.settings.get(SETTING_KEY)?.value
    return !(typeof value === 'object' && value !== null && !Array.isArray(value) && value['autoCheck'] === false)
  }

  setAutoCheck(autoCheck: boolean): ProductUpdateStatus {
    const current = this.#options.settings.get(SETTING_KEY)
    this.#options.settings.put(SETTING_KEY, { autoCheck }, current?.revision)
    if (autoCheck) this.start()
    else this.#stopTimer()
    return this.status()
  }

  status(): ProductUpdateStatus {
    const identity = this.#identity
    return {
      channel: identity.channel,
      currentVersion: identity.version,
      ...(identity.commit === undefined ? {} : { currentCommit: identity.commit.slice(0, 7) }),
      autoCheck: this.autoCheck,
      ...(identity.channel === 'development' ? { state: 'unsupported' as const } : this.#result),
    }
  }

  /** Checks now and on an interval while automatic checks are on; development builds never check. */
  start(): void {
    if (this.#identity.channel === 'development' || !this.autoCheck || this.#timer !== undefined) return
    void this.check().catch(() => undefined)
    this.#timer = setInterval(() => void this.check().catch(() => undefined), PRODUCT_UPDATE_INTERVAL_MS)
    this.#timer.unref?.()
  }

  dispose(): void {
    this.#stopTimer()
  }

  check(): Promise<ProductUpdateStatus> {
    if (this.#identity.channel === 'development') return Promise.resolve(this.status())
    this.#inflight ??= this.#check().finally(() => {
      this.#inflight = undefined
    })
    return this.#inflight
  }

  #stopTimer(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer)
    this.#timer = undefined
  }

  async #check(): Promise<ProductUpdateStatus> {
    const checkedAt = this.#now()
    try {
      const preview = this.#identity.channel === 'preview'
      const [github, mirror] = await Promise.allSettled([this.#githubCandidate(), this.#mirrorCandidate()])
      const fromGitHub = github.status === 'fulfilled' ? github.value : undefined
      const fromMirror = mirror.status === 'fulfilled' ? mirror.value : undefined
      const latest = this.#newest(fromGitHub, fromMirror)
      if (latest === undefined) throw github.status === 'rejected' ? github.reason : new Error('没有找到可用的发布。')
      const published = latest.publishedAt === undefined ? {} : { publishedAt: latest.publishedAt }
      const downloads = latest.downloads.length === 0 ? {} : { downloads: [...latest.downloads] }
      if (preview) {
        const current = this.#identity.commit ?? ''
        const commit = latest.commit ?? ''
        const same = commit.startsWith(current) || current.startsWith(commit)
        this.#result = same
          ? { state: 'up-to-date', checkedAt }
          : {
              state: 'available',
              checkedAt,
              latest: {
                version: latest.version,
                commit: commit.slice(0, 7),
                url: latest.url,
                ...published,
                ...downloads,
              },
            }
      } else {
        this.#result = isNewerVersion(latest.version, this.#identity.version)
          ? {
              state: 'available',
              checkedAt,
              latest: { version: latest.version, url: latest.url, ...published, ...downloads },
            }
          : { state: 'up-to-date', checkedAt }
      }
    } catch (error) {
      this.#result = {
        ...this.#result,
        state: this.#result.state === 'available' ? 'available' : 'failed',
        checkedAt,
        error: error instanceof Error ? error.message : String(error),
      }
    }
    const status = this.status()
    this.#options.onChange?.(status)
    return status
  }

  /** The newer of the two views; the same release from both keeps the mirror's installers ahead of GitHub's. */
  #newest(github: ReleaseCandidate | undefined, mirror: ReleaseCandidate | undefined): ReleaseCandidate | undefined {
    if (github === undefined || mirror === undefined) return github ?? mirror
    const same =
      this.#identity.channel === 'preview'
        ? github.commit !== undefined &&
          mirror.commit !== undefined &&
          github.commit.startsWith(mirror.commit.slice(0, 7))
        : github.version === mirror.version
    if (same) return { ...github, downloads: mergeDownloads(mirror.downloads, github.downloads) }
    const mirrorNewer =
      this.#identity.channel === 'preview'
        ? (mirror.publishedAt ?? 0) > (github.publishedAt ?? 0)
        : isNewerVersion(mirror.version, github.version)
    return mirrorNewer ? mirror : github
  }

  async #githubCandidate(): Promise<ReleaseCandidate> {
    const preview = this.#identity.channel === 'preview'
    const release = await this.#release(preview ? 'tags/preview' : 'latest')
    const url = release.html_url ?? `https://github.com/${this.#options.repository}/releases`
    // Preview replaces a rolling release: published_at remains its original publication date.
    const releaseTime = preview ? release.updated_at : release.published_at
    const publishedAt = typeof releaseTime === 'string' ? Date.parse(releaseTime) : Number.NaN
    const published = Number.isFinite(publishedAt) ? { publishedAt } : {}
    const downloads = githubDownloads(release)
    if (preview) {
      const commit = /nxt-preview-commit:([0-9a-f]{7,40})/u.exec(release.body ?? '')?.[1]
      if (commit === undefined) throw new Error('预览版发布页缺少提交信息。')
      const version = release.name?.replace(/^NekroNXT Preview\s+/u, '') ?? 'preview'
      return { version, commit, url, ...published, downloads }
    }
    const tag = release.tag_name ?? ''
    const version = tag.replace(/^v/u, '')
    if (semverParts(version) === undefined) throw new Error(`最新正式版的标签无法识别：${tag}`)
    return { version, url, ...published, downloads }
  }

  async #mirrorCandidate(): Promise<ReleaseCandidate | undefined> {
    const mirror = this.#options.mirror
    if (mirror === undefined) return undefined
    const manifestUrl = new URL(`/api/v1/desktop/${this.#identity.channel}/manifest`, mirror)
    const response = await this.#fetch(manifestUrl, {
      headers: { accept: 'application/json', 'user-agent': 'NekroNXT' },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`社区镜像返回 ${response.status}。`)
    const manifest = MirrorManifestSchema.parse(await response.json())
    if (manifest.channel !== this.#identity.channel) throw new Error('社区镜像的发布通道不一致。')
    return {
      version: manifest.releaseVersion,
      commit: manifest.commit,
      url: manifest.releaseUrl,
      publishedAt: manifest.publishedAt,
      downloads: manifest.files.map(({ path, ...file }) => ({ ...file, urls: [new URL(path, manifestUrl).href] })),
    }
  }

  async #release(path: string): Promise<GitHubRelease> {
    const response = await this.#fetch(`https://api.github.com/repos/${this.#options.repository}/releases/${path}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'NekroNXT' },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`GitHub 返回 ${response.status}。`)
    return GitHubReleaseSchema.parse(await response.json())
  }
}
