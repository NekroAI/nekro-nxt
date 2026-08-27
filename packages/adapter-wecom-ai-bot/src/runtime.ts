import type {
  AdapterConnectionHostContext,
  AdapterConnectionInteractions,
  AdapterConnectionRuntime,
  AdapterDeliveryReceipt,
  AdapterInteractionOutcome,
  AdapterPhysicalPlan,
  PhysicalDeliveryRequest,
} from '@nekro-nxt/adapter-sdk'
import type {
  AssetId,
  ChannelActivityType,
  ChannelId,
  ConnectionId,
  JsonValue,
  LogicalMessageId,
  MessagePart,
} from '@nekro-nxt/contracts'
import { ChannelIdSchema, LogicalMessageIdSchema } from '@nekro-nxt/contracts'
import { createDecipheriv, createHash, randomUUID } from 'node:crypto'
import { WECOM_AI_BOT_ADAPTER_KEY, WECOM_AI_BOT_CAPABILITIES, type WeComAiBotRuntimeConfig } from './definition.js'
import { WeComTransportError, WeComWebSocketClient, type WeComObject, weComObject } from './transport.js'

const CALLBACK_TTL_MS = 24 * 60 * 60 * 1_000
const STREAM_LIMIT_MS = 10 * 60 * 1_000
const STREAM_SETTLE_MS = 9 * 60 * 1_000
const WELCOME_LIMIT_MS = 5_000
const MAX_TEXT_BYTES = 20_000
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024
const CHUNK_BYTES = 512 * 1024
const STREAM_STATE_KEY = 'wecom-ai-bot/active-streams-v1'
const FEEDBACK_TARGET_STATE_KEY = 'wecom-ai-bot/feedback-targets-v1'

type MediaType = 'image' | 'voice' | 'video' | 'file'

interface CallbackRecord {
  readonly reqId: string
  readonly channelId: ChannelId
  readonly receivedAt: number
}

interface ActiveStream {
  readonly leaseId: string
  readonly platformMessageId: string
  readonly reqId: string
  readonly streamId: string
  readonly startedAt: number
  readonly channelId: ChannelId
  readonly logicalMessageId?: LogicalMessageId
}

interface FeedbackTarget {
  readonly channelId: ChannelId
  readonly logicalMessageId: LogicalMessageId
  readonly expiresAt: number
}

interface OutboundContext {
  readonly mode: 'stream-final' | 'welcome' | 'proactive'
  readonly mediaType?: MediaType
  readonly filename?: string
  readonly callbackReqId?: string
  readonly streamId?: string
  readonly receivedAt?: number
}

export interface WeComAiBotRuntimeOptions {
  readonly context: AdapterConnectionHostContext
  readonly config: WeComAiBotRuntimeConfig
  readonly transport?: {
    readonly endpoint?: string
    readonly requestTimeoutMs?: number
    readonly heartbeatIntervalMs?: number
    readonly reconnectDelaysMs?: readonly number[]
  }
}

const object = (value: unknown): WeComObject | undefined => weComObject(value)
const string = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined
const number = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value)
    ? value
    : typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))
      ? Number(value)
      : undefined
const timestamp = (value: unknown, fallback: number): number => {
  const parsed = number(value)
  if (parsed === undefined || parsed < 0) return fallback
  return parsed < 10_000_000_000 ? Math.floor(parsed * 1_000) : Math.floor(parsed)
}
const truncate = (value: string, length = 300): string =>
  value.length <= length ? value : `${value.slice(0, Math.max(1, length - 1))}…`

const outboundContext = (value: JsonValue | undefined): OutboundContext | undefined => {
  const parsed = object(value)
  const mode = parsed?.['mode']
  if (mode !== 'stream-final' && mode !== 'welcome' && mode !== 'proactive') return undefined
  if (!parsed) return undefined
  const mediaType = parsed['mediaType']
  return {
    mode,
    ...(mediaType === 'image' || mediaType === 'voice' || mediaType === 'video' || mediaType === 'file'
      ? { mediaType }
      : {}),
    ...(string(parsed['filename']) === undefined ? {} : { filename: string(parsed['filename'])! }),
    ...(string(parsed['callbackReqId']) === undefined ? {} : { callbackReqId: string(parsed['callbackReqId'])! }),
    ...(string(parsed['streamId']) === undefined ? {} : { streamId: string(parsed['streamId'])! }),
    ...(number(parsed['receivedAt']) === undefined ? {} : { receivedAt: number(parsed['receivedAt'])! }),
  }
}

const utf8Bytes = (value: string): number => Buffer.byteLength(value, 'utf8')

/** Splits Markdown without breaking UTF-8 code points and prefers readable boundaries. */
export const splitWeComMarkdown = (value: string, maxBytes = MAX_TEXT_BYTES): string[] => {
  if (utf8Bytes(value) <= maxBytes) return [value]
  const output: string[] = []
  let remaining = value
  while (utf8Bytes(remaining) > maxBytes) {
    let used = 0
    let hardEnd = 0
    for (const codePoint of remaining) {
      const next = used + utf8Bytes(codePoint)
      if (next > maxBytes) break
      used = next
      hardEnd += codePoint.length
    }
    const prefix = remaining.slice(0, hardEnd)
    const candidates = [prefix.lastIndexOf('\n\n'), prefix.lastIndexOf('\n'), prefix.lastIndexOf(' ')]
    const preferred = Math.max(...candidates)
    const end =
      preferred >= Math.floor(hardEnd * 0.6)
        ? preferred + (prefix.slice(preferred, preferred + 2) === '\n\n' ? 2 : 1)
        : hardEnd
    output.push(remaining.slice(0, end))
    remaining = remaining.slice(end)
  }
  if (remaining.length > 0) output.push(remaining)
  return output
}

const decodeAesKey = (encoded: string): Buffer => {
  const normalized = encoded.trim()
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(normalized) || normalized.length % 4 !== 0) {
    throw new Error('企业微信媒体 AES Key 不是有效的 Base64。')
  }
  const key = Buffer.from(normalized, 'base64')
  if (key.length !== 32) throw new Error('企业微信媒体 AES Key 必须解码为 32 字节。')
  return key
}

/** Decrypts the official AES-256-CBC envelope and validates PKCS#7 padding explicitly. */
export const decryptWeComMedia = (encrypted: Uint8Array, encodedKey: string): Uint8Array => {
  if (encrypted.byteLength > MAX_DOWNLOAD_BYTES) throw new Error('企业微信媒体密文超过 100 MiB。')
  const key = decodeAesKey(encodedKey)
  const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16))
  decipher.setAutoPadding(false)
  const plain = Buffer.concat([decipher.update(encrypted), decipher.final()])
  if (plain.length === 0 || plain.length > MAX_DOWNLOAD_BYTES) throw new Error('企业微信媒体明文大小无效。')
  const padding = plain[plain.length - 1]!
  if (padding < 1 || padding > 32 || padding > plain.length) throw new Error('企业微信媒体 PKCS#7 填充无效。')
  for (let index = plain.length - padding; index < plain.length; index += 1) {
    if (plain[index] !== padding) throw new Error('企业微信媒体 PKCS#7 填充无效。')
  }
  return new Uint8Array(plain.subarray(0, plain.length - padding))
}

class SlidingWindowLimiter {
  readonly #minute = new Map<string, number[]>()
  readonly #hour = new Map<string, number[]>()

  take(key: string, now: number, minuteLimit: number, hourLimit: number): boolean {
    const minute = (this.#minute.get(key) ?? []).filter((at) => at > now - 60_000)
    const hour = (this.#hour.get(key) ?? []).filter((at) => at > now - 60 * 60_000)
    if (minute.length >= minuteLimit || hour.length >= hourLimit) return false
    minute.push(now)
    hour.push(now)
    this.#minute.set(key, minute)
    this.#hour.set(key, hour)
    return true
  }
}

const transportReceipt = (error: unknown): AdapterDeliveryReceipt => {
  if (error instanceof WeComTransportError) {
    if (error.kind === 'unknown') return { status: 'unknown', message: error.message }
    return { status: 'failed', failure: { kind: error.kind, message: error.message } }
  }
  return {
    status: 'failed',
    failure: { kind: 'transient', message: error instanceof Error ? error.message : String(error) },
  }
}

const interactionOutcome = (error: unknown): AdapterInteractionOutcome => {
  if (error instanceof WeComTransportError && error.kind === 'unknown') {
    return { status: 'unknown', message: error.message }
  }
  return { status: 'failed', message: error instanceof Error ? error.message : String(error) }
}

/** Official enterprise WeChat AI bot long-connection mapping. */
export class WeComAiBotRuntime implements AdapterConnectionRuntime {
  readonly capabilities = WECOM_AI_BOT_CAPABILITIES
  readonly interactions: AdapterConnectionInteractions
  readonly #context: AdapterConnectionHostContext
  readonly #config: WeComAiBotRuntimeConfig
  readonly #transportOptions: NonNullable<WeComAiBotRuntimeOptions['transport']>
  readonly #callbacks = new Map<string, CallbackRecord>()
  readonly #streams = new Map<string, ActiveStream>()
  readonly #feedbackTargets = new Map<string, FeedbackTarget>()
  readonly #streamTimers = new Map<string, ReturnType<typeof setTimeout>>()
  readonly #sendLimiter = new SlidingWindowLimiter()
  readonly #uploadLimiter = new SlidingWindowLimiter()
  #client: WeComWebSocketClient | undefined
  #started = false
  #persistQueue = Promise.resolve()

  constructor(options: WeComAiBotRuntimeOptions) {
    this.#context = options.context
    this.#config = options.config
    this.#transportOptions = options.transport ?? {}
    this.interactions = {
      startProcessingFeedback: (input) => this.#startFeedback(input),
      finishProcessingFeedback: (input) => this.#finishFeedback(input.leaseId, input.reason),
    }
  }

  async start(): Promise<void> {
    if (this.#started) throw new Error('企业微信智能机器人 Runtime 已启动。')
    this.#started = true
    const secret = await this.#context.credentials.resolve(this.#config.secretCredentialRef)
    await this.#restoreStreams()
    await this.#restoreFeedbackTargets()
    const client = new WeComWebSocketClient({
      context: this.#context,
      botId: this.#config.botId,
      secret,
      onFrame: (frame) => this.#receive(frame),
      ...this.#transportOptions,
    })
    this.#client = client
    await client.start()
    this.#scheduleRecovery()
  }

  async stop(): Promise<void> {
    if (!this.#started && !this.#client) return
    this.#started = false
    for (const timer of this.#streamTimers.values()) clearTimeout(timer)
    this.#streamTimers.clear()
    const pending = [...this.#streams.keys()].map((leaseId) => this.#finishFeedback(leaseId, 'shutdown'))
    await Promise.allSettled(pending)
    const client = this.#client
    this.#client = undefined
    await client?.stop()
    await this.#persistQueue
  }

  async planOutbound(input: {
    readonly connectionId: ConnectionId
    readonly channelId: ChannelId
    readonly parts: readonly MessagePart[]
    readonly replyTo?: string
    readonly origin?: {
      readonly platformMessageId?: string
      readonly activityType?: ChannelActivityType
      readonly receivedAt: number
    }
    readonly processingFeedback?: { readonly leaseId: string; readonly platformMessageId: string }
  }): Promise<readonly AdapterPhysicalPlan[]> {
    if (
      input.replyTo !== undefined ||
      input.parts.some((part) => part.type === 'mention' || part.type === 'quote' || part.type === 'rich')
    ) {
      throw new Error('企业微信智能机器人不支持主动 Mention、引用或富内容透传。')
    }
    const plans: AdapterPhysicalPlan[] = []
    let feedbackAvailable = input.processingFeedback !== undefined
    let welcomeAvailable = input.origin?.activityType === 'conversation-entered'
    for (const part of input.parts) {
      if (part.type === 'text') {
        const chunks = splitWeComMarkdown(part.text)
        for (const [index, textPart] of chunks.entries()) {
          const stream =
            feedbackAvailable && index === 0 ? this.#streams.get(input.processingFeedback!.leaseId) : undefined
          if (stream) {
            plans.push({
              parts: [{ type: 'text', text: textPart }],
              adapterContext: { mode: 'stream-final', callbackReqId: stream.reqId, streamId: stream.streamId },
              consumesProcessingFeedback: true,
            })
            feedbackAvailable = false
            continue
          }
          const welcomeCallback =
            welcomeAvailable && input.origin?.platformMessageId
              ? this.#callbacks.get(input.origin.platformMessageId)
              : undefined
          if (welcomeCallback) {
            plans.push({
              parts: [{ type: 'text', text: textPart }],
              adapterContext: {
                mode: 'welcome',
                callbackReqId: welcomeCallback.reqId,
                receivedAt: input.origin!.receivedAt,
              },
            })
            welcomeAvailable = false
          } else {
            plans.push({ parts: [{ type: 'text', text: textPart }], adapterContext: { mode: 'proactive' } })
          }
        }
        continue
      }
      if (part.type !== 'image' && part.type !== 'file' && part.type !== 'audio') {
        throw new Error(`企业微信智能机器人不支持主动发送 ${part.type} 内容。`)
      }
      const asset = await this.#context.assets.read({ assetId: part.assetId, channelId: input.channelId })
      const media = this.#classifyMedia(part, asset.mediaType)
      plans.push({
        parts: [part],
        adapterContext: {
          mode: 'proactive',
          mediaType: media.type,
          filename: media.filename,
        },
      })
    }
    return plans
  }

  async deliver(request: PhysicalDeliveryRequest, signal: AbortSignal): Promise<AdapterDeliveryReceipt> {
    if (signal.aborted) {
      return { status: 'failed', failure: { kind: 'transient', message: '发送在写入企业微信前已取消。' } }
    }
    const context = outboundContext(request.adapterContext)
    if (!context) return { status: 'failed', failure: { kind: 'invalid', message: '企业微信物理投递上下文无效。' } }
    try {
      const client = this.#requireClient()
      if (context.mode === 'stream-final') {
        const textPart = request.parts[0]
        if (textPart?.type !== 'text' || !context.callbackReqId || !context.streamId) {
          throw new WeComTransportError('企业微信流式结束投递无效。', 'invalid', false)
        }
        this.#takeSendRate(request.channelId)
        await client.request(
          'aibot_respond_msg',
          {
            msgtype: 'stream',
            stream: { id: context.streamId, content: textPart.text, finish: true },
          },
          context.callbackReqId,
        )
        if (request.processingFeedback) {
          const active = this.#streams.get(request.processingFeedback.leaseId)
          if (active) {
            this.#feedbackTargets.set(active.leaseId, {
              channelId: request.channelId,
              logicalMessageId: request.logicalMessageId,
              expiresAt: this.#context.now() + CALLBACK_TTL_MS,
            })
            await this.#persistFeedbackTargets()
            await this.#removeStream(active.leaseId)
          }
        }
        return { status: 'sent' }
      }
      if (context.mode === 'welcome') {
        const part = request.parts[0]
        if (part?.type !== 'text' || !context.callbackReqId || context.receivedAt === undefined) {
          throw new WeComTransportError('企业微信欢迎语投递上下文无效。', 'invalid', false)
        }
        if (this.#context.now() - context.receivedAt > WELCOME_LIMIT_MS) {
          throw new WeComTransportError('企业微信欢迎语的五秒响应窗口已结束。', 'permanent', false)
        }
        this.#takeSendRate(request.channelId)
        await client.request(
          'aibot_respond_welcome_msg',
          { msgtype: 'text', text: { content: part.text } },
          context.callbackReqId,
        )
        return { status: 'sent' }
      }
      const target = await this.#resolveTarget(request.channelId)
      if (!target) throw new WeComTransportError('企业微信频道目标无效。', 'invalid', false)
      this.#takeSendRate(request.channelId)
      const part = request.parts[0]
      if (!part) throw new WeComTransportError('企业微信投递内容为空。', 'invalid', false)
      let body: WeComObject
      if (part.type === 'text') {
        body = {
          msgtype: 'markdown',
          markdown: { content: part.text, feedback: { id: `nxt-msg:${request.logicalMessageId}` } },
        }
      } else {
        if (part.type !== 'image' && part.type !== 'file' && part.type !== 'audio') {
          throw new WeComTransportError(`企业微信智能机器人不支持主动发送 ${part.type} 内容。`, 'invalid', false)
        }
        if (!context.mediaType) throw new WeComTransportError('企业微信媒体类型无效。', 'invalid', false)
        const asset = await this.#context.assets.read({ assetId: part.assetId, channelId: request.channelId })
        const mediaId = await this.#uploadMedia(context.mediaType, context.filename ?? 'asset', asset.bytes)
        body = { msgtype: context.mediaType, [context.mediaType]: { media_id: mediaId } }
      }
      await client.request('aibot_send_msg', { chat_type: target.chatType, chatid: target.chatId, ...body })
      return { status: 'sent' }
    } catch (error) {
      if (
        context.mode === 'stream-final' &&
        request.processingFeedback &&
        error instanceof WeComTransportError &&
        error.kind === 'unknown'
      ) {
        await this.#removeStream(request.processingFeedback.leaseId)
      }
      return transportReceipt(error)
    }
  }

  async testSend(channelId: ChannelId): Promise<void> {
    const target = await this.#resolveTarget(channelId)
    if (!target) throw new WeComTransportError('企业微信测试频道目标无效。', 'invalid', false)
    this.#takeSendRate(channelId)
    await this.#requireClient().request('aibot_send_msg', {
      chat_type: target.chatType,
      chatid: target.chatId,
      msgtype: 'markdown',
      markdown: { content: 'NekroNXT 企业微信智能机器人连接发送测试。' },
    })
  }

  async #receive(frame: WeComObject): Promise<void> {
    this.#expireCallbacks()
    const cmd = string(frame['cmd'])
    if (cmd !== 'aibot_msg_callback' && cmd !== 'aibot_event_callback') return
    const headers = object(frame['headers'])
    const reqId = string(headers?.['req_id'])
    const body = object(frame['body'])
    if (!reqId || !body) return
    if (string(body['aibotid']) !== this.#config.botId) {
      this.#context.diagnostics.publish({ status: 'connected', message: '收到的事件不属于当前 BotID。' })
      return
    }
    if (cmd === 'aibot_msg_callback') await this.#receiveMessage(body, reqId)
    else await this.#receiveEvent(body, reqId)
  }

  async #receiveMessage(body: WeComObject, reqId: string): Promise<void> {
    const now = this.#context.now()
    const msgId = string(body['msgid'])
    const senderId = string(object(body['from'])?.['userid'])
    const chatType = string(body['chattype'])
    const chatId = string(body['chatid'])
    if (!msgId || !senderId || (chatType !== 'single' && chatType !== 'group') || (chatType === 'group' && !chatId))
      return
    const channelId = await this.#ensureChannel(chatType, senderId, chatId, now)
    const senderMemberId = await this.#context.members.ensure({ channelId, platformUserId: senderId, observedAt: now })
    this.#callbacks.set(msgId, { reqId, channelId, receivedAt: now })
    const decoded = await this.#decodeMessage(body)
    await this.#context.acceptInbound({
      connectionId: this.#context.connectionId,
      channelId,
      adapterKey: WECOM_AI_BOT_ADAPTER_KEY,
      platformEventId: `message:${msgId}`,
      platformMessageId: msgId,
      kind: 'message-created',
      senderMemberId,
      parts: decoded.parts,
      platformTimestamp: timestamp(body['create_time'], now),
      receivedAt: now,
      dedupeKey: `wecom:message:${msgId}`,
      ...(chatType === 'group' ? { facts: { mentionedBot: true } } : {}),
      ...(decoded.assetOccurrences.length === 0 ? {} : { assetOccurrences: decoded.assetOccurrences }),
    })
  }

  async #receiveEvent(body: WeComObject, reqId: string): Promise<void> {
    const event = object(body['event'])
    const eventType = string(event?.['eventtype'])
    if (!eventType) return
    if (eventType === 'disconnected_event') {
      this.#client?.stopForConflict()
      return
    }
    const now = this.#context.now()
    const msgId = string(body['msgid'])
    const senderId = string(object(body['from'])?.['userid'])
    const chatType = string(body['chattype']) ?? 'single'
    const chatId = string(body['chatid'])
    if (!msgId || !senderId || (chatType !== 'single' && chatType !== 'group') || (chatType === 'group' && !chatId))
      return
    const channelId = await this.#ensureChannel(chatType, senderId, chatId, now)
    const senderMemberId = await this.#context.members.ensure({ channelId, platformUserId: senderId, observedAt: now })
    this.#callbacks.set(msgId, { reqId, channelId, receivedAt: now })
    const mapped = await this.#mapEvent(eventType, event!, channelId)
    if (!mapped) return
    await this.#context.acceptInbound({
      connectionId: this.#context.connectionId,
      channelId,
      adapterKey: WECOM_AI_BOT_ADAPTER_KEY,
      platformEventId: `event:${msgId}`,
      platformMessageId: msgId,
      kind: 'control',
      activityType: mapped.activityType,
      senderMemberId,
      parts: mapped.parts,
      platformTimestamp: timestamp(body['create_time'], now),
      receivedAt: now,
      dedupeKey: `wecom:event:${msgId}`,
      ...(mapped.targetLogicalMessageId === undefined ? {} : { targetLogicalMessageId: mapped.targetLogicalMessageId }),
      ...(mapped.facts === undefined ? {} : { facts: mapped.facts }),
    })
  }

  async #mapEvent(
    eventType: string,
    event: WeComObject,
    channelId: ChannelId,
  ): Promise<
    | {
        readonly activityType: ChannelActivityType
        readonly parts: MessagePart[]
        readonly targetLogicalMessageId?: LogicalMessageId
        readonly facts?: Readonly<Record<string, JsonValue>>
      }
    | undefined
  > {
    if (eventType === 'enter_chat') {
      return {
        activityType: 'conversation-entered',
        parts: [this.#rich('conversation-entered', '成员进入了机器人会话。')],
      }
    }
    if (eventType === 'template_card_event') {
      const facts: Record<string, JsonValue> = {}
      const eventKey = string(event['event_key'])
      const taskId = string(event['task_id'])
      if (eventKey) facts['eventKey'] = truncate(eventKey, 128)
      if (taskId) facts['taskId'] = truncate(taskId, 128)
      const selection = event['selected_items'] ?? event['selected_options']
      if (selection !== undefined) facts['selectionSummary'] = truncate(JSON.stringify(selection), 500)
      return {
        activityType: 'card-action-invoked',
        parts: [this.#rich('card-action', eventKey ? `触发了卡片操作：${truncate(eventKey, 80)}` : '触发了卡片操作。')],
        ...(Object.keys(facts).length === 0 ? {} : { facts }),
      }
    }
    if (eventType !== 'feedback_event') return undefined
    const feedback = object(event['feedback_event']) ?? object(event['feedback']) ?? event
    const feedbackType = number(feedback['type'])
    const activityType =
      feedbackType === 1
        ? 'message-feedback-positive'
        : feedbackType === 2
          ? 'message-feedback-negative'
          : feedbackType === 3
            ? 'message-feedback-withdrawn'
            : undefined
    if (!activityType) return undefined
    const feedbackId = string(feedback['id'])
    const targetLogicalMessageId = feedbackId ? await this.#resolveFeedbackTarget(channelId, feedbackId) : undefined
    const content = string(feedback['content'])
    const reason = string(feedback['reason'])
    const facts: Record<string, JsonValue> = { feedbackType: feedbackType! }
    if (reason) facts['reason'] = truncate(reason, 300)
    const inaccurateReasons = feedback['inaccurate_reason_list']
    if (Array.isArray(inaccurateReasons)) {
      facts['inaccurateReasonList'] = inaccurateReasons
        .filter((item): item is number => typeof item === 'number')
        .slice(0, 10)
    }
    return {
      activityType,
      parts: [
        this.#rich(
          'message-feedback',
          content
            ? `成员提交了消息反馈：${truncate(content, 300)}`
            : activityType === 'message-feedback-positive'
              ? '成员提交了正向反馈。'
              : activityType === 'message-feedback-negative'
                ? '成员提交了负向反馈。'
                : '成员撤销了消息反馈。',
        ),
      ],
      ...(targetLogicalMessageId === undefined ? {} : { targetLogicalMessageId }),
      facts,
    }
  }

  async #decodeMessage(body: WeComObject): Promise<{
    readonly parts: MessagePart[]
    readonly assetOccurrences: { readonly partIndex: number; readonly assetId: AssetId }[]
  }> {
    const parts: MessagePart[] = []
    const assetOccurrences: { partIndex: number; assetId: AssetId }[] = []
    const addMedia = async (kind: 'image' | 'file' | 'video', payload: unknown): Promise<void> => {
      const media = object(payload)
      const url = string(media?.['url'])
      const aeskey = string(media?.['aeskey'])
      if (!url || !aeskey) {
        parts.push(this.#rich(kind, `${kind === 'image' ? '图片' : kind === 'video' ? '视频' : '文件'}暂时不可下载。`))
        return
      }
      try {
        const remote = await this.#context.assets.fetchRemoteBytes({ url, maxBytes: MAX_DOWNLOAD_BYTES })
        const bytes = decryptWeComMedia(remote.bytes, aeskey)
        const imported = await this.#context.assets.importBytes({
          bytes,
          ...(remote.declaredMediaType === undefined ? {} : { declaredMediaType: remote.declaredMediaType }),
        })
        const partIndex = parts.length
        parts.push(
          kind === 'image'
            ? { type: 'image', assetId: imported.assetId }
            : { type: 'file', assetId: imported.assetId, ...(remote.filename ? { name: remote.filename } : {}) },
        )
        assetOccurrences.push({ partIndex, assetId: imported.assetId })
      } catch {
        parts.push(
          this.#rich(kind, `${kind === 'image' ? '图片' : kind === 'video' ? '视频' : '文件'}下载或解密失败。`),
        )
      }
    }
    const msgType = string(body['msgtype'])
    if (msgType === 'text') {
      const content = string(object(body['text'])?.['content'])
      if (content) parts.push({ type: 'text', text: content })
    } else if (msgType === 'mixed') {
      const items = object(body['mixed'])?.['msg_item']
      if (Array.isArray(items)) {
        for (const raw of items) {
          const item = object(raw)
          if (item?.['msgtype'] === 'text') {
            const content = string(object(item['text'])?.['content'])
            if (content) parts.push({ type: 'text', text: content })
          } else if (item?.['msgtype'] === 'image') await addMedia('image', item['image'])
        }
      }
    } else if (msgType === 'image') await addMedia('image', body['image'])
    else if (msgType === 'file') await addMedia('file', body['file'])
    else if (msgType === 'video') await addMedia('video', body['video'])
    else if (msgType === 'voice') {
      const transcript = string(object(body['voice'])?.['content'])
      parts.push(
        this.#rich(
          'voice-transcript',
          transcript ? `语音转写：${truncate(transcript, 450)}` : '收到一条语音消息，未提供转写文本。',
        ),
      )
    } else
      parts.push(this.#rich('unknown-message', `收到暂不支持的企业微信消息类型：${truncate(msgType ?? 'unknown', 60)}`))
    const quote = object(body['quote'])
    if (quote) parts.push(this.#rich('quote-summary', this.#quoteSummary(quote)))
    if (parts.length === 0) parts.push(this.#rich('empty-message', '收到一条没有可显示内容的企业微信消息。'))
    return { parts, assetOccurrences }
  }

  async #startFeedback(input: {
    readonly leaseId: string
    readonly channelId: ChannelId
    readonly platformMessageId: string
  }): Promise<AdapterInteractionOutcome> {
    const callback = this.#callbacks.get(input.platformMessageId)
    if (!callback || callback.channelId !== input.channelId) {
      return { status: 'failed', message: '企业微信消息回调窗口不可用。' }
    }
    const stream: ActiveStream = {
      leaseId: input.leaseId,
      platformMessageId: input.platformMessageId,
      reqId: callback.reqId,
      streamId: `nxt-${randomUUID()}`,
      startedAt: this.#context.now(),
      channelId: input.channelId,
    }
    try {
      this.#takeSendRate(input.channelId)
    } catch (error) {
      return interactionOutcome(error)
    }
    this.#streams.set(stream.leaseId, stream)
    await this.#persistStreams()
    try {
      await this.#requireClient().request(
        'aibot_respond_msg',
        {
          msgtype: 'stream',
          stream: {
            id: stream.streamId,
            content: '正在处理…',
            finish: false,
            feedback: { id: `nxt-lease:${stream.leaseId}` },
          },
        },
        stream.reqId,
      )
      this.#scheduleStream(stream)
      return { status: 'succeeded' }
    } catch (error) {
      await this.#removeStream(stream.leaseId)
      return interactionOutcome(error)
    }
  }

  async #finishFeedback(
    leaseId: string,
    reason: 'idle' | 'error' | 'cancelled' | 'timeout' | 'shutdown' | 'recovery' | 'continued',
  ): Promise<AdapterInteractionOutcome> {
    const stream = this.#streams.get(leaseId)
    if (!stream) return { status: 'succeeded' }
    if (this.#context.now() - stream.startedAt >= STREAM_LIMIT_MS) {
      await this.#removeStream(leaseId)
      return { status: 'succeeded' }
    }
    const content =
      reason === 'idle' ? '处理已结束。' : reason === 'continued' ? '处理仍在继续，结果将另行发送。' : '处理未完成。'
    try {
      this.#takeSendRate(stream.channelId)
      await this.#requireClient().request(
        'aibot_respond_msg',
        { msgtype: 'stream', stream: { id: stream.streamId, content, finish: true } },
        stream.reqId,
      )
      await this.#removeStream(leaseId)
      return { status: 'succeeded' }
    } catch (error) {
      if (error instanceof WeComTransportError && error.kind === 'unknown') {
        await this.#removeStream(leaseId)
      }
      return interactionOutcome(error)
    }
  }

  async #resolveFeedbackTarget(channelId: ChannelId, feedbackId: string): Promise<LogicalMessageId | undefined> {
    const direct = feedbackId.startsWith('nxt-msg:') ? feedbackId.slice('nxt-msg:'.length) : undefined
    const fromLease = feedbackId.startsWith('nxt-lease:')
      ? this.#feedbackTargets.get(feedbackId.slice('nxt-lease:'.length))?.logicalMessageId
      : undefined
    const candidate = direct ?? fromLease
    const parsed = LogicalMessageIdSchema.safeParse(candidate)
    if (!parsed.success) return undefined
    return (await this.#context.messages.resolveLogicalMessage(channelId, parsed.data)) ? parsed.data : undefined
  }

  async #uploadMedia(type: MediaType, filename: string, bytes: Uint8Array): Promise<string> {
    this.#validateMedia(type, filename, bytes)
    if (!this.#uploadLimiter.take('bot', this.#context.now(), 30, 1_000)) {
      throw new WeComTransportError('企业微信媒体上传频率已达到本地限制。', 'rate-limited', false)
    }
    const totalChunks = Math.ceil(bytes.byteLength / CHUNK_BYTES)
    if (totalChunks < 1 || totalChunks > 100)
      throw new WeComTransportError('企业微信媒体分片数量无效。', 'invalid', false)
    const client = this.#requireClient()
    const init = object(
      (
        await client.request('aibot_upload_media_init', {
          type,
          filename: truncate(filename, 240),
          total_size: bytes.byteLength,
          total_chunks: totalChunks,
          md5: createHash('md5').update(bytes).digest('hex'),
        })
      )['body'],
    )
    const uploadId = string(init?.['upload_id'])
    if (!uploadId) throw new WeComTransportError('企业微信媒体上传初始化缺少 upload_id。', 'unknown', true)
    for (let index = 0; index < totalChunks; index += 1) {
      const chunk = bytes.slice(index * CHUNK_BYTES, Math.min(bytes.byteLength, (index + 1) * CHUNK_BYTES))
      let lastError: unknown
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await client.request('aibot_upload_media_chunk', {
            upload_id: uploadId,
            chunk_index: index,
            base64_data: Buffer.from(chunk).toString('base64'),
          })
          lastError = undefined
          break
        } catch (error) {
          lastError = error
          if (error instanceof WeComTransportError && error.kind === 'authentication') break
        }
      }
      if (lastError) {
        throw lastError instanceof Error
          ? lastError
          : new Error(typeof lastError === 'string' ? lastError : '企业微信媒体分片上传失败。')
      }
    }
    const finished = object((await client.request('aibot_upload_media_finish', { upload_id: uploadId }))['body'])
    const mediaId = string(finished?.['media_id'])
    if (!mediaId) throw new WeComTransportError('企业微信媒体上传完成回执缺少 media_id。', 'unknown', true)
    return mediaId
  }

  #classifyMedia(part: Exclude<MessagePart, { type: 'text' | 'mention' | 'quote' | 'rich' }>, mediaType: string) {
    if (part.type === 'image') {
      if (mediaType !== 'image/png' && mediaType !== 'image/jpeg' && mediaType !== 'image/gif') {
        throw new WeComTransportError('企业微信图片仅支持 PNG、JPEG 和 GIF。', 'invalid', false)
      }
      return {
        type: 'image' as const,
        filename: mediaType === 'image/gif' ? 'image.gif' : mediaType === 'image/png' ? 'image.png' : 'image.jpg',
      }
    }
    if (part.type === 'audio') {
      if (mediaType !== 'audio/amr') throw new WeComTransportError('企业微信语音仅支持 AMR。', 'invalid', false)
      return { type: 'voice' as const, filename: 'voice.amr' }
    }
    if (mediaType === 'video/mp4') return { type: 'video' as const, filename: part.name ?? 'video.mp4' }
    return { type: 'file' as const, filename: part.name ?? 'file' }
  }

  #validateMedia(type: MediaType, filename: string, bytes: Uint8Array): void {
    const limit = type === 'voice' ? 2 * 1024 * 1024 : type === 'file' ? 20 * 1024 * 1024 : 10 * 1024 * 1024
    if (bytes.byteLength === 0 || bytes.byteLength > limit)
      throw new WeComTransportError('企业微信媒体大小超过对应类型限制。', 'invalid', false)
    const lower = filename.toLowerCase()
    if (type === 'image' && !/\.(?:png|jpe?g|gif)$/u.test(lower))
      throw new WeComTransportError('企业微信图片仅支持 PNG、JPEG 和 GIF。', 'invalid', false)
    if (type === 'voice' && !lower.endsWith('.amr'))
      throw new WeComTransportError('企业微信语音仅支持 AMR。', 'invalid', false)
    if (type === 'video' && !lower.endsWith('.mp4'))
      throw new WeComTransportError('企业微信视频仅支持 MP4。', 'invalid', false)
  }

  #takeSendRate(channelId: ChannelId): void {
    if (!this.#sendLimiter.take(channelId, this.#context.now(), 30, 1_000)) {
      throw new WeComTransportError('企业微信会话发送频率已达到本地限制。', 'rate-limited', false)
    }
  }

  async #resolveTarget(
    channelId: ChannelId,
  ): Promise<{ readonly chatType: 1 | 2; readonly chatId: string } | undefined> {
    const platform = await this.#context.channels.resolvePlatformChannelId(channelId)
    if (platform?.startsWith('single:')) return { chatType: 1, chatId: platform.slice('single:'.length) }
    if (platform?.startsWith('group:')) return { chatType: 2, chatId: platform.slice('group:'.length) }
    return undefined
  }

  #ensureChannel(
    chatType: string,
    senderId: string,
    chatId: string | undefined,
    observedAt: number,
  ): Promise<ChannelId> {
    return this.#context.channels.ensure({
      platformChannelId: chatType === 'group' ? `group:${chatId!}` : `single:${senderId}`,
      kind: chatType === 'group' ? 'group' : 'direct',
      observedAt,
    })
  }

  #quoteSummary(quote: WeComObject): string {
    const type = string(quote['msgtype']) ?? 'unknown'
    if (type === 'text') {
      const content = string(object(quote['text'])?.['content'])
      return content ? `引用文本：${truncate(content, 420)}` : '引用了一条文本消息。'
    }
    return `引用了一条${type === 'image' ? '图片' : type === 'voice' ? '语音' : type === 'file' ? '文件' : type === 'mixed' ? '图文混排' : '消息'}。`
  }

  #rich(kind: string, summary: string): Extract<MessagePart, { type: 'rich' }> {
    return { type: 'rich', adapterKey: WECOM_AI_BOT_ADAPTER_KEY, kind, summary: truncate(summary, 500) }
  }

  #requireClient(): WeComWebSocketClient {
    if (!this.#client) throw new WeComTransportError('企业微信智能机器人 Runtime 尚未启动。', 'transient', false)
    return this.#client
  }

  #expireCallbacks(): void {
    const cutoff = this.#context.now() - CALLBACK_TTL_MS
    for (const [msgId, callback] of this.#callbacks) if (callback.receivedAt < cutoff) this.#callbacks.delete(msgId)
    for (const [leaseId, target] of this.#feedbackTargets) {
      if (target.expiresAt <= this.#context.now()) this.#feedbackTargets.delete(leaseId)
    }
  }

  #scheduleStream(stream: ActiveStream): void {
    const previous = this.#streamTimers.get(stream.leaseId)
    if (previous) clearTimeout(previous)
    const delay = Math.max(0, stream.startedAt + STREAM_SETTLE_MS - this.#context.now())
    const timer = setTimeout(() => {
      this.#streamTimers.delete(stream.leaseId)
      void this.#finishFeedback(stream.leaseId, 'continued')
    }, delay)
    this.#streamTimers.set(stream.leaseId, timer)
  }

  #scheduleRecovery(): void {
    for (const stream of this.#streams.values()) {
      if (this.#context.now() - stream.startedAt >= STREAM_LIMIT_MS) {
        void this.#removeStream(stream.leaseId)
        continue
      }
      const attempt = (): void => {
        if (!this.#started || !this.#streams.has(stream.leaseId)) return
        if (!this.#client?.connected) {
          const timer = setTimeout(attempt, 1_000)
          this.#streamTimers.set(stream.leaseId, timer)
          return
        }
        void this.#finishFeedback(stream.leaseId, 'recovery')
      }
      attempt()
    }
  }

  async #restoreStreams(): Promise<void> {
    const raw = await this.#context.state.load(STREAM_STATE_KEY)
    if (!Array.isArray(raw)) return
    for (const item of raw) {
      const row = object(item)
      const leaseId = string(row?.['leaseId'])
      const platformMessageId = string(row?.['platformMessageId'])
      const reqId = string(row?.['reqId'])
      const streamId = string(row?.['streamId'])
      const startedAt = number(row?.['startedAt'])
      const channelId = ChannelIdSchema.safeParse(row?.['channelId'])
      if (!leaseId || !platformMessageId || !reqId || !streamId || startedAt === undefined || !channelId.success)
        continue
      this.#streams.set(leaseId, {
        leaseId,
        platformMessageId,
        reqId,
        streamId,
        startedAt,
        channelId: channelId.data,
        ...(LogicalMessageIdSchema.safeParse(row?.['logicalMessageId']).success
          ? { logicalMessageId: LogicalMessageIdSchema.parse(row?.['logicalMessageId']) }
          : {}),
      })
    }
  }

  async #restoreFeedbackTargets(): Promise<void> {
    const raw = await this.#context.state.load(FEEDBACK_TARGET_STATE_KEY)
    if (!Array.isArray(raw)) return
    for (const item of raw) {
      const row = object(item)
      const leaseId = string(row?.['leaseId'])
      const channelId = ChannelIdSchema.safeParse(row?.['channelId'])
      const logicalMessageId = LogicalMessageIdSchema.safeParse(row?.['logicalMessageId'])
      const expiresAt = number(row?.['expiresAt'])
      if (
        !leaseId ||
        !channelId.success ||
        !logicalMessageId.success ||
        expiresAt === undefined ||
        expiresAt <= this.#context.now()
      )
        continue
      this.#feedbackTargets.set(leaseId, {
        channelId: channelId.data,
        logicalMessageId: logicalMessageId.data,
        expiresAt,
      })
    }
  }

  #persistFeedbackTargets(): Promise<void> {
    const rows: JsonValue = [...this.#feedbackTargets].map(([leaseId, target]) => ({
      leaseId,
      channelId: target.channelId,
      logicalMessageId: target.logicalMessageId,
      expiresAt: target.expiresAt,
    }))
    this.#persistQueue = this.#persistQueue.then(() =>
      rows.length === 0
        ? this.#context.state.clear(FEEDBACK_TARGET_STATE_KEY)
        : this.#context.state.save(FEEDBACK_TARGET_STATE_KEY, rows),
    )
    return this.#persistQueue
  }

  #persistStreams(): Promise<void> {
    const rows: JsonValue = [...this.#streams.values()].map((stream) => ({
      leaseId: stream.leaseId,
      platformMessageId: stream.platformMessageId,
      reqId: stream.reqId,
      streamId: stream.streamId,
      startedAt: stream.startedAt,
      channelId: stream.channelId,
      ...(stream.logicalMessageId === undefined ? {} : { logicalMessageId: stream.logicalMessageId }),
    }))
    this.#persistQueue = this.#persistQueue.then(() =>
      rows.length === 0
        ? this.#context.state.clear(STREAM_STATE_KEY)
        : this.#context.state.save(STREAM_STATE_KEY, rows),
    )
    return this.#persistQueue
  }

  async #removeStream(leaseId: string): Promise<void> {
    const timer = this.#streamTimers.get(leaseId)
    if (timer) clearTimeout(timer)
    this.#streamTimers.delete(leaseId)
    this.#streams.delete(leaseId)
    await this.#persistStreams()
  }
}
