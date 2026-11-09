import { z } from 'zod'

/**
 * Host capability level this build implements. A Revision that declares `requires.sdk` above it is rejected at
 * import with an "upgrade NekroNXT" message instead of an opaque schema error. Bump when a Manifest capability
 * ships; never reuse a level for a different meaning. Level 7 is Manifest V7 (host instance + agent attachments); level 8 adds the asset library, image info, tool result
 * images, the search index and host-layer model calls. Level 9 adds the structured logger and explicit chat commands. Level 10 adds version lineage, the data version with its
 * migration hook and administrator-only commands. Level 11 lists the pictures of an inbound message to inbound hooks.
 * Level 12 adds credential placeholders (`secrets.placeholder`) that `http.fetch` fills for the credential's domains.
 * Level 13 adds outbound processing (`harness.onOutbound`, `permissions.agent.outbound`).
 * Level 14 adds work files (`files`), reading Asset bytes (`assets.read`), high-detail tool images (`toolImages`),
 * long-running tools (`timeoutSeconds`, `execute(args, { signal, progress })`), media processing (`media`), command
 * profiles (`commands`) and speech to text (`speech`).
 * Level 15 adds downloads into work files (`files.fromUrl`).
 * Level 16 adds declared member platform identities.
 */
export const EXTENSION_SDK_LEVEL = 16

/** Declared and approved member platform identities. */
export const EXTENSION_MEMBER_IDENTITIES_SDK_LEVEL = 16

/** `files.fromUrl` needs this level; it adds no declaration, so the host checks the level when it is called. */
export const EXTENSION_DOWNLOAD_SDK_LEVEL = 15

/** Largest response `http.fetch` holds in memory; bigger files go through `files.fromUrl`. */
export const EXTENSION_FETCH_MAX_BYTES = 32 * 1024 * 1024

/** Default 扩展下载上限: what one `files.fromUrl` may write until an administrator changes it. */
export const EXTENSION_DOWNLOAD_DEFAULT_BYTES = 1024 * 1024 * 1024

/** The highest 扩展下载上限 an administrator can set. */
export const EXTENSION_DOWNLOAD_MAX_BYTES = 5 * 1024 * 1024 * 1024

/** The lowest 扩展下载上限 an administrator can set. */
export const EXTENSION_DOWNLOAD_MIN_BYTES = 8 * 1024 * 1024

/** Work files, Asset reads, high-detail tool images, tool time limits, media, commands and speech need this level. */
export const EXTENSION_FILES_SDK_LEVEL = 14

/** Outbound processing needs this level; packages that declare `permissions.agent.outbound` declare it. */
export const EXTENSION_OUTBOUND_SDK_LEVEL = 13

/** Lineage, `dataVersion` and administrator-only commands need this level; packages that carry them declare it. */
export const EXTENSION_GOVERNANCE_SDK_LEVEL = 10

/**
 * The first NekroNXT version of each capability level, so users read "needs NekroNXT 0.5.0" rather than a level
 * number. Add the row for a new level in the change that raises EXTENSION_SDK_LEVEL; a test keeps the two in step.
 */
export const EXTENSION_SDK_RELEASES: readonly { readonly level: number; readonly version: string }[] = [
  { level: 6, version: '0.3.0' },
  { level: 7, version: '0.4.0' },
  { level: 8, version: '0.5.0' },
  { level: 9, version: '0.6.0' },
  { level: 10, version: '0.6.0' },
  { level: 11, version: '0.6.0' },
  { level: 12, version: '0.7.0' },
  { level: 13, version: '0.7.0' },
  { level: 14, version: '0.8.0' },
  { level: 15, version: '0.8.1' },
  { level: 16, version: '0.8.2' },
]

/** The oldest NekroNXT version that supports `level`; undefined for a level no release supports yet. */
export const extensionSdkVersion = (level: number): string | undefined =>
  EXTENSION_SDK_RELEASES.find((release) => release.level >= level)?.version

/** Manifest V7 itself; extensions that use nothing newer need this level. */
export const EXTENSION_SDK_BASE_LEVEL = 7

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

export const EXTENSION_OUTBOUND_MAX_TIMEOUT_MS = 15_000

/**
 * Outbound processing of the agent's own messages. `read` sees each message after it was delivered; `transform` may
 * replace its content or append messages before it is sent; `cancel` may stop it. `onTimeout` decides what happens
 * when the handler times out or throws before sending: `send` (default) sends the message as it is.
 */
export const ExtensionOutboundCapabilitySchema = z
  .object({
    read: z.literal(true).optional(),
    transform: z.literal(true).optional(),
    cancel: z.literal(true).optional(),
    timeoutMs: z.number().int().min(100).max(EXTENSION_OUTBOUND_MAX_TIMEOUT_MS),
    onTimeout: z.enum(['send', 'cancel']).optional(),
  })
  .strict()
  .refine(
    (value) => value.read === true || value.transform === true || value.cancel === true,
    'outbound 至少声明 read、transform 或 cancel 中的一项。',
  )
export type ExtensionOutboundCapability = z.output<typeof ExtensionOutboundCapabilitySchema>

/** Whether the extension takes part before sending (and so in the agent's processing order). */
export const outboundProcessesBeforeSend = (outbound: ExtensionOutboundCapability | undefined): boolean =>
  outbound?.transform === true || outbound?.cancel === true

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
 * used in any channel later; `read` reads the bytes of Assets the current channel can see or the library holds.
 */
export const ExtensionAssetsCapabilitySchema = z
  .object({
    write: z.literal(true).optional(),
    library: ExtensionAssetLibraryCapabilitySchema.optional(),
    read: z.literal(true).optional(),
  })
  .strict()
  .refine(
    (value) => value.write !== undefined || value.library !== undefined || value.read !== undefined,
    'assets 至少声明 write、library 或 read。',
  )
export type ExtensionAssetsCapability = z.output<typeof ExtensionAssetsCapabilitySchema>

export const EXTENSION_FILES_DEFAULT_TEMP_QUOTA_BYTES = 1024 * 1024 * 1024
export const EXTENSION_FILES_DEFAULT_CACHE_QUOTA_BYTES = 1024 * 1024 * 1024
export const EXTENSION_FILES_MAX_QUOTA_BYTES = 16 * 1024 * 1024 * 1024

const FilesQuotaSchema = z
  .number()
  .int()
  .min(1024 * 1024)
  .max(EXTENSION_FILES_MAX_QUOTA_BYTES)

/**
 * Work files passed between services by `fileId`. Temporary files expire a day after they are written; cache entries
 * stay until the cache quota is full, then the least recently used go first.
 */
export const ExtensionFilesCapabilitySchema = z
  .object({ tempQuotaBytes: FilesQuotaSchema.optional(), cacheQuotaBytes: FilesQuotaSchema.optional() })
  .strict()
export type ExtensionFilesCapability = z.output<typeof ExtensionFilesCapabilitySchema>

/** Tool result pictures with `detail: 'high'` reach the model at up to 2048 px on the long side. */
export const ExtensionToolImagesCapabilitySchema = z.object({ highDetail: z.literal(true) }).strict()
export type ExtensionToolImagesCapability = z.output<typeof ExtensionToolImagesCapabilitySchema>

/**
 * Add-ons (附加功能) whose capability an extension can use. The ids match `AddonIdSchema` in host-api; they are
 * repeated here so manifests validate without it.
 */
export type ExtensionAddonId = 'media' | 'speech'

/**
 * Command profiles extensions may run (`nxt.commands`, 附加功能 F7), and the add-on that provides each program. A new
 * program needs a profile on the server and a row here.
 */
export const ExtensionCommandProfileIdSchema = z.enum(['ffmpeg', 'ffprobe'], {
  message: '命令档案只能是 ffmpeg、ffprobe。',
})
export type ExtensionCommandProfileId = z.output<typeof ExtensionCommandProfileIdSchema>

export const EXTENSION_COMMAND_PROFILES: Readonly<Record<ExtensionCommandProfileId, ExtensionAddonId>> = {
  ffmpeg: 'media',
  ffprobe: 'media',
}

/** Programs run through their command profiles: confined to the call's own files, without network. */
export const ExtensionCommandsCapabilitySchema = z
  .object({
    profiles: z
      .array(ExtensionCommandProfileIdSchema)
      .min(1)
      .max(ExtensionCommandProfileIdSchema.options.length)
      .refine((value) => new Set(value).size === value.length, '命令档案不能重复。'),
  })
  .strict()
export type ExtensionCommandsCapability = z.output<typeof ExtensionCommandsCapabilitySchema>

export const EXTENSION_SPEECH_MAX_CALLS_PER_MINUTE = 60
export const EXTENSION_SPEECH_DEFAULT_CALLS_PER_MINUTE = 10

/** Speech to text with the provider chosen in 设置 → 附加功能, which may be a cloud service. */
export const ExtensionSpeechCapabilitySchema = z
  .object({
    maxCallsPerMinute: z
      .number()
      .int()
      .min(1)
      .max(EXTENSION_SPEECH_MAX_CALLS_PER_MINUTE)
      .default(EXTENSION_SPEECH_DEFAULT_CALLS_PER_MINUTE),
  })
  .strict()
export type ExtensionSpeechCapability = z.output<typeof ExtensionSpeechCapabilitySchema>

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

/**
 * A header or environment value: literal text, the current value of a `meta.role: 'secret'` config field, or a named
 * credential (by id or name) that the agent may use.
 */
export const ExtensionMcpValueSchema = z.union([
  z.string().max(4096),
  z.object({ secret: z.string().trim().min(1).max(64) }).strict(),
  z.object({ credential: z.string().trim().min(1).max(64) }).strict(),
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
    /** Takes the value from this named credential instead; `value` and `secret` are then ignored. */
    credential: z.string().trim().min(1).max(64).optional(),
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
        typeof value === 'string' || !('secret' in value) ? [] : [value.secret],
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
    files: ExtensionFilesCapabilitySchema.optional(),
    toolImages: ExtensionToolImagesCapabilitySchema.optional(),
    /** `nxt.media`: probe, frames, audio and convert on the media add-on. */
    media: z.literal(true).optional(),
    commands: ExtensionCommandsCapabilitySchema.optional(),
    speech: ExtensionSpeechCapabilitySchema.optional(),
    index: ExtensionIndexCapabilitySchema.optional(),
    /** Host layer only; the agent layer uses `llm`, which runs on the agent's own model. */
    models: ExtensionModelsCapabilitySchema.optional(),
    history: z
      .object({ read: z.literal(true) })
      .strict()
      .optional(),
    members: z
      .object({ identities: z.literal(true) })
      .strict()
      .optional(),
    inboundHook: ExtensionInboundHookCapabilitySchema.optional(),
    outbound: ExtensionOutboundCapabilitySchema.optional(),
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
    /**
     * The same library agent attachments use; the host instance lists and imports into it. `read` reads the bytes of
     * library Assets.
     */
    assets: z
      .object({ library: ExtensionAssetLibraryCapabilitySchema.optional(), read: z.literal(true).optional() })
      .strict()
      .refine((value) => value.library !== undefined || value.read !== undefined, 'assets 至少声明 library 或 read。')
      .optional(),
    files: ExtensionFilesCapabilitySchema.optional(),
    media: z.literal(true).optional(),
    commands: ExtensionCommandsCapabilitySchema.optional(),
    speech: ExtensionSpeechCapabilitySchema.optional(),
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
        ...(host.assets === undefined
          ? {}
          : {
              assets: {
                ...(host.assets.library === undefined ? {} : { library: host.assets.library }),
                ...(host.assets.read === undefined ? {} : { read: host.assets.read }),
              },
            }),
        ...(host.files === undefined ? {} : { files: host.files }),
        ...(host.media === undefined ? {} : { media: host.media }),
        ...(host.commands === undefined ? {} : { commands: host.commands }),
        ...(host.speech === undefined ? {} : { speech: host.speech }),
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
  if (next.assets?.read !== undefined && previous?.assets?.read === undefined) return true
  if (next.files !== undefined && previous?.files === undefined) return true
  if (next.toolImages !== undefined && previous?.toolImages === undefined) return true
  if (next.media !== undefined && previous?.media === undefined) return true
  if ((next.commands?.profiles ?? []).some((profile) => !(previous?.commands?.profiles ?? []).includes(profile))) {
    return true
  }
  if (
    next.speech !== undefined &&
    (previous?.speech === undefined || next.speech.maxCallsPerMinute > previous.speech.maxCallsPerMinute)
  ) {
    return true
  }
  if (
    next.models !== undefined &&
    (previous?.models === undefined ||
      next.models.maxCallsPerMinute > previous.models.maxCallsPerMinute ||
      next.models.maxOutputTokens > previous.models.maxOutputTokens)
  ) {
    return true
  }
  if (next.history !== undefined && previous?.history === undefined) return true
  if (next.members?.identities === true && previous?.members?.identities !== true) return true
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
  const outbound = next.outbound
  const previousOutbound = previous?.outbound
  if (
    outbound !== undefined &&
    (previousOutbound === undefined ||
      (outbound.read === true && previousOutbound.read !== true) ||
      (outbound.transform === true && previousOutbound.transform !== true) ||
      (outbound.cancel === true && previousOutbound.cancel !== true) ||
      (outbound.onTimeout === 'cancel' && previousOutbound.onTimeout !== 'cancel'))
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
  bytes >= 1024 * 1024 * 1024
    ? `${+(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
    : `${Math.round(bytes / 1024 / 1024)} MB`

/** Capability risk tiers shown on the approval page (§7 of the capability decision). */
export type ExtensionCapabilityRisk = 'normal' | 'sensitive' | 'high'

export interface ExtensionCapabilitySummaryItem {
  readonly key: string
  readonly risk: ExtensionCapabilityRisk
  readonly label: string
  readonly detail?: string
  /** For a high-risk capability with limits: what it stays within, shown where the user accepts the risk. */
  readonly scope?: string
}

/**
 * Add-ons the declared capabilities need (附加功能 F13), in a stable order: `media` needs 媒体处理, `speech` needs
 * 语音识别, and each command profile needs the add-on that provides its program. Pass both layers, host-layer ones
 * through {@link hostLayerAsCapabilities}.
 */
export const requiredExtensionAddons = (
  ...layers: readonly (ExtensionCapabilities | undefined)[]
): readonly ExtensionAddonId[] => {
  const needed = new Set<ExtensionAddonId>()
  for (const capabilities of layers) {
    if (capabilities?.media !== undefined) needed.add('media')
    if (capabilities?.speech !== undefined) needed.add('speech')
    for (const profile of capabilities?.commands?.profiles ?? []) needed.add(EXTENSION_COMMAND_PROFILES[profile])
  }
  return (['media', 'speech'] as const).filter((id) => needed.has(id))
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
  if (capabilities.assets?.read !== undefined) {
    items.push(
      options.layer === 'host'
        ? { key: 'assets.read', risk: 'normal', label: '读取扩展资源库里的文件' }
        : { key: 'assets.read', risk: 'sensitive', label: '读取当前频道里的图片和文件' },
    )
  }
  if (capabilities.files !== undefined) {
    items.push({
      key: 'files',
      risk: 'normal',
      label: '在本机存放临时文件和缓存',
      detail: `临时文件最多 ${formatLibraryQuota(capabilities.files.tempQuotaBytes ?? EXTENSION_FILES_DEFAULT_TEMP_QUOTA_BYTES)}，缓存最多 ${formatLibraryQuota(capabilities.files.cacheQuotaBytes ?? EXTENSION_FILES_DEFAULT_CACHE_QUOTA_BYTES)}`,
    })
  }
  if (capabilities.toolImages !== undefined) {
    items.push({
      key: 'toolImages',
      risk: 'normal',
      label: '以高细节向智能体展示图片',
      detail: '计入智能体用量',
    })
  }
  if (capabilities.media !== undefined) {
    items.push({ key: 'media', risk: 'normal', label: '处理音频、视频和图片' })
  }
  if (capabilities.commands !== undefined) {
    items.push({
      key: 'commands',
      risk: 'high',
      label: '在本机运行程序',
      detail: capabilities.commands.profiles.join('、'),
      scope: '只能读写交给它的文件，不能联网',
    })
  }
  if (capabilities.speech !== undefined) {
    items.push({
      key: 'speech',
      risk: 'sensitive',
      label: '把音频转成文字',
      detail: `音频可能发给「设置 → 附加功能」里选择的语音识别服务，每分钟最多 ${capabilities.speech.maxCallsPerMinute} 次`,
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
  if (capabilities.members?.identities === true) {
    items.push({
      key: 'members.identities',
      risk: 'sensitive',
      label: '读取成员的平台账号和身份',
      detail: '可关联同一连接的不同频道中的成员',
    })
  }
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
  const outbound = capabilities.outbound
  if (outbound !== undefined) {
    if (outbound.transform === true) {
      items.push({ key: 'outbound.transform', risk: 'high', label: '在智能体的消息发出前修改内容或追加消息' })
    }
    if (outbound.cancel === true) {
      items.push({ key: 'outbound.cancel', risk: 'high', label: '取消智能体要发出的消息' })
    }
    if (outbound.read === true) {
      items.push({ key: 'outbound.read', risk: 'sensitive', label: '查看智能体发出的每条消息' })
    }
    if (outbound.onTimeout === 'cancel' && (outbound.transform === true || outbound.cancel === true)) {
      items.push({ key: 'outbound.onTimeout', risk: 'high', label: '这个扩展出错时，智能体的消息会发不出去' })
    }
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
