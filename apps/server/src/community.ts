import {
  CommunityAccountSchema,
  CommunityExtensionDetailSchema,
  CommunityExtensionSummarySchema,
  CommunityReviewStatusSchema,
  parseJsonValue,
  type CommunityAccount,
  type CommunityExtensionDetail,
  type CommunityExtensionSummary,
  type CommunityStatus,
  type JsonValue,
} from '@nekro-nxt/contracts'
import type { SystemSettingRecord } from '@nekro-nxt/storage-sqlite'
import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { LocalCredentialStore } from './credentials.js'

/** 正式社区。测试时用 `NEKRO_COMMUNITY_URL` 指向测试站或本地开发服务。 */
export const DEFAULT_COMMUNITY_URL = 'https://nxt.nekro.ai'
export const COMMUNITY_CALLBACK_PATH = '/community/callback'

const ACCOUNT_SETTING_KEY = 'community.account'
const LOGIN_TTL_MS = 10 * 60_000
const MAX_PENDING_LOGINS = 16
const REQUEST_TIMEOUT_MS = 30_000
const PACKAGE_TIMEOUT_MS = 120_000
const MAX_PACKAGE_BYTES = 16 * 1024 * 1024
const MAX_JSON_BYTES = 4 * 1024 * 1024

interface CommunitySettingsRepository {
  getSystemSetting(key: string): SystemSettingRecord | undefined
  putSystemSetting(
    key: string,
    value: JsonValue,
    expectedRevision: number | undefined,
    updatedAt: number,
  ): SystemSettingRecord
}

const StoredAccountSchema = z
  .object({
    version: z.literal(1),
    communityUrl: z.string().url(),
    account: CommunityAccountSchema,
    refreshTokenRef: z.string().min(1),
    signedInAt: z.number().int(),
  })
  .strict()
type StoredAccount = z.output<typeof StoredAccountSchema>

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.literal('Bearer'),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1),
  user: z.object({ handle: z.string(), displayName: z.string(), avatarUrl: z.string().nullable() }).passthrough(),
})

const OAuthErrorSchema = z.object({ error_description: z.string() }).passthrough()
const ApiErrorSchema = z.object({ error: z.object({ message: z.string() }).passthrough() }).passthrough()

/** 社区返回的出错格式：开放接口为 `{ error: { message } }`，授权接口为 `{ error_description }`。 */
const communityErrorMessage = (body: unknown, status: number): string => {
  const oauth = OAuthErrorSchema.safeParse(body)
  if (oauth.success) return oauth.data.error_description
  const api = ApiErrorSchema.safeParse(body)
  return api.success ? api.data.error.message : `社区返回 ${status}。`
}

export class CommunityError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = 'community-request-failed',
  ) {
    super(message)
  }
}

const base64Url = (bytes: Buffer): string => bytes.toString('base64url')

export const normalizeCommunityUrl = (raw: string | undefined): string => {
  const value = raw?.trim() || DEFAULT_COMMUNITY_URL
  const url = new URL(value)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new TypeError('社区地址必须使用 HTTPS（本机开发地址除外）。')
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new TypeError('社区地址只能包含协议、主机与端口。')
  }
  return url.origin
}

/** 授权完成后回到浏览器正在访问本实例的地址；只接受 http(s) 来源，不含路径。 */
export const normalizeReturnOrigin = (raw: string): string => {
  const url = new URL(raw)
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    throw new TypeError('回跳地址无效。')
  }
  return url.origin
}

type FetchLike = typeof fetch

interface PendingLogin {
  readonly verifier: string
  readonly redirectUri: string
  readonly expiresAt: number
}

/**
 * NekroNXT 实例与社区之间的唯一通道：登录（授权码 + PKCE）、令牌轮换、公开目录代理、扩展包下载与发布。
 * 刷新令牌保存在本机凭据存储，账号资料与凭据引用保存在系统设置；访问令牌只在内存中。
 */
export class CommunityService {
  readonly communityUrl: string
  readonly #repository: CommunitySettingsRepository
  readonly #credentials: LocalCredentialStore
  readonly #fetch: FetchLike
  readonly #now: () => number
  readonly #instanceName: string
  readonly #pending = new Map<string, PendingLogin>()
  #access: { readonly token: string; readonly expiresAt: number } | undefined
  #refreshing: Promise<string> | undefined

  constructor(
    repository: CommunitySettingsRepository,
    credentials: LocalCredentialStore,
    options: {
      readonly communityUrl?: string | undefined
      readonly instanceName?: string
      readonly fetch?: FetchLike
      readonly now?: () => number
    } = {},
  ) {
    this.#repository = repository
    this.#credentials = credentials
    this.communityUrl = normalizeCommunityUrl(options.communityUrl)
    this.#instanceName = options.instanceName ?? 'NekroNXT'
    this.#fetch = options.fetch ?? fetch
    this.#now = options.now ?? Date.now
  }

  #stored(): { readonly value: StoredAccount; readonly revision: number } | undefined {
    const record = this.#repository.getSystemSetting(ACCOUNT_SETTING_KEY)
    const parsed = StoredAccountSchema.safeParse(record?.value)
    // 登录属于某一个社区；切换社区地址后旧登录不再使用。
    if (!record || !parsed.success || parsed.data.communityUrl !== this.communityUrl) return undefined
    return { value: parsed.data, revision: record.revision }
  }

  status(): CommunityStatus {
    const stored = this.#stored()
    return {
      communityUrl: this.communityUrl,
      account: stored?.value.account ?? null,
      signedInAt: stored?.value.signedInAt ?? null,
    }
  }

  startLogin(returnOrigin: string): string {
    const now = this.#now()
    for (const [state, pending] of this.#pending) if (pending.expiresAt <= now) this.#pending.delete(state)
    if (this.#pending.size >= MAX_PENDING_LOGINS) {
      const oldest = this.#pending.keys().next().value
      if (oldest !== undefined) this.#pending.delete(oldest)
    }
    const verifier = base64Url(randomBytes(48))
    const state = base64Url(randomBytes(32))
    const redirectUri = `${normalizeReturnOrigin(returnOrigin)}${COMMUNITY_CALLBACK_PATH}`
    this.#pending.set(state, { verifier, redirectUri, expiresAt: now + LOGIN_TTL_MS })
    const url = new URL('/oauth/authorize', this.communityUrl)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('code_challenge_method', 'S256')
    url.searchParams.set('code_challenge', base64Url(createHash('sha256').update(verifier).digest()))
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('state', state)
    url.searchParams.set('instance_name', this.#instanceName)
    return url.toString()
  }

  /** 社区回跳。state 只能使用一次；用户在社区拒绝授权时只清理本次登录。 */
  async completeLogin(params: URLSearchParams): Promise<CommunityAccount> {
    const state = params.get('state') ?? ''
    const pending = this.#pending.get(state)
    this.#pending.delete(state)
    if (!pending || pending.expiresAt <= this.#now()) {
      throw new CommunityError(400, '登录已过期，请回到 NekroNXT 重新登录社区。', 'community-login-expired')
    }
    if (params.get('error') === 'access_denied') {
      throw new CommunityError(400, '你在社区拒绝了这次授权。', 'community-login-denied')
    }
    const code = params.get('code')
    if (!code) throw new CommunityError(400, '社区没有返回授权码。', 'community-login-failed')
    const tokens = await this.#tokenRequest({
      grant_type: 'authorization_code',
      code,
      code_verifier: pending.verifier,
      redirect_uri: pending.redirectUri,
    })
    const account = CommunityAccountSchema.parse({
      handle: tokens.user.handle,
      displayName: tokens.user.displayName,
      avatarUrl: tokens.user.avatarUrl,
    })
    const previous = this.#stored()
    const reference = await this.#credentials.save(tokens.refresh_token)
    try {
      this.#repository.putSystemSetting(
        ACCOUNT_SETTING_KEY,
        parseJsonValue({
          version: 1,
          communityUrl: this.communityUrl,
          account,
          refreshTokenRef: reference,
          signedInAt: this.#now(),
        } satisfies StoredAccount),
        this.#repository.getSystemSetting(ACCOUNT_SETTING_KEY)?.revision,
        this.#now(),
      )
    } catch (error) {
      await this.#credentials.delete(reference)
      throw error
    }
    if (previous) await this.#credentials.delete(previous.value.refreshTokenRef)
    this.#access = { token: tokens.access_token, expiresAt: this.#now() + tokens.expires_in * 1000 }
    return account
  }

  /** 本机退出并尽力在社区撤销授权；社区不可达时仍完成本机退出。 */
  async logout(): Promise<CommunityStatus> {
    const stored = this.#stored()
    this.#access = undefined
    if (stored) {
      try {
        const refreshToken = await this.#credentials.resolve(stored.value.refreshTokenRef)
        await this.#fetch(new URL('/oauth/revoke', this.communityUrl), {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: refreshToken }).toString(),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
      } catch {
        // 撤销是尽力而为；本机凭据仍会删除。
      }
      await this.#forget(stored)
    }
    return this.status()
  }

  async #forget(stored: { readonly value: StoredAccount; readonly revision: number }): Promise<void> {
    this.#repository.putSystemSetting(ACCOUNT_SETTING_KEY, null, stored.revision, this.#now())
    await this.#credentials.delete(stored.value.refreshTokenRef)
    this.#access = undefined
  }

  async #tokenRequest(form: Record<string, string>): Promise<z.output<typeof TokenResponseSchema>> {
    const response = await this.#request(new URL('/oauth/token', this.communityUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
    })
    const body = await this.#json(response)
    if (!response.ok) {
      throw new CommunityError(
        response.status === 400 ? 401 : 502,
        communityErrorMessage(body, response.status),
        response.status === 400 ? 'community-auth-invalid' : 'community-request-failed',
      )
    }
    return TokenResponseSchema.parse(body)
  }

  /** 有效的访问令牌；过期前一分钟用刷新令牌轮换，并发请求共享同一次刷新。 */
  async #accessToken(): Promise<string> {
    if (this.#access && this.#access.expiresAt - 60_000 > this.#now()) return this.#access.token
    this.#refreshing ??= this.#refresh().finally(() => {
      this.#refreshing = undefined
    })
    return this.#refreshing
  }

  async #refresh(): Promise<string> {
    const stored = this.#stored()
    if (!stored) throw new CommunityError(401, '请先在「设置 → 社区账号」登录社区。', 'community-signed-out')
    const refreshToken = await this.#credentials.resolve(stored.value.refreshTokenRef)
    let tokens: z.output<typeof TokenResponseSchema>
    try {
      tokens = await this.#tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken })
    } catch (error) {
      if (error instanceof CommunityError && error.code === 'community-auth-invalid') {
        await this.#forget(stored)
        throw new CommunityError(401, '社区登录已失效，请重新登录。', 'community-signed-out')
      }
      throw error
    }
    const reference = await this.#credentials.save(tokens.refresh_token)
    try {
      this.#repository.putSystemSetting(
        ACCOUNT_SETTING_KEY,
        parseJsonValue({
          ...stored.value,
          account: CommunityAccountSchema.parse({
            handle: tokens.user.handle,
            displayName: tokens.user.displayName,
            avatarUrl: tokens.user.avatarUrl,
          }),
          refreshTokenRef: reference,
        } satisfies StoredAccount),
        stored.revision,
        this.#now(),
      )
    } catch (error) {
      await this.#credentials.delete(reference)
      throw error
    }
    await this.#credentials.delete(stored.value.refreshTokenRef)
    this.#access = { token: tokens.access_token, expiresAt: this.#now() + tokens.expires_in * 1000 }
    return tokens.access_token
  }

  async #request(url: URL, init: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
    try {
      return await this.#fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) })
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError'
      throw new CommunityError(502, timedOut ? '连接社区超时，请稍后再试。' : '无法连接社区，请检查网络后再试。')
    }
  }

  async #json(response: Response): Promise<unknown> {
    const length = Number(response.headers.get('content-length') ?? 0)
    if (length > MAX_JSON_BYTES) throw new CommunityError(502, '社区返回的数据过大。')
    const text = await response.text()
    if (text.length > MAX_JSON_BYTES) throw new CommunityError(502, '社区返回的数据过大。')
    try {
      return text ? JSON.parse(text) : null
    } catch {
      throw new CommunityError(502, '社区返回了无法识别的内容。')
    }
  }

  async #api(path: string, init: RequestInit = {}, authenticated = false): Promise<unknown> {
    const headers = new Headers(init.headers)
    headers.set('accept', 'application/json')
    if (authenticated) headers.set('authorization', `Bearer ${await this.#accessToken()}`)
    const response = await this.#request(new URL(path, this.communityUrl), { ...init, headers })
    const body = await this.#json(response)
    if (!response.ok) {
      if (response.status === 401 && authenticated) this.#access = undefined
      throw new CommunityError(
        response.status === 404 ? 404 : response.status === 401 ? 401 : 400,
        communityErrorMessage(body, response.status),
        response.status === 404 ? 'community-not-found' : 'community-request-failed',
      )
    }
    return body
  }

  #extensionPage(id: string): string {
    return new URL(`/extensions/${encodeURIComponent(id)}`, this.communityUrl).toString()
  }

  #summary(raw: unknown): CommunityExtensionSummary {
    return CommunityExtensionSummarySchema.parse(normalizeSummary(raw, this.#extensionPage.bind(this)))
  }

  async listExtensions(input: {
    readonly query?: string | undefined
    readonly scope?: string | undefined
    readonly cursor?: string | undefined
  }): Promise<{ readonly items: CommunityExtensionSummary[]; readonly nextCursor: string | null }> {
    const search = new URLSearchParams({ limit: '30' })
    if (input.query) search.set('q', input.query)
    if (input.scope) search.set('scope', input.scope)
    if (input.cursor) search.set('cursor', input.cursor)
    const body = z
      .object({ items: z.array(z.unknown()), nextCursor: z.string().nullable() })
      .parse(await this.#api(`/api/v1/extensions?${search.toString()}`))
    return { items: body.items.map((item) => this.#summary(item)), nextCursor: body.nextCursor }
  }

  async getExtension(extensionId: string): Promise<CommunityExtensionDetail> {
    const raw = await this.#api(`/api/v1/extensions/${encodeURIComponent(extensionId)}`)
    const record = asRecord(raw)
    const review = asRecord(record['review'])
    return CommunityExtensionDetailSchema.parse({
      ...normalizeSummary(raw, this.#extensionPage.bind(this)),
      description: typeof record['description'] === 'string' ? record['description'] : '',
      sourceUrl: typeof record['sourceUrl'] === 'string' ? record['sourceUrl'] : null,
      review:
        record['review'] === null || record['review'] === undefined
          ? null
          : {
              status: review['status'],
              grade: review['grade'] ?? null,
              summary: typeof review['summary'] === 'string' ? review['summary'] : null,
              highlights: (Array.isArray(review['highlights']) ? review['highlights'] : [])
                .slice(0, 16)
                .map((item) => ({ severity: asRecord(item)['severity'], title: asRecord(item)['title'] })),
            },
    })
  }

  /**
   * 下载一次发布：先读社区的发布记录拿到包摘要，再下载并比对 SHA-256 与大小。摘要不一致时拒绝，
   * 之后仍由本地导入检查完整校验包内容。
   */
  async downloadRelease(releaseId: string): Promise<Uint8Array> {
    const release = z
      .object({ packageSha256: z.string().regex(/^[a-f0-9]{64}$/u), packageSize: z.number().int().positive() })
      .passthrough()
      .parse(await this.#api(`/api/v1/releases/${encodeURIComponent(releaseId)}`))
    if (release.packageSize > MAX_PACKAGE_BYTES) throw new CommunityError(400, '扩展包超过 16 MiB，无法导入。')
    const response = await this.#request(
      new URL(`/api/v1/releases/${encodeURIComponent(releaseId)}/package`, this.communityUrl),
      { headers: { 'x-nxt-install': '1' } },
      PACKAGE_TIMEOUT_MS,
    )
    if (!response.ok) {
      throw new CommunityError(
        response.status === 404 ? 404 : 502,
        communityErrorMessage(await this.#json(response), response.status),
      )
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (
      bytes.byteLength !== release.packageSize ||
      createHash('sha256').update(bytes).digest('hex') !== release.packageSha256
    ) {
      throw new CommunityError(502, '下载的扩展包与社区记录不一致，已停止导入。')
    }
    return bytes
  }

  async publish(input: { readonly filename: string; readonly body: Uint8Array; readonly notes: string }): Promise<{
    readonly releaseId: string
    readonly number: number
    readonly reviewStatus: z.output<typeof CommunityReviewStatusSchema>
    readonly pageUrl: string
    readonly reportUrl: string
    readonly findings: readonly { readonly severity: string; readonly title: string }[]
  }> {
    const form = new FormData()
    form.set('package', new Blob([Uint8Array.from(input.body)], { type: 'application/zip' }), input.filename)
    form.set('notes', input.notes)
    const body = z
      .object({
        extension: z.object({ id: z.string() }).passthrough(),
        release: z
          .object({ id: z.string(), number: z.number().int(), reviewStatus: CommunityReviewStatusSchema })
          .passthrough(),
        findings: z.array(z.object({ severity: z.string(), title: z.string() }).passthrough()),
      })
      .parse(await this.#api('/api/v1/releases', { method: 'POST', body: form }, true))
    return {
      releaseId: body.release.id,
      number: body.release.number,
      reviewStatus: body.release.reviewStatus,
      pageUrl: this.#extensionPage(body.extension.id),
      reportUrl: new URL(`/me/releases/${encodeURIComponent(body.release.id)}`, this.communityUrl).toString(),
      findings: body.findings.map((finding) => ({ severity: finding.severity, title: finding.title })),
    }
  }
}

const RecordSchema = z.record(z.string(), z.unknown())

const asRecord = (value: unknown): Record<string, unknown> => {
  const parsed = RecordSchema.safeParse(value)
  return parsed.success && !Array.isArray(value) ? parsed.data : {}
}

/** 只取 NXT 需要的字段；社区新增字段不透传。 */
const normalizeSummary = (raw: unknown, pageUrl: (id: string) => string): Record<string, unknown> => {
  const record = asRecord(raw)
  const publisher = asRecord(record['publisher'])
  const latest = record['latest'] === null || record['latest'] === undefined ? null : asRecord(record['latest'])
  return {
    id: record['id'],
    scope: record['scope'],
    displayName: record['displayName'],
    summary: record['summary'],
    tags: record['tags'],
    publisher: {
      handle: publisher['handle'],
      displayName: publisher['displayName'],
      avatarUrl: publisher['avatarUrl'] ?? null,
    },
    latest:
      latest === null
        ? null
        : {
            id: latest['id'],
            number: latest['number'],
            reviewStatus: latest['reviewStatus'],
            grade: latest['grade'] ?? null,
            permissions: (Array.isArray(latest['permissions']) ? latest['permissions'] : []).map((item) => {
              const permission = asRecord(item)
              return {
                key: permission['key'],
                level: permission['level'],
                label: permission['label'],
                ...(typeof permission['detail'] === 'string' ? { detail: permission['detail'] } : {}),
              }
            }),
            packageSize: latest['packageSize'],
            requiresSdk: latest['requiresSdk'] ?? null,
            notes: latest['notes'] ?? '',
            createdAt: latest['createdAt'],
          },
    downloads: record['downloads'],
    updatedAt: record['updatedAt'],
    pageUrl: typeof record['id'] === 'string' ? pageUrl(record['id']) : '',
  }
}
