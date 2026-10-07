import { z } from 'zod'
import { McpServerFormSchema } from './extension-capabilities.js'
import { HostUpgradeSummarySchema, RuntimeCompatibilityDiagnosticSchema } from './runtime-compatibility.js'
import {
  AgentIdSchema,
  AgentRevisionIdSchema,
  AuthoringAttemptIdSchema,
  AuthoringTaskIdSchema,
  AssetIdSchema,
  ChannelEventIdSchema,
  AdapterActivityKeySchema,
  ChannelIdSchema,
  ChannelMemberIdSchema,
  ConnectionIdSchema,
  ConnectionEventIdSchema,
  DshPluginEntryIdSchema,
  DshPluginPackageIdSchema,
  ExtensionIdSchema,
  ExtensionRevisionIdSchema,
  HostUiPageInstanceIdSchema,
  EpisodeIdSchema,
  JsonValueSchema,
  LogicalMessageIdSchema,
  RichExtensionSchema,
  RichTargetUrlSchema,
  OutboundIntentIdSchema,
  PlatformIdentityIdSchema,
  PromptDocumentV1Schema,
  promptDocumentPlainText,
} from './domain.js'
import { ClientNotificationSchema, ManagementDeviceIdSchema, ManagementDeviceViewSchema } from './management-api.js'
import { ConfigSchemaDocumentSchema } from './config-schema.js'
import {
  CommunityExtensionDetailSchema,
  CommunityExtensionSummarySchema,
  CommunityReleaseIdSchema,
  CommunityReviewStatusSchema,
  CommunityStatusSchema,
  CommunitySourceSchema,
  CommunityEndpointSchema,
  CommunityInstalledSchema,
  CommunityMyExtensionSchema,
  CommunityReviewReportSchema,
} from './community.js'
import {
  COMMUNITY_PERSONA_AVATAR_TYPES,
  COMMUNITY_PERSONA_MAX_LENGTH,
  CommunityMyPersonaSchema,
  CommunityMyPersonasSchema,
  CommunityPersonaDetailSchema,
  CommunityPersonaIdSchema,
  CommunityPersonaRevisionIdSchema,
  CommunityPersonaSummarySchema,
} from './community-personas.js'
import {
  DshNxtHostUiSchema,
  EMPTY_EXTENSION_UI_CONTRIBUTIONS,
  ExtensionUiContributionsSchema,
  PanelContributionSchema,
  RichKindSchema,
  HostPageContributionSchema,
  HostIconNameSchema,
  HostUiKitComponentNameSchema,
  HostUiPageGeometryEvidenceSchema,
  HostUiPageEntrySchema,
  HostUiPermissionDeclarationSchema,
} from './extension-ui.js'

const EmptyParamsSchema = z.object({}).strict()
const NoRequestBodySchema = z.undefined()
const NonEmptyStringSchema = z.string().trim().min(1)
const DynamicIdSchema = NonEmptyStringSchema

const DynamicAttemptStatusSchema = z.enum([
  'awaiting-approval',
  'starting-host',
  'client-pending',
  'running',
  'waiting',
  'rejected',
  'failed',
  'cancelled',
  'stopped',
])

const DynamicHalfStateSchema = z
  .object({
    status: z.enum(['absent', 'pending', 'stopped', 'running', 'waiting', 'failed']),
    waitingFor: z.array(z.string()),
    error: z.string().optional(),
  })
  .strict()

const DynamicAttemptErrorSchema = z
  .object({
    phase: z.enum(['approval', 'host-load', 'host-apply', 'client-load', 'client-apply', 'client-render']),
    message: z.string(),
    stack: z.string().optional(),
    pluginId: DynamicIdSchema,
    packageId: DynamicIdSchema,
    pluginRunId: DynamicIdSchema,
  })
  .strict()

const DynamicLatestRunSchema = z
  .object({
    pluginRunId: DynamicIdSchema,
    packageId: DynamicIdSchema,
    mode: z.enum(['run', 'update']),
    status: DynamicAttemptStatusSchema,
    approvalRequestId: DynamicIdSchema.optional(),
    requiresApproval: z.boolean().optional(),
    host: DynamicHalfStateSchema,
    client: DynamicHalfStateSchema,
    error: DynamicAttemptErrorSchema.optional(),
  })
  .strict()

const AuthoringTaskStatusSchema = z.enum([
  'working',
  'awaiting-approval',
  'running',
  'ready',
  'repairing',
  'failed',
  'interrupted',
  'stopped',
  'completed',
])

const AuthoringAttemptStateSchema = z.enum([
  'drafting',
  'preflight-failed',
  'awaiting-approval',
  'starting-host',
  'loading-client',
  'verifying',
  'active',
  'failed',
  'rejected',
  'stopped',
])

const AuthoringAttemptSummarySchema = z
  .object({
    id: AuthoringAttemptIdSchema,
    ordinal: z.number().int().positive(),
    name: z.string(),
    purpose: z.string(),
    state: AuthoringAttemptStateSchema,
    riskDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    host: DynamicHalfStateSchema,
    client: DynamicHalfStateSchema,
    error: z
      .object({
        phase: z.enum([
          'preflight',
          'approval',
          'host-load',
          'host-apply',
          'client-load',
          'client-apply',
          'client-render',
          'verification',
          'settlement',
          'restore',
        ]),
        message: z.string(),
        repairable: z.boolean(),
      })
      .strict()
      .optional(),
    createdAt: z.number().int().nonnegative(),
    settledAt: z.number().int().nonnegative().optional(),
  })
  .strict()

const AuthoringTaskSummarySchema = z
  .object({
    id: AuthoringTaskIdSchema,
    agentId: AgentIdSchema,
    channelId: ChannelIdSchema,
    episodeId: EpisodeIdSchema,
    title: z.string(),
    requirementSummary: z.string(),
    status: AuthoringTaskStatusSchema,
    approvalPolicy: z.enum(['risk-stable', 'fully-automatic']),
    approvedRiskDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    revision: z.number().int().positive(),
    activeAttempt: AuthoringAttemptSummarySchema.optional(),
    candidateAttempt: AuthoringAttemptSummarySchema.optional(),
    /** Latest attempt that still carries product verification evidence; it can be restored as the candidate. */
    verifiedAttempt: AuthoringAttemptSummarySchema.optional(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict()
const ConnectionAliasInputSchema = z
  .string()
  .trim()
  .max(80)
  .transform((value) => value || undefined)
const ConnectionAliasOutputSchema = z.string().trim().min(1).max(80)

export const HostApiErrorSchema = z
  .object({
    error: z
      .object({
        code: NonEmptyStringSchema,
        message: z.string(),
      })
      .strict(),
  })
  .strict()

const AgentModelSchema = z
  .object({
    provider: NonEmptyStringSchema,
    model: NonEmptyStringSchema,
    reasoningEffort: NonEmptyStringSchema.optional(),
  })
  .strict()

export const ImageUnderstandingPolicyApiSchema = z
  .object({
    history: z
      .object({
        mode: z.literal('persistent-distinct'),
        detail: z.enum(['low', 'auto', 'high']),
        restoreAfterCompaction: z
          .object({
            recentMessages: z.number().int().min(1).max(100),
            maxImages: z.number().int().min(1).max(50),
          })
          .strict(),
      })
      .strict(),
    textModel: z.discriminatedUnion('mode', [
      z.object({ mode: z.literal('disabled') }).strict(),
      z
        .object({
          mode: z.literal('auxiliary'),
          model: AgentModelSchema,
          maxTokens: z.number().int().min(256).max(8192),
        })
        .strict(),
    ]),
  })
  .strict()

const AgentCapabilitiesSchema = z
  .object({
    subagents: z.boolean(),
    fileTools: z.boolean(),
    webSearch: z.boolean(),
    dynamicCreation: z.boolean(),
    developmentShell: z.boolean(),
    unrestrictedFileAccess: z.boolean(),
    /** Absent in older clients means on. */
    scheduledTasks: z.boolean().default(true),
  })
  .strict()

export const DynamicClientApprovalPolicySchema = z.enum(['manual', 'automatic'])

export const NotificationEventKeySchema = z.enum(['dynamic-client-approval-requested'])
export type NotificationEventKey = z.output<typeof NotificationEventKeySchema>

export const NotificationSettingsViewSchema = z
  .object({
    revision: z.number().int().positive().optional(),
    system: z.object({ enabled: z.boolean() }).strict(),
    bark: z
      .object({
        enabled: z.boolean(),
        serverUrl: z.url(),
        deviceKeyConfigured: z.boolean(),
      })
      .strict(),
    events: z.record(NotificationEventKeySchema, z.boolean()),
  })
  .strict()

export const UpdateNotificationSettingsRequestSchema = z
  .object({
    expectedRevision: z.number().int().positive().optional(),
    system: z.object({ enabled: z.boolean() }).strict(),
    bark: z
      .object({
        enabled: z.boolean(),
        serverUrl: z.url(),
        deviceKey: z.string().trim().min(1).max(2048).optional(),
        clearDeviceKey: z.boolean().optional(),
      })
      .strict(),
    events: z.record(NotificationEventKeySchema, z.boolean()),
  })
  .strict()
  .refine((value) => !(value.bark.deviceKey !== undefined && value.bark.clearDeviceKey === true), {
    message: '不能同时更新并清除 Bark Device Key。',
    path: ['bark'],
  })

export const TestBarkNotificationRequestSchema = z
  .object({ serverUrl: z.url(), deviceKey: z.string().trim().min(1).max(2048).optional() })
  .strict()

export const ClientNotificationFeedResponseSchema = z
  .object({
    cursor: z.number().int().nonnegative(),
    notifications: z.array(ClientNotificationSchema),
  })
  .strict()

const AgentRevisionRequestContentSchema = z
  .object({
    displayName: z.string().trim().min(1).max(80),
    persona: z
      .string()
      .max(64 * 1024)
      .default(''),
    personaDocument: PromptDocumentV1Schema.optional(),
    model: AgentModelSchema,
    imagePolicy: ImageUnderstandingPolicyApiSchema.optional(),
    dynamicClientApprovalPolicy: DynamicClientApprovalPolicySchema.optional(),
  })
  .strict()

const validatePersonaDocumentProjection = (
  value: z.output<typeof AgentRevisionRequestContentSchema>,
  context: z.core.$RefinementCtx<z.output<typeof AgentRevisionRequestContentSchema>>,
): void => {
  if (value.personaDocument !== undefined && promptDocumentPlainText(value.personaDocument) !== value.persona) {
    context.addIssue({
      code: 'custom',
      message: '人设文本必须与结构化人设文档一致。',
      path: ['personaDocument'],
      input: value,
    })
  }
}

const CreateAgentRequestSchema = AgentRevisionRequestContentSchema.extend({
  capabilities: AgentCapabilitiesSchema.optional(),
}).superRefine((value, context) => {
  validatePersonaDocumentProjection(value, context)
})

const ReviseAgentRequestSchema = AgentRevisionRequestContentSchema.extend({
  expectedCurrentRevisionId: AgentRevisionIdSchema,
}).superRefine((value, context) => {
  validatePersonaDocumentProjection(value, context)
})

// The default that fills `scheduledTasks` for older clients must not turn it on in a partial update.
const UpdateAgentCapabilitiesRequestSchema = AgentCapabilitiesSchema.partial()
  .extend({ scheduledTasks: z.boolean().optional() })
  .strict()
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), '至少提供一个能力。')

const TriggerPolicySchema = z.enum(['always', 'mentioned-or-replied', 'command', 'observe-only'])

export const WorkTreeOrderSchema = z
  .object({
    agentIds: z.array(AgentIdSchema),
    channelIdsByAgent: z.record(AgentIdSchema, z.array(ChannelIdSchema)),
    unboundChannelIds: z.array(ChannelIdSchema),
  })
  .strict()

export type WorkTreeOrder = z.output<typeof WorkTreeOrderSchema>

const SnapshotMessagePartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }).strict(),
  z
    .object({ type: z.literal('mention'), memberId: ChannelMemberIdSchema, displayName: z.string().optional() })
    .strict(),
  z.object({ type: z.literal('image'), assetId: AssetIdSchema, alt: z.string().optional() }).strict(),
  z.object({ type: z.literal('file'), assetId: AssetIdSchema, name: z.string().optional() }).strict(),
  z.object({ type: z.literal('audio'), assetId: AssetIdSchema }).strict(),
  z.object({ type: z.literal('quote'), messageId: LogicalMessageIdSchema }).strict(),
  z
    .object({
      type: z.literal('rich'),
      adapterKey: z.string().trim().min(1).max(64),
      kind: z.string().trim().min(1).max(64),
      summary: z.string().trim().min(1).max(500),
      title: z.string().trim().min(1).max(200).optional(),
      source: z.string().trim().min(1).max(80).optional(),
      targetUrl: RichTargetUrlSchema.optional(),
      previewAssetId: AssetIdSchema.optional(),
      extension: RichExtensionSchema.optional(),
    })
    .strict(),
])

export const HostSnapshotMessageSchema = z
  .object({
    id: z.union([ChannelEventIdSchema, OutboundIntentIdSchema]),
    channelId: ChannelIdSchema,
    role: z.enum(['member', 'agent', 'system']),
    parts: z.array(SnapshotMessagePartSchema),
    sender: z.object({ memberId: ChannelMemberIdSchema, displayName: z.string().optional() }).strict().optional(),
    mentionedConnectionAccount: z.boolean().optional(),
    activityKey: AdapterActivityKeySchema.optional(),
    targetLogicalMessageId: LogicalMessageIdSchema.optional(),
    occurredAt: z.number().finite(),
    deliveryState: z.enum(['planned', 'sending', 'sent', 'partially-sent', 'failed', 'unknown']).optional(),
    /** Latest administrator resolution of an unsettled delivery; history keeps the original receipt state. */
    deliveryResolution: z
      .object({
        action: z.enum(['retry', 'confirm-delivered']),
        resolvedAt: z.number().int().safe().nonnegative(),
      })
      .strict()
      .optional(),
    origin: z.enum(['admin-console']).optional(),
    /** What the agent's inbound hooks decided for this message, when anything differs from the default. */
    inboundHook: z
      .object({
        trigger: z.enum(['default', 'suppress', 'force']),
        hidden: z.boolean(),
        annotation: z.string().optional(),
        extensions: z.array(z.string()),
        problems: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    /** A scheduled task came due: a Host fact shown as a notice, not a member message. */
    scheduledTask: z
      .object({ label: z.string(), extensionName: z.string().optional(), note: z.string().optional() })
      .strict()
      .optional(),
  })
  .strict()

export type HostSnapshotMessage = z.output<typeof HostSnapshotMessageSchema>

export const HostConnectionEventSchema = z
  .object({
    id: ConnectionEventIdSchema,
    connectionId: ConnectionIdSchema,
    activityKey: AdapterActivityKeySchema,
    summary: z.string(),
    actor: z.object({ identityId: PlatformIdentityIdSchema, displayName: z.string().optional() }).strict().optional(),
    subject: z.object({ identityId: PlatformIdentityIdSchema, displayName: z.string().optional() }).strict().optional(),
    occurredAt: z.number().int().safe().nonnegative(),
  })
  .strict()

export type HostConnectionEvent = z.output<typeof HostConnectionEventSchema>

const PlatformUserChannelPreviewSchema = z
  .object({
    id: ChannelIdSchema,
    displayName: z.string().trim().min(1).max(120).optional(),
    kind: z.enum(['internal', 'direct', 'group']),
  })
  .strict()

const PlatformUserFacetAdapterSchema = z
  .object({ key: NonEmptyStringSchema, displayName: NonEmptyStringSchema, userCount: z.number().int().nonnegative() })
  .strict()

const PlatformUserFacetConnectionSchema = z
  .object({
    id: ConnectionIdSchema,
    adapterKey: NonEmptyStringSchema,
    displayName: NonEmptyStringSchema,
    userCount: z.number().int().nonnegative(),
  })
  .strict()

export const PlatformUserListResponseSchema = z
  .object({
    total: z.number().int().nonnegative(),
    items: z.array(
      z
        .object({
          identityId: PlatformIdentityIdSchema,
          displayName: z.string().trim().min(1).max(120).optional(),
          adapter: z.object({ key: NonEmptyStringSchema, displayName: NonEmptyStringSchema }).strict(),
          connection: z.object({ id: ConnectionIdSchema, displayName: NonEmptyStringSchema }).strict(),
          activeChannelCount: z.number().int().nonnegative(),
          channelPreview: z.array(PlatformUserChannelPreviewSchema).max(3),
          historicalOnly: z.boolean(),
        })
        .strict(),
    ),
    facets: z
      .object({
        adapters: z.array(PlatformUserFacetAdapterSchema),
        connections: z.array(PlatformUserFacetConnectionSchema),
      })
      .strict(),
    nextCursor: PlatformIdentityIdSchema.optional(),
  })
  .strict()

export type PlatformUserListResponse = z.output<typeof PlatformUserListResponseSchema>

export const ChannelFactSseItemSchema = z
  .object({
    kind: z.enum(['inbound', 'outbound']),
    sourceId: z.union([ChannelEventIdSchema, OutboundIntentIdSchema]),
    message: HostSnapshotMessageSchema,
  })
  .strict()

export const ChannelFactSseDataSchema = z
  .object({
    channelId: ChannelIdSchema,
    revision: z.number().int().positive(),
    items: z.array(ChannelFactSseItemSchema).min(1),
  })
  .strict()

export const ChannelRuntimePhaseSchema = z.enum(['idle', 'thinking', 'using-tool', 'waiting-input', 'unavailable'])

export const ChannelRuntimeUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative().optional(),
    cacheReadTokens: z.number().int().nonnegative().optional(),
    cacheWriteTokens: z.number().int().nonnegative().optional(),
    reasoningTokens: z.number().int().nonnegative().optional(),
  })
  .strict()

export const ChannelRuntimeToolSchema = z
  .object({
    callId: NonEmptyStringSchema,
    name: NonEmptyStringSchema,
    displayName: NonEmptyStringSchema,
    state: z.enum(['running', 'succeeded', 'failed']),
    inputPreview: z.string().optional(),
    resultPreview: z.string().optional(),
    wroteToChannel: z.boolean().optional(),
    deliveryState: z.enum(['sent', 'partially-sent', 'failed', 'unknown']).optional(),
    durationMs: z.number().int().nonnegative().optional(),
  })
  .strict()

export const ChannelRuntimeStepSchema = z
  .object({
    step: z.number().int().nonnegative(),
    tools: z.array(ChannelRuntimeToolSchema),
    internalOutput: z
      .object({
        kind: z.literal('internal-output'),
        text: z.string().optional(),
        reasoning: z.string().optional(),
      })
      .strict()
      .optional(),
    durationMs: z.number().int().nonnegative().optional(),
    firstTokenMs: z.number().int().nonnegative().optional(),
    usage: ChannelRuntimeUsageSchema.optional(),
  })
  .strict()

export const ChannelRuntimeTurnSchema = z
  .object({
    turn: z.number().int().nonnegative(),
    state: z.enum(['in-progress', 'completed', 'unreplied', 'aborted', 'error', 'max-tokens', 'interrupted']),
    producedReply: z.boolean(),
    responseState: z.enum(['not-required', 'pending', 'sent', 'finished', 'protocol-failed', 'interrupted']),
    error: z.object({ code: NonEmptyStringSchema, message: z.string() }).strict().optional(),
    steps: z.array(ChannelRuntimeStepSchema),
    durationMs: z.number().int().nonnegative().optional(),
    /** Session log time the turn opened. */
    startedAt: z.number().int().safe().nonnegative().optional(),
    /** Session log time the turn closed; absent while it is still running. */
    endedAt: z.number().int().safe().nonnegative().optional(),
    /** Newest Channel Event of the admission that opened this turn; absent for non-channel turns. */
    triggerEventId: ChannelEventIdSchema.optional(),
  })
  .strict()

export const ChannelRuntimeOccupancySchema = z
  .object({
    projectedTokens: z.number().int().nonnegative(),
    contextWindow: z.number().int().positive(),
    breakdown: z
      .object({
        systemTokens: z.number().int().nonnegative(),
        toolsTokens: z.number().int().nonnegative(),
        messageTokens: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
  })
  .strict()

export const ChannelRuntimeCacheSampleSchema = z
  .object({
    turn: z.number().int().nonnegative(),
    step: z.number().int().nonnegative(),
    at: z.number().nonnegative().optional(),
    uncachedInputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative().optional(),
    cacheWriteTokens: z.number().int().nonnegative().optional(),
  })
  .strict()

export const ChannelRuntimeCacheSchema = z
  .object({
    scope: z.literal('episode'),
    aggregate: z
      .object({
        usageRequestCount: z.number().int().nonnegative(),
        observedRequestCount: z.number().int().nonnegative(),
        shareRequestCount: z.number().int().nonnegative(),
        hitRequestCount: z.number().int().nonnegative(),
        uncachedInputTokens: z.number().int().nonnegative(),
        cacheReadTokens: z.number().int().nonnegative(),
        cacheWriteTokens: z.number().int().nonnegative(),
        averageRequestReadShare: z.number().min(0).max(1).optional(),
      })
      .strict(),
    recent: z
      .object({
        windowSize: z.number().int().positive(),
        samples: z.array(ChannelRuntimeCacheSampleSchema),
      })
      .strict(),
  })
  .strict()

export const ChannelRuntimePerformanceSampleSchema = z
  .object({
    turn: z.number().int().nonnegative(),
    step: z.number().int().nonnegative(),
    at: z.number().nonnegative().optional(),
    firstTokenMs: z.number().int().nonnegative().optional(),
    decodeMs: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
  })
  .strict()

export const ChannelRuntimePerformanceSchema = z
  .object({
    scope: z.literal('episode'),
    aggregate: z
      .object({
        steps: z.number().int().nonnegative(),
        llmMs: z.number().nonnegative(),
        toolMs: z.number().nonnegative(),
        ttftMs: z.number().nonnegative(),
        ttftSteps: z.number().int().nonnegative(),
        decodeMs: z.number().nonnegative(),
        decodeTokens: z.number().int().nonnegative(),
        decodeSteps: z.number().int().nonnegative(),
        retryCount: z.number().int().nonnegative(),
        retryDelayMs: z.number().nonnegative(),
      })
      .strict(),
    recent: z
      .object({
        windowSize: z.number().int().positive(),
        samples: z.array(ChannelRuntimePerformanceSampleSchema),
      })
      .strict(),
  })
  .strict()

export const ChannelRuntimeProjectionSchema = z
  .object({
    channelId: ChannelIdSchema,
    agentId: AgentIdSchema.optional(),
    episodeId: EpisodeIdSchema.optional(),
    phase: ChannelRuntimePhaseSchema,
    summary: z.string(),
    pendingInjectCount: z.number().int().nonnegative(),
    occupancy: ChannelRuntimeOccupancySchema.optional(),
    cache: ChannelRuntimeCacheSchema.optional(),
    performance: ChannelRuntimePerformanceSchema.optional(),
    turns: z.array(ChannelRuntimeTurnSchema),
  })
  .strict()

export const ChannelRuntimeSseDataSchema = ChannelRuntimeProjectionSchema.extend({
  revision: z.number().int().positive(),
  truncated: z.boolean().optional(),
}).strict()

export type ChannelRuntimePhase = z.output<typeof ChannelRuntimePhaseSchema>
export type ChannelRuntimeUsage = z.output<typeof ChannelRuntimeUsageSchema>
export type ChannelRuntimeOccupancy = z.output<typeof ChannelRuntimeOccupancySchema>
export type ChannelRuntimeCacheSample = z.output<typeof ChannelRuntimeCacheSampleSchema>
export type ChannelRuntimeCache = z.output<typeof ChannelRuntimeCacheSchema>
export type ChannelRuntimePerformanceSample = z.output<typeof ChannelRuntimePerformanceSampleSchema>
export type ChannelRuntimePerformance = z.output<typeof ChannelRuntimePerformanceSchema>
export type ChannelRuntimeProjection = z.output<typeof ChannelRuntimeProjectionSchema>
export type ChannelRuntimeSseData = z.output<typeof ChannelRuntimeSseDataSchema>
export type ChannelFactSseData = z.output<typeof ChannelFactSseDataSchema>

const AdapterConnectionCreationSchema = z
  .object({
    mode: z.enum(['schema-form', 'qr-login']),
    actionLabel: z.string().trim().min(1).optional(),
    pendingLabel: z.string().trim().min(1).optional(),
  })
  .strict()

const AdapterConnectionDescriptorSchema = z
  .object({
    key: NonEmptyStringSchema,
    displayName: z.string(),
    description: z.string(),
    provisioning: z.enum(['user-created', 'system-singleton']),
    aliasEditable: z.boolean(),
    channelDiscovery: z.enum(['host-created', 'adapter-observed']),
    channelKinds: z.array(z.enum(['internal', 'direct', 'group'])).min(1),
    activities: z.array(
      z
        .object({
          key: AdapterActivityKeySchema,
          scope: z.enum(['channel', 'connection']),
          displayName: z.string().trim().min(1),
          description: z.string().trim().min(1),
          icon: HostIconNameSchema.optional(),
          triggerable: z.boolean(),
          channelKinds: z.array(z.enum(['internal', 'direct', 'group'])).optional(),
        })
        .strict(),
    ),
    features: z
      .object({
        processingFeedback: z
          .object({ channelKinds: z.array(z.enum(['direct', 'group'])).min(1) })
          .strict()
          .optional(),
      })
      .strict(),
    diagnostics: z.object({ receive: z.boolean(), send: z.boolean() }).strict(),
    creation: AdapterConnectionCreationSchema.optional(),
    /** Typed platform actions the Adapter offers to agent extensions (`ctx.nxt.platform`). */
    platformActions: z
      .array(
        z
          .object({
            name: z.string().regex(/^[a-z0-9_]{1,64}$/u),
            title: z.string(),
            description: z.string(),
            risk: z.enum(['low', 'admin']),
            channelKinds: z.array(z.enum(['direct', 'group'])).min(1),
            parameters: z
              .object({
                type: z.literal('object'),
                properties: z.record(z.string(), JsonValueSchema),
                required: z.array(z.string()).optional(),
              })
              .strict(),
          })
          .strict(),
      )
      .optional(),
    rawApi: z.object({ description: z.string() }).strict().optional(),
    configSchema: ConfigSchemaDocumentSchema,
  })
  .strict()

const AdapterCapabilityStateSchema = z
  .object({
    state: z.enum(['available', 'disabled', 'unsupported', 'degraded', 'unknown']),
    reason: z.string().optional(),
  })
  .strict()

const ActivityTriggerOverridesSchema = z.record(AdapterActivityKeySchema, z.boolean())

export const HostSyncCursorSchema = z
  .object({
    epoch: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u),
    sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict()

export const AgentAppearanceSchema = z
  .object({
    hue: z.number().int().min(0).max(359).optional(),
    avatarAssetId: AssetIdSchema.optional(),
  })
  .strict()

export type AgentAppearance = z.output<typeof AgentAppearanceSchema>

/** Upper bound of a reported unread count; `unreadCapped` marks that more exist. */
export const CHANNEL_UNREAD_COUNT_CAP = 99

export const ChannelActivitySummarySchema = z
  .object({
    lastActivityAt: z.number().int().safe().nonnegative().optional(),
    lastMessage: z
      .object({
        role: z.enum(['member', 'agent', 'admin', 'system']),
        author: z.string().max(120),
        preview: z.string().max(160),
        occurredAt: z.number().int().safe().nonnegative(),
      })
      .strict()
      .optional(),
    unreadCount: z.number().int().nonnegative().max(CHANNEL_UNREAD_COUNT_CAP),
    unreadCapped: z.boolean(),
  })
  .strict()

export type ChannelActivitySummary = z.output<typeof ChannelActivitySummarySchema>

export const AttentionItemSchema = z
  .object({
    /** Stable fingerprint; a recurrence of the same condition gets a new fingerprint. */
    id: z.string().min(1).max(200),
    kind: z.enum([
      'delivery-unconfirmed',
      'delivery-failed',
      'turn-failed',
      'authoring-approval',
      'connection-unhealthy',
      'agent-model-unavailable',
      'agent-vision-unavailable',
    ]),
    severity: z.enum(['critical', 'warning', 'info']),
    subject: z
      .object({
        kind: z.enum(['outbound', 'channel', 'authoring-task', 'connection', 'agent']),
        id: NonEmptyStringSchema,
      })
      .strict(),
    related: z
      .object({
        channelId: ChannelIdSchema.optional(),
        agentId: AgentIdSchema.optional(),
        connectionId: ConnectionIdSchema.optional(),
        taskId: AuthoringTaskIdSchema.optional(),
        outboundId: OutboundIntentIdSchema.optional(),
      })
      .strict(),
    title: z.string().min(1).max(120),
    detail: z.string().max(400),
    action: z
      .object({
        kind: z.enum(['open-channel', 'resolve-delivery', 'open-authoring-task', 'open-connection', 'open-agent']),
        label: z.string().min(1).max(40),
      })
      .strict(),
    occurredAt: z.number().int().safe().nonnegative(),
  })
  .strict()

export type AttentionItem = z.output<typeof AttentionItemSchema>

export const AttentionListSchema = z
  .object({
    revision: z.string().min(1),
    items: z.array(AttentionItemSchema).max(200),
  })
  .strict()

export const ChannelPendingContextSchema = z
  .object({
    channelId: ChannelIdSchema,
    episodeId: EpisodeIdSchema.optional(),
    items: z.array(
      z
        .object({
          admissionId: NonEmptyStringSchema,
          /** `next-step`: injected at the next safe step boundary; `next-turn`: waits for a later turn. */
          target: z.enum(['next-step', 'next-turn']),
          events: z.array(
            z
              .object({
                eventId: ChannelEventIdSchema,
                author: z.string().max(120),
                preview: z.string().max(160),
                receivedAt: z.number().int().safe().nonnegative(),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
  })
  .strict()

export type ChannelPendingContext = z.output<typeof ChannelPendingContextSchema>

export const ACTIVITY_MAX_WINDOW_MS = 24 * 60 * 60 * 1000
export const ACTIVITY_MIN_BUCKET_MS = 60 * 1000
export const ACTIVITY_MAX_BUCKETS = 288

const ActivityDurationSchema = z.string().regex(/^[1-9][0-9]{0,4}[mh]$/u)

export const activityDurationMs = (value: string): number => {
  const amount = Number(value.slice(0, -1))
  return value.endsWith('h') ? amount * 60 * 60 * 1000 : amount * 60 * 1000
}

export const ActivityQuerySchema = z
  .object({
    window: ActivityDurationSchema.default('2h'),
    bucket: ActivityDurationSchema.default('5m'),
  })
  .strict()
  .superRefine((value, context) => {
    const window = activityDurationMs(value.window)
    const bucket = activityDurationMs(value.bucket)
    if (window > ACTIVITY_MAX_WINDOW_MS)
      context.addIssue({ code: 'custom', path: ['window'], message: '统计窗口不能超过 24 小时。' })
    if (bucket < ACTIVITY_MIN_BUCKET_MS)
      context.addIssue({ code: 'custom', path: ['bucket'], message: '统计间隔不能小于 1 分钟。' })
    if (bucket > window) context.addIssue({ code: 'custom', path: ['bucket'], message: '统计间隔不能大于统计窗口。' })
    if (window / bucket > ACTIVITY_MAX_BUCKETS) {
      context.addIssue({ code: 'custom', path: ['bucket'], message: `统计桶不能超过 ${ACTIVITY_MAX_BUCKETS} 个。` })
    }
  })

export const ChannelActivitySeriesSchema = z
  .object({
    from: z.number().int().safe().nonnegative(),
    to: z.number().int().safe().nonnegative(),
    bucketMs: z.number().int().positive(),
    channels: z.array(
      z
        .object({
          channelId: ChannelIdSchema,
          counts: z.array(z.number().int().nonnegative()).max(ACTIVITY_MAX_BUCKETS),
          total: z.number().int().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict()

export type ChannelActivitySeries = z.output<typeof ChannelActivitySeriesSchema>

export const ScheduledTaskIdSchema = z.string().regex(/^job_[0-9A-Za-z]+$/u)

/**
 * One scheduled task of an agent in one channel. `chat` tasks come from the agent's scheduling tools; `declared` and
 * `runtime` tasks belong to an extension (Manifest plan or `ctx.nxt.jobs`).
 */
export const ScheduledTaskSchema = z
  .object({
    id: ScheduledTaskIdSchema,
    agentId: AgentIdSchema,
    channelId: ChannelIdSchema,
    source: z.enum(['chat', 'declared', 'runtime']),
    extensionId: ExtensionIdSchema.optional(),
    extensionName: z.string().optional(),
    label: z.string(),
    note: z.string().optional(),
    schedule: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('once'), at: z.number().int().safe() }).strict(),
      z.object({ kind: z.literal('cron'), cron: z.string(), timezone: z.string() }).strict(),
    ]),
    /** `inactive`: the owning extension is disabled for this agent, so the task stays silent. */
    state: z.enum(['scheduled', 'paused', 'finished', 'inactive']),
    nextRunAt: z.number().int().safe().optional(),
    lastFiredAt: z.number().int().safe().optional(),
    createdAt: z.number().int().safe(),
  })
  .strict()

export type ScheduledTask = z.output<typeof ScheduledTaskSchema>

export const HostSnapshotSchema = z
  .object({
    upgrade: HostUpgradeSummarySchema.optional(),
    cursor: HostSyncCursorSchema,
    diagnosticsSampledAt: z.number().int().nonnegative(),
    productMetadata: z
      .object({
        displayName: NonEmptyStringSchema,
        organizationName: NonEmptyStringSchema,
        version: NonEmptyStringSchema,
        releaseId: NonEmptyStringSchema,
        repositoryUrl: z.url(),
        licenseSpdx: NonEmptyStringSchema.nullable(),
        dshVersion: NonEmptyStringSchema.optional(),
      })
      .strict()
      .optional(),
    models: z.array(
      z
        .object({
          provider: NonEmptyStringSchema,
          providerName: NonEmptyStringSchema,
          id: NonEmptyStringSchema,
          name: z.string(),
          description: z.string().optional(),
          inputModalities: z.array(z.string()).optional(),
        })
        .strict(),
    ),
    capabilityAvailability: z
      .object({
        subagents: z.object({ available: z.boolean() }).strict(),
        webSearch: z
          .object({
            provider: z.literal('deepseek-official'),
            available: z.boolean(),
            credentialConfigured: z.boolean(),
            credentialReference: NonEmptyStringSchema,
            maxUsesPerCall: z.number().int().nonnegative(),
            maxResultsPerCall: z.number().int().nonnegative(),
            timeoutMs: z.number().int().nonnegative(),
          })
          .strict(),
      })
      .strict(),
    connectionAdapters: z.array(AdapterConnectionDescriptorSchema),
    notificationSettings: NotificationSettingsViewSchema,
    agents: z.array(
      z
        .object({
          id: AgentIdSchema,
          displayName: z.string(),
          persona: z.string(),
          personaDocument: PromptDocumentV1Schema,
          model: AgentModelSchema,
          capabilities: AgentCapabilitiesSchema,
          imagePolicy: ImageUnderstandingPolicyApiSchema,
          dynamicClientApprovalPolicy: DynamicClientApprovalPolicySchema,
          imageDiagnostics: z
            .object({
              route: z
                .object({
                  mode: z.enum(['direct', 'delegated', 'unavailable']),
                  provider: z.string().optional(),
                  model: z.string().optional(),
                })
                .strict(),
              activeSessions: z.number().int().nonnegative(),
              residentImages: z.number().int().nonnegative(),
              duplicateImagesSkipped: z.number().int().nonnegative(),
              lastInspection: z
                .object({
                  mode: z.enum(['direct', 'delegated']),
                  imageCount: z.number().int().nonnegative(),
                  provider: z.string().optional(),
                  model: z.string().optional(),
                  cacheHit: z.boolean(),
                  usage: ChannelRuntimeUsageSchema.optional(),
                  errorCode: z.string().optional(),
                })
                .strict()
                .optional(),
              lastRestoration: z
                .object({
                  compactionId: z.string(),
                  candidateCount: z.number().int().nonnegative(),
                  restoredCount: z.number().int().nonnegative(),
                  skippedCount: z.number().int().nonnegative(),
                  error: z.string().optional(),
                })
                .strict()
                .optional(),
              blockers: z.array(z.string()),
            })
            .strict(),
          currentRevisionId: AgentRevisionIdSchema,
          runtimeStatus: z.enum(['idle', 'running']),
          runtimePhase: ChannelRuntimePhaseSchema.default('idle'),
          createdAt: z.number().finite(),
          channels: z.array(ChannelIdSchema),
          appearance: AgentAppearanceSchema.default({}),
        })
        .strict(),
    ),
    channels: z.array(
      z
        .object({
          id: ChannelIdSchema,
          connectionId: ConnectionIdSchema,
          platformChannelId: NonEmptyStringSchema,
          kind: z.enum(['internal', 'group', 'direct']),
          displayName: z.string().optional(),
          boundAgentId: AgentIdSchema.optional(),
          runtimePhase: ChannelRuntimePhaseSchema.default('idle'),
          activity: ChannelActivitySummarySchema.default({ unreadCount: 0, unreadCapped: false }),
          bindings: z.array(
            z
              .object({
                channelId: ChannelIdSchema,
                agentId: AgentIdSchema,
                triggerPolicy: TriggerPolicySchema,
                processingFeedback: z.enum(['auto', 'off']).default('auto'),
                activityTriggerOverrides: ActivityTriggerOverridesSchema.default({}),
                boundAt: z.number().int().safe().nonnegative(),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
    workTreeOrder: WorkTreeOrderSchema.default({
      agentIds: [],
      channelIdsByAgent: {},
      unboundChannelIds: [],
    }),
    messages: z.array(HostSnapshotMessageSchema),
    connections: z.array(
      z
        .object({
          id: ConnectionIdSchema,
          adapterKey: NonEmptyStringSchema,
          alias: ConnectionAliasOutputSchema.optional(),
          activityTriggerDefaults: z.array(AdapterActivityKeySchema).default([]),
          status: z
            .object({
              state: z.enum(['stopped', 'connecting', 'connected', 'reconnecting', 'failed']),
              message: z.string().optional(),
              credentialConfigured: z.boolean(),
              proactiveSend: z.boolean(),
              accountReference: z.string().optional(),
              implementation: z
                .object({
                  name: z.string().optional(),
                  version: z.string().optional(),
                  protocolVersion: z.string().optional(),
                })
                .strict()
                .optional(),
              optionalCapabilities: z
                .record(z.string(), z.enum(['unknown', 'available', 'unsupported', 'degraded']))
                .optional(),
              activities: z.record(z.string(), AdapterCapabilityStateSchema).default({}),
              processingFeedback: AdapterCapabilityStateSchema.optional(),
            })
            .strict()
            .default({ state: 'stopped', credentialConfigured: false, proactiveSend: false, activities: {} }),
          channelCount: z.number().int().nonnegative(),
          knownChannels: z.array(
            z.object({ id: ChannelIdSchema, name: z.string(), kind: z.enum(['internal', 'group', 'direct']) }).strict(),
          ),
          lastInbound: z
            .object({
              channelId: ChannelIdSchema,
              platformMessageId: NonEmptyStringSchema,
              receivedAt: z.number().int().safe().nonnegative(),
            })
            .strict()
            .optional(),
          receiveTest: z.lazy(() => ConnectionTestResultSchema).optional(),
          sendTest: z.lazy(() => ConnectionTestResultSchema).optional(),
          configuration: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
        })
        .strict(),
    ),
    archivedConnections: z
      .array(
        z
          .object({
            id: ConnectionIdSchema,
            adapterKey: NonEmptyStringSchema,
            alias: ConnectionAliasOutputSchema.optional(),
            channelCount: z.number().int().nonnegative(),
            archivedAt: z.number().int().safe().nonnegative(),
          })
          .strict(),
      )
      .default([]),
    extensions: z.array(
      z
        .object({
          id: ExtensionIdSchema,
          scope: z.enum(['agent', 'host-adapter', 'host-ui']),
          slug: NonEmptyStringSchema,
          displayName: z.string(),
          description: z.string(),
          createdByAgentId: AgentIdSchema.optional(),
          revisions: z.array(
            z
              .object({
                id: ExtensionRevisionIdSchema,
                revisionNumber: z.number().int().positive(),
                format: z.enum(['current', 'unavailable']).optional(),
                ui: ExtensionUiContributionsSchema.default(EMPTY_EXTENSION_UI_CONTRIBUTIONS),
                configSchema: ConfigSchemaDocumentSchema.optional(),
                createdAt: z.number().int().safe().nonnegative(),
                /** 从社区安装的保存记录的来源；本机保存与文件导入没有来源。 */
                source: CommunitySourceSchema.optional(),
                scope: z.enum(['agent', 'host-adapter', 'host-ui']),
                contributions: z.array(z.string()),
                verification: z
                  .object({
                    verifiedAt: z.number().int().nonnegative(),
                    dshVersion: z.string(),
                    contractVersion: z.string(),
                    hostBuilt: z.boolean(),
                    clientBuilt: z.boolean(),
                    buildKey: z.string(),
                    toolInvocationCount: z.number().int().nonnegative(),
                    rpcMethods: z.array(z.string()),
                    renderedPanels: z.array(z.string()).default([]),
                    renderedToolViews: z.array(z.string()).default([]),
                    renderedMessageRenderers: z.array(z.string()).default([]),
                    renderedPages: z.array(HostPageContributionSchema).max(8).optional(),
                    usedUiComponents: z.array(HostUiKitComponentNameSchema).optional(),
                    pageGeometry: z.array(HostUiPageGeometryEvidenceSchema).max(8).optional(),
                    permissions: HostUiPermissionDeclarationSchema.optional(),
                    permissionDigest: z
                      .string()
                      .regex(/^[a-f0-9]{64}$/u)
                      .optional(),
                    permissionApprovalRequired: z.boolean().optional(),
                    adapter: z
                      .object({
                        apiVersion: z.literal(2),
                        key: NonEmptyStringSchema,
                        descriptorDigest: z.string().regex(/^[a-f0-9]{64}$/u),
                        registered: z.boolean(),
                        started: z.boolean(),
                        stopped: z.boolean(),
                        inboundCommitted: z.boolean(),
                        outboundReceipt: z.enum(['sent', 'failed', 'unknown']),
                      })
                      .strict()
                      .optional(),
                  })
                  .strict()
                  .optional(),
              })
              .strict(),
          ),
          activations: z.array(
            z
              .object({
                agentId: AgentIdSchema,
                extensionRevisionId: ExtensionRevisionIdSchema,
                /** Secret fields are removed; `configuredSecrets` lists those the Host stores. */
                config: JsonValueSchema,
                configuredSecrets: z.array(z.string()).optional(),
                activatedAt: z.number().int().safe().nonnegative(),
                runtime: z
                  .object({
                    status: z.enum(['active', 'restore-failed', 'dispose-failed']),
                    message: z.string().optional(),
                    observedAt: z.number().int().safe().nonnegative(),
                  })
                  .optional(),
                /** Latest connection attempt of each MCP server this Activation declares. */
                mcpServers: z
                  .array(
                    z
                      .object({
                        name: z.string(),
                        state: z.enum(['connecting', 'connected', 'unavailable', 'missing-credentials']),
                        toolCount: z.number().int().nonnegative().optional(),
                        missing: z.array(z.string()).optional(),
                        message: z.string().optional(),
                        observedAt: z.number().int().safe().nonnegative(),
                      })
                      .strict(),
                  )
                  .optional(),
              })
              .strict(),
          ),
          installation: z
            .object({
              extensionRevisionId: ExtensionRevisionIdSchema,
              installedAt: z.number().int().safe().nonnegative(),
              config: JsonValueSchema.default({}),
              runtime: z
                .object({
                  status: z.enum(['active', 'restore-failed', 'dispose-failed']),
                  message: z.string().optional(),
                  observedAt: z.number().int().safe().nonnegative(),
                })
                .optional(),
            })
            .strict()
            .optional(),
          hostUiPermission: z
            .object({
              declaration: HostUiPermissionDeclarationSchema,
              permissionDigest: z.string().regex(/^[a-f0-9]{64}$/u),
              approvalRequired: z.boolean(),
            })
            .strict()
            .optional(),
          hostClientDiagnostic: z
            .object({
              revisionId: ExtensionRevisionIdSchema,
              status: z.enum(['loaded', 'failed']),
              message: z.string().optional(),
              observedAt: z.number().int().safe().nonnegative(),
            })
            .strict()
            .optional(),
          clientDiagnostics: z.array(
            z
              .object({
                agentId: AgentIdSchema,
                revisionId: ExtensionRevisionIdSchema,
                status: z.enum(['loaded', 'failed']),
                message: z.string().optional(),
                observedAt: z.number().int().nonnegative(),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
    hostUi: z
      .object({
        preferencesRevision: z.number().int().nonnegative(),
        pages: z.array(HostUiPageEntrySchema),
      })
      .strict()
      .default({ preferencesRevision: 0, pages: [] }),
    dynamic: z.array(
      z
        .object({
          agentId: AgentIdSchema,
          episodeId: EpisodeIdSchema,
          pluginId: DynamicIdSchema,
          packageId: DynamicIdSchema.optional(),
          currentPackageId: DynamicIdSchema.optional(),
          nextPackageId: DynamicIdSchema.optional(),
          approvalRequestId: DynamicIdSchema.optional(),
          status: DynamicAttemptStatusSchema,
          activeRun: z.object({ pluginRunId: DynamicIdSchema, packageId: DynamicIdSchema }).strict().optional(),
          latestRun: DynamicLatestRunSchema.optional(),
          packages: z.array(
            z
              .object({
                packageId: DynamicIdSchema,
                name: z.string(),
                purpose: z.string(),
                hasHostHalf: z.boolean(),
                hasClientHalf: z.boolean(),
              })
              .strict(),
          ),
          policy: z
            .object({
              turn: z.number().int().nonnegative(),
              primaryPluginId: DynamicIdSchema.optional(),
              consecutiveFailures: z.number().int().nonnegative(),
              repeatedFingerprintCount: z.number().int().nonnegative(),
              lastErrorFingerprint: z.string().optional(),
              blockedReason: z.string().optional(),
            })
            .strict(),
        })
        .strict(),
    ),
    authoringTasks: z.array(AuthoringTaskSummarySchema).default([]),
    scheduledTasks: z.array(ScheduledTaskSchema).default([]),
  })
  .strict()

const MessageInputPartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().trim().min(1) }).strict(),
  z.object({ type: z.literal('mention'), memberId: ChannelMemberIdSchema }).strict(),
])

const SendChannelMessageRequestSchema = z
  .object({
    parts: z.array(MessageInputPartSchema).min(1),
    clientEventId: NonEmptyStringSchema.optional(),
    senderMemberId: ChannelMemberIdSchema.optional(),
  })
  .strict()
  .refine(
    (body) => body.parts.every((part) => part.type !== 'text' || [...part.text].length <= 64 * 1024),
    'Message text must not exceed 64 KiB.',
  )

const DynamicErrorDetailsSchema = z.object({ message: z.string(), stack: z.string().optional() }).strict()
const DynamicRenderFailureSchema = z
  .object({
    slot: NonEmptyStringSchema,
    message: z.string(),
    stack: z.string().optional(),
    abdicated: z.boolean(),
  })
  .strict()
const DynamicRunResolutionSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), pluginRunId: DynamicIdSchema, waitingFor: z.array(z.string()).optional() }).strict(),
  z
    .object({
      ok: z.literal(false),
      reason: z.enum(['rejected', 'host-half-failed', 'client-half-failed']),
      pluginRunId: DynamicIdSchema.optional(),
      startedHere: z.boolean().optional(),
      message: z.string().optional(),
      stack: z.string().optional(),
    })
    .strict(),
])

const DynamicRunResponseSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      status: z.enum(['awaiting-approval', 'starting', 'running']),
      pluginId: DynamicIdSchema,
      packageId: DynamicIdSchema,
      pluginRunId: DynamicIdSchema,
      waitingFor: z.array(z.string()),
      clientWaitingFor: z.array(z.string()).optional(),
      currentPackageId: DynamicIdSchema.optional(),
      nextPackageId: DynamicIdSchema.optional(),
      mode: z.enum(['run', 'update']),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      reason: z.enum([
        'plugin-missing',
        'package-missing',
        'invalid-mode',
        'transition-in-flight',
        'host-half-failed',
        'client-half-failed',
        'rejected',
        'cancelled',
        'not-running',
      ]),
      message: z.string(),
      stack: z.string().optional(),
    })
    .strict(),
])

const DynamicInventoryRowSchema = z
  .object({
    pluginId: DynamicIdSchema,
    agentId: NonEmptyStringSchema,
    packages: z.array(
      z
        .object({
          packageId: DynamicIdSchema,
          name: z.string(),
          purpose: z.string(),
          hasHostHalf: z.boolean(),
          hasClientHalf: z.boolean(),
        })
        .strict(),
    ),
    currentPackageId: DynamicIdSchema.optional(),
    nextPackageId: DynamicIdSchema.optional(),
    activeRun: z.object({ pluginRunId: DynamicIdSchema, packageId: DynamicIdSchema }).strict().optional(),
    latestRun: DynamicLatestRunSchema.optional(),
  })
  .strict()

export const DshPluginCatalogEntrySchema = z
  .object({
    packageName: NonEmptyStringSchema,
    packageVersion: NonEmptyStringSchema,
    origin: z.enum(['builtin', 'profile', 'dynamic', 'installed']),
    settingsNamespaces: z.array(NonEmptyStringSchema),
    loadError: z.object({ code: NonEmptyStringSchema, message: NonEmptyStringSchema }).strict().optional(),
    packageId: DshPluginPackageIdSchema.optional(),
    installSource: z.enum(['registry', 'tarball', 'imported']).optional(),
    installedAt: z.number().int().safe().nonnegative().optional(),
    clientUiDetected: z.boolean().optional(),
    hostUi: DshNxtHostUiSchema.optional(),
    approvedBuilds: z.array(NonEmptyStringSchema).optional(),
    entries: z
      .array(
        z
          .object({
            id: DshPluginEntryIdSchema,
            entryKey: NonEmptyStringSchema,
            moduleName: NonEmptyStringSchema,
            suggestedScope: z.enum(['host', 'agent']),
            selectedScope: z.enum(['host', 'agent']).optional(),
            config: JsonValueSchema,
            activations: z.array(
              z
                .object({
                  targetKey: NonEmptyStringSchema,
                  target: z.enum(['host', 'agent']),
                  agentId: AgentIdSchema.optional(),
                  activatedAt: z.number().int().safe().nonnegative(),
                  diagnostic: z
                    .object({
                      status: z.enum(['active', 'load-failed', 'restore-failed', 'dispose-failed']),
                      phase: z.enum(['import', 'apply', 'update', 'dispose', 'restore']),
                      message: z.string().optional(),
                      observedAt: z.number().int().safe().nonnegative(),
                    })
                    .optional(),
                })
                .strict(),
            ),
          })
          .strict(),
      )
      .optional(),
  })
  .strict()

export const DshSettingsNamespaceSchema = z
  .object({
    ns: NonEmptyStringSchema,
    schema: JsonValueSchema,
    resolved: JsonValueSchema,
    base: JsonValueSchema.optional(),
    user: JsonValueSchema.optional(),
    applies: z.enum(['live', 'restart']),
    secrets: z.array(z.object({ path: z.array(z.string()), set: z.boolean() }).strict()),
    revision: z.number().int().nonnegative(),
    writable: z.boolean(),
    owner: z.object({ packageName: NonEmptyStringSchema, packageVersion: NonEmptyStringSchema }).strict().optional(),
  })
  .strict()

export const DshSettingsPathSchema = z.array(z.string().min(1).max(200)).min(1).max(32)

export const DshSettingsPathOperationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set'), path: DshSettingsPathSchema, value: JsonValueSchema }).strict(),
  z.object({ op: z.literal('unset'), path: DshSettingsPathSchema }).strict(),
])

export const DshSettingsMutationRequestSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    ops: z.array(DshSettingsPathOperationSchema).min(1).max(128),
  })
  .strict()

export const DshCredentialRefSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)
  .max(200)

export const DshCredentialViewSchema = z
  .object({ configured: z.boolean(), source: z.string().optional(), writable: z.boolean() })
  .strict()

export const DshSettingsChangedSseDataSchema = z
  .object({ namespace: NonEmptyStringSchema, revision: z.number().int().nonnegative() })
  .strict()

export const DshCredentialsChangedSseDataSchema = z.object({ ref: DshCredentialRefSchema }).strict()

export const DynamicChangedSseDataSchema = z.object({ agentId: AgentIdSchema }).strict()

export const HostSseStatusDataSchema = z
  .object({
    ok: z.boolean(),
    message: z.string(),
    replay: z.enum(['none', 'complete', 'expired']).optional(),
  })
  .strict()

export const DshPluginOperationSseDataSchema = z
  .object({
    operationId: z.string().uuid(),
    kind: z.enum(['inspect', 'install']),
    phase: z.enum(['download', 'dependencies', 'build-scripts', 'validation', 'publish']),
    status: z.enum(['running', 'done', 'failed']),
    message: z.string(),
  })
  .strict()

export const HostSseEventSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('snapshot-changed'), data: z.object({ changed: z.literal(true) }).strict() }).strict(),
  z.object({ event: z.literal('channel-fact'), data: ChannelFactSseDataSchema }).strict(),
  z.object({ event: z.literal('connection-fact'), data: HostConnectionEventSchema }).strict(),
  z.object({ event: z.literal('runtime'), data: ChannelRuntimeSseDataSchema }).strict(),
  z.object({ event: z.literal('extensions-changed'), data: z.object({ changed: z.literal(true) }).strict() }).strict(),
  z.object({ event: z.literal('dsh-plugins-changed'), data: z.object({ changed: z.literal(true) }).strict() }).strict(),
  z.object({ event: z.literal('dsh-plugin-operation'), data: DshPluginOperationSseDataSchema }).strict(),
  z.object({ event: z.literal('dynamic-changed'), data: DynamicChangedSseDataSchema }).strict(),
  z.object({ event: z.literal('dsh-settings-changed'), data: DshSettingsChangedSseDataSchema }).strict(),
  z.object({ event: z.literal('dsh-credentials-changed'), data: DshCredentialsChangedSseDataSchema }).strict(),
  z.object({ event: z.literal('status'), data: HostSseStatusDataSchema }).strict(),
  z
    .object({ event: z.literal('attention-changed'), data: z.object({ revision: z.string().min(1) }).strict() })
    .strict(),
  z
    .object({
      event: z.literal('binding-change'),
      data: z
        .object({
          operationId: NonEmptyStringSchema,
          channelId: ChannelIdSchema,
          kind: z.enum(['bind', 'replace', 'clear']),
          step: NonEmptyStringSchema,
          status: z.enum(['running', 'skipped', 'done', 'failed']),
          message: z.string(),
        })
        .strict(),
    })
    .strict(),
])

export type HostSseEvent = z.output<typeof HostSseEventSchema>

/** Request content a model accepts; `image` enables native vision for agents using the model. */
export const LlmModelInputModalitiesSchema = z.array(z.enum(['text', 'image'])).min(1)

export const LlmProviderModelSchema = z
  .object({
    id: NonEmptyStringSchema,
    name: NonEmptyStringSchema,
    contextWindow: z.number().int().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
    inputModalities: LlmModelInputModalitiesSchema.optional(),
  })
  .strict()

export const LlmDiscoveredModelSchema = z
  .object({
    id: NonEmptyStringSchema,
    name: NonEmptyStringSchema.optional(),
    contextWindow: z.number().int().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
    inputModalities: LlmModelInputModalitiesSchema.optional(),
  })
  .strict()

export const LlmProviderCredentialSchema = z
  .object({ configured: z.boolean(), source: z.string().optional(), writable: z.boolean() })
  .strict()

export const LlmProviderViewSchema = z
  .object({
    provider: NonEmptyStringSchema,
    displayName: z.string(),
    settingsNs: NonEmptyStringSchema,
    settingsPath: z.array(NonEmptyStringSchema),
    settingsRevision: z.number().int().nonnegative(),
    declared: z.boolean(),
    active: z.boolean(),
    configured: z.boolean(),
    baseURL: z.string().optional(),
    api: NonEmptyStringSchema.optional(),
    credential: LlmProviderCredentialSchema.optional(),
    models: z.array(LlmProviderModelSchema),
    /** The model list was edited on this host; built-in providers can restore their own catalog. */
    modelsCustomized: z.boolean(),
    /** The provider's adapter can list the models its endpoint offers. */
    discoverable: z.boolean(),
  })
  .strict()

export const LlmProviderSettingsSchema = z
  .object({
    writable: z.boolean(),
    protocols: z.array(NonEmptyStringSchema),
    providers: z.array(LlmProviderViewSchema),
  })
  .strict()

export const ConnectionTestResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('received'),
      channelId: ChannelIdSchema,
      platformMessageId: NonEmptyStringSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal('sent'),
      channelId: ChannelIdSchema,
      platformMessageId: NonEmptyStringSchema.optional(),
    })
    .strict(),
  z
    .object({
      status: z.enum(['waiting-for-message', 'needs-channel', 'needs-target', 'not-connected']),
      message: z.string(),
    })
    .strict(),
  z
    .object({
      status: z.literal('failed'),
      kind: NonEmptyStringSchema,
      message: z.string(),
      retryAfterMs: z.number().int().nonnegative().optional(),
    })
    .strict(),
])

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
type AnySchema = z.ZodType

export interface HostApiContract<
  Method extends HttpMethod = HttpMethod,
  Params extends AnySchema = AnySchema,
  Request extends AnySchema = AnySchema,
  Response extends AnySchema = AnySchema,
  ErrorSchema extends AnySchema = AnySchema,
> {
  readonly method: Method
  readonly timeoutMs?: number
  readonly responseFormat?: 'json' | 'bytes'
  readonly invalidatesSnapshot?: boolean
  encodeRequest?(input: z.output<Request>): {
    readonly body: string | Uint8Array
    readonly headers: Readonly<Record<string, string>>
  }
  readonly path: string
  readonly params: Params
  readonly request: Request
  readonly response: Response
  readonly error: ErrorSchema
  readonly parseParams: (input: unknown) => z.output<Params>
  readonly parseRequest: (input: unknown) => z.output<Request>
  readonly parseResponse: (input: unknown) => z.output<Response>
  readonly parseError: (input: unknown) => z.output<ErrorSchema>
}

/** 扩展包导入检查的结果：本地文件与社区下载共用同一确认步骤。 */
export const ExtensionImportInspectionSchema = z
  .object({
    token: NonEmptyStringSchema,
    extensionId: ExtensionIdSchema,
    revisionId: ExtensionRevisionIdSchema,
    slug: NonEmptyStringSchema,
    displayName: NonEmptyStringSchema,
    scope: z.enum(['agent', 'host-adapter', 'host-ui']),
    idempotent: z.boolean(),
    slugConflict: z.boolean(),
  })
  .strict()

const defineContract = <
  const Method extends HttpMethod,
  Params extends AnySchema,
  Request extends AnySchema,
  Response extends AnySchema,
>(
  contract: Omit<
    HostApiContract<Method, Params, Request, Response, typeof HostApiErrorSchema>,
    'parseParams' | 'parseRequest' | 'parseResponse' | 'parseError'
  >,
): HostApiContract<Method, Params, Request, Response, typeof HostApiErrorSchema> => ({
  ...contract,
  parseParams: (input) => contract.params.parse(input),
  parseRequest: (input) => contract.request.parse(input),
  parseResponse: (input) => contract.response.parse(input),
  parseError: (input) => contract.error.parse(input),
})

const agentParam = z.object({ agentId: AgentIdSchema }).strict()
const agentRevisionParam = z.object({ agentId: AgentIdSchema, revisionId: AgentRevisionIdSchema }).strict()

export const AgentRevisionChangedFieldSchema = z.enum([
  'name',
  'persona',
  'model',
  'capabilities',
  'imagePolicy',
  'approvalPolicy',
])

export const AgentRevisionHistorySchema = z
  .object({
    agentId: AgentIdSchema,
    currentRevisionId: AgentRevisionIdSchema,
    /** Newest first. `changedFields` compares each Revision with the one numbered just before it. */
    revisions: z.array(
      z
        .object({
          id: AgentRevisionIdSchema,
          revision: z.number().int().positive(),
          createdAt: z.number().int().nonnegative(),
          displayName: z.string(),
          model: z.object({ provider: z.string(), model: z.string() }).strict(),
          changedFields: z.array(AgentRevisionChangedFieldSchema),
          current: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict()
export type AgentRevisionHistory = z.output<typeof AgentRevisionHistorySchema>
const channelParam = z.object({ channelId: ChannelIdSchema }).strict()
const connectionParam = z.object({ connectionId: ConnectionIdSchema }).strict()
const agentExtensionParam = z.object({ agentId: AgentIdSchema, extensionId: ExtensionIdSchema }).strict()
const extensionParam = z.object({ extensionId: ExtensionIdSchema }).strict()
const dshPluginPackageParam = z.object({ packageId: DshPluginPackageIdSchema }).strict()
const dshPluginEntryParam = z.object({ entryId: DshPluginEntryIdSchema }).strict()
const extensionRevisionParam = z
  .object({ extensionId: ExtensionIdSchema, revisionId: ExtensionRevisionIdSchema })
  .strict()
const dshSettingsParam = z.object({ namespace: NonEmptyStringSchema }).strict()
const dshCredentialParam = z.object({ ref: DshCredentialRefSchema }).strict()
const llmProviderParam = z.object({ provider: NonEmptyStringSchema }).strict()
const authoringTaskParam = z.object({ taskId: AuthoringTaskIdSchema }).strict()
const scheduledTaskParam = z.object({ taskId: ScheduledTaskIdSchema }).strict()
const authoringAttemptParam = z.object({ taskId: AuthoringTaskIdSchema, attemptId: AuthoringAttemptIdSchema }).strict()

const DshPluginInstallInspectionSchema = z
  .object({
    token: NonEmptyStringSchema,
    operationId: z.string().uuid().optional(),
    packageName: NonEmptyStringSchema,
    packageVersion: NonEmptyStringSchema,
    packageDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    lockfileDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    blockedBuilds: z.array(NonEmptyStringSchema),
    clientUiDetected: z.boolean(),
    hostUi: DshNxtHostUiSchema.optional(),
    entries: z.array(
      z
        .object({
          entryKey: NonEmptyStringSchema,
          moduleName: NonEmptyStringSchema,
          suggestedScope: z.enum(['host', 'agent']),
        })
        .strict(),
    ),
  })
  .strict()

const BinaryUploadRequestSchema = z
  .object({
    bytes: z.instanceof(Uint8Array),
    fileName: z.string().max(255).optional(),
    operationId: z.string().uuid().optional(),
  })
  .strict()
const encodeBinaryUpload = (input: z.output<typeof BinaryUploadRequestSchema>) => ({
  body: input.bytes,
  headers: {
    'content-type': 'application/octet-stream',
    ...(input.fileName === undefined ? {} : { 'x-file-name': input.fileName }),
    ...(input.operationId === undefined ? {} : { 'x-operation-id': input.operationId }),
  },
})

export const HostApiContracts = {
  retryRuntimeCompatibility: defineContract({
    method: 'POST',
    path: '/api/runtime/compatibility/retry',
    params: EmptyParamsSchema,
    request: z
      .object({ objectKind: RuntimeCompatibilityDiagnosticSchema.shape.objectKind, objectId: z.string().min(1) })
      .strict(),
    response: z.object({ diagnostics: z.array(RuntimeCompatibilityDiagnosticSchema) }).strict(),
    error: HostApiErrorSchema,
    invalidatesSnapshot: true,
  }),
  snapshot: defineContract({
    method: 'GET',
    path: '/api/snapshot',
    params: EmptyParamsSchema,
    request: NoRequestBodySchema,
    response: HostSnapshotSchema,
    error: HostApiErrorSchema,
  }),
  getAuthoringTask: defineContract({
    method: 'GET',
    path: '/api/authoring/tasks/:taskId',
    params: authoringTaskParam,
    request: NoRequestBodySchema,
    response: z
      .object({
        task: AuthoringTaskSummarySchema,
        attempts: z.array(AuthoringAttemptSummarySchema),
        /** Secret fields of the latest candidate and which have a test value for this task's dynamic runs. */
        testSecrets: z
          .object({
            fields: z.array(z.object({ key: z.string(), title: z.string() }).strict()),
            configured: z.array(z.string()),
          })
          .strict()
          .optional(),
        events: z.array(
          z
            .object({
              sequence: z.number().int().positive(),
              kind: z.string(),
              attemptId: AuthoringAttemptIdSchema.optional(),
              payload: JsonValueSchema,
              createdAt: z.number().int().nonnegative(),
            })
            .strict(),
        ),
      })
      .strict(),
    error: HostApiErrorSchema,
  }),
  decideAuthoringAttempt: defineContract({
    invalidatesSnapshot: true,
    method: 'POST',
    path: '/api/authoring/tasks/:taskId/attempts/:attemptId/decision',
    params: authoringAttemptParam,
    request: z
      .object({ expectedRevision: z.number().int().positive(), approved: z.boolean(), approveRiskStable: z.boolean() })
      .strict(),
    response: z
      .object({ accepted: z.boolean(), taskRevision: z.number().int().positive(), executionRequired: z.boolean() })
      .strict(),
    error: HostApiErrorSchema,
  }),
  restoreAuthoringAttempt: defineContract({
    invalidatesSnapshot: true,
    method: 'POST',
    path: '/api/authoring/tasks/:taskId/attempts/:attemptId/restore',
    params: authoringAttemptParam,
    request: z.object({ expectedRevision: z.number().int().positive() }).strict(),
    response: AuthoringTaskSummarySchema,
    error: HostApiErrorSchema,
  }),
  stopAuthoringTask: defineContract({
    invalidatesSnapshot: true,
    method: 'POST',
    path: '/api/authoring/tasks/:taskId/stop',
    params: authoringTaskParam,
    request: z.object({ expectedRevision: z.number().int().positive() }).strict(),
    response: AuthoringTaskSummarySchema,
    error: HostApiErrorSchema,
  }),
  setAuthoringTestSecrets: defineContract({
    method: 'PUT',
    path: '/api/authoring/tasks/:taskId/test-secrets',
    params: authoringTaskParam,
    request: z.object({ secrets: z.record(z.string(), z.string().max(8192)) }).strict(),
    response: z.object({ configured: z.array(z.string()) }).strict(),
    error: HostApiErrorSchema,
  }),
  deleteAuthoringTask: defineContract({
    invalidatesSnapshot: true,
    method: 'DELETE',
    path: '/api/authoring/tasks/:taskId',
    params: authoringTaskParam,
    request: NoRequestBodySchema,
    response: z.object({ deleted: z.literal(true) }).strict(),
    error: HostApiErrorSchema,
  }),
  pauseScheduledTask: defineContract({
    invalidatesSnapshot: true,
    method: 'POST',
    path: '/api/scheduled-tasks/:taskId/pause',
    params: scheduledTaskParam,
    request: NoRequestBodySchema,
    response: ScheduledTaskSchema,
    error: HostApiErrorSchema,
  }),
  resumeScheduledTask: defineContract({
    invalidatesSnapshot: true,
    method: 'POST',
    path: '/api/scheduled-tasks/:taskId/resume',
    params: scheduledTaskParam,
    request: NoRequestBodySchema,
    response: ScheduledTaskSchema,
    error: HostApiErrorSchema,
  }),
  runScheduledTask: defineContract({
    invalidatesSnapshot: true,
    method: 'POST',
    path: '/api/scheduled-tasks/:taskId/run',
    params: scheduledTaskParam,
    request: NoRequestBodySchema,
    /** `woke: false` when the owning extension's due-job handler let this run pass without waking the agent. */
    response: z.object({ task: ScheduledTaskSchema, woke: z.boolean() }).strict(),
    error: HostApiErrorSchema,
  }),
  deleteScheduledTask: defineContract({
    invalidatesSnapshot: true,
    method: 'DELETE',
    path: '/api/scheduled-tasks/:taskId',
    params: scheduledTaskParam,
    request: NoRequestBodySchema,
    response: z.object({ deleted: z.literal(true) }).strict(),
    error: HostApiErrorSchema,
  }),
  listClientNotifications: defineContract({
    method: 'GET',
    path: '/api/client-notifications',
    params: z.object({ cursor: z.number().int().nonnegative().optional() }).strict(),
    request: NoRequestBodySchema,
    response: ClientNotificationFeedResponseSchema,
    error: HostApiErrorSchema,
  }),
  updateNotificationSettings: defineContract({
    invalidatesSnapshot: true,
    method: 'PUT',
    path: '/api/settings/notifications',
    params: EmptyParamsSchema,
    request: UpdateNotificationSettingsRequestSchema,
    response: NotificationSettingsViewSchema,
    error: HostApiErrorSchema,
  }),
  testBarkNotification: defineContract({
    method: 'POST',
    path: '/api/settings/notifications/test',
    params: EmptyParamsSchema,
    request: TestBarkNotificationRequestSchema,
    response: z.object({ sent: z.literal(true) }).strict(),
    error: HostApiErrorSchema,
  }),
  testSystemNotification: defineContract({
    method: 'POST',
    path: '/api/settings/notifications/test-system',
    params: EmptyParamsSchema,
    request: NoRequestBodySchema,
    response: z.object({ published: z.literal(true) }).strict(),
    error: HostApiErrorSchema,
  }),
  listPlatformUsers: defineContract({
    method: 'GET',
    path: '/api/platform-users',
    params: z
      .object({
        query: z.string().trim().max(80).optional(),
        adapterKey: z.string().trim().min(1).max(120).optional(),
        connectionId: ConnectionIdSchema.optional(),
        cursor: PlatformIdentityIdSchema.optional(),
        limit: z.number().int().min(1).max(100).default(50),
      })
      .strict(),
    request: NoRequestBodySchema,
    response: PlatformUserListResponseSchema,
    error: HostApiErrorSchema,
  }),
  listConnectionEvents: defineContract({
    method: 'GET',
    path: '/api/connections/:connectionId/events',
    params: z
      .object({
        connectionId: ConnectionIdSchema,
        beforeReceivedAt: z.number().int().safe().nonnegative().optional(),
        beforeId: ConnectionEventIdSchema.optional(),
        limit: z.number().int().min(1).max(100).default(50),
      })
      .strict(),
    request: NoRequestBodySchema,
    response: z.object({ events: z.array(HostConnectionEventSchema), hasMore: z.boolean() }).strict(),
    error: HostApiErrorSchema,
  }),
  createAgent: defineContract({
    invalidatesSnapshot: true,
    method: 'POST',
    path: '/api/agents',
    params: EmptyParamsSchema,
    request: CreateAgentRequestSchema,
    response: z
      .object({ agentId: AgentIdSchema, channelId: ChannelIdSchema, connectionId: ConnectionIdSchema })
      .strict(),
    error: HostApiErrorSchema,
  }),
  reviseAgent: defineContract({
    invalidatesSnapshot: true,
    method: 'POST',
    path: '/api/agents/:agentId/revision',
    params: agentParam,
    request: ReviseAgentRequestSchema,
    response: z.object({ currentRevisionId: AgentRevisionIdSchema }).strict(),
    error: HostApiErrorSchema,
  }),
  updateAgentCapabilities: defineContract({
    invalidatesSnapshot: true,
    method: 'POST',
    path: '/api/agents/:agentId/capabilities',
    params: agentParam,
    request: UpdateAgentCapabilitiesRequestSchema,
    response: z.object({ currentRevisionId: AgentRevisionIdSchema, capabilities: AgentCapabilitiesSchema }).strict(),
    error: HostApiErrorSchema,
  }),
  deleteAgent: defineContract({
    invalidatesSnapshot: true,
    method: 'DELETE',
    path: '/api/agents/:agentId',
    params: agentParam,
    request: z
      .object({
        expectedCurrentRevisionId: AgentRevisionIdSchema,
        confirmationName: z.string().min(1).max(80),
        deleteAutoCreatedBuiltInChannels: z.boolean().default(true),
        /** Also remove `workspaces/<agentId>/` (files, development shell output, creation candidates). */
        deleteWorkspace: z.boolean().default(false),
      })
      .strict(),
    response: z
      .object({
        agentId: AgentIdSchema,
        deleted: z.literal(true),
        unboundChannelIds: z.array(ChannelIdSchema),
        deletedChannelIds: z.array(ChannelIdSchema),
      })
      .strict(),
    error: HostApiErrorSchema,
  }),
  createInternalChannel: defineContract({
    invalidatesSnapshot: true,
    method: 'POST',
    path: '/api/channels',
    params: EmptyParamsSchema,
    request: z.object({ displayName: z.string().trim().min(1).max(120) }).strict(),
    response: z.object({ channelId: ChannelIdSchema, connectionId: ConnectionIdSchema }).strict(),
    error: HostApiErrorSchema,
  }),
  deleteChannel: defineContract({
    invalidatesSnapshot: true,
    method: 'DELETE',
    path: '/api/channels/:channelId',
    params: channelParam,
    request: z.object({ expectedBoundAgentId: AgentIdSchema.nullable() }).strict(),
    response: z.object({ channelId: ChannelIdSchema, deleted: z.literal(true) }).strict(),
    error: HostApiErrorSchema,
  }),
  createBinding: defineContract({
    invalidatesSnapshot: true,
    method: 'POST',
    path: '/api/bindings',
    params: EmptyParamsSchema,
    request: z
      .object({
        agentId: AgentIdSchema,
        channelId: ChannelIdSchema,
        triggerPolicy: TriggerPolicySchema,
        processingFeedback: z.enum(['auto', 'off']).optional(),
        activityTriggerOverrides: ActivityTriggerOverridesSchema.optional(),
      })
      .strict(),
    response: z
      .object({
        channelId: ChannelIdSchema,
        agentId: AgentIdSchema,
        triggerPolicy: TriggerPolicySchema,
        processingFeedback: z.enum(['auto', 'off']).default('auto'),
        activityTriggerOverrides: ActivityTriggerOverridesSchema.default({}),
        boundAt: z.number().int().safe().nonnegative(),
      })
      .strict(),
    error: HostApiErrorSchema,
  }),
  clearBinding: defineContract({
    invalidatesSnapshot: true,
    method: 'DELETE',
    path: '/api/bindings/:channelId',
    params: channelParam,
    request: NoRequestBodySchema,
    response: z.object({ channelId: ChannelIdSchema, cleared: z.literal(true) }).strict(),
    error: HostApiErrorSchema,
  }),
  putWorkTreeOrder: defineContract({
    invalidatesSnapshot: true,
    method: 'PUT',
    path: '/api/work-tree-order',
    params: EmptyParamsSchema,
    request: WorkTreeOrderSchema,
    response: WorkTreeOrderSchema,
    error: HostApiErrorSchema,
  }),
  listChannelMessages: defineContract({
    method: 'GET',
    path: '/api/channels/:channelId/messages',
    params: z
      .object({
        channelId: ChannelIdSchema,
        limit: z.number().int().min(1).max(100),
        beforeOccurredAt: z.number().int().safe().nonnegative().optional(),
        beforeSourceId: NonEmptyStringSchema.optional(),
      })
      .strict()
      .refine(
        (value) => (value.beforeOccurredAt === undefined) === (value.beforeSourceId === undefined),
        '频道历史游标必须完整提供。',
      ),
    request: NoRequestBodySchema,
    response: z
      .object({ messages: z.array(HostSnapshotMessageSchema), hasMore: z.boolean(), cursor: HostSyncCursorSchema })
      .strict(),
    error: HostApiErrorSchema,
  }),
  sendChannelMessage: defineContract({
    method: 'POST',
    path: '/api/channels/:channelId/messages',
    params: channelParam,
    request: SendChannelMessageRequestSchema,
    response: z
      .object({
        inserted: z.boolean(),
        channelEventId: ChannelEventIdSchema.optional(),
        outboundIntentId: OutboundIntentIdSchema.optional(),
      })
      .strict(),
    error: HostApiErrorSchema,
  }),
  renameChannel: defineContract({
    invalidatesSnapshot: true,
    method: 'POST',
    path: '/api/channels/:channelId/display-name',
    params: channelParam,
    request: z.object({ displayName: z.string().trim().min(1).max(120) }).strict(),
    response: z.object({ channelId: ChannelIdSchema, displayName: z.string().trim().min(1).max(120) }).strict(),
    error: HostApiErrorSchema,
  }),
  getChannelRuntime: defineContract({
    method: 'GET',
    path: '/api/channels/:channelId/runtime',
    params: channelParam,
    request: NoRequestBodySchema,
    response: ChannelRuntimeProjectionSchema.extend({ cursor: HostSyncCursorSchema }),
    error: HostApiErrorSchema,
  }),
  getChannelToolCall: defineContract({
    method: 'GET',
    path: '/api/channels/:channelId/runtime/tools/:callId',
    params: z.object({ channelId: ChannelIdSchema, callId: z.string().trim().min(1).max(200) }).strict(),
    request: NoRequestBodySchema,
    // The full arguments and result of one tool call in the live session; the runtime projection only carries previews.
    // `available: false` when the session has left memory: the step keeps its preview, which is not an error.
    response: z
      .object({
        callId: z.string(),
        available: z.boolean(),
        name: z.string().optional(),
        input: z.string().optional(),
        result: z.string().optional(),
        inputTruncated: z.boolean(),
        resultTruncated: z.boolean(),
      })
      .strict(),
    error: HostApiErrorSchema,
  }),
  resetChannelContext: defineContract({
    invalidatesSnapshot: true,
    method: 'POST',
    path: '/api/channels/:channelId/context-reset',
    params: channelParam,
    request: z
      .object({
        mode: z.enum(['clear', 'compact']),
        expectedEpisodeId: EpisodeIdSchema,
      })
      .strict(),
    response: z
      .object({
        mode: z.enum(['clear', 'compact']),
        closedEpisodeId: EpisodeIdSchema,
        nextEpisodeId: EpisodeIdSchema.optional(),
      })
      .strict(),
    error: HostApiErrorSchema,
  }),
  createConnection: defineContract({
    invalidatesSnapshot: true,
    method: 'POST',
    path: '/api/connections',
    params: EmptyParamsSchema,
    request: z
      .object({
        adapterKey: NonEmptyStringSchema,
        alias: ConnectionAliasInputSchema.optional(),
        configuration: z.record(z.string(), JsonValueSchema).default({}),
        credentials: z.record(z.string(), z.string().max(16 * 1024)).default({}),
      })
      .strict(),
    response: z.object({ connectionId: ConnectionIdSchema, adapterKey: NonEmptyStringSchema }).strict(),
    error: HostApiErrorSchema,
  }),
  startConnectionLogin: defineContract({
    method: 'POST',
    path: '/api/connection-logins',
    params: EmptyParamsSchema,
    request: z
      .object({
        adapterKey: NonEmptyStringSchema,
        alias: ConnectionAliasInputSchema.optional(),
        connectionId: ConnectionIdSchema.optional(),
      })
      .strict(),
    response: z
      .object({
        loginId: NonEmptyStringSchema,
        adapterKey: NonEmptyStringSchema,
        status: z.enum(['pending', 'scanned', 'confirmed', 'expired', 'failed', 'cancelled']),
        qrCodeUrl: NonEmptyStringSchema,
        message: z.string().optional(),
      })
      .strict(),
    error: HostApiErrorSchema,
  }),
  getConnectionLogin: defineContract({
    method: 'GET',
    path: '/api/connection-logins/:loginId',
    params: z.object({ loginId: NonEmptyStringSchema }).strict(),
    request: NoRequestBodySchema,
    response: z
      .object({
        loginId: NonEmptyStringSchema,
        status: z.enum(['pending', 'scanned', 'confirmed', 'expired', 'failed', 'cancelled']),
        qrCodeUrl: NonEmptyStringSchema.optional(),
        connectionId: ConnectionIdSchema.optional(),
        adapterKey: NonEmptyStringSchema,
        message: z.string().optional(),
      })
      .strict(),
    error: HostApiErrorSchema,
  }),
  cancelConnectionLogin: defineContract({
    method: 'DELETE',
    path: '/api/connection-logins/:loginId',
    params: z.object({ loginId: NonEmptyStringSchema }).strict(),
    request: NoRequestBodySchema,
    response: z
      .object({
        loginId: NonEmptyStringSchema,
        status: z.literal('cancelled'),
      })
      .strict(),
    error: HostApiErrorSchema,
  }),
  updateConnectionAlias: defineContract({
    invalidatesSnapshot: true,
    method: 'POST',
    path: '/api/connections/:connectionId/alias',
    params: connectionParam,
    request: z.object({ alias: z.string().trim().max(80) }).strict(),
    response: z
      .object({
        connectionId: ConnectionIdSchema,
        alias: ConnectionAliasOutputSchema.optional(),
      })
      .strict(),
    error: HostApiErrorSchema,
  }),
  updateConnectionActivityTriggerDefaults: defineContract({
    invalidatesSnapshot: true,
    method: 'POST',
    path: '/api/connections/:connectionId/activity-trigger-defaults',
    params: connectionParam,
    request: z.object({ activityKeys: z.array(AdapterActivityKeySchema) }).strict(),
    response: z.object({ connectionId: ConnectionIdSchema, activityKeys: z.array(AdapterActivityKeySchema) }).strict(),
    error: HostApiErrorSchema,
  }),
  updateConnectionConfiguration: defineContract({
    invalidatesSnapshot: true,
    method: 'POST',
    path: '/api/connections/:connectionId/configuration',
    params: connectionParam,
    request: z.object({ configuration: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])) }).strict(),
    response: z
      .object({
        connectionId: ConnectionIdSchema,
        configuration: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
      })
      .strict(),
    error: HostApiErrorSchema,
  }),
  deleteConnection: defineContract({
    invalidatesSnapshot: true,
    method: 'DELETE',
    path: '/api/connections/:connectionId',
    params: connectionParam,
    request: z.object({ deleteChannelData: z.boolean() }).strict(),
    response: z.object({ connectionId: ConnectionIdSchema, archived: z.boolean() }).strict(),
    error: HostApiErrorSchema,
  }),
  restoreConnection: defineContract({
    invalidatesSnapshot: true,
    method: 'POST',
    path: '/api/connections/:connectionId/restore',
    params: connectionParam,
    request: NoRequestBodySchema,
    response: z.object({ connectionId: ConnectionIdSchema, restored: z.literal(true) }).strict(),
    error: HostApiErrorSchema,
  }),
  dshPlugins: defineContract({
    method: 'GET',
    path: '/api/dsh/plugins',
    params: EmptyParamsSchema,
    request: NoRequestBodySchema,
    response: z.object({ plugins: z.array(DshPluginCatalogEntrySchema) }).strict(),
    error: HostApiErrorSchema,
  }),
  inspectDshPluginTarball: defineContract({
    method: 'POST',
    timeoutMs: 300_000,
    path: '/api/dsh/plugin-installs/inspect-tarball',
    params: EmptyParamsSchema,
    request: BinaryUploadRequestSchema,
    encodeRequest: encodeBinaryUpload,
    response: DshPluginInstallInspectionSchema,
    error: HostApiErrorSchema,
  }),
  exportExtensionRevision: defineContract({
    method: 'GET',
    timeoutMs: 300_000,
    path: '/api/extensions/:extensionId/revisions/:revisionId/export',
    params: extensionRevisionParam,
    request: NoRequestBodySchema,
    responseFormat: 'bytes',
    response: z.instanceof(Uint8Array),
    error: HostApiErrorSchema,
  }),
  inspectDshPluginInstall: defineContract({
    timeoutMs: 300_000,
    method: 'POST',
    path: '/api/dsh/plugin-installs/inspect',
    params: EmptyParamsSchema,
    request: z.object({ spec: NonEmptyStringSchema.max(500), operationId: z.string().uuid().optional() }).strict(),
    response: DshPluginInstallInspectionSchema,
    error: HostApiErrorSchema,
  }),
  commitDshPluginInstall: defineContract({
    invalidatesSnapshot: true,
    timeoutMs: 300_000,
    method: 'POST',
    path: '/api/dsh/plugin-installs',
    params: EmptyParamsSchema,
    request: z
      .object({
        token: NonEmptyStringSchema,
        approvedBuilds: z.array(NonEmptyStringSchema).default([]),
        operationId: z.string().uuid().optional(),
      })
      .strict(),
    response: z.object({ packageId: DshPluginPackageIdSchema, operationId: z.string().uuid().optional() }).strict(),
    error: HostApiErrorSchema,
  }),
  inspectDshPluginEntryConfig: defineContract({
    method: 'POST',
    path: '/api/dsh/plugin-entries/:entryId/config/inspect',
    params: dshPluginEntryParam,
    request: NoRequestBodySchema,
    response: z.discriminatedUnion('mode', [
      z.object({ mode: z.literal('schema'), schema: JsonValueSchema }).strict(),
      z.object({ mode: z.literal('json') }).strict(),
      z.object({ mode: z.literal('incompatible'), reason: NonEmptyStringSchema }).strict(),
    ]),
    error: HostApiErrorSchema,
  }),
  activateDshPluginEntry: defineContract({
    method: 'PUT',
    path: '/api/dsh/plugin-entries/:entryId/activation',
    params: dshPluginEntryParam,
    request: z
      .object({
        target: z.enum(['host', 'agent']),
        agentId: AgentIdSchema.optional(),
        config: JsonValueSchema,
        permissionApproval: z
          .object({ permissionDigest: z.string().regex(/^[a-f0-9]{64}$/u) })
          .strict()
          .optional(),
      })
      .strict(),
    response: z.object({ targetKey: NonEmptyStringSchema }).strict(),
    error: HostApiErrorSchema,
  }),
  deactivateDshPluginEntry: defineContract({
    method: 'DELETE',
    path: '/api/dsh/plugin-entries/:entryId/activation',
    params: dshPluginEntryParam,
    request: z.object({ targetKey: NonEmptyStringSchema }).strict(),
    response: z.object({ disabled: z.literal(true) }).strict(),
    error: HostApiErrorSchema,
  }),
  removeDshPluginPackage: defineContract({
    invalidatesSnapshot: true,
    method: 'DELETE',
    path: '/api/dsh/plugin-installs/:packageId',
    params: dshPluginPackageParam,
    request: NoRequestBodySchema,
    response: z.object({ removed: z.literal(true) }).strict(),
    error: HostApiErrorSchema,
  }),
  inspectExtensionImport: defineContract({
    timeoutMs: 300_000,
    method: 'POST',
    path: '/api/extensions/imports/inspect',
    params: EmptyParamsSchema,
    request: BinaryUploadRequestSchema,
    encodeRequest: encodeBinaryUpload,
    response: ExtensionImportInspectionSchema,
    error: HostApiErrorSchema,
  }),
  /**
   * Management-edge endpoints: they exist only when the Server is reached through its management edge (a management
   * key is set); clients tell that from the edge's CSRF cookie.
   */
  listManagementDevices: defineContract({
    method: 'GET',
    path: '/api/management/devices',
    params: EmptyParamsSchema,
    request: NoRequestBodySchema,
    response: z.object({ devices: z.array(ManagementDeviceViewSchema) }).strict(),
    error: HostApiErrorSchema,
  }),
  revokeManagementDevice: defineContract({
    method: 'DELETE',
    path: '/api/management/devices/:deviceId',
    params: z.object({ deviceId: ManagementDeviceIdSchema }).strict(),
    request: NoRequestBodySchema,
    response: z.object({ revoked: z.boolean() }).strict(),
    error: HostApiErrorSchema,
  }),
  managementLogout: defineContract({
    method: 'DELETE',
    path: '/api/management/session',
    params: EmptyParamsSchema,
    request: NoRequestBodySchema,
    response: z.object({ authenticated: z.literal(false) }).strict(),
    error: HostApiErrorSchema,
  }),
  getCommunityStatus: defineContract({
    method: 'GET',
    path: '/api/community/status',
    params: EmptyParamsSchema,
    request: NoRequestBodySchema,
    response: CommunityStatusSchema,
    error: HostApiErrorSchema,
  }),
  startCommunityLogin: defineContract({
    method: 'POST',
    path: '/api/community/login',
    params: EmptyParamsSchema,
    /** 浏览器当前访问本实例使用的来源；社区授权完成后回到 `<returnOrigin>/community/callback`。 */
    request: z.object({ returnOrigin: z.string().url().max(300) }).strict(),
    response: z.object({ authorizeUrl: z.string().url() }).strict(),
    error: HostApiErrorSchema,
  }),
  communityLogout: defineContract({
    method: 'DELETE',
    path: '/api/community/login',
    params: EmptyParamsSchema,
    request: NoRequestBodySchema,
    response: CommunityStatusSchema,
    error: HostApiErrorSchema,
  }),
  listCommunityExtensions: defineContract({
    timeoutMs: 30_000,
    method: 'GET',
    path: '/api/community/extensions',
    params: z
      .object({
        query: z.string().trim().max(80).optional(),
        scope: z.enum(['agent', 'host-adapter', 'host-ui']).optional(),
        /** 只列社区后台认定的官方扩展。 */
        official: z.enum(['1']).optional(),
        cursor: z.string().max(200).optional(),
      })
      .strict(),
    request: NoRequestBodySchema,
    response: z.object({ items: z.array(CommunityExtensionSummarySchema), nextCursor: z.string().nullable() }).strict(),
    error: HostApiErrorSchema,
  }),
  getCommunityExtension: defineContract({
    timeoutMs: 30_000,
    method: 'GET',
    path: '/api/community/extensions/:extensionId',
    params: z.object({ extensionId: ExtensionIdSchema }).strict(),
    request: NoRequestBodySchema,
    response: CommunityExtensionDetailSchema,
    error: HostApiErrorSchema,
  }),
  /** 下载社区发布并按包摘要校验，结果与本地文件导入的检查相同，再经 `commitExtensionImport` 确认。 */
  getCommunityEndpoint: defineContract({
    method: 'GET',
    path: '/api/community/endpoint',
    params: EmptyParamsSchema,
    request: NoRequestBodySchema,
    response: CommunityEndpointSchema,
    error: HostApiErrorSchema,
  }),
  /** 修改社区地址；`url: null` 恢复为环境变量或默认地址。非加密的局域网地址需要确认风险。 */
  updateCommunityEndpoint: defineContract({
    method: 'PUT',
    path: '/api/community/endpoint',
    params: EmptyParamsSchema,
    request: z.object({ url: z.string().max(300).nullable(), acknowledgeInsecure: z.boolean() }).strict(),
    response: CommunityEndpointSchema,
    error: HostApiErrorSchema,
  }),
  testCommunityEndpoint: defineContract({
    timeoutMs: 30_000,
    method: 'POST',
    path: '/api/community/endpoint/test',
    params: EmptyParamsSchema,
    request: z.object({ url: z.string().max(300), acknowledgeInsecure: z.boolean() }).strict(),
    response: z
      .object({
        ok: z.boolean(),
        message: z.string(),
        name: z.string().optional(),
        environment: z.enum(['production', 'staging', 'development']).optional(),
      })
      .strict(),
    error: HostApiErrorSchema,
  }),
  listCommunityInstalled: defineContract({
    timeoutMs: 30_000,
    method: 'GET',
    path: '/api/community/installed',
    params: z.object({ refresh: z.enum(['1']).optional() }).strict(),
    request: NoRequestBodySchema,
    response: CommunityInstalledSchema,
    error: HostApiErrorSchema,
  }),
  listCommunityMine: defineContract({
    timeoutMs: 30_000,
    method: 'GET',
    path: '/api/community/mine',
    params: EmptyParamsSchema,
    request: NoRequestBodySchema,
    response: z.object({ items: z.array(CommunityMyExtensionSchema) }).strict(),
    error: HostApiErrorSchema,
  }),
  getCommunityReleaseReview: defineContract({
    timeoutMs: 30_000,
    method: 'GET',
    path: '/api/community/releases/:releaseId/review',
    params: z.object({ releaseId: CommunityReleaseIdSchema }).strict(),
    request: NoRequestBodySchema,
    response: CommunityReviewReportSchema,
    error: HostApiErrorSchema,
  }),
  requestCommunityReview: defineContract({
    timeoutMs: 30_000,
    method: 'POST',
    path: '/api/community/releases/:releaseId/review',
    params: z.object({ releaseId: CommunityReleaseIdSchema }).strict(),
    request: NoRequestBodySchema,
    response: z.object({ ok: z.literal(true) }).strict(),
    error: HostApiErrorSchema,
  }),
  withdrawCommunityRelease: defineContract({
    timeoutMs: 30_000,
    method: 'POST',
    path: '/api/community/releases/:releaseId/withdraw',
    params: z.object({ releaseId: CommunityReleaseIdSchema }).strict(),
    request: NoRequestBodySchema,
    response: z.object({ ok: z.literal(true) }).strict(),
    error: HostApiErrorSchema,
  }),
  importCommunityRelease: defineContract({
    timeoutMs: 120_000,
    method: 'POST',
    path: '/api/community/releases/:releaseId/import',
    params: z.object({ releaseId: CommunityReleaseIdSchema }).strict(),
    request: NoRequestBodySchema,
    response: ExtensionImportInspectionSchema,
    error: HostApiErrorSchema,
  }),
  publishToCommunity: defineContract({
    timeoutMs: 120_000,
    method: 'POST',
    path: '/api/community/publish',
    params: EmptyParamsSchema,
    request: z
      .object({
        extensionId: ExtensionIdSchema,
        revisionId: ExtensionRevisionIdSchema,
        notes: z.string().max(2000),
      })
      .strict(),
    response: z
      .object({
        releaseId: CommunityReleaseIdSchema,
        reviewStatus: CommunityReviewStatusSchema,
        pageUrl: z.string().url(),
        reportUrl: z.string().url(),
        findings: z.array(z.object({ severity: z.string(), title: z.string() }).strict()),
      })
      .strict(),
    error: HostApiErrorSchema,
  }),
  listCommunityPersonas: defineContract({
    timeoutMs: 30_000,
    method: 'GET',
    path: '/api/community/personas',
    params: z
      .object({
        query: z.string().trim().min(1).max(200).optional(),
        tag: z.string().trim().min(1).max(40).optional(),
        official: z.literal('1').optional(),
        cursor: z.string().min(1).max(500).optional(),
      })
      .strict(),
    request: NoRequestBodySchema,
    response: z.object({ items: z.array(CommunityPersonaSummarySchema), nextCursor: z.string().nullable() }).strict(),
    error: HostApiErrorSchema,
  }),
  getCommunityPersona: defineContract({
    timeoutMs: 30_000,
    method: 'GET',
    path: '/api/community/personas/:personaId',
    params: z.object({ personaId: CommunityPersonaIdSchema }).strict(),
    request: NoRequestBodySchema,
    response: CommunityPersonaDetailSchema,
    error: HostApiErrorSchema,
  }),
  /**
   * 把社区人设装进本机：新建一个智能体，或为现有智能体保存一次只换设定（及可选名称）的新配置。头像下载后作为
   * 智能体头像；下载失败不影响安装。`expectedRevisionId` 是用户看过的修订，社区已更新时拒绝，避免装入未看过的内容。
   */
  installCommunityPersona: defineContract({
    invalidatesSnapshot: true,
    timeoutMs: 60_000,
    method: 'POST',
    path: '/api/community/personas/:personaId/install',
    params: z.object({ personaId: CommunityPersonaIdSchema }).strict(),
    request: z.discriminatedUnion('target', [
      z
        .object({
          target: z.literal('new'),
          expectedRevisionId: CommunityPersonaRevisionIdSchema,
          displayName: z.string().trim().min(1).max(80),
          model: AgentModelSchema,
          useAvatar: z.boolean(),
        })
        .strict(),
      z
        .object({
          target: z.literal('replace'),
          expectedRevisionId: CommunityPersonaRevisionIdSchema,
          agentId: AgentIdSchema,
          expectedCurrentRevisionId: AgentRevisionIdSchema,
          /** 同时改名；省略时保留原名称。 */
          displayName: z.string().trim().min(1).max(80).optional(),
          useAvatar: z.boolean(),
        })
        .strict(),
    ]),
    response: z
      .object({
        agentId: AgentIdSchema,
        channelId: ChannelIdSchema.nullable(),
        currentRevisionId: AgentRevisionIdSchema,
        avatar: z.enum(['applied', 'none', 'failed']),
      })
      .strict(),
    error: HostApiErrorSchema,
  }),
  listCommunityMyPersonas: defineContract({
    timeoutMs: 30_000,
    method: 'GET',
    path: '/api/community/mine/personas',
    params: EmptyParamsSchema,
    request: NoRequestBodySchema,
    response: CommunityMyPersonasSchema,
    error: HostApiErrorSchema,
  }),
  /** 把智能体的设定分享到社区；带 `personaId` 时更新自己已发布的人设（生成新修订并重新审查）。 */
  publishCommunityPersona: defineContract({
    timeoutMs: 60_000,
    method: 'POST',
    path: '/api/community/personas/publish',
    params: EmptyParamsSchema,
    request: z
      .object({
        agentId: AgentIdSchema,
        personaId: CommunityPersonaIdSchema.optional(),
        name: z.string().trim().min(1).max(80),
        summary: z.string().trim().min(1).max(200),
        description: z.string().max(20_000),
        tags: z.array(z.string().trim().min(1).max(40)).max(16),
        persona: z.string().trim().min(1).max(COMMUNITY_PERSONA_MAX_LENGTH),
        notes: z.string().max(2000).optional(),
        /** 页面缩放后的头像（Base64）；省略时不上传头像，更新时保留社区上的原头像。 */
        avatar: z
          .object({
            mediaType: z.enum(COMMUNITY_PERSONA_AVATAR_TYPES),
            base64: z
              .string()
              .min(1)
              .max(Math.ceil((512 * 1024 * 4) / 3) + 4),
          })
          .strict()
          .optional(),
      })
      .strict(),
    response: CommunityMyPersonaSchema,
    error: HostApiErrorSchema,
  }),
  testMcpServer: defineContract({
    timeoutMs: 30_000,
    method: 'POST',
    path: '/api/mcp-servers/test',
    params: EmptyParamsSchema,
    request: z.object({ server: McpServerFormSchema }).strict(),
    response: z
      .object({
        ok: z.boolean(),
        message: z.string(),
        serverName: z.string().optional(),
        tools: z.array(z.object({ name: z.string(), description: z.string().optional() }).strict()),
      })
      .strict(),
    error: HostApiErrorSchema,
  }),
  createMcpExtension: defineContract({
    invalidatesSnapshot: true,
    timeoutMs: 120_000,
    method: 'POST',
    path: '/api/mcp-servers',
    params: EmptyParamsSchema,
    request: z
      .object({
        displayName: z.string().trim().min(1).max(80),
        description: z.string().trim().max(500).default(''),
        server: McpServerFormSchema,
      })
      .strict(),
    response: z
      .object({
        extensionId: ExtensionIdSchema,
        revisionId: ExtensionRevisionIdSchema,
        /** Credential config fields created for the form's secret rows, by row name. */
        secretFields: z.array(z.object({ key: z.string(), name: z.string() }).strict()),
      })
      .strict(),
    error: HostApiErrorSchema,
  }),
  commitExtensionImport: defineContract({
    invalidatesSnapshot: true,
    timeoutMs: 300_000,
    method: 'POST',
    path: '/api/extensions/imports/:token/commit',
    params: z.object({ token: NonEmptyStringSchema }).strict(),
    request: z.object({ localSlug: z.string().trim().min(3).max(64).optional() }).strict(),
    response: z
      .object({ extensionId: ExtensionIdSchema, revisionId: ExtensionRevisionIdSchema, idempotent: z.boolean() })
      .strict(),
    error: HostApiErrorSchema,
  }),
  dshSettings: defineContract({
    method: 'GET',
    path: '/api/dsh/settings',
    params: EmptyParamsSchema,
    request: NoRequestBodySchema,
    response: z.object({ namespaces: z.array(DshSettingsNamespaceSchema) }).strict(),
    error: HostApiErrorSchema,
  }),
  dshSettingsMutate: defineContract({
    invalidatesSnapshot: true,
    method: 'POST',
    path: '/api/dsh/settings/:namespace/mutate',
    params: dshSettingsParam,
    request: DshSettingsMutationRequestSchema,
    response: DshSettingsNamespaceSchema,
    error: HostApiErrorSchema,
  }),
  dshCredentialsDescribe: defineContract({
    method: 'POST',
    path: '/api/dsh/credentials/describe',
    params: EmptyParamsSchema,
    request: z.object({ refs: z.array(DshCredentialRefSchema).max(64) }).strict(),
    response: z.object({ credentials: z.record(z.string(), DshCredentialViewSchema) }).strict(),
    error: HostApiErrorSchema,
  }),
  dshCredentialSet: defineContract({
    invalidatesSnapshot: true,
    method: 'PUT',
    path: '/api/dsh/credentials/:ref',
    params: dshCredentialParam,
    request: z
      .object({
        value: z
          .string()
          .min(1)
          .max(64 * 1024),
      })
      .strict(),
    response: DshCredentialViewSchema,
    error: HostApiErrorSchema,
  }),
  dshCredentialUnset: defineContract({
    invalidatesSnapshot: true,
    method: 'DELETE',
    path: '/api/dsh/credentials/:ref',
    params: dshCredentialParam,
    request: NoRequestBodySchema,
    response: DshCredentialViewSchema,
    error: HostApiErrorSchema,
  }),
  llmProviders: defineContract({
    method: 'GET',
    path: '/api/llm/providers',
    params: EmptyParamsSchema,
    request: NoRequestBodySchema,
    response: LlmProviderSettingsSchema,
    error: HostApiErrorSchema,
  }),
  llmDiscoverModels: defineContract({
    method: 'POST',
    path: '/api/llm/discover-models',
    params: EmptyParamsSchema,
    request: z
      .object({
        provider: NonEmptyStringSchema.optional(),
        settingsNs: NonEmptyStringSchema.optional(),
        baseURL: z.url().optional(),
        api: NonEmptyStringSchema.optional(),
        apiKey: z
          .string()
          .min(1)
          .max(64 * 1024)
          .optional(),
      })
      .strict(),
    response: z.object({ models: z.array(LlmDiscoveredModelSchema) }).strict(),
    error: HostApiErrorSchema,
  }),
  llmTestProvider: defineContract({
    method: 'POST',
    path: '/api/llm/test-provider',
    params: EmptyParamsSchema,
    request: z
      .object({
        provider: NonEmptyStringSchema,
        model: NonEmptyStringSchema,
        settingsNs: NonEmptyStringSchema.optional(),
        apiKey: z
          .string()
          .min(1)
          .max(64 * 1024)
          .optional(),
        baseURL: z.url().optional(),
        api: NonEmptyStringSchema.optional(),
        models: z.array(LlmDiscoveredModelSchema).optional(),
      })
      .strict(),
    response: z.object({ provider: NonEmptyStringSchema, model: NonEmptyStringSchema }).strict(),
    error: HostApiErrorSchema,
  }),
  llmProviderRemovalImpact: defineContract({
    method: 'GET',
    path: '/api/llm/providers/:provider/removal-impact',
    params: llmProviderParam,
    request: NoRequestBodySchema,
    response: z
      .object({
        provider: NonEmptyStringSchema,
        displayName: NonEmptyStringSchema,
        declared: z.boolean(),
        expectedRevision: z.number().int().nonnegative(),
        models: z.array(NonEmptyStringSchema),
        blockedReason: z.string(),
        references: z.array(
          z
            .object({
              agentId: AgentIdSchema,
              displayName: NonEmptyStringSchema,
              model: NonEmptyStringSchema,
              role: z.enum(['primary', 'vision']),
              scope: z.enum(['configuration', 'context']),
              channelId: ChannelIdSchema.optional(),
              channelName: z.string().optional(),
              episodeStatus: z.enum(['opening', 'active']).optional(),
            })
            .strict(),
        ),
      })
      .strict(),
    error: HostApiErrorSchema,
  }),
  llmRemoveProvider: defineContract({
    invalidatesSnapshot: true,
    method: 'DELETE',
    path: '/api/llm/providers/:provider',
    params: llmProviderParam,
    request: z.object({ expectedRevision: z.number().int().nonnegative() }).strict(),
    response: LlmProviderSettingsSchema,
    error: HostApiErrorSchema,
  }),
  llmRestoreProviderModels: defineContract({
    invalidatesSnapshot: true,
    method: 'POST',
    path: '/api/llm/providers/:provider/restore-models',
    params: llmProviderParam,
    request: z.object({ expectedRevision: z.number().int().nonnegative() }).strict(),
    response: LlmProviderSettingsSchema,
    error: HostApiErrorSchema,
  }),
  llmSaveProvider: defineContract({
    invalidatesSnapshot: true,
    method: 'POST',
    path: '/api/llm/providers/:provider',
    params: llmProviderParam,
    request: z
      .object({
        expectedRevision: z.number().int().nonnegative(),
        apiKey: z
          .string()
          .min(1)
          .max(64 * 1024)
          .optional(),
        displayName: z.string().trim().min(1).max(120).optional(),
        baseURL: z.url().optional(),
        api: NonEmptyStringSchema.optional(),
        models: z.array(LlmDiscoveredModelSchema).optional(),
      })
      .strict(),
    response: LlmProviderSettingsSchema,
    error: HostApiErrorSchema,
  }),
  testConnection: defineContract({
    invalidatesSnapshot: true,
    method: 'POST',
    path: '/api/connections/:connectionId/test',
    params: connectionParam,
    request: z.object({ direction: z.enum(['send', 'receive']), channelId: ChannelIdSchema.optional() }).strict(),
    response: ConnectionTestResultSchema,
    error: HostApiErrorSchema,
  }),
  dynamicInventory: defineContract({
    method: 'POST',
    path: '/api/dynamic/:agentId/inventory',
    params: agentParam,
    request: z.object({ episodeId: EpisodeIdSchema }).strict(),
    response: z.object({ rows: z.array(DynamicInventoryRowSchema) }).strict(),
    error: HostApiErrorSchema,
  }),
  dynamicApprove: defineContract({
    invalidatesSnapshot: true,
    method: 'POST',
    path: '/api/dynamic/:agentId/approve',
    params: agentParam,
    request: z
      .object({ episodeId: EpisodeIdSchema, requestId: DynamicIdSchema, pluginRunId: DynamicIdSchema.optional() })
      .strict(),
    response: z.object({ accepted: z.boolean() }).strict(),
    error: HostApiErrorSchema,
  }),
  dynamicDecline: defineContract({
    invalidatesSnapshot: true,
    method: 'POST',
    path: '/api/dynamic/:agentId/decline',
    params: agentParam,
    request: z
      .object({ episodeId: EpisodeIdSchema, requestId: DynamicIdSchema, pluginRunId: DynamicIdSchema.optional() })
      .strict(),
    response: z.object({ accepted: z.boolean() }).strict(),
    error: HostApiErrorSchema,
  }),
  dynamicInvoke: defineContract({
    method: 'POST',
    path: '/api/dynamic/:agentId/invoke',
    params: agentParam,
    request: z
      .object({
        episodeId: EpisodeIdSchema,
        pluginId: DynamicIdSchema,
        pluginRunId: DynamicIdSchema,
        method: NonEmptyStringSchema,
        args: JsonValueSchema.optional(),
      })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), value: JsonValueSchema }).strict(),
      z.object({ ok: z.literal(false), message: z.string() }).strict(),
    ]),
    error: HostApiErrorSchema,
  }),
  dynamicRunHostHalf: defineContract({
    method: 'POST',
    path: '/api/dynamic/:agentId/run-host-half',
    params: agentParam,
    request: z
      .object({
        episodeId: EpisodeIdSchema,
        pluginId: DynamicIdSchema,
        packageId: DynamicIdSchema,
        mode: z.enum(['run', 'update']),
        requestId: DynamicIdSchema.nullable().optional(),
        approveFutureVersions: z.boolean().default(false),
      })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z
        .object({
          ok: z.literal(true),
          pluginId: DynamicIdSchema,
          packageId: DynamicIdSchema,
          pluginRunId: DynamicIdSchema,
          waitingFor: z.array(z.string()),
          startedHere: z.boolean(),
        })
        .strict(),
      DynamicErrorDetailsSchema.extend({ ok: z.literal(false) }),
    ]),
    error: HostApiErrorSchema,
  }),
  dynamicSettleUserRun: defineContract({
    method: 'POST',
    path: '/api/dynamic/:agentId/settle-user-run',
    params: agentParam,
    request: z
      .object({ episodeId: EpisodeIdSchema, pluginId: DynamicIdSchema, resolution: DynamicRunResolutionSchema })
      .strict(),
    response: DynamicRunResponseSchema,
    error: HostApiErrorSchema,
  }),
  dynamicGetClientCode: defineContract({
    method: 'POST',
    path: '/api/dynamic/:agentId/get-client-code',
    params: agentParam,
    request: z.object({ episodeId: EpisodeIdSchema, pluginId: DynamicIdSchema, pluginRunId: DynamicIdSchema }).strict(),
    response: z
      .object({
        code: z.string(),
        name: z.string(),
        pluginId: DynamicIdSchema,
        packageId: DynamicIdSchema,
        pluginRunId: DynamicIdSchema,
        /** What the candidate declared; preview data hooks enforce exactly what the saved Revision will. */
        permissions: HostUiPermissionDeclarationSchema.default({ permissions: [], networkOrigins: [] }),
      })
      .strict(),
    error: HostApiErrorSchema,
  }),
  dynamicReportRenderFailure: defineContract({
    method: 'POST',
    path: '/api/dynamic/:agentId/report-render-failure',
    params: agentParam,
    request: z
      .object({
        episodeId: EpisodeIdSchema,
        pluginId: DynamicIdSchema,
        pluginRunId: DynamicIdSchema,
        failure: DynamicRenderFailureSchema,
      })
      .strict(),
    response: z.object({ ok: z.literal(true) }).strict(),
    error: HostApiErrorSchema,
  }),
  dynamicReportGuardFailure: defineContract({
    method: 'POST',
    path: '/api/dynamic/:agentId/report-guard-failure',
    params: agentParam,
    request: z
      .object({
        episodeId: EpisodeIdSchema,
        pluginId: DynamicIdSchema,
        pluginRunId: DynamicIdSchema,
        message: z.string().min(1).max(4096),
        stack: z
          .string()
          .max(16 * 1024)
          .optional(),
      })
      .strict(),
    response: z.object({ ok: z.literal(true) }).strict(),
    error: HostApiErrorSchema,
  }),
  dynamicReportClientVerification: defineContract({
    method: 'POST',
    path: '/api/dynamic/:agentId/report-client-verification',
    params: agentParam,
    request: z
      .object({
        episodeId: EpisodeIdSchema,
        pluginId: DynamicIdSchema,
        packageId: DynamicIdSchema,
        pluginRunId: DynamicIdSchema,
        renderedPanels: z.array(PanelContributionSchema).max(16).default([]),
        renderedToolViews: z.array(z.string().trim().min(1).max(64)).max(32).default([]),
        renderedMessageRenderers: z.array(RichKindSchema).max(32).default([]),
        renderedPages: z.array(HostPageContributionSchema).max(8).default([]),
        usedUiComponents: z
          .array(HostUiKitComponentNameSchema)
          .max(HostUiKitComponentNameSchema.options.length)
          .default([]),
        pageGeometry: z.array(HostUiPageGeometryEvidenceSchema).max(8).default([]),
        navigationEntries: z.array(z.string().trim().min(1).max(64)).max(8).default([]),
      })
      .strict()
      .refine(
        (value) =>
          value.renderedPanels.length > 0 ||
          value.renderedToolViews.length > 0 ||
          value.renderedMessageRenderers.length > 0 ||
          value.renderedPages.length > 0,
        {
          message: '动态 Client 必须真实渲染至少一个面板、工具视图、富消息渲染器或页面。',
        },
      ),
    response: z.object({ ok: z.literal(true) }).strict(),
    error: HostApiErrorSchema,
  }),
  saveExtensionFromDynamic: defineContract({
    invalidatesSnapshot: true,
    timeoutMs: 300_000,
    method: 'POST',
    path: '/api/extensions/save-from-dynamic',
    params: EmptyParamsSchema,
    request: z.union([
      z
        .object({
          taskId: AuthoringTaskIdSchema,
          attemptId: AuthoringAttemptIdSchema,
          displayName: z.string().trim().min(1).max(80),
          slug: z
            .string()
            .trim()
            .regex(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/u),
          description: z.string().max(500).default(''),
          targetExtensionId: ExtensionIdSchema.optional(),
        })
        .strict(),
      z
        .object({
          agentId: AgentIdSchema,
          episodeId: EpisodeIdSchema,
          pluginId: DynamicIdSchema,
          packageId: DynamicIdSchema,
          displayName: z.string().trim().min(1).max(80),
          slug: z
            .string()
            .trim()
            .regex(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/u),
          description: z.string().max(500).default(''),
          targetExtensionId: ExtensionIdSchema.optional(),
        })
        .strict(),
    ]),
    response: z
      .object({
        extensionId: ExtensionIdSchema,
        revisionId: ExtensionRevisionIdSchema,
        activation: z.literal('inactive'),
        installation: z.literal('uninstalled').optional(),
      })
      .strict(),
    error: HostApiErrorSchema,
  }),
  extensionClientCall: defineContract({
    method: 'POST',
    path: '/api/extensions/:extensionId/revisions/:revisionId/call',
    params: extensionRevisionParam,
    request: z
      .object({ agentId: AgentIdSchema, method: NonEmptyStringSchema, input: JsonValueSchema.optional() })
      .strict(),
    response: z.object({ value: JsonValueSchema }).strict(),
    error: HostApiErrorSchema,
  }),
  extensionClientDiagnostic: defineContract({
    method: 'POST',
    path: '/api/extensions/:extensionId/revisions/:revisionId/client-diagnostic',
    params: extensionRevisionParam,
    request: z
      .object({
        agentId: AgentIdSchema,
        status: z.enum(['loaded', 'failed']),
        message: z.string().max(4096).optional(),
      })
      .strict(),
    response: z.object({ accepted: z.literal(true) }).strict(),
    error: HostApiErrorSchema,
  }),
  hostExtensionClientDiagnostic: defineContract({
    method: 'POST',
    path: '/api/extensions/:extensionId/revisions/:revisionId/host-client-diagnostic',
    params: extensionRevisionParam,
    request: z.object({ status: z.enum(['loaded', 'failed']), message: z.string().max(4096).optional() }).strict(),
    response: z.object({ accepted: z.literal(true) }).strict(),
    error: HostApiErrorSchema,
  }),
  activateExtension: defineContract({
    invalidatesSnapshot: true,
    method: 'POST',
    path: '/api/agents/:agentId/extensions/:extensionId/activation',
    params: agentExtensionParam,
    request: z
      .object({
        revisionId: ExtensionRevisionIdSchema,
        permissionApproval: z
          .object({ permissionDigest: z.string().regex(/^[a-f0-9]{64}$/u) })
          .strict()
          .optional(),
      })
      .strict(),
    response: z
      .object({
        activation: z
          .object({
            agentId: AgentIdSchema,
            extensionId: ExtensionIdSchema,
            extensionRevisionId: ExtensionRevisionIdSchema,
            config: JsonValueSchema,
            configuredSecrets: z.array(z.string()).optional(),
            activatedAt: z.number().int().safe().nonnegative(),
          })
          .strict(),
      })
      .strict(),
    error: HostApiErrorSchema,
  }),
  deactivateExtension: defineContract({
    invalidatesSnapshot: true,
    method: 'DELETE',
    path: '/api/agents/:agentId/extensions/:extensionId/activation',
    params: agentExtensionParam,
    request: NoRequestBodySchema,
    response: z.object({ disabled: z.literal(true) }).strict(),
    error: HostApiErrorSchema,
  }),
  updateExtensionActivationConfig: defineContract({
    invalidatesSnapshot: true,
    method: 'PUT',
    path: '/api/agents/:agentId/extensions/:extensionId/activation/config',
    params: agentExtensionParam,
    request: z
      .object({
        config: JsonValueSchema,
        /** Write-only credential drafts keyed by secret field; an absent or empty draft keeps the stored one. */
        secrets: z.record(z.string(), z.string().max(8192)).optional(),
      })
      .strict(),
    response: z.object({ config: JsonValueSchema, configuredSecrets: z.array(z.string()).optional() }).strict(),
    error: HostApiErrorSchema,
  }),
  updateHostExtensionConfig: defineContract({
    invalidatesSnapshot: true,
    timeoutMs: 300_000,
    method: 'PUT',
    path: '/api/extensions/:extensionId/installation/config',
    params: extensionParam,
    request: z.object({ config: JsonValueSchema }).strict(),
    response: z.object({ config: JsonValueSchema }).strict(),
    error: HostApiErrorSchema,
  }),
  installHostExtension: defineContract({
    invalidatesSnapshot: true,
    timeoutMs: 300_000,
    method: 'PUT',
    path: '/api/extensions/:extensionId/installation',
    params: extensionParam,
    request: z
      .object({
        revisionId: ExtensionRevisionIdSchema,
        permissionApproval: z
          .object({ permissionDigest: z.string().regex(/^[a-f0-9]{64}$/u) })
          .strict()
          .optional(),
      })
      .strict(),
    response: z
      .object({
        installation: z
          .object({
            extensionId: ExtensionIdSchema,
            extensionRevisionId: ExtensionRevisionIdSchema,
            installedAt: z.number().int().safe().nonnegative(),
            config: JsonValueSchema,
          })
          .strict(),
      })
      .strict(),
    error: HostApiErrorSchema,
  }),
  uninstallHostExtension: defineContract({
    invalidatesSnapshot: true,
    timeoutMs: 300_000,
    method: 'DELETE',
    path: '/api/extensions/:extensionId/installation',
    params: extensionParam,
    request: NoRequestBodySchema,
    response: z.object({ uninstalled: z.literal(true) }).strict(),
    error: HostApiErrorSchema,
  }),
  updateHostUiPagePreferences: defineContract({
    invalidatesSnapshot: true,
    method: 'PUT',
    path: '/api/host-ui/page-preferences',
    params: EmptyParamsSchema,
    request: z
      .object({
        expectedRevision: z.number().int().nonnegative(),
        entries: z.array(z.object({ pageInstanceId: HostUiPageInstanceIdSchema, visible: z.boolean() }).strict()),
      })
      .strict(),
    response: z.object({ revision: z.number().int().positive() }).strict(),
    error: HostApiErrorSchema,
  }),
  callHostUiPage: defineContract({
    method: 'POST',
    path: '/api/host-ui/pages/:pageInstanceId/call',
    params: z.object({ pageInstanceId: HostUiPageInstanceIdSchema }).strict(),
    request: z.object({ method: NonEmptyStringSchema, input: JsonValueSchema.default({}) }).strict(),
    response: z.object({ value: JsonValueSchema }).strict(),
    error: HostApiErrorSchema,
  }),
  reportHostUiPageDiagnostic: defineContract({
    method: 'POST',
    path: '/api/host-ui/pages/:pageInstanceId/diagnostic',
    params: z.object({ pageInstanceId: HostUiPageInstanceIdSchema }).strict(),
    request: z
      .object({
        status: z.enum(['ready', 'load-failed', 'navigation-failed', 'rpc-failed']),
        message: z.string().max(2000).optional(),
      })
      .strict(),
    response: z.object({ recorded: z.literal(true) }).strict(),
    error: HostApiErrorSchema,
  }),
  markChannelRead: defineContract({
    method: 'POST',
    path: '/api/channels/:channelId/read',
    params: channelParam,
    request: z
      .object({
        /** Defaults to the newest inbound fact visible now. */
        upTo: z
          .object({ occurredAt: z.number().int().safe().nonnegative(), sourceId: ChannelEventIdSchema })
          .strict()
          .optional(),
      })
      .strict(),
    response: z.object({ channelId: ChannelIdSchema, activity: ChannelActivitySummarySchema }).strict(),
    error: HostApiErrorSchema,
  }),
  listAttention: defineContract({
    method: 'GET',
    path: '/api/attention',
    params: EmptyParamsSchema,
    request: NoRequestBodySchema,
    response: AttentionListSchema,
    error: HostApiErrorSchema,
  }),
  dismissAttention: defineContract({
    method: 'POST',
    path: '/api/attention/:attentionId/dismiss',
    params: z.object({ attentionId: z.string().min(1).max(200) }).strict(),
    request: NoRequestBodySchema,
    response: z.object({ dismissed: z.literal(true), revision: z.string().min(1) }).strict(),
    error: HostApiErrorSchema,
  }),
  getChannelPending: defineContract({
    method: 'GET',
    path: '/api/channels/:channelId/pending',
    params: channelParam,
    request: NoRequestBodySchema,
    response: ChannelPendingContextSchema,
    error: HostApiErrorSchema,
  }),
  stopChannelTask: defineContract({
    method: 'POST',
    path: '/api/channels/:channelId/stop',
    params: channelParam,
    request: z.object({ expectedEpisodeId: EpisodeIdSchema.optional() }).strict(),
    response: z
      .object({
        result: z.enum(['stopped', 'idle']),
        episodeId: EpisodeIdSchema.optional(),
        /** Admitted messages that were not yet consumed and remain queued for the next turn. */
        retainedPending: z.number().int().nonnegative(),
      })
      .strict(),
    error: HostApiErrorSchema,
  }),
  resolveOutbound: defineContract({
    method: 'POST',
    path: '/api/outbound/:outboundId/resolve',
    params: z.object({ outboundId: OutboundIntentIdSchema }).strict(),
    request: z.object({ action: z.enum(['retry', 'confirm-delivered']) }).strict(),
    response: z
      .object({
        outboundId: OutboundIntentIdSchema,
        action: z.enum(['retry', 'confirm-delivered']),
        deliveryState: z.enum(['planned', 'sending', 'sent', 'partially-sent', 'failed', 'unknown']),
        resolvedAt: z.number().int().safe().nonnegative(),
      })
      .strict(),
    error: HostApiErrorSchema,
  }),
  getChannelActivity: defineContract({
    method: 'GET',
    path: '/api/activity',
    params: ActivityQuerySchema,
    request: NoRequestBodySchema,
    response: ChannelActivitySeriesSchema,
    error: HostApiErrorSchema,
  }),
  listAgentRevisions: defineContract({
    method: 'GET',
    path: '/api/agents/:agentId/revisions',
    params: agentParam,
    request: NoRequestBodySchema,
    response: AgentRevisionHistorySchema,
    error: HostApiErrorSchema,
  }),
  restoreAgentRevision: defineContract({
    invalidatesSnapshot: true,
    method: 'POST',
    path: '/api/agents/:agentId/revisions/:revisionId/restore',
    params: agentRevisionParam,
    request: z.object({ expectedCurrentRevisionId: AgentRevisionIdSchema }).strict(),
    response: z.object({ currentRevisionId: AgentRevisionIdSchema }).strict(),
    error: HostApiErrorSchema,
  }),
  updateAgentAppearance: defineContract({
    invalidatesSnapshot: true,
    method: 'PATCH',
    path: '/api/agents/:agentId/appearance',
    params: agentParam,
    request: z
      .object({
        hue: z.number().int().min(0).max(359).nullable().optional(),
        /** `null` removes the avatar; uploading uses `uploadAgentAvatar`. */
        avatarAssetId: z.null().optional(),
      })
      .strict(),
    response: z.object({ agentId: AgentIdSchema, appearance: AgentAppearanceSchema }).strict(),
    error: HostApiErrorSchema,
  }),
  uploadAgentAvatar: defineContract({
    invalidatesSnapshot: true,
    method: 'POST',
    path: '/api/agents/:agentId/avatar',
    params: agentParam,
    request: BinaryUploadRequestSchema,
    encodeRequest: encodeBinaryUpload,
    response: z.object({ agentId: AgentIdSchema, appearance: AgentAppearanceSchema }).strict(),
    error: HostApiErrorSchema,
  }),
  deleteLocalExtension: defineContract({
    invalidatesSnapshot: true,
    method: 'DELETE',
    path: '/api/extensions/:extensionId',
    params: extensionParam,
    request: NoRequestBodySchema,
    response: z.object({ deleted: z.literal(true) }).strict(),
    error: HostApiErrorSchema,
  }),
} as const

export type HostApiContractName = keyof typeof HostApiContracts
export type HostApiParams<Name extends HostApiContractName> = z.input<(typeof HostApiContracts)[Name]['params']>
export type HostApiRequest<Name extends HostApiContractName> = z.input<(typeof HostApiContracts)[Name]['request']>
export type HostApiResponse<Name extends HostApiContractName> = z.output<(typeof HostApiContracts)[Name]['response']>
export type HostApiContractParams<Contract> = Contract extends {
  readonly params: z.ZodType<unknown, infer Input>
}
  ? Input
  : never
export type HostApiContractRequest<Contract> = Contract extends {
  readonly request: z.ZodType<unknown, infer Input>
}
  ? Input
  : never
export type HostApiContractResponse<Contract> = Contract extends {
  readonly response: z.ZodType<infer Output, unknown>
}
  ? Output
  : never

const pathParameterPattern = /:([A-Za-z][A-Za-z0-9]*)/gu

/** Build the transport URL only after all path/query parameters pass the shared schema. */
const buildValidatedHostApiPath = (
  contract: { readonly path: string; readonly params: AnySchema },
  input: unknown,
): string => {
  const params = z.record(z.string(), z.unknown()).parse(contract.params.parse(input))
  const consumed = new Set<string>()
  const pathname = contract.path.replace(pathParameterPattern, (_placeholder, key: string) => {
    const value = params[key]
    if (typeof value !== 'string') throw new TypeError(`Host API path parameter ${key} must be a string.`)
    consumed.add(key)
    return encodeURIComponent(value)
  })
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (consumed.has(key) || value === undefined) continue
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new TypeError(`Host API query parameter ${key} must be a string, number, or boolean.`)
    }
    query.set(key, String(value))
  }
  const suffix = query.toString()
  return suffix ? `${pathname}?${suffix}` : pathname
}

export function buildHostApiContractPath<Params extends AnySchema>(
  contract: { readonly path: string; readonly params: Params },
  input: unknown,
): string {
  return buildValidatedHostApiPath(contract, input)
}

export function buildHostApiPath<Name extends HostApiContractName>(name: Name, input: HostApiParams<Name>): string {
  return buildValidatedHostApiPath(HostApiContracts[name], input)
}
