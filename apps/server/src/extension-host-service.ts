import type { Context } from '@deepseek-ai/cordis'
import { Cron } from 'croner'
import { parseFeed, parseHtml, renderSvg } from './extension-render-parse.js'
import {
  EXTENSION_CONTEXT_DYNAMIC_MAX_CHARS,
  EXTENSION_STORAGE_DEFAULT_QUOTA_BYTES,
  JsonValueSchema,
  type ExtensionCapabilities,
  type ExtensionContextContribution,
  type ExtensionStorageScope,
  type JsonValue,
} from '@nekro-nxt/contracts'
import type {
  ExtensionJsonValue,
  NxtAssetCreateInput,
  NxtAssetRecord,
  NxtCallContext,
  NxtMemberSummary,
  NxtFetchInit,
  NxtFetchResponse,
  NxtHistoryMessage,
  NxtHostService,
  NxtJobRecord,
  NxtPlatformAction,
  NxtPlatformResult,
  NxtLlmRequest,
  NxtLlmResponse,
  NxtPromptRenderApi,
  NxtStorageEntry,
  NxtStorageListOptions,
  NxtStorageOptions,
} from '@nekro-nxt/extension-sdk'

/** Service name extensions declare in `inject`. Not a DSH private Service, so isolation never hides it. */
export const NXT_HOST_SERVICE_NAME = 'nxt'

/** Where an `nxt` instance runs and which product facts it may touch. */
export interface NxtServiceBinding {
  readonly mode: 'activation' | 'dynamic' | 'verification'
  readonly agentId: string
  /** `extensionId` for Activations; the authoring task owner key for dynamic runs. */
  readonly ownerKey: string
  readonly displayName: string
  readonly channelId: string
  /** Approved capabilities; `undefined` means none. Dynamic runs read the current candidate's declaration. */
  readonly capabilities: () => ExtensionCapabilities | undefined
  readonly config: () => JsonValue
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
  | { readonly mode: 'config'; readonly hosts: readonly string[] }
  | { readonly mode: 'unrestricted' }

/** Product facts the service reads or writes; wired by the Server composition root or a verification fake. */
export interface NxtServiceBackends {
  readonly fetch: (policy: NxtEgressPolicy, url: string, init: NxtFetchInit | undefined) => Promise<NxtFetchResponse>
  readonly storage: NxtStorageBackend
  readonly secret: (binding: NxtServiceBinding, key: string) => Promise<string | undefined>
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

const requireCapability = <Key extends keyof ExtensionCapabilities>(
  binding: NxtServiceBinding,
  key: Key,
  manifestHint: string,
): NonNullable<ExtensionCapabilities[Key]> => {
  const value = binding.capabilities()?.[key]
  if (value === undefined) {
    throw new NxtCapabilityError(`这个扩展没有声明 ${manifestHint}，请在 Manifest 的 permissions.capabilities 中声明。`)
  }
  return value
}

const configHosts = (binding: NxtServiceBinding, fields: readonly string[]): readonly string[] => {
  const config = binding.config()
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
  if (network.mode === 'config') return { mode: 'config', hosts: configHosts(binding, network.fields) }
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
      `这个扩展没有声明 ${scope} 存储作用域，请加入 permissions.capabilities.storage.scopes。`,
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
      `上下文 ${name} 没有以 ${kind} 声明，请在 permissions.capabilities.context 中加入 { name: '${name}', kind: '${kind}', maxChars }。`,
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

  // Async so a missing declaration rejects like every other `nxt` call instead of throwing synchronously.
  const fetchWithPolicy = async (url: string, init?: NxtFetchInit): Promise<NxtFetchResponse> =>
    backends.fetch(egressPolicy(binding), url, init)

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

  return {
    http: { fetch: fetchWithPolicy },
    secrets: {
      async get(key) {
        return backends.secret(binding, key)
      },
    },
    assets: {
      async create(input) {
        requireCapability(binding, 'assets', 'assets（生成频道文件）')
        return backends.createAsset(binding.channelId, input)
      },
      async fromUrl(url, options) {
        requireCapability(binding, 'assets', 'assets（生成频道文件）')
        const response = await fetchWithPolicy(url)
        if (response.status < 200 || response.status >= 300) {
          throw new Error(`下载失败：HTTP ${response.status}`)
        }
        return backends.createAsset(binding.channelId, {
          ...(response.base64 === undefined ? { text: response.text ?? '' } : { base64: response.base64 }),
          mediaType: response.contentType,
          ...(options?.name === undefined ? {} : { name: options.name }),
        })
      },
    },
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
            `没有声明平台动作 ${catalog.adapterKey}:${action}，请加入 permissions.capabilities.platform.actions。`,
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
            `没有声明 ${catalog.adapterKey} 的原始接口，请加入 permissions.capabilities.platform.raw。`,
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
            `读取机器人账号的平台 ID 需要声明 ${catalog.adapterKey} 的原始接口，请加入 permissions.capabilities.platform.raw。`,
          )
        }
        return backends.platform.selfPlatformUserId(binding.channelId)
      },
    },
    jobs: {
      async schedule(input) {
        const jobs = requireCapability(binding, 'jobs', 'jobs（定时任务）')
        if (jobs.runtime === undefined) {
          throw new NxtCapabilityError('运行时创建定时任务需要声明 permissions.capabilities.jobs.runtime.maxActive。')
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

/** Adapts a DSH agent Context to {@link NxtPromptRegistry}; registrations are effects of that Context. */
export const dshPromptRegistry = (context: Context, sessionId: string): NxtPromptRegistry => ({
  section: (section) => context.systemPrompt.section(section),
  context: (entry) => context.systemPrompt.context(entry),
  onTurnStart: (listener) =>
    context.on('agent/pre-step', async ({ agent, step }, next) => {
      if (step <= 1 && agent.id === sessionId) await listener()
      return next()
    }),
})

/**
 * `nxt` facade for dynamic runs, published with `context.set('nxt', …)`. The DSH dynamic sandbox lets a host half
 * reach Services it lists in `inject` and proxies their members; resolving per access follows the current candidate.
 */
export const createNxtDynamicFacade = (resolve: () => NxtHostService): NxtHostService => ({
  get http() {
    return resolve().http
  },
  get secrets() {
    return resolve().secrets
  },
  get assets() {
    return resolve().assets
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
