import type {
  AdapterConnectionContext,
  AdapterConnectionRuntime,
  AdapterDeliveryReceipt,
  AdapterOutboundCapabilities,
  InboundCommitResult,
  PhysicalDeliveryRequest,
} from '@nekro-nxt/adapter-sdk'
import { AdapterEmptyObjectSchema, defineAdapterConnection } from '@nekro-nxt/adapter-sdk'
import type { ChannelId, ChannelMemberId, ConnectionId, MessagePart } from '@nekro-nxt/contracts'

export const WEB_ADAPTER_KEY = 'web'

export const WEB_CONNECTION_DEFINITION = defineAdapterConnection({
  key: WEB_ADAPTER_KEY,
  displayName: '内置频道',
  description: '由 NekroNXT 直接提供，用于应用内对话。',
  userCreatable: false,
  configurationSchema: AdapterEmptyObjectSchema,
  credentialsSchema: AdapterEmptyObjectSchema,
  configSchema: { schemaVersion: 1, type: 'object', required: [], properties: {} },
  create: () => undefined,
})

export const WEB_CONNECTION_DESCRIPTOR = WEB_CONNECTION_DEFINITION.descriptor

export const WEB_ADAPTER_CAPABILITIES: AdapterOutboundCapabilities = {
  text: true,
  mentions: true,
  images: true,
  files: true,
  audio: true,
  replies: true,
  mixedContent: true,
  proactiveSend: true,
}

export interface WebInboundMessage {
  readonly channelId: ChannelId
  readonly clientEventId: string
  readonly senderMemberId?: ChannelMemberId
  readonly parts: readonly MessagePart[]
  readonly replyToBot?: boolean
  readonly receivedAt?: number
}

export interface WebOutboundEvent {
  readonly platformMessageId: string
  readonly request: PhysicalDeliveryRequest
}

export type WebOutboundListener = (event: WebOutboundEvent) => Promise<void> | void

/** In-process platform boundary for Web Channel; durable truth remains in Core Outbox. */
export class WebAdapterConnection implements AdapterConnectionRuntime {
  readonly capabilities = WEB_ADAPTER_CAPABILITIES
  readonly #context: AdapterConnectionContext
  readonly #listeners = new Set<WebOutboundListener>()
  #running = false
  #nextMessage = 1

  constructor(context: AdapterConnectionContext) {
    this.#context = context
  }

  start(): Promise<void> {
    if (this.#running) return Promise.reject(new Error('Web Adapter connection is already running.'))
    this.#running = true
    return Promise.resolve()
  }

  stop(): Promise<void> {
    this.#running = false
    this.#listeners.clear()
    return Promise.resolve()
  }

  subscribe(listener: WebOutboundListener): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  postMessage(message: WebInboundMessage): Promise<InboundCommitResult> {
    if (!this.#running) return Promise.reject(new Error('Web Adapter connection is not running.'))
    if (message.clientEventId.trim().length === 0)
      return Promise.reject(new Error('Web clientEventId must not be empty.'))
    const receivedAt = message.receivedAt ?? this.#context.now()
    return this.#context.acceptInbound({
      connectionId: this.#context.connectionId,
      channelId: message.channelId,
      adapterKey: WEB_ADAPTER_KEY,
      platformEventId: message.clientEventId,
      platformMessageId: message.clientEventId,
      kind: 'message-created',
      ...(message.senderMemberId === undefined ? {} : { senderMemberId: message.senderMemberId }),
      parts: [...message.parts],
      platformTimestamp: receivedAt,
      receivedAt,
      dedupeKey: `web-event:${message.clientEventId}`,
      ...(message.replyToBot === undefined ? {} : { facts: { replyToBot: message.replyToBot } }),
    })
  }

  async deliver(request: PhysicalDeliveryRequest, signal: AbortSignal): Promise<AdapterDeliveryReceipt> {
    if (!this.#running) return Promise.reject(new Error('Web Adapter connection is not running.'))
    if (request.connectionId !== this.#context.connectionId) {
      return { status: 'failed', failure: { kind: 'invalid', message: 'Delivery targets another Connection.' } }
    }
    if (signal.aborted) {
      return { status: 'failed', failure: { kind: 'transient', message: 'Delivery aborted before publication.' } }
    }
    const platformMessageId = `web-message-${this.#nextMessage}`
    this.#nextMessage += 1
    const event = { platformMessageId, request }
    await Promise.allSettled([...this.#listeners].map((listener) => Promise.resolve().then(() => listener(event))))
    return { status: 'sent', platformMessageId }
  }
}

export const createWebAdapterConnection = (
  connectionId: ConnectionId,
  acceptInbound: AdapterConnectionContext['acceptInbound'],
  now: () => number = Date.now,
): WebAdapterConnection => new WebAdapterConnection({ connectionId, acceptInbound, now })
