import {
  AGENT_PANEL_ANCHORS,
  ADAPTER_PANEL_ANCHORS,
  ExtensionConfigDeclarationSchema,
  ExtensionIdSchema,
  ExtensionRevisionIdSchema,
  HostPageContributionSchema,
  HostUiPermissionDeclarationSchema,
  JsonValueSchema,
  MessageRendererContributionSchema,
  PanelContributionSchema,
  ToolViewContributionSchema,
  configFields,
  configSecretKeys,
  EMPTY_EXTENSION_UI_CONTRIBUTIONS,
  EXTENSION_SDK_LEVEL,
  mcpSecretFields,
  ExtensionRequiresSchema,
  type ExtensionCapabilities,
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

const manifestIdentitySchema = z
  .object({
    extensionId: ExtensionIdSchema,
    revisionId: ExtensionRevisionIdSchema,
    entrypoints: extensionEntrypointsSchema,
  })
  .strict()

export const adapterContributionSchema = z
  .object({
    kind: z.literal('adapter'),
    apiVersion: z.literal(2),
    key: z.string().trim().min(1),
    descriptorDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict()

const scopeShared = {
  schemaVersion: z.literal(6),
  requires: ExtensionRequiresSchema.optional(),
  clientCss: clientCssSchema.optional(),
  /** 扩展自身的图标，用于工坊、社区和智能体能力列表；不影响运行行为。 */
  icon: extensionIconSchema.optional(),
  permissions: HostUiPermissionDeclarationSchema.default({ permissions: [], networkOrigins: [] }),
  config: ExtensionConfigDeclarationSchema.optional(),
}

type Issue = (message: string) => void

const checkPanels = (
  contributions: readonly { readonly kind: string; readonly id?: string; readonly anchor?: string }[],
  anchors: readonly string[],
  issue: Issue,
): void => {
  const panels = contributions.filter((entry) => entry.kind === 'panel')
  if (panels.length > 16) issue('一个 Revision 最多贡献 16 个面板。')
  const ids = new Set<string>()
  for (const panel of panels) {
    if (panel.anchor === undefined || !anchors.includes(panel.anchor)) {
      issue(`这个扩展类型不能把面板放在 ${String(panel.anchor)}。`)
    }
    if (panel.id !== undefined && ids.has(panel.id)) issue(`面板 id 重复：${panel.id}`)
    if (panel.id !== undefined) ids.add(panel.id)
  }
}

const checkPages = (contributions: readonly { readonly kind: string }[], issue: Issue): void => {
  if (contributions.filter(({ kind }) => kind === 'host-page').length > 8)
    issue('一个 Revision 最多贡献 8 个顶级页面。')
}

const checkClientNeeded = (
  value: {
    readonly entrypoints: object
    readonly clientCss?: unknown
    readonly contributions: readonly { readonly kind: string }[]
  },
  issue: Issue,
): void => {
  const needsClient = value.contributions.some(({ kind }) =>
    ['panel', 'tool-view', 'message-renderer', 'host-page'].includes(kind),
  )
  const hasClient = 'client' in value.entrypoints
  if (needsClient && !hasClient) issue('界面贡献需要 Client 源码。')
  if (!needsClient && hasClient) issue('Client 源码必须至少贡献一个面板、工具视图、富消息渲染器或页面。')
  if (value.clientCss !== undefined && !hasClient) issue('Client CSS 需要 Client 源码。')
}

const checkRequires = (value: { readonly requires?: { readonly sdk: number } | undefined }, issue: Issue): void => {
  if (value.requires !== undefined && value.requires.sdk > EXTENSION_SDK_LEVEL) {
    issue(
      `这个扩展需要扩展能力等级 ${value.requires.sdk}，当前 NekroNXT 只支持到 ${EXTENSION_SDK_LEVEL}，请先升级 NekroNXT。`,
    )
  }
}

const checkConfig = (
  value: { readonly config?: { readonly schema: unknown } | undefined },
  issue: Issue,
  secrets: 'allowed' | 'forbidden',
): void => {
  if (value.config === undefined) return
  const parsed = ExtensionConfigDeclarationSchema.safeParse(value.config)
  if (!parsed.success) return
  const secretFields = configFields(parsed.data.schema).filter((field) => field.kind === 'secret')
  if (secrets === 'forbidden' && configSecretKeys(parsed.data.schema).length > 0) {
    issue('这类扩展的配置不支持凭据字段；凭据请通过适配器连接或 DSH 凭据管理。')
  }
  for (const field of secretFields) {
    if (field.default !== undefined) issue(`凭据字段不能声明默认值：${field.key}`)
  }
}

const checkCapabilities = (
  value: {
    readonly config?: { readonly schema: unknown } | undefined
    readonly permissions: { readonly capabilities?: ExtensionCapabilities | undefined }
  },
  issue: Issue,
): void => {
  const parsed = value.config === undefined ? undefined : ExtensionConfigDeclarationSchema.safeParse(value.config)
  const fields = new Map(
    parsed?.success === true ? configFields(parsed.data.schema).map((field) => [field.key, field.kind]) : [],
  )
  for (const field of mcpSecretFields(value.permissions.capabilities?.mcp)) {
    if (fields.get(field) !== 'secret') {
      issue(`MCP 请求头或环境变量引用的凭据必须是 config.schema 中的凭据字段：${field}`)
    }
  }
  const network = value.permissions.capabilities?.network
  if (network?.mode !== 'config') return
  for (const field of network.fields) {
    if (fields.get(field) !== 'string') {
      issue(`permissions.capabilities.network.fields 只能引用 config.schema 中的文本字段：${field}`)
    }
  }
}

const checkNoCapabilities = (
  value: { readonly permissions: { readonly capabilities?: ExtensionCapabilities | undefined } },
  issue: Issue,
): void => {
  if (value.permissions.capabilities !== undefined) issue('只有智能体扩展可以声明 permissions.capabilities。')
}

export const extensionManifestSchema = z.union([
  manifestIdentitySchema
    .extend({
      ...scopeShared,
      scope: z.literal('agent'),
      contributions: z.array(
        z.union([toolContributionSchema, rpcContributionSchema, PanelContributionSchema, ToolViewContributionSchema]),
      ),
    })
    .strict()
    .superRefine((value, context) => {
      const issue: Issue = (message) => context.addIssue({ code: 'custom', message })
      checkPanels(value.contributions, AGENT_PANEL_ANCHORS, issue)
      checkClientNeeded(value, issue)
      checkRequires(value, issue)
      checkConfig(value, issue, 'allowed')
      checkCapabilities(value, issue)
      const tools = new Set(value.contributions.flatMap((entry) => (entry.kind === 'tool' ? [entry.name] : [])))
      for (const entry of value.contributions) {
        if (entry.kind === 'tool-view' && !tools.has(entry.tool)) {
          issue(`工具视图只能渲染本扩展声明的工具：${entry.tool}`)
        }
      }
    }),
  manifestIdentitySchema
    .extend({
      ...scopeShared,
      scope: z.literal('host-adapter'),
      entrypoints: z.union([
        z.object({ host: z.literal('source/host.ts'), client: z.literal('source/client.ts') }).strict(),
        z.object({ host: z.literal('source/host.ts') }).strict(),
      ]),
      contributions: z
        .array(
          z.union([
            adapterContributionSchema,
            PanelContributionSchema,
            MessageRendererContributionSchema,
            HostPageContributionSchema,
          ]),
        )
        .min(1),
    })
    .strict()
    .superRefine((value, context) => {
      const issue: Issue = (message) => context.addIssue({ code: 'custom', message })
      if (value.contributions.filter(({ kind }) => kind === 'adapter').length !== 1) {
        issue('Host Adapter Manifest 必须且只能声明一个 Adapter。')
      }
      checkPanels(value.contributions, ADAPTER_PANEL_ANCHORS, issue)
      checkPages(value.contributions, issue)
      checkClientNeeded(value, issue)
      checkRequires(value, issue)
      checkConfig(value, issue, 'forbidden')
      checkNoCapabilities(value, issue)
    }),
  manifestIdentitySchema
    .extend({
      ...scopeShared,
      scope: z.literal('host-ui'),
      entrypoints: z.union([
        z.object({ host: z.literal('source/host.ts'), client: z.literal('source/client.ts') }).strict(),
        z.object({ client: z.literal('source/client.ts') }).strict(),
      ]),
      contributions: z.array(HostPageContributionSchema).min(1).max(8),
    })
    .strict()
    .superRefine((value, context) => {
      const issue: Issue = (message) => context.addIssue({ code: 'custom', message })
      checkRequires(value, issue)
      checkConfig(value, issue, 'forbidden')
      checkNoCapabilities(value, issue)
    }),
])

export type ExtensionManifest = z.infer<typeof extensionManifestSchema>
export type ExtensionManifestContribution = ExtensionManifest['contributions'][number]

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
