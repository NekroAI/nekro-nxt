import { z } from 'zod'
import { ExtensionIdSchema, ExtensionRevisionIdSchema, HostUiPageInstanceIdSchema } from './domain.js'

export const AGENT_CLIENT_SLOT_NAMES = [
  'agent.workbench.sections',
  'extension.activation.panels',
  'extension.details.panels',
  'channel.inspector.agent.sections',
  'conversation.tool.card',
] as const

export const AgentClientSlotNameSchema = z.enum(AGENT_CLIENT_SLOT_NAMES)

export type AgentClientSlotName = z.output<typeof AgentClientSlotNameSchema>

export const ADAPTER_CLIENT_SLOT_NAMES = [
  'conversation.message.rich',
  'connection.adapter.setup',
  'connection.adapter.status',
  'connection.adapter.test',
  'channel.inspector.adapter.sections',
] as const

export const AdapterClientSlotNameSchema = z.enum(ADAPTER_CLIENT_SLOT_NAMES)

export type AdapterClientSlotName = z.output<typeof AdapterClientSlotNameSchema>

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
  'SidePane',
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
  })
  .strict()

export type HostPageContribution = z.output<typeof HostPageContributionSchema>

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

export const HostUiPermissionDeclarationSchema = z
  .object({
    permissions: z.array(HostUiPermissionSchema).max(HostUiPermissionSchema.options.length),
    networkOrigins: z.array(HostUiNetworkOriginSchema).max(32).default([]),
  })
  .strict()
  .superRefine((value, context) => {
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
  })

export type HostUiPermissionDeclaration = z.output<typeof HostUiPermissionDeclarationSchema>

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
