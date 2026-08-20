import type {
  AdapterConnectionContext,
  AdapterConnectionRuntime,
  AdapterDeliveryReceipt,
  AdapterPhysicalPlan,
  AdapterOutboundCapabilities,
  InboundCommitResult,
  PhysicalDeliveryRequest,
} from '@nekro-nxt/adapter-sdk'
import { defineAdapterConnection } from '@nekro-nxt/adapter-sdk'
import type {
  AssetId,
  ChannelId,
  ChannelMemberId,
  ConnectionId,
  JsonValue,
  LogicalMessageId,
  MessagePart,
} from '@nekro-nxt/contracts'
import { LogicalMessageIdSchema } from '@nekro-nxt/contracts'
import { z } from 'zod'
import { splitQQContentAtoms } from './inbound.js'
import { isQQTransportError } from './transport-error.js'

export * from './gateway.js'
export * from './http.js'
export * from './inbound.js'
export * from './runtime.js'
export * from './transport-error.js'
export * from './websocket.js'

export const QQ_OPENCLAW_ADAPTER_KEY = 'qq-openclaw'

export const QQOpenClawConnectionConfigurationSchema = z
  .object({
    appId: z.string().trim().min(1),
    proactiveSend: z.boolean().default(false),
    markdown: z.boolean().default(true),
    maxTextLength: z.number().int().positive().default(1800),
    maxTextBytes: z.number().int().positive().default(7200),
  })
  .strict()

export const QQOpenClawCredentialsSchema = z
  .object({
    clientSecretCredentialRef: z.string().trim().min(1),
  })
  .strict()

export const QQOpenClawConnectionInputSchema = QQOpenClawConnectionConfigurationSchema.extend({
  clientSecret: z.string().trim().min(1),
}).strict()

export type QQOpenClawConnectionInput = z.input<typeof QQOpenClawConnectionInputSchema>

export const QQOpenClawConfigSchema = QQOpenClawConnectionConfigurationSchema.extend({
  ...QQOpenClawCredentialsSchema.shape,
  maxAssetBytes: z
    .number()
    .int()
    .positive()
    .default(20 * 1024 * 1024),
  passiveReplyTtlMs: z
    .number()
    .int()
    .positive()
    .default(5 * 60 * 1000),
  passiveReplyLimit: z.number().int().positive().default(5),
}).strict()

export type QQOpenClawConfig = z.input<typeof QQOpenClawConfigSchema>
type QQResolvedOpenClawConfig = z.output<typeof QQOpenClawConfigSchema>

export const QQ_OPENCLAW_CONNECTION_DEFINITION = defineAdapterConnection({
  key: QQ_OPENCLAW_ADAPTER_KEY,
  displayName: 'QQ 官方机器人',
  description: '连接 QQ 官方机器人账号，接收群聊与私聊消息，并按平台能力发送内容。',
  userCreatable: true,
  configurationSchema: QQOpenClawConnectionConfigurationSchema,
  credentialsSchema: QQOpenClawCredentialsSchema,
  configSchema: {
    schemaVersion: 1,
    type: 'object',
    required: ['appId', 'clientSecretCredentialRef'],
    properties: {
      appId: { type: 'string', title: 'App ID' },
      clientSecretCredentialRef: { type: 'credential-reference', title: 'Client Secret' },
      proactiveSend: { type: 'boolean', title: '允许主动发送', default: false },
      markdown: { type: 'boolean', title: '使用 Markdown', default: true },
      maxTextLength: { type: 'number', title: '单条字符上限', default: 1800 },
      maxTextBytes: { type: 'number', title: '单条 UTF-8 字节上限', default: 7200 },
    },
  },
  create: (configuration, credentials) => ({
    ...configuration,
    clientSecret: credentials.clientSecretCredentialRef,
  }),
})

export const QQ_OPENCLAW_CONFIG_SCHEMA = QQ_OPENCLAW_CONNECTION_DEFINITION.descriptor.configSchema
export const QQ_OPENCLAW_CONNECTION_DESCRIPTOR = QQ_OPENCLAW_CONNECTION_DEFINITION.descriptor

export const QQ_OPENCLAW_CAPABILITIES: AdapterOutboundCapabilities = {
  text: true,
  mentions: true,
  images: true,
  files: true,
  audio: true,
  replies: true,
  mixedContent: false,
  proactiveSend: true,
  maxTextLength: 1800,
}

export interface QQTarget {
  readonly kind: 'c2c' | 'group'
  readonly openId: string
}

export interface QQIdentityDirectory {
  resolveTarget(connectionId: ConnectionId, channelId: ChannelId): Promise<QQTarget | undefined>
  resolveMemberOpenId(
    connectionId: ConnectionId,
    channelId: ChannelId,
    memberId: ChannelMemberId,
  ): Promise<string | undefined>
  resolvePlatformMessageId(
    connectionId: ConnectionId,
    channelId: ChannelId,
    logicalMessageId: LogicalMessageId,
  ): Promise<string | undefined>
}

export interface QQAssetSource {
  read(assetId: AssetId): Promise<{
    readonly bytes: Uint8Array
    readonly mediaType: string
    readonly fileName?: string
  }>
}

export interface QQInboundAttachment {
  readonly url: string
  readonly fileName?: string
  readonly mediaType?: string
}

export interface QQInboundBridge {
  ensureTarget(input: {
    readonly connectionId: ConnectionId
    readonly target: QQTarget
    readonly displayName?: string
    readonly observedAt: number
  }): Promise<ChannelId>
  ensureMember(input: {
    readonly connectionId: ConnectionId
    readonly channelId: ChannelId
    readonly openId: string
    readonly displayName?: string
    readonly observedAt: number
  }): Promise<ChannelMemberId>
  importAttachment(
    input: QQInboundAttachment & {
      readonly connectionId: ConnectionId
      readonly channelId: ChannelId
      readonly platformMessageId: string
      readonly receivedAt: number
      readonly attachmentIndex: number
      readonly signal: AbortSignal
    },
  ): Promise<{
    readonly assetId: AssetId
    readonly mediaType: string
    readonly fileName?: string
  }>
  resolveQuote(input: {
    readonly connectionId: ConnectionId
    readonly target: QQTarget
    readonly platformReference: string
  }): Promise<
    | {
        readonly messageId: LogicalMessageId
        readonly authoredByAgent: boolean
      }
    | undefined
  >
}

export interface QQNormalizedInboundMessage {
  readonly eventType: 'C2C_MESSAGE_CREATE' | 'GROUP_AT_MESSAGE_CREATE' | 'GROUP_MESSAGE_CREATE'
  readonly platformMessageId: string
  readonly target: QQTarget
  readonly targetDisplayName?: string
  readonly senderOpenId: string
  readonly senderDisplayName?: string
  readonly content?: string
  readonly mentions?: readonly {
    readonly openId: string
    readonly displayName?: string
    readonly bot?: boolean
  }[]
  readonly attachments?: readonly QQInboundAttachment[]
  readonly platformReference?: string
  readonly platformSequence?: number
  readonly platformTimestamp: number
  readonly receivedAt?: number
  readonly replyExpiresAt?: number
  readonly remainingReplies?: number
}

export interface QQTransportReceipt {
  readonly platformMessageId: string
  readonly refIndex?: string
}

export interface QQOpenClawTransport {
  start(): Promise<void>
  stop(): Promise<void>
  sendText(input: {
    readonly target: QQTarget
    readonly markdown: boolean
    readonly content: string
    readonly replyMessageId?: string
    readonly messageSequence?: number
    readonly signal: AbortSignal
  }): Promise<QQTransportReceipt>
  upload(input: {
    readonly target: QQTarget
    readonly bytes: Uint8Array
    readonly mediaType: string
    readonly fileName?: string
    readonly signal: AbortSignal
  }): Promise<{ readonly fileInfo: string }>
  sendMedia(input: {
    readonly target: QQTarget
    readonly fileInfo: string
    readonly replyMessageId?: string
    readonly messageSequence?: number
    readonly signal: AbortSignal
  }): Promise<QQTransportReceipt>
}

type TextAtom = { readonly kind: 'text'; readonly value: string } | { readonly kind: 'mention'; readonly value: string }

const codePoints = (value: string): string[] => [...value]

const splitPlainText = (value: string, limit: number): string[] => {
  const points = codePoints(value)
  if (points.length <= limit) return value ? [value] : []
  const chunks: string[] = []
  for (let offset = 0; offset < points.length; offset += limit)
    chunks.push(points.slice(offset, offset + limit).join(''))
  return chunks
}

/** Split text while keeping Mention tokens atomic and closing/reopening fenced code blocks. */
export function splitQQMarkdownAtoms(atoms: readonly TextAtom[], limit: number): string[] {
  if (!Number.isSafeInteger(limit) || limit < 16) throw new TypeError('QQ Markdown limit must be at least 16.')
  const output: string[] = []
  let current = ''
  let fence = ''
  const flush = () => {
    if (!current) return
    output.push(fence ? `${current}\n\`\`\`` : current)
    current = fence ? `\`\`\`${fence}\n` : ''
  }
  const append = (token: string, atomic: boolean) => {
    if (atomic && codePoints(token).length > limit) throw new Error('QQ atomic Markdown token exceeds the limit.')
    for (const piece of atomic ? [token] : splitPlainText(token, Math.max(1, limit - codePoints(current).length))) {
      if (codePoints(current + piece).length > limit) flush()
      if (codePoints(piece).length > limit) {
        for (const nested of splitPlainText(piece, limit - (fence ? fence.length + 4 : 0))) {
          if (codePoints(current + nested).length > limit) flush()
          current += nested
          if (codePoints(current).length >= limit) flush()
        }
      } else current += piece
      const markers = piece.match(/```[^\n]*/g) ?? []
      for (const marker of markers) fence = fence ? '' : marker.slice(3).trim()
    }
  }
  const linkPattern = /\[[^\]\n]+\]\([^\s)]+\)|https?:\/\/[^\s]+/gu
  for (const atom of atoms) {
    if (atom.kind === 'mention') {
      append(atom.value, true)
      continue
    }
    let offset = 0
    for (const match of atom.value.matchAll(linkPattern)) {
      const index = match.index
      if (index > offset) append(atom.value.slice(offset, index), false)
      append(match[0], true)
      offset = index + match[0].length
    }
    if (offset < atom.value.length) append(atom.value.slice(offset), false)
  }
  flush()
  return output.filter(Boolean)
}

export class QQReplyBudget {
  readonly #entries = new Map<
    string,
    { expiresAt: number; remaining: number; nextSequence: number; reservations: Set<number> }
  >()

  observe(messageId: string, expiresAt: number, remaining: number): void {
    const existing = this.#entries.get(messageId)
    if (existing) {
      existing.expiresAt = Math.max(existing.expiresAt, expiresAt)
      existing.remaining = Math.min(existing.remaining, remaining)
      return
    }
    this.#entries.set(messageId, { expiresAt, remaining, nextSequence: 1, reservations: new Set() })
  }

  reserve(
    messageId: string | undefined,
    now: number,
  ): { readonly messageId: string; readonly sequence: number } | undefined {
    if (!messageId) return undefined
    const entry = this.#entries.get(messageId)
    if (!entry || entry.expiresAt <= now || entry.remaining - entry.reservations.size <= 0) return undefined
    const sequence = entry.nextSequence
    entry.nextSequence += 1
    entry.reservations.add(sequence)
    return { messageId, sequence }
  }

  commit(reservation: { readonly messageId: string; readonly sequence: number }): void {
    const entry = this.#entries.get(reservation.messageId)
    if (!entry?.reservations.delete(reservation.sequence)) return
    entry.remaining = Math.max(0, entry.remaining - 1)
  }

  release(reservation: { readonly messageId: string; readonly sequence: number }): void {
    this.#entries.get(reservation.messageId)?.reservations.delete(reservation.sequence)
  }

  available(messageId: string, now: number): number {
    const entry = this.#entries.get(messageId)
    return !entry || entry.expiresAt <= now ? 0 : Math.max(0, entry.remaining - entry.reservations.size)
  }
}

export class QQOpenClawConnection implements AdapterConnectionRuntime {
  readonly capabilities: AdapterOutboundCapabilities
  readonly #context: AdapterConnectionContext
  readonly #config: QQResolvedOpenClawConfig
  readonly #directory: QQIdentityDirectory
  readonly #assets: QQAssetSource
  readonly #inbound: QQInboundBridge | undefined
  readonly #transport: QQOpenClawTransport
  readonly #replyBudget = new QQReplyBudget()
  #running = false

  constructor(
    context: AdapterConnectionContext,
    config: QQOpenClawConfig,
    dependencies: {
      readonly directory: QQIdentityDirectory
      readonly assets: QQAssetSource
      readonly transport: QQOpenClawTransport
      readonly inbound?: QQInboundBridge
    },
  ) {
    this.#context = context
    this.#config = QQOpenClawConfigSchema.parse(config)
    this.#directory = dependencies.directory
    this.#assets = dependencies.assets
    this.#inbound = dependencies.inbound
    this.#transport = dependencies.transport
    this.capabilities = {
      ...QQ_OPENCLAW_CAPABILITIES,
      proactiveSend: this.#config.proactiveSend,
      maxTextLength: this.#config.maxTextLength,
      maxAssetBytes: this.#config.maxAssetBytes,
    }
  }

  start = async (): Promise<void> => {
    if (this.#running) throw new Error('QQ OpenClaw Connection is already running.')
    await this.#transport.start()
    this.#running = true
  }

  stop = async (): Promise<void> => {
    this.#running = false
    await this.#transport.stop()
  }

  async planOutbound(input: {
    readonly connectionId: ConnectionId
    readonly channelId: ChannelId
    readonly parts: readonly MessagePart[]
    readonly replyTo?: string
  }): Promise<readonly AdapterPhysicalPlan[]> {
    const replyTargets = new Set<string>()
    if (input.replyTo) replyTargets.add(input.replyTo)
    for (const part of input.parts) if (part.type === 'quote') replyTargets.add(part.messageId)
    if (replyTargets.size > 1) throw new Error('QQ PhysicalDelivery cannot reference multiple quoted messages.')
    const [logicalReplyTarget] = replyTargets
    const replyPlatformMessageId = logicalReplyTarget
      ? await this.#directory.resolvePlatformMessageId(
          input.connectionId,
          input.channelId,
          LogicalMessageIdSchema.parse(logicalReplyTarget),
        )
      : undefined
    if (logicalReplyTarget && !replyPlatformMessageId) {
      throw new Error(`QQ quoted message is unknown in this Channel: ${logicalReplyTarget}`)
    }
    const groups: MessagePart[][] = []
    let text: TextAtom[] = []
    const flush = (): void => {
      for (const chunk of splitQQMarkdownAtoms(text, this.#config.maxTextLength)) {
        groups.push([{ type: 'text', text: chunk }])
      }
      text = []
    }
    for (const part of input.parts) {
      if (part.type === 'text') text.push({ kind: 'text', value: part.text })
      else if (part.type === 'mention') {
        const openId = await this.#directory.resolveMemberOpenId(input.connectionId, input.channelId, part.memberId)
        if (!openId) throw new Error(`QQ member is unknown in this Connection: ${part.memberId}`)
        text.push({ kind: 'mention', value: `<@${openId}>` })
      } else if (part.type === 'quote') {
        continue
      } else {
        flush()
        groups.push([part])
      }
    }
    flush()
    if (groups.length === 0) throw new Error('QQ quoted delivery requires content in addition to the quote.')
    for (const parts of groups) {
      for (const part of parts) {
        if (part.type === 'text' && Buffer.byteLength(part.text, 'utf8') > this.#config.maxTextBytes) {
          throw new Error('QQ planned text exceeds the configured UTF-8 byte limit.')
        }
      }
    }
    if (replyPlatformMessageId === undefined) return groups.map((parts) => ({ parts }))
    const available = this.#replyBudget.available(replyPlatformMessageId, this.#context.now())
    const replyMode = available >= groups.length ? 'passive' : 'proactive'
    if (replyMode === 'proactive' && !this.#config.proactiveSend) {
      throw new Error('QQ passive reply quota cannot cover the complete PhysicalDelivery group.')
    }
    const adapterContext = { replyPlatformMessageId, replyMode } satisfies JsonValue
    return groups.map((parts) => ({ parts, adapterContext }))
  }

  observeReplyContext(
    messageId: string,
    input: { readonly expiresAt?: number; readonly remainingReplies?: number },
  ): void {
    this.#replyBudget.observe(
      messageId,
      input.expiresAt ?? this.#context.now() + this.#config.passiveReplyTtlMs,
      input.remainingReplies ?? this.#config.passiveReplyLimit,
    )
  }

  async resolveDiagnosticTarget(channelId: ChannelId): Promise<QQTarget> {
    const target = await this.#directory.resolveTarget(this.#context.connectionId, channelId)
    if (!target) throw new Error('QQ diagnostic target is unknown for this Channel.')
    return target
  }

  sendDiagnosticText(target: QQTarget, content: string, signal: AbortSignal): Promise<QQTransportReceipt> {
    if (!this.#running) return Promise.reject(new Error('QQ OpenClaw Connection is not running.'))
    return this.#transport.sendText({ target, markdown: false, content, signal })
  }

  async receive(
    message: QQNormalizedInboundMessage,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<InboundCommitResult> {
    if (!this.#running) throw new Error('QQ OpenClaw Connection is not running.')
    if (!this.#inbound) throw new Error('QQ inbound bridge is not configured.')
    if (!message.platformMessageId.trim()) throw new Error('QQ inbound message ID is required.')
    const receivedAt = message.receivedAt ?? this.#context.now()
    const channelId = await this.#inbound.ensureTarget({
      connectionId: this.#context.connectionId,
      target: message.target,
      ...(message.targetDisplayName === undefined ? {} : { displayName: message.targetDisplayName }),
      observedAt: receivedAt,
    })
    const senderMemberId = await this.#inbound.ensureMember({
      connectionId: this.#context.connectionId,
      channelId,
      openId: message.senderOpenId,
      ...(message.senderDisplayName === undefined ? {} : { displayName: message.senderDisplayName }),
      observedAt: receivedAt,
    })
    const parts: MessagePart[] = []
    const assetOccurrences: { readonly partIndex: number; readonly assetId: AssetId }[] = []
    let replyToBot = false
    let mentionedBot = message.eventType === 'GROUP_AT_MESSAGE_CREATE'
    for (const atom of splitQQContentAtoms(message.content, message.mentions ?? [])) {
      if (atom.kind === 'text') {
        if (atom.value) parts.push({ type: 'text', text: atom.value })
        continue
      }
      if (atom.bot) mentionedBot = true
      const memberId = await this.#inbound.ensureMember({
        connectionId: this.#context.connectionId,
        channelId,
        openId: atom.openId,
        ...(atom.displayName === undefined ? {} : { displayName: atom.displayName }),
        observedAt: receivedAt,
      })
      parts.push({ type: 'mention', memberId })
    }
    for (const [attachmentIndex, attachment] of (message.attachments ?? []).entries()) {
      const imported = await this.#inbound.importAttachment({
        ...attachment,
        connectionId: this.#context.connectionId,
        channelId,
        platformMessageId: message.platformMessageId,
        receivedAt,
        attachmentIndex,
        signal,
      })
      assetOccurrences.push({ partIndex: parts.length, assetId: imported.assetId })
      if (imported.mediaType.startsWith('image/')) {
        parts.push({
          type: 'image',
          assetId: imported.assetId,
          ...(imported.fileName === undefined ? {} : { alt: imported.fileName }),
        })
      } else if (imported.mediaType.startsWith('audio/')) {
        parts.push({ type: 'audio', assetId: imported.assetId })
      } else {
        parts.push({
          type: 'file',
          assetId: imported.assetId,
          ...(imported.fileName === undefined ? {} : { name: imported.fileName }),
        })
      }
    }
    if (message.platformReference) {
      const quote = await this.#inbound.resolveQuote({
        connectionId: this.#context.connectionId,
        target: message.target,
        platformReference: message.platformReference,
      })
      if (quote) {
        parts.push({ type: 'quote', messageId: quote.messageId })
        replyToBot = quote.authoredByAgent
      }
    }
    if (parts.length === 0) {
      parts.push({
        type: 'text',
        text: mentionedBot ? '（未包含其他可显示内容）' : '该 QQ 消息包含暂不支持显示的内容。',
      })
    }
    this.observeReplyContext(message.platformMessageId, {
      ...(message.replyExpiresAt === undefined ? {} : { expiresAt: message.replyExpiresAt }),
      ...(message.remainingReplies === undefined ? {} : { remainingReplies: message.remainingReplies }),
    })
    const commit = await this.#context.acceptInbound({
      connectionId: this.#context.connectionId,
      channelId,
      adapterKey: QQ_OPENCLAW_ADAPTER_KEY,
      platformEventId: `${message.eventType}:${message.platformMessageId}`,
      platformMessageId: message.platformMessageId,
      kind: 'message-created',
      senderMemberId,
      parts,
      ...(message.platformSequence === undefined ? {} : { platformSequence: message.platformSequence }),
      platformTimestamp: message.platformTimestamp,
      receivedAt,
      dedupeKey: `qq-openclaw:${message.eventType}:${message.platformMessageId}`,
      facts: {
        mentionedBot,
        replyToBot,
        targetKind: message.target.kind,
      },
      ...(assetOccurrences.length === 0 ? {} : { assetOccurrences }),
    })
    return commit
  }

  async deliver(request: PhysicalDeliveryRequest, signal: AbortSignal): Promise<AdapterDeliveryReceipt> {
    if (!this.#running) throw new Error('QQ OpenClaw Connection is not running.')
    if (request.connectionId !== this.#context.connectionId) {
      return { status: 'failed', failure: { kind: 'invalid', message: 'Delivery targets another Connection.' } }
    }
    const target = await this.#directory.resolveTarget(request.connectionId, request.channelId)
    if (!target) return { status: 'failed', failure: { kind: 'invalid', message: 'QQ Channel target is unknown.' } }
    const adapterContext =
      typeof request.adapterContext === 'object' &&
      request.adapterContext !== null &&
      !Array.isArray(request.adapterContext)
        ? request.adapterContext
        : undefined
    const plannedReply = adapterContext?.['replyPlatformMessageId']
    const plannedReplyMode = adapterContext?.['replyMode']
    const replyMessageId = typeof plannedReply === 'string' ? plannedReply : request.replyTo
    const passive =
      plannedReplyMode === 'proactive' ? undefined : this.#replyBudget.reserve(replyMessageId, this.#context.now())
    if (!passive && (plannedReplyMode === 'passive' || !this.#config.proactiveSend)) {
      return { status: 'failed', failure: { kind: 'permanent', message: '被动回复上下文不可用，且主动发送未启用。' } }
    }
    try {
      const receipt = await this.#deliverParts(request, target, passive, signal)
      if (passive) this.#replyBudget.commit(passive)
      return { status: 'sent', platformMessageId: receipt.platformMessageId }
    } catch (error) {
      if (isQQTransportError(error)) {
        if (passive) {
          if (error.kind === 'unknown') this.#replyBudget.commit(passive)
          else this.#replyBudget.release(passive)
        }
        if (error.kind === 'unknown') return { status: 'unknown', message: error.message }
        return {
          status: 'failed',
          failure: {
            kind: error.kind,
            message: error.message,
            ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
          },
        }
      }
      if (signal.aborted) {
        if (passive) this.#replyBudget.commit(passive)
        return { status: 'unknown', message: 'QQ request may have been submitted before cancellation.' }
      }
      if (passive) this.#replyBudget.release(passive)
      return {
        status: 'failed',
        failure: { kind: 'transient', message: error instanceof Error ? error.message : String(error) },
      }
    }
  }

  async #deliverParts(
    request: PhysicalDeliveryRequest,
    target: QQTarget,
    passive: { readonly messageId: string; readonly sequence: number } | undefined,
    signal: AbortSignal,
  ): Promise<QQTransportReceipt> {
    if (request.parts.every((part) => part.type === 'text' || part.type === 'mention')) {
      const atoms: TextAtom[] = []
      for (const part of request.parts) {
        if (part.type === 'text') atoms.push({ kind: 'text', value: part.text })
        else if (part.type === 'mention') {
          const openId = await this.#directory.resolveMemberOpenId(
            request.connectionId,
            request.channelId,
            part.memberId,
          )
          if (!openId) throw new Error(`QQ member is unknown in this Connection: ${part.memberId}`)
          atoms.push({ kind: 'mention', value: `<@${openId}>` })
        }
      }
      const chunks = splitQQMarkdownAtoms(atoms, this.#config.maxTextLength)
      if (chunks.length !== 1) throw new Error('QQ PhysicalDelivery requires planner splitting before send.')
      if (Buffer.byteLength(chunks[0] ?? '', 'utf8') > this.#config.maxTextBytes) {
        throw new Error('QQ PhysicalDelivery exceeds the configured UTF-8 byte limit.')
      }
      return this.#transport.sendText({
        target,
        markdown: this.#config.markdown,
        content: chunks[0] ?? '',
        ...(passive === undefined ? {} : { replyMessageId: passive.messageId, messageSequence: passive.sequence }),
        signal,
      })
    }
    if (request.parts.length !== 1) throw new Error('QQ media PhysicalDelivery must contain exactly one part.')
    const part = request.parts[0]!
    if (part.type !== 'image' && part.type !== 'file' && part.type !== 'audio') {
      throw new Error(`QQ cannot deliver this physical part: ${part.type}`)
    }
    const source = await this.#assets.read(part.assetId)
    if (source.bytes.byteLength > this.#config.maxAssetBytes)
      throw new Error('QQ media exceeds the configured size limit.')
    const uploaded = await this.#transport.upload({ target, ...source, signal })
    return this.#transport.sendMedia({
      target,
      fileInfo: uploaded.fileInfo,
      ...(passive === undefined ? {} : { replyMessageId: passive.messageId, messageSequence: passive.sequence }),
      signal,
    })
  }
}
