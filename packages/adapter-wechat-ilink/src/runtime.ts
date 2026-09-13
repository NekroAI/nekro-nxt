import type {
  AdapterConnectionHostContext,
  AdapterConnectionRuntime,
  AdapterDeliveryReceipt,
  AdapterOutboundCapabilities,
  AdapterPhysicalPlan,
  AdapterRuntimeCapabilities,
  PhysicalDeliveryRequest,
} from '@nekro-nxt/adapter-sdk'
import type { AssetId, ChannelId, ConnectionId, MessagePart } from '@nekro-nxt/contracts'
import { LogicalMessageIdSchema, PhysicalDeliveryIdSchema } from '@nekro-nxt/contracts'
import { WechatIlinkRuntimeConfigSchema, type WechatIlinkRuntimeConfig } from './config.js'
import {
  contextTokenStateKey,
  createWechatIlinkInboundEvent,
  decodeWechatId,
  normalizeWechatIlinkInboundMessage,
  type WechatIlinkInboundMediaAttachment,
  type WechatIlinkNormalizedInboundMessage,
} from './inbound.js'
import { createWechatIlinkSdkTransportFactory } from './transport.js'
import {
  WECHAT_ILINK_SYNC_BUF_STATE_KEY,
  type WechatIlinkClassifiedError,
  type WechatIlinkMessage,
  type WechatIlinkMessageItem,
  type WechatIlinkTransport,
  type WechatIlinkTransportFactory,
} from './types.js'

export const WECHAT_ILINK_CAPABILITIES: AdapterOutboundCapabilities = {
  text: true,
  mentions: false,
  images: false,
  files: false,
  audio: false,
  replies: false,
  mixedContent: false,
  proactiveSend: false,
  maxTextLength: 4000,
  acceptedMimeTypes: ['text/plain'],
}

const WECHAT_ILINK_MAX_INBOUND_ASSET_BYTES = 20 * 1024 * 1024

export interface WechatIlinkRuntimeOptions {
  readonly context: AdapterConnectionHostContext
  readonly config: WechatIlinkRuntimeConfig
  readonly transportFactory?: WechatIlinkTransportFactory
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null

const numericErrorField = (record: Readonly<Record<string, unknown>> | undefined, key: string): number | undefined => {
  const value = record?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export const classifyWechatIlinkError = (error: unknown): WechatIlinkClassifiedError => {
  const message = error instanceof Error ? error.message : String(error)
  const lower = message.toLowerCase()
  const record = isRecord(error) ? error : undefined
  const cause = isRecord(record?.['cause']) ? record['cause'] : undefined
  const status = numericErrorField(record, 'status') ?? numericErrorField(cause, 'status')
  const codes = [
    numericErrorField(record, 'errcode'),
    numericErrorField(record, 'ret'),
    numericErrorField(cause, 'errcode'),
    numericErrorField(cause, 'ret'),
  ]
  if (status === 429 || /\b429\b|rate[ -]?limit|too many requests/u.test(lower)) {
    return { kind: 'rate-limited', message }
  }
  if (
    status === 401 ||
    status === 403 ||
    codes.includes(-14) ||
    /(?:ret|errcode)\s*=\s*-14\b|session (?:expired|timeout)|stale token|unauthori[sz]ed|authentication|not authenticated|forbidden|invalid token|expired token|token expired/u.test(
      lower,
    )
  ) {
    return { kind: 'authentication', message }
  }
  if (lower.includes('timeout') || lower.includes('network') || lower.includes('fetch failed')) {
    return { kind: 'transient', message }
  }
  return { kind: 'transient', message }
}

const joinTextParts = (parts: readonly MessagePart[]): string | undefined => {
  let text = ''
  for (const part of parts) {
    if (part.type !== 'text') return undefined
    text += part.text
  }
  return text
}

export class WechatIlinkRuntime implements AdapterConnectionRuntime {
  readonly capabilities: AdapterRuntimeCapabilities
  readonly #context: AdapterConnectionHostContext
  readonly #config: ReturnType<typeof WechatIlinkRuntimeConfigSchema.parse>
  readonly #transportFactory: WechatIlinkTransportFactory
  #transport: WechatIlinkTransport | undefined
  #abort: AbortController | undefined
  #running = false
  #generation = 0

  constructor(options: WechatIlinkRuntimeOptions) {
    this.#context = options.context
    this.#config = WechatIlinkRuntimeConfigSchema.parse(options.config)
    this.#transportFactory = options.transportFactory ?? createWechatIlinkSdkTransportFactory()
    this.capabilities = {
      outbound: { ...WECHAT_ILINK_CAPABILITIES, maxTextLength: this.#config.maxTextLength },
      activities: {},
    }
  }

  async start(): Promise<void> {
    if (this.#running) throw new Error('微信 iLink 连接已经在运行。')
    const token = await this.#context.credentials.resolve(this.#config.botTokenCredentialRef)
    const abort = new AbortController()
    const generation = this.#generation + 1
    this.#generation = generation
    this.#abort = abort
    this.#transport = this.#transportFactory({
      accountId: this.#config.accountId,
      token,
      baseUrl: this.#config.baseUrl,
      cdnBaseUrl: this.#config.cdnBaseUrl,
      ...(this.#config.channelVersion === undefined ? {} : { channelVersion: this.#config.channelVersion }),
      ...(this.#config.routeTag === undefined ? {} : { routeTag: this.#config.routeTag }),
    })
    this.#publishBaseDiagnostic('connecting')
    await this.#transport.start({
      signal: abort.signal,
      longPollTimeoutMs: this.#config.longPollTimeoutMs,
      loadSyncBuf: async () => {
        const value = await this.#context.state.load(WECHAT_ILINK_SYNC_BUF_STATE_KEY)
        return typeof value === 'string' ? value : undefined
      },
      saveSyncBuf: (syncBuf) => this.#context.state.save(WECHAT_ILINK_SYNC_BUF_STATE_KEY, syncBuf),
      onMessage: (message) => this.#receive(message, generation, abort.signal),
      onError: (error) => this.#publishError(error),
      onSessionExpired: () => {
        this.#context.diagnostics.publish({
          status: 'failed',
          message: '微信 iLink 会话已过期，请重新扫码登录。',
          accountReference: this.#config.accountId,
          credentialConfigured: true,
          proactiveSend: false,
          implementation: { name: 'wechat-ilink-client', version: '0.1.0' },
          details: { code: 'wechat-ilink/session-expired' },
        })
      },
    })
    this.#running = true
    this.#publishBaseDiagnostic('connected')
  }

  async stop(): Promise<void> {
    this.#running = false
    this.#generation += 1
    this.#abort?.abort(new Error('微信 iLink 连接已停止。'))
    await this.#transport?.stop()
    this.#transport = undefined
    this.#abort = undefined
    this.#context.diagnostics.publish({ status: 'stopped', credentialConfigured: true, proactiveSend: false })
  }

  planOutbound(input: {
    readonly connectionId: ConnectionId
    readonly channelId: ChannelId
    readonly parts: readonly MessagePart[]
  }): Promise<readonly AdapterPhysicalPlan[]> {
    return Promise.resolve([{ parts: input.parts }])
  }

  async deliver(request: PhysicalDeliveryRequest, signal: AbortSignal): Promise<AdapterDeliveryReceipt> {
    if (!this.#running || !this.#transport) {
      return { status: 'failed', failure: { kind: 'transient', message: '微信 iLink 连接尚未运行。' } }
    }
    const invalid = await this.#validateDelivery(request)
    if (invalid.status === 'failed') return invalid
    try {
      const receipt = await this.#transport.sendText({
        toUserId: invalid.userId,
        text: invalid.text,
        contextToken: invalid.contextToken,
        signal,
      })
      return {
        status: 'sent',
        platformMessageId: receipt.platformMessageId ?? receipt.clientId ?? request.deliveryId,
        capabilityOutcomes: {
          idKind: receipt.platformMessageId ? 'message_id' : receipt.clientId ? 'client_id' : 'delivery_id',
        },
      }
    } catch (error) {
      const failure = classifyWechatIlinkError(error)
      return {
        status: 'failed',
        failure: {
          kind: failure.kind,
          message: failure.message,
          ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }),
        },
      }
    }
  }

  async testSend(channelId: ChannelId, signal: AbortSignal = AbortSignal.timeout(15_000)): Promise<string> {
    const receipt = await this.deliver(
      {
        deliveryId: PhysicalDeliveryIdSchema.parse('phy_WECHATTEST'),
        logicalMessageId: LogicalMessageIdSchema.parse('msg_WECHATTEST'),
        connectionId: this.#context.connectionId,
        channelId,
        parts: [{ type: 'text', text: 'NekroNXT 微信 iLink 连接发送测试。' }],
      },
      signal,
    )
    if (receipt.status === 'sent') {
      if (!receipt.platformMessageId) throw new Error('微信 iLink 测试回执缺少消息 ID。')
      return receipt.platformMessageId
    }
    if (receipt.status === 'failed') throw new Error(receipt.failure.message)
    throw new Error(receipt.message)
  }

  async #validateDelivery(
    request: PhysicalDeliveryRequest,
  ): Promise<
    | { readonly status: 'ok'; readonly userId: string; readonly text: string; readonly contextToken: string }
    | Extract<AdapterDeliveryReceipt, { readonly status: 'failed' }>
  > {
    const text = joinTextParts(request.parts)
    if (text === undefined) {
      return { status: 'failed', failure: { kind: 'invalid', message: '微信 iLink 当前只支持纯文本消息。' } }
    }
    if (!text.trim()) return { status: 'failed', failure: { kind: 'invalid', message: '微信 iLink 不能发送空文本。' } }
    if (text.length > this.#config.maxTextLength) {
      return { status: 'failed', failure: { kind: 'invalid', message: '微信 iLink 文本超过单条字符上限。' } }
    }
    const platformChannelId = await this.#context.channels.resolvePlatformChannelId(request.channelId)
    if (!platformChannelId?.startsWith('direct:')) {
      return { status: 'failed', failure: { kind: 'invalid', message: '微信 iLink 当前只支持已发现的私聊频道。' } }
    }
    const userId = decodeWechatId(platformChannelId.slice('direct:'.length))
    if (!userId) return { status: 'failed', failure: { kind: 'invalid', message: '微信 iLink 私聊频道身份无法解析。' } }
    const contextToken = await this.#context.state.load(contextTokenStateKey(userId))
    if (typeof contextToken !== 'string' || !contextToken.trim()) {
      const message = '微信 iLink 当前没有可用 context_token；需要先收到该会话消息后才能回复。'
      this.#context.diagnostics.publish({
        status: 'connected',
        message,
        accountReference: this.#config.accountId,
        credentialConfigured: true,
        proactiveSend: false,
        details: { code: 'wechat-ilink/missing-context-token' },
      })
      return { status: 'failed', failure: { kind: 'invalid', message } }
    }
    return { status: 'ok', userId, text, contextToken }
  }

  async #receive(message: WechatIlinkMessage, generation: number, signal: AbortSignal): Promise<void> {
    if (!this.#running || generation !== this.#generation || signal.aborted) return
    const normalized = normalizeWechatIlinkInboundMessage(message, {
      now: this.#context.now,
      accountId: this.#config.accountId,
    })
    if (!normalized) return
    if (normalized.facts['hasGroupId'] === true) {
      this.#context.diagnostics.publish({
        status: 'connected',
        accountReference: this.#config.accountId,
        credentialConfigured: true,
        proactiveSend: false,
        details: { code: 'wechat-ilink/group-unsupported' },
      })
      return
    }
    const channelId = await this.#context.channels.ensure({
      platformChannelId: normalized.platformChannelId,
      kind: 'direct',
      observedAt: normalized.receivedAt,
    })
    const senderMemberId = await this.#context.members.ensure({
      channelId,
      platformUserId: normalized.platformUserId,
      observedAt: normalized.receivedAt,
    })
    if (normalized.contextToken !== undefined) {
      await this.#context.state.save(contextTokenStateKey(normalized.platformUserId), normalized.contextToken)
    }
    if (!this.#running || generation !== this.#generation || signal.aborted) return
    const resolved = await this.#resolveInboundParts(normalized, signal)
    if (!this.#running || generation !== this.#generation || signal.aborted) return
    await this.#context.acceptChannelInbound(
      createWechatIlinkInboundEvent({
        connectionId: this.#context.connectionId,
        channelId,
        senderMemberId,
        normalized,
        parts: resolved.parts,
        assetOccurrences: resolved.assetOccurrences,
      }),
    )
  }

  async #resolveInboundParts(
    normalized: WechatIlinkNormalizedInboundMessage,
    signal: AbortSignal,
  ): Promise<{
    readonly parts: readonly MessagePart[]
    readonly assetOccurrences: readonly { readonly partIndex: number; readonly assetId: AssetId }[]
  }> {
    if (normalized.mediaAttachments.length === 0) return { parts: normalized.parts, assetOccurrences: [] }
    const parts = [...normalized.parts]
    const assetOccurrences: { partIndex: number; assetId: AssetId }[] = []
    for (const occurrence of normalized.mediaAttachments) {
      if (signal.aborted) break
      const mediaLabel = occurrence.attachment.kind === 'image' ? '图片' : '文件'
      if (!this.#config.enableInboundMedia) {
        parts[occurrence.partIndex] = {
          type: 'rich',
          adapterKey: 'wechat-ilink',
          kind: occurrence.attachment.kind,
          summary: '微信 iLink 入站媒体接收未开启。',
        }
        continue
      }
      try {
        const asset = await this.#downloadInboundAsset(occurrence.attachment, signal)
        const fileName = asset.fileName ?? occurrence.attachment.fileName
        parts[occurrence.partIndex] =
          occurrence.attachment.kind === 'image'
            ? {
                type: 'image',
                assetId: asset.assetId,
                ...(fileName === undefined ? {} : { alt: fileName }),
              }
            : {
                type: 'file',
                assetId: asset.assetId,
                ...(fileName === undefined ? {} : { name: fileName }),
              }
        assetOccurrences.push({ partIndex: occurrence.partIndex, assetId: asset.assetId })
      } catch {
        parts[occurrence.partIndex] = {
          type: 'rich',
          adapterKey: 'wechat-ilink',
          kind: occurrence.attachment.kind,
          summary: '微信 iLink ' + mediaLabel + '下载失败。',
        }
      }
    }
    return { parts, assetOccurrences }
  }

  async #downloadInboundAsset(attachment: WechatIlinkInboundMediaAttachment, signal: AbortSignal) {
    if (attachment.byteSize !== undefined && attachment.byteSize > WECHAT_ILINK_MAX_INBOUND_ASSET_BYTES) {
      throw new Error('媒体超过大小上限。')
    }
    if (this.#transport?.downloadMedia) {
      try {
        const item = this.#toSdkDownloadItem(attachment)
        const media = await this.#transport.downloadMedia(item, signal)
        if (signal.aborted) throw signal.reason
        if (media !== null) {
          if (media.kind !== attachment.kind) throw new Error('媒体类型不匹配。')
          if (media.data.byteLength > WECHAT_ILINK_MAX_INBOUND_ASSET_BYTES) throw new Error('媒体超过大小上限。')
          const asset = await this.#context.assets.importBytes({
            bytes: media.data,
            ...(attachment.mediaType === undefined ? {} : { declaredMediaType: attachment.mediaType }),
          })
          return { assetId: asset.assetId, ...(media.fileName === undefined ? {} : { fileName: media.fileName }) }
        }
      } catch (error) {
        if (signal.aborted || !attachment.url) throw error
      }
    }
    if (!attachment.url) throw new Error('媒体没有可下载来源。')
    if (signal.aborted) throw signal.reason
    const remote = await this.#context.assets.fetchRemoteBytes({
      url: attachment.url,
      maxBytes: WECHAT_ILINK_MAX_INBOUND_ASSET_BYTES,
    })
    if (signal.aborted) throw signal.reason
    const declaredMediaType = attachment.mediaType ?? remote.declaredMediaType
    const asset = await this.#context.assets.importBytes({
      bytes: remote.bytes,
      ...(declaredMediaType === undefined ? {} : { declaredMediaType }),
    })
    return {
      assetId: asset.assetId,
      ...(remote.filename === undefined ? {} : { fileName: remote.filename }),
    }
  }

  #toSdkDownloadItem(attachment: WechatIlinkInboundMediaAttachment): WechatIlinkMessageItem {
    const item: WechatIlinkMessageItem =
      attachment.item.type !== undefined || attachment.item.item_type === undefined
        ? attachment.item
        : { ...attachment.item, type: attachment.item.item_type }
    if (item.media === undefined) return item
    if (attachment.kind === 'image' && item.image_item === undefined) {
      return {
        ...item,
        image_item: {
          media: item.media,
          ...(item.aeskey === undefined ? {} : { aeskey: item.aeskey }),
          ...(item.file_name === undefined ? {} : { file_name: item.file_name }),
          ...(item.name === undefined ? {} : { name: item.name }),
          ...(item.mime_type === undefined ? {} : { mime_type: item.mime_type }),
          ...(item.media_type === undefined ? {} : { media_type: item.media_type }),
          ...(item.content_type === undefined ? {} : { content_type: item.content_type }),
          ...(item.size === undefined ? {} : { size: item.size }),
        },
      }
    }
    if (attachment.kind === 'file' && item.file_item === undefined) {
      return {
        ...item,
        file_item: {
          media: item.media,
          ...(item.file_name === undefined ? {} : { file_name: item.file_name }),
          ...(item.name === undefined ? {} : { name: item.name }),
          ...(item.md5 === undefined ? {} : { md5: item.md5 }),
          ...(item.len === undefined ? {} : { len: item.len }),
          ...(item.mime_type === undefined ? {} : { mime_type: item.mime_type }),
          ...(item.media_type === undefined ? {} : { media_type: item.media_type }),
          ...(item.content_type === undefined ? {} : { content_type: item.content_type }),
          ...(item.size === undefined ? {} : { size: item.size }),
        },
      }
    }
    return item
  }

  #publishBaseDiagnostic(status: 'connecting' | 'connected'): void {
    this.#context.diagnostics.publish({
      status,
      accountReference: this.#config.accountId,
      credentialConfigured: true,
      proactiveSend: false,
      implementation: { name: 'wechat-ilink-client', version: '0.1.0' },
      optionalCapabilities: {
        media: this.#config.enableInboundMedia ? 'degraded' : 'unsupported',
        group: 'unsupported',
        mention: 'unsupported',
      },
    })
  }

  #publishError(error: unknown): void {
    const failure = classifyWechatIlinkError(error)
    this.#context.diagnostics.publish({
      status: failure.kind === 'authentication' ? 'failed' : 'reconnecting',
      message: failure.message,
      accountReference: this.#config.accountId,
      credentialConfigured: true,
      proactiveSend: false,
      ...(failure.details === undefined ? {} : { details: failure.details }),
    })
  }
}
