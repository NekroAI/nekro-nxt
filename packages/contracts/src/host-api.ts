import { z } from 'zod'
import {
  AgentIdSchema,
  AgentRevisionIdSchema,
  AssetIdSchema,
  ChannelEventIdSchema,
  ChannelActivityTypeSchema,
  ChannelIdSchema,
  ChannelMemberIdSchema,
  ConnectionIdSchema,
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
import { ClientNotificationSchema } from './management-api.js'
import {
  AdapterClientSlotNameSchema,
  AgentClientSlotNameSchema,
  DshNxtHostUiSchema,
  HostPageContributionSchema,
  HostUiPageEntrySchema,
  HostUiPermissionDeclarationSchema,
} from './extension-ui.js'

const EmptyParamsSchema = z.object({}).strict()
const NoRequestBodySchema = z.undefined()
const NonEmptyStringSchema = z.string().trim().min(1)
const DynamicIdSchema = NonEmptyStringSchema
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

const UpdateAgentCapabilitiesRequestSchema = AgentCapabilitiesSchema.partial()
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
    role: z.enum(['member', 'agent']),
    parts: z.array(SnapshotMessagePartSchema),
    sender: z.object({ memberId: ChannelMemberIdSchema, displayName: z.string().optional() }).strict().optional(),
    mentionedConnectionAccount: z.boolean().optional(),
    activityType: ChannelActivityTypeSchema.optional(),
    targetLogicalMessageId: LogicalMessageIdSchema.optional(),
    occurredAt: z.number().finite(),
    deliveryState: z.enum(['planned', 'sending', 'sent', 'partially-sent', 'failed', 'unknown']).optional(),
    origin: z.enum(['admin-console']).optional(),
  })
  .strict()

export type HostSnapshotMessage = z.output<typeof HostSnapshotMessageSchema>

const PlatformUserChannelPreviewSchema = z
  .object({
    id: ChannelIdSchema,
    displayName: z.string().trim().min(1).max(120).optional(),
    kind: z.enum(['web', 'direct', 'group']),
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
    error: z.object({ code: NonEmptyStringSchema, message: z.string() }).strict().optional(),
    steps: z.array(ChannelRuntimeStepSchema),
    durationMs: z.number().int().nonnegative().optional(),
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

const AdapterConfigurationPropertySchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.enum(['string', 'credential-reference']),
      title: z.string(),
      description: z.string().optional(),
      default: z.string().optional(),
      credentialKey: z.string().trim().min(1).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('boolean'),
      title: z.string(),
      description: z.string().optional(),
      default: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('number'),
      title: z.string(),
      description: z.string().optional(),
      default: z.number().finite().optional(),
    })
    .strict(),
])

const AdapterConnectionDescriptorSchema = z
  .object({
    key: NonEmptyStringSchema,
    displayName: z.string(),
    description: z.string(),
    userCreatable: z.boolean(),
    aliasEditable: z.boolean(),
    channelDiscovery: z.enum(['host-created', 'adapter-observed']),
    diagnostics: z.object({ receive: z.boolean(), send: z.boolean() }).strict(),
    configSchema: z
      .object({
        schemaVersion: z.number().int().nonnegative(),
        type: z.literal('object'),
        required: z.array(z.string()),
        properties: z.record(z.string(), AdapterConfigurationPropertySchema),
      })
      .strict(),
  })
  .strict()

export const HostSnapshotSchema = z
  .object({
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
                  usage: z
                    .object({
                      inputTokens: z.number().int().nonnegative(),
                      outputTokens: z.number().int().nonnegative(),
                      cacheReadTokens: z.number().int().nonnegative().optional(),
                      cacheWriteTokens: z.number().int().nonnegative().optional(),
                      reasoningTokens: z.number().int().nonnegative().optional(),
                    })
                    .strict()
                    .optional(),
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
        })
        .strict(),
    ),
    channels: z.array(
      z
        .object({
          id: ChannelIdSchema,
          connectionId: ConnectionIdSchema,
          platformChannelId: NonEmptyStringSchema,
          kind: z.enum(['web', 'group', 'direct']),
          displayName: z.string().optional(),
          boundAgentId: AgentIdSchema.optional(),
          runtimePhase: ChannelRuntimePhaseSchema.default('idle'),
          bindings: z.array(
            z
              .object({
                channelId: ChannelIdSchema,
                agentId: AgentIdSchema,
                triggerPolicy: TriggerPolicySchema,
                processingFeedback: z.enum(['auto', 'off']).default('auto'),
                eventTriggers: z.array(ChannelActivityTypeSchema).default([]),
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
          status: z
            .object({
              state: z.enum(['stopped', 'connecting', 'connected', 'reconnecting', 'failed']),
              message: z.string().optional(),
              credentialConfigured: z.boolean(),
              proactiveSend: z.boolean(),
              accountId: z.string().optional(),
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
            })
            .strict()
            .default({ state: 'stopped', credentialConfigured: false, proactiveSend: false }),
          /** Legacy response fields remain parseable during the client transition; Server no longer emits them. */
          appId: z.string().optional(),
          proactiveSend: z.boolean().optional(),
          credentialConfigured: z.boolean().optional(),
          channelCount: z.number().int().nonnegative(),
          knownChannels: z.array(
            z.object({ id: ChannelIdSchema, name: z.string(), kind: z.enum(['web', 'group', 'direct']) }).strict(),
          ),
          gateway: z
            .object({
              state: z.enum(['stopped', 'connecting', 'connected', 'reconnecting', 'failed']),
              sessionId: z.string().optional(),
              sequence: z.number().int().nonnegative().optional(),
              resumed: z.boolean().optional(),
              lastError: z.string().optional(),
            })
            .strict()
            .optional(),
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
        })
        .strict(),
    ),
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
                createdAt: z.number().int().safe().nonnegative(),
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
                    renderedSlots: z.array(z.string()),
                    renderedHostSlots: z
                      .array(z.object({ name: AdapterClientSlotNameSchema, key: NonEmptyStringSchema }).strict())
                      .optional(),
                    renderedPages: z.array(HostPageContributionSchema).max(8).optional(),
                    permissions: HostUiPermissionDeclarationSchema.optional(),
                    permissionDigest: z
                      .string()
                      .regex(/^[a-f0-9]{64}$/u)
                      .optional(),
                    permissionApprovalRequired: z.boolean().optional(),
                    adapter: z
                      .object({
                        apiVersion: z.literal(1),
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
                config: JsonValueSchema,
                activatedAt: z.number().int().safe().nonnegative(),
                runtime: z
                  .object({
                    status: z.enum(['active', 'restore-failed', 'dispose-failed']),
                    message: z.string().optional(),
                    observedAt: z.number().int().safe().nonnegative(),
                  })
                  .optional(),
              })
              .strict(),
          ),
          installation: z
            .object({
              extensionRevisionId: ExtensionRevisionIdSchema,
              installedAt: z.number().int().safe().nonnegative(),
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
          status: NonEmptyStringSchema,
          activeRun: z.object({ pluginRunId: DynamicIdSchema, packageId: DynamicIdSchema }).strict().optional(),
          latestRun: z
            .object({ pluginRunId: DynamicIdSchema, packageId: DynamicIdSchema, status: NonEmptyStringSchema })
            .strict()
            .optional(),
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

const DynamicHalfStateSchema = z
  .object({
    status: z.enum(['absent', 'pending', 'stopped', 'running', 'waiting', 'failed']),
    waitingFor: z.array(z.string()),
    error: z.string().optional(),
  })
  .strict()

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
    latestRun: z
      .object({
        pluginRunId: DynamicIdSchema,
        packageId: DynamicIdSchema,
        mode: z.enum(['run', 'update']),
        status: z.enum([
          'awaiting-approval',
          'starting-host',
          'client-pending',
          'running',
          'waiting',
          'rejected',
          'failed',
          'cancelled',
          'stopped',
        ]),
        approvalRequestId: DynamicIdSchema.optional(),
        requiresApproval: z.boolean().optional(),
        host: DynamicHalfStateSchema,
        client: DynamicHalfStateSchema,
        error: z
          .object({
            phase: z.enum(['approval', 'host-load', 'host-apply', 'client-load', 'client-apply', 'client-render']),
            message: z.string(),
            stack: z.string().optional(),
            pluginId: DynamicIdSchema,
            packageId: DynamicIdSchema,
            pluginRunId: DynamicIdSchema,
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
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
  z.object({ event: z.literal('channel-fact'), data: ChannelFactSseDataSchema }).strict(),
  z.object({ event: z.literal('runtime'), data: ChannelRuntimeSseDataSchema }).strict(),
  z.object({ event: z.literal('extensions-changed'), data: z.object({ changed: z.literal(true) }).strict() }).strict(),
  z.object({ event: z.literal('dsh-plugins-changed'), data: z.object({ changed: z.literal(true) }).strict() }).strict(),
  z.object({ event: z.literal('dsh-plugin-operation'), data: DshPluginOperationSseDataSchema }).strict(),
  z.object({ event: z.literal('dynamic-changed'), data: DynamicChangedSseDataSchema }).strict(),
  z.object({ event: z.literal('dsh-settings-changed'), data: DshSettingsChangedSseDataSchema }).strict(),
  z.object({ event: z.literal('dsh-credentials-changed'), data: DshCredentialsChangedSseDataSchema }).strict(),
  z.object({ event: z.literal('status'), data: HostSseStatusDataSchema }).strict(),
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

export const LlmProviderModelSchema = z
  .object({
    id: NonEmptyStringSchema,
    name: NonEmptyStringSchema,
    contextWindow: z.number().int().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
  })
  .strict()

export const LlmDiscoveredModelSchema = z
  .object({
    id: NonEmptyStringSchema,
    name: NonEmptyStringSchema.optional(),
    contextWindow: z.number().int().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
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

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'
type AnySchema = z.ZodType

export interface HostApiContract<
  Method extends HttpMethod = HttpMethod,
  Params extends AnySchema = AnySchema,
  Request extends AnySchema = AnySchema,
  Response extends AnySchema = AnySchema,
  ErrorSchema extends AnySchema = AnySchema,
> {
  readonly method: Method
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

export const HostApiContracts = {
  snapshot: defineContract({
    method: 'GET',
    path: '/api/snapshot',
    params: EmptyParamsSchema,
    request: NoRequestBodySchema,
    response: HostSnapshotSchema,
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
  createAgent: defineContract({
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
    method: 'POST',
    path: '/api/agents/:agentId/revision',
    params: agentParam,
    request: ReviseAgentRequestSchema,
    response: z.object({ currentRevisionId: AgentRevisionIdSchema }).strict(),
    error: HostApiErrorSchema,
  }),
  updateAgentCapabilities: defineContract({
    method: 'POST',
    path: '/api/agents/:agentId/capabilities',
    params: agentParam,
    request: UpdateAgentCapabilitiesRequestSchema,
    response: z.object({ currentRevisionId: AgentRevisionIdSchema, capabilities: AgentCapabilitiesSchema }).strict(),
    error: HostApiErrorSchema,
  }),
  deleteAgent: defineContract({
    method: 'DELETE',
    path: '/api/agents/:agentId',
    params: agentParam,
    request: z
      .object({
        expectedCurrentRevisionId: AgentRevisionIdSchema,
        confirmationName: z.string().min(1).max(80),
        deleteAutoCreatedBuiltInChannels: z.boolean().default(true),
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
  createWebChannel: defineContract({
    method: 'POST',
    path: '/api/channels',
    params: EmptyParamsSchema,
    request: z.object({ displayName: z.string().trim().min(1).max(120) }).strict(),
    response: z.object({ channelId: ChannelIdSchema, connectionId: ConnectionIdSchema }).strict(),
    error: HostApiErrorSchema,
  }),
  deleteChannel: defineContract({
    method: 'DELETE',
    path: '/api/channels/:channelId',
    params: channelParam,
    request: z.object({ expectedBoundAgentId: AgentIdSchema.nullable() }).strict(),
    response: z.object({ channelId: ChannelIdSchema, deleted: z.literal(true) }).strict(),
    error: HostApiErrorSchema,
  }),
  createBinding: defineContract({
    method: 'POST',
    path: '/api/bindings',
    params: EmptyParamsSchema,
    request: z
      .object({
        agentId: AgentIdSchema,
        channelId: ChannelIdSchema,
        triggerPolicy: TriggerPolicySchema,
        processingFeedback: z.enum(['auto', 'off']).optional(),
        eventTriggers: z.array(ChannelActivityTypeSchema).optional(),
      })
      .strict(),
    response: z
      .object({
        channelId: ChannelIdSchema,
        agentId: AgentIdSchema,
        triggerPolicy: TriggerPolicySchema,
        processingFeedback: z.enum(['auto', 'off']).default('auto'),
        eventTriggers: z.array(ChannelActivityTypeSchema).default([]),
        boundAt: z.number().int().safe().nonnegative(),
      })
      .strict(),
    error: HostApiErrorSchema,
  }),
  clearBinding: defineContract({
    method: 'DELETE',
    path: '/api/bindings/:channelId',
    params: channelParam,
    request: NoRequestBodySchema,
    response: z.object({ channelId: ChannelIdSchema, cleared: z.literal(true) }).strict(),
    error: HostApiErrorSchema,
  }),
  putWorkTreeOrder: defineContract({
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
    response: z.object({ messages: z.array(HostSnapshotMessageSchema), hasMore: z.boolean() }).strict(),
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
    response: ChannelRuntimeProjectionSchema,
    error: HostApiErrorSchema,
  }),
  resetChannelContext: defineContract({
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
  updateConnectionAlias: defineContract({
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
  dshPlugins: defineContract({
    method: 'GET',
    path: '/api/dsh/plugins',
    params: EmptyParamsSchema,
    request: NoRequestBodySchema,
    response: z.object({ plugins: z.array(DshPluginCatalogEntrySchema) }).strict(),
    error: HostApiErrorSchema,
  }),
  inspectDshPluginInstall: defineContract({
    method: 'POST',
    path: '/api/dsh/plugin-installs/inspect',
    params: EmptyParamsSchema,
    request: z.object({ spec: NonEmptyStringSchema.max(500), operationId: z.string().uuid().optional() }).strict(),
    response: z
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
      .strict(),
    error: HostApiErrorSchema,
  }),
  commitDshPluginInstall: defineContract({
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
    method: 'DELETE',
    path: '/api/dsh/plugin-installs/:packageId',
    params: dshPluginPackageParam,
    request: NoRequestBodySchema,
    response: z.object({ removed: z.literal(true) }).strict(),
    error: HostApiErrorSchema,
  }),
  inspectExtensionImport: defineContract({
    method: 'POST',
    path: '/api/extensions/imports/inspect',
    params: EmptyParamsSchema,
    request: NoRequestBodySchema,
    response: z
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
      .strict(),
    error: HostApiErrorSchema,
  }),
  commitExtensionImport: defineContract({
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
  llmSaveProvider: defineContract({
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
        renderedSlots: z.array(AgentClientSlotNameSchema).max(5),
        renderedHostSlots: z
          .array(z.object({ name: AdapterClientSlotNameSchema, key: NonEmptyStringSchema }).strict())
          .max(16)
          .default([]),
        renderedPages: z.array(HostPageContributionSchema).max(8).default([]),
        permissions: HostUiPermissionDeclarationSchema.default({ permissions: [], networkOrigins: [] }),
      })
      .strict()
      .refine(
        (value) =>
          value.renderedSlots.length > 0 || value.renderedHostSlots.length > 0 || value.renderedPages.length > 0,
        {
          message: '动态 Client 必须提供至少一个真实渲染的产品 Slot 或页面。',
        },
      )
      .superRefine((value, context) => {
        if (value.renderedPages.length === 0 && value.permissions.permissions.length === 0) return
        if (value.renderedPages.length > 0) return
        context.addIssue({
          code: 'custom',
          path: ['permissions'],
          message: '没有页面贡献时不能声明 Host UI 权限。',
        })
      }),
    response: z.object({ ok: z.literal(true) }).strict(),
    error: HostApiErrorSchema,
  }),
  saveExtensionFromDynamic: defineContract({
    method: 'POST',
    path: '/api/extensions/save-from-dynamic',
    params: EmptyParamsSchema,
    request: z
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
    method: 'POST',
    path: '/api/agents/:agentId/extensions/:extensionId/activation',
    params: agentExtensionParam,
    request: z.object({ revisionId: ExtensionRevisionIdSchema }).strict(),
    response: z
      .object({
        activation: z
          .object({
            agentId: AgentIdSchema,
            extensionId: ExtensionIdSchema,
            extensionRevisionId: ExtensionRevisionIdSchema,
            config: JsonValueSchema,
            activatedAt: z.number().int().safe().nonnegative(),
          })
          .strict(),
      })
      .strict(),
    error: HostApiErrorSchema,
  }),
  deactivateExtension: defineContract({
    method: 'DELETE',
    path: '/api/agents/:agentId/extensions/:extensionId/activation',
    params: agentExtensionParam,
    request: NoRequestBodySchema,
    response: z.object({ disabled: z.literal(true) }).strict(),
    error: HostApiErrorSchema,
  }),
  installHostExtension: defineContract({
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
          })
          .strict(),
      })
      .strict(),
    error: HostApiErrorSchema,
  }),
  uninstallHostExtension: defineContract({
    method: 'DELETE',
    path: '/api/extensions/:extensionId/installation',
    params: extensionParam,
    request: NoRequestBodySchema,
    response: z.object({ uninstalled: z.literal(true) }).strict(),
    error: HostApiErrorSchema,
  }),
  updateHostUiPagePreferences: defineContract({
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
  deleteLocalExtension: defineContract({
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
