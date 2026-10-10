import { z } from 'zod'

/**
 * Host capability level this build implements. A Revision that declares `requires.sdk` above it is rejected at
 * import with an "upgrade NekroNXT" message instead of an opaque schema error. Bump when a Manifest capability
 * ships; never reuse a level for a different meaning. Level 7 is Manifest V7 (host instance + agent attachments); level 8 adds the asset library, image info, tool result
 * images, the search index and host-layer model calls.
 */
export const EXTENSION_SDK_LEVEL = 8

export const ExtensionRequiresSchema = z.object({ sdk: z.number().int().min(1).max(1000) }).strict()
export type ExtensionRequires = z.output<typeof ExtensionRequiresSchema>

/** `api.example.com` or `*.example.com` (subdomains only); lower-case DNS labels, no scheme, port or path. */
export const ExtensionNetworkDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^(\*\.)?(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u, {
    message: '网络域名必须是 api.example.com 或 *.example.com 形式，不含协议、端口和路径。',
  })

export const ExtensionNetworkCapabilitySchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('domains'),
      domains: z.array(ExtensionNetworkDomainSchema).min(1).max(32),
    })
    .strict(),
  z
    .object({
      mode: z.literal('config'),
      /** Top-level config fields whose current value is a URL or host the user typed. */
      fields: z.array(z.string().trim().min(1).max(64)).min(1).max(8),
    })
    .strict(),
  z
    .object({
      mode: z.literal('unrestricted'),
      /** Shown to the user next to the risk acknowledgement. */
      purpose: z.string().trim().min(4).max(200),
    })
    .strict(),
])
export type ExtensionNetworkCapability = z.output<typeof ExtensionNetworkCapabilitySchema>

export const EXTENSION_STORAGE_SCOPES = ['agent', 'channel', 'member', 'shared'] as const
export const ExtensionStorageScopeSchema = z.enum(EXTENSION_STORAGE_SCOPES)
export type ExtensionStorageScope = z.output<typeof ExtensionStorageScopeSchema>

export const EXTENSION_STORAGE_DEFAULT_QUOTA_BYTES = 8 * 1024 * 1024
export const EXTENSION_STORAGE_MAX_QUOTA_BYTES = 64 * 1024 * 1024

export const ExtensionStorageCapabilitySchema = z
  .object({
    scopes: z.array(ExtensionStorageScopeSchema).min(1).max(EXTENSION_STORAGE_SCOPES.length),
    quotaBytes: z.number().int().min(1024).max(EXTENSION_STORAGE_MAX_QUOTA_BYTES).optional(),
  })
  .strict()
  .refine((value) => new Set(value.scopes).size === value.scopes.length, '存储作用域不能重复。')
export type ExtensionStorageCapability = z.output<typeof ExtensionStorageCapabilitySchema>

export const EXTENSION_CONTEXT_STATIC_MAX_CHARS = 4000
export const EXTENSION_CONTEXT_DYNAMIC_MAX_CHARS = 2000

export const ExtensionContextContributionSchema = z
  .object({
    name: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9-]{0,39}$/u, '上下文名称只能使用小写字母、数字和连字符。'),
    kind: z.enum(['static', 'dynamic']),
    maxChars: z.number().int().min(1).max(EXTENSION_CONTEXT_STATIC_MAX_CHARS),
  })
  .strict()
  .refine(
    (value) => value.kind === 'static' || value.maxChars <= EXTENSION_CONTEXT_DYNAMIC_MAX_CHARS,
    `动态上下文最多 ${EXTENSION_CONTEXT_DYNAMIC_MAX_CHARS} 字。`,
  )
export type ExtensionContextContribution = z.output<typeof ExtensionContextContributionSchema>

export const EXTENSION_LLM_MAX_CALLS_PER_TURN = 20
export const EXTENSION_LLM_MAX_OUTPUT_TOKENS = 8192

export const ExtensionLlmCapabilitySchema = z
  .object({
    maxCallsPerTurn: z.number().int().min(1).max(EXTENSION_LLM_MAX_CALLS_PER_TURN),
    maxOutputTokens: z.number().int().min(64).max(EXTENSION_LLM_MAX_OUTPUT_TOKENS),
  })
  .strict()
export type ExtensionLlmCapability = z.output<typeof ExtensionLlmCapabilitySchema>

export const EXTENSION_INBOUND_HOOK_MAX_TIMEOUT_MS = 15_000

export const ExtensionInboundHookCapabilitySchema = z
  .object({
    /** `triggered`: only messages that would wake the agent anyway; `all`: every message in bound channels. */
    reads: z.enum(['triggered', 'all']),
    mayHide: z.boolean(),
    mayForceTrigger: z.boolean(),
    timeoutMs: z.number().int().min(100).max(EXTENSION_INBOUND_HOOK_MAX_TIMEOUT_MS),
  })
  .strict()
export type ExtensionInboundHookCapability = z.output<typeof ExtensionInboundHookCapabilitySchema>

export const EXTENSION_JOB_MAX_RUNTIME = 50

export const ExtensionDeclaredJobSchema = z
  .object({
    id: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9-]{0,39}$/u, '定时任务 id 只能使用小写字母、数字和连字符。'),
    label: z.string().trim().min(1).max(200),
    cron: z.string().trim().min(9).max(120),
    timezone: z.string().trim().min(1).max(64).optional(),
  })
  .strict()
export type ExtensionDeclaredJob = z.output<typeof ExtensionDeclaredJobSchema>

export const ExtensionJobsCapabilitySchema = z
  .object({
    /** Fixed schedules; each fires in every channel bound to the agent that enables the extension. */
    declared: z
      .array(ExtensionDeclaredJobSchema)
      .max(8)
      .refine((jobs) => new Set(jobs.map(({ id }) => id)).size === jobs.length, '定时任务 id 不能重复。')
      .optional(),
    /** Jobs the extension creates at runtime (`ctx.nxt.jobs.schedule`), at most this many active per agent. */
    runtime: z
      .object({ maxActive: z.number().int().min(1).max(EXTENSION_JOB_MAX_RUNTIME) })
      .strict()
      .optional(),
  })
  .strict()
export type ExtensionJobsCapability = z.output<typeof ExtensionJobsCapabilitySchema>

const AdapterKeySchema = z.string().trim().min(1).max(64)

export const ExtensionPlatformCapabilitySchema = z
  .object({
    /** Typed actions an Adapter declares, as `{ adapter, action }`. */
    actions: z
      .array(z.object({ adapter: AdapterKeySchema, action: z.string().regex(/^[a-z0-9_]{1,64}$/u) }).strict())
      .max(32)
      .default([]),
    /** Adapters whose raw API passthrough the extension may call. */
    raw: z.array(AdapterKeySchema).max(8).default([]),
  })
  .strict()
export type ExtensionPlatformCapability = z.output<typeof ExtensionPlatformCapabilitySchema>

export const EXTENSION_ASSET_LIBRARY_DEFAULT_QUOTA_BYTES = 2 * 1024 * 1024 * 1024
export const EXTENSION_ASSET_LIBRARY_MAX_QUOTA_BYTES = 32 * 1024 * 1024 * 1024

export const ExtensionAssetLibraryCapabilitySchema = z
  .object({
    quotaBytes: z
      .number()
      .int()
      .min(1024 * 1024)
      .max(EXTENSION_ASSET_LIBRARY_MAX_QUOTA_BYTES)
      .optional(),
  })
  .strict()
export type ExtensionAssetLibraryCapability = z.output<typeof ExtensionAssetLibraryCapabilitySchema>

/**
 * `write` creates Assets in the current channel; `library` keeps Assets in the extension's own library so they can be
 * used in any channel later.
 */
export const ExtensionAssetsCapabilitySchema = z
  .object({
    write: z.literal(true).optional(),
    library: ExtensionAssetLibraryCapabilitySchema.optional(),
  })
  .strict()
  .refine((value) => value.write !== undefined || value.library !== undefined, 'assets 至少声明 write 或 library。')
export type ExtensionAssetsCapability = z.output<typeof ExtensionAssetsCapabilitySchema>

const IndexNameSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{0,31}$/u, '索引、字段和过滤项名称只能使用小写字母、数字和下划线，以字母开头。')

export const EXTENSION_INDEX_MAX_TEXT_FIELDS = 4
export const EXTENSION_INDEX_MAX_FILTERS = 4

/**
 * One searchable collection. Text fields are matched by keywords (and vectors when the Host has them enabled); weights
 * rank keyword matches. Filter fields hold short keyword values, possibly several per document.
 */
export const ExtensionIndexCollectionSchema = z
  .object({
    name: IndexNameSchema,
    fields: z
      .array(z.object({ name: IndexNameSchema, weight: z.number().min(0.1).max(10).default(1) }).strict())
      .min(1)
      .max(EXTENSION_INDEX_MAX_TEXT_FIELDS),
    filters: z.array(IndexNameSchema).max(EXTENSION_INDEX_MAX_FILTERS).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    const names = [...value.fields.map(({ name }) => name), ...value.filters]
    if (new Set(names).size !== names.length) {
      context.addIssue({ code: 'custom', message: '同一索引里的字段与过滤项不能重名。' })
    }
  })
export type ExtensionIndexCollection = z.output<typeof ExtensionIndexCollectionSchema>

export const ExtensionIndexCapabilitySchema = z
  .object({
    collections: z
      .array(ExtensionIndexCollectionSchema)
      .min(1)
      .max(4)
      .refine((value) => new Set(value.map(({ name }) => name)).size === value.length, '索引名称不能重复。'),
  })
  .strict()
export type ExtensionIndexCapability = z.output<typeof ExtensionIndexCapabilitySchema>

export const EXTENSION_MODEL_MAX_CALLS_PER_MINUTE = 120

/** Calls to a model the user picks from the Host's configured models, with images allowed; host layer only. */
export const ExtensionModelsCapabilitySchema = z
  .object({
    maxCallsPerMinute: z.number().int().min(1).max(EXTENSION_MODEL_MAX_CALLS_PER_MINUTE),
    maxOutputTokens: z.number().int().min(64).max(EXTENSION_LLM_MAX_OUTPUT_TOKENS),
  })
  .strict()
export type ExtensionModelsCapability = z.output<typeof ExtensionModelsCapabilitySchema>

/** A header or environment value: literal text, or the current value of a `meta.role: 'secret'` config field. */
export const ExtensionMcpValueSchema = z.union([
  z.string().max(4096),
  z.object({ secret: z.string().trim().min(1).max(64) }).strict(),
])
export type ExtensionMcpValue = z.output<typeof ExtensionMcpValueSchema>

/** Becomes the model-facing tool prefix `mcp__<name>__`. */
export const ExtensionMcpServerNameSchema = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/u)

const McpValueMapSchema = z
  .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/u), ExtensionMcpValueSchema)
  .refine((value) => Object.keys(value).length <= 32, '最多 32 项。')
  .default({})

export const ExtensionMcpServerSchema = z.discriminatedUnion('transport', [
  z
    .object({
      transport: z.literal('streamable-http'),
      name: ExtensionMcpServerNameSchema,
      url: z
        .string()
        .url()
        .refine((value) => /^https?:\/\//iu.test(value), 'MCP 地址必须是 http 或 https。'),
      headers: McpValueMapSchema,
    })
    .strict(),
  z
    .object({
      transport: z.literal('stdio'),
      name: ExtensionMcpServerNameSchema,
      command: z.string().trim().min(1).max(512),
      args: z.array(z.string().max(4096)).max(64).default([]),
      env: McpValueMapSchema,
    })
    .strict(),
])
export type ExtensionMcpServer = z.output<typeof ExtensionMcpServerSchema>

/**
 * MCP servers the Host connects for the agent while the extension is enabled; their tools appear as
 * `mcp__<name>__<tool>`. `stdio` runs a program on the Host and is only created from the administrator's form.
 */
export const ExtensionMcpCapabilitySchema = z
  .object({
    servers: z
      .array(ExtensionMcpServerSchema)
      .min(1)
      .max(8)
      .refine((value) => new Set(value.map(({ name }) => name)).size === value.length, 'MCP 服务名称不能重复。'),
  })
  .strict()
export type ExtensionMcpCapability = z.output<typeof ExtensionMcpCapabilitySchema>

/** One header or environment row of the administrator's form; secret rows become credential config fields. */
const McpFormValueSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/u, '名称只能包含字母、数字、下划线和连字符。'),
    value: z.string().max(4096),
    secret: z.boolean().default(false),
  })
  .strict()

export const McpServerFormSchema = z.discriminatedUnion('transport', [
  z
    .object({
      transport: z.literal('streamable-http'),
      name: ExtensionMcpServerNameSchema,
      url: z.string().url(),
      headers: z.array(McpFormValueSchema).max(32).default([]),
    })
    .strict(),
  z
    .object({
      transport: z.literal('stdio'),
      name: ExtensionMcpServerNameSchema,
      command: z.string().trim().min(1).max(512),
      args: z.array(z.string().max(4096)).max(64).default([]),
      env: z.array(McpFormValueSchema).max(32).default([]),
    })
    .strict(),
])
export type McpServerForm = z.output<typeof McpServerFormSchema>

/** Secret config fields an MCP declaration reads. */
export const mcpSecretFields = (mcp: ExtensionMcpCapability | undefined): readonly string[] => [
  ...new Set(
    (mcp?.servers ?? []).flatMap((server) =>
      Object.values(server.transport === 'stdio' ? server.env : server.headers).flatMap((value) =>
        typeof value === 'string' ? [] : [value.secret],
      ),
    ),
  ),
]

/** What a server connects to; changing it needs a new approval, unlike its credentials. */
const mcpTarget = (server: ExtensionMcpServer): string =>
  server.transport === 'stdio'
    ? JSON.stringify(['stdio', server.name, server.command, server.args])
    : JSON.stringify(['streamable-http', server.name, server.url])

/**
 * Agent-layer capabilities (`permissions.agent`): what the extension may do inside the agents it is enabled for. An
 * absent field means the extension cannot use that capability.
 */
export const ExtensionCapabilitiesSchema = z
  .object({
    network: ExtensionNetworkCapabilitySchema.optional(),
    storage: ExtensionStorageCapabilitySchema.optional(),
    assets: ExtensionAssetsCapabilitySchema.optional(),
    index: ExtensionIndexCapabilitySchema.optional(),
    /** Host layer only; the agent layer uses `llm`, which runs on the agent's own model. */
    models: ExtensionModelsCapabilitySchema.optional(),
    history: z
      .object({ read: z.literal(true) })
      .strict()
      .optional(),
    inboundHook: ExtensionInboundHookCapabilitySchema.optional(),
    jobs: ExtensionJobsCapabilitySchema.optional(),
    platform: ExtensionPlatformCapabilitySchema.optional(),
    llm: ExtensionLlmCapabilitySchema.optional(),
    mcp: ExtensionMcpCapabilitySchema.optional(),
    context: z
      .array(ExtensionContextContributionSchema)
      .max(8)
      .refine((value) => new Set(value.map(({ name }) => name)).size === value.length, '上下文名称不能重复。')
      .optional(),
  })
  .strict()
export type ExtensionCapabilities = z.output<typeof ExtensionCapabilitiesSchema>

/**
 * Host-layer capabilities (`permissions.host`): what the extension's single host instance may do through the `nxt`
 * service its factory receives. Host storage is the extension's `shared` partition.
 */
export const HostLayerCapabilitiesSchema = z
  .object({
    network: ExtensionNetworkCapabilitySchema.optional(),
    storage: z
      .object({ quotaBytes: z.number().int().min(1024).max(EXTENSION_STORAGE_MAX_QUOTA_BYTES).optional() })
      .strict()
      .optional(),
    /** The same library agent attachments use; the host instance lists and imports into it. */
    assets: z.object({ library: ExtensionAssetLibraryCapabilitySchema }).strict().optional(),
    /** The same collections agent attachments declare; pages search and maintain them. */
    index: ExtensionIndexCapabilitySchema.optional(),
    models: ExtensionModelsCapabilitySchema.optional(),
  })
  .strict()
export type HostLayerCapabilities = z.output<typeof HostLayerCapabilitiesSchema>

/** Host-layer capabilities in the agent-capability shape, so digests, expansion and summaries share one implementation. */
export const hostLayerAsCapabilities = (host: HostLayerCapabilities | undefined): ExtensionCapabilities | undefined =>
  host === undefined || Object.keys(host).length === 0
    ? undefined
    : {
        ...(host.network === undefined ? {} : { network: host.network }),
        ...(host.storage === undefined
          ? {}
          : {
              storage: {
                scopes: ['shared'],
                ...(host.storage.quotaBytes === undefined ? {} : { quotaBytes: host.storage.quotaBytes }),
              },
            }),
        ...(host.assets === undefined ? {} : { assets: { library: host.assets.library } }),
        ...(host.index === undefined ? {} : { index: host.index }),
        ...(host.models === undefined ? {} : { models: host.models }),
      }

const NETWORK_MODE_RANK = { domains: 0, config: 1, unrestricted: 2 } as const

const networkExpands = (
  previous: ExtensionNetworkCapability | undefined,
  next: ExtensionNetworkCapability | undefined,
): boolean => {
  if (next === undefined) return false
  if (previous === undefined) return true
  if (NETWORK_MODE_RANK[next.mode] !== NETWORK_MODE_RANK[previous.mode]) {
    return NETWORK_MODE_RANK[next.mode] > NETWORK_MODE_RANK[previous.mode]
  }
  if (next.mode === 'domains' && previous.mode === 'domains') {
    return next.domains.some((domain) => !previous.domains.includes(domain))
  }
  if (next.mode === 'config' && previous.mode === 'config') {
    return next.fields.some((field) => !previous.fields.includes(field))
  }
  return false
}

/**
 * Whether `next` asks for something an approval of `previous` did not cover. Narrowing never needs approval;
 * storage quota is bounded by the Host maximum and is not an expansion. Context contributions are capped text
 * shown in the trace, so adding one is not an expansion either.
 */
export const extensionCapabilitiesExpand = (
  previous: ExtensionCapabilities | undefined,
  next: ExtensionCapabilities | undefined,
): boolean => {
  if (next === undefined) return false
  if (networkExpands(previous?.network, next.network)) return true
  if (next.storage?.scopes.some((scope) => !(previous?.storage?.scopes ?? []).includes(scope))) return true
  if (next.assets?.write !== undefined && previous?.assets?.write === undefined) return true
  if (next.assets?.library !== undefined && previous?.assets?.library === undefined) return true
  if (
    next.models !== undefined &&
    (previous?.models === undefined ||
      next.models.maxCallsPerMinute > previous.models.maxCallsPerMinute ||
      next.models.maxOutputTokens > previous.models.maxOutputTokens)
  ) {
    return true
  }
  if (next.history !== undefined && previous?.history === undefined) return true
  const platformKey = ({ adapter, action }: { readonly adapter: string; readonly action: string }) =>
    `${adapter}:${action}`
  const previousActions = new Set((previous?.platform?.actions ?? []).map(platformKey))
  if ((next.platform?.actions ?? []).some((entry) => !previousActions.has(platformKey(entry)))) return true
  if ((next.platform?.raw ?? []).some((adapter) => !(previous?.platform?.raw ?? []).includes(adapter))) return true
  const hook = next.inboundHook
  const previousHook = previous?.inboundHook
  if (
    hook !== undefined &&
    (previousHook === undefined ||
      (hook.reads === 'all' && previousHook.reads === 'triggered') ||
      (hook.mayHide && !previousHook.mayHide) ||
      (hook.mayForceTrigger && !previousHook.mayForceTrigger))
  ) {
    return true
  }
  if (
    next.jobs?.runtime !== undefined &&
    (previous?.jobs?.runtime === undefined || next.jobs.runtime.maxActive > previous.jobs.runtime.maxActive)
  ) {
    return true
  }
  const previousMcp = new Set((previous?.mcp?.servers ?? []).map(mcpTarget))
  if ((next.mcp?.servers ?? []).some((server) => !previousMcp.has(mcpTarget(server)))) return true
  if (
    next.llm !== undefined &&
    (previous?.llm === undefined ||
      next.llm.maxCallsPerTurn > previous.llm.maxCallsPerTurn ||
      next.llm.maxOutputTokens > previous.llm.maxOutputTokens)
  ) {
    return true
  }
  return false
}

const formatLibraryQuota = (bytes: number): string =>
  bytes >= 1024 * 1024 * 1024 ? `${+(bytes / 1024 / 1024 / 1024).toFixed(1)} GB` : `${Math.round(bytes / 1024 / 1024)} MB`

/** Capability risk tiers shown on the approval page (§7 of the capability decision). */
export type ExtensionCapabilityRisk = 'normal' | 'sensitive' | 'high'

export interface ExtensionCapabilitySummaryItem {
  readonly key: string
  readonly risk: ExtensionCapabilityRisk
  readonly label: string
  readonly detail?: string
}

/**
 * User-facing summary of declared capabilities, in a stable order, for approval and inspection pages. `layer: 'host'`
 * phrases host-layer capabilities (passed through {@link hostLayerAsCapabilities}) for the host instance.
 */
export const summarizeExtensionCapabilities = (
  capabilities: ExtensionCapabilities | undefined,
  options: {
    readonly layer?: 'host' | 'agent'
    /** Display name of a config field, so `network.mode: 'config'` names the fields as the user knows them. */
    readonly fieldTitle?: (key: string) => string
  } = {},
): readonly ExtensionCapabilitySummaryItem[] => {
  if (capabilities === undefined) return []
  const items: ExtensionCapabilitySummaryItem[] = []
  const network = capabilities.network
  if (network?.mode === 'domains') {
    items.push({ key: 'network', risk: 'normal', label: '访问指定网站', detail: network.domains.join('、') })
  } else if (network?.mode === 'config') {
    items.push({
      key: 'network',
      risk: 'normal',
      label: '访问你在配置中填写的地址',
      detail: network.fields.map((field) => options.fieldTitle?.(field) ?? field).join('、'),
    })
  } else if (network?.mode === 'unrestricted') {
    items.push({ key: 'network', risk: 'high', label: '访问任意公网地址', detail: network.purpose })
  }
  if (capabilities.storage !== undefined && options.layer === 'host') {
    items.push({ key: 'storage', risk: 'normal', label: '在本机保存扩展数据，页面与启用它的智能体共用' })
  } else if (capabilities.storage !== undefined) {
    const shared = capabilities.storage.scopes.includes('shared')
    items.push({
      key: 'storage',
      risk: shared ? 'sensitive' : 'normal',
      label: shared ? '保存数据，并在启用它的智能体之间共享' : '为这个智能体保存数据',
    })
  }
  if (capabilities.assets?.write !== undefined)
    items.push({ key: 'assets', risk: 'normal', label: '在当前频道生成图片或文件' })
  if (capabilities.assets?.library !== undefined) {
    items.push({
      key: 'assets.library',
      risk: 'sensitive',
      label: '把频道里的图片收进扩展资源库，之后可以在其他频道使用',
      detail: `最多 ${formatLibraryQuota(capabilities.assets.library.quotaBytes ?? EXTENSION_ASSET_LIBRARY_DEFAULT_QUOTA_BYTES)}`,
    })
  }
  if (capabilities.index !== undefined) {
    items.push({
      key: 'index',
      risk: 'normal',
      label: '建立可搜索的索引',
      detail: capabilities.index.collections.map(({ name }) => name).join('、'),
    })
  }
  if (capabilities.models !== undefined) {
    items.push({
      key: 'models',
      risk: 'sensitive',
      label: '使用本机已配置的模型，可以发送图片',
      detail: `每分钟最多 ${capabilities.models.maxCallsPerMinute} 次，计入所选模型的用量`,
    })
  }
  if (capabilities.history !== undefined)
    items.push({ key: 'history', risk: 'normal', label: '读取当前频道的聊天记录' })
  const hook = capabilities.inboundHook
  if (hook !== undefined) {
    const effects = [
      hook.mayHide ? '对智能体隐藏消息' : '',
      hook.mayForceTrigger ? '让智能体回应原本不会回应的消息' : '',
    ]
      .filter((effect) => effect !== '')
      .join('、')
    items.push({
      key: 'inboundHook',
      risk: hook.reads === 'all' ? 'high' : 'sensitive',
      label: hook.reads === 'all' ? '查看频道里的全部消息' : '在智能体回应前查看要回应的消息',
      ...(effects === '' ? {} : { detail: `可以${effects}` }),
    })
  }
  const jobs = capabilities.jobs
  if (jobs?.declared !== undefined && jobs.declared.length > 0) {
    items.push({
      key: 'jobs.declared',
      risk: 'normal',
      label: '按固定计划唤醒智能体',
      detail: jobs.declared.map(({ label }) => label).join('、'),
    })
  }
  if (jobs?.runtime !== undefined) {
    items.push({
      key: 'jobs.runtime',
      risk: 'sensitive',
      label: '创建定时任务唤醒智能体',
      detail: `同时最多 ${jobs.runtime.maxActive} 个`,
    })
  }
  const platform = capabilities.platform
  if (platform !== undefined && platform.actions.length > 0) {
    items.push({
      key: 'platform.actions',
      // Actions such as muting or removing members affect other people, so every typed action is confirmed.
      risk: 'high',
      label: '在平台上执行操作',
      detail: platform.actions.map(({ adapter, action }) => `${adapter} · ${action}`).join('、'),
    })
  }
  if (platform !== undefined && platform.raw.length > 0) {
    items.push({
      key: 'platform.raw',
      risk: 'high',
      label: '直接调用平台原始接口',
      detail: platform.raw.join('、'),
    })
  }
  if (capabilities.llm !== undefined) {
    items.push({
      key: 'llm',
      risk: 'sensitive',
      label: '使用这个智能体的模型',
      detail: `每轮最多 ${capabilities.llm.maxCallsPerTurn} 次，计入智能体用量`,
    })
  }
  for (const server of capabilities.mcp?.servers ?? []) {
    items.push(
      server.transport === 'stdio'
        ? {
            key: `mcp.${server.name}`,
            risk: 'high',
            label: `在本机运行 MCP 程序 ${server.name}`,
            detail: [server.command, ...server.args].join(' '),
          }
        : {
            key: `mcp.${server.name}`,
            risk: 'sensitive',
            label: `连接 MCP 服务 ${server.name}`,
            detail: new URL(server.url).host,
          },
    )
  }
  if (capabilities.context !== undefined && capabilities.context.length > 0) {
    items.push({
      key: 'context',
      risk: 'normal',
      label: '向智能体提供补充说明',
      detail: capabilities.context.map(({ name }) => name).join('、'),
    })
  }
  return items
}
