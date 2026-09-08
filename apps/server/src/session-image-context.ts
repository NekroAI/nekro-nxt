import type { DshHostRuntimeOptions } from './index.js'
import type { Context } from '@deepseek-ai/cordis'
import { type Agent } from '@deepseek-ai/dsh-agent'
import AttachmentStore, {
  AttachmentId,
  type ImageAttachmentRef,
  type ImageRequestPolicy,
  type RequestImageAttachment,
  type SaveImageAttachment,
  type StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { readRequestImageFile } from '@deepseek-ai/dsh-attachment-local'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { freezeMessage, MessageId, type ContentBlock, type TokenUsage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { isAdminConsoleOutbound, type ChannelHistoryEntry } from '@nekro-nxt/channel-runtime'
import {
  AssetIdSchema,
  messagePartAssetIds,
  richPartContextText,
  type AssetId,
  type ChannelId,
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
    readonly usage?: TokenUsage
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
    policy: ImageRequestPolicy,
    signal?: AbortSignal,
  ): Promise<RequestImageAttachment> {
    const decoded = parseNekroImageAttachmentId(ref.attachmentId)
    if (!decoded) throw new Error(`Attachment ID is not a NekroNxt Asset reference: ${ref.attachmentId}`)
    const effectivePolicy =
      decoded.detail === 'low' ? { ...policy, maxPixels: Math.min(policy.maxPixels, 512 * 512) } : policy
    return readRequestImageFile(this.requestImageRoot, await this.readImage(ref, signal), effectivePolicy, signal)
  }
}

export const requireNekroAssetAttachmentStore = (store: AttachmentStore): NekroAssetAttachmentStore => {
  if (!(store instanceof NekroAssetAttachmentStore)) {
    throw new TypeError('NekroNxt image projection requires the Host Asset attachment store.')
  }
  return store
}

export type ProductChannelHistoryRepository = DshHostRuntimeOptions['history']

export const memberSummary = (
  history: ProductChannelHistoryRepository,
  memberId: NonNullable<ChannelEventRecord['senderMemberId']>,
): { readonly memberId: string; readonly displayName?: string } => {
  const displayName = history.getChannelMember(memberId)?.displayName
  return { memberId, ...(displayName === undefined ? {} : { displayName }) }
}

export const historyEntrySenderDescription = (
  history: ProductChannelHistoryRepository,
  entry: ChannelHistoryEntry,
): string => {
  if (entry.source === 'outbound-intent') {
    return isAdminConsoleOutbound(entry.sourceTurnId) ? '，管理员此前通过机器人账号发送' : '，本频道智能体此前发送'
  }
  if (entry.senderMemberId === undefined) return ''
  const sender = memberSummary(history, entry.senderMemberId)
  return `，发送成员：${sender.displayName ?? '未知成员'}（成员标识 ${sender.memberId}）`
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
      } else if (block.type === 'tool-result') visit(block.content)
    }
  }
  for (const message of agent.session.deriveMessages()) visit(message.content)
  for (const event of agent.session.events) {
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

export class NekroNxtCompactionEngine extends BasicCompactionEngine {
  private visualRestoreDepth = 0
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
  readonly #assets: AssetAccessRepository
  constructor(
    context: Context,
    sessions: SessionRegistry<unknown>,
    history: ProductChannelHistoryRepository,
    assets: AssetAccessRepository,
  ) {
    this.#context = context
    this.#sessions = sessions
    this.#history = history
    this.#assets = assets
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
            blockers.push('配置的辅助视觉模型没有明确声明支持图片输入。')
          }
        } catch {
          route = { mode: 'unavailable' }
          blockers.push('配置的辅助视觉模型当前不可用。')
        }
      } else {
        route = { mode: 'unavailable' }
        blockers.push(
          primary.inputModalities === undefined
            ? '主模型没有声明图片输入能力，且未配置辅助视觉模型。'
            : '主模型仅支持文本，且未配置辅助视觉模型。',
        )
      }
    } catch {
      route = { mode: 'unavailable' }
      blockers.push('主模型当前不可用，无法建立图片理解路由。')
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
      for (const event of agent.session.events) {
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
              ...(latestInspection.data.usage === undefined ? {} : { usage: latestInspection.data.usage }),
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
    const latest = [...agent.session.events]
      .reverse()
      .find((event) => event.type === 'compaction/end' && event.data.error === undefined)
    if (latest?.type !== 'compaction/end') return
    const compactionId = String(latest.data.compactionId)
    const settled = agent.session.events.some(
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
      agent.session.events.some(
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
            text: '以下原图来自当前频道最近消息，是压缩后的视觉上下文恢复，不是新的频道消息。',
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
        if (visibleDigests.has(asset.contentDigest)) {
          if (imageStats) imageStats.duplicateCount += 1
          blocks.push({
            type: 'text',
            text: `图片资源 ${assetId} 与当前上下文中已驻留图片内容相同，沿用已有视觉内容。`,
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
        text: `图片资源 ${asset.id} 已收到，但当前模型不直接支持图片输入；如已配置辅助视觉模型，可使用 asset_inspect_images 批量理解。`,
      })
    }
    for (const part of parts) {
      switch (part.type) {
        case 'text':
          blocks.push({ type: 'text', text: part.text })
          break
        case 'mention': {
          const member = memberSummary(this.#history, part.memberId)
          blocks.push({
            type: 'text',
            text: `@${member.displayName ?? '未知成员'}（成员标识 ${member.memberId}）`,
          })
          break
        }
        case 'image':
          blocks.push({
            type: 'text',
            text: `收到图片资源 ${part.assetId}${part.alt ? `（${part.alt}）` : ''}`,
          })
          await attachImage(part.assetId, part.alt)
          break
        case 'file':
          blocks.push({
            type: 'text',
            text: `收到文件资源 ${part.assetId}${part.name ? `（${part.name}）` : ''}`,
          })
          break
        case 'audio':
          blocks.push({ type: 'text', text: `收到音频资源 ${part.assetId}` })
          break
        case 'quote': {
          if (!expandQuotes) {
            blocks.push({ type: 'text', text: `引用频道消息 ${part.messageId}` })
            break
          }
          const quoted = this.#history.getChannelHistoryEntryByLogicalMessageId(channelId, part.messageId)
          if (quoted === undefined) {
            blocks.push({
              type: 'text',
              text: `引用频道消息 ${part.messageId}，当前频道中无法读取该消息`,
            })
            break
          }
          blocks.push({
            type: 'text',
            text: `引用频道消息 ${part.messageId}${historyEntrySenderDescription(this.#history, quoted)}：`,
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

  async projectEvent(
    sessionId: SessionId,
    event: ChannelEventRecord,
    visibleDigests?: Set<string>,
    imageStats?: ImageProjectionStats,
  ): Promise<ContentBlock[]> {
    const sender = event.senderMemberId === undefined ? undefined : memberSummary(this.#history, event.senderMemberId)
    const senderDescription =
      sender === undefined ? '' : `，发送成员：${sender.displayName ?? '未知成员'}（成员标识 ${sender.memberId}）`
    const mentionDescription = event.facts?.['mentionedBot'] === true ? '；该消息提及了当前智能体关联的机器人账号' : ''
    const blocks: ContentBlock[] = [
      { type: 'text', text: `频道消息 ${event.logicalMessageId}${senderDescription}${mentionDescription}：` },
    ]
    const seen =
      visibleDigests ??
      (() => {
        const agent = this.#context.agents.get(sessionId)
        return agent === undefined ? new Set<string>() : collectVisibleImageDigests(agent, this.#assets)
      })()
    blocks.push(...(await this.projectMessageParts(sessionId, event.channelId, event.parts, seen, imageStats)))
    return blocks
  }
}
