import {
  CommunityAccountSchema,
  CommunityExtensionDetailSchema,
  CommunityExtensionSummarySchema,
  type CommunityListingInput,
  CommunityMyExtensionSchema,
  CommunityPermissionItemSchema,
  CommunityReleaseSchema,
  CommunityReviewReportSchema,
  CommunityReviewStatusSchema,
  parseJsonValue,
  type CommunityAccount,
  type CommunityEndpoint,
  type CommunityExtensionDetail,
  type CommunityExtensionSummary,
  type CommunityInstalledItem,
  type CommunityMyExtension,
  type CommunityReviewReport,
  type CommunitySource,
  type CommunityStatus,
  type ExtensionId,
  type JsonValue,
} from '@nekro-nxt/contracts'
import type { SystemSettingRecord } from '@nekro-nxt/storage-sqlite'
import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { LocalCredentialStore } from './credentials.js'

/** 正式社区。测试时用 `NEKRO_COMMUNITY_URL` 指向测试站或本地开发服务。 */
export const DEFAULT_COMMUNITY_URL = 'https://nxt.nekro.ai'
export const COMMUNITY_CALLBACK_PATH = '/community/callback'

const ENDPOINT_SETTING_KEY = 'community.endpoint'
const ACCOUNTS_SETTING_KEY = 'community.accounts'
/** 早期版本只保存一个社区的登录；读取时迁移到按地址保存的结构。 */
const LEGACY_ACCOUNT_SETTING_KEY = 'community.account'
const META_TTL_MS = 5 * 60_000
const META_TIMEOUT_MS = 5_000
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60_000
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

const AccountEntrySchema = z
  .object({ account: CommunityAccountSchema, refreshTokenRef: z.string().min(1), signedInAt: z.number().int() })
  .strict()
type AccountEntry = z.output<typeof AccountEntrySchema>

const StoredAccountsSchema = z
  .object({ version: z.literal(2), accounts: z.record(z.string(), AccountEntrySchema) })
  .strict()

const LegacyAccountSchema = AccountEntrySchema.extend({ version: z.literal(1), communityUrl: z.string() }).strict()

const StoredEndpointSchema = z.object({ version: z.literal(1), url: z.string(), allowInsecure: z.boolean() }).strict()

const MetaSchema = z
  .object({ name: z.string(), environment: z.enum(['production', 'staging', 'development']), version: z.string() })
  .passthrough()
type CommunityMeta = z.output<typeof MetaSchema>

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

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** 局域网地址：私有 IPv4 段、`.local`/`.lan` 主机名与不带点的主机名。 */
const isPrivateNetworkHost = (hostname: string): boolean => {
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/u.exec(hostname)
  if (ipv4) {
    const [first, second] = [Number(ipv4[1]), Number(ipv4[2])]
    return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168)
  }
  return !hostname.includes('.') || hostname.endsWith('.local') || hostname.endsWith('.lan')
}

/**
 * 校验社区地址并返回其来源（origin）。HTTPS 与本机 HTTP 直接接受；局域网 HTTP 供团队调试，需要确认风险，
 * 因为扩展包会经未加密的网络下载；其他 HTTP 地址一律拒绝。
 */
export const inspectCommunityUrl = (
  raw: string,
  options: { readonly allowInsecure?: boolean } = {},
): { readonly origin: string; readonly insecure: boolean } => {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new CommunityError(400, '社区地址无效，请填写完整地址，例如 https://nxt.nekro.ai。', 'community-url-invalid')
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new CommunityError(400, '社区地址只能包含协议、主机与端口。', 'community-url-invalid')
  }
  if (url.protocol === 'https:') return { origin: url.origin, insecure: false }
  if (url.protocol !== 'http:') throw new CommunityError(400, '社区地址只支持 HTTPS 或 HTTP。', 'community-url-invalid')
  if (LOOPBACK_HOSTS.has(url.hostname)) return { origin: url.origin, insecure: false }
  if (!isPrivateNetworkHost(url.hostname)) {
    throw new CommunityError(400, '公网社区地址必须使用 HTTPS。', 'community-url-invalid')
  }
  if (!options.allowInsecure) {
    throw new CommunityError(
      400,
      '这是未加密的局域网地址，扩展包会以明文下载。确认风险后才能使用。',
      'community-url-insecure',
    )
  }
  return { origin: url.origin, insecure: true }
}

export const normalizeCommunityUrl = (raw: string | undefined): string =>
  inspectCommunityUrl(raw?.trim() || DEFAULT_COMMUNITY_URL, { allowInsecure: true }).origin

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
  readonly #environmentUrl: string | null
  readonly #repository: CommunitySettingsRepository
  readonly #credentials: LocalCredentialStore
  readonly #fetch: FetchLike
  readonly #now: () => number
  readonly #instanceName: string
  readonly #pending = new Map<string, PendingLogin>()
  #access: { readonly url: string; readonly token: string; readonly expiresAt: number } | undefined
  readonly #meta = new Map<string, { readonly value: CommunityMeta | null; readonly expiresAt: number }>()
  #installed: { readonly url: string; readonly checkedAt: number; readonly items: CommunityInstalledItem[] } | undefined
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
    // 环境变量由部署者设置，局域网 HTTP 视为已确认；格式错误时启动即失败。
    this.#environmentUrl = options.communityUrl?.trim() ? normalizeCommunityUrl(options.communityUrl) : null
    this.#instanceName = options.instanceName ?? 'NekroNXT'
    this.#fetch = options.fetch ?? fetch
    this.#now = options.now ?? Date.now
  }

  #storedEndpoint(): z.output<typeof StoredEndpointSchema> | undefined {
    const parsed = StoredEndpointSchema.safeParse(this.#repository.getSystemSetting(ENDPOINT_SETTING_KEY)?.value)
    return parsed.success ? parsed.data : undefined
  }

  /** 当前社区地址：界面设置 > 环境变量 `NEKRO_COMMUNITY_URL` > 正式社区。 */
  get communityUrl(): string {
    return this.#storedEndpoint()?.url ?? this.#environmentUrl ?? DEFAULT_COMMUNITY_URL
  }

  endpoint(): CommunityEndpoint {
    const stored = this.#storedEndpoint()
    const url = this.communityUrl
    return {
      url,
      source: stored ? 'setting' : this.#environmentUrl ? 'environment' : 'default',
      defaultUrl: DEFAULT_COMMUNITY_URL,
      environmentUrl: this.#environmentUrl,
      insecure: inspectCommunityUrl(url, { allowInsecure: true }).insecure,
    }
  }

  /** 修改社区地址。登录按地址分别保存，切换后再切回无需重新登录。 */
  setEndpoint(url: string | null, acknowledgeInsecure: boolean): CommunityEndpoint {
    const record = this.#repository.getSystemSetting(ENDPOINT_SETTING_KEY)
    if (url === null) {
      // 设置值不能为 NULL：写入空对象，读取时不符合结构即视为未设置。
      if (record) this.#repository.putSystemSetting(ENDPOINT_SETTING_KEY, {}, record.revision, this.#now())
    } else {
      const { origin, insecure } = inspectCommunityUrl(url, { allowInsecure: acknowledgeInsecure })
      this.#repository.putSystemSetting(
        ENDPOINT_SETTING_KEY,
        parseJsonValue({ version: 1, url: origin, allowInsecure: insecure }),
        record?.revision,
        this.#now(),
      )
    }
    this.#pending.clear()
    this.#installed = undefined
    return this.endpoint()
  }

  async testEndpoint(
    url: string,
    acknowledgeInsecure: boolean,
  ): Promise<{ ok: boolean; message: string; name?: string; environment?: CommunityMeta['environment'] }> {
    const { origin } = inspectCommunityUrl(url, { allowInsecure: acknowledgeInsecure })
    const meta = await this.#fetchMeta(origin)
    if (!meta) return { ok: false, message: '无法连接这个地址，或它不是 NekroNXT 社区。' }
    return { ok: true, message: `已连接「${meta.name}」。`, name: meta.name, environment: meta.environment }
  }

  async #fetchMeta(origin: string): Promise<CommunityMeta | null> {
    try {
      const response = await this.#fetch(new URL('/api/v1/meta', origin), {
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(META_TIMEOUT_MS),
      })
      if (!response.ok) return null
      const parsed = MetaSchema.safeParse(await response.json())
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }

  /** 社区自我描述，按地址缓存 5 分钟；连接失败也缓存，避免每次读取状态都等待超时。 */
  async meta(): Promise<CommunityMeta | null> {
    const url = this.communityUrl
    const cached = this.#meta.get(url)
    if (cached && cached.expiresAt > this.#now()) return cached.value
    const value = await this.#fetchMeta(url)
    this.#meta.set(url, { value, expiresAt: this.#now() + META_TTL_MS })
    return value
  }

  #accounts(): { readonly accounts: Record<string, AccountEntry>; readonly revision: number | undefined } {
    const record = this.#repository.getSystemSetting(ACCOUNTS_SETTING_KEY)
    const parsed = StoredAccountsSchema.safeParse(record?.value)
    if (parsed.success) return { accounts: parsed.data.accounts, revision: record?.revision }
    const legacyRecord = this.#repository.getSystemSetting(LEGACY_ACCOUNT_SETTING_KEY)
    const legacy = LegacyAccountSchema.safeParse(legacyRecord?.value)
    if (!legacy.success || !legacyRecord) return { accounts: {}, revision: record?.revision }
    const { communityUrl, account, refreshTokenRef, signedInAt } = legacy.data
    const accounts = { [communityUrl]: { account, refreshTokenRef, signedInAt } }
    const written = this.#repository.putSystemSetting(
      ACCOUNTS_SETTING_KEY,
      parseJsonValue({ version: 2, accounts }),
      record?.revision,
      this.#now(),
    )
    this.#repository.putSystemSetting(LEGACY_ACCOUNT_SETTING_KEY, {}, legacyRecord.revision, this.#now())
    return { accounts, revision: written.revision }
  }

  #stored(url = this.communityUrl): AccountEntry | undefined {
    return this.#accounts().accounts[url]
  }

  #writeAccount(url: string, entry: AccountEntry | null): void {
    const { accounts, revision } = this.#accounts()
    const next = { ...accounts }
    if (entry === null) delete next[url]
    else next[url] = entry
    this.#repository.putSystemSetting(
      ACCOUNTS_SETTING_KEY,
      parseJsonValue({ version: 2, accounts: next }),
      revision,
      this.#now(),
    )
  }

  async status(): Promise<CommunityStatus> {
    const url = this.communityUrl
    const stored = this.#stored(url)
    const meta = await this.meta()
    const installed = this.#installed?.url === url ? this.#installed.items : []
    return {
      communityUrl: url,
      environment: meta?.environment ?? null,
      account: stored?.account ?? null,
      signedInAt: stored?.signedInAt ?? null,
      updatesAvailable: installed.filter((item) => item.updateAvailable).length,
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
    const url = this.communityUrl
    const previous = this.#stored(url)
    const reference = await this.#credentials.save(tokens.refresh_token)
    try {
      this.#writeAccount(url, { account, refreshTokenRef: reference, signedInAt: this.#now() })
    } catch (error) {
      await this.#credentials.delete(reference)
      throw error
    }
    if (previous) await this.#credentials.delete(previous.refreshTokenRef)
    this.#access = { url, token: tokens.access_token, expiresAt: this.#now() + tokens.expires_in * 1000 }
    return account
  }

  /** 本机退出并尽力在社区撤销授权；社区不可达时仍完成本机退出。 */
  async logout(): Promise<CommunityStatus> {
    const stored = this.#stored()
    this.#access = undefined
    if (stored) {
      try {
        const refreshToken = await this.#credentials.resolve(stored.refreshTokenRef)
        await this.#fetch(new URL('/oauth/revoke', this.communityUrl), {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: refreshToken }).toString(),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
      } catch {
        // 撤销是尽力而为；本机凭据仍会删除。
      }
      await this.#forget(this.communityUrl, stored)
    }
    return this.status()
  }

  async #forget(url: string, stored: AccountEntry): Promise<void> {
    this.#writeAccount(url, null)
    await this.#credentials.delete(stored.refreshTokenRef)
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
    if (this.#access && this.#access.url === this.communityUrl && this.#access.expiresAt - 60_000 > this.#now()) {
      return this.#access.token
    }
    this.#refreshing ??= this.#refresh().finally(() => {
      this.#refreshing = undefined
    })
    return this.#refreshing
  }

  async #refresh(): Promise<string> {
    const url = this.communityUrl
    const stored = this.#stored(url)
    if (!stored) throw new CommunityError(401, '请先在「社区 → 账号」登录社区。', 'community-signed-out')
    const refreshToken = await this.#credentials.resolve(stored.refreshTokenRef)
    let tokens: z.output<typeof TokenResponseSchema>
    try {
      tokens = await this.#tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken })
    } catch (error) {
      if (error instanceof CommunityError && error.code === 'community-auth-invalid') {
        await this.#forget(url, stored)
        throw new CommunityError(401, '社区登录已失效，请重新登录。', 'community-signed-out')
      }
      throw error
    }
    const reference = await this.#credentials.save(tokens.refresh_token)
    try {
      this.#writeAccount(url, {
        account: CommunityAccountSchema.parse({
          handle: tokens.user.handle,
          displayName: tokens.user.displayName,
          avatarUrl: tokens.user.avatarUrl,
        }),
        refreshTokenRef: reference,
        signedInAt: stored.signedInAt,
      })
    } catch (error) {
      await this.#credentials.delete(reference)
      throw error
    }
    await this.#credentials.delete(stored.refreshTokenRef)
    this.#access = { url, token: tokens.access_token, expiresAt: this.#now() + tokens.expires_in * 1000 }
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
    readonly provides?: string | undefined
    readonly official?: '1' | undefined
    readonly cursor?: string | undefined
  }): Promise<{ readonly items: CommunityExtensionSummary[]; readonly nextCursor: string | null }> {
    const search = new URLSearchParams({ limit: '30' })
    if (input.query) search.set('q', input.query)
    if (input.provides) search.set('provides', input.provides)
    if (input.official) search.set('official', input.official)
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

  async publish(input: {
    readonly filename: string
    readonly body: Uint8Array
    readonly notes: string
    readonly listing?: CommunityListingInput | undefined
  }): Promise<{
    readonly releaseId: string
    readonly reviewStatus: z.output<typeof CommunityReviewStatusSchema>
    readonly pageUrl: string
    readonly reportUrl: string
    readonly findings: readonly { readonly severity: string; readonly title: string }[]
  }> {
    const form = new FormData()
    form.set('package', new Blob([Uint8Array.from(input.body)], { type: 'application/zip' }), input.filename)
    form.set('notes', input.notes)
    // 条目信息只提交填写了的字段；社区据此建条目或覆盖对应字段。
    const listing = input.listing
    if (listing?.summary !== undefined) form.set('summary', listing.summary)
    if (listing?.description !== undefined) form.set('description', listing.description)
    if (listing?.tags !== undefined) form.set('tags', JSON.stringify(listing.tags))
    if (listing?.sourceUrl !== undefined) form.set('sourceUrl', listing.sourceUrl)
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
      reviewStatus: body.release.reviewStatus,
      pageUrl: this.#extensionPage(body.extension.id),
      reportUrl: new URL(`/me/releases/${encodeURIComponent(body.release.id)}`, this.communityUrl).toString(),
      findings: body.findings.map((finding) => ({ severity: finding.severity, title: finding.title })),
    }
  }

  /**
   * 已安装扩展的更新检查。每个扩展取最近一次从社区导入的来源；来源与当前社区地址不同的只列出，不检查。
   * 结果缓存到下次检查，供状态中的可更新数量使用。
   */
  async installed(
    sources: readonly {
      readonly extensionId: ExtensionId
      readonly displayName: string
      readonly revisionId: string
      readonly source: CommunitySource
    }[],
  ): Promise<{ readonly checkedAt: number; readonly items: CommunityInstalledItem[] }> {
    const url = this.communityUrl
    const checkable = sources.filter((entry) => entry.source.communityUrl === url)
    const remote = new Map<string, Record<string, unknown>>()
    if (checkable.length > 0) {
      const body = z.object({ items: z.array(z.record(z.string(), z.unknown())) }).parse(
        await this.#api('/api/v1/updates', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            items: checkable.map((entry) => ({ extensionId: entry.extensionId, releaseId: entry.source.releaseId })),
          }),
        }),
      )
      for (const item of body.items) remote.set(`${String(item['extensionId'])}:${String(item['releaseId'])}`, item)
    }
    const items = sources.map((entry): CommunityInstalledItem => {
      const sameCommunity = entry.source.communityUrl === url
      const found = sameCommunity ? remote.get(`${entry.extensionId}:${entry.source.releaseId}`) : undefined
      const latest = found?.['latest'] ? CommunityReleaseSchema.parse(normalizeRelease(found['latest'])) : null
      return {
        extensionId: entry.extensionId,
        displayName: entry.displayName,
        revisionId: entry.revisionId,
        source: entry.source,
        sameCommunity,
        found: found?.['found'] === true,
        delisted: found?.['delisted'] === true,
        delistedReason: typeof found?.['delistedReason'] === 'string' ? found['delistedReason'] : null,
        releaseWithdrawn: found?.['releaseWithdrawn'] === true,
        latest,
        updateAvailable: latest !== null && latest.id !== entry.source.releaseId,
        addedPermissions: (Array.isArray(found?.['addedPermissions']) ? found['addedPermissions'] : []).map((item) =>
          CommunityPermissionItemSchema.parse(normalizePermission(item)),
        ),
      }
    })
    const checkedAt = this.#now()
    this.#installed = { url, checkedAt, items }
    return { checkedAt, items }
  }

  cachedInstalled(): { readonly checkedAt: number; readonly items: CommunityInstalledItem[] } | undefined {
    const cached = this.#installed
    // 缓存里的社区地址只用于判断是否仍属当前社区，不随响应返回。
    return cached?.url === this.communityUrl ? { checkedAt: cached.checkedAt, items: cached.items } : undefined
  }

  async publisherOf(extensionId: string): Promise<string> {
    return (await this.getExtension(extensionId)).publisher.handle
  }

  async mine(): Promise<CommunityMyExtension[]> {
    const body = z.object({ items: z.array(z.unknown()) }).parse(await this.#api('/api/v1/me/extensions', {}, true))
    return body.items.map((raw) => {
      const record = asRecord(raw)
      return CommunityMyExtensionSchema.parse({
        ...normalizeSummary(raw, this.#extensionPage.bind(this)),
        releases: (Array.isArray(record['releases']) ? record['releases'] : []).map((release) => ({
          ...normalizeRelease(release),
          withdrawn: asRecord(release)['withdrawn'] === true,
        })),
        delisted: record['delisted'] === true,
        delistedReason: typeof record['delistedReason'] === 'string' ? record['delistedReason'] : null,
      })
    })
  }

  async review(releaseId: string): Promise<CommunityReviewReport> {
    const raw = asRecord(await this.#api(`/api/v1/releases/${encodeURIComponent(releaseId)}/review`, {}, true))
    const ai = raw['ai'] === null || raw['ai'] === undefined ? null : asRecord(raw['ai'])
    return CommunityReviewReportSchema.parse({
      releaseId: raw['releaseId'],
      status: raw['status'],
      grade: raw['grade'] ?? null,
      deterministic: (Array.isArray(raw['deterministic']) ? raw['deterministic'] : []).map((item) => {
        const finding = asRecord(item)
        return {
          severity: finding['severity'],
          title: finding['title'],
          detail: finding['detail'],
          ...(typeof finding['file'] === 'string' ? { file: finding['file'] } : {}),
          ...(typeof finding['line'] === 'number' ? { line: finding['line'] } : {}),
        }
      }),
      ai:
        ai === null
          ? null
          : {
              summary: ai['summary'],
              verdict: ai['verdict'],
              grade: ai['grade'],
              dimensions: (Array.isArray(ai['dimensions']) ? ai['dimensions'] : []).map((item) => {
                const dimension = asRecord(item)
                return { key: dimension['key'], grade: dimension['grade'], notes: dimension['notes'] }
              }),
              findings: (Array.isArray(ai['findings']) ? ai['findings'] : []).map((item) => {
                const finding = asRecord(item)
                return {
                  dimension: finding['dimension'],
                  severity: finding['severity'],
                  title: finding['title'],
                  detail: finding['detail'],
                  ...(typeof finding['file'] === 'string' ? { file: finding['file'] } : {}),
                  ...(typeof finding['line'] === 'number' ? { line: finding['line'] } : {}),
                  ...(typeof finding['suggestion'] === 'string' ? { suggestion: finding['suggestion'] } : {}),
                }
              }),
              ...(typeof ai['exploitability'] === 'string' ? { exploitability: ai['exploitability'] } : {}),
            },
      model: raw['model'] ?? null,
      error: raw['error'] ?? null,
      decisions: (Array.isArray(raw['decisions']) ? raw['decisions'] : []).map((item) => {
        const decision = asRecord(item)
        return {
          decision: decision['decision'],
          note: decision['note'],
          by: decision['by'],
          createdAt: decision['createdAt'],
        }
      }),
      finishedAt: raw['finishedAt'] ?? null,
      reportUrl: new URL(`/me/releases/${encodeURIComponent(releaseId)}`, this.communityUrl).toString(),
    })
  }

  async requestReview(releaseId: string): Promise<void> {
    await this.#api(`/api/v1/releases/${encodeURIComponent(releaseId)}/review`, { method: 'POST' }, true)
  }

  async withdraw(releaseId: string): Promise<void> {
    await this.#api(`/api/v1/releases/${encodeURIComponent(releaseId)}/withdraw`, { method: 'POST' }, true)
  }

  /** 同一社区通道上的其他资源（如人设）读取开放接口：沿用地址、登录、超时与出错格式。 */
  async apiJson(path: string, init: RequestInit = {}, authenticated = false): Promise<unknown> {
    return this.#api(path, init, authenticated)
  }

  /** 下载一个社区资源（如人设头像），超过上限即停止。 */
  async download(
    path: string,
    maxBytes: number,
  ): Promise<{ readonly bytes: Uint8Array; readonly contentType: string }> {
    const response = await this.#request(new URL(path, this.communityUrl), { headers: { accept: 'image/*' } })
    if (!response.ok) {
      throw new CommunityError(
        response.status === 404 ? 404 : 502,
        response.status === 404 ? '社区上没有这个文件。' : `社区返回 ${response.status}。`,
        response.status === 404 ? 'community-not-found' : 'community-request-failed',
      )
    }
    if (Number(response.headers.get('content-length') ?? 0) > maxBytes) {
      throw new CommunityError(502, '社区返回的文件过大。')
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > maxBytes) throw new CommunityError(502, '社区返回的文件过大。')
    return { bytes, contentType: response.headers.get('content-type') ?? '' }
  }
}

const RecordSchema = z.record(z.string(), z.unknown())

const asRecord = (value: unknown): Record<string, unknown> => {
  const parsed = RecordSchema.safeParse(value)
  return parsed.success && !Array.isArray(value) ? parsed.data : {}
}

const normalizePermission = (raw: unknown): Record<string, unknown> => {
  const permission = asRecord(raw)
  return {
    key: permission['key'],
    level: permission['level'],
    label: permission['label'],
    ...(typeof permission['detail'] === 'string' ? { detail: permission['detail'] } : {}),
  }
}

const normalizeRelease = (raw: unknown): Record<string, unknown> => {
  const release = asRecord(raw)
  return {
    id: release['id'],
    reviewStatus: release['reviewStatus'],
    grade: release['grade'] ?? null,
    permissions: (Array.isArray(release['permissions']) ? release['permissions'] : []).map(normalizePermission),
    packageSize: release['packageSize'],
    requiresSdk: release['requiresSdk'] ?? null,
    notes: release['notes'] ?? '',
    createdAt: release['createdAt'],
  }
}

const httpUrlOrNull = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null
  } catch {
    return null
  }
}

/** 只取 NXT 需要的字段；社区新增字段不透传。 */
const normalizeSummary = (raw: unknown, pageUrl: (id: string) => string): Record<string, unknown> => {
  const record = asRecord(raw)
  const publisher = asRecord(record['publisher'])
  const latest = record['latest'] === null || record['latest'] === undefined ? null : asRecord(record['latest'])
  return {
    id: record['id'],
    // 「提供什么」标签；本机不认识的标签由界面忽略。
    provides: Array.isArray(record['provides'])
      ? record['provides'].filter((item): item is string => typeof item === 'string').slice(0, 8)
      : [],
    displayName: record['displayName'],
    summary: record['summary'],
    tags: record['tags'],
    // 旧版社区没有图标字段；只接受 http(s) 地址。
    iconUrl: httpUrlOrNull(record['iconUrl']),
    // 旧版社区没有这个字段，按非官方处理。
    official: record['official'] === true,
    publisher: {
      handle: publisher['handle'],
      displayName: publisher['displayName'],
      avatarUrl: publisher['avatarUrl'] ?? null,
    },
    latest: latest === null ? null : normalizeRelease(latest),
    downloads: record['downloads'],
    updatedAt: record['updatedAt'],
    pageUrl: typeof record['id'] === 'string' ? pageUrl(record['id']) : '',
  }
}
