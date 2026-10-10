import type {
  AssetId,
  AdapterActivityKey,
  ChannelEventId,
  ChannelId,
  ChannelMemberId,
  ConnectionId,
  ConfigSchemaDocument,
  ConnectionEventId,
  HostIconName,
  JsonValue,
  LogicalMessageId,
  MessagePart,
  PhysicalDeliveryId,
  PlatformIdentityId,
} from '@nekro-nxt/contracts'
import {
  AssetIdSchema,
  AdapterActivityKeySchema,
  ConfigSchemaDocumentSchema,
  configFields,
  ChannelIdSchema,
  ChannelMemberIdSchema,
  ConnectionIdSchema,
  LogicalMessageIdSchema,
  MessagePartSchema,
  PlatformIdentityIdSchema,
} from '@nekro-nxt/contracts'
import { z } from 'zod'

export const AdapterOutboundCapabilitiesSchema = z
  .object({
    text: z.boolean(),
    mentions: z.boolean(),
    images: z.boolean(),
    files: z.boolean(),
    audio: z.boolean(),
    replies: z.boolean(),
    mixedContent: z.boolean(),
    proactiveSend: z.boolean(),
    maxTextLength: z.number().int().positive().optional(),
    maxAssetBytes: z.number().int().positive().optional(),
    acceptedMimeTypes: z.array(z.string().min(1)).optional(),
  })
  .strict()

export type AdapterOutboundCapabilities = z.infer<typeof AdapterOutboundCapabilitiesSchema>

export type AdapterChannelInboundEventKind =
  'message-created' | 'message-edited' | 'message-deleted' | 'member-updated' | 'reaction' | 'control'

export { AdapterActivityKeySchema }
export type { AdapterActivityKey }

export const AdapterChannelInboundEventSchema = z
  .object({
    connectionId: ConnectionIdSchema,
    channelId: ChannelIdSchema,
    adapterKey: z.string().trim().min(1),
    platformEventId: z.string().min(1).optional(),
    platformMessageId: z.string().min(1).optional(),
    kind: z.enum(['message-created', 'message-edited', 'message-deleted', 'member-updated', 'reaction', 'control']),
    activityKey: AdapterActivityKeySchema.optional(),
    targetPlatformMessageId: z.string().min(1).optional(),
    targetLogicalMessageId: LogicalMessageIdSchema.optional(),
    senderMemberId: ChannelMemberIdSchema.optional(),
    parts: z.array(MessagePartSchema),
    platformSequence: z.number().int().safe().optional(),
    platformTimestamp: z.number().int().safe().nonnegative(),
    receivedAt: z.number().int().safe().nonnegative(),
    dedupeKey: z.string().trim().min(1),
    facts: z.record(z.string(), z.json()).optional(),
    assetOccurrences: z
      .array(z.object({ partIndex: z.number().int().nonnegative(), assetId: AssetIdSchema }).strict())
      .optional(),
  })
  .strict()

export type AdapterChannelInboundEvent = z.infer<typeof AdapterChannelInboundEventSchema>

export const AdapterConnectionInboundEventSchema = z
  .object({
    connectionId: ConnectionIdSchema,
    adapterKey: z.string().trim().min(1),
    platformEventId: z.string().min(1).optional(),
    activityKey: AdapterActivityKeySchema,
    summary: z.string().trim().min(1).max(2_000),
    actorIdentityId: PlatformIdentityIdSchema.optional(),
    subjectIdentityId: PlatformIdentityIdSchema.optional(),
    sourceTimestamp: z.number().int().safe().nonnegative(),
    receivedAt: z.number().int().safe().nonnegative(),
    dedupeKey: z.string().trim().min(1),
    facts: z.record(z.string(), z.json()).optional(),
  })
  .strict()

export type AdapterConnectionInboundEvent = z.infer<typeof AdapterConnectionInboundEventSchema>

export interface InboundCommitResult {
  readonly channelEventId: ChannelEventId
  readonly inserted: boolean
}

export interface ConnectionInboundCommitResult {
  readonly connectionEventId: ConnectionEventId
  readonly inserted: boolean
}

export interface AdapterConnectionContext {
  readonly connectionId: ConnectionId
  readonly acceptChannelInbound: (event: AdapterChannelInboundEvent) => Promise<InboundCommitResult>
  readonly acceptConnectionInbound?: (event: AdapterConnectionInboundEvent) => Promise<ConnectionInboundCommitResult>
  readonly now: () => number
  readonly channels?: AdapterChannelDirectory
  readonly identities?: AdapterIdentityDirectory
  readonly members?: AdapterMemberDirectory
  readonly account?: AdapterAccountDirectory
  readonly messages?: AdapterMessageDirectory
  readonly assets?: AdapterAssetHost
  readonly credentials?: AdapterCredentialHost
  readonly state?: AdapterScopedStateStore
  readonly diagnostics?: AdapterDiagnosticPublisher
  readonly transport?: AdapterTransportService
}

export type AdapterConnectionHostContext = AdapterConnectionContext &
  Required<
    Pick<
      AdapterConnectionContext,
      | 'acceptConnectionInbound'
      | 'channels'
      | 'identities'
      | 'members'
      | 'account'
      | 'messages'
      | 'assets'
      | 'credentials'
      | 'state'
      | 'diagnostics'
      | 'transport'
    >
  >

export interface AdapterIdentityDirectory {
  ensure(input: {
    readonly platformUserId: string
    readonly displayName?: string
    readonly observedAt: number
  }): Promise<PlatformIdentityId>
}

/** Restricted Host-owned channel directory. It never exposes Core repositories. */
export interface AdapterChannelDirectory {
  ensure(input: {
    readonly platformChannelId: string
    readonly kind: 'direct' | 'group'
    readonly displayName?: string
    readonly observedAt: number
  }): Promise<ChannelId>
  updateDisplayName(channelId: ChannelId, displayName: string): Promise<void>
  resolvePlatformChannelId(channelId: ChannelId): Promise<string | undefined>
  resolveKind(channelId: ChannelId): Promise<'direct' | 'group' | undefined>
}

/** Restricted Host-owned identity directory scoped to this Connection. */
export interface AdapterMemberDirectory {
  ensure(input: {
    readonly channelId: ChannelId
    readonly platformUserId: string
    readonly displayName?: string
    readonly observedAt: number
    /**
     * This platform user is the connection's own account, e.g. the platform said the mention or the message is the
     * bot's. Set it only when the platform says so; the Host shows the member to the agent as itself.
     */
    readonly self?: boolean
  }): Promise<ChannelMemberId>
  /**
   * The member's platform user id. Undefined when the member is not in this channel, or is the connection's own account
   * and its platform id is unknown; use `isSelf` to tell the second case apart.
   */
  resolvePlatformUserId(channelId: ChannelId, memberId: ChannelMemberId): Promise<string | undefined>
  /** Whether the member stands for the connection's own account. */
  isSelf(channelId: ChannelId, memberId: ChannelMemberId): Promise<boolean>
}

/**
 * The connection's own platform account. An Adapter that can read its account id (for example from a login call)
 * reports it after each (re)connect; the agent never sees the id, but the Host uses it to resolve the account for
 * platform actions and to recognise other local connections' accounts in a shared channel.
 */
export interface AdapterAccountDirectory {
  report(input: {
    readonly platformUserId: string
    readonly displayName?: string
    readonly observedAt: number
  }): Promise<void>
}

export interface AdapterMessageDirectory {
  resolvePlatformMessage(
    channelId: ChannelId,
    platformMessageId: string,
  ): Promise<{ readonly logicalMessageId: LogicalMessageId; readonly authoredByAgent: boolean } | undefined>
  resolvePlatformMessageId(channelId: ChannelId, logicalMessageId: LogicalMessageId): Promise<string | undefined>
  resolveLogicalMessage(
    channelId: ChannelId,
    logicalMessageId: LogicalMessageId,
  ): Promise<{ readonly authoredByAgent: boolean } | undefined>
}

export interface AdapterAssetHost {
  importBytes(input: {
    readonly bytes: Uint8Array
    readonly declaredMediaType?: string
  }): Promise<{ readonly assetId: AssetId; readonly mediaType: string; readonly byteSize: number }>
  read(input: {
    readonly assetId: AssetId
    readonly channelId: ChannelId
  }): Promise<{ readonly bytes: Uint8Array; readonly mediaType: string; readonly byteSize: number }>
  fetchRemoteBytes(input: {
    readonly url: string
    readonly maxBytes: number
    /** Public HTTP is disabled by default and must be enabled by a protocol adapter that requires it. */
    readonly allowHttp?: boolean
  }): Promise<{
    readonly bytes: Uint8Array
    readonly declaredMediaType?: string
    readonly filename?: string
  }>
}

export interface AdapterCredentialHost {
  resolve(reference: string): Promise<string>
}

export interface AdapterHttpRequest {
  readonly url: string
  readonly method?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string | Uint8Array
  readonly signal?: AbortSignal
}

export interface AdapterHttpResponse {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: Uint8Array
}

export type AdapterWebSocketEvent =
  | { readonly type: 'open' }
  | { readonly type: 'message'; readonly data: string | Uint8Array }
  | { readonly type: 'close'; readonly code: number; readonly reason: string }
  | { readonly type: 'error'; readonly message: string }

export interface AdapterWebSocketConnection {
  send(data: string | Uint8Array): Promise<void>
  close(code?: number, reason?: string): Promise<void>
  subscribe(listener: (event: AdapterWebSocketEvent) => void): () => void
}

/** Replaceable network boundary used by production Adapters and offline validation harnesses. */
export interface AdapterTransportService {
  request(input: AdapterHttpRequest): Promise<AdapterHttpResponse>
  connectWebSocket(input: {
    readonly url: string
    readonly protocols?: string | readonly string[]
    readonly headers?: Readonly<Record<string, string>>
    readonly signal?: AbortSignal
  }): Promise<AdapterWebSocketConnection>
}

export interface AdapterScopedStateStore {
  load(key: string): Promise<JsonValue | undefined>
  save(key: string, value: JsonValue): Promise<void>
  clear(key: string): Promise<void>
}

export type AdapterConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'stopped'
export type AdapterOptionalCapabilityStatus = 'unknown' | 'available' | 'unsupported' | 'degraded'

export interface AdapterConnectionDiagnostic {
  readonly status: AdapterConnectionStatus
  readonly message?: string
  readonly credentialConfigured?: boolean
  readonly proactiveSend?: boolean
  readonly accountReference?: string
  readonly implementation?: {
    readonly name?: string
    readonly version?: string
    readonly protocolVersion?: string
  }
  readonly optionalCapabilities?: Readonly<Record<string, AdapterOptionalCapabilityStatus>>
  readonly details?: Readonly<Record<string, JsonValue>>
}

export interface AdapterDiagnosticPublisher {
  publish(diagnostic: AdapterConnectionDiagnostic): void
}

type AdapterSchemaObject = z.ZodObject

/** Product-facing, versioned Connection setup metadata contributed by an Adapter. */
export type AdapterChannelKind = 'internal' | 'direct' | 'group'

export interface AdapterActivityDefinition {
  readonly key: AdapterActivityKey
  readonly scope: 'channel' | 'connection'
  readonly displayName: string
  readonly description: string
  readonly icon?: HostIconName
  readonly triggerable: boolean
  readonly channelKinds?: readonly AdapterChannelKind[]
  /**
   * The activity acts on someone: it triggers only when that someone is the connection's own account (the member it
   * pokes, or the author of the message it reacts to). Activities among other members stay channel context.
   */
  readonly directedAt?: 'member' | 'message'
}

export interface AdapterCapabilityState {
  readonly state: 'available' | 'disabled' | 'unsupported' | 'degraded' | 'unknown'
  readonly reason?: string
}

export const AdapterCapabilityStateSchema = z
  .object({
    state: z.enum(['available', 'disabled', 'unsupported', 'degraded', 'unknown']),
    reason: z.string().trim().min(1).optional(),
  })
  .strict()

export interface PlatformActionDefinition {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly risk: 'low' | 'admin'
  readonly channelKinds: readonly ('direct' | 'group')[]
  readonly parameters: {
    readonly type: 'object'
    readonly properties: Readonly<Record<string, JsonValue>>
    readonly required?: readonly string[]
  }
}

export type AdapterConnectionDescriptor = {
  readonly key: string
  readonly displayName: string
  readonly description: string
  readonly provisioning: 'user-created' | 'system-singleton'
  /** Whether the user can edit the optional Connection alias. */
  readonly aliasEditable: boolean
  /** How Channels become available for this Connection. */
  readonly channelDiscovery: 'host-created' | 'adapter-observed'
  readonly channelKinds: readonly AdapterChannelKind[]
  readonly activities: readonly AdapterActivityDefinition[]
  readonly features: {
    readonly processingFeedback?: {
      readonly channelKinds: readonly Extract<AdapterChannelKind, 'direct' | 'group'>[]
    }
  }
  /** Product-owned diagnostic actions supported by this Adapter. */
  readonly diagnostics: {
    readonly receive: boolean
    readonly send: boolean
  }
  /** Optional product-owned Connection creation flow. Schema-form remains the default. */
  readonly creation?: {
    readonly mode: 'schema-form' | 'qr-login'
    readonly actionLabel?: string
    readonly pendingLabel?: string
  }
  /** Platform actions the Adapter can invoke on behalf of the Extension. */
  readonly platformActions?: readonly PlatformActionDefinition[]
  /** Raw API passthrough capability metadata. */
  readonly rawApi?: {
    readonly description: string
  }
  /**
   * Serialized Schemastery document for the Connection form. Fields with `meta.role: 'secret'` are credentials:
   * their raw values go to the credential store and the durable reference is keyed by the field name.
   */
  readonly configSchema: ConfigSchemaDocument
}

export type AdapterConnectionCreator<Configuration, Credentials, Created> = (
  configuration: Configuration,
  credentials: Credentials,
) => Created

export interface AdapterConnectionDefinition<
  Key extends string = string,
  ConfigurationSchema extends AdapterSchemaObject = AdapterSchemaObject,
  CredentialsSchema extends AdapterSchemaObject = AdapterSchemaObject,
  Created = unknown,
> {
  readonly descriptor: AdapterConnectionDescriptor & { readonly key: Key }
  readonly configurationSchema: ConfigurationSchema
  readonly credentialsSchema: CredentialsSchema
  readonly create: AdapterConnectionCreator<z.output<ConfigurationSchema>, z.output<CredentialsSchema>, Created>
}

export function defineAdapterConnection<
  const Key extends string,
  const ConfigurationSchema extends AdapterSchemaObject,
  const CredentialsSchema extends AdapterSchemaObject,
  Created,
>(input: {
  readonly key: Key
  readonly displayName: string
  readonly description: string
  readonly provisioning: 'user-created' | 'system-singleton'
  readonly aliasEditable?: boolean
  readonly channelDiscovery?: 'host-created' | 'adapter-observed'
  readonly channelKinds: readonly AdapterChannelKind[]
  readonly activities?: readonly AdapterActivityDefinition[]
  readonly features?: AdapterConnectionDescriptor['features']
  readonly diagnostics?: { readonly receive: boolean; readonly send: boolean }
  readonly creation?: AdapterConnectionDescriptor['creation']
  readonly platformActions?: readonly PlatformActionDefinition[]
  readonly rawApi?: { readonly description: string }
  readonly configurationSchema: ConfigurationSchema
  readonly credentialsSchema: CredentialsSchema
  readonly configSchema: ConfigSchemaDocument
  readonly create: AdapterConnectionCreator<z.output<ConfigurationSchema>, z.output<CredentialsSchema>, Created>
}): AdapterConnectionDefinition<Key, ConfigurationSchema, CredentialsSchema, Created> {
  for (const field of configFields(input.configSchema)) {
    const owner = field.kind === 'secret' ? input.credentialsSchema : input.configurationSchema
    if (!Object.hasOwn(owner.shape, field.key)) {
      throw new TypeError(
        `Adapter config field ${field.key} is not declared by the ${field.kind === 'secret' ? 'credentials' : 'configuration'} schema.`,
      )
    }
  }
  return {
    descriptor: {
      key: input.key,
      displayName: input.displayName,
      description: input.description,
      provisioning: input.provisioning,
      aliasEditable: input.aliasEditable ?? input.provisioning === 'user-created',
      channelDiscovery:
        input.channelDiscovery ?? (input.provisioning === 'user-created' ? 'adapter-observed' : 'host-created'),
      channelKinds: input.channelKinds,
      activities: input.activities ?? [],
      features: input.features ?? {},
      diagnostics: input.diagnostics ?? {
        receive: input.provisioning === 'user-created',
        send: input.provisioning === 'user-created',
      },
      ...(input.creation === undefined ? {} : { creation: input.creation }),
      ...(input.platformActions === undefined ? {} : { platformActions: input.platformActions }),
      ...(input.rawApi === undefined ? {} : { rawApi: input.rawApi }),
      configSchema: input.configSchema,
    },
    configurationSchema: input.configurationSchema,
    credentialsSchema: input.credentialsSchema,
    create: input.create,
  }
}

export const AdapterEmptyObjectSchema = z.object({}).strict()

export interface ParsedAdapterConnectionConfiguration<
  ConfigurationSchema extends AdapterSchemaObject = AdapterSchemaObject,
  CredentialsSchema extends AdapterSchemaObject = AdapterSchemaObject,
> {
  readonly configuration: z.output<ConfigurationSchema>
  readonly credentials: z.output<CredentialsSchema>
}

/**
 * Validates the public schema subset before an Adapter-specific creator receives values.
 * Credential-reference fields accept write-only secret material separately from durable config.
 */
export function parseAdapterConnectionConfiguration<
  Key extends string,
  ConfigurationSchema extends AdapterSchemaObject,
  CredentialsSchema extends AdapterSchemaObject,
  Created,
>(
  definition: AdapterConnectionDefinition<Key, ConfigurationSchema, CredentialsSchema, Created>,
  input: {
    readonly configuration?: Readonly<Record<string, unknown>>
    readonly credentials?: Readonly<Record<string, unknown>>
  },
): ParsedAdapterConnectionConfiguration<ConfigurationSchema, CredentialsSchema> {
  const configurationInput = input.configuration ?? {}
  const credentialInput = input.credentials ?? {}
  const unknownConfiguration = Object.keys(configurationInput).find(
    (key) => !Object.hasOwn(definition.configurationSchema.shape, key),
  )
  const unknownCredential = Object.keys(credentialInput).find(
    (key) => !Object.hasOwn(definition.credentialsSchema.shape, key),
  )
  if (unknownConfiguration || unknownCredential) {
    throw new TypeError(`连接配置包含未知字段：${unknownConfiguration ?? unknownCredential}`)
  }

  const missingCredential = configFields(definition.descriptor.configSchema).find(
    (field) =>
      field.kind === 'secret' &&
      field.required &&
      (typeof credentialInput[field.key] !== 'string' || String(credentialInput[field.key]).trim().length === 0),
  )
  if (missingCredential) {
    throw new TypeError(`请填写${missingCredential.title}。`)
  }
  return {
    configuration: definition.configurationSchema.parse(configurationInput),
    credentials: definition.credentialsSchema.parse(credentialInput),
  }
}

/** Adapter-owned durable state, namespaced by Connection and an Adapter-defined key. */
export interface AdapterRuntimeStateStore {
  load(connectionId: ConnectionId, key: string): Promise<JsonValue | undefined>
  save(connectionId: ConnectionId, key: string, value: JsonValue, updatedAt: number): Promise<void>
  clear(connectionId: ConnectionId, key: string): Promise<void>
}

export interface PhysicalDeliveryRequest {
  readonly deliveryId: PhysicalDeliveryId
  readonly logicalMessageId: LogicalMessageId
  readonly connectionId: ConnectionId
  readonly channelId: ChannelId
  readonly parts: readonly MessagePart[]
  readonly replyTo?: string
  readonly adapterContext?: JsonValue
  readonly processingFeedback?: {
    readonly leaseId: string
    readonly platformMessageId: string
  }
}

export type AdapterFailureKind = 'transient' | 'permanent' | 'rate-limited' | 'authentication' | 'invalid'

export const AdapterDeliveryReceiptSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('sent'),
      platformMessageId: z.string().min(1).optional(),
      capabilityOutcomes: z.record(z.string(), z.json()).optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal('failed'),
      failure: z
        .object({
          kind: z.enum(['transient', 'permanent', 'rate-limited', 'authentication', 'invalid']),
          message: z.string(),
          retryAfterMs: z.number().int().nonnegative().optional(),
        })
        .strict(),
    })
    .strict(),
  z.object({ status: z.literal('unknown'), message: z.string() }).strict(),
])

export type AdapterDeliveryReceipt = z.infer<typeof AdapterDeliveryReceiptSchema>

export interface AdapterRuntimeCapabilities {
  readonly outbound: AdapterOutboundCapabilities
  readonly activities: Readonly<Record<AdapterActivityKey, AdapterCapabilityState>>
  readonly processingFeedback?: AdapterCapabilityState
}

export const AdapterRuntimeCapabilitiesSchema = z
  .object({
    outbound: AdapterOutboundCapabilitiesSchema,
    activities: z.record(AdapterActivityKeySchema, AdapterCapabilityStateSchema),
    processingFeedback: AdapterCapabilityStateSchema.optional(),
  })
  .strict()

export interface AdapterLocalChannelPort {
  postMessage(input: {
    readonly channelId: ChannelId
    readonly clientEventId: string
    readonly senderMemberId?: ChannelMemberId
    readonly parts: readonly MessagePart[]
    readonly replyToBot?: boolean
    readonly receivedAt?: number
  }): Promise<InboundCommitResult>
}

export interface AdapterConnectionRuntime {
  readonly capabilities: AdapterRuntimeCapabilities
  readonly interactions?: AdapterConnectionInteractions
  readonly localChannel?: AdapterLocalChannelPort
  /** Platform-aware, side-effect-free split before PhysicalDelivery facts are committed. */
  planOutbound?(input: {
    readonly connectionId: ConnectionId
    readonly channelId: ChannelId
    readonly parts: readonly MessagePart[]
    readonly replyTo?: string
    readonly origin?: {
      readonly platformMessageId?: string
      readonly activityKey?: AdapterActivityKey
      readonly receivedAt: number
    }
    readonly processingFeedback?: {
      readonly leaseId: string
      readonly platformMessageId: string
    }
  }): Promise<readonly AdapterPhysicalPlan[]>
  start(): Promise<void>
  stop(): Promise<void>
  deliver(request: PhysicalDeliveryRequest, signal: AbortSignal): Promise<AdapterDeliveryReceipt>
}

export type AdapterInteractionOutcome =
  | { readonly status: 'succeeded' }
  | { readonly status: 'unsupported'; readonly message: string }
  | { readonly status: 'failed'; readonly message: string }
  | { readonly status: 'unknown'; readonly message: string }

export interface AdapterConnectionInteractions {
  startProcessingFeedback?(input: {
    readonly leaseId: string
    readonly channelId: ChannelId
    readonly platformMessageId: string
  }): Promise<AdapterInteractionOutcome>
  finishProcessingFeedback?(input: {
    readonly leaseId: string
    readonly channelId: ChannelId
    readonly platformMessageId: string
    readonly reason: 'idle' | 'error' | 'cancelled' | 'timeout' | 'shutdown' | 'recovery'
  }): Promise<AdapterInteractionOutcome>
  retractOwnMessage?(input: {
    readonly channelId: ChannelId
    readonly platformMessageId: string
    readonly clientRequestId: string
  }): Promise<AdapterInteractionOutcome>
  nudgeMember?(input: {
    readonly channelId: ChannelId
    readonly memberId: ChannelMemberId
    readonly clientRequestId: string
  }): Promise<AdapterInteractionOutcome>
  invokePlatformAction?(input: {
    readonly channelId: ChannelId
    readonly action: string
    readonly args: Readonly<Record<string, JsonValue>>
    readonly clientRequestId: string
  }): Promise<AdapterInteractionOutcome & { readonly result?: JsonValue }>
  invokeRawApi?(input: {
    readonly channelId: ChannelId
    readonly api: string
    readonly params: Readonly<Record<string, JsonValue>>
    readonly clientRequestId: string
  }): Promise<AdapterInteractionOutcome & { readonly result?: JsonValue }>
}

export interface AdapterPhysicalPlan {
  readonly parts: readonly MessagePart[]
  readonly adapterContext?: JsonValue
  readonly consumesProcessingFeedback?: boolean
}

export interface AdapterContribution<Config = unknown> {
  readonly key: string
  create(context: AdapterConnectionContext, config: Config): Promise<AdapterConnectionRuntime>
}

export interface AdapterStoredConnectionConfiguration {
  readonly configuration: Readonly<Record<string, string | number | boolean>>
  readonly credentialRefs: Readonly<Record<string, string>>
}

export type AdapterConnectionLoginStatus = 'pending' | 'scanned' | 'expired'

export interface AdapterConnectionLoginInput {
  readonly signal: AbortSignal
  readonly onQrCode: (qrCodeUrl: string) => Promise<void> | void
  readonly onStatus: (status: AdapterConnectionLoginStatus, message?: string) => void
}

export interface AdapterConnectionLoginResult {
  /** Stable platform account identity used to prevent duplicates and verify reauthentication. */
  readonly accountKey: string
  /** Complete private Adapter configuration persisted by the Host. */
  readonly configuration: Readonly<Record<string, string | number | boolean>>
  /** Raw write-only credentials persisted by the Host under Adapter-owned keys. */
  readonly credentials: Readonly<Record<string, string>>
}

export interface AdapterConnectionLoginContribution {
  readonly mode: 'qr-login'
  start(input: AdapterConnectionLoginInput): Promise<AdapterConnectionLoginResult>
}

/** Versioned Host-wide Adapter contribution loaded from built-ins or an installed Extension Revision. */
export interface AdapterHostContributionV2 {
  readonly apiVersion: 2
  readonly descriptor: AdapterConnectionDescriptor
  readonly connectionLogin?: AdapterConnectionLoginContribution
  create(
    context: AdapterConnectionHostContext,
    stored: AdapterStoredConnectionConfiguration,
  ): Promise<AdapterConnectionRuntime>
}

export interface RegisteredAdapterHandle {
  readonly owner: string
  readonly contribution: AdapterHostContributionV2
  dispose(): Promise<void>
}

const assertAdapterDescriptor = (descriptor: AdapterConnectionDescriptor): void => {
  if (!descriptor.key.trim()) throw new TypeError('Adapter key must not be empty.')
  if (!/^[a-z][a-z0-9-]{1,62}[a-z0-9]$/u.test(descriptor.key)) {
    throw new TypeError('Adapter key must use lowercase letters, numbers, and hyphens.')
  }
  if (!descriptor.displayName.trim()) throw new TypeError('Adapter displayName must not be empty.')
  if (descriptor.provisioning !== 'user-created' && descriptor.provisioning !== 'system-singleton') {
    throw new TypeError('Adapter provisioning is invalid.')
  }
  if (descriptor.provisioning === 'system-singleton' && descriptor.aliasEditable) {
    throw new TypeError('System-singleton Adapter alias cannot be editable.')
  }
  if (descriptor.channelKinds.length === 0) throw new TypeError('Adapter must declare at least one Channel kind.')
  if (descriptor.channelKinds.some((kind) => kind !== 'internal' && kind !== 'direct' && kind !== 'group')) {
    throw new TypeError('Adapter declared an invalid Channel kind.')
  }
  const channelKinds = new Set(descriptor.channelKinds)
  if (channelKinds.size !== descriptor.channelKinds.length) {
    throw new TypeError('Adapter Channel kinds must not contain duplicates.')
  }
  const activityKeys = new Set<string>()
  for (const activity of descriptor.activities) {
    AdapterActivityKeySchema.parse(activity.key)
    if (activityKeys.has(activity.key)) throw new TypeError(`Adapter activity key is duplicated: ${activity.key}`)
    activityKeys.add(activity.key)
    if (!activity.displayName.trim() || !activity.description.trim()) {
      throw new TypeError(`Adapter activity requires displayName and description: ${activity.key}`)
    }
    if (activity.scope !== 'channel' && activity.scope !== 'connection') {
      throw new TypeError(`Adapter activity scope is invalid: ${activity.key}`)
    }
    if (typeof activity.triggerable !== 'boolean') {
      throw new TypeError(`Adapter activity triggerable flag is invalid: ${activity.key}`)
    }
    if (activity.directedAt !== undefined && activity.directedAt !== 'member' && activity.directedAt !== 'message') {
      throw new TypeError(`Adapter activity directedAt is invalid: ${activity.key}`)
    }
    if (activity.scope === 'connection') {
      if (activity.triggerable)
        throw new TypeError(`Connection activity cannot trigger an intelligent agent: ${activity.key}`)
      if (activity.channelKinds !== undefined) {
        throw new TypeError(`Connection activity cannot declare Channel kinds: ${activity.key}`)
      }
      continue
    }
    if (!activity.channelKinds || activity.channelKinds.length === 0) {
      throw new TypeError(`Channel activity must declare Channel kinds: ${activity.key}`)
    }
    if (new Set(activity.channelKinds).size !== activity.channelKinds.length) {
      throw new TypeError(`Channel activity kinds must not contain duplicates: ${activity.key}`)
    }
    if (activity.channelKinds.some((kind) => !channelKinds.has(kind))) {
      throw new TypeError(`Channel activity uses an unsupported Channel kind: ${activity.key}`)
    }
  }
  const feedbackKinds = descriptor.features.processingFeedback?.channelKinds ?? []
  if (new Set(feedbackKinds).size !== feedbackKinds.length) {
    throw new TypeError('Processing feedback Channel kinds must not contain duplicates.')
  }
  if (feedbackKinds.some((kind) => !channelKinds.has(kind))) {
    throw new TypeError('Processing feedback uses an unsupported Channel kind.')
  }
  const parsedSchema = ConfigSchemaDocumentSchema.safeParse(descriptor.configSchema)
  if (!parsedSchema.success) throw new TypeError('Adapter config schema must be a serialized Schemastery object.')
  for (const field of configFields(descriptor.configSchema)) {
    if (!field.key.trim() || !field.title.trim())
      throw new TypeError('Adapter config fields need stable keys and titles.')
    if (field.kind === 'object' || field.kind === 'array') {
      throw new TypeError(`Adapter config field must be a scalar: ${field.key}`)
    }
    if (field.kind === 'secret' && field.default !== undefined) {
      throw new TypeError(`Adapter credential field cannot declare a default: ${field.key}`)
    }
  }
  const actionNames = new Set<string>()
  for (const action of descriptor.platformActions ?? []) {
    if (!action.name.trim() || !/^[a-z0-9_]+$/u.test(action.name)) {
      throw new TypeError(
        `Adapter platform action name must contain only lowercase letters, numbers, and underscores: ${action.name}`,
      )
    }
    if (actionNames.has(action.name)) throw new TypeError(`Adapter platform action name is duplicated: ${action.name}`)
    actionNames.add(action.name)
    if (!action.title.trim() || !action.description.trim()) {
      throw new TypeError(`Adapter platform action requires title and description: ${action.name}`)
    }
    if (action.risk !== 'low' && action.risk !== 'admin') {
      throw new TypeError(`Adapter platform action has invalid risk level: ${action.name}`)
    }
    if (action.channelKinds.length === 0) {
      throw new TypeError(`Adapter platform action must declare at least one channel kind: ${action.name}`)
    }
    if (action.channelKinds.some((kind) => kind !== 'direct' && kind !== 'group')) {
      throw new TypeError(`Adapter platform action has invalid channel kind: ${action.name}`)
    }
    if (new Set(action.channelKinds).size !== action.channelKinds.length) {
      throw new TypeError(`Adapter platform action channel kinds must not contain duplicates: ${action.name}`)
    }
    if (action.parameters.type !== 'object') {
      throw new TypeError(`Adapter platform action parameters must have type 'object': ${action.name}`)
    }
  }
  if (descriptor.rawApi && !descriptor.rawApi.description.trim()) {
    throw new TypeError('Adapter rawApi must have a description.')
  }
}

/** Single authoritative catalog for built-in and installed Host Adapter contributions. */
export class AdapterRegistry {
  readonly #byKey = new Map<string, RegisteredAdapterHandle>()
  readonly #byOwner = new Map<string, RegisteredAdapterHandle>()

  register(ownerInput: string, contribution: AdapterHostContributionV2): RegisteredAdapterHandle {
    const owner = ownerInput.trim()
    if (!owner) throw new TypeError('Adapter contribution owner must not be empty.')
    if (contribution.apiVersion !== 2)
      throw new TypeError(`Unsupported Adapter Host API version: ${String(contribution.apiVersion)}`)
    assertAdapterDescriptor(contribution.descriptor)
    if (
      (contribution.descriptor.creation?.mode === 'qr-login') !==
      (contribution.connectionLogin?.mode === 'qr-login')
    ) {
      throw new TypeError('A qr-login Adapter must provide exactly one matching connection login contribution.')
    }
    if (this.#byOwner.has(owner)) throw new Error(`Adapter contribution owner is already registered: ${owner}`)
    if (this.#byKey.has(contribution.descriptor.key)) {
      throw new Error(`Adapter key is already registered: ${contribution.descriptor.key}`)
    }
    let active = true
    const handle: RegisteredAdapterHandle = {
      owner,
      contribution,
      dispose: () => {
        if (!active) return Promise.resolve()
        active = false
        if (this.#byKey.get(contribution.descriptor.key) === handle) this.#byKey.delete(contribution.descriptor.key)
        if (this.#byOwner.get(owner) === handle) this.#byOwner.delete(owner)
        return Promise.resolve()
      },
    }
    this.#byKey.set(contribution.descriptor.key, handle)
    this.#byOwner.set(owner, handle)
    return handle
  }

  get(key: string): AdapterHostContributionV2 | undefined {
    return this.#byKey.get(key)?.contribution
  }

  getByOwner(owner: string): AdapterHostContributionV2 | undefined {
    return this.#byOwner.get(owner)?.contribution
  }

  list(): readonly AdapterHostContributionV2[] {
    return [...this.#byKey.values()].map(({ contribution }) => contribution)
  }
}

export function parseAdapterChannelInboundEvent(input: unknown): AdapterChannelInboundEvent {
  return AdapterChannelInboundEventSchema.parse(input)
}

export function parseAdapterConnectionInboundEvent(input: unknown): AdapterConnectionInboundEvent {
  return AdapterConnectionInboundEventSchema.parse(input)
}

export function parseAdapterCapabilities(input: unknown): AdapterRuntimeCapabilities {
  const parsed = AdapterRuntimeCapabilitiesSchema.parse(input)
  return {
    outbound: parsed.outbound,
    activities: Object.fromEntries(
      Object.entries(parsed.activities).map(([key, value]) => [
        key,
        { state: value.state, ...(value.reason === undefined ? {} : { reason: value.reason }) },
      ]),
    ),
    ...(parsed.processingFeedback === undefined
      ? {}
      : {
          processingFeedback: {
            state: parsed.processingFeedback.state,
            ...(parsed.processingFeedback.reason === undefined ? {} : { reason: parsed.processingFeedback.reason }),
          },
        }),
  }
}

export function parseAdapterDeliveryReceipt(input: unknown): AdapterDeliveryReceipt {
  return AdapterDeliveryReceiptSchema.parse(input)
}

export { configSchema, configFields, EMPTY_CONFIG_SCHEMA } from '@nekro-nxt/contracts'
export type { ConfigField, ConfigSchemaDocument, ConfigSchemaNode } from '@nekro-nxt/contracts'
