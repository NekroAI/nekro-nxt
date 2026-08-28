import type {
  AdapterConnectionHostContext,
  AdapterConnectionInteractions,
  AdapterConnectionRuntime,
  AdapterDeliveryReceipt,
  AdapterInteractionOutcome,
  PhysicalDeliveryRequest,
} from '@nekro-nxt/adapter-sdk'
import type { AssetId, ChannelId, ChannelMemberId, JsonValue, MessagePart } from '@nekro-nxt/contracts'
import { LogicalMessageIdSchema } from '@nekro-nxt/contracts'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { ONEBOT_11_ADAPTER_KEY, ONEBOT_11_CAPABILITIES, type OneBot11RuntimeConfig } from './definition.js'
import {
  OneBotActionError,
  OneBotWebSocketClient,
  oneBotObject,
  oneBotStringId,
  type OneBotObject,
} from './transport.js'

const MAX_ASSET_BYTES = 20 * 1024 * 1024
const FEEDBACK_EMOJI_ID = '212'
const FORWARD_NODE_LIMIT = 50
const FORWARD_JSON_LIMIT = 64 * 1024

export interface OneBot11RuntimeOptions {
  readonly context: AdapterConnectionHostContext
  readonly config: OneBot11RuntimeConfig
  readonly transport?: {
    readonly requestTimeoutMs?: number
    readonly reconnectDelaysMs?: readonly number[]
  }
}

type Segment = { readonly type: string; readonly data: OneBotObject }

const textValue = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const numberValue = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value)
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value)
      : undefined

const timestampMs = (value: unknown, fallback: number): number => {
  const numeric = numberValue(value)
  if (numeric === undefined || !Number.isFinite(numeric) || numeric < 0) return fallback
  return numeric < 10_000_000_000 ? Math.trunc(numeric * 1000) : Math.trunc(numeric)
}

const compactNoticeText = (value: unknown, maxLength = 120): string | undefined => {
  const text = textValue(value)?.trim()
  return text ? text.slice(0, maxLength) : undefined
}

const durationLabel = (seconds: number | undefined): string | undefined => {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return undefined
  if (seconds % 86_400 === 0) return `${seconds / 86_400} 天`
  if (seconds % 3_600 === 0) return `${seconds / 3_600} 小时`
  if (seconds % 60 === 0) return `${seconds / 60} 分钟`
  return `${Math.trunc(seconds)} 秒`
}

const byteSizeLabel = (bytes: number | undefined): string | undefined => {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return undefined
  if (bytes < 1024) return `${Math.trunc(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MiB`
}

const segment = (input: unknown): Segment | undefined => {
  const object = oneBotObject(input)
  const type = textValue(object?.['type'])
  const data = oneBotObject(object?.['data'])
  return type && data ? { type, data } : undefined
}

const stableJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(',')}}`
}

const eventDigest = (event: OneBotObject): string => createHash('sha256').update(stableJson(event)).digest('hex')

const targetFromPlatformChannel = (
  platformChannelId: string,
): { readonly kind: 'group' | 'private'; readonly id: string } | undefined => {
  const separator = platformChannelId.indexOf(':')
  if (separator < 1) return undefined
  const kind = platformChannelId.slice(0, separator)
  const id = platformChannelId.slice(separator + 1)
  return (kind === 'group' || kind === 'private') && id ? { kind, id } : undefined
}

const actionOutcome = (error: unknown): AdapterInteractionOutcome => {
  if (error instanceof OneBotActionError) {
    if (error.kind === 'unsupported') return { status: 'unsupported', message: error.message }
    if (error.kind === 'unknown') return { status: 'unknown', message: error.message }
    return { status: 'failed', message: error.message }
  }
  return { status: 'failed', message: error instanceof Error ? error.message : String(error) }
}

/** Protocol-endpoint-neutral OneBot 11 mapping and optional interaction layer. */
export class OneBot11Runtime implements AdapterConnectionRuntime {
  readonly capabilities = ONEBOT_11_CAPABILITIES
  readonly interactions: AdapterConnectionInteractions
  readonly #context: AdapterConnectionHostContext
  readonly #config: OneBot11RuntimeConfig
  readonly #transportOptions: NonNullable<OneBot11RuntimeOptions['transport']>
  readonly #feedbackEchoes = new Map<string, number>()
  readonly #recallEchoes = new Map<string, number>()
  #client: OneBotWebSocketClient | undefined
  #started = false

  constructor(options: OneBot11RuntimeOptions) {
    this.#context = options.context
    this.#config = options.config
    this.#transportOptions = options.transport ?? {}
    this.interactions = {
      startProcessingFeedback: (input) => this.#setProcessingFeedback(input.channelId, input.platformMessageId, true),
      finishProcessingFeedback: (input) => this.#setProcessingFeedback(input.channelId, input.platformMessageId, false),
      retractOwnMessage: async (input) => {
        this.#recallEchoes.set(input.platformMessageId, this.#context.now() + 15_000)
        try {
          await this.#requireClient().call('delete_msg', { message_id: input.platformMessageId })
          return { status: 'succeeded' }
        } catch (error) {
          this.#recallEchoes.delete(input.platformMessageId)
          return actionOutcome(error)
        }
      },
      nudgeMember: async (input) => {
        try {
          const platformUserId = await this.#context.members.resolvePlatformUserId(input.channelId, input.memberId)
          if (!platformUserId) return { status: 'failed', message: '当前频道找不到该成员的平台身份。' }
          const target = await this.#resolveTarget(input.channelId)
          if (!target) return { status: 'failed', message: '当前频道不是有效的 OneBot 频道。' }
          await this.#requireClient().callOptional('send_poke', {
            user_id: platformUserId,
            ...(target.kind === 'group' ? { group_id: target.id } : {}),
          })
          return { status: 'succeeded' }
        } catch (error) {
          return actionOutcome(error)
        }
      },
    }
  }

  async start(): Promise<void> {
    if (this.#started) throw new Error('OneBot Runtime is already started.')
    this.#started = true
    const accessToken =
      this.#config.accessTokenCredentialRef === undefined
        ? undefined
        : await this.#context.credentials.resolve(this.#config.accessTokenCredentialRef)
    const client = new OneBotWebSocketClient({
      context: this.#context,
      endpoint: this.#config.endpoint,
      ...(accessToken === undefined ? {} : { accessToken }),
      onEvent: (event) => this.#receive(event),
      ...this.#transportOptions,
    })
    this.#client = client
    await client.start()
  }

  async stop(): Promise<void> {
    this.#started = false
    const client = this.#client
    this.#client = undefined
    await client?.stop()
  }

  async deliver(request: PhysicalDeliveryRequest, signal: AbortSignal): Promise<AdapterDeliveryReceipt> {
    if (signal.aborted) {
      return { status: 'failed', failure: { kind: 'transient', message: '发送在写入 OneBot 前已取消。' } }
    }
    try {
      const target = await this.#resolveTarget(request.channelId)
      if (!target) return { status: 'failed', failure: { kind: 'invalid', message: 'OneBot 频道目标无效。' } }
      const segments = await this.#outboundSegments(request)
      const action = target.kind === 'group' ? 'send_group_msg' : 'send_private_msg'
      const privateSource = target.kind === 'private' ? await this.#privateSourceGroup(request.channelId) : undefined
      const data = oneBotObject(
        await this.#requireClient().call(action, {
          ...(target.kind === 'group'
            ? { group_id: target.id }
            : { user_id: target.id, ...(privateSource === undefined ? {} : { group_id: privateSource }) }),
          message: segments,
        }),
      )
      const platformMessageId = oneBotStringId(data?.['message_id'])
      if (!platformMessageId) {
        return { status: 'unknown', message: 'OneBot 发送成功回执缺少 message_id，无法确认物理消息。' }
      }
      return { status: 'sent', platformMessageId }
    } catch (error) {
      if (error instanceof OneBotActionError) {
        if (error.kind === 'unknown' || (error.submitted && signal.aborted)) {
          return { status: 'unknown', message: error.message }
        }
        const kind = error.kind === 'unsupported' ? 'permanent' : error.kind
        return { status: 'failed', failure: { kind, message: error.message } }
      }
      return {
        status: 'failed',
        failure: { kind: 'transient', message: error instanceof Error ? error.message : String(error) },
      }
    }
  }

  async testSend(channelId: ChannelId): Promise<string> {
    const target = await this.#resolveTarget(channelId)
    if (!target) throw new OneBotActionError('OneBot 测试频道目标无效。', 'invalid', false)
    const privateSource = target.kind === 'private' ? await this.#privateSourceGroup(channelId) : undefined
    const data = oneBotObject(
      await this.#requireClient().call(target.kind === 'group' ? 'send_group_msg' : 'send_private_msg', {
        ...(target.kind === 'group'
          ? { group_id: target.id }
          : { user_id: target.id, ...(privateSource === undefined ? {} : { group_id: privateSource }) }),
        message: [{ type: 'text', data: { text: 'NekroNXT OneBot 11 连接发送测试。' } }],
      }),
    )
    const messageId = oneBotStringId(data?.['message_id'])
    if (!messageId) throw new OneBotActionError('OneBot 测试回执缺少 message_id。', 'unknown', true)
    return messageId
  }

  async #outboundSegments(request: PhysicalDeliveryRequest): Promise<OneBotObject[]> {
    const output: OneBotObject[] = []
    if (request.replyTo !== undefined) {
      const platformMessageId = await this.#context.messages.resolvePlatformMessageId(
        request.channelId,
        LogicalMessageIdSchema.parse(request.replyTo),
      )
      if (!platformMessageId) throw new OneBotActionError('引用消息无法映射到当前平台。', 'invalid', false)
      output.push({ type: 'reply', data: { id: platformMessageId } })
    }
    for (const part of request.parts) {
      switch (part.type) {
        case 'text':
          output.push({ type: 'text', data: { text: part.text } })
          break
        case 'mention': {
          const platformUserId = await this.#context.members.resolvePlatformUserId(request.channelId, part.memberId)
          if (!platformUserId) throw new OneBotActionError('Mention 成员无法映射到当前平台。', 'invalid', false)
          output.push({ type: 'at', data: { qq: platformUserId } })
          break
        }
        case 'quote': {
          const platformMessageId = await this.#context.messages.resolvePlatformMessageId(
            request.channelId,
            part.messageId,
          )
          if (!platformMessageId) throw new OneBotActionError('引用消息无法映射到当前平台。', 'invalid', false)
          output.push({ type: 'reply', data: { id: platformMessageId } })
          break
        }
        case 'image':
        case 'audio': {
          const asset = await this.#context.assets.read({ assetId: part.assetId, channelId: request.channelId })
          if (asset.byteSize > MAX_ASSET_BYTES)
            throw new OneBotActionError('Asset 超过 OneBot 发送上限。', 'invalid', false)
          output.push({
            type: part.type === 'image' ? 'image' : 'record',
            data: { file: `base64://${Buffer.from(asset.bytes).toString('base64')}` },
          })
          break
        }
        case 'file':
        case 'rich':
          throw new OneBotActionError(`OneBot 首版不主动发送 ${part.type} 内容。`, 'invalid', false)
      }
    }
    return output
  }

  async #receive(event: OneBotObject): Promise<void> {
    this.#expireFeedbackEchoes()
    const postType = textValue(event['post_type'])
    if (postType === 'message' || postType === 'message_sent') {
      if (postType === 'message_sent') return
      await this.#receiveMessage(event)
      return
    }
    if (postType === 'notice') {
      if (textValue(event['notice_type']) === 'bot_offline') {
        this.#requireClient().reportWarning('协议端报告当前账号已离线。', {
          lastPlatformStatusAt: this.#context.now(),
          platformStatus: 'offline',
        })
        return
      }
      if (textValue(event['notice_type']) === 'input_status') return
      await this.#receiveNotice(event)
      return
    }
    if (postType === 'meta_event') {
      this.#requireClient().reportDetails({
        lastMetaEventAt: this.#context.now(),
        metaEventType: textValue(event['meta_event_type']) ?? 'unknown',
        ...(textValue(event['sub_type']) === undefined ? {} : { metaEventSubtype: textValue(event['sub_type'])! }),
      })
      return
    }
    if (postType === 'request') {
      this.#requireClient().reportDetails({
        lastPendingRequestAt: this.#context.now(),
        pendingRequestType: textValue(event['request_type']) ?? 'unknown',
      })
    }
  }

  async #receiveMessage(event: OneBotObject): Promise<void> {
    const now = this.#context.now()
    const messageType = textValue(event['message_type'])
    const groupId = oneBotStringId(event['group_id'])
    const userId = oneBotStringId(event['user_id']) ?? oneBotStringId(oneBotObject(event['sender'])?.['user_id'])
    const platformMessageId = oneBotStringId(event['message_id'])
    if (!userId || !platformMessageId || (messageType !== 'group' && messageType !== 'private')) return
    const platformChannelId = messageType === 'group' && groupId ? `group:${groupId}` : `private:${userId}`
    const channelId = await this.#context.channels.ensure({
      platformChannelId,
      kind: messageType === 'group' ? 'group' : 'direct',
      ...(messageType === 'group' && textValue(event['group_name'])
        ? { displayName: textValue(event['group_name'])! }
        : {}),
      observedAt: now,
    })
    if (messageType === 'private' && groupId) await this.#context.state.save(`private-source/${channelId}`, { groupId })
    const sender = oneBotObject(event['sender'])
    const displayName = textValue(sender?.['card']) || textValue(sender?.['nickname'])
    const senderMemberId = await this.#context.members.ensure({
      channelId,
      platformUserId: userId,
      ...(displayName ? { displayName } : {}),
      observedAt: now,
    })
    const decoded = await this.#decodeMessage(event['message'], channelId)
    const mentionedBot = decoded.mentionedPlatformIds.includes(this.#requireClient().accountId ?? '')
    await this.#context.acceptInbound({
      connectionId: this.#context.connectionId,
      channelId,
      adapterKey: ONEBOT_11_ADAPTER_KEY,
      platformEventId: `message:${platformMessageId}`,
      platformMessageId,
      kind: 'message-created',
      senderMemberId,
      parts: decoded.parts,
      platformTimestamp: timestampMs(event['time'], now),
      receivedAt: now,
      dedupeKey: `onebot:${eventDigest(event)}`,
      ...(mentionedBot ? { facts: { mentionedBot: true } } : {}),
      ...(decoded.assetOccurrences.length === 0 ? {} : { assetOccurrences: decoded.assetOccurrences }),
    })
  }

  async #decodeMessage(
    message: unknown,
    channelId: ChannelId,
  ): Promise<{
    readonly parts: MessagePart[]
    readonly assetOccurrences: { readonly partIndex: number; readonly assetId: AssetId }[]
    readonly mentionedPlatformIds: string[]
  }> {
    if (!Array.isArray(message)) {
      this.#requireClient().reportWarning('协议端返回了字符串消息；请将 OneBot 消息格式配置为数组。', {
        messageFormat: 'string',
      })
      return {
        parts: [
          {
            type: 'rich',
            adapterKey: ONEBOT_11_ADAPTER_KEY,
            kind: 'invalid-message-format',
            summary: '这条消息由协议端以字符串格式上报，无法安全解析；请启用数组消息格式。',
          },
        ],
        assetOccurrences: [],
        mentionedPlatformIds: [],
      }
    }
    const parts: MessagePart[] = []
    const assetOccurrences: { partIndex: number; assetId: AssetId }[] = []
    const mentionedPlatformIds: string[] = []
    for (const raw of message) {
      const item = segment(raw)
      if (!item) continue
      if (item.type === 'text') {
        const text = textValue(item.data['text'])
        if (text) parts.push({ type: 'text', text })
        continue
      }
      if (item.type === 'at') {
        const platformUserId = oneBotStringId(item.data['qq'])
        if (!platformUserId) continue
        if (platformUserId === 'all') {
          parts.push({ type: 'rich', adapterKey: ONEBOT_11_ADAPTER_KEY, kind: 'mention-all', summary: '提及全体成员' })
          continue
        }
        mentionedPlatformIds.push(platformUserId)
        const memberId = await this.#context.members.ensure({
          channelId,
          platformUserId,
          observedAt: this.#context.now(),
        })
        parts.push({ type: 'mention', memberId })
        continue
      }
      if (item.type === 'reply') {
        const targetPlatformMessageId = oneBotStringId(item.data['id'])
        const resolved =
          targetPlatformMessageId === undefined
            ? undefined
            : await this.#context.messages.resolvePlatformMessage(channelId, targetPlatformMessageId)
        if (resolved) parts.push({ type: 'quote', messageId: resolved.logicalMessageId })
        else
          parts.push({
            type: 'rich',
            adapterKey: ONEBOT_11_ADAPTER_KEY,
            kind: 'unresolved-reply',
            summary: '引用了一条当前频道中尚未解析的消息。',
          })
        continue
      }
      if (item.type === 'image' || item.type === 'record') {
        const url = textValue(item.data['url'])
        if (!url) {
          parts.push({
            type: 'rich',
            adapterKey: ONEBOT_11_ADAPTER_KEY,
            kind: item.type,
            summary: item.type === 'image' ? '图片暂时不可下载。' : '语音暂时不可下载。',
          })
          continue
        }
        try {
          const asset = await this.#downloadAsset(url)
          const partIndex = parts.length
          parts.push(
            item.type === 'image'
              ? { type: 'image', assetId: asset.assetId }
              : { type: 'audio', assetId: asset.assetId },
          )
          assetOccurrences.push({ partIndex, assetId: asset.assetId })
        } catch {
          parts.push({
            type: 'rich',
            adapterKey: ONEBOT_11_ADAPTER_KEY,
            kind: item.type,
            summary: item.type === 'image' ? '图片下载失败。' : '语音下载失败。',
          })
        }
        continue
      }
      if (item.type === 'forward') {
        parts.push(await this.#forwardPart(item.data))
        continue
      }
      if (['json', 'xml', 'markdown', 'keyboard', 'mface', 'file'].includes(item.type)) {
        parts.push({
          type: 'rich',
          adapterKey: ONEBOT_11_ADAPTER_KEY,
          kind: item.type,
          summary: this.#richSummary(item.type, item.data),
        })
        continue
      }
      parts.push({
        type: 'rich',
        adapterKey: ONEBOT_11_ADAPTER_KEY,
        kind: `segment-${item.type}`.slice(0, 64),
        summary: `收到暂不支持的 ${item.type} 消息段。`,
      })
    }
    if (parts.length === 0)
      parts.push({
        type: 'rich',
        adapterKey: ONEBOT_11_ADAPTER_KEY,
        kind: 'empty-message',
        summary: '收到一条没有可显示内容的消息。',
      })
    return { parts, assetOccurrences, mentionedPlatformIds }
  }

  async #forwardPart(data: OneBotObject): Promise<Extract<MessagePart, { type: 'rich' }>> {
    const id = oneBotStringId(data['id'])
    if (!id)
      return { type: 'rich', adapterKey: ONEBOT_11_ADAPTER_KEY, kind: 'forward', summary: '收到一条合并转发消息。' }
    try {
      const budget = { remaining: FORWARD_NODE_LIMIT, truncated: false }
      const items = await this.#forwardItems(id, 0, budget)
      const extension = { items, truncated: budget.truncated }
      if (Buffer.byteLength(JSON.stringify(extension), 'utf8') > FORWARD_JSON_LIMIT) {
        return {
          type: 'rich',
          adapterKey: ONEBOT_11_ADAPTER_KEY,
          kind: 'forward',
          summary: `合并转发消息（${FORWARD_NODE_LIMIT - budget.remaining} 个节点，内容过大，仅保留摘要）。`,
        }
      }
      return {
        type: 'rich',
        adapterKey: ONEBOT_11_ADAPTER_KEY,
        kind: 'forward',
        summary: `合并转发消息（${FORWARD_NODE_LIMIT - budget.remaining} 个节点）。`,
        extension: extension as JsonValue,
      }
    } catch {
      return { type: 'rich', adapterKey: ONEBOT_11_ADAPTER_KEY, kind: 'forward', summary: '合并转发消息暂时无法展开。' }
    }
  }

  async #forwardItems(
    id: string,
    depth: number,
    budget: { remaining: number; truncated: boolean },
  ): Promise<JsonValue[]> {
    const response = oneBotObject(await this.#requireClient().call('get_forward_msg', { id }))
    const messages = Array.isArray(response?.['messages']) ? response['messages'] : []
    const items: JsonValue[] = []
    for (const node of messages) {
      if (budget.remaining <= 0) {
        budget.truncated = true
        break
      }
      budget.remaining -= 1
      const object = oneBotObject(node)
      const segments = Array.isArray(object?.['content'])
        ? object['content'].map(segment).filter((item): item is Segment => item !== undefined)
        : []
      const text = segments
        .filter((item) => item.type === 'text')
        .map((item) => textValue(item.data['text']) ?? '')
        .join('')
        .slice(0, 500)
      const nestedIds = segments.flatMap((item) =>
        item.type === 'forward' && oneBotStringId(item.data['id']) ? [oneBotStringId(item.data['id'])!] : [],
      )
      const nested: JsonValue[] = []
      if (nestedIds.length > 0) {
        if (depth >= 2) budget.truncated = true
        else {
          for (const nestedId of nestedIds) nested.push(...(await this.#forwardItems(nestedId, depth + 1, budget)))
        }
      }
      items.push({
        text: text || (nested.length > 0 ? '嵌套合并转发' : '非文本转发节点'),
        ...(nested.length === 0 ? {} : { items: nested }),
      })
    }
    return items
  }

  #richSummary(type: string, data: OneBotObject): string {
    const raw = textValue(data['data']) ?? textValue(data['content']) ?? textValue(data['text'])
    if (type === 'file') return `文件：${textValue(data['name']) ?? '未命名文件'}`
    if (raw) {
      try {
        const parsed = z.json().parse(JSON.parse(raw))
        const object = oneBotObject(parsed)
        const title = textValue(object?.['prompt']) ?? textValue(object?.['title'])
        if (title) return `${type.toUpperCase()} 卡片：${title.slice(0, 300)}`
      } catch {
        // Untrusted card payload is summarized, never persisted verbatim.
      }
    }
    return `收到一条 ${type.toUpperCase()} 富消息。`
  }

  async #receiveNotice(event: OneBotObject): Promise<void> {
    const now = this.#context.now()
    const noticeType = textValue(event['notice_type'])
    const subType = textValue(event['sub_type'])
    const groupId = oneBotStringId(event['group_id'])
    const userId = oneBotStringId(event['user_id']) ?? oneBotStringId(event['target_id'])
    const operatorId = oneBotStringId(event['operator_id'])
    const senderId = oneBotStringId(event['sender_id'])
    const targetId = oneBotStringId(event['target_id'])
    const messageId = oneBotStringId(event['message_id'])
    let activityType: Parameters<AdapterConnectionHostContext['acceptInbound']>[0]['activityType']
    let kind: Parameters<AdapterConnectionHostContext['acceptInbound']>[0]['kind'] = 'control'
    let reactionEmoji: string | undefined
    let reactionAdded = true

    if (noticeType === 'group_recall' || noticeType === 'friend_recall') {
      if (messageId && this.#isRecallEcho(messageId, userId, operatorId)) return
      activityType = 'message-recalled'
      kind = 'message-deleted'
    } else if (noticeType === 'group_msg_emoji_like') {
      const likes = Array.isArray(event['likes']) ? oneBotObject(event['likes'][0]) : undefined
      reactionEmoji =
        oneBotStringId(event['emoji_id']) ?? oneBotStringId(event['emoji_type']) ?? oneBotStringId(likes?.['emoji_id'])
      reactionAdded = subType !== 'remove' && event['set'] !== false
      activityType = reactionAdded ? 'message-reaction-added' : 'message-reaction-removed'
      kind = 'reaction'
      if (this.#isFeedbackEcho(messageId, reactionEmoji, reactionAdded, userId)) return
      if (!this.#config.captureMessageReactionEvents) return
    } else if (noticeType === 'notify' && subType === 'poke') {
      if (!this.#config.capturePokeEvents) return
      activityType = 'member-poked'
    } else if ((noticeType === 'notify' && subType === 'profile_like') || noticeType === 'profile_like') {
      activityType = 'profile-liked'
    } else if (noticeType === 'group_increase') {
      activityType = 'member-joined'
      kind = 'member-updated'
    } else if (noticeType === 'group_decrease') {
      activityType = 'member-left'
      kind = 'member-updated'
    } else if (noticeType === 'group_ban') {
      activityType = subType === 'lift_ban' || numberValue(event['duration']) === 0 ? 'member-unmuted' : 'member-muted'
      kind = 'member-updated'
    } else if (noticeType === 'group_admin') {
      activityType = subType === 'unset' ? 'member-admin-unset' : 'member-admin-set'
      kind = 'member-updated'
    } else if (noticeType === 'group_card') {
      activityType = 'member-card-changed'
      kind = 'member-updated'
    } else if (noticeType === 'notify' && subType === 'title') {
      activityType = 'member-title-changed'
      kind = 'member-updated'
    } else if (noticeType === 'notify' && (subType === 'group_name' || subType === 'group_name_change')) {
      activityType = 'channel-name-changed'
    } else if (noticeType === 'group_upload') {
      activityType = 'file-uploaded'
    } else if (noticeType === 'essence') {
      activityType = subType === 'delete' || subType === 'remove' ? 'essence-removed' : 'essence-added'
    } else if (noticeType === 'friend_add') {
      activityType = 'friend-added'
    } else return

    const directPeerId = userId ?? operatorId ?? senderId
    const channelPlatformId = groupId ? `group:${groupId}` : directPeerId ? `private:${directPeerId}` : undefined
    if (!channelPlatformId) return
    const channelId = await this.#context.channels.ensure({
      platformChannelId: channelPlatformId,
      kind: groupId ? 'group' : 'direct',
      observedAt: now,
    })
    if (activityType === 'channel-name-changed') {
      const name =
        compactNoticeText(event['name_new']) ??
        compactNoticeText(event['group_name']) ??
        compactNoticeText(event['name'])
      if (name) await this.#context.channels.updateDisplayName(channelId, name)
    }

    const displayHints = new Map<string, string>()
    const operatorNickname = compactNoticeText(event['operator_nick'])
    const cardNew = compactNoticeText(event['card_new'])
    if (operatorId && operatorNickname) displayHints.set(operatorId, operatorNickname)
    if (userId && cardNew) displayHints.set(userId, cardNew)
    const participantPlatformIds = [
      ...new Set([userId, operatorId, senderId, targetId].filter((id) => id !== undefined)),
    ]
    const participantMembers = new Map<string, ChannelMemberId>()
    await Promise.all(
      participantPlatformIds.map(async (platformUserId) => {
        const memberId = await this.#ensureNoticeMember(
          channelId,
          platformUserId,
          groupId,
          displayHints.get(platformUserId),
        )
        participantMembers.set(platformUserId, memberId)
      }),
    )

    const memberId = (platformUserId: string | undefined): ChannelMemberId | undefined =>
      platformUserId === undefined ? undefined : participantMembers.get(platformUserId)
    const memberParts = (platformUserId: string | undefined, fallback: string): MessagePart[] => {
      const resolved = memberId(platformUserId)
      return resolved ? [{ type: 'mention', memberId: resolved }] : [{ type: 'text', text: fallback }]
    }
    const sameMember = (left: string | undefined, right: string | undefined): boolean =>
      left !== undefined && right !== undefined && left === right

    const facts: Record<string, JsonValue> = {}
    if (subType) facts['subType'] = subType
    const subjectMemberId = memberId(userId)
    const operatorMemberId = memberId(operatorId)
    const targetMemberId = memberId(targetId)
    const senderActorMemberId = memberId(senderId)
    if (subjectMemberId) facts['subjectMemberId'] = subjectMemberId
    if (operatorMemberId) facts['operatorMemberId'] = operatorMemberId
    if (targetMemberId) facts['targetMemberId'] = targetMemberId
    if (senderActorMemberId) facts['senderMemberId'] = senderActorMemberId
    if (reactionEmoji) facts['reactionEmoji'] = reactionEmoji
    const durationSeconds = numberValue(event['duration'])
    if (durationSeconds !== undefined) facts['durationSeconds'] = durationSeconds
    const previousValue = compactNoticeText(event['card_old'])
    const newValue =
      cardNew ??
      compactNoticeText(event['title']) ??
      compactNoticeText(event['name_new']) ??
      compactNoticeText(event['name'])
    if (previousValue) facts['previousValue'] = previousValue
    if (newValue) facts['newValue'] = newValue

    let senderMemberId: ChannelMemberId | undefined
    let parts: MessagePart[]
    if (activityType === 'message-recalled') {
      const actorId = operatorId ?? userId
      senderMemberId = memberId(actorId)
      parts = sameMember(actorId, userId)
        ? [...memberParts(actorId, '一名成员'), { type: 'text', text: ' 撤回了一条消息。' }]
        : operatorId
          ? [
              ...memberParts(operatorId, '一名管理员'),
              { type: 'text', text: ' 撤回了 ' },
              ...memberParts(userId, '一名成员'),
              { type: 'text', text: ' 的一条消息。' },
            ]
          : [...memberParts(userId, '一名成员'), { type: 'text', text: ' 撤回了一条消息。' }]
    } else if (activityType === 'message-reaction-added' || activityType === 'message-reaction-removed') {
      senderMemberId = memberId(userId)
      parts = [
        ...memberParts(userId, '一名成员'),
        {
          type: 'text',
          text: activityType === 'message-reaction-added' ? ' 对一条消息添加了回应。' : ' 移除了一条消息的回应。',
        },
      ]
    } else if (activityType === 'member-poked') {
      const actorId = senderId ?? userId
      senderMemberId = memberId(actorId)
      parts = [
        ...memberParts(actorId, '一名成员'),
        { type: 'text', text: ' 戳了戳 ' },
        ...memberParts(targetId, '另一名成员'),
        { type: 'text', text: '。' },
      ]
    } else if (activityType === 'profile-liked') {
      senderMemberId = memberId(operatorId)
      const times = numberValue(event['times'])
      if (times !== undefined) facts['times'] = times
      parts = [
        ...memberParts(operatorId, '一名成员'),
        { type: 'text', text: ` 为机器人账号资料卡点了${times && times > 1 ? ` ${times} 次` : ''}赞。` },
      ]
    } else if (activityType === 'member-joined') {
      senderMemberId = memberId(userId)
      parts =
        subType === 'invite' && operatorId && !sameMember(operatorId, userId)
          ? [
              ...memberParts(userId, '一名成员'),
              { type: 'text', text: ' 受 ' },
              ...memberParts(operatorId, '一名成员'),
              { type: 'text', text: ' 邀请加入了频道。' },
            ]
          : subType === 'approve'
            ? [...memberParts(userId, '一名成员'), { type: 'text', text: ' 通过申请加入了频道。' }]
            : [...memberParts(userId, '一名成员'), { type: 'text', text: ' 加入了频道。' }]
    } else if (activityType === 'member-left') {
      senderMemberId = memberId(subType === 'kick' || subType === 'kick_me' ? (operatorId ?? userId) : userId)
      parts =
        subType === 'disband'
          ? [{ type: 'text', text: '频道已被解散。' }]
          : (subType === 'kick' || subType === 'kick_me') && operatorId
            ? [
                ...memberParts(operatorId, '一名管理员'),
                { type: 'text', text: ' 将 ' },
                ...memberParts(userId, subType === 'kick_me' ? '机器人账号' : '一名成员'),
                { type: 'text', text: ' 移出了频道。' },
              ]
            : subType === 'kick' || subType === 'kick_me'
              ? [...memberParts(userId, '一名成员'), { type: 'text', text: ' 被移出了频道。' }]
              : [...memberParts(userId, '一名成员'), { type: 'text', text: ' 离开了频道。' }]
    } else if (activityType === 'member-muted' || activityType === 'member-unmuted') {
      senderMemberId = operatorMemberId ?? subjectMemberId
      const prefix = operatorId
        ? [...memberParts(operatorId, '一名管理员'), { type: 'text' as const, text: ' 将 ' }]
        : []
      const duration = durationLabel(durationSeconds)
      parts = [
        ...prefix,
        ...memberParts(userId, '一名成员'),
        {
          type: 'text',
          text:
            activityType === 'member-muted'
              ? `${operatorId ? '' : ' 被'}禁言${duration ? ` ${duration}` : ''}。`
              : `${operatorId ? '' : ' 被'}解除了禁言。`,
        },
      ]
    } else if (activityType === 'member-admin-set' || activityType === 'member-admin-unset') {
      senderMemberId = subjectMemberId
      parts = [
        ...memberParts(userId, '一名成员'),
        {
          type: 'text',
          text: activityType === 'member-admin-set' ? ' 被设为管理员。' : ' 不再担任管理员。',
        },
      ]
    } else if (activityType === 'member-card-changed') {
      senderMemberId = subjectMemberId
      parts =
        previousValue && cardNew
          ? [
              ...memberParts(userId, '一名成员'),
              { type: 'text', text: ` 将群名片从「${previousValue}」改为「${cardNew}」。` },
            ]
          : cardNew
            ? [...memberParts(userId, '一名成员'), { type: 'text', text: ` 将群名片改为「${cardNew}」。` }]
            : previousValue
              ? [...memberParts(userId, '一名成员'), { type: 'text', text: ` 清除了群名片「${previousValue}」。` }]
              : [...memberParts(userId, '一名成员'), { type: 'text', text: ' 修改了群名片。' }]
    } else if (activityType === 'member-title-changed') {
      senderMemberId = subjectMemberId
      const title = compactNoticeText(event['title'])
      parts = title
        ? [...memberParts(userId, '一名成员'), { type: 'text', text: ` 获得了群头衔「${title}」。` }]
        : [...memberParts(userId, '一名成员'), { type: 'text', text: ' 的群头衔发生了变化。' }]
    } else if (activityType === 'channel-name-changed') {
      senderMemberId = subjectMemberId
      const name =
        compactNoticeText(event['name_new']) ??
        compactNoticeText(event['group_name']) ??
        compactNoticeText(event['name'])
      parts = name
        ? [...memberParts(userId, '一名管理员'), { type: 'text', text: ` 将频道名称改为「${name}」。` }]
        : [{ type: 'text', text: '频道名称发生了变化。' }]
    } else if (activityType === 'essence-added' || activityType === 'essence-removed') {
      senderMemberId = operatorMemberId ?? subjectMemberId
      parts = [
        ...memberParts(operatorId ?? userId, '一名管理员'),
        { type: 'text', text: ' 将 ' },
        ...memberParts(userId, '一名成员'),
        {
          type: 'text',
          text: activityType === 'essence-added' ? ' 的一条消息设为精华。' : ' 的一条消息取消了精华。',
        },
      ]
    } else if (activityType === 'friend-added') {
      senderMemberId = subjectMemberId
      parts = [...memberParts(userId, '一名成员'), { type: 'text', text: ' 已成为机器人账号的好友。' }]
    } else {
      senderMemberId = subjectMemberId
      parts = [{ type: 'text', text: '收到一条频道事件。' }]
    }

    let assetOccurrences: { readonly partIndex: number; readonly assetId: AssetId }[] | undefined
    if (activityType === 'file-uploaded' && groupId) {
      const file = oneBotObject(event['file'])
      const fileId = oneBotStringId(file?.['id'])
      const busid = oneBotStringId(file?.['busid'])
      const fileName = compactNoticeText(file?.['name'], 200)
      const fileSize = numberValue(file?.['size'])
      senderMemberId = subjectMemberId
      if (fileSize !== undefined) facts['fileSize'] = fileSize
      if (fileId && busid) {
        try {
          const response = oneBotObject(
            await this.#requireClient().call('get_group_file_url', {
              group_id: groupId,
              file_id: fileId,
              busid,
            }),
          )
          const url = textValue(response?.['url'])
          if (url) {
            const asset = await this.#downloadAsset(url)
            parts = [
              ...memberParts(userId, '一名成员'),
              { type: 'text', text: ' 上传了文件：' },
              { type: 'file', assetId: asset.assetId, ...(fileName ? { name: fileName } : {}) },
            ]
            assetOccurrences = [{ partIndex: parts.length - 1, assetId: asset.assetId }]
          }
        } catch {
          // The durable rich summary remains when this protocol endpoint cannot provide a safe URL.
        }
      }
      if (assetOccurrences === undefined) {
        const detail = [fileName ? `「${fileName}」` : '一个文件', byteSizeLabel(fileSize)].filter(Boolean).join(' · ')
        parts = [...memberParts(userId, '一名成员'), { type: 'text', text: ` 上传了${detail}。` }]
      }
    }
    await this.#context.acceptInbound({
      connectionId: this.#context.connectionId,
      channelId,
      adapterKey: ONEBOT_11_ADAPTER_KEY,
      kind,
      activityType,
      ...(messageId === undefined ? {} : { targetPlatformMessageId: messageId }),
      ...(senderMemberId === undefined ? {} : { senderMemberId }),
      parts,
      platformTimestamp: timestampMs(event['time'], now),
      receivedAt: now,
      dedupeKey: `onebot:${eventDigest(event)}`,
      ...(Object.keys(facts).length === 0 ? {} : { facts }),
      ...(assetOccurrences === undefined ? {} : { assetOccurrences }),
    })
  }

  async #ensureNoticeMember(
    channelId: ChannelId,
    platformUserId: string,
    groupId: string | undefined,
    displayHint: string | undefined,
  ): Promise<ChannelMemberId> {
    let displayName = displayHint
    if (!displayName && groupId) {
      try {
        const info = oneBotObject(
          await this.#requireClient().call('get_group_member_info', {
            group_id: groupId,
            user_id: platformUserId,
            no_cache: true,
          }),
        )
        displayName = compactNoticeText(info?.['card']) ?? compactNoticeText(info?.['nickname'])
      } catch {
        // A member may already have left the group; fall back to stranger info below.
      }
    }
    if (!displayName) {
      try {
        const info = oneBotObject(
          await this.#requireClient().call('get_stranger_info', { user_id: platformUserId, no_cache: false }),
        )
        displayName = compactNoticeText(info?.['nickname'])
      } catch {
        // Existing Host member observations can still supply a display name.
      }
    }
    return this.#context.members.ensure({
      channelId,
      platformUserId,
      ...(displayName ? { displayName } : {}),
      observedAt: this.#context.now(),
    })
  }

  async #downloadAsset(rawUrl: string) {
    const remote = await this.#context.assets.fetchRemoteBytes({
      url: rawUrl,
      maxBytes: MAX_ASSET_BYTES,
      allowHttp: true,
    })
    return this.#context.assets.importBytes({
      bytes: remote.bytes,
      ...(remote.declaredMediaType ? { declaredMediaType: remote.declaredMediaType } : {}),
    })
  }

  async #resolveTarget(channelId: ChannelId) {
    const platformChannelId = await this.#context.channels.resolvePlatformChannelId(channelId)
    return platformChannelId ? targetFromPlatformChannel(platformChannelId) : undefined
  }

  async #privateSourceGroup(channelId: ChannelId): Promise<string | undefined> {
    const source = oneBotObject(await this.#context.state.load(`private-source/${channelId}`))
    return oneBotStringId(source?.['groupId'])
  }

  async #setProcessingFeedback(
    channelId: ChannelId,
    platformMessageId: string,
    set: boolean,
  ): Promise<AdapterInteractionOutcome> {
    const target = await this.#resolveTarget(channelId)
    if (target?.kind !== 'group') return { status: 'unsupported', message: 'OneBot 处理中回应只用于群聊。' }
    const client = this.#client
    if (!client) return { status: 'failed', message: 'OneBot Runtime 尚未启动。' }
    const key = this.#feedbackKey(platformMessageId, FEEDBACK_EMOJI_ID, set)
    this.#feedbackEchoes.set(key, this.#context.now() + 15_000)
    try {
      await client.callOptional('set_msg_emoji_like', {
        message_id: platformMessageId,
        emoji_id: FEEDBACK_EMOJI_ID,
        set,
      })
      return { status: 'succeeded' }
    } catch (error) {
      this.#feedbackEchoes.delete(key)
      return actionOutcome(error)
    }
  }

  #isFeedbackEcho(
    messageId: string | undefined,
    emojiId: string | undefined,
    added: boolean,
    userId: string | undefined,
  ): boolean {
    if (!messageId || !emojiId || (userId && userId !== this.#client?.accountId)) return false
    return this.#feedbackEchoes.has(this.#feedbackKey(messageId, emojiId, added))
  }

  #feedbackKey(messageId: string, emojiId: string, set: boolean): string {
    return `${messageId}:${emojiId}:${set ? 'add' : 'remove'}`
  }

  #expireFeedbackEchoes(): void {
    const now = this.#context.now()
    for (const [key, expiresAt] of this.#feedbackEchoes) if (expiresAt <= now) this.#feedbackEchoes.delete(key)
    for (const [key, expiresAt] of this.#recallEchoes) if (expiresAt <= now) this.#recallEchoes.delete(key)
  }

  #isRecallEcho(messageId: string, userId: string | undefined, operatorId: string | undefined): boolean {
    if (!this.#recallEchoes.has(messageId)) return false
    const accountId = this.#client?.accountId
    return accountId !== undefined && (userId === accountId || operatorId === accountId)
  }

  #requireClient(): OneBotWebSocketClient {
    if (!this.#client) throw new OneBotActionError('OneBot Runtime 尚未启动。', 'transient', false)
    return this.#client
  }
}
