import type {
  AssetId,
  ChannelEventId,
  ChannelActivityType,
  ChannelId,
  ChannelMemberId,
  ConnectionId,
  JsonValue,
  LogicalMessageId,
  MessagePart,
  PhysicalDeliveryId,
} from '@nekro-nxt/contracts'
import {
  AssetIdSchema,
  ChannelActivityTypeSchema,
  ChannelIdSchema,
  ChannelMemberIdSchema,
  ConnectionIdSchema,
  LogicalMessageIdSchema,
  MessagePartSchema,
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

export type AdapterInboundEventKind =
  'message-created' | 'message-edited' | 'message-deleted' | 'member-updated' | 'reaction' | 'control'

export { ChannelActivityTypeSchema }
export type { ChannelActivityType }

export const AdapterInboundEventSchema = z
  .object({
    connectionId: ConnectionIdSchema,
    channelId: ChannelIdSchema,
    adapterKey: z.string().trim().min(1),
    platformEventId: z.string().min(1).optional(),
    platformMessageId: z.string().min(1).optional(),
    kind: z.enum(['message-created', 'message-edited', 'message-deleted', 'member-updated', 'reaction', 'control']),
    activityType: ChannelActivityTypeSchema.optional(),
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

export type AdapterInboundEvent = z.infer<typeof AdapterInboundEventSchema>

export interface InboundCommitResult {
  readonly channelEventId: ChannelEventId
  readonly inserted: boolean
}

export interface AdapterConnectionContext {
  readonly connectionId: ConnectionId
  readonly acceptInbound: (event: AdapterInboundEvent) => Promise<InboundCommitResult>
  readonly now: () => number
  readonly channels?: AdapterChannelDirectory
  readonly members?: AdapterMemberDirectory
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
      'channels' | 'members' | 'messages' | 'assets' | 'credentials' | 'state' | 'diagnostics' | 'transport'
    >
  >

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
  }): Promise<ChannelMemberId>
  resolvePlatformUserId(channelId: ChannelId, memberId: ChannelMemberId): Promise<string | undefined>
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
  fetchRemoteBytes(input: { readonly url: string; readonly maxBytes: number }): Promise<{
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
  readonly accountId?: string
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

export type AdapterConfigurationProperty =
  | {
      readonly type: 'string' | 'credential-reference'
      readonly title: string
      readonly description?: string
      readonly default?: string
      /** Durable credential reference key; defaults to the public property key. */
      readonly credentialKey?: string
    }
  | {
      readonly type: 'boolean'
      readonly title: string
      readonly description?: string
      readonly default?: boolean
    }
  | {
      readonly type: 'number'
      readonly title: string
      readonly description?: string
      readonly default?: number
    }

type AdapterSchemaObject = z.ZodObject

type RequiredKeys<T> = {
  [Key in keyof T]-?: T extends Required<Pick<T, Key>> ? Key : never
}[keyof T]

type AdapterConfigurationPropertyFor<Value> = [Exclude<Value, undefined>] extends [string]
  ? {
      readonly type: 'string'
      readonly title: string
      readonly description?: string
      readonly default?: string
    }
  : [Exclude<Value, undefined>] extends [boolean]
    ? {
        readonly type: 'boolean'
        readonly title: string
        readonly description?: string
        readonly default?: boolean
      }
    : [Exclude<Value, undefined>] extends [number]
      ? {
          readonly type: 'number'
          readonly title: string
          readonly description?: string
          readonly default?: number
        }
      : never

type AdapterCredentialPropertyFor<Value> = [Exclude<Value, undefined>] extends [string]
  ? {
      readonly type: 'credential-reference'
      readonly title: string
      readonly description?: string
      readonly credentialKey?: string
    }
  : never

type AdapterConnectionWireSchema = {
  readonly schemaVersion: number
  readonly type: 'object'
  readonly required: readonly string[]
  readonly properties: Readonly<Record<string, AdapterConfigurationProperty>>
}

type AdapterConnectionProperties<
  ConfigurationSchema extends AdapterSchemaObject,
  CredentialsSchema extends AdapterSchemaObject,
> = {
  [Key in Extract<keyof z.output<ConfigurationSchema>, string>]: AdapterConfigurationPropertyFor<
    z.output<ConfigurationSchema>[Key]
  >
} & {
  [Key in Extract<keyof z.output<CredentialsSchema>, string>]: AdapterCredentialPropertyFor<
    z.output<CredentialsSchema>[Key]
  >
}

/** The serializable, product-facing setup metadata contributed by an Adapter. */
export type AdapterConnectionUiSchema<
  ConfigurationSchema extends AdapterSchemaObject,
  CredentialsSchema extends AdapterSchemaObject,
> = {
  readonly schemaVersion: number
  readonly type: 'object'
  readonly required: readonly Extract<
    RequiredKeys<z.input<ConfigurationSchema>> | RequiredKeys<z.input<CredentialsSchema>>,
    string
  >[]
  readonly properties: AdapterConnectionProperties<ConfigurationSchema, CredentialsSchema>
}

/** Product-facing, versioned Connection setup metadata contributed by an Adapter. */
export type AdapterConnectionDescriptor<
  ConfigurationSchema extends AdapterSchemaObject = never,
  CredentialsSchema extends AdapterSchemaObject = never,
> = {
  readonly key: string
  readonly displayName: string
  readonly description: string
  /** System-managed adapters remain visible for diagnostics but cannot be created by users. */
  readonly userCreatable: boolean
  /** Whether the user can edit the optional Connection alias. */
  readonly aliasEditable: boolean
  /** How Channels become available for this Connection. */
  readonly channelDiscovery: 'host-created' | 'adapter-observed'
  /** Product-owned diagnostic actions supported by this Adapter. */
  readonly diagnostics: {
    readonly receive: boolean
    readonly send: boolean
  }
  readonly configSchema: [ConfigurationSchema] extends [never]
    ? AdapterConnectionWireSchema
    : [CredentialsSchema] extends [never]
      ? AdapterConnectionWireSchema
      : AdapterConnectionUiSchema<ConfigurationSchema, CredentialsSchema>
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
  readonly descriptor: AdapterConnectionDescriptor<ConfigurationSchema, CredentialsSchema> & { readonly key: Key }
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
  readonly userCreatable: boolean
  readonly aliasEditable?: boolean
  readonly channelDiscovery?: 'host-created' | 'adapter-observed'
  readonly diagnostics?: { readonly receive: boolean; readonly send: boolean }
  readonly configurationSchema: ConfigurationSchema
  readonly credentialsSchema: CredentialsSchema
  readonly configSchema: AdapterConnectionUiSchema<ConfigurationSchema, CredentialsSchema>
  readonly create: AdapterConnectionCreator<z.output<ConfigurationSchema>, z.output<CredentialsSchema>, Created>
}): AdapterConnectionDefinition<Key, ConfigurationSchema, CredentialsSchema, Created> {
  return {
    descriptor: {
      key: input.key,
      displayName: input.displayName,
      description: input.description,
      userCreatable: input.userCreatable,
      aliasEditable: input.aliasEditable ?? input.userCreatable,
      channelDiscovery: input.channelDiscovery ?? (input.userCreatable ? 'adapter-observed' : 'host-created'),
      diagnostics: input.diagnostics ?? { receive: input.userCreatable, send: input.userCreatable },
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

  const uiSchema: AdapterConnectionWireSchema = definition.descriptor.configSchema
  const missingCredential = Object.entries(uiSchema.properties).find(
    ([key, property]) =>
      property.type === 'credential-reference' &&
      uiSchema.required.includes(key) &&
      (typeof credentialInput[key] !== 'string' || credentialInput[key].trim().length === 0),
  )
  if (missingCredential) {
    throw new TypeError(`请填写${missingCredential[1].title}。`)
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

export interface AdapterConnectionRuntime {
  readonly capabilities: AdapterOutboundCapabilities
  readonly interactions?: AdapterConnectionInteractions
  /** Platform-aware, side-effect-free split before PhysicalDelivery facts are committed. */
  planOutbound?(input: {
    readonly connectionId: ConnectionId
    readonly channelId: ChannelId
    readonly parts: readonly MessagePart[]
    readonly replyTo?: string
    readonly origin?: {
      readonly platformMessageId?: string
      readonly activityType?: ChannelActivityType
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

/** Versioned Host-wide Adapter contribution loaded from built-ins or an installed Extension Revision. */
export interface AdapterHostContributionV1 {
  readonly apiVersion: 1
  readonly descriptor: AdapterConnectionDescriptor
  create(
    context: AdapterConnectionHostContext,
    stored: AdapterStoredConnectionConfiguration,
  ): Promise<AdapterConnectionRuntime>
}

export interface RegisteredAdapterHandle {
  readonly owner: string
  readonly contribution: AdapterHostContributionV1
  dispose(): Promise<void>
}

const assertAdapterDescriptor = (descriptor: AdapterConnectionDescriptor): void => {
  if (!descriptor.key.trim()) throw new TypeError('Adapter key must not be empty.')
  if (!/^[a-z][a-z0-9-]{1,62}[a-z0-9]$/u.test(descriptor.key)) {
    throw new TypeError('Adapter key must use lowercase letters, numbers, and hyphens.')
  }
  if (!descriptor.displayName.trim()) throw new TypeError('Adapter displayName must not be empty.')
  if (descriptor.configSchema.type !== 'object') throw new TypeError('Adapter config schema must be an object.')
  if (!Number.isSafeInteger(descriptor.configSchema.schemaVersion) || descriptor.configSchema.schemaVersion < 1) {
    throw new TypeError('Adapter config schema version must be a positive integer.')
  }
  const credentialKeys = new Set<string>()
  const requiredKeys = new Set<string>()
  for (const key of descriptor.configSchema.required) {
    if (requiredKeys.has(key)) throw new TypeError(`Adapter required property is duplicated: ${key}`)
    requiredKeys.add(key)
  }
  for (const [key, property] of Object.entries(descriptor.configSchema.properties)) {
    if (!key.trim() || !property.title.trim())
      throw new TypeError('Adapter config properties need stable keys and titles.')
    if (property.default !== undefined && property.type === 'credential-reference') {
      throw new TypeError(`Adapter credential property cannot declare a default: ${key}`)
    }
    if (property.default !== undefined && typeof property.default !== property.type) {
      throw new TypeError(`Adapter config property default has the wrong type: ${key}`)
    }
    if (property.type !== 'credential-reference') continue
    const credentialKey = property.credentialKey?.trim() || key
    if (credentialKeys.has(credentialKey)) throw new TypeError(`Adapter credential key is duplicated: ${credentialKey}`)
    credentialKeys.add(credentialKey)
  }
  const unknownRequired = descriptor.configSchema.required.find(
    (key) => !Object.hasOwn(descriptor.configSchema.properties, key),
  )
  if (unknownRequired) throw new TypeError(`Adapter required property is not declared: ${unknownRequired}`)
}

/** Single authoritative catalog for built-in and installed Host Adapter contributions. */
export class AdapterRegistry {
  readonly #byKey = new Map<string, RegisteredAdapterHandle>()
  readonly #byOwner = new Map<string, RegisteredAdapterHandle>()

  register(ownerInput: string, contribution: AdapterHostContributionV1): RegisteredAdapterHandle {
    const owner = ownerInput.trim()
    if (!owner) throw new TypeError('Adapter contribution owner must not be empty.')
    if (contribution.apiVersion !== 1)
      throw new TypeError(`Unsupported Adapter Host API version: ${String(contribution.apiVersion)}`)
    assertAdapterDescriptor(contribution.descriptor)
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

  get(key: string): AdapterHostContributionV1 | undefined {
    return this.#byKey.get(key)?.contribution
  }

  getByOwner(owner: string): AdapterHostContributionV1 | undefined {
    return this.#byOwner.get(owner)?.contribution
  }

  list(): readonly AdapterHostContributionV1[] {
    return [...this.#byKey.values()].map(({ contribution }) => contribution)
  }
}

export function parseAdapterInboundEvent(input: unknown): AdapterInboundEvent {
  return AdapterInboundEventSchema.parse(input)
}

export function parseAdapterCapabilities(input: unknown): AdapterOutboundCapabilities {
  return AdapterOutboundCapabilitiesSchema.parse(input)
}

export function parseAdapterDeliveryReceipt(input: unknown): AdapterDeliveryReceipt {
  return AdapterDeliveryReceiptSchema.parse(input)
}
