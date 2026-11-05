import type { NxtLogger } from '@nekro-nxt/contracts'
import type { Context } from '@deepseek-ai/cordis'
import { Cron } from 'croner'
import { randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import { parseFeed, parseHtml, renderSvg } from './extension-render-parse.js'
import {
  ChannelIdSchema,
  SpeechLanguageSchema,
  EXTENSION_ASSET_LIBRARY_DEFAULT_QUOTA_BYTES,
  EXTENSION_CONTEXT_DYNAMIC_MAX_CHARS,
  EXTENSION_DOWNLOAD_DEFAULT_BYTES,
  EXTENSION_DOWNLOAD_MAX_BYTES,
  EXTENSION_DOWNLOAD_SDK_LEVEL,
  EXTENSION_FETCH_MAX_BYTES,
  EXTENSION_FILES_DEFAULT_CACHE_QUOTA_BYTES,
  EXTENSION_FILES_DEFAULT_TEMP_QUOTA_BYTES,
  EXTENSION_STORAGE_DEFAULT_QUOTA_BYTES,
  JsonValueSchema,
  type ExtensionCapabilities,
  type ExtensionContextContribution,
  type ChannelId,
  type ExtensionStorageScope,
  type JsonValue,
} from '@nekro-nxt/contracts'
import type {
  ExtensionJsonValue,
  NxtAssetCreateInput,
  NxtAssetRecord,
  NxtByteRange,
  NxtCallContext,
  NxtCommandsService,
  NxtFileFromUrlOptions,
  NxtFilesService,
  NxtMediaInput,
  NxtMediaService,
  NxtSpeechService,
  NxtMemberSummary,
  NxtFetchInit,
  NxtFetchResponse,
  NxtHistoryMessage,
  NxtHostLayerService,
  NxtHostService,
  NxtJobRecord,
  NxtPlatformAction,
  NxtPlatformResult,
  NxtLlmRequest,
  NxtLlmResponse,
  NxtPromptRenderApi,
  NxtIndexService,
  NxtModelOption,
  NxtModelRequest,
  NxtStorageEntry,
  NxtStorageListOptions,
  NxtStorageOptions,
} from '@nekro-nxt/extension-sdk'
import { queryLimit, validateIndexDocument, validateIndexFilter, type ExtensionIndexEngine } from './extension-index.js'
import type { ExtensionLibrary } from './extension-library.js'
import {
  EXTENSION_FILE_MAX_BYTES,
  formatBytes,
  readRange,
  type ExtensionFileQuota,
  type ExtensionFiles,
} from './extension-files.js'
import type { CommandArgument, CommandProfiles } from './command-profiles.js'
import type { AudioFormat, ConvertFormat, MediaToolkit } from './media-toolkit.js'
import type { SpeechService } from './speech-service.js'

/** Service name extensions declare in `inject`. Not a DSH private Service, so isolation never hides it. */
export const NXT_HOST_SERVICE_NAME = 'nxt'

/** Where an `nxt` instance runs and which product facts it may touch. */
export interface NxtServiceBinding {
  readonly sdk?: number
  /** `host` is the extension's single host instance; it has no agent or channel. */
  readonly mode: 'activation' | 'dynamic' | 'verification' | 'host'
  readonly agentId: string
  /** `extensionId` for installed extensions; the authoring task owner key for dynamic runs. */
  readonly ownerKey: string
  readonly displayName: string
  readonly channelId: string
  /**
   * Approved capabilities of this layer; `undefined` means none. Host bindings carry host-layer capabilities in the
   * same shape. Dynamic runs read the current candidate's declaration.
   */
  readonly capabilities: () => ExtensionCapabilities | undefined
  /** The configuration of this layer: the agent's for agent bindings, the host's for host bindings. */
  readonly config: () => JsonValue
  /** Host configuration of an agent binding; secrets declared in `config.host` resolve from it. */
  readonly hostConfig?: () => JsonValue
  /**
   * The part of `config` a person entered, when not all of it was: under `network.mode: 'config'` only addresses in
   * these values may reach private networks. Dynamic runs set it, since the agent provides their other values.
   */
  readonly userEnteredConfig?: () => JsonValue
  /**
   * Fields the Manifest declares `meta.role: 'secret'`, per value source: `config` for this binding's own layer and
   * `hostConfig` for the host layer of an agent binding. A secret resolves only from a field declared here.
   */
  readonly declaredSecrets: () => { readonly config: readonly string[]; readonly hostConfig: readonly string[] }
}

const configRecord = (value: JsonValue | undefined): Readonly<Record<string, JsonValue>> =>
  value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value) ? value : {}

/**
 * The stored reference of one secret field: from the layer that declares it as a secret, otherwise `undefined`. A value
 * in an undeclared field is never treated as a credential reference.
 */
export const bindingSecretReference = (binding: NxtServiceBinding, key: string): JsonValue | undefined => {
  const declared = binding.declaredSecrets()
  if (declared.config.includes(key)) return configRecord(binding.config())[key]
  if (declared.hostConfig.includes(key)) return configRecord(binding.hostConfig?.())[key]
  return undefined
}

/** A credential cleared for a request: its value and, for named credentials, the domains it may be sent to. */
export interface NxtRequestSecret {
  readonly value: string
  /** Hostnames or `*.example.com`; absent means wherever the extension's network policy reaches. */
  readonly domains?: readonly string[]
}

/** A placeholder an `http.fetch` call carries, with what to fill in and where. */
export interface NxtFetchSecret extends NxtRequestSecret {
  readonly token: string
}

export interface NxtStoragePartition {
  readonly owner: string
  readonly partition: string
}

export interface NxtStorageBackend {
  get(ownerKey: string, location: NxtStoragePartition, key: string): Promise<JsonValue | undefined>
  set(ownerKey: string, location: NxtStoragePartition, key: string, value: JsonValue, quotaBytes: number): Promise<void>
  delete(ownerKey: string, location: NxtStoragePartition, key: string): Promise<boolean>
  list(
    ownerKey: string,
    location: NxtStoragePartition,
    options: { readonly prefix?: string; readonly limit: number; readonly after?: string },
  ): Promise<{ readonly entries: readonly NxtStorageEntry[]; readonly next?: string }>
}

export type NxtEgressPolicy =
  | { readonly mode: 'domains'; readonly domains: readonly string[] }
  | { readonly mode: 'config'; readonly hosts: readonly string[]; readonly privateHosts?: readonly string[] }
  | { readonly mode: 'unrestricted' }

export interface NxtDownloadTarget {
  readonly path: string
  readonly maxBytes: number
  readonly signal?: AbortSignal | undefined
}

/** The body is in the target file when `status` is 2xx. */
export interface NxtDownloadResult {
  readonly url: string
  readonly status: number
  readonly contentType: string
  readonly byteSize: number
}

/** Product facts the service reads or writes; wired by the Server composition root or a verification fake. */
export interface NxtServiceBackends {
  readonly logger?: (binding: NxtServiceBinding) => NxtLogger
  readonly fetch: (
    policy: NxtEgressPolicy,
    url: string,
    init: NxtFetchInit | undefined,
    secrets?: readonly NxtFetchSecret[],
    limits?: { readonly maxBytes: number },
  ) => Promise<NxtFetchResponse>
  /** Streams a 2xx response body into a file through the same policy as `fetch`; absent backends cannot download. */
  readonly download?: (
    policy: NxtEgressPolicy,
    url: string,
    init: NxtFetchInit | undefined,
    secrets: readonly NxtFetchSecret[],
    target: NxtDownloadTarget,
  ) => Promise<NxtDownloadResult>
  /** 设置 → 存储 → 扩展下载上限; the highest allowed when absent. */
  readonly downloadLimitBytes?: () => number
  /** A channel Asset from streamed bytes (`assets.fromUrl`); the library's channel import when absent. */
  readonly createAssetFromStream?: (channelId: string, bytes: AsyncIterable<Uint8Array>) => Promise<NxtAssetRecord>
  readonly storage: NxtStorageBackend
  /** A secret field's value for code to read (`secrets.get`). */
  readonly secret: (binding: NxtServiceBinding, key: string) => Promise<string | undefined>
  /**
   * A secret field's value for one request the host sends (`secrets.placeholder`); `targetHost` is where the request
   * starts. Absent backends reject placeholders.
   */
  readonly requestSecret?: (
    binding: NxtServiceBinding,
    key: string,
    targetHost: string,
  ) => Promise<NxtRequestSecret | undefined>
  /** A named credential an MCP server declaration names by id or name, cleared for the binding's agent. */
  readonly mcpCredential?: (
    binding: NxtServiceBinding,
    reference: string,
    use: { readonly purpose: 'program' | 'request'; readonly targetHost?: string | undefined },
  ) => Promise<NxtRequestSecret | undefined>
  readonly createAsset: (channelId: string, input: NxtAssetCreateInput) => Promise<NxtAssetRecord>
  readonly callContext: (binding: NxtServiceBinding) => Promise<NxtCallContext>
  readonly members: {
    describe(channelId: string, memberId: string): Promise<NxtMemberSummary | undefined>
  }
  readonly platform: {
    /** The Adapter of the channel, its raw-API support and the typed actions valid for this channel kind. */
    catalog(channelId: string): Promise<NxtPlatformCatalog>
    invoke(
      binding: NxtServiceBinding,
      action: string,
      args: Readonly<Record<string, JsonValue>>,
    ): Promise<NxtPlatformResult>
    raw(
      binding: NxtServiceBinding,
      api: string,
      params: Readonly<Record<string, JsonValue>>,
    ): Promise<NxtPlatformResult>
    /** The platform user id the channel's connection reported as its own account. */
    selfPlatformUserId(channelId: string): Promise<string | undefined>
  }
  readonly jobs: {
    schedule(binding: NxtServiceBinding, job: NxtValidatedJob, maxActive: number): Promise<NxtJobRecord>
    list(binding: NxtServiceBinding): Promise<readonly NxtJobRecord[]>
    cancel(binding: NxtServiceBinding, jobId: string): Promise<boolean>
  }
  /** One model completion for the binding's agent; the service enforces the declared caps first. */
  readonly complete: (
    binding: NxtServiceBinding,
    request: NxtLlmRequest,
    maxOutputTokens: number,
  ) => Promise<NxtLlmResponse>
  readonly history: {
    list(
      channelId: string,
      options: { readonly limit: number; readonly before?: string },
    ): Promise<{ readonly messages: readonly NxtHistoryMessage[]; readonly next?: string }>
    search(channelId: string, query: string, limit: number): Promise<readonly NxtHistoryMessage[]>
  }
  readonly library: ExtensionLibrary
  /** Work files; dynamic runs and verification use a throwaway directory. */
  readonly files: ExtensionFiles
  /** The media add-on on host paths (附加功能 F8); verification answers with placeholders. */
  readonly media: Pick<MediaToolkit, 'probe' | 'frames' | 'audio' | 'convert'>
  /** Programs of the current add-ons by command profile (F7); verification answers with placeholders. */
  readonly commands: Pick<CommandProfiles, 'run' | 'available'>
  /** Speech to text with the speech add-on's provider (F9); verification answers with a fixed transcript. */
  readonly speech: Pick<SpeechService, 'transcribe' | 'transcribeOnce'>
  readonly index: ExtensionIndexEngine
  /** Host-configured models for host-layer calls; images are library Assets. */
  readonly models: {
    list(): Promise<readonly NxtModelOption[]>
    complete(
      binding: NxtServiceBinding,
      request: NxtModelRequest & { readonly provider: string; readonly modelId: string },
      maxOutputTokens: number,
    ): Promise<NxtLlmResponse>
  }
  readonly diagnostic?: (binding: NxtServiceBinding, message: string) => void
}

/** The DSH system prompt registry an `nxt` instance writes static sections and dynamic context into. */
export interface NxtPromptRegistry {
  section(section: { readonly name: string; readonly order: number; readonly text: string }): () => void
  context(context: { readonly name: string; readonly order: number; readonly text: () => string }): () => void
  /** Subscribes to the first step of every turn; resolves before the step assembles its prompt. */
  onTurnStart(listener: () => Promise<void>): () => void
}

export interface NxtPlatformCatalog {
  readonly adapterKey: string
  readonly raw: boolean
  readonly actions: readonly NxtPlatformAction[]
}

export type NxtJobSchedule =
  | { readonly kind: 'once'; readonly at: number }
  | { readonly kind: 'cron'; readonly cron: string; readonly timezone: string }

export interface NxtValidatedJob {
  readonly label: string
  readonly schedule: NxtJobSchedule
  readonly payload: JsonValue
  readonly nextRunAt: number
}

/** Next occurrence strictly after `after`, or `undefined` when a cron never fires again. */
export const nextJobRun = (schedule: NxtJobSchedule, after: number): number | undefined => {
  if (schedule.kind === 'once') return schedule.at > after ? schedule.at : undefined
  return new Cron(schedule.cron, { timezone: schedule.timezone }).nextRun(new Date(after))?.getTime()
}

const hostTimezone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone

/** Validates a cron expression and time zone, throwing a readable error the authoring agent can act on. */
export const parseJobSchedule = (
  input: {
    readonly at?: number | undefined
    readonly cron?: string | undefined
    readonly timezone?: string | undefined
  },
  now: number,
): NxtJobSchedule => {
  if ((input.at === undefined) === (input.cron === undefined)) {
    throw new NxtCapabilityError('定时任务需要且只能提供 at（一次性时间戳）或 cron（周期表达式）之一。')
  }
  if (input.at !== undefined) {
    if (!Number.isSafeInteger(input.at) || input.at <= now) throw new NxtCapabilityError('at 必须是未来的毫秒时间戳。')
    return { kind: 'once', at: input.at }
  }
  const cron = (input.cron ?? '').trim()
  if (cron.split(/\s+/u).length !== 5) throw new NxtCapabilityError('cron 只支持五段表达式，例如 0 8 * * *。')
  const timezone = input.timezone ?? hostTimezone()
  try {
    // croner validates the time zone lazily, so compute one occurrence to surface both errors here.
    new Cron(cron, { timezone, paused: true }).nextRun(new Date(now))
  } catch (error) {
    throw new NxtCapabilityError(`cron 或时区无效：${error instanceof Error ? error.message : String(error)}`)
  }
  return { kind: 'cron', cron, timezone }
}

export class NxtCapabilityError extends Error {
  override readonly name = 'NxtCapabilityError'
}

const DYNAMIC_RENDER_TIMEOUT_MS = 2000
/** Extension static sections sit after the product's own channel and communication policy sections. */
const STATIC_SECTION_ORDER = 30
const DYNAMIC_CONTEXT_ORDER = 900

const layerField = (binding: NxtServiceBinding): string =>
  binding.mode === 'host' ? 'permissions.host' : 'permissions.agent'

const requireCapability = <Key extends keyof ExtensionCapabilities>(
  binding: NxtServiceBinding,
  key: Key,
  manifestHint: string,
): NonNullable<ExtensionCapabilities[Key]> => {
  const value = binding.capabilities()?.[key]
  if (value === undefined) {
    throw new NxtCapabilityError(`这个扩展没有声明 ${manifestHint}，请在 Manifest 的 ${layerField(binding)} 中声明。`)
  }
  return value
}

const configHosts = (config: JsonValue, fields: readonly string[]): readonly string[] => {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return []
  return fields.flatMap((field) => {
    const raw = (config as Readonly<Record<string, JsonValue>>)[field]
    if (typeof raw !== 'string' || raw.trim() === '') return []
    try {
      return [new URL(raw.includes('://') ? raw : `https://${raw}`).host.toLowerCase()]
    } catch {
      return []
    }
  })
}

const egressPolicy = (binding: NxtServiceBinding): NxtEgressPolicy => {
  const network = requireCapability(binding, 'network', 'network（出站网络）')
  if (network.mode === 'domains') return { mode: 'domains', domains: network.domains }
  if (network.mode === 'config') {
    return {
      mode: 'config',
      hosts: configHosts(binding.config(), network.fields),
      ...(binding.userEnteredConfig === undefined
        ? {}
        : { privateHosts: configHosts(binding.userEnteredConfig(), network.fields) }),
    }
  }
  return { mode: 'unrestricted' }
}

const STORAGE_KEY_PATTERN = /^[\p{L}\p{N}._:/-]{1,256}$/u

const storageLocation = (
  binding: NxtServiceBinding,
  options: NxtStorageOptions | undefined,
): { readonly scope: ExtensionStorageScope; readonly location: NxtStoragePartition } => {
  const storage = requireCapability(binding, 'storage', 'storage（私有存储）')
  const scope = options?.scope ?? 'agent'
  if (!storage.scopes.includes(scope)) {
    throw new NxtCapabilityError(
      binding.mode === 'host'
        ? '本机实例的存储需要在 permissions.host 中声明 storage。'
        : `这个扩展没有声明 ${scope} 存储作用域，请加入 permissions.agent.storage.scopes。`,
    )
  }
  switch (scope) {
    case 'agent':
      return { scope, location: { owner: binding.agentId, partition: '' } }
    case 'channel':
      return { scope, location: { owner: binding.agentId, partition: binding.channelId } }
    case 'member': {
      const memberId = options?.memberId?.trim()
      if (!memberId)
        throw new NxtCapabilityError('member 作用域需要 memberId，可从 context.current() 或历史消息中取得。')
      return { scope, location: { owner: binding.agentId, partition: `${binding.channelId}:${memberId}` } }
    }
    case 'shared':
      return { scope, location: { owner: 'shared', partition: '' } }
  }
}

const checkedKey = (key: string): string => {
  if (!STORAGE_KEY_PATTERN.test(key)) {
    throw new NxtCapabilityError('存储键必须是 1–256 个字母、数字或 . _ : / - 字符。')
  }
  return key
}

const jsonValue = (value: unknown): JsonValue => JsonValueSchema.parse(JSON.parse(JSON.stringify(value)))

const jsonRecord = (value: unknown): Readonly<Record<string, JsonValue>> => {
  const parsed = jsonValue(value ?? {})
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new NxtCapabilityError('平台动作参数必须是对象。')
  }
  return parsed
}

const contextDeclaration = (
  binding: NxtServiceBinding,
  name: string,
  kind: ExtensionContextContribution['kind'],
): ExtensionContextContribution => {
  const declared = binding.capabilities()?.context?.find((entry) => entry.name === name)
  if (declared?.kind !== kind) {
    throw new NxtCapabilityError(
      `上下文 ${name} 没有以 ${kind} 声明，请在 permissions.agent.context 中加入 { name: '${name}', kind: '${kind}', maxChars }。`,
    )
  }
  return declared
}

const truncate = (text: string, maxChars: number): string =>
  text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1))}…`

const withTimeout = async <Value>(promise: Promise<Value>, timeoutMs: number, message: string): Promise<Value> => {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Runs `work` so a thrown capability error rejects like every other `nxt` call. */
const settle = <Value>(work: () => Value): Promise<Awaited<Value>> => {
  try {
    return Promise.resolve(work())
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)))
  }
}

const libraryQuota = (binding: NxtServiceBinding): number => {
  const library = requireCapability(binding, 'assets', 'assets.library（扩展资源库）').library
  if (library === undefined) {
    throw new NxtCapabilityError(`这个扩展没有声明扩展资源库，请在 ${layerField(binding)}.assets 中加入 library。`)
  }
  return library.quotaBytes ?? EXTENSION_ASSET_LIBRARY_DEFAULT_QUOTA_BYTES
}

const channelOf = (binding: NxtServiceBinding) => {
  const parsed = ChannelIdSchema.safeParse(binding.channelId)
  if (!parsed.success) throw new NxtCapabilityError('这次调用没有所在的频道。')
  return parsed.data
}

const requireWrite = (binding: NxtServiceBinding): void => {
  if (requireCapability(binding, 'assets', 'assets（生成频道文件）').write === undefined) {
    throw new NxtCapabilityError(`在当前频道生成文件需要在 ${layerField(binding)}.assets 中声明 write: true。`)
  }
}

/** Largest chunk one `assets.read` or `files.read` returns. */
export const NXT_READ_CHUNK_MAX_BYTES = 4 * 1024 * 1024
/** Dynamic runs and verification keep work files small whatever the declaration asks for. */
const PREVIEW_FILES_QUOTA_BYTES = 64 * 1024 * 1024

const byteRange = (range: NxtByteRange | undefined): { readonly offset: number; readonly length: number } => {
  const offset = range?.offset ?? 0
  const length = range?.length ?? NXT_READ_CHUNK_MAX_BYTES
  if (!Number.isSafeInteger(offset) || offset < 0) throw new NxtCapabilityError('offset 必须是非负整数。')
  if (!Number.isSafeInteger(length) || length < 1 || length > NXT_READ_CHUNK_MAX_BYTES) {
    throw new NxtCapabilityError(`length 必须是 1 到 ${NXT_READ_CHUNK_MAX_BYTES} 之间的整数（每次最多读 4 MiB）。`)
  }
  return { offset, length }
}

/** The channel an agent binding runs in; host bindings and calls outside a channel read only the library. */
const bindingChannel = (binding: NxtServiceBinding): ChannelId | undefined => {
  if (binding.mode === 'host') return undefined
  const parsed = ChannelIdSchema.safeParse(binding.channelId)
  return parsed.success ? parsed.data : undefined
}

const requireAssetRead = (binding: NxtServiceBinding): void => {
  if (requireCapability(binding, 'assets', 'assets.read（读取频道文件）').read === undefined) {
    throw new NxtCapabilityError(`读取文件内容需要在 ${layerField(binding)}.assets 中声明 read: true。`)
  }
}

/** `assets.read` and `assets.stat`: Assets the binding's channel can see, or the extension's library holds. */
const assetReader = (
  binding: NxtServiceBinding,
  backends: NxtServiceBackends,
): Pick<NxtHostService['assets'], 'read' | 'stat'> => ({
  async read(assetId, range) {
    requireAssetRead(binding)
    range?.signal?.throwIfAborted()
    const { offset, length } = byteRange(range)
    const asset = backends.library.readable(binding.ownerKey, bindingChannel(binding), assetId)
    const chunk = await readRange(backends.library.blobPath(asset), asset.byteSize, offset, length)
    return {
      base64: chunk.bytes.toString('base64'),
      eof: chunk.eof,
      byteSize: asset.byteSize,
      mediaType: asset.mediaType,
    }
  },
  stat: (assetId) =>
    settle(() => {
      requireAssetRead(binding)
      const asset = backends.library.readable(binding.ownerKey, bindingChannel(binding), assetId)
      return { byteSize: asset.byteSize, mediaType: asset.mediaType }
    }),
})

const DOWNLOAD_SETTING = '「设置 → 存储 → 扩展下载上限」'

/** 扩展下载上限: what one download may write, never above the highest an administrator can set. */
const downloadLimit = (backends: NxtServiceBackends): number =>
  Math.min(backends.downloadLimitBytes?.() ?? EXTENSION_DOWNLOAD_DEFAULT_BYTES, EXTENSION_DOWNLOAD_MAX_BYTES)

/** What `http.fetch` holds in memory: its own cap, or a lower 扩展下载上限. */
const fetchLimit = (backends: NxtServiceBackends): number =>
  Math.min(EXTENSION_FETCH_MAX_BYTES, downloadLimit(backends))

const isTooLarge = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'response-too-large'

/** Turns an egress size error into one that says what to do next; other errors pass through. */
const explainTooLarge = async <Result>(work: () => Promise<Result>, explain: () => string): Promise<Result> => {
  try {
    return await work()
  } catch (error) {
    if (isTooLarge(error)) throw new NxtCapabilityError(explain())
    throw error
  }
}

const fetchTooLarge = (backends: NxtServiceBackends): string => {
  const limit = fetchLimit(backends)
  return limit < EXTENSION_FETCH_MAX_BYTES
    ? `响应超过 ${formatBytes(limit)}：管理员在${DOWNLOAD_SETTING}把扩展下载上限设为 ${formatBytes(limit)}，需要更大的文件时请管理员调高。`
    : `响应超过 http.fetch 的 ${formatBytes(limit)} 上限。http.fetch 把整个响应读进内存，只适合接口和网页；视频、音频、压缩包等大文件请用 files.fromUrl 下载成工作文件（需要 files 权限和 requires.sdk 至少为 ${EXTENSION_DOWNLOAD_SDK_LEVEL}）。`
}

/** Says which limit a download went past: the 扩展下载上限, or the room left in the temp quota. */
const downloadTooLarge = (binding: NxtServiceBinding, limit: number, room: number, quota: number): string => {
  if (room < limit) {
    const preview =
      binding.mode === 'dynamic' || binding.mode === 'verification'
        ? `动态试运行和保存验证时工作文件最多 ${formatBytes(PREVIEW_FILES_QUOTA_BYTES)}，正式启用后按声明的配额。`
        : '请先删除不用的工作文件，或调大 files.tempQuotaBytes。'
    return `临时文件空间不够：这个扩展的临时文件配额为 ${formatBytes(quota)}，还剩 ${formatBytes(room)}。${preview}`
  }
  return limit < EXTENSION_DOWNLOAD_MAX_BYTES
    ? `文件超过扩展下载上限 ${formatBytes(limit)}。可以请管理员在${DOWNLOAD_SETTING}调高（最多 ${formatBytes(EXTENSION_DOWNLOAD_MAX_BYTES)}）。`
    : `文件超过扩展下载上限 ${formatBytes(limit)}，NekroNXT 目前不能下载更大的文件。`
}

/** The last part of the URL path, as the default name of a downloaded file. */
const urlFileName = (url: string): string | undefined => {
  try {
    const base = decodeURIComponent(new URL(url).pathname.split('/').at(-1) ?? '')
    return base === '' ? undefined : base
  } catch {
    return undefined
  }
}

type Downloader = (url: string, init: NxtFetchInit | undefined, target: NxtDownloadTarget) => Promise<NxtDownloadResult>

const fetchInit = (options: NxtFileFromUrlOptions | undefined): NxtFetchInit => ({
  ...(options?.method === undefined ? {} : { method: options.method }),
  ...(options?.headers === undefined ? {} : { headers: options.headers }),
  ...(options?.body === undefined ? {} : { body: options.body }),
  ...(options?.bodyBase64 === undefined ? {} : { bodyBase64: options.bodyBase64 }),
})

const filesQuota = (binding: NxtServiceBinding): ExtensionFileQuota => {
  const files = requireCapability(binding, 'files', 'files（工作文件）')
  const cap = binding.mode === 'dynamic' || binding.mode === 'verification' ? PREVIEW_FILES_QUOTA_BYTES : Infinity
  return {
    tempBytes: Math.min(files.tempQuotaBytes ?? EXTENSION_FILES_DEFAULT_TEMP_QUOTA_BYTES, cap),
    cacheBytes: Math.min(files.cacheQuotaBytes ?? EXTENSION_FILES_DEFAULT_CACHE_QUOTA_BYTES, cap),
  }
}

const fileBytes = (input: { readonly base64?: unknown; readonly text?: unknown }): Uint8Array => {
  if ((input.base64 === undefined) === (input.text === undefined)) {
    throw new NxtCapabilityError('files.write 需要且只能提供 base64 或 text 之一。')
  }
  if (typeof input.text === 'string') return new TextEncoder().encode(input.text)
  if (typeof input.base64 !== 'string') throw new NxtCapabilityError('base64 必须是字符串。')
  return Uint8Array.from(Buffer.from(input.base64, 'base64'))
}

/**
 * `nxt.files` (附加功能 F5). File ids belong to the extension (`ownerKey`), shared by its host instance and agent
 * attachments. `fromAsset` follows the same visibility as `assets.read`; `toAsset` needs the same declaration as
 * creating an Asset there.
 */
const filesService = (
  binding: NxtServiceBinding,
  backends: NxtServiceBackends,
  download: Downloader,
): NxtFilesService => {
  const owner = binding.ownerKey
  return {
    async write(input, options) {
      const quota = filesQuota(binding)
      options?.signal?.throwIfAborted()
      const name = typeof input?.name === 'string' ? input.name : undefined
      const mediaType =
        typeof input?.mediaType === 'string'
          ? input.mediaType
          : input?.text !== undefined
            ? 'text/plain; charset=utf-8'
            : undefined
      return backends.files.write(owner, { bytes: fileBytes(input ?? {}), name, mediaType }, quota)
    },
    async read(fileId, range) {
      filesQuota(binding)
      range?.signal?.throwIfAborted()
      const { offset, length } = byteRange(range)
      const chunk = await backends.files.read(owner, fileId, offset, length)
      return { base64: chunk.bytes.toString('base64'), eof: chunk.eof }
    },
    async stat(fileId) {
      filesQuota(binding)
      return backends.files.stat(owner, fileId)
    },
    async delete(fileId) {
      filesQuota(binding)
      return backends.files.delete(owner, fileId)
    },
    async fromAsset(assetId, options) {
      filesQuota(binding)
      options?.signal?.throwIfAborted()
      const asset = backends.library.readable(owner, bindingChannel(binding), assetId)
      return backends.files.fromAsset(owner, asset)
    },
    async toAsset(fileId, options) {
      filesQuota(binding)
      const library = binding.mode === 'host' || options?.library === true
      const quota = library ? libraryQuota(binding) : undefined
      if (!library) requireWrite(binding)
      options?.signal?.throwIfAborted()
      const { path: source } = await backends.files.resolvePath(owner, fileId)
      const bytes = createReadStream(source, options?.signal === undefined ? {} : { signal: options.signal })
      if (quota !== undefined) {
        const kept = await backends.library.import(owner, bytes, quota)
        return { assetId: kept.assetId, byteSize: kept.byteSize, mediaType: kept.mediaType }
      }
      return backends.library.createInChannel(channelOf(binding), bytes)
    },
    async fromUrl(url, options) {
      if (binding.mode !== 'dynamic' && (binding.sdk ?? 7) < EXTENSION_DOWNLOAD_SDK_LEVEL) {
        throw new NxtCapabilityError(
          `files.fromUrl 需要在清单中声明 requires.sdk 为 ${EXTENSION_DOWNLOAD_SDK_LEVEL} 或更高。`,
        )
      }
      const quota = filesQuota(binding)
      options?.signal?.throwIfAborted()
      const limit = downloadLimit(backends)
      const room = Math.max(0, quota.tempBytes - backends.files.usage(owner).tempBytes)
      const folder = await backends.files.workDirectory(owner)
      try {
        const target = path.join(folder.path, 'download')
        const response = await explainTooLarge(
          () =>
            download(url, fetchInit(options), {
              path: target,
              maxBytes: Math.min(limit, room),
              signal: options?.signal,
            }),
          () => downloadTooLarge(binding, limit, room, quota.tempBytes),
        )
        if (response.status < 200 || response.status >= 300) {
          throw new NxtCapabilityError(`下载失败：HTTP ${response.status}`)
        }
        return await backends.files.importPath(
          owner,
          target,
          { name: options?.name ?? urlFileName(url), mediaType: response.contentType, move: true, maxBytes: limit },
          quota,
        )
      } finally {
        await folder.dispose()
      }
    },
    cache: {
      async get(key) {
        filesQuota(binding)
        return backends.files.cacheGet(owner, key)
      },
      async put(key, fileId) {
        return backends.files.cachePut(owner, key, fileId, filesQuota(binding))
      },
      async delete(key) {
        filesQuota(binding)
        return backends.files.cacheDelete(owner, key)
      },
    },
  }
}

/** A host file a media, command or speech call reads, from an Asset or a work file of the extension. */
interface ResolvedInput {
  readonly path: string
  /** The content digest of an Asset input, which speech uses to transcribe the same audio once. */
  readonly digest?: string
}

const resolveInput = async (
  binding: NxtServiceBinding,
  backends: NxtServiceBackends,
  input: NxtMediaInput | undefined,
): Promise<ResolvedInput> => {
  const value = input as { readonly assetId?: unknown; readonly fileId?: unknown } | undefined
  if (typeof value?.assetId === 'string' && value.fileId === undefined) {
    const asset = backends.library.readable(binding.ownerKey, bindingChannel(binding), value.assetId)
    return { path: backends.library.blobPath(asset), digest: asset.contentDigest }
  }
  if (typeof value?.fileId === 'string' && value.assetId === undefined) {
    return { path: (await backends.files.resolvePath(binding.ownerKey, value.fileId)).path }
  }
  throw new NxtCapabilityError('输入需要且只能是 { assetId } 或 { fileId } 之一。')
}

/**
 * Runs `work` in a fresh work folder of the extension and turns the files it reports into temporary work files of the
 * extension (counted against its temp quota). If importing fails part way, the files already imported are removed.
 */
const withOutputs = async <Result>(
  binding: NxtServiceBinding,
  backends: NxtServiceBackends,
  work: (
    folder: string,
    keep: (hostPath: string, mediaType: string) => Promise<{ readonly fileId: string; readonly byteSize: number }>,
  ) => Promise<Result>,
): Promise<Result> => {
  const quota = filesQuota(binding)
  const folder = await backends.files.workDirectory(binding.ownerKey)
  const kept: string[] = []
  try {
    return await work(folder.path, async (hostPath, mediaType) => {
      const file = await backends.files.importPath(binding.ownerKey, hostPath, { mediaType, move: true }, quota)
      kept.push(file.fileId)
      return { fileId: file.fileId, byteSize: file.byteSize }
    })
  } catch (error) {
    await Promise.all(kept.map((fileId) => backends.files.delete(binding.ownerKey, fileId)))
    throw error
  } finally {
    await folder.dispose()
  }
}

const FRAME_MEDIA_TYPES: Readonly<Record<string, string>> = { jpeg: 'image/jpeg', png: 'image/png' }
const MEDIA_TYPES: Readonly<Record<AudioFormat | ConvertFormat, string>> = {
  wav: 'audio/wav',
  pcm_s16le: 'application/octet-stream',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  amr: 'audio/amr',
  silk: 'audio/silk',
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  webm: 'video/webm',
}
const FILE_EXTENSIONS: Readonly<Record<string, string>> = { jpeg: 'jpg', pcm_s16le: 'pcm' }

const outputName = (stem: string, format: unknown): string => {
  const key = typeof format === 'string' && format in MEDIA_TYPES ? format : 'bin'
  return `${stem}.${FILE_EXTENSIONS[key] ?? key}`
}

const callOptions = (options: { readonly signal?: AbortSignal } | undefined) =>
  options?.signal === undefined ? {} : { signal: options.signal }

const requireOptions = <Options>(options: Options | undefined): Options => {
  if (options === undefined || options === null || typeof options !== 'object') {
    throw new NxtCapabilityError('需要传入选项，至少写明 format。')
  }
  return options
}

/**
 * `nxt.media` (附加功能 F8): the media add-on on Assets and work files. Assets follow the same visibility as
 * `assets.read`; outputs become temporary work files, so producing them also needs `files`.
 */
const mediaService = (binding: NxtServiceBinding, backends: NxtServiceBackends): NxtMediaService => {
  const require = () => requireCapability(binding, 'media', 'media（媒体处理）')
  return {
    async probe(input, options) {
      require()
      const source = await resolveInput(binding, backends, input)
      return backends.media.probe(source.path, callOptions(options))
    },
    async frames(input, options) {
      require()
      const checked = requireOptions(options)
      const source = await resolveInput(binding, backends, input)
      return withOutputs(binding, backends, async (folder, keep) => {
        const frames = await backends.media.frames(source.path, checked, folder)
        const kept = []
        for (const frame of frames) {
          const file = await keep(frame.path, FRAME_MEDIA_TYPES[checked.format] ?? 'application/octet-stream')
          kept.push({ fileId: file.fileId, time: frame.time, width: frame.width, height: frame.height })
        }
        return kept
      })
    },
    async audio(input, options) {
      require()
      const checked = requireOptions(options)
      const source = await resolveInput(binding, backends, input)
      return withOutputs(binding, backends, async (folder, keep) => {
        const result = await backends.media.audio(
          source.path,
          checked,
          path.join(folder, outputName('audio', checked.format)),
        )
        const file = await keep(result.path, MEDIA_TYPES[result.format])
        return {
          fileId: file.fileId,
          byteSize: file.byteSize,
          format: result.format,
          sampleRate: result.sampleRate,
          channels: result.channels,
        }
      })
    },
    async convert(input, options) {
      require()
      const checked = requireOptions(options)
      const source = await resolveInput(binding, backends, input)
      return withOutputs(binding, backends, async (folder, keep) => {
        const result = await backends.media.convert(
          source.path,
          checked,
          path.join(folder, outputName('converted', checked.format)),
        )
        const file = await keep(result.path, MEDIA_TYPES[result.format])
        return { fileId: file.fileId, byteSize: file.byteSize, format: result.format }
      })
    },
  }
}

/** Arguments as the profile reads them; anything else is refused before the run. */
const commandArguments = (args: unknown): CommandArgument[] => {
  if (!Array.isArray(args)) throw new NxtCapabilityError('参数需要是数组。')
  return args.map((argument: unknown) => {
    if (typeof argument === 'string') return argument
    if (typeof argument === 'object' && argument !== null) {
      if ('input' in argument && !('output' in argument) && typeof argument.input === 'string') {
        return { input: argument.input }
      }
      if ('output' in argument && !('input' in argument) && typeof argument.output === 'string') {
        return { output: argument.output }
      }
    }
    throw new NxtCapabilityError('每个参数需要是文字、{ input: 键 } 或 { output: 文件名 }。')
  })
}

/**
 * `nxt.commands` (附加功能 F7): declared command profiles only, each call in a fresh work folder of the extension;
 * output files become temporary work files.
 */
const commandsService = (binding: NxtServiceBinding, backends: NxtServiceBackends): NxtCommandsService => {
  const declared = () => requireCapability(binding, 'commands', 'commands（运行程序）').profiles as readonly string[]
  return {
    async run(profile, args, options) {
      if (!declared().includes(profile)) {
        throw new NxtCapabilityError(
          `这个扩展没有声明命令档案 ${String(profile)}，请在 ${layerField(binding)}.commands.profiles 中加入。`,
        )
      }
      const parsed = commandArguments(args)
      const timeoutSeconds = options?.timeoutSeconds
      if (timeoutSeconds !== undefined && (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)) {
        throw new NxtCapabilityError('timeoutSeconds 需要是正数。')
      }
      const inputs: Record<string, string> = {}
      for (const [key, input] of Object.entries(options?.inputs ?? {})) {
        inputs[key] = (await resolveInput(binding, backends, input)).path
      }
      return withOutputs(binding, backends, async (folder, keep) => {
        const result = await backends.commands.run(profile, parsed, {
          inputs,
          workDir: folder,
          ...(timeoutSeconds === undefined ? {} : { timeoutMs: Math.round(timeoutSeconds * 1000) }),
          ...callOptions(options),
        })
        const outputs = []
        for (const output of result.outputs) {
          const file = await keep(output.path, 'application/octet-stream')
          outputs.push({ name: output.name, fileId: file.fileId, byteSize: file.byteSize })
        }
        return {
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          truncated: result.truncated,
          outputs,
        }
      })
    },
    profiles: () =>
      settle(() => {
        const available = new Map(backends.commands.available().map((profile) => [profile.id, profile.program]))
        return declared().map((id) => ({ id, program: available.get(id) ?? id, available: available.has(id) }))
      }),
  }
}

/**
 * `nxt.speech` (附加功能 F9) with the provider chosen in 设置 → 附加功能. Assets are transcribed once per content;
 * calls beyond the declared rate are refused.
 */
const speechService = (binding: NxtServiceBinding, backends: NxtServiceBackends): NxtSpeechService => {
  const calls: number[] = []
  return {
    async transcribe(input, options) {
      const speech = requireCapability(binding, 'speech', 'speech（语音识别）')
      const language = options?.language === undefined ? undefined : SpeechLanguageSchema.safeParse(options.language)
      if (language?.success === false) {
        throw new NxtCapabilityError(`language 只能是 ${SpeechLanguageSchema.options.join('、')}。`)
      }
      const source = await resolveInput(binding, backends, input)
      const now = Date.now()
      while (calls.length > 0 && calls[0]! <= now - 60_000) calls.shift()
      if (calls.length >= speech.maxCallsPerMinute) {
        throw new NxtCapabilityError(`每分钟最多转写 ${speech.maxCallsPerMinute} 次，请稍后再试。`)
      }
      calls.push(now)
      const request = {
        path: source.path,
        ...(language?.data === undefined ? {} : { language: language.data }),
        ...callOptions(options),
      }
      const transcript =
        source.digest === undefined
          ? await backends.speech.transcribe(request)
          : await backends.speech.transcribeOnce({ ...request, digest: source.digest })
      return {
        text: transcript.text,
        ...(transcript.language === undefined ? {} : { language: transcript.language }),
        segments: transcript.segments.map(({ start, end, text }) => ({ start, end, text })),
        durationSeconds: transcript.durationSeconds,
        provider: { id: transcript.provider.id, title: transcript.provider.title },
        model: transcript.model,
      }
    },
  }
}

const indexService = (binding: NxtServiceBinding, backends: NxtServiceBackends): NxtIndexService => {
  const collectionOf = (name: string) => {
    const declared = requireCapability(binding, 'index', 'index（检索索引）').collections.find(
      (collection) => collection.name === name,
    )
    if (declared === undefined) {
      throw new NxtCapabilityError(`没有声明索引 ${name}，请加入 ${layerField(binding)}.index.collections。`)
    }
    return declared
  }
  return {
    upsert: (collection, id, document) =>
      settle(() => {
        const declared = collectionOf(collection)
        backends.index.upsert(binding.ownerKey, declared, id, validateIndexDocument(declared, id, document))
      }),
    delete: (collection, id) =>
      settle(() => {
        collectionOf(collection)
        return backends.index.delete(binding.ownerKey, collection, id)
      }),
    async query(collection, text, options) {
      const declared = collectionOf(collection)
      if (typeof text !== 'string') throw new NxtCapabilityError('检索内容必须是字符串。')
      return backends.index.query(binding.ownerKey, declared, text, {
        limit: queryLimit(options?.limit),
        filter: validateIndexFilter(declared, options?.filter),
      })
    },
    count: (collection) =>
      settle(() => {
        collectionOf(collection)
        return backends.index.count(binding.ownerKey, collection)
      }),
  }
}

/** SDK level that introduced `secrets.placeholder`. */
export const NXT_PLACEHOLDER_SDK_LEVEL = 12
const PLACEHOLDER_PATTERN = /\{\{nxt-credential:[a-f0-9]{24}\}\}/gu

/**
 * `secrets.placeholder` and the lookup `http.fetch` uses to fill placeholders in. A token stands for one secret field
 * of this `nxt` instance only, so a token copied into another extension resolves to nothing.
 */
const credentialPlaceholders = (binding: NxtServiceBinding, backends: NxtServiceBackends) => {
  const tokens = new Map<string, string>()
  const keys = new Map<string, string>()
  return {
    placeholder(key: string): string {
      if (binding.mode !== 'dynamic' && (binding.sdk ?? 7) < NXT_PLACEHOLDER_SDK_LEVEL) {
        throw new NxtCapabilityError(
          `使用凭据占位符的扩展需要声明 requires.sdk 为 ${NXT_PLACEHOLDER_SDK_LEVEL} 或更高。`,
        )
      }
      if (typeof key !== 'string' || key.trim() === '') throw new NxtCapabilityError('占位符需要凭据字段名。')
      const existing = tokens.get(key)
      if (existing !== undefined) return existing
      const token = `{{nxt-credential:${randomBytes(12).toString('hex')}}}`
      tokens.set(key, token)
      keys.set(token, key)
      return token
    },
    /** Placeholders in the URL, headers and string body, each with the credential it stands for. */
    async secretsFor(url: string, init: NxtFetchInit | undefined): Promise<readonly NxtFetchSecret[]> {
      const found = new Set<string>()
      for (const text of [url, ...Object.values(init?.headers ?? {}), init?.body ?? '']) {
        if (typeof text !== 'string') continue
        for (const match of text.matchAll(PLACEHOLDER_PATTERN)) found.add(match[0])
      }
      if (found.size === 0) return []
      let targetHost = ''
      try {
        targetHost = new URL(url.replaceAll(PLACEHOLDER_PATTERN, '')).hostname.toLowerCase()
      } catch {
        // The egress reports the invalid URL itself.
      }
      const secrets: NxtFetchSecret[] = []
      for (const token of found) {
        const key = keys.get(token)
        if (key === undefined) {
          throw new NxtCapabilityError('请求里有不属于这个扩展的凭据占位符，请用 secrets.placeholder 重新获取。')
        }
        if (backends.requestSecret === undefined) throw new NxtCapabilityError('这里不能使用凭据占位符。')
        const secret = await backends.requestSecret(binding, key, targetHost)
        if (secret === undefined) {
          throw new NxtCapabilityError(`凭据字段 ${key} 还没有设置，或者绑定的凭据不对当前智能体开放。`)
        }
        secrets.push({ token, ...secret })
      }
      return secrets
    },
  }
}

/** Downloads into a file through the binding's egress policy, filling credential placeholders like `http.fetch`. */
const createDownloader =
  (
    binding: NxtServiceBinding,
    backends: NxtServiceBackends,
    placeholders: ReturnType<typeof credentialPlaceholders>,
  ): Downloader =>
  async (url, init, target) => {
    const policy = egressPolicy(binding)
    if (backends.download === undefined) throw new NxtCapabilityError('这里不能下载文件。')
    return backends.download(policy, url, init, await placeholders.secretsFor(url, init), target)
  }

/** Host-layer model calls: the caller names one of the Host's configured models by `ref`. */
const modelService = (binding: NxtServiceBinding, backends: NxtServiceBackends): NxtHostLayerService['models'] => {
  const calls: number[] = []
  return {
    async list() {
      requireCapability(binding, 'models', 'models（使用本机配置的模型）')
      return backends.models.list()
    },
    async complete(request) {
      const models = requireCapability(binding, 'models', 'models（使用本机配置的模型）')
      const messages: NxtModelRequest['messages'] = request.messages
      if (messages.length === 0) throw new NxtCapabilityError('models.complete 至少需要一条 messages。')
      const option = (await backends.models.list()).find(({ ref }) => ref === request.model)
      if (option === undefined) throw new NxtCapabilityError('找不到这个模型，可能已被移除，请重新选择。')
      const maxOutputTokens = Math.max(
        1,
        Math.min(Math.trunc(request.maxOutputTokens ?? models.maxOutputTokens), models.maxOutputTokens),
      )
      for (const message of messages) {
        for (const part of message.content) {
          if (part.type === 'image') backends.library.readable(binding.ownerKey, undefined, part.assetId)
        }
      }
      const now = Date.now()
      while (calls.length > 0 && calls[0]! <= now - 60_000) calls.shift()
      if (calls.length >= models.maxCallsPerMinute) {
        throw new NxtCapabilityError(`每分钟最多调用 ${models.maxCallsPerMinute} 次模型，请稍后再试。`)
      }
      calls.push(now)
      return backends.models.complete(
        binding,
        { ...request, provider: option.provider, modelId: option.model },
        maxOutputTokens,
      )
    },
  }
}

/**
 * One `nxt` instance per (agent, extension owner, Session). `prompt` is optional because verification renders
 * dynamic context directly instead of registering into a live DSH Session.
 */
export const createNxtHostService = (
  binding: NxtServiceBinding,
  backends: NxtServiceBackends,
  prompt?: NxtPromptRegistry,
): NxtHostService & { readonly renderDynamicContext: () => Promise<readonly string[]> } => {
  const storageQuota = (): number =>
    binding.capabilities()?.storage?.quotaBytes ?? EXTENSION_STORAGE_DEFAULT_QUOTA_BYTES
  const dynamicRenderers = new Map<
    string,
    {
      readonly render: (api: NxtPromptRenderApi) => string | Promise<string>
      readonly maxChars: number
      current: string
    }
  >()

  const storage: NxtHostService['storage'] = {
    async get(key, options) {
      const { location } = storageLocation(binding, options)
      return backends.storage.get(binding.ownerKey, location, checkedKey(key))
    },
    async set(key, value, options) {
      const { location } = storageLocation(binding, options)
      await backends.storage.set(binding.ownerKey, location, checkedKey(key), jsonValue(value), storageQuota())
    },
    async delete(key, options) {
      const { location } = storageLocation(binding, options)
      return backends.storage.delete(binding.ownerKey, location, checkedKey(key))
    },
    async list(options?: NxtStorageListOptions) {
      const { location } = storageLocation(binding, options)
      const limit = Math.min(Math.max(Math.trunc(options?.limit ?? 50), 1), 200)
      return backends.storage.list(binding.ownerKey, location, {
        limit,
        ...(options?.prefix === undefined ? {} : { prefix: options.prefix }),
        ...(options?.after === undefined ? {} : { after: options.after }),
      })
    },
  }

  const placeholders = credentialPlaceholders(binding, backends)
  // Async so a missing declaration rejects like every other `nxt` call instead of throwing synchronously.
  const fetchWithPolicy = async (url: string, init?: NxtFetchInit): Promise<NxtFetchResponse> => {
    const policy = egressPolicy(binding)
    const secrets = await placeholders.secretsFor(url, init)
    return explainTooLarge(
      () => backends.fetch(policy, url, init, secrets, { maxBytes: fetchLimit(backends) }),
      () => fetchTooLarge(backends),
    )
  }
  const download = createDownloader(binding, backends, placeholders)

  const renderApi = async (): Promise<NxtPromptRenderApi> => ({
    storage: { get: (key, options) => storage.get(key, options), list: (options) => storage.list(options) },
    context: await backends.callContext(binding),
  })

  const renderDynamicContext = async (): Promise<readonly string[]> => {
    if (dynamicRenderers.size === 0) return []
    const api = await renderApi()
    const rendered: string[] = []
    for (const [name, renderer] of dynamicRenderers) {
      try {
        const text = await withTimeout(
          Promise.resolve(renderer.render(api)),
          DYNAMIC_RENDER_TIMEOUT_MS,
          `动态上下文 ${name} 渲染超过 ${DYNAMIC_RENDER_TIMEOUT_MS}ms。`,
        )
        if (typeof text !== 'string') throw new TypeError(`动态上下文 ${name} 必须返回字符串。`)
        renderer.current = truncate(text.trim(), renderer.maxChars)
      } catch (error) {
        // Keep the previous snapshot: an unchanged value appends nothing to the Session history.
        backends.diagnostic?.(binding, error instanceof Error ? error.message : String(error))
      }
      rendered.push(renderer.current)
    }
    return rendered
  }

  // Model calls are budgeted per turn; outside a live Session (dynamic runs, verification) the budget never resets.
  let llmCallsThisTurn = 0
  // The listener lives as long as the Session Fiber whose Context registered it.
  prompt?.onTurnStart(() => {
    llmCallsThisTurn = 0
    return Promise.resolve()
  })
  let offTurnStart: (() => void) | undefined
  const ensureTurnListener = (): void => {
    if (offTurnStart !== undefined || prompt === undefined) return
    offTurnStart = prompt.onTurnStart(async () => {
      await renderDynamicContext()
    })
  }

  const label = `[扩展：${binding.displayName}]`
  const log =
    (level: 'debug' | 'info' | 'warn' | 'error') =>
    (message: string, details?: unknown): void => {
      if (binding.mode !== 'dynamic' && (binding.sdk ?? 7) < 9)
        throw new Error('使用日志接口的扩展需要声明 requires.sdk 为 9 或更高。')
      backends.logger?.(binding)[level](message, details)
    }

  return {
    logger: { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') },
    config: () => binding.config(),
    http: { fetch: fetchWithPolicy },
    secrets: {
      async get(key) {
        return backends.secret(binding, key)
      },
      placeholder: (key) => placeholders.placeholder(key),
    },
    assets: {
      async create(input, options) {
        if (options?.library === true) {
          const quota = libraryQuota(binding)
          const bytes =
            input.base64 === undefined
              ? new TextEncoder().encode(input.text ?? '')
              : Uint8Array.from(Buffer.from(input.base64, 'base64'))
          const kept = await backends.library.import(binding.ownerKey, bytes, quota)
          return { assetId: kept.assetId, byteSize: kept.byteSize, mediaType: kept.mediaType }
        }
        requireWrite(binding)
        return backends.createAsset(binding.channelId, input)
      },
      keep: (assetId) =>
        settle(() => backends.library.keep(binding.ownerKey, channelOf(binding), assetId, libraryQuota(binding))),
      release: (assetId) =>
        settle(() => {
          libraryQuota(binding)
          return backends.library.release(binding.ownerKey, assetId)
        }),
      attach: (assetId) =>
        settle(() => {
          libraryQuota(binding)
          return backends.library.attach(binding.ownerKey, channelOf(binding), assetId)
        }),
      ...assetReader(binding, backends),
      // `name` stays accepted for older extensions; channel Assets are identified by content.
      async fromUrl(url) {
        requireWrite(binding)
        const limit = Math.min(downloadLimit(backends), EXTENSION_FILE_MAX_BYTES)
        const folder = await backends.files.workDirectory(binding.ownerKey)
        try {
          const target = path.join(folder.path, 'download')
          const response = await explainTooLarge(
            () => download(url, undefined, { path: target, maxBytes: limit }),
            () =>
              limit < EXTENSION_FILE_MAX_BYTES
                ? downloadTooLarge(binding, limit, Infinity, Infinity)
                : `文件超过 ${formatBytes(limit)}，不能直接存成频道文件。请用 files.fromUrl 下载成工作文件再处理。`,
          )
          if (response.status < 200 || response.status >= 300) {
            throw new Error(`下载失败：HTTP ${response.status}`)
          }
          const bytes = createReadStream(target)
          return await (backends.createAssetFromStream === undefined
            ? backends.library.createInChannel(channelOf(binding), bytes)
            : backends.createAssetFromStream(binding.channelId, bytes))
        } finally {
          await folder.dispose()
        }
      },
    },
    image: {
      info: (assetId) => backends.library.imageInfo(binding.ownerKey, channelOf(binding), assetId),
    },
    files: filesService(binding, backends, download),
    media: mediaService(binding, backends),
    commands: commandsService(binding, backends),
    speech: speechService(binding, backends),
    index: indexService(binding, backends),
    storage,
    context: {
      current: () => backends.callContext(binding),
    },
    members: {
      describe: (memberId) => backends.members.describe(binding.channelId, memberId),
    },
    history: {
      async list(options) {
        requireCapability(binding, 'history', 'history（读取频道聊天记录）')
        const limit = Math.min(Math.max(Math.trunc(options?.limit ?? 20), 1), 100)
        return backends.history.list(binding.channelId, {
          limit,
          ...(options?.before === undefined ? {} : { before: options.before }),
        })
      },
      async search(query, options) {
        requireCapability(binding, 'history', 'history（读取频道聊天记录）')
        if (!query.trim()) throw new NxtCapabilityError('搜索内容不能为空。')
        const limit = Math.min(Math.max(Math.trunc(options?.limit ?? 20), 1), 100)
        return backends.history.search(binding.channelId, query, limit)
      },
    },
    platform: {
      async actions() {
        const platform = requireCapability(binding, 'platform', 'platform（平台动作）')
        const catalog = await backends.platform.catalog(binding.channelId)
        return catalog.actions.filter((action) =>
          platform.actions.some((entry) => entry.adapter === catalog.adapterKey && entry.action === action.name),
        )
      },
      async invoke(action, args) {
        const platform = requireCapability(binding, 'platform', 'platform（平台动作）')
        const catalog = await backends.platform.catalog(binding.channelId)
        if (!platform.actions.some((entry) => entry.adapter === catalog.adapterKey && entry.action === action)) {
          throw new NxtCapabilityError(
            `没有声明平台动作 ${catalog.adapterKey}:${action}，请加入 ${layerField(binding)}.platform.actions。`,
          )
        }
        if (!catalog.actions.some(({ name }) => name === action)) {
          throw new NxtCapabilityError(
            `当前频道的平台不支持动作 ${action}。可用动作：${catalog.actions.map(({ name }) => name).join('、') || '无'}`,
          )
        }
        return backends.platform.invoke(binding, action, jsonRecord(args))
      },
      async raw(api, params) {
        const platform = requireCapability(binding, 'platform', 'platform（平台动作）')
        const catalog = await backends.platform.catalog(binding.channelId)
        if (!platform.raw.includes(catalog.adapterKey)) {
          throw new NxtCapabilityError(
            `没有声明 ${catalog.adapterKey} 的原始接口，请加入 ${layerField(binding)}.platform.raw。`,
          )
        }
        if (!catalog.raw) throw new NxtCapabilityError('当前频道的平台不支持原始接口透传。')
        if (typeof api !== 'string' || api.trim() === '') throw new NxtCapabilityError('原始接口名不能为空。')
        return backends.platform.raw(binding, api.trim(), jsonRecord(params))
      },
      async selfPlatformUserId() {
        const platform = requireCapability(binding, 'platform', 'platform（平台动作）')
        const catalog = await backends.platform.catalog(binding.channelId)
        if (!platform.raw.includes(catalog.adapterKey)) {
          throw new NxtCapabilityError(
            `读取机器人账号的平台 ID 需要声明 ${catalog.adapterKey} 的原始接口，请加入 ${layerField(binding)}.platform.raw。`,
          )
        }
        return backends.platform.selfPlatformUserId(binding.channelId)
      },
    },
    jobs: {
      async schedule(input) {
        const jobs = requireCapability(binding, 'jobs', 'jobs（定时任务）')
        if (jobs.runtime === undefined) {
          throw new NxtCapabilityError(`运行时创建定时任务需要声明 ${layerField(binding)}.jobs.runtime.maxActive。`)
        }
        const label = typeof input.label === 'string' ? input.label.trim() : ''
        if (label === '' || label.length > 200) throw new NxtCapabilityError('定时任务 label 需要 1–200 个字符。')
        const now = Date.now()
        const schedule = parseJobSchedule(input, now)
        const nextRunAt = nextJobRun(schedule, now)
        if (nextRunAt === undefined) throw new NxtCapabilityError('这个计划不会再触发。')
        return backends.jobs.schedule(
          binding,
          { label, schedule, payload: jsonValue(input.payload ?? {}), nextRunAt },
          jobs.runtime.maxActive,
        )
      },
      async list() {
        requireCapability(binding, 'jobs', 'jobs（定时任务）')
        return backends.jobs.list(binding)
      },
      async cancel(jobId) {
        requireCapability(binding, 'jobs', 'jobs（定时任务）')
        return backends.jobs.cancel(binding, jobId)
      },
    },
    llm: {
      async complete(request) {
        const llm = requireCapability(binding, 'llm', 'llm（使用智能体的模型）')
        if (!Array.isArray(request.messages) || request.messages.length === 0) {
          throw new NxtCapabilityError('llm.complete 至少需要一条 messages。')
        }
        if (llmCallsThisTurn >= llm.maxCallsPerTurn) {
          throw new NxtCapabilityError(
            `本轮已调用模型 ${llmCallsThisTurn} 次，达到声明的上限 ${llm.maxCallsPerTurn}；请合并请求或在下一轮再试。`,
          )
        }
        llmCallsThisTurn += 1
        const maxOutputTokens = Math.min(
          Math.trunc(request.maxOutputTokens ?? llm.maxOutputTokens),
          llm.maxOutputTokens,
        )
        return backends.complete(binding, request, Math.max(1, maxOutputTokens))
      },
    },
    render: {
      svg: (svg, options) => renderSvg(svg, options),
    },
    parse: {
      html: (html, options) => Promise.resolve(parseHtml(html, options)),
      feed: (xml, options) => Promise.resolve(parseFeed(xml, options)),
    },
    prompt: {
      static(name, text) {
        const declaration = contextDeclaration(binding, name, 'static')
        if (typeof text !== 'string') throw new NxtCapabilityError('静态上下文必须是固定字符串。')
        if (prompt === undefined) return () => undefined
        return prompt.section({
          name: `nekro-nxt:extension:${binding.ownerKey}:${name}`,
          order: STATIC_SECTION_ORDER,
          text: `${label}\n${truncate(text.trim(), declaration.maxChars)}`,
        })
      },
      dynamic(name, render) {
        const declaration = contextDeclaration(binding, name, 'dynamic')
        if (typeof render !== 'function') throw new NxtCapabilityError('动态上下文需要渲染函数。')
        if (dynamicRenderers.has(name)) throw new NxtCapabilityError(`动态上下文已注册：${name}`)
        const renderer = {
          render,
          maxChars: Math.min(declaration.maxChars, EXTENSION_CONTEXT_DYNAMIC_MAX_CHARS),
          current: '',
        }
        dynamicRenderers.set(name, renderer)
        ensureTurnListener()
        const offContext =
          prompt?.context({
            name: `nekro-nxt:extension:${binding.ownerKey}:${name}`,
            order: DYNAMIC_CONTEXT_ORDER,
            text: () => (renderer.current === '' ? '' : `${label}\n${renderer.current}`),
          }) ?? (() => undefined)
        return () => {
          offContext()
          dynamicRenderers.delete(name)
          if (dynamicRenderers.size === 0) {
            offTurnStart?.()
            offTurnStart = undefined
          }
        }
      },
    },
    renderDynamicContext,
  }
}

/**
 * The host instance's `nxt` (扩展形态统一 §5): controlled network, secrets, the extension's host storage partition and
 * the pure render and parse services, checked against `permissions.host`.
 */
export const createHostLayerNxt = (binding: NxtServiceBinding, backends: NxtServiceBackends): NxtHostLayerService => {
  const quota = (): number => binding.capabilities()?.storage?.quotaBytes ?? EXTENSION_STORAGE_DEFAULT_QUOTA_BYTES
  const location = () => storageLocation(binding, { scope: 'shared' }).location
  const placeholders = credentialPlaceholders(binding, backends)
  return {
    http: {
      fetch: async (url, init) => {
        const policy = egressPolicy(binding)
        const secrets = await placeholders.secretsFor(url, init)
        return explainTooLarge(
          () => backends.fetch(policy, url, init, secrets, { maxBytes: fetchLimit(backends) }),
          () => fetchTooLarge(backends),
        )
      },
    },
    secrets: {
      get: async (key) => backends.secret(binding, key),
      placeholder: (key) => placeholders.placeholder(key),
    },
    storage: {
      async get(key) {
        return backends.storage.get(binding.ownerKey, location(), checkedKey(key))
      },
      async set(key, value) {
        await backends.storage.set(binding.ownerKey, location(), checkedKey(key), jsonValue(value), quota())
      },
      async delete(key) {
        return backends.storage.delete(binding.ownerKey, location(), checkedKey(key))
      },
      async list(options) {
        const limit = Math.min(Math.max(Math.trunc(options?.limit ?? 50), 1), 200)
        return backends.storage.list(binding.ownerKey, location(), {
          limit,
          ...(options?.prefix === undefined ? {} : { prefix: options.prefix }),
          ...(options?.after === undefined ? {} : { after: options.after }),
        })
      },
    },
    render: { svg: (svg, options) => renderSvg(svg, options) },
    parse: {
      html: (html, options) => Promise.resolve(parseHtml(html, options)),
      feed: (xml, options) => Promise.resolve(parseFeed(xml, options)),
    },
    assets: {
      list: (options) =>
        settle(() => {
          libraryQuota(binding)
          return backends.library.list(binding.ownerKey, options)
        }),
      get: (assetId) =>
        settle(() => {
          libraryQuota(binding)
          return backends.library.get(binding.ownerKey, assetId)
        }),
      release: (assetId) =>
        settle(() => {
          libraryQuota(binding)
          return backends.library.release(binding.ownerKey, assetId)
        }),
      ...assetReader(binding, backends),
    },
    image: {
      info: (assetId) => backends.library.imageInfo(binding.ownerKey, undefined, assetId),
    },
    files: filesService(binding, backends, createDownloader(binding, backends, placeholders)),
    media: mediaService(binding, backends),
    commands: commandsService(binding, backends),
    speech: speechService(binding, backends),
    index: indexService(binding, backends),
    models: modelService(binding, backends),
  }
}

/**
 * Adapts a DSH agent Context to {@link NxtPromptRegistry}; registrations are effects of that Context. `redact` hides
 * known secrets in extension-supplied text: once for a static section, on every render for runtime context.
 */
export const dshPromptRegistry = (
  context: Context,
  sessionId: string,
  redact: (text: string) => string,
): NxtPromptRegistry => ({
  section: (section) => context.systemPrompt.section({ ...section, text: redact(section.text) }),
  context: (entry) => context.systemPrompt.context({ ...entry, text: () => redact(entry.text()) }),
  onTurnStart: (listener) =>
    context.on('agent/pre-step', async ({ agent, step }, next) => {
      if (step <= 1 && agent.id === sessionId) await listener()
      return next()
    }),
})

/** The host's own implementations, so a candidate sees the same behavior it gets once saved. */
const DYNAMIC_SANDBOX_GLOBALS = Object.freeze({
  crypto: globalThis.crypto,
  URL,
  URLSearchParams,
  AbortController,
  structuredClone,
})
export type DynamicSandboxGlobals = typeof DYNAMIC_SANDBOX_GLOBALS

/**
 * `nxt` facade for dynamic runs, published with `context.set('nxt', …)`. The DSH dynamic sandbox lets a host half
 * reach Services it lists in `inject` and proxies their members; resolving per access follows the current candidate.
 */
export const createNxtDynamicFacade = (
  resolve: () => NxtHostService,
  resolveHostLayer?: () => NxtHostLayerService,
  reportToolProgress?: (callId: string, update: unknown) => void,
): NxtHostService & {
  readonly hostLayer: NxtHostLayerService | undefined
  /** Called by the dynamic wrapper's `harness.defineTool` with the progress a candidate's Tool reports. */
  readonly reportToolProgress: (callId: string, update: unknown) => void
  /** Web globals the DSH sandbox lacks; the dynamic wrapper hands them to the candidate, as a saved Revision has them. */
  readonly sandboxGlobals: DynamicSandboxGlobals
} => ({
  sandboxGlobals: DYNAMIC_SANDBOX_GLOBALS,
  get logger() {
    return resolve().logger
  },
  reportToolProgress: (callId, update) => {
    if (typeof callId === 'string') reportToolProgress?.(callId, update)
  },
  config: () => resolve().config(),
  /** The candidate's host-layer `nxt`; the dynamic wrapper hands it to the factory's top-level `nxt`. */
  get hostLayer() {
    return resolveHostLayer?.()
  },
  get http() {
    return resolve().http
  },
  get secrets() {
    return resolve().secrets
  },
  get assets() {
    return resolve().assets
  },
  get image() {
    return resolve().image
  },
  get files() {
    return resolve().files
  },
  get media() {
    return resolve().media
  },
  get commands() {
    return resolve().commands
  },
  get speech() {
    return resolve().speech
  },
  get index() {
    return resolve().index
  },
  get storage() {
    return resolve().storage
  },
  get context() {
    return resolve().context
  },
  get members() {
    return resolve().members
  },
  get history() {
    return resolve().history
  },
  get platform() {
    return resolve().platform
  },
  get jobs() {
    return resolve().jobs
  },
  get llm() {
    return resolve().llm
  },
  get render() {
    return resolve().render
  },
  get parse() {
    return resolve().parse
  },
  get prompt() {
    return resolve().prompt
  },
})

export type { ExtensionJsonValue }
