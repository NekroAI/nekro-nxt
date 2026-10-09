import { formatContextTime } from './scheduled-tasks.js'
import { sessionEvents } from './session-event-history.js'
import type { DshHostRuntimeOptions } from './index.js'
import type { Context } from '@deepseek-ai/cordis'
import { type Agent } from '@deepseek-ai/dsh-agent'
import AttachmentStore, {
  AttachmentId,
  type ImageAttachmentRef,
  type ImageRequestTarget,
  type RequestImageAttachment,
  type SaveImageAttachment,
  type StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { readRequestImageFile } from '@deepseek-ai/dsh-attachment-local'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import {
  BlockAssembler,
  contentHasImage,
  freezeMessage,
  LlmError,
  MessageId,
  type ContentBlock,
  type TextBlock,
  type UserMessage,
} from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { isAdminConsoleOutbound, type ChannelHistoryEntry } from '@nekro-nxt/channel-runtime'
import {
  AssetIdSchema,
  messagePartAssetIds,
  richPartContextText,
  type AssetId,
  type ChannelId,
  type ChannelMemberId,
  type ChannelRuntimeUsage,
  type MessagePart,
} from '@nekro-nxt/contracts'
import type {
  AgentRevisionRecord,
  AssetChannelGrant,
  AssetRecord,
  AssetService,
  ChannelEventRecord,
} from '@nekro-nxt/core'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { z } from 'zod'
import type { SessionRegistry } from './session-registry.js'
import { projectTokenUsage } from './token-usage.js'
export interface AssetAccessRepository {
  getAssetById(id: AssetRecord['id']): AssetRecord | undefined
  canAccessAsset(assetId: AssetRecord['id'], channelId: ChannelId): boolean
  grantAssetAccess(grant: AssetChannelGrant): AssetChannelGrant
}

export interface AgentImageDiagnostics {
  readonly route: {
    readonly mode: 'direct' | 'delegated' | 'unavailable'
    readonly provider?: string
    readonly model?: string
  }
  readonly activeSessions: number
  readonly residentImages: number
  readonly duplicateImagesSkipped: number
  readonly lastInspection?: {
    readonly mode: 'direct' | 'delegated'
    readonly imageCount: number
    readonly provider?: string
    readonly model?: string
    readonly cacheHit: boolean
    readonly usage?: ChannelRuntimeUsage
    readonly errorCode?: string
  }
  readonly lastRestoration?: {
    readonly compactionId: string
    readonly candidateCount: number
    readonly restoredCount: number
    readonly skippedCount: number
    readonly error?: string
  }
  readonly blockers: readonly string[]
}

export const DSH_IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

export const DshImageMediaTypeSchema = z.enum(DSH_IMAGE_MEDIA_TYPES)

export const nekroImageAttachmentId = (
  assetId: AssetId,
  detail: EffectiveImageDetail,
): ReturnType<typeof AttachmentId> => AttachmentId(`nxt-asset:${assetId}:${detail}`)

export const parseNekroImageAttachmentId = (
  attachmentId: string,
): { readonly assetId: AssetId; readonly detail?: EffectiveImageDetail } | undefined => {
  if (!attachmentId.startsWith('nxt-asset:')) {
    const legacy = AssetIdSchema.safeParse(attachmentId)
    return legacy.success ? { assetId: legacy.data } : undefined
  }
  const separator = attachmentId.lastIndexOf(':')
  const detail = attachmentId.slice(separator + 1)
  const assetId = AssetIdSchema.safeParse(attachmentId.slice('nxt-asset:'.length, separator))
  if (!assetId.success || (detail !== 'low' && detail !== 'auto')) return undefined
  return { assetId: assetId.data, detail }
}

export class NekroAssetAttachmentStore extends AttachmentStore {
  readonly imageLimits = {
    maxImageBytes: 128 * 1024 * 1024,
    maxImagesPerMessage: 20,
    maxMessageImageBytes: 256 * 1024 * 1024,
    maxImagePixels: 100_000_000,
    maxImageDimension: 32_768,
    mediaTypes: DSH_IMAGE_MEDIA_TYPES,
  }
  readonly assets: AssetAccessRepository
  readonly assetService: AssetService
  readonly requestImageRoot: string

  constructor(
    context: Context,
    config: { assets: AssetAccessRepository; assetService: AssetService; requestImageRoot: string },
  ) {
    super(context)
    this.assets = config.assets
    this.assetService = config.assetService
    this.requestImageRoot = config.requestImageRoot
  }

  async validateImage(input: SaveImageAttachment): Promise<void> {
    const metadata = await sharp(input.data).metadata()
    if (
      !metadata.width ||
      !metadata.height ||
      metadata.width > this.imageLimits.maxImageDimension ||
      metadata.height > this.imageLimits.maxImageDimension ||
      metadata.width * metadata.height > this.imageLimits.maxImagePixels
    ) {
      throw new Error('Image dimensions are unavailable or exceed the configured limit.')
    }
  }

  saveImage(): Promise<ImageAttachmentRef> {
    return Promise.reject(new Error('NekroNxt images must enter through Asset Service before DSH projection.'))
  }

  async refForAsset(
    asset: AssetRecord,
    name?: string,
    detail: 'low' | 'auto' | 'high' = 'auto',
  ): Promise<ImageAttachmentRef> {
    const mediaType = DshImageMediaTypeSchema.parse(asset.mediaType)
    const metadata = await sharp(this.assetService.blobPath(asset)).metadata()
    if (!metadata.width || !metadata.height) throw new Error(`Asset image dimensions are unavailable: ${asset.id}`)
    return {
      attachmentId: nekroImageAttachmentId(asset.id, effectiveImageDetail(detail)),
      mediaType,
      bytes: asset.byteSize,
      width: metadata.width,
      height: metadata.height,
      ...(name === undefined ? {} : { name: path.basename(name) }),
    }
  }

  async readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment> {
    signal?.throwIfAborted()
    const decoded = parseNekroImageAttachmentId(ref.attachmentId)
    if (!decoded) throw new Error(`Attachment ID is not a NekroNxt Asset reference: ${ref.attachmentId}`)
    const asset = this.assets.getAssetById(decoded.assetId)
    if (!asset) throw new Error(`Attachment Asset is unavailable: ${ref.attachmentId}`)
    const data = new Uint8Array(await readFile(this.assetService.blobPath(asset), { signal }))
    const digest = `sha256:${createHash('sha256').update(data).digest('hex')}`
    if (digest !== asset.contentDigest || data.byteLength !== ref.bytes) {
      throw new Error(`Attachment Asset failed integrity verification: ${asset.id}`)
    }
    return { ref, data }
  }

  override async readImageRequest(
    ref: ImageAttachmentRef,
    policy: ImageRequestTarget,
    signal?: AbortSignal,
  ): Promise<RequestImageAttachment> {
    const decoded = parseNekroImageAttachmentId(ref.attachmentId)
    if (!decoded) throw new Error(`Attachment ID is not a NekroNxt Asset reference: ${ref.attachmentId}`)
    const effectivePolicy =
      decoded.detail === 'low'
        ? { ...policy, width: Math.min(policy.width, 512), height: Math.min(policy.height, 512) }
        : policy
    const stored = await this.readImage(ref, signal)
    const version = await readRequestImageFile(this.requestImageRoot, stored, effectivePolicy, signal)
    // The DeepSeek upload index only accepts `sha256:` attachment IDs and drops the whole index when one record
    // does not match, which re-uploads every image on every step. The variant ID is already computed from the
    // Asset reference, so only the identity handed to the provider adapter switches to the content digest.
    const asset = this.assets.getAssetById(decoded.assetId)
    if (!asset) throw new Error(`Attachment Asset is unavailable: ${ref.attachmentId}`)
    return { ...version, attachment: { ...version.attachment, attachmentId: AttachmentId(asset.contentDigest) } }
  }
}

export const requireNekroAssetAttachmentStore = (store: AttachmentStore): NekroAssetAttachmentStore => {
  if (!(store instanceof NekroAssetAttachmentStore)) {
    throw new TypeError('NekroNxt image projection requires the Host Asset attachment store.')
  }
  return store
}

export type ProductChannelHistoryRepository = DshHostRuntimeOptions['history']

/** Who a channel member is for the agent answering that channel. */
export type ChannelMemberRelation =
  | { readonly kind: 'self' }
  | { readonly kind: 'local-agent'; readonly agentName?: string }
  | { readonly kind: 'member' }

/** Host knowledge of the channel's own account and other local agents' accounts; absent hosts show plain members. */
export interface ChannelMemberRelations {
  describe(memberId: ChannelMemberId): ChannelMemberRelation
  /** The member standing for the channel's own account; it always exists. */
  self(channelId: ChannelId): { readonly memberId: ChannelMemberId; readonly displayName?: string }
  /** Accounts of other agents on this host that answer the same platform channel. */
  localAgents(channelId: ChannelId): readonly {
    readonly memberId: ChannelMemberId
    readonly displayName?: string
    readonly agentName: string
  }[]
}

export type MemberSummary = {
  readonly memberId: string
  readonly displayName?: string
  /** Absent for an ordinary member. */
  readonly relation?: Exclude<ChannelMemberRelation, { kind: 'member' }>
}

export const memberSummary = (
  history: Pick<ProductChannelHistoryRepository, 'getChannelMember'>,
  memberId: NonNullable<ChannelEventRecord['senderMemberId']>,
  relations?: ChannelMemberRelations,
): MemberSummary => {
  const displayName = history.getChannelMember(memberId)?.displayName
  const relation = relations?.describe(memberId)
  return {
    memberId,
    ...(displayName === undefined ? {} : { displayName }),
    ...(relation === undefined || relation.kind === 'member' ? {} : { relation }),
  }
}

/** How a member is named to the agent: the stable member id always, and what the host knows about who it is. */
export const memberLabel = (member: MemberSummary): string => {
  const relation = member.relation
  if (relation?.kind === 'self') return `你（${member.memberId}）`
  const name = member.displayName ?? '未知成员'
  if (relation?.kind === 'local-agent') {
    const owner = relation.agentName === undefined ? '本机另一个账号' : `智能体「${relation.agentName}」的账号`
    return `${name}（${owner}，${member.memberId}）`
  }
  return `${name}（${member.memberId}）`
}

export const historyEntrySenderDescription = (
  history: ProductChannelHistoryRepository,
  entry: ChannelHistoryEntry,
  relations?: ChannelMemberRelations,
): string => {
  if (entry.source === 'outbound-intent') {
    return isAdminConsoleOutbound(entry.sourceTurnId) ? '，管理员用你的账号发的' : '，你发的'
  }
  if (entry.senderMemberId === undefined) return ''
  return `，${memberLabel(memberSummary(history, entry.senderMemberId, relations))}`
}

const HISTORY_LINE_MAX_CHARS = 2000

/** Message parts as one plain-text line for history tools; images stay as references the agent can inspect. */
export const historyPartsText = (
  history: Pick<ProductChannelHistoryRepository, 'getChannelMember'>,
  parts: readonly MessagePart[],
  relations?: ChannelMemberRelations,
): string =>
  parts
    .map((part) => {
      switch (part.type) {
        case 'text':
          return part.text
        case 'mention':
          return `@${memberLabel(memberSummary(history, part.memberId, relations))}`
        case 'image':
          return `[图片 ${part.assetId}${part.alt ? `：${part.alt}` : ''}]`
        case 'file':
          return `[文件 ${part.assetId}${part.name ? `：${part.name}` : ''}]`
        case 'audio':
          return `[语音 ${part.assetId}]`
        case 'quote':
          return `[引用 ${part.messageId}]`
        case 'rich':
          return `[${part.kind === 'forward' ? '转发' : '卡片'}] ${richPartContextText(part)}`
      }
    })
    .join('')

/** One history entry as `[时间 · 消息编号] 发言人：正文`, the same header the agent sees for live messages. */
export const historyEntryLine = (
  history: Pick<ProductChannelHistoryRepository, 'getChannelMember'>,
  entry: ChannelHistoryEntry,
  relations?: ChannelMemberRelations,
  previousAt?: number,
): string => {
  const sender =
    entry.source === 'outbound-intent'
      ? isAdminConsoleOutbound(entry.sourceTurnId)
        ? ' 管理员用你的账号'
        : ' 你'
      : entry.senderMemberId === undefined
        ? ''
        : ` ${memberLabel(memberSummary(history, entry.senderMemberId, relations))}`
  const text = historyPartsText(history, entry.parts, relations).replace(/\s*\n\s*/gu, ' ⏎ ')
  const body =
    text.length > HISTORY_LINE_MAX_CHARS
      ? `${text.slice(0, HISTORY_LINE_MAX_CHARS)}……（后面还有 ${text.length - HISTORY_LINE_MAX_CHARS} 字）`
      : text
  return `[${formatContextTime(entry.occurredAt, previousAt)} · ${entry.logicalMessageId}]${sender}：${body}`
}

/** Header for a due scheduled job; it is a Host fact, not a member message, and does not oblige a reply. */
const extensionJobHeader = (event: ChannelEventRecord): string | undefined => {
  const job = event.facts?.['extensionJob']
  if (job === null || typeof job !== 'object' || Array.isArray(job)) return undefined
  const source = typeof job['extensionName'] === 'string' ? `扩展「${job['extensionName']}」` : '对话创建的定时任务'
  const task = typeof job['jobId'] === 'string' ? `，taskId ${job['jobId']}` : ''
  const scheduledAt = typeof job['scheduledAt'] === 'number' ? formatContextTime(job['scheduledAt']) : '未知'
  const delay =
    typeof job['delayMinutes'] === 'number' && job['delayMinutes'] > 0
      ? `；因为程序没在运行，晚了约 ${job['delayMinutes']} 分钟`
      : ''
  return `〔定时任务到时间了〕来源：${source}${task}；计划时间 ${scheduledAt}${delay}。要不要在群里说话由你决定：`
}

export const DirectImageInspectionValueSchema = z
  .object({
    mode: z.literal('direct'),
    question: z.string().optional(),
    detail: z.enum(['low', 'auto', 'high']),
    effectiveDetail: z.enum(['low', 'auto']),
    images: z.array(
      z
        .object({
          index: z.number().int().nonnegative(),
          assetId: AssetIdSchema,
          status: z.enum(['injected', 'resident', 'detail-upgraded', 'duplicate']),
          duplicateOf: z.number().int().nonnegative().optional(),
          attachment: z.json().optional(),
        })
        .strict(),
    ),
  })
  .strict()

export type EffectiveImageDetail = 'low' | 'auto'

export type ImageProjectionStats = {
  imageCount: number
  injectedCount: number
  duplicateCount: number
  skippedCount: number
  /** Over the backlog's picture budget: left as references the agent can open. */
  deferredCount?: number
}

export const effectiveImageDetail = (detail: 'low' | 'auto' | 'high'): EffectiveImageDetail =>
  detail === 'low' ? 'low' : 'auto'

export const imageDetailRank = (detail: EffectiveImageDetail): number => (detail === 'low' ? 0 : 1)

export const collectVisibleImageResidency = (
  agent: Agent,
  assets: Pick<AssetAccessRepository, 'getAssetById'>,
  baselineDetail: 'low' | 'auto' | 'high' = 'auto',
): Map<string, EffectiveImageDetail> => {
  const residency = new Map<string, EffectiveImageDetail>()
  const baseline = effectiveImageDetail(baselineDetail)
  const visit = (blocks: readonly ContentBlock[]): void => {
    for (const block of blocks) {
      if (block.type === 'image') {
        const parsed = parseNekroImageAttachmentId(block.attachment.attachmentId)
        if (!parsed) continue
        const asset = assets.getAssetById(parsed.assetId)
        const detail = parsed.detail ?? baseline
        if (asset && !residency.has(asset.contentDigest)) residency.set(asset.contentDigest, detail)
      }
    }
  }
  for (const message of agent.session.deriveMessages()) visit(message.content)
  for (const event of sessionEvents(agent.session)) {
    if (
      event.type !== 'nekro-nxt/image-inspection' ||
      event.data.mode !== 'direct' ||
      event.data.result === undefined
    ) {
      continue
    }
    const result = DirectImageInspectionValueSchema.safeParse(event.data.result)
    if (!result.success) continue
    for (const image of result.data.images) {
      if (image.status !== 'injected' && image.status !== 'detail-upgraded') continue
      const digest = event.data.contentDigests[image.index]
      if (digest === undefined || !residency.has(digest)) continue
      const current = residency.get(digest)!
      if (imageDetailRank(result.data.effectiveDetail) > imageDetailRank(current)) {
        residency.set(digest, result.data.effectiveDetail)
      }
    }
  }
  return residency
}

export const collectVisibleImageDigests = (
  agent: Agent,
  assets: Pick<AssetAccessRepository, 'getAssetById'>,
): Set<string> => new Set(collectVisibleImageResidency(agent, assets).keys())

export type NekroCompactionResult = NonNullable<Awaited<ReturnType<BasicCompactionEngine['compactIfNeeded']>>>

/**
 * What the agent is asked to keep when older conversation is condensed. DSH's default is written for a coding
 * assistant; a channel needs people, running games, agreements and promises kept with their exact wording.
 */
export const CHANNEL_COMPACTION_INSTRUCTION = [
  '先停一下，把上面更早的对话整理成一份交接记录，让之后的你接着聊时不丢重要的信息。',
  '',
  '按下面的结构输出，每节用简短的条目，不写成段落；没有内容的节写「（无）」，不要删节：',
  '',
  '## 参与者与称呼',
  '- 谁是谁、成员编号、希望怎么被称呼，和你的关系或常聊的话题',
  '',
  '## 正在进行的事',
  '- 正在聊或正在玩的事情和进展。跑团、游戏、剧本这类要保留设定、人物、掷骰结果、线索和已发生的事件，名字和数字照原文写',
  '',
  '## 约定与要求',
  '- 群规、管理员或成员提出的长期要求，注明是谁说的；被更正过的只写最新的说法',
  '',
  '## 承诺与待办',
  '- 你答应过的事、别人托你做的事、约好的时间地点，以及还没完成的',
  '',
  '## 关键结论',
  '- 大家确认过的结论或决定和依据；只是某人一面之词或玩笑的，注明出处',
  '',
  '## 有用的资料',
  '- 有人分享的链接、文件、图片编号、消息编号，以及它们是什么',
  '',
  '## 你正在做的事',
  '- 这段对话结束时你正在处理的事和下一步',
  '',
  '要求：',
  '- 名字、数字、时间、链接、编号照原文写，不要改写或概括掉。时间写成带日期的绝对时间。',
  '- 玩笑、反讽、没人确认的说法，不要写成事实。',
  '- 不要提这次整理本身，不要调用工具，只输出整理结果。',
  '- 上面如果已经有 <compacted-summary> 包着的旧记录，把仍然有效的内容合并进来、过时的删掉，输出一份完整的新记录。',
].join('\n')

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'nekro-nxt-compaction-instruction': { readonly kind: 'nekro-nxt-compaction-instruction' }
  }
}

export class NekroNxtCompactionEngine extends BasicCompactionEngine {
  private visualRestoreDepth = 0

  /**
   * DSH's own summarizer with the channel instruction: the replayed conversation stays the request prefix, so the
   * provider's cache is reused, and only the final instruction differs.
   */
  protected override async summarize(
    input: Parameters<BasicCompactionEngine['summarize']>[0],
    agent: Parameters<BasicCompactionEngine['summarize']>[1],
    signal?: AbortSignal,
  ): ReturnType<BasicCompactionEngine['summarize']> {
    const routed = agent.session.requestHeader()?.config
    const conversation =
      routed !== undefined && routed.provider.length > 0 && routed.model.length > 0
        ? { provider: routed.provider, model: routed.model }
        : agent.options.provider && agent.options.model
          ? { provider: agent.options.provider, model: agent.options.model }
          : undefined
    const policy =
      conversation === undefined
        ? undefined
        : this.config.modelPolicies.find(
            (candidate) => candidate.provider === conversation.provider && candidate.model === conversation.model,
          )
    const summarizationProvider = policy?.summarizationProvider ?? this.config.summarizationProvider
    const maxTokens = policy?.maxTokens ?? this.config.maxTokens
    const target =
      summarizationProvider.length > 0
        ? { provider: summarizationProvider, model: policy?.summarizationModel ?? this.config.summarizationModel }
        : conversation
    if (target === undefined) throw new Error('No provider/model is available for compaction.')
    const assembler = new BlockAssembler()
    const options = {
      provider: target.provider,
      model: target.model,
      messages: [
        ...input.messages,
        // Request-only, like DSH's own instruction: it is never written to the session log.
        freezeMessage({
          id: MessageId('nxt-compaction-instruction'),
          role: 'user',
          content: [{ type: 'text', text: CHANNEL_COMPACTION_INSTRUCTION }],
          source: { kind: 'nekro-nxt-compaction-instruction' },
        }) satisfies UserMessage,
      ],
      toolHistory: agent.session.toolHistory(),
      ...(input.tools === undefined ? {} : { tools: [...input.tools] }),
      maxTokens,
      sessionId: agent.session.id,
      purpose: 'compaction' as const,
      ...(signal === undefined ? {} : { signal }),
    }
    for await (const chunk of this.ctx.llm.stream(options)) assembler.push(chunk)
    const finish = assembler.finish
    if (finish.kind === 'error' || finish.kind === 'aborted') {
      throw new LlmError(finish.failure.message, finish.failure.code, finish.failure)
    }
    if (finish.kind === 'max-tokens') throw new Error('Compaction summary was cut off at the token limit.')
    const rawOutput = assembler.blocks()
    if (contentHasImage(rawOutput))
      throw new LlmError('Compaction summary cannot contain images.', 'UNSUPPORTED_CONTENT')
    const summary = rawOutput.filter((block): block is TextBlock => block.type === 'text')
    if (!summary.some((block) => block.text.trim().length > 0)) throw new Error('Compaction produced no summary text.')
    return {
      summary,
      rawOutput,
      llmStreamCall: true,
      provider: options.provider,
      model: options.model,
      maxTokens,
      ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
    }
  }
  private visualRestoreHandler: ((result: NekroCompactionResult, agent: Agent) => Promise<void>) | undefined

  setVisualRestore(handler: (result: NekroCompactionResult, agent: Agent) => Promise<void>): void {
    this.visualRestoreHandler = handler
  }

  override async compactIfNeeded(
    agent: Parameters<BasicCompactionEngine['compactIfNeeded']>[0],
    trigger: Parameters<BasicCompactionEngine['compactIfNeeded']>[1],
    signal: Parameters<BasicCompactionEngine['compactIfNeeded']>[2],
  ): ReturnType<BasicCompactionEngine['compactIfNeeded']> {
    return this.runWithVisualRestore(() => super.compactIfNeeded(agent, trigger, signal), agent)
  }

  override async compactNow(
    agent: Parameters<BasicCompactionEngine['compactNow']>[0],
    signal: Parameters<BasicCompactionEngine['compactNow']>[1],
    sourceCommandId?: Parameters<BasicCompactionEngine['compactNow']>[2],
  ): ReturnType<BasicCompactionEngine['compactNow']> {
    return this.runWithVisualRestore(() => super.compactNow(agent, signal, sourceCommandId), agent)
  }

  override async compactRegion(
    start: Parameters<BasicCompactionEngine['compactRegion']>[0],
    end: Parameters<BasicCompactionEngine['compactRegion']>[1],
    agent: Parameters<BasicCompactionEngine['compactRegion']>[2],
    signal?: Parameters<BasicCompactionEngine['compactRegion']>[3],
  ): ReturnType<BasicCompactionEngine['compactRegion']> {
    const result = await this.runWithVisualRestore(() => super.compactRegion(start, end, agent, signal), agent)
    if (!result) throw new Error('DSH compactRegion unexpectedly returned no result.')
    return result
  }

  private async runWithVisualRestore<T extends NekroCompactionResult | null>(
    operation: () => Promise<T>,
    agent: Agent,
  ): Promise<T> {
    this.visualRestoreDepth += 1
    try {
      const result = await operation()
      if (this.visualRestoreDepth === 1 && result && this.visualRestoreHandler) {
        try {
          await this.visualRestoreHandler(result, agent)
        } catch {
          // The DSH compaction has already committed. Visual restoration is a
          // best-effort append and must never make that committed compaction
          // appear to have rolled back.
        }
      }
      return result
    } finally {
      this.visualRestoreDepth -= 1
    }
  }
}
export class SessionImageContext {
  readonly #context: Context
  readonly #sessions: SessionRegistry<unknown>
  readonly #history: ProductChannelHistoryRepository
  readonly #members: ChannelMemberRelations | undefined
  readonly #assets: AssetAccessRepository
  constructor(
    context: Context,
    sessions: SessionRegistry<unknown>,
    history: ProductChannelHistoryRepository,
    assets: AssetAccessRepository,
    members?: ChannelMemberRelations,
  ) {
    this.#context = context
    this.#sessions = sessions
    this.#history = history
    this.#assets = assets
    this.#members = members
  }
  async getAgentImageDiagnostics(revision: AgentRevisionRecord): Promise<AgentImageDiagnostics> {
    const blockers: string[] = []
    let route: AgentImageDiagnostics['route']
    try {
      const primary = await this.#context.llm.resolveModelInfo(revision.model.provider, revision.model.model)
      if (primary.inputModalities?.includes('image')) {
        route = { mode: 'direct', provider: revision.model.provider, model: revision.model.model }
      } else if (revision.imagePolicy.textModel.mode === 'auxiliary') {
        const selection = revision.imagePolicy.textModel.model
        try {
          const auxiliary = await this.#context.llm.resolveModelInfo(selection.provider, selection.model)
          if (auxiliary.inputModalities?.includes('image')) {
            route = { mode: 'delegated', provider: selection.provider, model: selection.model }
          } else {
            route = { mode: 'unavailable' }
            blockers.push('看图模型没有声明支持图片。')
          }
        } catch {
          route = { mode: 'unavailable' }
          blockers.push('看图模型现在不可用。')
        }
      } else {
        route = { mode: 'unavailable' }
        blockers.push(
          primary.inputModalities === undefined
            ? '主模型不支持图片，也没有设置看图模型。'
            : '主模型不支持图片，也没有设置看图模型。',
        )
      }
    } catch {
      route = { mode: 'unavailable' }
      blockers.push('主模型现在不可用，看不了图片。')
    }

    const sessions = [...this.#sessions.records()]
      .map((record) => [record.sessionId, record.revision.agentId] as const)
      .filter(([, agentId]) => agentId === revision.agentId)
      .flatMap(([sessionId]) => {
        const agent = this.#context.agents.get(SessionId(sessionId))
        return agent === undefined ? [] : [agent]
      })
    let residentImages = 0
    let duplicateImagesSkipped = 0
    let latestInspection:
      { readonly time: number; readonly data: SessionEvent<'nekro-nxt/image-inspection'>['data'] } | undefined
    let latestRestoration:
      { readonly time: number; readonly data: SessionEvent<'nekro-nxt/image-restoration'>['data'] } | undefined
    for (const agent of sessions) {
      residentImages += collectVisibleImageResidency(agent, this.#assets, revision.imagePolicy.history.detail).size
      for (const event of sessionEvents(agent.session)) {
        if (event.type === 'nekro-nxt/image-admission') {
          duplicateImagesSkipped += event.data.duplicateCount
        } else if (event.type === 'nekro-nxt/image-inspection') {
          if (latestInspection === undefined || event.time > latestInspection.time) {
            latestInspection = { time: event.time, data: event.data }
          }
        } else if (event.type === 'nekro-nxt/image-restoration') {
          if (latestRestoration === undefined || event.time > latestRestoration.time) {
            latestRestoration = { time: event.time, data: event.data }
          }
        }
      }
    }
    return {
      route,
      activeSessions: sessions.length,
      residentImages,
      duplicateImagesSkipped,
      ...(latestInspection === undefined
        ? {}
        : {
            lastInspection: {
              mode: latestInspection.data.mode,
              imageCount: latestInspection.data.assetIds.length,
              ...(latestInspection.data.provider === undefined ? {} : { provider: latestInspection.data.provider }),
              ...(latestInspection.data.model === undefined ? {} : { model: latestInspection.data.model }),
              cacheHit: latestInspection.data.cacheHit,
              ...(latestInspection.data.usage === undefined
                ? {}
                : { usage: projectTokenUsage(latestInspection.data.usage) }),
              ...(latestInspection.data.errorCode === undefined ? {} : { errorCode: latestInspection.data.errorCode }),
            },
          }),
      ...(latestRestoration === undefined
        ? {}
        : {
            lastRestoration: {
              compactionId: latestRestoration.data.compactionId,
              candidateCount: latestRestoration.data.candidateCount,
              restoredCount: latestRestoration.data.restoredAssetIds.length,
              skippedCount: latestRestoration.data.skippedAssetIds.length,
              ...(latestRestoration.data.error === undefined ? {} : { error: latestRestoration.data.error }),
            },
          }),
      blockers,
    }
  }

  async restoreLatestPendingVisualContext(agent: Agent): Promise<void> {
    const latest = [...sessionEvents(agent.session)]
      .reverse()
      .find((event) => event.type === 'compaction/end' && event.data.error === undefined)
    if (latest?.type !== 'compaction/end') return
    const compactionId = String(latest.data.compactionId)
    const settled = sessionEvents(agent.session).some(
      (event) =>
        (event.type === 'nekro-nxt/image-restoration' && event.data.compactionId === compactionId) ||
        (event.type === 'user/message' &&
          event.data.source.kind === 'nekro-nxt-visual-restore' &&
          event.data.source.compactionId === compactionId),
    )
    if (!settled) await this.restoreVisualContext(agent, compactionId)
  }

  async restoreVisualContext(agent: Agent, compactionId: string): Promise<void> {
    const sessionId = String(agent.session.id)
    if (!this.#sessions.get(sessionId)?.imageInput) return
    const channelId = this.#sessions.get(sessionId)?.channelId
    const episodeId = this.#sessions.get(sessionId)?.episodeId
    const revision = this.#sessions.get(sessionId)?.revision
    if (!channelId || !episodeId || !revision) return
    if (
      sessionEvents(agent.session).some(
        (event) =>
          (event.type === 'nekro-nxt/image-restoration' && event.data.compactionId === compactionId) ||
          (event.type === 'user/message' &&
            event.data.source.kind === 'nekro-nxt-visual-restore' &&
            event.data.source.compactionId === compactionId),
      )
    ) {
      return
    }
    const skippedAssetIds: string[] = []
    try {
      const policy = revision.imagePolicy.history.restoreAfterCompaction
      const entries = [...this.#history.listEpisodeHistory(episodeId, { limit: policy.recentMessages })].reverse()
      const byDigest = new Map<
        string,
        {
          readonly asset: AssetRecord
          readonly occurredAt: number
          readonly ordinal: number
          readonly sourceMessageIds: string[]
        }
      >()
      let ordinal = 0
      for (const entry of entries) {
        for (const part of entry.parts) {
          for (const assetId of messagePartAssetIds(part)) {
            ordinal += 1
            if (!this.#assets.canAccessAsset(assetId, channelId)) {
              skippedAssetIds.push(assetId)
              continue
            }
            const asset = this.#assets.getAssetById(assetId)
            if (!asset?.mediaType.startsWith('image/')) {
              skippedAssetIds.push(assetId)
              continue
            }
            const previous = byDigest.get(asset.contentDigest)
            byDigest.set(asset.contentDigest, {
              asset,
              occurredAt: entry.occurredAt,
              ordinal,
              sourceMessageIds: [...(previous?.sourceMessageIds ?? []), String(entry.sourceId)],
            })
          }
        }
      }
      const visible = collectVisibleImageDigests(agent, this.#assets)
      const candidates = [...byDigest.entries()]
        .filter(([digest]) => !visible.has(digest))
        .sort((left, right) => right[1].occurredAt - left[1].occurredAt || right[1].ordinal - left[1].ordinal)
      const selected = candidates
        .slice(0, policy.maxImages)
        .sort((left, right) => left[1].occurredAt - right[1].occurredAt || left[1].ordinal - right[1].ordinal)
      const prepared: Array<{
        readonly assetId: string
        readonly contentDigest: string
        readonly sourceMessageIds: readonly string[]
        readonly attachment: ImageAttachmentRef
      }> = []
      for (const [contentDigest, candidate] of selected) {
        try {
          const attachment = await requireNekroAssetAttachmentStore(this.#context.attachments).refForAsset(
            candidate.asset,
            undefined,
            revision.imagePolicy.history.detail,
          )
          await this.#context.attachments.readImage(attachment)
          prepared.push({
            assetId: candidate.asset.id,
            contentDigest,
            sourceMessageIds: candidate.sourceMessageIds,
            attachment,
          })
        } catch {
          skippedAssetIds.push(candidate.asset.id)
        }
      }
      const makeRestoreMessage = (assetsToRestore: typeof prepared): UserMessage => {
        const sourceMessageIds = [...new Set(assetsToRestore.flatMap((asset) => asset.sourceMessageIds))]
        const blocks: ContentBlock[] = [
          {
            type: 'text',
            text: '〔之前聊天里的图片〕重新附上方便你回看，不是新消息。',
          },
        ]
        for (const asset of assetsToRestore) {
          blocks.push({
            type: 'text',
            text: `恢复图片 ${asset.assetId}；来源消息：${asset.sourceMessageIds.join('、')}。`,
          })
          blocks.push({ type: 'image', attachment: asset.attachment })
        }
        return freezeMessage({
          id: MessageId(`nxt-visual-${compactionId}`),
          role: 'user',
          content: blocks,
          source: {
            kind: 'nekro-nxt-visual-restore',
            compactionId,
            policyVersion: 1,
            sourceMessageIds,
            assets: assetsToRestore.map(({ assetId, contentDigest, sourceMessageIds }) => ({
              assetId,
              contentDigest,
              sourceMessageIds,
            })),
          },
        }) satisfies UserMessage
      }
      const restoredAssets = [...prepared]
      if (restoredAssets.length > 0) {
        const modelInfo = await this.#context.llm.resolveModelInfo(revision.model.provider, revision.model.model)
        const contextWindow = modelInfo.context?.contextWindow
        const compaction = this.#context.compaction
        if (contextWindow !== undefined && compaction instanceof NekroNxtCompactionEngine) {
          const modelPolicy = compaction.config.modelPolicies.find(
            (candidate) => candidate.provider === revision.model.provider && candidate.model === revision.model.model,
          )
          const thresholdRatio = modelPolicy?.thresholdRatio ?? compaction.config.thresholdRatio
          const thresholdTokens = Math.floor(contextWindow * thresholdRatio)
          const currentTokens = this.#context.tokenMeter.measure(agent.session).totalTokens
          while (
            restoredAssets.length > 0 &&
            currentTokens + this.#context.tokenMeter.estimateMessage(makeRestoreMessage(restoredAssets)) >
              thresholdTokens
          ) {
            const omitted = restoredAssets.shift()
            if (omitted) skippedAssetIds.push(omitted.assetId)
          }
        }
      }
      if (restoredAssets.length > 0) {
        const message = makeRestoreMessage(restoredAssets)
        agent.session.append('user/message', message, { surfaceOp: 'append' })
      }
      agent.session.append('nekro-nxt/image-restoration', {
        compactionId,
        candidateCount: candidates.length,
        restoredAssetIds: restoredAssets.map(({ assetId }) => assetId),
        skippedAssetIds,
      })
      await this.#context.sessions.flush(agent.session)
    } catch (error) {
      agent.session.append('nekro-nxt/image-restoration', {
        compactionId,
        candidateCount: 0,
        restoredAssetIds: [],
        skippedAssetIds,
        error: error instanceof Error ? error.message : String(error),
      })
      await this.#context.sessions.flush(agent.session)
    }
  }

  async projectMessageParts(
    sessionId: SessionId,
    channelId: ChannelId,
    parts: readonly MessagePart[],
    visibleDigests: Set<string>,
    imageStats?: ImageProjectionStats,
    expandQuotes = true,
    pictures?: ReadonlySet<AssetId>,
  ): Promise<ContentBlock[]> {
    const blocks: ContentBlock[] = []
    const attachImage = async (assetId: AssetId, alt?: string): Promise<void> => {
      if (!this.#assets.canAccessAsset(assetId, channelId)) {
        if (imageStats) imageStats.skippedCount += 1
        blocks.push({ type: 'text', text: `图片资源 ${assetId} 当前不可访问。` })
        return
      }
      const asset = this.#assets.getAssetById(assetId)
      if (!asset) {
        if (imageStats) imageStats.skippedCount += 1
        blocks.push({ type: 'text', text: `图片资源 ${assetId} 的元数据不可用。` })
        return
      }
      if (!asset.mediaType.startsWith('image/')) {
        if (imageStats) imageStats.skippedCount += 1
        blocks.push({ type: 'text', text: `资源 ${assetId} 不是可注入的图片。` })
        return
      }
      if (imageStats) imageStats.imageCount += 1
      if (this.#sessions.get(sessionId)?.imageInput) {
        if (pictures !== undefined && !pictures.has(assetId)) {
          if (imageStats) imageStats.deferredCount = (imageStats.deferredCount ?? 0) + 1
          blocks.push({ type: 'text', text: '（这张没直接给你看，要看用 asset_inspect_images）' })
          return
        }
        if (visibleDigests.has(asset.contentDigest)) {
          if (imageStats) imageStats.duplicateCount += 1
          blocks.push({
            type: 'text',
            text: `[图片 ${assetId}，和前面的一张相同]`,
          })
          return
        }
        const detail = this.#sessions.get(String(sessionId))?.revision?.imagePolicy.history.detail ?? 'auto'
        const attachment = await requireNekroAssetAttachmentStore(this.#context.attachments).refForAsset(
          asset,
          alt,
          detail,
        )
        blocks.push({ type: 'image', attachment })
        visibleDigests.add(asset.contentDigest)
        if (imageStats) imageStats.injectedCount += 1
        return
      }
      blocks.push({
        type: 'text',
        text: `[图片 ${asset.id}]（你看不到图片本身，需要时用 asset_inspect_images）`,
      })
    }
    for (const part of parts) {
      switch (part.type) {
        case 'text':
          blocks.push({ type: 'text', text: part.text })
          break
        case 'mention': {
          blocks.push({
            type: 'text',
            text: `@${memberLabel(memberSummary(this.#history, part.memberId, this.#members))}`,
          })
          break
        }
        case 'image':
          blocks.push({
            type: 'text',
            text: `[图片 ${part.assetId}${part.alt ? `：${part.alt}` : ''}]`,
          })
          await attachImage(part.assetId, part.alt)
          break
        case 'file':
          blocks.push({
            type: 'text',
            text: `[文件 ${part.assetId}${part.name ? `：${part.name}` : ''}]（小的文本文件可以用 asset_read_text 读）`,
          })
          break
        case 'audio':
          blocks.push({ type: 'text', text: `[语音 ${part.assetId}]` })
          break
        case 'quote': {
          if (!expandQuotes) {
            blocks.push({ type: 'text', text: `[引用 ${part.messageId}]` })
            break
          }
          const quoted = this.#history.getChannelHistoryEntryByLogicalMessageId(channelId, part.messageId)
          if (quoted === undefined) {
            blocks.push({
              type: 'text',
              text: `[引用 ${part.messageId}，原消息找不到了]`,
            })
            break
          }
          blocks.push({
            type: 'text',
            text: `[引用 ${part.messageId}（${formatContextTime(quoted.occurredAt)}${historyEntrySenderDescription(this.#history, quoted, this.#members)}）：`,
          })
          blocks.push(
            ...(await this.projectMessageParts(sessionId, channelId, quoted.parts, visibleDigests, imageStats, false)),
          )
          break
        }
        case 'rich': {
          const context = richPartContextText(part)
          const label = part.kind === 'forward' ? '收到转发' : '收到卡片'
          blocks.push({ type: 'text', text: `${label}：${context.includes('\n') ? `\n${context}` : context}` })
          for (const assetId of messagePartAssetIds(part)) {
            blocks.push({ type: 'text', text: `卡片图片资源 ${assetId}` })
            await attachImage(assetId)
          }
          break
        }
      }
    }
    return blocks
  }

  /**
   * `previousAt` is the receive time of the event projected just before this one in the same batch; a message on the
   * same day then states only its clock time.
   */
  async projectEvent(
    sessionId: SessionId,
    event: ChannelEventRecord,
    visibleDigests?: Set<string>,
    imageStats?: ImageProjectionStats,
    previousAt?: number,
    pictures?: ReadonlySet<AssetId>,
  ): Promise<ContentBlock[]> {
    const sender =
      event.senderMemberId === undefined ? undefined : memberSummary(this.#history, event.senderMemberId, this.#members)
    const senderDescription = sender === undefined ? '' : ` ${memberLabel(sender)}`
    // A mention of the account already reads 「@你」 in place; the note covers platforms that @ without a mention part.
    const mentionsSelf = event.parts.some(
      (part) => part.type === 'mention' && this.#members?.describe(part.memberId).kind === 'self',
    )
    const mentionDescription = event.facts?.['mentionedBot'] === true && !mentionsSelf ? '（提到了你）' : ''
    const job = extensionJobHeader(event)
    const time = formatContextTime(event.receivedAt, previousAt)
    const blocks: ContentBlock[] = [
      {
        type: 'text',
        text: job ?? `[${time} · ${event.logicalMessageId}]${senderDescription}${mentionDescription}：`,
      },
    ]
    const seen =
      visibleDigests ??
      (() => {
        const agent = this.#context.agents.get(sessionId)
        return agent === undefined ? new Set<string>() : collectVisibleImageDigests(agent, this.#assets)
      })()
    blocks.push(
      ...(await this.projectMessageParts(sessionId, event.channelId, event.parts, seen, imageStats, true, pictures)),
    )
    return blocks
  }
}
