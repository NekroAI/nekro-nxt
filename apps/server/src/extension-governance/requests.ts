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
    case 'use-credential':
      return undefined
    case 'migrate-data':
      return action.targetExtensionId
    case 'enable':
    case 'disable':
    case 'configure':
    case 'revert-config':
    case 'switch':
    case 'revert':
    case 'community-publish':
    case 'community-update':
      return action.extensionId
  }
}

/**
 * The thing a request changes. A newer request for the same thing supersedes an older pending one, so an
 * administrator never approves an outdated version switch or configuration by mistake.
 */
const objectKey = (action: ExtensionAction | undefined): string | undefined => {
  switch (action?.kind) {
    case 'enable':
    case 'disable':
      return `activation|${action.extensionId}|${action.agentId}`
    case 'switch':
    case 'revert':
      return `version|${action.extensionId}`
    case 'configure':
      return `config|${action.extensionId}|${action.layer}|${action.agentId ?? ''}`
    case 'revert-config':
      return `config-revert|${action.extensionId}`
    case 'migrate-data':
      return `data|${action.targetExtensionId}`
    case 'community-publish':
    case 'community-update':
      return `${action.kind}|${action.extensionId}`
    case undefined:
    case 'save':
    case 'branch':
    case 'community-install':
    case 'community-withdraw':
    case 'use-credential':
      return undefined
  }
}

/**
 * Whether `newer` replaces everything `older` asks for. Configuration requests change single fields, so a newer one
 * for other fields of the same layer leaves the older one standing instead of dropping its changes.
 */
const covers = (newer: ExtensionAction, older: ExtensionAction): boolean => {
  if (newer.kind !== 'configure' || older.kind !== 'configure') return true
  const fields = (action: ConfigureAction) => [
    ...Object.keys(action.values).map((name) => `value:${name}`),
    ...Object.keys(action.credentials).map((name) => `credential:${name}`),
  ]
  const replaced = new Set(fields(newer))
  return fields(older).every((field) => replaced.has(field))
}

type ConfigureAction = Extract<ExtensionAction, { readonly kind: 'configure' }>

/** Two changes to the same layer as one: later values and bindings win, reasons are kept together. */
const mergeConfigure = (first: ConfigureAction, second: ConfigureAction): ConfigureAction => {
  const reasons = [first.reason, second.reason].filter((reason) => reason !== undefined && reason !== '')
  const reason = [...new Set(reasons)].join('；').slice(0, 500)
  const requesterMemberId = second.requesterMemberId ?? first.requesterMemberId
  return {
    ...first,
    values: { ...first.values, ...second.values },
    credentials: { ...first.credentials, ...second.credentials },
    ...(reason === '' ? {} : { reason }),
    ...(requesterMemberId === undefined ? {} : { requesterMemberId }),
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

/** The action without who asked for it and why, so the same change asked twice compares equal. */
const ORIGIN_FIELDS = new Set(['actorAgentId', 'requesterMemberId', 'reason'])
const actionKey = (action: ExtensionAction | undefined): string =>
  action === undefined
    ? ''
    : JSON.stringify(Object.fromEntries(Object.entries(action).filter(([field]) => !ORIGIN_FIELDS.has(field))))

/**
 * Administrator-confirmed extension actions and the record of what agents did on their own. Every request gets a
 * short number people type in chat (`/ext approve 12`); the host posts the request and its outcome as notices, never as
 * the agent's own words, and tells the agent how it ended.
 */
export class ExtensionRequestService {
  readonly #runtime: NekroRuntime
  readonly #now: () => number
  /** Configuration changes waiting for the end of the agent's turn, by extension, layer, target and agent. */
  readonly #pendingConfigure = new Map<
    string,
    { action: ConfigureAction; actor: Extract<ExtensionActor, { readonly kind: 'agent' }> }
  >()

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
    // Asking twice for the same thing keeps one request, so the administrator never has to approve duplicates.
    const same = JSON.stringify(input.action)
    const existing = this.list('pending').find(
      (request) =>
        request.agentId === input.actor.agentId &&
        JSON.stringify(StoredPayloadSchema.safeParse(request.payload).data?.action) === same,
    )
    if (existing) return existing
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
    const superseded = this.#supersede(input.action, record.number, now)
    const replaces = superseded.length === 0 ? '' : `（取代 ${superseded.map((number) => `#${number}`).join('、')}）`
    const prefix = this.#commandPrefix(input.actor.channelId)
    this.#notice(
      input.actor.channelId,
      `ext-request:${record.number}:asked`,
      `${this.#agentName(input.actor.agentId)}请求${input.assessment.summary}${added}${replaces}。管理员发送 ${prefix}/ext approve ${record.number} 同意，或 ${prefix}/ext reject ${record.number} 拒绝；24 小时内有效。`,
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
    this.#settleAnswered(input.actor.agentId, input.action, record.number, now)
    const undo = this.#undoHint(input.action)
    this.#notice(
      input.actor.channelId,
      `ext-request:${record.number}:done`,
      `${this.#agentName(input.actor.agentId)}：${input.result.message}${undo}`,
    )
    this.#runtime.publishExtensionRequestChange?.()
    return this.#runtime.repository.getExtensionRequest(record.number) ?? record
  }

  /**
   * Carries out an agent's own action after its current turn: the action waits for the agent's safe gap, so the tool
   * call returns at once and the outcome is posted and reported when it lands.
   */
  runAfterTurn(input: {
    readonly action: ExtensionAction
    readonly actor: Extract<ExtensionActor, { readonly kind: 'agent' }>
    readonly assessment: ExtensionActionAssessment
  }): void {
    void this.#runtime.extensionActions
      .perform(input.action, input.actor)
      .then((result) => {
        const record = this.recordAutonomous({ ...input, result })
        this.#tellAgent(record, 'done', `〔系统通知〕${input.assessment.summary}已完成：${result.message}`)
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        this.#notice(
          input.actor.channelId,
          `ext-run:${input.actor.agentId}:${this.#now()}`,
          `${this.#agentName(input.actor.agentId)}没能${input.assessment.summary}：${message}`,
        )
        this.#runtime.host.notifyAgent({
          agentId: input.actor.agentId,
          ...(input.actor.channelId === undefined ? {} : { channelId: input.actor.channelId }),
          identity: `ext-run-failed:${input.actor.agentId}:${this.#now()}`,
          text: `〔系统通知〕${input.assessment.summary}没有完成：${message}。看一下原因再决定怎么处理。`,
        })
      })
  }

  /**
   * Carries out an agent's configuration change once its turn has ended. Changes to the same layer within one turn
   * are merged and written once; the merged change is judged again before it is written.
   */
  scheduleConfigure(input: {
    readonly action: ConfigureAction
    readonly actor: Extract<ExtensionActor, { readonly kind: 'agent' }>
  }): 'scheduled' | 'merged' {
    const { action, actor } = input
    const key = [action.extensionId, action.layer, action.agentId ?? '', actor.agentId].join('|')
    const pending = this.#pendingConfigure.get(key)
    if (pending !== undefined) {
      pending.action = mergeConfigure(pending.action, action)
      if (actor.requester === 'admin') pending.actor = actor
      return 'merged'
    }
    const entry = { action, actor }
    this.#pendingConfigure.set(key, entry)
    void this.#runtime.host
      .waitUntilSafe(actor.agentId)
      .catch(() => undefined)
      .then(() => {
        this.#pendingConfigure.delete(key)
        const assessment = this.#runtime.extensionActions.assess(entry.action, entry.actor)
        if (assessment.decision === 'run') {
          this.runAfterTurn({ action: entry.action, actor: entry.actor, assessment })
        } else if (assessment.decision === 'request') {
          const record = this.create({ action: entry.action, actor: entry.actor, assessment })
          this.#runtime.host.notifyAgent({
            agentId: actor.agentId,
            ...(actor.channelId === undefined ? {} : { channelId: actor.channelId }),
            identity: `ext-config-requested:${record.number}`,
            text: `〔系统通知〕${assessment.summary}需要管理员确认，已在频道里发出请求 #${record.number}。`,
          })
        } else {
          this.#runtime.host.notifyAgent({
            agentId: actor.agentId,
            ...(actor.channelId === undefined ? {} : { channelId: actor.channelId }),
            identity: `ext-config-console:${key}:${this.#now()}`,
            text: `〔系统通知〕${assessment.summary}没有完成：${assessment.reason ?? '需要管理员在后台处理。'}`,
          })
        }
      })
    return 'scheduled'
  }

  /**
   * Confirms a pending request and carries it out. The outcome goes back where the answer was given (the console's
   * response, or the chat command's reply) and to the agent; the request's channel gets no separate notice.
   */
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

  /** Takes back a request its agent filed, while it still waits; the record stays as withdrawn. */
  withdraw(number: number, agentId: AgentId): ExtensionRequestRecord {
    const record = this.#pending(number)
    if (record.agentId !== agentId) throw new Error(`请求 #${number} 不是你发起的，不能撤回。`)
    this.#runtime.repository.updateExtensionRequest({
      number,
      from: 'pending',
      status: 'withdrawn',
      result: { message: '发起方已撤回' },
      decidedBy: this.#agentName(agentId),
      decidedAt: this.#now(),
    })
    this.#runtime.publishExtensionRequestChange?.()
    return this.#runtime.repository.getExtensionRequest(number) ?? record
  }

  /** Marks older pending requests for the same thing as superseded by `by`; returns their numbers. */
  #supersede(action: ExtensionAction, by: number, now: number): number[] {
    const key = objectKey(action)
    if (key === undefined) return []
    const superseded: number[] = []
    for (const request of this.#runtime.repository.listExtensionRequests({ status: 'pending' })) {
      if (request.number === by) continue
      const older = StoredPayloadSchema.safeParse(request.payload).data?.action
      if (older === undefined || objectKey(older) !== key || !covers(action, older)) continue
      if (
        this.#runtime.repository.updateExtensionRequest({
          number: request.number,
          from: 'pending',
          status: 'superseded',
          result: { message: `已被请求 #${by} 取代` },
          decidedAt: now,
        })
      ) {
        superseded.push(request.number)
      }
    }
    return superseded
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
    if (record.status === 'superseded' || record.status === 'withdrawn') {
      const message = RequestResultSchema.safeParse(record.result).data?.message
      throw new Error(`请求 #${number} ${message ?? (record.status === 'withdrawn' ? '已撤回' : '已被新请求取代')}。`)
    }
    if (record.status !== 'pending') throw new Error(`请求 #${number} 已经被处理。`)
    return record
  }

  /** A request the agent has since carried out on its own no longer waits for an administrator. */
  #settleAnswered(agentId: AgentId, action: ExtensionAction, doneBy: number, now: number): void {
    const key = actionKey(action)
    for (const request of this.#runtime.repository.listExtensionRequests({ status: 'pending' })) {
      if (request.agentId !== agentId || request.number === doneBy) continue
      if (actionKey(StoredPayloadSchema.safeParse(request.payload).data?.action) !== key) continue
      this.#runtime.repository.updateExtensionRequest({
        number: request.number,
        from: 'pending',
        status: 'completed',
        result: { message: `智能体已自主完成（#${doneBy}）` },
        decidedBy: this.#agentName(agentId),
        decidedAt: now,
      })
    }
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
    if (action.kind === 'configure' || action.kind === 'revert-config') {
      return '如需撤销，可以在扩展详情的配置历史里恢复之前的版本。'
    }
    return action.kind === 'switch' || action.kind === 'community-update'
      ? '如需撤销，管理员发送 /ext revert 扩展名。'
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
