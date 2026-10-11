import {
  ExtensionIdSchema,
  ExtensionLayeredConfigSchema,
  ExtensionPermissionsSchema,
  ExtensionRevisionIdSchema,
  HostPageContributionSchema,
  JsonValueSchema,
  MessageRendererContributionSchema,
  PANEL_ANCHOR_LAYER,
  PanelContributionSchema,
  ToolViewContributionSchema,
  configFields,
  EMPTY_CONFIG_SCHEMA,
  EMPTY_EXTENSION_UI_CONTRIBUTIONS,
  EXTENSION_PROVIDES,
  EXTENSION_SDK_BASE_LEVEL,
  EXTENSION_SDK_LEVEL,
  requiredExtensionSdkLevel,
  mcpSecretFields,
  ExtensionRequiresSchema,
  type ConfigSchemaDocument,
  type ExtensionConfigLayer,
  type ExtensionLayeredConfig,
  type ExtensionPermissions,
  type ExtensionProvide,
  type ExtensionUiContributions,
} from '@nekro-nxt/contracts'
import { z } from 'zod'
import { extensionIconSchema } from './icon.js'

export const extensionEntrypointsSchema = z.union([
  z.object({ host: z.literal('source/host.ts'), client: z.literal('source/client.ts') }).strict(),
  z.object({ host: z.literal('source/host.ts') }).strict(),
  z.object({ client: z.literal('source/client.ts') }).strict(),
])

export const clientCssSchema = z
  .object({
    path: z.string().regex(/^assets\/[a-z0-9][a-z0-9/_-]*\.module\.css$/u),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict()

export const VERIFICATION_INPUT_MAX_BYTES = 16 * 1024

const encoder = new TextEncoder()
const utf8Length = (value: string): number => encoder.encode(value).byteLength

/**
 * Representative, side-effect-free input used to really call a Tool or RPC during verification (dynamic run, save
 * and import). Absent means the historical empty call: `{}` for Tools and `null` for RPC.
 */
export const verificationInputSchema = JsonValueSchema.refine(
  (value) => utf8Length(JSON.stringify(value)) <= VERIFICATION_INPUT_MAX_BYTES,
  `验证样例不能超过 ${VERIFICATION_INPUT_MAX_BYTES} 字节。`,
)

/** Tool arguments are always a JSON object. */
export const toolVerificationInputSchema = z
  .record(z.string(), JsonValueSchema)
  .refine(
    (value) => utf8Length(JSON.stringify(value)) <= VERIFICATION_INPUT_MAX_BYTES,
    `验证样例不能超过 ${VERIFICATION_INPUT_MAX_BYTES} 字节。`,
  )

export const toolContributionSchema = z
  .object({
    kind: z.literal('tool'),
    name: z.string(),
    description: z.string(),
    verificationInput: toolVerificationInputSchema.optional(),
  })
  .strict()

export const rpcContributionSchema = z
  .object({ kind: z.literal('rpc'), method: z.string(), verificationInput: verificationInputSchema.optional() })
  .strict()

export const adapterContributionSchema = z
  .object({
    kind: z.literal('adapter'),
    apiVersion: z.literal(2),
    key: z.string().trim().min(1),
    descriptorDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict()

export const extensionManifestContributionSchema = z.union([
  toolContributionSchema,
  rpcContributionSchema,
  PanelContributionSchema,
  ToolViewContributionSchema,
  MessageRendererContributionSchema,
  adapterContributionSchema,
  HostPageContributionSchema,
])

type Issue = (message: string) => void
type Contribution = z.output<typeof extensionManifestContributionSchema>

/** Contribution kinds that belong to an agent attachment (扩展形态统一 §4); everything else belongs to the host instance. */
export const contributionLayer = (contribution: Contribution): 'agent' | 'host' => {
  switch (contribution.kind) {
    case 'tool':
    case 'tool-view':
      return 'agent'
    case 'panel':
      return PANEL_ANCHOR_LAYER[contribution.anchor]
    case 'rpc':
    case 'adapter':
    case 'host-page':
    case 'message-renderer':
      return 'host'
  }
}

const checkContributions = (contributions: readonly Contribution[], issue: Issue): void => {
  const panels = contributions.filter((entry) => entry.kind === 'panel')
  if (panels.length > 16) issue('一个扩展最多贡献 16 个面板。')
  const panelIds = new Set<string>()
  for (const panel of panels) {
    if (panelIds.has(panel.id)) issue(`面板 id 重复：${panel.id}`)
    panelIds.add(panel.id)
  }
  const pages = contributions.filter((entry) => entry.kind === 'host-page')
  if (pages.length > 8) issue('一个扩展最多贡献 8 个顶级页面。')
  if (new Set(pages.map((page) => page.entryId)).size !== pages.length) issue('页面 entryId 不能重复。')
  if (pages.filter((page) => page.rail !== undefined).length > 1) issue('一个扩展最多有一个页面注册导航轨入口。')
  if (contributions.filter((entry) => entry.kind === 'adapter').length > 1) issue('一个扩展最多注册一个适配器。')
  const tools = new Set(contributions.flatMap((entry) => (entry.kind === 'tool' ? [entry.name] : [])))
  for (const entry of contributions) {
    if (entry.kind === 'tool-view' && !tools.has(entry.tool)) issue(`工具视图只能渲染本扩展声明的工具：${entry.tool}`)
  }
  const methods = contributions.flatMap((entry) => (entry.kind === 'rpc' ? [entry.method] : []))
  if (new Set(methods).size !== methods.length) issue('界面数据接口的 method 不能重复。')
  if (tools.size !== contributions.filter((entry) => entry.kind === 'tool').length) issue('工具名称不能重复。')
}

const checkEntrypoints = (
  value: {
    readonly entrypoints: object
    readonly clientCss?: unknown
    readonly contributions: readonly Contribution[]
  },
  issue: Issue,
): void => {
  const needsClient = value.contributions.some(({ kind }) =>
    ['panel', 'tool-view', 'message-renderer', 'host-page'].includes(kind),
  )
  const needsHost = value.contributions.some(({ kind }) => ['tool', 'rpc', 'adapter'].includes(kind))
  const hasClient = 'client' in value.entrypoints
  const hasHost = 'host' in value.entrypoints
  if (needsClient && !hasClient) issue('界面贡献需要 Client 源码。')
  if (!needsClient && hasClient) issue('Client 源码必须至少贡献一个面板、工具视图、富消息渲染器或页面。')
  if (needsHost && !hasHost) issue('工具、界面数据接口与适配器需要 Host 源码。')
  if (value.clientCss !== undefined && !hasClient) issue('Client CSS 需要 Client 源码。')
}

const checkRequires = (
  value: { readonly requires?: { readonly sdk: number } | undefined; readonly permissions: ExtensionPermissions },
  issue: Issue,
): void => {
  if (value.requires !== undefined && value.requires.sdk > EXTENSION_SDK_LEVEL) {
    issue(
      `这个扩展需要扩展能力等级 ${value.requires.sdk}，当前 NekroNXT 只支持到 ${EXTENSION_SDK_LEVEL}，请先升级 NekroNXT。`,
    )
  }
  // A declared level below what the capabilities need would let an older NekroNXT accept the package and then fail on
  // fields it does not know.
  const needed = requiredExtensionSdkLevel(value.permissions)
  if (needed.level > (value.requires?.sdk ?? EXTENSION_SDK_BASE_LEVEL)) {
    issue(`这个扩展用到了${needed.capabilities.join('、')}，需要在清单中声明 requires: { sdk: ${needed.level} }。`)
  }
}

/** Every config field of both layers; the two schemas may not share a field name. */
const layerFields = (config: ExtensionLayeredConfig | undefined) =>
  (['host', 'agent'] as const).flatMap((layer) =>
    configFields(config?.[layer]?.schema ?? EMPTY_CONFIG_SCHEMA).map((field) => ({ ...field, layer })),
  )

const checkConfig = (
  value: { readonly config?: ExtensionLayeredConfig | undefined; readonly permissions: ExtensionPermissions },
  agentLayer: boolean,
  issue: Issue,
): void => {
  if (value.config?.agent !== undefined && !agentLayer) issue('没有智能体层贡献的扩展不能声明 config.agent。')
  const fields = layerFields(value.config)
  const seen = new Set<string>()
  for (const field of fields) {
    if (seen.has(field.key)) issue(`config.host 与 config.agent 不能使用同名字段：${field.key}`)
    seen.add(field.key)
    if (field.kind === 'secret' && field.default !== undefined) issue(`凭据字段不能声明默认值：${field.key}`)
  }
  const kinds = new Map(fields.map((field) => [field.key, field.kind]))
  for (const field of mcpSecretFields(value.permissions.agent?.mcp)) {
    if (kinds.get(field) !== 'secret') issue(`MCP 请求头或环境变量引用的凭据必须是配置中的凭据字段：${field}`)
  }
  for (const [layer, network] of [
    ['host', value.permissions.host?.network],
    ['agent', value.permissions.agent?.network],
  ] as const) {
    if (network?.mode !== 'config') continue
    const own = new Map(
      fields.filter((field) => field.layer === layer).map((field) => [field.key, field.kind] as const),
    )
    for (const field of network.fields) {
      if (own.get(field) !== 'string') {
        issue(`permissions.${layer}.network.fields 只能引用 config.${layer} 中的文本字段：${field}`)
      }
    }
  }
}

/**
 * Manifest V7（扩展形态统一）。一个扩展 = 一个本机实例 + 可选的智能体挂载；贡献的归属由种类决定，不再声明 scope。
 */
export const extensionManifestSchema = z
  .object({
    schemaVersion: z.literal(7),
    extensionId: ExtensionIdSchema,
    revisionId: ExtensionRevisionIdSchema,
    entrypoints: extensionEntrypointsSchema,
    requires: ExtensionRequiresSchema.optional(),
    clientCss: clientCssSchema.optional(),
    /** 扩展自身的图标，用于工坊、社区和智能体能力列表；不影响运行行为。 */
    icon: extensionIconSchema.optional(),
    contributions: z.array(extensionManifestContributionSchema).max(96),
    permissions: ExtensionPermissionsSchema.default({ permissions: [], networkOrigins: [] }),
    config: ExtensionLayeredConfigSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const issue: Issue = (message) => context.addIssue({ code: 'custom', message })
    if (value.contributions.length === 0 && !hasAgentLayer(value)) issue('扩展至少要提供一项内容。')
    checkContributions(value.contributions, issue)
    checkEntrypoints(value, issue)
    checkRequires(value, issue)
    checkConfig(value, hasAgentLayer(value), issue)
  })

export type ExtensionManifest = z.infer<typeof extensionManifestSchema>
export type ExtensionManifestContribution = ExtensionManifest['contributions'][number]

/**
 * Whether the extension has agent attachments: an agent-layer contribution, or agent-layer capabilities (an inbound
 * hook or MCP servers need no contribution of their own).
 */
export function hasAgentLayer(manifest: {
  readonly contributions: readonly Contribution[]
  readonly permissions: { readonly agent?: object | undefined }
}): boolean {
  return (
    manifest.contributions.some((entry) => contributionLayer(entry) === 'agent') ||
    (manifest.permissions.agent !== undefined && Object.keys(manifest.permissions.agent).length > 0)
  )
}

/** What the extension provides, for listing and filtering (workshop, community market). */
export const extensionProvides = (manifest: ExtensionManifest): readonly ExtensionProvide[] =>
  EXTENSION_PROVIDES.filter((label) => {
    switch (label) {
      case 'agent':
        return (
          manifest.contributions.some((entry) => contributionLayer(entry) === 'agent') ||
          (manifest.permissions.agent !== undefined &&
            Object.keys(manifest.permissions.agent).some((key) => key !== 'mcp'))
        )
      case 'page':
        return manifest.contributions.some((entry) => entry.kind === 'host-page')
      case 'adapter':
        return manifest.contributions.some((entry) => entry.kind === 'adapter')
      case 'mcp':
        return (manifest.permissions.agent?.mcp?.servers.length ?? 0) > 0
    }
  })

/** The config schema of one layer; an empty schema when the layer declares none. */
export const layerConfigSchema = (
  manifest: Pick<ExtensionManifest, 'config'> | undefined,
  layer: ExtensionConfigLayer,
): ConfigSchemaDocument => manifest?.config?.[layer]?.schema ?? EMPTY_CONFIG_SCHEMA

/** The single adapter contribution, if the extension registers one. */
export const manifestAdapter = (manifest: ExtensionManifest) =>
  manifest.contributions.find(
    (entry): entry is Extract<ExtensionManifestContribution, { readonly kind: 'adapter' }> => entry.kind === 'adapter',
  )

/** Product projection of the UI a Revision contributes; empty for an unreadable Revision. */
export const extensionUiContributions = (manifest: ExtensionManifest | undefined): ExtensionUiContributions => {
  if (manifest === undefined) return EMPTY_EXTENSION_UI_CONTRIBUTIONS
  const contributions: readonly ExtensionManifestContribution[] = manifest.contributions
  return {
    panels: contributions.flatMap((entry) => (entry.kind === 'panel' ? [entry] : [])),
    toolViews: contributions.flatMap((entry) => (entry.kind === 'tool-view' ? [entry.tool] : [])),
    messageRenderers: contributions.flatMap((entry) => (entry.kind === 'message-renderer' ? [entry.richKind] : [])),
  }
}
