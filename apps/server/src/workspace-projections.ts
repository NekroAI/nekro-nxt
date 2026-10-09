import {
  activityDurationMs,
  AgentIdSchema,
  AgentRevisionIdSchema,
  CHANNEL_UNREAD_COUNT_CAP,
  ChannelIdSchema,
  HostApiContracts,
  OutboundIntentIdSchema,
  type AgentId,
  type AgentRevisionHistory,
  type AgentRevisionId,
  type AttentionItem,
  type ChannelActivitySeries,
  type ChannelActivitySummary,
  type ChannelId,
  type ChannelPendingContext,
  type HostApiResponse,
  type HostSseEvent,
  type MessagePart,
  type OutboundIntentId,
} from '@nekro-nxt/contracts'
import { ChannelStopConflictError, isAdminConsoleOutbound } from '@nekro-nxt/channel-runtime'
import type { ChannelEventRecord } from '@nekro-nxt/core'
import { OutboundResolutionError, type ChannelReadPosition } from '@nekro-nxt/storage-sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { NekroRuntime } from './bootstrap.js'
import { viewerKeyFromRequest } from './viewer.js'
import { assembleChannelRuntime } from './host-queries.js'
import {
  readBinaryBody,
  readJsonBody,
  writeContractJson,
  writeError,
  type HostRouteContext,
} from './host-route-support.js'

const PREVIEW_MAX = 80
const ATTENTION_DELIVERY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const ATTENTION_DELIVERY_LIMIT = 50
const ATTENTION_DISMISSAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const ATTENTION_RECHECK_DEBOUNCE_MS = 400
const ATTENTION_SAFETY_INTERVAL_MS = 30_000
const AVATAR_MAX_BYTES = 2 * 1024 * 1024
const AVATAR_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

const truncate = (value: string, max: number): string => {
  const characters = [...value]
  return characters.length <= max ? value : `${characters.slice(0, max - 1).join('')}…`
}

const channelDisplayName = (runtime: NekroRuntime, channelId: ChannelId): string => {
  const channel = runtime.repository.getChannel(channelId)
  if (channel === undefined) return '已删除的频道'
  return (
    channel.displayName ??
    (channel.kind === 'group' ? '未命名群聊' : channel.kind === 'direct' ? '未命名私聊' : '未命名内置频道')
  )
}

const agentDisplayName = (runtime: NekroRuntime, agentId: AgentId): string =>
  runtime.repository.getAgent(agentId)?.revision.displayName ?? '已删除的智能体'

/** One line of safe plain text for list previews; media become bracketed labels. */
export const previewMessageParts = (runtime: NekroRuntime, parts: readonly MessagePart[]): string => {
  const text = parts
    .map((part) => {
      switch (part.type) {
        case 'text':
          return part.text
        case 'mention':
          return `@${runtime.repository.getChannelMember(part.memberId)?.displayName ?? '成员'}`
        case 'image':
          return '[图片]'
        case 'file':
          return part.name === undefined ? '[文件]' : `[文件] ${part.name}`
        case 'audio':
          return '[语音]'
        case 'quote':
          return ''
        case 'rich':
          return part.summary
      }
    })
    .join(' ')
    .replaceAll(/\s+/gu, ' ')
    .trim()
  return truncate(text, PREVIEW_MAX)
}

const memberName = (runtime: NekroRuntime, event: ChannelEventRecord): string =>
  (event.senderMemberId === undefined
    ? undefined
    : runtime.repository.getChannelMember(event.senderMemberId)?.displayName) ?? '成员'

type ActivityQuery = ReturnType<typeof HostApiContracts.getChannelActivity.parseParams>

/**
 * Client workspace read models over durable facts: per-viewer unread positions, activity series, the attention
 * queue and administrator delivery resolutions. None of them introduces a second source of channel truth.
 */
export class WorkspaceProjections {
  readonly #runtime: NekroRuntime
  readonly #broadcast: (event: HostSseEvent) => void
  readonly #now: () => number
  readonly #unhealthySince = new Map<string, { readonly state: string; readonly since: number }>()
  #attentionRevision: string | undefined
  #attentionTimer: ReturnType<typeof setTimeout> | undefined
  #attentionCheck: Promise<void> | undefined
  #attentionDirty = false
  readonly #safetyTimer: ReturnType<typeof setInterval>
  #disposed = false

  constructor(runtime: NekroRuntime, broadcast: (event: HostSseEvent) => void, now: () => number = Date.now) {
    this.#runtime = runtime
    this.#broadcast = broadcast
    this.#now = now
    this.#safetyTimer = setInterval(() => this.scheduleAttentionCheck(), ATTENTION_SAFETY_INTERVAL_MS)
    this.#safetyTimer.unref?.()
  }

  dispose(): void {
    this.#disposed = true
    clearInterval(this.#safetyTimer)
    if (this.#attentionTimer !== undefined) clearTimeout(this.#attentionTimer)
  }

  // ---------------------------------------------------------------- channel activity

  /** Activity for every listed Channel from one viewer's perspective. */
  channelActivity(viewerKey: string, channelIds: readonly ChannelId[]): ReadonlyMap<ChannelId, ChannelActivitySummary> {
    const projections = this.#runtime.repository.projections
    const baseline = projections.ensureReadViewer(viewerKey, this.#now())
    const positions = projections.listChannelReadPositions(viewerKey)
    return new Map(
      channelIds.map((channelId) => [
        channelId,
        this.#summarize(channelId, positions.get(channelId) ?? { readAt: baseline, readSourceId: '' }),
      ]),
    )
  }

  #summarize(channelId: ChannelId, position: ChannelReadPosition): ChannelActivitySummary {
    const projections = this.#runtime.repository.projections
    const inbound = projections.getLatestVisibleInbound(channelId)
    const outbound = projections.getLatestOutbound(channelId)
    const unread = projections.countUnreadMemberMessages(channelId, position, CHANNEL_UNREAD_COUNT_CAP)
    let lastMessage: ChannelActivitySummary['lastMessage']
    if (inbound !== undefined && (outbound === undefined || inbound.receivedAt >= outbound.createdAt)) {
      lastMessage = {
        role: inbound.activityKey === undefined ? 'member' : 'system',
        author: truncate(inbound.activityKey === undefined ? memberName(this.#runtime, inbound) : '频道活动', 120),
        preview: previewMessageParts(this.#runtime, inbound.parts),
        occurredAt: inbound.receivedAt,
      }
    } else if (outbound !== undefined) {
      const admin = isAdminConsoleOutbound(outbound.sourceTurnId)
      lastMessage = {
        role: admin ? 'admin' : 'agent',
        author: truncate(
          admin
            ? '管理员'
            : (this.#runtime.repository.getAgentRevision(outbound.agentRevisionId)?.displayName ?? '智能体'),
          120,
        ),
        preview: previewMessageParts(this.#runtime, outbound.parts),
        occurredAt: outbound.createdAt,
      }
    }
    return {
      ...(lastMessage === undefined ? {} : { lastActivityAt: lastMessage.occurredAt, lastMessage }),
      unreadCount: unread.count,
      unreadCapped: unread.capped,
    }
  }

  markRead(
    viewerKey: string,
    channelId: ChannelId,
    upTo?: { readonly occurredAt: number; readonly sourceId: string },
  ): ChannelActivitySummary {
    if (this.#runtime.repository.getChannel(channelId) === undefined) throw new NotFoundError('频道不存在或已被删除。')
    const projections = this.#runtime.repository.projections
    projections.ensureReadViewer(viewerKey, this.#now())
    let target = upTo === undefined ? undefined : { readAt: upTo.occurredAt, readSourceId: upTo.sourceId }
    if (target === undefined) {
      const latest = projections.getLatestMemberMessage(channelId)
      target =
        latest === undefined
          ? { readAt: this.#now(), readSourceId: '' }
          : { readAt: latest.receivedAt, readSourceId: latest.id }
    }
    const position = projections.advanceChannelReadPosition(viewerKey, channelId, target, this.#now())
    return this.#summarize(channelId, position)
  }

  // ---------------------------------------------------------------- runtime controls

  pending(channelId: ChannelId): ChannelPendingContext {
    if (this.#runtime.repository.getChannel(channelId) === undefined) throw new NotFoundError('频道不存在或已被删除。')
    const context = this.#runtime.channels.listPendingContext(channelId)
    return {
      channelId,
      ...(context.episodeId === undefined ? {} : { episodeId: context.episodeId }),
      items: context.items.map((item) => ({
        admissionId: item.admissionId,
        target: item.target,
        events: item.events.map((event) => ({
          eventId: event.id,
          author: truncate(memberName(this.#runtime, event), 120),
          preview: previewMessageParts(this.#runtime, event.parts),
          receivedAt: event.receivedAt,
        })),
      })),
    }
  }

  async stop(
    channelId: ChannelId,
    expectedEpisodeId?: Parameters<NekroRuntime['channels']['stopCurrentTurn']>[1],
  ): Promise<HostApiResponse<'stopChannelTask'>> {
    if (this.#runtime.repository.getChannel(channelId) === undefined) throw new NotFoundError('频道不存在或已被删除。')
    const result = await this.#runtime.channels.stopCurrentTurn(channelId, expectedEpisodeId)
    this.scheduleAttentionCheck()
    return {
      result: result.result,
      ...(result.episodeId === undefined ? {} : { episodeId: result.episodeId }),
      retainedPending: result.retainedPending,
    }
  }

  async resolveOutbound(
    outboundId: OutboundIntentId,
    action: 'retry' | 'confirm-delivered',
    viewerKey: string,
  ): Promise<HostApiResponse<'resolveOutbound'>> {
    if (action === 'retry') this.#runtime.channels.assertOutboundDispatchable(outboundId)
    const resolution = this.#runtime.repository.projections.resolveOutbound({
      id: `ores_${randomUUID()}`,
      intentId: outboundId,
      action,
      viewerKey,
      now: this.#now(),
    })
    if (action === 'retry') await this.#runtime.channels.redispatchOutbound(outboundId)
    else this.#runtime.channels.publishOutboundFact(outboundId)
    this.scheduleAttentionCheck()
    return {
      outboundId,
      action,
      deliveryState: this.#runtime.repository.getOutbound(outboundId).intent.state,
      resolvedAt: resolution.createdAt,
    }
  }

  activity(query: ActivityQuery): ChannelActivitySeries {
    const windowMs = activityDurationMs(query.window)
    const bucketMs = activityDurationMs(query.bucket)
    const bucketCount = Math.ceil(windowMs / bucketMs)
    // Align to bucket boundaries so repeated polls share buckets; the last bucket contains "now".
    const to = (Math.floor(this.#now() / bucketMs) + 1) * bucketMs
    const from = to - bucketCount * bucketMs
    const live = new Set(
      this.#runtime.core
        .listConnections()
        .flatMap((connection) => this.#runtime.core.listChannelsByConnection(connection.id).map(({ id }) => id)),
    )
    const counts = this.#runtime.repository.projections.countChannelActivity(from, to, bucketMs)
    return {
      from,
      to,
      bucketMs,
      channels: [...counts]
        .filter(([channelId]) => live.has(channelId))
        .map(([channelId, buckets]) => {
          const series = Array.from({ length: bucketCount }, (_, index) => buckets.get(index) ?? 0)
          return { channelId, counts: series, total: series.reduce((sum, value) => sum + value, 0) }
        })
        .sort((left, right) => right.total - left.total || left.channelId.localeCompare(right.channelId)),
    }
  }

  // ---------------------------------------------------------------- agent revision history

  revisionHistory(agentId: AgentId): AgentRevisionHistory {
    const agent = this.#runtime.repository.getAgent(agentId)
    if (agent === undefined) throw new NotFoundError('智能体不存在或已被删除。')
    const currentRevisionId = agent.definition.currentRevisionId
    return {
      agentId,
      currentRevisionId,
      revisions: this.#runtime.core
        .listAgentRevisionHistory(agentId)
        .map(({ revision, changedFields }) => ({
          id: revision.id,
          revision: revision.revision,
          createdAt: revision.createdAt,
          displayName: revision.displayName,
          model: { provider: revision.model.provider, model: revision.model.model },
          changedFields: [...changedFields],
          current: revision.id === currentRevisionId,
        }))
        .reverse(),
    }
  }

  restoreRevision(agentId: AgentId, revisionId: AgentRevisionId, expectedCurrentRevisionId: AgentRevisionId) {
    const agent = this.#runtime.repository.getAgent(agentId)
    if (agent === undefined) throw new NotFoundError('智能体不存在或已被删除。')
    if (agent.definition.currentRevisionId !== expectedCurrentRevisionId) {
      throw new RevisionConflictError('智能体配置已在其他位置更新，请刷新后重试。')
    }
    const target = this.#runtime.repository.getAgentRevision(revisionId)
    if (target === undefined || target.agentId !== agentId) throw new NotFoundError('这个版本不存在。')
    return this.#runtime.core.restoreAgentRevision(agentId, revisionId, expectedCurrentRevisionId).revision.id
  }

  // ---------------------------------------------------------------- agent appearance

  updateAppearance(
    agentId: AgentId,
    patch: { readonly hue?: number | null | undefined; readonly avatarAssetId?: null | undefined },
  ) {
    if (this.#runtime.repository.getAgent(agentId) === undefined) throw new NotFoundError('智能体不存在或已被删除。')
    return this.#runtime.core.updateAgentAppearance(agentId, patch)
  }

  async uploadAvatar(agentId: AgentId, bytes: Uint8Array) {
    if (this.#runtime.repository.getAgent(agentId) === undefined) throw new NotFoundError('智能体不存在或已被删除。')
    if (bytes.byteLength === 0) throw new BadRequestError('头像文件为空。')
    const prepared = await this.#runtime.assetService.prepare({ bytes })
    if (!AVATAR_MEDIA_TYPES.has(prepared.asset.mediaType)) {
      throw new BadRequestError('头像只支持 PNG、JPEG、WebP 或 GIF 图片。')
    }
    return this.#runtime.core.updateAgentAppearance(agentId, { avatarAssetId: prepared.asset.id })
  }

  avatarAsset(agentId: AgentId) {
    const assetId = this.#runtime.repository.getAgent(agentId)?.definition.appearance?.avatarAssetId
    return assetId === undefined ? undefined : this.#runtime.repository.getAssetById(assetId)
  }

  // ---------------------------------------------------------------- attention

  async listAttention(): Promise<HostApiResponse<'listAttention'>> {
    const dismissed = this.#runtime.repository.projections.listAttentionDismissals()
    const items = (await this.#collectAttention())
      .filter((item) => !dismissed.has(item.id))
      .sort(
        (left, right) =>
          severityRank(left.severity) - severityRank(right.severity) || right.occurredAt - left.occurredAt,
      )
      .slice(0, 200)
    const revision = createHash('sha256')
      .update(items.map(({ id }) => id).join('\n'))
      .digest('hex')
      .slice(0, 16)
    return { revision, items }
  }

  async dismissAttention(fingerprint: string): Promise<HostApiResponse<'dismissAttention'>> {
    const now = this.#now()
    this.#runtime.repository.projections.dismissAttention(fingerprint, now, now - ATTENTION_DISMISSAL_RETENTION_MS)
    const { revision } = await this.listAttention()
    this.#publishAttention(revision)
    return { dismissed: true, revision }
  }

  /** Coalesces attention recomputation and broadcasts only when the visible set changed. */
  scheduleAttentionCheck(): void {
    if (this.#disposed) return
    this.#attentionDirty = true
    if (this.#attentionTimer !== undefined) return
    this.#attentionTimer = setTimeout(() => {
      this.#attentionTimer = undefined
      void this.#runAttentionCheck()
    }, ATTENTION_RECHECK_DEBOUNCE_MS)
    this.#attentionTimer.unref?.()
  }

  async #runAttentionCheck(): Promise<void> {
    if (this.#attentionCheck !== undefined) return
    this.#attentionCheck = (async () => {
      while (this.#attentionDirty && !this.#disposed) {
        this.#attentionDirty = false
        try {
          const { revision } = await this.listAttention()
          this.#publishAttention(revision)
        } catch (error) {
          console.error('[nekro-nxt] 关注事项计算失败：', error)
        }
      }
    })()
    try {
      await this.#attentionCheck
    } finally {
      this.#attentionCheck = undefined
    }
  }

  #publishAttention(revision: string): void {
    if (this.#disposed || revision === this.#attentionRevision) return
    this.#attentionRevision = revision
    this.#broadcast({ event: 'attention-changed', data: { revision } })
  }

  async #collectAttention(): Promise<AttentionItem[]> {
    const runtime = this.#runtime
    const items: AttentionItem[] = []
    const now = this.#now()

    for (const record of runtime.repository.projections.listUnsettledAttentionOutbounds(
      now - ATTENTION_DELIVERY_WINDOW_MS,
      ATTENTION_DELIVERY_LIMIT,
    )) {
      const deliveries = runtime.repository.getOutbound(record.intent.id).deliveries
      const unconfirmed =
        record.intent.state === 'unknown' || deliveries.some((delivery) => delivery.state === 'unknown')
      const channelName = channelDisplayName(runtime, record.channelId)
      const agentId = AgentIdSchema.parse(record.agentId)
      const author = isAdminConsoleOutbound(record.intent.sourceTurnId) ? '管理员' : agentDisplayName(runtime, agentId)
      items.push({
        id: `delivery:${record.intent.id}:${record.resolutionCount}`,
        kind: unconfirmed ? 'delivery-unconfirmed' : 'delivery-failed',
        severity: 'critical',
        subject: { kind: 'outbound', id: record.intent.id },
        related: { channelId: record.channelId, agentId, outboundId: record.intent.id },
        title: channelName,
        detail: truncate(
          `${author}的一条消息${unconfirmed ? '未确认送达' : '发送失败'}：${previewMessageParts(runtime, record.intent.parts)}`,
          400,
        ),
        action: { kind: 'resolve-delivery', label: '处理' },
        occurredAt: record.intent.createdAt,
      })
    }

    for (const connection of runtime.core.listConnections()) {
      for (const channel of runtime.core.listChannelsByConnection(connection.id)) {
        const binding = runtime.core.listBindings(channel.id)[0]
        if (binding === undefined) continue
        const projection = assembleChannelRuntime(runtime, channel.id, { binding })
        const latest = projection.turns.at(-1)
        if (projection.episodeId === undefined || latest === undefined) continue
        const failed = latest.state === 'error' || latest.state === 'max-tokens' || latest.state === 'interrupted'
        if (!failed) continue
        items.push({
          id: `turn:${projection.episodeId}:${latest.turn}`,
          kind: 'turn-failed',
          severity: latest.state === 'error' ? 'critical' : 'warning',
          subject: { kind: 'channel', id: channel.id },
          related: { channelId: channel.id, agentId: binding.agentId },
          title: channelDisplayName(runtime, channel.id),
          detail: truncate(
            latest.state === 'error'
              ? `${agentDisplayName(runtime, binding.agentId)}本轮失败：${latest.error?.message ?? '未知错误'}`
              : latest.state === 'max-tokens'
                ? `${agentDisplayName(runtime, binding.agentId)}的回复超出了输出长度上限。`
                : `${agentDisplayName(runtime, binding.agentId)}的处理被中断，可能没有完成回复。`,
            400,
          ),
          action: { kind: 'open-channel', label: '查看' },
          occurredAt: now,
        })
      }

      const status = runtime.adapterConnectionDiagnostic(connection.id)?.status
      if (status === 'failed' || status === 'reconnecting') {
        const previous = this.#unhealthySince.get(connection.id)
        const since = previous?.state === status ? previous.since : now
        this.#unhealthySince.set(connection.id, { state: status, since })
        const adapterName = runtime.adapters.get(connection.adapterKey)?.descriptor.displayName ?? connection.adapterKey
        items.push({
          id: `connection:${connection.id}:${status}:${since}`,
          kind: 'connection-unhealthy',
          severity: status === 'failed' ? 'critical' : 'warning',
          subject: { kind: 'connection', id: connection.id },
          related: { connectionId: connection.id },
          title: connection.alias ?? adapterName,
          detail:
            status === 'failed' ? `${adapterName} 连接异常，收不到新消息。` : `${adapterName} 连接中断，正在重连。`,
          action: { kind: 'open-connection', label: '查看连接' },
          occurredAt: since,
        })
      } else {
        this.#unhealthySince.delete(connection.id)
      }
    }

    for (const task of runtime.repository.listAuthoringTasks()) {
      if (task.status !== 'awaiting-approval') continue
      const attempt = runtime.repository
        .listAuthoringAttempts()
        .filter((candidate) => candidate.taskId === task.id)
        .at(-1)
      items.push({
        id: `authoring:${task.id}:${attempt?.id ?? 'none'}`,
        kind: 'authoring-approval',
        severity: 'warning',
        subject: { kind: 'authoring-task', id: task.id },
        related: { taskId: task.id, agentId: task.agentId, channelId: task.channelId },
        title: task.title,
        detail: `${agentDisplayName(runtime, task.agentId)}做好了新版本，等待你试运行。`,
        action: { kind: 'open-authoring-task', label: '去试运行' },
        occurredAt: task.updatedAt,
      })
    }

    const models = await runtime.host.listAvailableLlmModels()
    for (const commit of runtime.core.listAgents()) {
      const agentId = commit.definition.id
      const name = commit.revision.displayName
      const available = models.some(
        (model) => model.provider === commit.revision.model.provider && model.id === commit.revision.model.model,
      )
      if (!available) {
        items.push({
          id: `agent-model:${agentId}:${commit.revision.id}`,
          kind: 'agent-model-unavailable',
          severity: 'critical',
          subject: { kind: 'agent', id: agentId },
          related: { agentId },
          title: name,
          detail: `主模型 ${commit.revision.model.provider}/${commit.revision.model.model} 当前不可用，${name}无法回复。`,
          action: { kind: 'open-agent', label: '选择模型' },
          occurredAt: commit.revision.createdAt,
        })
        continue
      }
      const diagnostics = await runtime.host.getAgentImageDiagnostics(commit.revision)
      if (diagnostics.route.mode === 'unavailable') {
        items.push({
          id: `agent-vision:${agentId}:${commit.revision.id}`,
          kind: 'agent-vision-unavailable',
          severity: 'info',
          subject: { kind: 'agent', id: agentId },
          related: { agentId },
          title: name,
          detail: truncate(diagnostics.blockers[0] ?? '主模型看不懂图片，群里的图片会被跳过。', 400),
          action: { kind: 'open-agent', label: '添加视觉模型' },
          occurredAt: commit.revision.createdAt,
        })
      }
    }
    return items
  }

  // ---------------------------------------------------------------- routes

  /** `/api/channels/:channelId/(read|pending|stop)` delegated from the Channel route family. */
  async handleChannelRoute(
    req: IncomingMessage,
    res: ServerResponse,
    channelId: ChannelId,
    action: 'read' | 'pending' | 'stop',
  ): Promise<void> {
    try {
      if (action === 'pending') {
        if (!requireMethod(req, res, 'GET')) return
        writeContractJson(res, 200, HostApiContracts.getChannelPending, this.pending(channelId))
        return
      }
      if (!requireMethod(req, res, 'POST')) return
      if (action === 'read') {
        const body = HostApiContracts.markChannelRead.parseRequest((await readJsonBody(req)) ?? {})
        writeContractJson(res, 200, HostApiContracts.markChannelRead, {
          channelId,
          activity: this.markRead(viewerKeyFromRequest(req), channelId, body.upTo),
        })
        return
      }
      const body = HostApiContracts.stopChannelTask.parseRequest((await readJsonBody(req)) ?? {})
      writeContractJson(res, 200, HostApiContracts.stopChannelTask, await this.stop(channelId, body.expectedEpisodeId))
    } catch (error) {
      writeProjectionError(res, error)
    }
  }

  /** `/api/agents/:agentId/revisions[/:revisionId/restore]` delegated from the Agent route family. */
  async handleAgentRevisionRoute(
    req: IncomingMessage,
    res: ServerResponse,
    agentId: AgentId,
    restoreRevisionId: string | undefined,
  ): Promise<void> {
    try {
      if (restoreRevisionId === undefined) {
        if (!requireMethod(req, res, 'GET')) return
        writeContractJson(res, 200, HostApiContracts.listAgentRevisions, this.revisionHistory(agentId))
        return
      }
      if (!requireMethod(req, res, 'POST')) return
      const revisionId = AgentRevisionIdSchema.parse(restoreRevisionId)
      const body = HostApiContracts.restoreAgentRevision.parseRequest(await readJsonBody(req))
      writeContractJson(res, 200, HostApiContracts.restoreAgentRevision, {
        currentRevisionId: this.restoreRevision(agentId, revisionId, body.expectedCurrentRevisionId),
      })
    } catch (error) {
      writeProjectionError(res, error)
    }
  }

  /** `/api/agents/:agentId/(appearance|avatar)` delegated from the Agent route family. */
  async handleAgentRoute(
    req: IncomingMessage,
    res: ServerResponse,
    agentId: AgentId,
    action: 'appearance' | 'avatar',
  ): Promise<void> {
    try {
      if (action === 'appearance') {
        if (!requireMethod(req, res, 'PATCH')) return
        const body = HostApiContracts.updateAgentAppearance.parseRequest((await readJsonBody(req)) ?? {})
        writeContractJson(res, 200, HostApiContracts.updateAgentAppearance, {
          agentId,
          appearance: this.updateAppearance(agentId, body),
        })
        return
      }
      if (req.method === 'POST') {
        const appearance = await this.uploadAvatar(agentId, await readBinaryBody(req, AVATAR_MAX_BYTES))
        writeContractJson(res, 200, HostApiContracts.uploadAgentAvatar, { agentId, appearance })
        return
      }
      if (!requireMethod(req, res, 'GET')) return
      const asset = this.avatarAsset(agentId)
      if (asset === undefined) {
        writeError(res, 404, 'avatar-not-found', '这个智能体没有头像。')
        return
      }
      const bytes = await readFile(this.#runtime.assetService.blobPath(asset))
      res.writeHead(200, {
        'content-type': asset.mediaType,
        'content-length': String(bytes.byteLength),
        'cache-control': 'private, no-cache',
        etag: `"${asset.contentDigest}"`,
        'x-content-type-options': 'nosniff',
      })
      res.end(bytes)
    } catch (error) {
      writeProjectionError(res, error)
    }
  }

  registerRoutes({ registerRoute }: Pick<HostRouteContext, 'registerRoute'>): void {
    registerRoute({
      kind: 'prefix',
      path: '/api/attention',
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        try {
          if (url.pathname === '/api/attention') {
            if (!requireMethod(req, res, 'GET')) return
            writeContractJson(res, 200, HostApiContracts.listAttention, await this.listAttention())
            return
          }
          const match = /^\/api\/attention\/([^/]+)\/dismiss$/u.exec(url.pathname)
          if (!match) {
            writeError(res, 404, 'not-found', `Unknown route: ${req.method} ${url.pathname}`)
            return
          }
          if (!requireMethod(req, res, 'POST')) return
          const params = HostApiContracts.dismissAttention.parseParams({
            attentionId: decodeURIComponent(match[1] ?? ''),
          })
          writeContractJson(
            res,
            200,
            HostApiContracts.dismissAttention,
            await this.dismissAttention(params.attentionId),
          )
        } catch (error) {
          writeProjectionError(res, error)
        }
      },
    })
    registerRoute({
      kind: 'exact',
      path: '/api/activity',
      handler: (req, res) => {
        if (!requireMethod(req, res, 'GET')) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        try {
          const query = HostApiContracts.getChannelActivity.parseParams(Object.fromEntries(url.searchParams))
          writeContractJson(res, 200, HostApiContracts.getChannelActivity, this.activity(query))
        } catch (error) {
          writeProjectionError(res, error)
        }
      },
    })
    registerRoute({
      kind: 'prefix',
      path: '/api/outbound',
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const match = /^\/api\/outbound\/([^/]+)\/resolve$/u.exec(url.pathname)
        if (!match) {
          writeError(res, 404, 'not-found', `Unknown route: ${req.method} ${url.pathname}`)
          return
        }
        if (!requireMethod(req, res, 'POST')) return
        try {
          const outboundId = OutboundIntentIdSchema.parse(decodeURIComponent(match[1] ?? ''))
          const body = HostApiContracts.resolveOutbound.parseRequest(await readJsonBody(req))
          writeContractJson(
            res,
            200,
            HostApiContracts.resolveOutbound,
            await this.resolveOutbound(outboundId, body.action, viewerKeyFromRequest(req)),
          )
        } catch (error) {
          writeProjectionError(res, error)
        }
      },
    })
  }
}

const severityRank = (severity: AttentionItem['severity']): number =>
  severity === 'critical' ? 0 : severity === 'warning' ? 1 : 2

class NotFoundError extends Error {}
class RevisionConflictError extends Error {}
class BadRequestError extends Error {}

const requireMethod = (req: IncomingMessage, res: ServerResponse, method: string): boolean => {
  if (req.method === method) return true
  writeError(res, 405, 'method-not-allowed', `只支持 ${method}。`)
  return false
}

const writeProjectionError = (res: ServerResponse, error: unknown): void => {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof NotFoundError) writeError(res, 404, 'not-found', message)
  else if (error instanceof ChannelStopConflictError) writeError(res, 409, 'episode-conflict', message)
  else if (error instanceof RevisionConflictError) writeError(res, 409, 'revision-conflict', message)
  else if (error instanceof OutboundResolutionError) {
    writeError(res, error.code === 'not-found' ? 404 : 409, `outbound-${error.code}`, message)
  } else writeError(res, 400, 'invalid-request', message)
}

export const parseRouteChannelId = (raw: string): ChannelId => ChannelIdSchema.parse(decodeURIComponent(raw))
