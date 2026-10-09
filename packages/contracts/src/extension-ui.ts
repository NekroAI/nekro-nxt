import { z } from 'zod'
import {
  ExtensionCapabilitiesSchema,
  HostLayerCapabilitiesSchema,
  hostLayerAsCapabilities,
} from './extension-capabilities.js'
import { ExtensionIdSchema, ExtensionRevisionIdSchema, HostUiPageInstanceIdSchema } from './domain.js'
import { ConfigSchemaDocumentSchema } from './config-schema.js'

export const HostUiPermissionSchema = z.enum([
  'agents.read',
  'channels.read',
  'connections.read',
  'extensions.read',
  'dsh-plugins.read',
  'runtime.read',
  'messages.read',
  'assets.read',
  'agents.manage',
  'channels.manage',
  'connections.manage',
  'credentials.write',
  'messages.send',
  'notifications.publish',
  'network.request',
])

export type HostUiPermission = z.output<typeof HostUiPermissionSchema>

export const HOST_UI_KIT_COMPONENT_NAMES = [
  'Button',
  'IconButton',
  'Input',
  'Textarea',
  'Select',
  'Switch',
  'Tabs',
  'Dialog',
  'Popover',
  'Tooltip',
  'Field',
  'StatusBadge',
  'InlineFeedback',
  'EmptyState',
  'Spinner',
  'PageHeader',
  'MetricStrip',
  'Metric',
  'Section',
  'Stack',
  'Grid',
  'DataTable',
  'PropertyList',
  'PropertyRow',
] as const

export const HostUiKitComponentNameSchema = z.enum(HOST_UI_KIT_COMPONENT_NAMES)

export type HostUiKitComponentName = z.output<typeof HostUiKitComponentNameSchema>

export const HostUiPageGeometryEvidenceSchema = z
  .object({
    entryId: z
      .string()
      .trim()
      .regex(/^[a-z](?:[a-z0-9-]{0,62}[a-z0-9])?$/u),
    objectPane: z.enum(['navigation', 'hidden']),
    viewport: z
      .object({
        width: z.number().finite().positive().max(16_384),
        height: z.number().finite().positive().max(16_384),
      })
      .strict(),
    insets: z
      .object({
        top: z.number().finite().nonnegative().max(512),
        right: z.number().finite().nonnegative().max(512),
        bottom: z.number().finite().nonnegative().max(512),
        left: z.number().finite().nonnegative().max(512),
      })
      .strict(),
    contentAxesAligned: z.boolean(),
    horizontalOverflow: z.boolean(),
    titleDistinct: z.boolean(),
  })
  .strict()

export type HostUiPageGeometryEvidence = z.output<typeof HostUiPageGeometryEvidenceSchema>

export const HostIconNameSchema = z.enum([
  'app-window',
  'bar-chart',
  'book-open',
  'boxes',
  'database',
  'file-text',
  'folder',
  'globe',
  'layout-dashboard',
  'puzzle',
  'terminal',
  'workflow',
  'wrench',
])

export type HostIconName = z.output<typeof HostIconNameSchema>

export const HostPageIconSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('host-icon'), name: HostIconNameSchema }).strict(),
  z
    .object({
      kind: z.literal('svg'),
      path: z
        .string()
        .trim()
        .regex(/^assets\/[a-z0-9][a-z0-9/_-]*\.svg$/u),
      sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    })
    .strict(),
])

export type HostPageIcon = z.output<typeof HostPageIconSchema>

export const HostPageContributionSchema = z
  .object({
    kind: z.literal('host-page'),
    entryId: z
      .string()
      .trim()
      .regex(/^[a-z](?:[a-z0-9-]{0,62}[a-z0-9])?$/u),
    title: z.string().trim().min(1).max(40),
    description: z.string().trim().max(120).optional(),
    icon: HostPageIconSchema,
    objectPane: z.enum(['navigation', 'hidden']),
    startPath: z
      .string()
      .trim()
      .regex(/^(?:[a-z0-9][a-z0-9/_-]*)?$/u),
    /** Registers a navigation rail entry for this page; at most one page of an extension may declare it. */
    rail: z
      .object({ order: z.number().int().min(0).max(999).optional() })
      .strict()
      .optional(),
  })
  .strict()

export type HostPageContribution = z.output<typeof HostPageContributionSchema>

/** Rail position of a page that registers a rail entry without an explicit order. */
export const HOST_PAGE_DEFAULT_RAIL_ORDER = 100

/** The stored rail position of a page; `null` when the page has no rail entry. */
export const hostPageRailOrder = (page: Pick<HostPageContribution, 'rail'>): number | null =>
  page.rail === undefined ? null : (page.rail.order ?? HOST_PAGE_DEFAULT_RAIL_ORDER)

export const HostUiNavigationItemSchema = z
  .object({
    id: z.string().trim().min(1).max(80),
    label: z.string().trim().min(1).max(80),
    description: z.string().trim().max(120).optional(),
    icon: HostPageIconSchema.optional(),
    badge: z.string().trim().max(24).optional(),
    status: z.enum(['neutral', 'info', 'success', 'warning', 'error']).optional(),
    disabledReason: z.string().trim().max(160).optional(),
    path: z
      .string()
      .trim()
      .regex(/^(?:[a-z0-9][a-z0-9/_-]*)?$/u),
  })
  .strict()

export const HostUiNavigationGroupSchema = z
  .object({
    id: z.string().trim().min(1).max(80),
    label: z.string().trim().max(80).optional(),
    items: z.array(HostUiNavigationItemSchema).max(256),
  })
  .strict()

export const HostUiNavigationModelSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    groups: z.array(HostUiNavigationGroupSchema).max(16),
  })
  .strict()
  .refine((model) => model.groups.reduce((total, group) => total + group.items.length, 0) <= 256, {
    message: 'Host UI navigation cannot contain more than 256 items.',
  })

export type HostUiNavigationModel = z.output<typeof HostUiNavigationModelSchema>

export const HostUiNetworkOriginSchema = z
  .string()
  .url()
  .transform((value, context) => {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      context.addIssue({ code: 'custom', message: 'Host UI network origins must use HTTP(S).' })
      return z.NEVER
    }
    if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
      context.addIssue({ code: 'custom', message: 'Host UI network origins cannot contain paths or credentials.' })
      return z.NEVER
    }
    return url.origin
  })

const checkBrowserPermissions = (
  value: { readonly permissions: readonly HostUiPermission[]; readonly networkOrigins: readonly string[] },
  context: z.RefinementCtx,
): void => {
  if (new Set(value.permissions).size !== value.permissions.length) {
    context.addIssue({ code: 'custom', path: ['permissions'], message: 'Host UI permissions must be unique.' })
  }
  if (new Set(value.networkOrigins).size !== value.networkOrigins.length) {
    context.addIssue({ code: 'custom', path: ['networkOrigins'], message: 'Host UI network origins must be unique.' })
  }
  if (value.networkOrigins.length > 0 && !value.permissions.includes('network.request')) {
    context.addIssue({
      code: 'custom',
      path: ['networkOrigins'],
      message: 'Host UI network origins require network.request.',
    })
  }
}

/**
 * One approval: browser-side permissions plus the capabilities of one layer. Grants, digests and the approval page
 * use this shape for both the host approval and each agent approval.
 */
export const HostUiPermissionDeclarationSchema = z
  .object({
    permissions: z.array(HostUiPermissionSchema).max(HostUiPermissionSchema.options.length),
    networkOrigins: z.array(HostUiNetworkOriginSchema).max(32).default([]),
    capabilities: ExtensionCapabilitiesSchema.optional(),
  })
  .strict()
  .superRefine(checkBrowserPermissions)

export type HostUiPermissionDeclaration = z.output<typeof HostUiPermissionDeclarationSchema>

/**
 * Manifest V7 `permissions`: browser-side permissions of pages and panels (`host.call`), host-layer capabilities used
 * by the single host instance, and agent-layer capabilities used inside each enabled agent.
 */
export const ExtensionPermissionsSchema = z
  .object({
    permissions: z.array(HostUiPermissionSchema).max(HostUiPermissionSchema.options.length).default([]),
    networkOrigins: z.array(HostUiNetworkOriginSchema).max(32).default([]),
    host: HostLayerCapabilitiesSchema.optional(),
    agent: ExtensionCapabilitiesSchema.optional(),
  })
  .strict()
  .superRefine(checkBrowserPermissions)

export type ExtensionPermissions = z.output<typeof ExtensionPermissionsSchema>

export const EMPTY_EXTENSION_PERMISSIONS: ExtensionPermissions = { permissions: [], networkOrigins: [] }

/** What installing the extension on this machine asks the user to approve. */
export const hostPermissionDeclaration = (permissions: ExtensionPermissions): HostUiPermissionDeclaration => {
  const capabilities = hostLayerAsCapabilities(permissions.host)
  return {
    permissions: [...permissions.permissions],
    networkOrigins: [...permissions.networkOrigins],
    ...(capabilities === undefined ? {} : { capabilities }),
  }
}

/** What enabling the extension for one agent asks the user to approve. */
export const agentPermissionDeclaration = (permissions: ExtensionPermissions): HostUiPermissionDeclaration => ({
  permissions: [],
  networkOrigins: [],
  ...(permissions.agent === undefined || Object.keys(permissions.agent).length === 0
    ? {}
    : { capabilities: permissions.agent }),
})

export const HostUiOwnerSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('extension'),
      extensionId: ExtensionIdSchema,
      revisionId: ExtensionRevisionIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('dsh-plugin'),
      entryId: z.string().trim().min(1),
      artifactDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    })
    .strict(),
])

export type HostUiOwner = z.output<typeof HostUiOwnerSchema>

export const HostUiPageEntrySchema = z
  .object({
    pageInstanceId: HostUiPageInstanceIdSchema,
    owner: HostUiOwnerSchema,
    entryId: z.string().trim().min(1).max(64),
    title: z.string().trim().min(1).max(40),
    description: z.string().trim().max(120).optional(),
    icon: HostPageIconSchema,
    objectPane: z.enum(['navigation', 'hidden']),
    startPath: z.string(),
    visible: z.boolean(),
    sortOrder: z.number().int().nonnegative(),
    /** Present when the page registered a navigation rail entry; lower orders come first. */
    rail: z
      .object({ order: z.number().int().min(0).max(999) })
      .strict()
      .optional(),
    routeBase: z.string().regex(/^\/apps\/hup_[0-9A-Za-z]+$/u),
    client: z
      .object({
        moduleUrl: z.string().startsWith('/'),
        buildKey: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict(),
    diagnostic: z
      .object({
        status: z.enum(['ready', 'load-failed', 'navigation-failed', 'rpc-failed', 'restore-failed']),
        message: z.string().optional(),
        observedAt: z.number().int().safe().nonnegative(),
      })
      .strict()
      .optional(),
    createdAt: z.number().int().safe().nonnegative(),
    updatedAt: z.number().int().safe().nonnegative(),
  })
  .strict()

export type HostUiPageEntry = z.output<typeof HostUiPageEntrySchema>

export const HostUiPagePreferencesSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    entries: z.array(
      z
        .object({
          pageInstanceId: HostUiPageInstanceIdSchema,
          visible: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict()

export type HostUiPagePreferences = z.output<typeof HostUiPagePreferencesSchema>

export const DshNxtHostUiSchema = z
  .object({
    schemaVersion: z.literal(1),
    entryKey: z.string().trim().min(1).max(120),
    client: z
      .string()
      .trim()
      .regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[a-zA-Z0-9._/-]+\.m?js$/u),
    css: z
      .string()
      .trim()
      .regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[a-zA-Z0-9._/-]+\.css$/u)
      .optional(),
    pages: z.array(HostPageContributionSchema).min(1).max(8),
    permissions: HostUiPermissionDeclarationSchema.default({ permissions: [], networkOrigins: [] }),
  })
  .strict()

export type DshNxtHostUi = z.output<typeof DshNxtHostUiSchema>

/** Where the product shell may place an extension panel. The Host decides the concrete page and position. */
export const ExtensionPanelAnchorSchema = z.enum(['agent', 'channel', 'extension', 'connection'])
export type ExtensionPanelAnchor = z.output<typeof ExtensionPanelAnchorSchema>

/**
 * Which layer a panel belongs to. Agent and channel panels follow the agents the extension is enabled for (a channel
 * panel also shows on channels of the extension's own adapter); extension and connection panels belong to the host
 * instance.
 */
export const PANEL_ANCHOR_LAYER = {
  agent: 'agent',
  channel: 'agent',
  extension: 'host',
  connection: 'host',
} as const satisfies Readonly<Record<ExtensionPanelAnchor, 'agent' | 'host'>>

export const PanelDensitySchema = z.enum(['compact', 'full'])
export type PanelDensity = z.output<typeof PanelDensitySchema>

export const ConnectionPanelRoleSchema = z.enum(['setup', 'status', 'diagnostics'])
export type ConnectionPanelRole = z.output<typeof ConnectionPanelRoleSchema>

export const ToolViewDensitySchema = z.enum(['chip', 'card'])
export type ToolViewDensity = z.output<typeof ToolViewDensitySchema>

const ContributionIdSchema = z
  .string()
  .trim()
  .regex(/^[a-z](?:[a-z0-9-]{0,62}[a-z0-9])?$/u)

const panelFields = {
  id: ContributionIdSchema,
  anchor: ExtensionPanelAnchorSchema,
  title: z.string().trim().min(1).max(24),
  icon: HostIconNameSchema.optional(),
  densities: z.array(PanelDensitySchema).min(1).max(2),
  role: ConnectionPanelRoleSchema.optional(),
  when: z
    .object({
      channelKinds: z
        .array(z.enum(['internal', 'direct', 'group']))
        .min(1)
        .max(3)
        .optional(),
    })
    .strict()
    .optional(),
}

const checkPanel = (
  value: {
    readonly anchor: ExtensionPanelAnchor
    readonly densities: readonly PanelDensity[]
    readonly role?: ConnectionPanelRole | undefined
    readonly when?: { readonly channelKinds?: readonly string[] | undefined } | undefined
  },
  context: z.RefinementCtx,
): void => {
  if (new Set(value.densities).size !== value.densities.length) {
    context.addIssue({ code: 'custom', path: ['densities'], message: '面板密度不能重复。' })
  }
  if (value.anchor === 'connection' && value.role === undefined) {
    context.addIssue({
      code: 'custom',
      path: ['role'],
      message: '连接面板必须声明 setup、status 或 diagnostics 角色。',
    })
  }
  if (value.anchor !== 'connection' && value.role !== undefined) {
    context.addIssue({ code: 'custom', path: ['role'], message: '只有连接面板可以声明角色。' })
  }
  if (value.when?.channelKinds !== undefined && value.anchor !== 'channel') {
    context.addIssue({ code: 'custom', path: ['when'], message: '只有频道面板可以按频道类型限定。' })
  }
  if (
    value.when?.channelKinds !== undefined &&
    new Set(value.when.channelKinds).size !== value.when.channelKinds.length
  ) {
    context.addIssue({ code: 'custom', path: ['when', 'channelKinds'], message: '频道类型不能重复。' })
  }
}

/** Client-side registration options for one panel; identical to the Manifest contribution without `kind`. */
export const ExtensionPanelDeclarationSchema = z.object(panelFields).strict().superRefine(checkPanel)
export type ExtensionPanelDeclaration = z.output<typeof ExtensionPanelDeclarationSchema>

export const PanelContributionSchema = z
  .object({ kind: z.literal('panel'), ...panelFields })
  .strict()
  .superRefine(checkPanel)
export type PanelContribution = z.output<typeof PanelContributionSchema>

export const ToolViewContributionSchema = z
  .object({ kind: z.literal('tool-view'), tool: z.string().trim().min(1).max(64) })
  .strict()
export type ToolViewContribution = z.output<typeof ToolViewContributionSchema>

export const RichKindSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9._-]{0,62}$/u)

export const MessageRendererContributionSchema = z
  .object({ kind: z.literal('message-renderer'), richKind: RichKindSchema })
  .strict()
export type MessageRendererContribution = z.output<typeof MessageRendererContributionSchema>

/** What an extension provides, derived from its Manifest; for listing and filtering, never a lifecycle switch. */
export const EXTENSION_PROVIDES = ['agent', 'page', 'adapter', 'mcp'] as const
export const ExtensionProvideSchema = z.enum(EXTENSION_PROVIDES)
export type ExtensionProvide = z.output<typeof ExtensionProvideSchema>

/** One configuration form: a serialized Schemastery document. */
export const ExtensionConfigDeclarationSchema = z.object({ schema: ConfigSchemaDocumentSchema }).strict()
export type ExtensionConfigDeclaration = z.output<typeof ExtensionConfigDeclarationSchema>

/** Manifest V7 `config`: the host instance's configuration and each enabled agent's configuration. */
export const ExtensionLayeredConfigSchema = z
  .object({ host: ExtensionConfigDeclarationSchema.optional(), agent: ExtensionConfigDeclarationSchema.optional() })
  .strict()
export type ExtensionLayeredConfig = z.output<typeof ExtensionLayeredConfigSchema>
export type ExtensionConfigLayer = 'host' | 'agent'

/** Product projection of what one Revision contributes to the shell. */
export const ExtensionUiContributionsSchema = z
  .object({
    panels: z.array(PanelContributionSchema).max(16),
    toolViews: z.array(z.string().trim().min(1).max(64)).max(32),
    messageRenderers: z.array(RichKindSchema).max(32),
  })
  .strict()
export type ExtensionUiContributions = z.output<typeof ExtensionUiContributionsSchema>

export const EMPTY_EXTENSION_UI_CONTRIBUTIONS: ExtensionUiContributions = {
  panels: [],
  toolViews: [],
  messageRenderers: [],
}

/** Read permission each Client data hook requires; the host enforces it in every runtime that renders a Client. */
export const EXTENSION_DATA_HOOK_PERMISSIONS = {
  useAgent: 'agents.read',
  useChannel: 'channels.read',
  useConnection: 'connections.read',
  useChannelRuntime: 'runtime.read',
} as const satisfies Readonly<Record<string, HostUiPermission>>

export type ExtensionDataHookName = keyof typeof EXTENSION_DATA_HOOK_PERMISSIONS
