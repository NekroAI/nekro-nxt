import type { JsonValue, ProductUpdateStatus } from '@nekro-nxt/contracts'
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
    body: z.string().nullable().optional(),
  })
  .loose()

type GitHubRelease = z.output<typeof GitHubReleaseSchema>

export interface ProductUpdatesOptions {
  readonly releaseId: string
  /** `owner/name` on GitHub. */
  readonly repository: string
  readonly settings: {
    get(key: string): { readonly value: JsonValue; readonly revision: number } | undefined
    put(key: string, value: JsonValue, expectedRevision: number | undefined): void
  }
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
      const release = await this.#release(this.#identity.channel === 'preview' ? 'tags/preview' : 'latest')
      const url = release.html_url ?? `https://github.com/${this.#options.repository}/releases`
      const publishedAt = typeof release.published_at === 'string' ? Date.parse(release.published_at) : Number.NaN
      const published = Number.isFinite(publishedAt) ? { publishedAt } : {}
      if (this.#identity.channel === 'preview') {
        const body = release.body ?? ''
        const commit = /nxt-preview-commit:([0-9a-f]{7,40})/u.exec(body)?.[1]
        if (commit === undefined) throw new Error('预览版发布页缺少提交信息。')
        const name = release.name?.replace(/^NekroNXT Preview\s+/u, '') ?? 'preview'
        const current = this.#identity.commit ?? ''
        const same = commit.startsWith(current) || current.startsWith(commit)
        this.#result = same
          ? { state: 'up-to-date', checkedAt }
          : { state: 'available', checkedAt, latest: { version: name, commit: commit.slice(0, 7), url, ...published } }
      } else {
        const tag = release.tag_name ?? ''
        const version = tag.replace(/^v/u, '')
        if (semverParts(version) === undefined) throw new Error(`最新正式版的标签无法识别：${tag}`)
        this.#result = isNewerVersion(version, this.#identity.version)
          ? { state: 'available', checkedAt, latest: { version, url, ...published } }
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

  async #release(path: string): Promise<GitHubRelease> {
    const response = await this.#fetch(`https://api.github.com/repos/${this.#options.repository}/releases/${path}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'NekroNXT' },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`GitHub 返回 ${response.status}。`)
    return GitHubReleaseSchema.parse(await response.json())
  }
}
