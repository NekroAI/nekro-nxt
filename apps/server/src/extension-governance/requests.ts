import {
  CommunityReviewStatusSchema,
  parseJsonValue,
  type AgentId,
  type ChannelId,
  type CommunityReviewStatus,
  type ExtensionId,
  type JsonValue,
} from '@nekro-nxt/contracts'
import type { ExtensionRequestRecord } from '@nekro-nxt/storage-sqlite'
import { z } from 'zod'
import type { NekroRuntime } from '../bootstrap.js'
import {
  ExtensionActionSchema,
  type ExtensionAction,
  type ExtensionActionAssessment,
  type ExtensionActionResult,
  type ExtensionActor,
} from './actions.js'

/** Requests wait a day for an administrator; after that the agent has to ask again. */
export const EXTENSION_REQUEST_TTL_MS = 24 * 60 * 60 * 1000

/** Community review results are followed for three days after a publish; later results are only on the community. */
export const EXTENSION_REVIEW_WATCH_MS = 3 * 24 * 60 * 60 * 1000

const REVIEW_SETTLED: Readonly<Partial<Record<CommunityReviewStatus, string>>> = {
  passed: '审查通过',
  passed_with_notes: '审查通过，审查员留了建议',
  flagged: '审查发现风险，等社区复审',
  risk_confirmed: '审查确认有风险，安装时会提示',
  held: '被暂停公开，等社区复审',
  rejected: '没有通过审查',
  incomplete: '审查没能完成',
}

/** What a finished request keeps: the outcome message and, for a publish, the release whose review is followed. */
interface RequestResult {
  readonly message: string
  readonly releaseId?: string
  /** `waiting` until the review settles, then the review status that was reported. */
  readonly review?: 'waiting' | CommunityReviewStatus
}

const resultOf = (result: ExtensionActionResult): RequestResult => ({
  message: result.message,
  ...(result.releaseId === undefined ? {} : { releaseId: result.releaseId, review: 'waiting' as const }),
})

/** Who decided a request: the console, or an administrator's platform account in chat. */
export type ExtensionRequestDecider =
  { readonly kind: 'console' } | { readonly kind: 'administrator'; readonly label: string }

const extensionOf = (action: ExtensionAction): ExtensionId | undefined => {
  switch (action.kind) {
    case 'save':
    case 'branch':
    case 'community-install':
    case 'community-withdraw':
      return undefined
    case 'migrate-data':
      return action.targetExtensionId
    case 'enable':
    case 'disable':
    case 'switch':
    case 'revert':
    case 'community-publish':
    case 'community-update':
      return action.extensionId
  }
}

/** Requests keep their action and outcome as JSON; these read them back. */
const StoredPayloadSchema = z.object({ action: ExtensionActionSchema.optional() }).passthrough()
const RequestResultSchema = z.object({
  message: z.string(),
  releaseId: z.string().optional(),
  review: z.union([z.literal('waiting'), CommunityReviewStatusSchema]).optional(),
})
const toJson = (value: unknown): JsonValue => parseJsonValue(JSON.parse(JSON.stringify(value)))

/**
 * Administrator-confirmed extension actions and the record of what agents did on their own. Every request gets a
 * short number people type in chat (`/ext approve 12`); the host posts the request and its outcome as notices, never as
 * the agent's own words, and tells the agent how it ended.
 */
export class ExtensionRequestService {
  readonly #runtime: NekroRuntime
  readonly #now: () => number

  constructor(runtime: NekroRuntime, now: () => number = Date.now) {
    this.#runtime = runtime
    this.#now = now
  }

  list(status?: ExtensionRequestRecord['status']): readonly ExtensionRequestRecord[] {
    this.expire()
    return this.#runtime.repository.listExtensionRequests(status === undefined ? {} : { status })
  }

  get(number: number): ExtensionRequestRecord | undefined {
    this.expire()
    return this.#runtime.repository.getExtensionRequest(number)
  }

  /** Files a request for an action the agent may not take alone and posts it in the channel. */
  create(input: {
    readonly action: ExtensionAction
    readonly actor: Extract<ExtensionActor, { readonly kind: 'agent' }>
    readonly assessment: ExtensionActionAssessment
  }): ExtensionRequestRecord {
    const now = this.#now()
    const extensionId = extensionOf(input.action)
    const record = this.#runtime.repository.createExtensionRequest({
      kind: input.action.kind,
      agentId: input.actor.agentId,
      channelId: input.actor.channelId ?? null,
      extensionId: extensionId ?? null,
      summary: input.assessment.summary,
      payload: toJson({ action: input.action, added: input.assessment.added, level: input.assessment.level }),
      createdAt: now,
      expiresAt: now + EXTENSION_REQUEST_TTL_MS,
    })
    const added =
      input.assessment.added.length === 0
        ? ''
        : `（新增权限：${input.assessment.added.map((item) => item.label + (item.detail ? ` ${item.detail}` : '')).join('；')}）`
    const prefix = this.#commandPrefix(input.actor.channelId)
    this.#notice(
      input.actor.channelId,
      `ext-request:${record.number}:asked`,
      `${this.#agentName(input.actor.agentId)}请求${input.assessment.summary}${added}。管理员发送 ${prefix}/ext approve ${record.number} 同意，或 ${prefix}/ext reject ${record.number} 拒绝；24 小时内有效。`,
    )
    this.#runtime.publishExtensionRequestChange?.()
    return record
  }

  /** Records what an agent did on its own and posts the receipt, so every autonomous step can be traced and undone. */
  recordAutonomous(input: {
    readonly action: ExtensionAction
    readonly actor: Extract<ExtensionActor, { readonly kind: 'agent' }>
    readonly assessment: ExtensionActionAssessment
    readonly result: ExtensionActionResult
  }): ExtensionRequestRecord {
    const now = this.#now()
    const record = this.#runtime.repository.createExtensionRequest({
      kind: input.action.kind,
      agentId: input.actor.agentId,
      channelId: input.actor.channelId ?? null,
      extensionId: input.result.extensionId ?? extensionOf(input.action) ?? null,
      summary: input.assessment.summary,
      payload: toJson({ action: input.action, autonomous: true }),
      createdAt: now,
      expiresAt: now,
    })
    this.#runtime.repository.updateExtensionRequest({
      number: record.number,
      from: 'pending',
      status: 'completed',
      result: toJson(resultOf(input.result)),
      decidedBy: this.#agentName(input.actor.agentId),
      decidedAt: now,
    })
    const undo = this.#undoHint(input.action)
    this.#notice(
      input.actor.channelId,
      `ext-request:${record.number}:done`,
      `${this.#agentName(input.actor.agentId)}：${input.result.message}${undo}`,
    )
    this.#runtime.publishExtensionRequestChange?.()
    return this.#runtime.repository.getExtensionRequest(record.number) ?? record
  }

  /** Confirms a pending request and carries it out; the outcome is posted and reported to the agent. */
  async approve(number: number, decider: ExtensionRequestDecider): Promise<ExtensionActionResult> {
    const record = this.#pending(number)
    const action = this.#action(record)
    const actor = decider.kind === 'console' ? ({ kind: 'console' } as const) : decider
    const assessment = this.#runtime.extensionActions.assess(action, actor)
    if (assessment.decision === 'console') throw new Error(assessment.reason ?? '这个请求需要在 NekroNXT 后台处理。')
    const now = this.#now()
    const label = decider.kind === 'console' ? '控制台管理员' : decider.label
    if (
      !this.#runtime.repository.updateExtensionRequest({
        number,
        from: 'pending',
        status: 'approved',
        decidedBy: label,
        decidedAt: now,
      })
    ) {
      throw new Error(`请求 #${number} 已经被处理。`)
    }
    try {
      const result = await this.#runtime.extensionActions.perform(action, actor)
      this.#runtime.repository.updateExtensionRequest({
        number,
        from: 'approved',
        status: 'completed',
        result: toJson(resultOf(result)),
      })
      this.#notice(
        record.channelId ?? undefined,
        `ext-request:${number}:done`,
        `请求 #${number} 已由${label}同意：${result.message}`,
      )
      this.#tellAgent(
        record,
        'done',
        `〔系统通知〕扩展请求 #${number}（${record.summary}）已由${label}同意并完成：${result.message}`,
      )
      this.#runtime.publishExtensionRequestChange?.()
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.#runtime.repository.updateExtensionRequest({
        number,
        from: 'approved',
        status: 'failed',
        result: { message },
      })
      this.#notice(
        record.channelId ?? undefined,
        `ext-request:${number}:failed`,
        `请求 #${number} 已同意，但没有完成：${message}`,
      )
      this.#tellAgent(
        record,
        'failed',
        `〔系统通知〕扩展请求 #${number}（${record.summary}）已同意，但执行失败：${message}。看一下原因再决定怎么处理。`,
      )
      this.#runtime.publishExtensionRequestChange?.()
      throw error
    }
  }

  reject(number: number, decider: ExtensionRequestDecider, reason?: string): void {
    const record = this.#pending(number)
    const label = decider.kind === 'console' ? '控制台管理员' : decider.label
    if (
      !this.#runtime.repository.updateExtensionRequest({
        number,
        from: 'pending',
        status: 'rejected',
        decidedBy: label,
        decidedAt: this.#now(),
        ...(reason === undefined ? {} : { result: { message: reason } }),
      })
    ) {
      throw new Error(`请求 #${number} 已经被处理。`)
    }
    this.#notice(
      record.channelId ?? undefined,
      `ext-request:${number}:rejected`,
      `请求 #${number} 已被${label}拒绝${reason ? `：${reason}` : '。'}`,
    )
    this.#tellAgent(
      record,
      'rejected',
      `〔系统通知〕扩展请求 #${number}（${record.summary}）被${label}拒绝${reason ? `：${reason}` : '。'}不要再自行重试同一个请求。`,
    )
    this.#runtime.publishExtensionRequestChange?.()
  }

  /**
   * Reports community review results of releases agents published from a channel: once a review settles, the channel
   * gets a notice and the agent is told, so nobody has to open the community to learn how it went.
   */
  async watchReviews(): Promise<void> {
    const since = this.#now() - EXTENSION_REVIEW_WATCH_MS
    const watched = this.#runtime.repository
      .listExtensionRequests({ status: 'completed', limit: 200 })
      .filter((record) => record.kind === 'community-publish' && record.createdAt >= since)
      .flatMap((record) => {
        const parsed = RequestResultSchema.safeParse(record.result)
        const result = parsed.success ? parsed.data : undefined
        return result?.review === 'waiting' && result.releaseId !== undefined
          ? [{ record, result, releaseId: result.releaseId }]
          : []
      })
    for (const { record, result, releaseId } of watched) {
      let status: CommunityReviewStatus
      let reportUrl: string
      try {
        const report = await this.#runtime.community.review(releaseId)
        status = report.status
        reportUrl = report.reportUrl
      } catch {
        continue
      }
      const outcome = REVIEW_SETTLED[status]
      if (outcome === undefined) continue
      if (
        !this.#runtime.repository.updateExtensionRequest({
          number: record.number,
          from: 'completed',
          status: 'completed',
          result: toJson({ ...result, review: status }),
        })
      ) {
        continue
      }
      const extension =
        record.extensionId === null ? undefined : this.#runtime.repository.getExtension(record.extensionId)
      const name = extension ? `「${extension.displayName}」` : '扩展'
      this.#notice(
        record.channelId ?? undefined,
        `ext-request:${record.number}:review`,
        `${name}的社区发布${outcome}。审查报告：${reportUrl}`,
      )
      this.#tellAgent(
        record,
        'review',
        `〔系统通知〕你发布到社区的${name}${outcome}。${status === 'passed' ? '' : `审查报告在 ${reportUrl}，按里面的意见决定要不要修改后重新发布。`}`,
      )
      this.#runtime.publishExtensionRequestChange?.()
    }
  }

  expire(): void {
    if (this.#runtime.repository.expireExtensionRequests(this.#now()) > 0)
      this.#runtime.publishExtensionRequestChange?.()
  }

  #pending(number: number): ExtensionRequestRecord {
    this.expire()
    const record = this.#runtime.repository.getExtensionRequest(number)
    if (!record) throw new Error(`没有编号为 #${number} 的扩展请求。`)
    if (record.status === 'expired') throw new Error(`请求 #${number} 已过期，请让智能体重新发起。`)
    if (record.status !== 'pending') throw new Error(`请求 #${number} 已经被处理。`)
    return record
  }

  #action(record: ExtensionRequestRecord): ExtensionAction {
    const payload = StoredPayloadSchema.safeParse(record.payload)
    if (!payload.success || payload.data.action === undefined)
      throw new Error(`请求 #${record.number} 的内容无法读取。`)
    return payload.data.action
  }

  /** External groups only take commands addressed to the bot, so the hint says so. */
  #commandPrefix(channelId: ChannelId | undefined): string {
    if (channelId === undefined) return ''
    const channel = this.#runtime.repository.getChannel(channelId)
    return channel?.kind === 'group' ? '@机器人 ' : ''
  }

  #undoHint(action: ExtensionAction): string {
    return action.kind === 'switch' || action.kind === 'community-update'
      ? '。如需撤销，管理员发送 /ext revert 扩展名。'
      : ''
  }

  #notice(channelId: ChannelId | undefined, key: string, text: string): void {
    if (channelId === undefined) return
    void this.#runtime.channels
      .sendHostNotice({ channelId, noticeKey: key, parts: [{ type: 'text', text }] })
      .catch((error: unknown) => {
        console.error('[nekro-nxt] 扩展通知发送失败：', error)
      })
  }

  #tellAgent(record: ExtensionRequestRecord, outcome: 'done' | 'failed' | 'rejected' | 'review', text: string): void {
    this.#runtime.host.notifyAgent({
      agentId: record.agentId,
      ...(record.channelId === null ? {} : { channelId: record.channelId }),
      identity: `ext-request:${record.number}:${outcome}`,
      text,
    })
  }

  #agentName(agentId: AgentId): string {
    return this.#runtime.repository.getAgent(agentId)?.revision.displayName ?? '智能体'
  }
}
