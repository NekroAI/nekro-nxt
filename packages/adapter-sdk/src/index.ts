import type {
  ChannelEventId,
  ChannelId,
  ChannelMemberId,
  ConnectionId,
  JsonValue,
  LogicalMessageId,
  MessagePart,
  PhysicalDeliveryId,
} from '@nekro-nxt/contracts'
import { ChannelIdSchema, ChannelMemberIdSchema, ConnectionIdSchema, MessagePartSchema } from '@nekro-nxt/contracts'
import { z } from 'zod'

export interface AdapterOutboundCapabilities {
  readonly text: boolean
  readonly mentions: boolean
  readonly images: boolean
  readonly files: boolean
  readonly audio: boolean
  readonly replies: boolean
  readonly mixedContent: boolean
  readonly proactiveSend: boolean
  readonly maxTextLength?: number
  readonly maxAssetBytes?: number
  readonly acceptedMimeTypes?: readonly string[]
}

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

export type AdapterInboundEventKind =
  'message-created' | 'message-edited' | 'message-deleted' | 'member-updated' | 'reaction' | 'control'

export interface AdapterInboundEvent {
  readonly connectionId: ConnectionId
  readonly channelId: ChannelId
  readonly adapterKey: string
  readonly platformEventId?: string
  readonly platformMessageId?: string
  readonly kind: AdapterInboundEventKind
  readonly senderMemberId?: ChannelMemberId
  readonly parts: readonly MessagePart[]
  readonly platformSequence?: number
  readonly platformTimestamp: number
  readonly receivedAt: number
  readonly dedupeKey: string
  readonly facts?: Readonly<Record<string, JsonValue>>
  readonly checkpoint?: JsonValue
}

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
    checkpoint: z.json().optional(),
  })
  .strict()
  .superRefine((event, context) => {
    if ((event.kind === 'message-created' || event.kind === 'message-edited') && event.parts.length === 0) {
      context.addIssue({ code: 'custom', path: ['parts'], message: 'Message events require at least one part.' })
    }
  })

export interface InboundCommitResult {
  readonly channelEventId: ChannelEventId
  readonly inserted: boolean
  readonly checkpointCommitted: boolean
}

export interface AdapterConnectionContext {
  readonly connectionId: ConnectionId
  readonly acceptInbound: (event: AdapterInboundEvent) => Promise<InboundCommitResult>
  readonly now: () => number
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
  readonly attempt: number
  readonly adapterContext?: JsonValue
}

export type AdapterFailureKind = 'transient' | 'permanent' | 'rate-limited' | 'authentication' | 'invalid'

export type AdapterDeliveryReceipt =
  | {
      readonly status: 'sent'
      readonly platformMessageId: string
      readonly capabilityOutcomes?: Readonly<Record<string, JsonValue>>
    }
  | {
      readonly status: 'failed'
      readonly failure: {
        readonly kind: AdapterFailureKind
        readonly message: string
        readonly retryAfterMs?: number
      }
    }
  | { readonly status: 'unknown'; readonly message: string }

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
  return AdapterInboundEventSchema.parse(input) as AdapterInboundEvent
}

export function parseAdapterCapabilities(input: unknown): AdapterOutboundCapabilities {
  return AdapterOutboundCapabilitiesSchema.parse(input) as AdapterOutboundCapabilities
}

export function parseAdapterDeliveryReceipt(input: unknown): AdapterDeliveryReceipt {
  return AdapterDeliveryReceiptSchema.parse(input) as AdapterDeliveryReceipt
}
