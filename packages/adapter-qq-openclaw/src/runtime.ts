import type {
  AdapterConnectionContext,
  AdapterConnectionRuntime,
  AdapterDeliveryReceipt,
  AdapterPhysicalPlan,
  PhysicalDeliveryRequest,
} from '@nekro-nxt/adapter-sdk'
import type { MessagePart } from '@nekro-nxt/contracts'
import {
  QQGatewayClient,
  type QQGatewayAccess,
  type QQGatewayCheckpointStore,
  type QQGatewayClientOptions,
  type QQGatewayClock,
  type QQGatewaySocketFactory,
  type QQGatewayStatus,
} from './gateway.js'
import { decodeQQInboundMessage } from './inbound.js'
import {
  QQOpenClawConnection,
  type QQAssetSource,
  type QQIdentityDirectory,
  type QQInboundBridge,
  type QQOpenClawConfig,
  type QQOpenClawTransport,
} from './index.js'

export interface QQOpenClawRuntimeOptions {
  readonly context: AdapterConnectionContext
  readonly config: QQOpenClawConfig
  readonly directory: QQIdentityDirectory
  readonly assets: QQAssetSource
  readonly inbound: QQInboundBridge
  readonly transport: QQOpenClawTransport
  readonly gateway: {
    readonly access: QQGatewayAccess
    readonly sockets: QQGatewaySocketFactory
    readonly checkpoints: QQGatewayCheckpointStore
    readonly clock: QQGatewayClock
    readonly onStatus?: (status: QQGatewayStatus) => void
    readonly maxDispatchAttempts?: number
    readonly onQuarantine?: QQGatewayClientOptions['onQuarantine']
    readonly resumeTtlMs?: number
    readonly initialReconnectDelayMs?: number
    readonly maxReconnectDelayMs?: number
  }
}

/** Owns one QQ Connection, including REST delivery, Gateway ingest and quiescent shutdown. */
export class QQOpenClawRuntime implements AdapterConnectionRuntime {
  readonly #connection: QQOpenClawConnection
  readonly #gateway: QQGatewayClient

  constructor(options: QQOpenClawRuntimeOptions) {
    this.#connection = new QQOpenClawConnection(options.context, options.config, {
      directory: options.directory,
      assets: options.assets,
      inbound: options.inbound,
      transport: options.transport,
    })
    this.#gateway = new QQGatewayClient({
      appId: options.config.appId,
      access: options.gateway.access,
      sockets: options.gateway.sockets,
      checkpoints: options.gateway.checkpoints,
      clock: options.gateway.clock,
      onDispatch: async (eventType, data, dispatch) => {
        const message = decodeQQInboundMessage(eventType, data, { now: options.context.now })
        if (!message) return true
        await this.#connection.receive(
          {
            ...message,
            ...(dispatch.sequence === undefined ? {} : { platformSequence: dispatch.sequence }),
          },
          dispatch.signal,
        )
        return true
      },
      ...(options.gateway.onStatus === undefined ? {} : { onStatus: options.gateway.onStatus }),
      ...(options.gateway.maxDispatchAttempts === undefined
        ? {}
        : { maxDispatchAttempts: options.gateway.maxDispatchAttempts }),
      ...(options.gateway.onQuarantine === undefined ? {} : { onQuarantine: options.gateway.onQuarantine }),
      ...(options.gateway.resumeTtlMs === undefined ? {} : { resumeTtlMs: options.gateway.resumeTtlMs }),
      ...(options.gateway.initialReconnectDelayMs === undefined
        ? {}
        : { initialReconnectDelayMs: options.gateway.initialReconnectDelayMs }),
      ...(options.gateway.maxReconnectDelayMs === undefined
        ? {}
        : { maxReconnectDelayMs: options.gateway.maxReconnectDelayMs }),
    })
  }

  get capabilities() {
    return this.#connection.capabilities
  }

  async start(): Promise<void> {
    await this.#connection.start()
    try {
      await this.#gateway.start()
    } catch (error) {
      await this.#connection.stop()
      throw error
    }
  }

  async stop(): Promise<void> {
    try {
      await this.#gateway.stop()
    } finally {
      await this.#connection.stop()
    }
  }

  planOutbound(input: {
    readonly connectionId: PhysicalDeliveryRequest['connectionId']
    readonly channelId: PhysicalDeliveryRequest['channelId']
    readonly parts: readonly MessagePart[]
    readonly replyTo?: string
  }): Promise<readonly AdapterPhysicalPlan[]> {
    return this.#connection.planOutbound(input)
  }

  deliver(request: PhysicalDeliveryRequest, signal: AbortSignal): Promise<AdapterDeliveryReceipt> {
    return this.#connection.deliver(request, signal)
  }

  /** Explicit platform diagnostic; it is not an intelligent-agent channel message. */
  async testSend(channelId: PhysicalDeliveryRequest['channelId'], signal: AbortSignal): Promise<string> {
    const target = await this.#connection.resolveDiagnosticTarget(channelId)
    const receipt = await this.#connection.sendDiagnosticText(target, 'NekroNxt QQ 连接发送测试。', signal)
    return receipt.platformMessageId
  }
}
