import type {
  ChannelEventId,
  ChannelId,
  ConnectionId,
  JsonValue,
  LogicalMessageId,
  MessagePart,
  PhysicalDeliveryId,
} from '@nekro-nxt/contracts'
import {
  AssetIdSchema,
  ChannelIdSchema,
  ChannelMemberIdSchema,
  ConnectionIdSchema,
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

export const AdapterInboundEventSchema = z
  .object({
    connectionId: ConnectionIdSchema,
    channelId: ChannelIdSchema,
    adapterKey: z.string().trim().min(1),
    platformEventId: z.string().min(1).optional(),
    platformMessageId: z.string().min(1).optional(),
    kind: z.enum(['message-created', 'message-edited', 'message-deleted', 'member-updated', 'reaction', 'control']),
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
}

export type AdapterConfigurationProperty =
  | {
      readonly type: 'string' | 'credential-reference'
      readonly title: string
      readonly description?: string
      readonly default?: string
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
}

export type AdapterFailureKind = 'transient' | 'permanent' | 'rate-limited' | 'authentication' | 'invalid'

export const AdapterDeliveryReceiptSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('sent'),
      platformMessageId: z.string().min(1),
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
  /** Platform-aware, side-effect-free split before PhysicalDelivery facts are committed. */
  planOutbound?(input: {
    readonly connectionId: ConnectionId
    readonly channelId: ChannelId
    readonly parts: readonly MessagePart[]
    readonly replyTo?: string
  }): Promise<readonly AdapterPhysicalPlan[]>
  start(): Promise<void>
  stop(): Promise<void>
  deliver(request: PhysicalDeliveryRequest, signal: AbortSignal): Promise<AdapterDeliveryReceipt>
}

export interface AdapterPhysicalPlan {
  readonly parts: readonly MessagePart[]
  readonly adapterContext?: JsonValue
}

export interface AdapterContribution<Config = unknown> {
  readonly key: string
  create(context: AdapterConnectionContext, config: Config): Promise<AdapterConnectionRuntime>
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
