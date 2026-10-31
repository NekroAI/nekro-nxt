import {
  CommunityAccountSchema,
  CommunityExtensionDetailSchema,
  CommunityExtensionSummarySchema,
  CommunityRatingSchema,
  type CommunityExtensionSort,
  type CommunityRating,
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
  type CommunityMyExtension,
  type CommunityReviewReport,
  type CommunityStatus,
  type ExtensionId,
  type JsonValue,
  EXTENSION_SDK_LEVEL,
} from '@nekro-nxt/contracts'
import type { SystemSettingRecord } from '@nekro-nxt/storage-sqlite'
import type { CommunityFeedbackIdentity } from '@nekro-nxt/storage-sqlite'
import {
  CommunityFeedbackSchema,
  CommunityFeedbackListSchema,
  CommunityFeedbackChangesSchema,
  type CommunityFeedbackCreate,
} from '@nekro-nxt/contracts'
import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'
import { CommunityReadCache, type CommunityCachedRead } from './community-cache.js'
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
export const FIRST_UPDATE_CHECK_DELAY_MS = 60_000
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
  .object({
    name: z.string(),
    environment: z.enum(['production', 'staging', 'development']),
    version: z.string(),
    features: z.array(z.string()).default([]),
  })
  .passthrough()
type CommunityMeta = z.output<typeof MetaSchema>

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.literal('Bearer'),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1),
  user: z
    .object({
      id: z.string().optional(),
      handle: z.string(),
      displayName: z.string(),
      avatarUrl: z.string().nullable(),
    })
    .passthrough(),
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

/**
 * A community that runs older shared packages than this NekroNXT rejects new capability levels with the shared
 * "please upgrade NekroNXT" text. When the community is the one behind, say so: neither the extension nor this
 * NekroNXT needs to change.
 */
export const explainCommunityLevelRejection = (error: unknown): unknown => {
  if (!(error instanceof CommunityError)) return error
  const match = /扩展能力等级\s*(\d+)[，,]\s*当前为\s*(\d+)/u.exec(error.message)
  if (!match) return error
  const needed = Number(match[1])
  const supported = Number(match[2])
  if (supported >= EXTENSION_SDK_LEVEL || needed > EXTENSION_SDK_LEVEL) return error
  return new CommunityError(
    error.status,
    `社区还不支持这个扩展用到的能力（需要能力等级 ${needed}，社区目前支持到 ${supported}）。等社区更新后再发布，扩展和 NekroNXT 都不用改。`,
    error.code,
  )
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
  readonly communityUrl: string
  readonly generation: number
  readonly verifier: string
  readonly redirectUri: string
  readonly expiresAt: number
}

/**
 * NekroNXT 实例与社区之间的唯一通道：登录（授权码 + PKCE）、令牌轮换、公开目录代理、扩展包下载与发布。
 * 刷新令牌保存在本机凭据存储，账号资料与凭据引用保存在系统设置；访问令牌只在内存中。
 */
/** What the community says about one extension line this machine follows or publishes. */
export interface CommunityUpdateCheck {
  readonly found: boolean
  readonly delisted: boolean
  readonly delistedReason: string | null
  readonly releaseWithdrawn: boolean
  readonly latest: z.output<typeof CommunityReleaseSchema> | null
  readonly addedPermissions: z.output<typeof CommunityPermissionItemSchema>[]
}

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
  /** Extensions with something to do after the last sync check, for the navigation badge; per community address. */
  #attention: { readonly url: string; readonly count: number } | undefined
  readonly #reads: CommunityReadCache
  #authGeneration = 0
  #refreshing: { readonly generation: number; readonly promise: Promise<string> } | undefined

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
    this.#reads = new CommunityReadCache({
      now: this.#now,
      isGone: (error) => error instanceof CommunityError && error.code === 'community-not-found',
    })
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
    this.#invalidateAuth()
    this.#attention = undefined
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
    return {
      communityUrl: url,
      environment: meta?.environment ?? null,
      ...(meta?.features.length ? { features: meta.features } : {}),
      account: stored?.account ?? null,
      signedInAt: stored?.signedInAt ?? null,
      updatesAvailable: this.#attention?.url === url ? this.#attention.count : 0,
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
    this.#pending.set(state, {
      verifier,
      redirectUri,
      expiresAt: now + LOGIN_TTL_MS,
      communityUrl: this.communityUrl,
      generation: this.#authGeneration,
    })
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
    const tokens = await this.#tokenRequest(
      {
        grant_type: 'authorization_code',
        code,
        code_verifier: pending.verifier,
        redirect_uri: pending.redirectUri,
      },
      pending.communityUrl,
    )
    this.#assertAuthGeneration(pending.generation)
    const account = CommunityAccountSchema.parse({
      ...(tokens.user.id === undefined ? {} : { id: tokens.user.id }),
      handle: tokens.user.handle,
      displayName: tokens.user.displayName,
      avatarUrl: tokens.user.avatarUrl,
    })
    const url = pending.communityUrl
    const previous = this.#stored(url)
    const reference = await this.#credentials.save(tokens.refresh_token)
    try {
      this.#assertAuthGeneration(pending.generation)
      this.#writeAccount(url, { account, refreshTokenRef: reference, signedInAt: this.#now() })
      this.#invalidateAuth()
    } catch (error) {
      await this.#credentials.delete(reference)
      throw error
    }
    const completedGeneration = this.#authGeneration
    if (previous) await this.#credentials.delete(previous.refreshTokenRef)
    this.#assertAuthGeneration(completedGeneration)
    this.#access = { url, token: tokens.access_token, expiresAt: this.#now() + tokens.expires_in * 1000 }
    return account
  }

  /** 本机退出并尽力在社区撤销授权；社区不可达时仍完成本机退出。 */
  async logout(): Promise<CommunityStatus> {
    const url = this.communityUrl
    const stored = this.#stored()
    this.#invalidateAuth()
    this.#pending.clear()
    if (stored) {
      try {
        const refreshToken = await this.#credentials.resolve(stored.refreshTokenRef)
        await this.#fetch(new URL('/oauth/revoke', url), {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: refreshToken }).toString(),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
      } catch {
        // 撤销是尽力而为；本机凭据仍会删除。
      }
      await this.#forget(url, stored)
    }
    return this.status()
  }

  async #forget(url: string, stored: AccountEntry): Promise<void> {
    if (this.#stored(url)?.refreshTokenRef === stored.refreshTokenRef) {
      this.#writeAccount(url, null)
      if (this.communityUrl === url) this.#invalidateAuth()
    }
    await this.#credentials.delete(stored.refreshTokenRef)
  }

  /** 社区地址或登录变化时，目录缓存一并作废。 */
  #invalidateAuth(): void {
    this.#reads.clear()
    this.#authGeneration += 1
    this.#access = undefined
    this.#refreshing = undefined
  }

  #assertAuthGeneration(generation: number): void {
    if (generation !== this.#authGeneration)
      throw new CommunityError(409, '社区或账号已切换，请重新操作。', 'community-identity-changed')
  }

  async #tokenRequest(
    form: Record<string, string>,
    url = this.communityUrl,
  ): Promise<z.output<typeof TokenResponseSchema>> {
    const response = await this.#request(new URL('/oauth/token', url), {
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
    if (this.#refreshing === undefined) {
      const generation = this.#authGeneration
      const promise = this.#refresh().finally(() => {
        if (this.#refreshing?.generation === generation) this.#refreshing = undefined
      })
      this.#refreshing = { generation, promise }
    }
    return this.#refreshing.promise
  }

  async #refresh(): Promise<string> {
    const generation = this.#authGeneration
    const url = this.communityUrl
    const stored = this.#stored(url)
    if (!stored) throw new CommunityError(401, '请先在「社区 → 账号」登录社区。', 'community-signed-out')
    const refreshToken = await this.#credentials.resolve(stored.refreshTokenRef)
    this.#assertAuthGeneration(generation)
    let tokens: z.output<typeof TokenResponseSchema>
    try {
      tokens = await this.#tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken }, url)
    } catch (error) {
      if (
        generation === this.#authGeneration &&
        error instanceof CommunityError &&
        error.code === 'community-auth-invalid'
      ) {
        await this.#forget(url, stored)
        throw new CommunityError(401, '社区登录已失效，请重新登录。', 'community-signed-out')
      }
      throw error
    }
    const reference = await this.#credentials.save(tokens.refresh_token)
    try {
      this.#assertAuthGeneration(generation)
      this.#writeAccount(url, {
        account: CommunityAccountSchema.parse({
          ...(tokens.user.id === undefined ? {} : { id: tokens.user.id }),
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
    this.#assertAuthGeneration(generation)
    this.#access = { url, token: tokens.access_token, expiresAt: this.#now() + tokens.expires_in * 1000 }
    return tokens.access_token
  }

  async #request(url: URL, init: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
    // The community answers with what this version can install: updates it can apply, and a readable refusal for
    // packages that need a newer NekroNXT.
    const headers = new Headers(init.headers)
    headers.set('x-nxt-sdk', String(EXTENSION_SDK_LEVEL))
    try {
      return await this.#fetch(url, {
        ...init,
        headers,
        redirect: 'error',
        signal: init.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      init.signal?.throwIfAborted()
      const timedOut = error instanceof Error && error.name === 'TimeoutError'
      throw timedOut
        ? new CommunityError(502, '连接社区超时，请稍后再试。', 'community-timeout')
        : new CommunityError(502, '无法连接社区，请检查网络后再试。', 'community-unreachable')
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
    const url = this.communityUrl
    const generation = this.#authGeneration
    const headers = new Headers(init.headers)
    headers.set('accept', 'application/json')
    if (authenticated) headers.set('authorization', `Bearer ${await this.#accessToken()}`)
    this.#assertAuthGeneration(generation)
    const response = await this.#request(new URL(path, url), { ...init, headers })
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
    readonly sort?: CommunityExtensionSort | undefined
    readonly cursor?: string | undefined
  }): Promise<{ readonly items: CommunityExtensionSummary[]; readonly nextCursor: string | null }> {
    const search = new URLSearchParams({ limit: '30' })
    if (input.query) search.set('q', input.query)
    if (input.provides) search.set('provides', input.provides)
    if (input.official) search.set('official', input.official)
    if (input.sort) search.set('sort', input.sort)
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
              rating: normalizeRating(review['rating']),
              summary: typeof review['summary'] === 'string' ? review['summary'] : null,
              dimensions: records(review['dimensions'], 16).map((item) => ({ key: item['key'], notes: item['notes'] })),
              findings: records(review['findings'], 64).map((item) => ({
                dimension: item['dimension'],
                severity: item['severity'],
                title: item['title'],
              })),
              checks: records(review['checks'], 64).map((item) => ({
                severity: item['severity'],
                title: item['title'],
              })),
              reviewedAt: typeof review['reviewedAt'] === 'number' ? review['reviewedAt'] : null,
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
    readonly releaseNumber: number
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
      .parse(
        await this.#api('/api/v1/releases', { method: 'POST', body: form }, true).catch((error: unknown) => {
          throw explainCommunityLevelRejection(error)
        }),
      )
    this.#reads.clear()
    return {
      releaseId: body.release.id,
      releaseNumber: body.release.number,
      reviewStatus: body.release.reviewStatus,
      pageUrl: this.#extensionPage(body.extension.id),
      reportUrl: new URL(`/me/releases/${encodeURIComponent(body.release.id)}`, this.communityUrl).toString(),
      findings: body.findings.map((finding) => ({ severity: finding.severity, title: finding.title })),
    }
  }

  /**
   * Newest public release of each extension, with withdrawal and delisting state and the permissions it adds over
   * the release the machine knows. `releaseId` is optional: a line this machine published may not have one yet.
   */
  async checkUpdates(
    items: readonly { readonly extensionId: ExtensionId; readonly releaseId?: string; readonly revisionId?: string }[],
  ): Promise<ReadonlyMap<string, CommunityUpdateCheck>> {
    const result = new Map<string, CommunityUpdateCheck>()
    if (items.length === 0) return result
    const body = z.object({ items: z.array(z.record(z.string(), z.unknown())) }).parse(
      await this.#api('/api/v1/updates', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          items: items.map((item) => ({
            extensionId: item.extensionId,
            ...(item.releaseId === undefined ? {} : { releaseId: item.releaseId }),
            ...(item.revisionId === undefined ? {} : { revisionId: item.revisionId }),
          })),
        }),
      }),
    )
    for (const item of body.items) {
      const latest = item['latest'] ? CommunityReleaseSchema.parse(normalizeRelease(item['latest'])) : null
      result.set(String(item['extensionId']), {
        found: item['found'] === true,
        delisted: item['delisted'] === true,
        delistedReason: typeof item['delistedReason'] === 'string' ? item['delistedReason'] : null,
        releaseWithdrawn: item['releaseWithdrawn'] === true,
        latest,
        addedPermissions: (Array.isArray(item['addedPermissions']) ? item['addedPermissions'] : []).map((entry) =>
          CommunityPermissionItemSchema.parse(normalizePermission(entry)),
        ),
      })
    }
    return result
  }

  /** How many extensions need attention after the last sync check (navigation badge). */
  setAttention(count: number): void {
    this.#attention = { url: this.communityUrl, count }
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
      rating: normalizeRating(raw['rating']),
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
              compliance:
                ai['compliance'] === undefined || ai['compliance'] === null
                  ? null
                  : { ok: asRecord(ai['compliance'])['ok'], notes: asRecord(ai['compliance'])['notes'] },
              dimensions: records(ai['dimensions'], 16).map((dimension) => ({
                key: dimension['key'],
                stars: dimension['stars'],
                headline: dimension['headline'],
                notes: dimension['notes'],
                ...(typeof dimension['nextStar'] === 'string' ? { nextStar: dimension['nextStar'] } : {}),
              })),
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
    this.#reads.clear()
  }

  /**
   * 公开目录读取（扩展与人设的列表、详情）走进程内缓存：按社区地址、种类与完整查询区分，5 分钟内直接返回。
   * `refresh` 跳过缓存并替换；社区读取失败时退回较早的一份并标记 `stale`。
   */
  async cachedRead(
    kind: string,
    query: Readonly<Record<string, string | undefined>>,
    refresh: boolean,
    load: () => Promise<object>,
  ): Promise<CommunityCachedRead> {
    const params = Object.entries(query)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
    return this.#reads.read(JSON.stringify([this.communityUrl, kind, params]), refresh, load)
  }

  /** 本实例发布了社区内容后调用，下次浏览时读到新内容。 */
  invalidateReads(): void {
    this.#reads.clear()
  }

  /** 同一社区通道上的其他资源（如人设）读取开放接口：沿用地址、登录、超时与出错格式。 */
  async apiJson(path: string, init: RequestInit = {}, authenticated = false): Promise<unknown> {
    return this.#api(path, init, authenticated)
  }

  feedbackIdentity(): CommunityFeedbackIdentity {
    return { communityUrl: this.communityUrl, communityUserId: this.#stored()?.account.id ?? null }
  }

  /** Older saved logins acquire the new immutable ID from /me, without asking the user to log in again. */
  async ensureFeedbackIdentity(): Promise<CommunityFeedbackIdentity> {
    const identity = this.feedbackIdentity()
    if (identity.communityUserId !== null || !this.#stored()) return identity
    const generation = this.#authGeneration
    const raw = await this.#api('/api/v1/me', {}, true)
    this.#assertAuthGeneration(generation)
    const account = CommunityAccountSchema.parse(raw)
    if (!account.id)
      throw new CommunityError(502, '社区没有返回账号标识，请更新社区后重试。', 'community-identity-missing')
    const stored = this.#stored()
    if (stored && account.id) this.#writeAccount(identity.communityUrl, { ...stored, account })
    return this.feedbackIdentity()
  }

  #assertFeedbackIdentity(identity: CommunityFeedbackIdentity): void {
    const current = this.feedbackIdentity()
    if (current.communityUrl !== identity.communityUrl || current.communityUserId !== identity.communityUserId) {
      throw new CommunityError(409, '社区或账号已切换，请重新操作。', 'community-identity-changed')
    }
    if (identity.communityUserId === null)
      throw new CommunityError(401, '请先登录支持反馈的社区。', 'community-signed-out')
  }

  async #feedbackRequest(
    identity: CommunityFeedbackIdentity,
    pathname: string,
    init: RequestInit = {},
  ): Promise<unknown> {
    init.signal?.throwIfAborted()
    this.#assertFeedbackIdentity(identity)
    const token = await this.#accessToken()
    init.signal?.throwIfAborted()
    this.#assertFeedbackIdentity(identity)
    const response = await this.#request(new URL(pathname, identity.communityUrl), {
      ...init,
      headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${token}` },
    })
    const body = await this.#json(response)
    this.#assertFeedbackIdentity(identity)
    if (!response.ok) {
      const error = z.object({ error: z.object({ code: z.string(), message: z.string() }) }).safeParse(body)
      throw new CommunityError(
        response.status,
        communityErrorMessage(body, response.status),
        error.success ? error.data.error.code : 'community-request-failed',
      )
    }
    return body
  }

  async createFeedback(identity: CommunityFeedbackIdentity, input: CommunityFeedbackCreate, signal?: AbortSignal) {
    return CommunityFeedbackSchema.parse(
      await this.#feedbackRequest(identity, '/api/v1/feedback', {
        method: 'POST',
        body: JSON.stringify(input),
        ...(signal ? { signal } : {}),
      }),
    )
  }

  async listFeedback(
    identity: CommunityFeedbackIdentity,
    params = new URLSearchParams(),
    known = false,
    signal?: AbortSignal,
  ) {
    return CommunityFeedbackListSchema.parse(
      await this.#feedbackRequest(
        identity,
        `/api/v1/feedback${known ? '/known' : ''}${params.size ? `?${params}` : ''}`,
        signal ? { signal } : {},
      ),
    )
  }

  async getFeedback(identity: CommunityFeedbackIdentity, ref: string, signal?: AbortSignal) {
    const feedback = CommunityFeedbackSchema.parse(
      await this.#feedbackRequest(identity, `/api/v1/feedback/${encodeURIComponent(ref)}`, signal ? { signal } : {}),
    )
    if (feedback.ref !== ref)
      throw new CommunityError(502, '社区返回了不匹配的反馈，请稍后重试。', 'community-feedback-mismatch')
    return feedback
  }

  async feedbackChanges(identity: CommunityFeedbackIdentity, cursor?: number) {
    return CommunityFeedbackChangesSchema.parse(
      await this.#feedbackRequest(
        identity,
        `/api/v1/feedback/changes${cursor === undefined ? '' : `?cursor=${cursor}`}`,
      ),
    )
  }

  async updateFeedback(
    identity: CommunityFeedbackIdentity,
    ref: string,
    action: 'messages' | 'withdraw' | 'reopen' | 'confirm-fixed' | 'affected' | 'supplement',
    body: unknown,
    method: 'POST' | 'DELETE' = 'POST',
  ) {
    return CommunityFeedbackSchema.parse(
      await this.#feedbackRequest(identity, `/api/v1/feedback/${encodeURIComponent(ref)}/${action}`, {
        method,
        body: JSON.stringify(body),
      }),
    )
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
    ...(permission['layer'] === 'host' || permission['layer'] === 'agent' ? { layer: permission['layer'] } : {}),
  }
}

const records = (value: unknown, limit: number): Record<string, unknown>[] =>
  (Array.isArray(value) ? value : []).slice(0, limit).map(asRecord)

/** 社区的评级；结构不认识（旧版社区没有评级，或将来的标准）时当作没有评级。 */
const normalizeRating = (raw: unknown): CommunityRating | null => {
  const parsed = CommunityRatingSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

const normalizeRelease = (raw: unknown): Record<string, unknown> => {
  const release = asRecord(raw)
  return {
    id: release['id'],
    reviewStatus: release['reviewStatus'],
    rating: normalizeRating(release['rating']),
    permissions: (Array.isArray(release['permissions']) ? release['permissions'] : []).map(normalizePermission),
    packageSize: release['packageSize'],
    requiresSdk: release['requiresSdk'] ?? null,
    notes: release['notes'] ?? '',
    createdAt: release['createdAt'],
    ...(typeof release['number'] === 'number' ? { number: release['number'] } : {}),
    ...(typeof release['revisionId'] === 'string' ? { revisionId: release['revisionId'] } : {}),
    ...(typeof release['parentRevisionId'] === 'string' || release['parentRevisionId'] === null
      ? { parentRevisionId: release['parentRevisionId'] }
      : {}),
    ...(Array.isArray(release['ancestry'])
      ? { ancestry: release['ancestry'].filter((id): id is string => typeof id === 'string').slice(0, 256) }
      : {}),
  }
}

/** A branch origin as the community reports it; anything unreadable counts as no origin. */
const normalizeBranchOf = (raw: unknown): Record<string, unknown> | null => {
  if (raw === null || raw === undefined) return null
  const record = asRecord(raw)
  if (typeof record['extensionId'] !== 'string') return null
  return {
    extensionId: record['extensionId'],
    revisionId: typeof record['revisionId'] === 'string' ? record['revisionId'] : null,
    displayName: typeof record['displayName'] === 'string' ? record['displayName'] : null,
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
    branchOf: normalizeBranchOf(record['branchOf']),
    ...(typeof record['branchCount'] === 'number' ? { branchCount: record['branchCount'] } : {}),
  }
}
