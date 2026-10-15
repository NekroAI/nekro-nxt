import type { AgentId, ChannelId, ExtensionId, JsonValue } from '@nekro-nxt/contracts'
import type { ExtensionRequestRecord } from '@nekro-nxt/storage-sqlite'
import type { NekroRuntime } from '../bootstrap.js'
import type {
  ExtensionAction,
  ExtensionActionAssessment,
  ExtensionActionResult,
  ExtensionActor,
} from './actions.js'

/** Requests wait a day for an administrator; after that the agent has to ask again. */
export const EXTENSION_REQUEST_TTL_MS = 24 * 60 * 60 * 1000

/** Who decided a request: the console, or an administrator's platform account in chat. */
export type ExtensionRequestDecider = { readonly kind: 'console' } | { readonly kind: 'administrator'; readonly label: string }

const extensionOf = (action: ExtensionAction): ExtensionId | undefined => {
  switch (action.kind) {
    case 'save':
    case 'community-install':
    case 'community-withdraw':
      return undefined
    case 'branch':
      return undefined
    case 'migrate-data':
      return action.targetExtensionId
    default:
      return action.extensionId
  }
}

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
      payload: { action: input.action, added: input.assessment.added, level: input.assessment.level } as unknown as JsonValue,
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
      payload: { action: input.action, autonomous: true } as unknown as JsonValue,
      createdAt: now,
      expiresAt: now,
    })
    this.#runtime.repository.updateExtensionRequest({
      number: record.number,
      from: 'pending',
      status: 'completed',
      result: { message: input.result.message } as JsonValue,
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
    if (!this.#runtime.repository.updateExtensionRequest({ number, from: 'pending', status: 'approved', decidedBy: label, decidedAt: now })) {
      throw new Error(`请求 #${number} 已经被处理。`)
    }
    try {
      const result = await this.#runtime.extensionActions.perform(action, actor)
      this.#runtime.repository.updateExtensionRequest({
        number,
        from: 'approved',
        status: 'completed',
        result: { message: result.message } as JsonValue,
      })
      this.#notice(record.channelId ?? undefined, `ext-request:${number}:done`, `请求 #${number} 已由${label}同意：${result.message}`)
      this.#tellAgent(record, 'done', `〔系统通知〕扩展请求 #${number}（${record.summary}）已由${label}同意并完成：${result.message}`)
      this.#runtime.publishExtensionRequestChange?.()
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.#runtime.repository.updateExtensionRequest({
        number,
        from: 'approved',
        status: 'failed',
        result: { message } as JsonValue,
      })
      this.#notice(record.channelId ?? undefined, `ext-request:${number}:failed`, `请求 #${number} 已同意，但没有完成：${message}`)
      this.#tellAgent(record, 'failed', `〔系统通知〕扩展请求 #${number}（${record.summary}）已同意，但执行失败：${message}。看一下原因再决定怎么处理。`)
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
        ...(reason === undefined ? {} : { result: { message: reason } as JsonValue }),
      })
    ) {
      throw new Error(`请求 #${number} 已经被处理。`)
    }
    this.#notice(record.channelId ?? undefined, `ext-request:${number}:rejected`, `请求 #${number} 已被${label}拒绝${reason ? `：${reason}` : '。'}`)
    this.#tellAgent(record, 'rejected', `〔系统通知〕扩展请求 #${number}（${record.summary}）被${label}拒绝${reason ? `：${reason}` : '。'}不要再自行重试同一个请求。`)
    this.#runtime.publishExtensionRequestChange?.()
  }

  expire(): void {
    if (this.#runtime.repository.expireExtensionRequests(this.#now()) > 0) this.#runtime.publishExtensionRequestChange?.()
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
    const payload = record.payload as { readonly action?: ExtensionAction }
    if (payload.action === undefined) throw new Error(`请求 #${record.number} 的内容无法读取。`)
    return payload.action
  }

  /** External groups only take commands addressed to the bot, so the hint says so. */
  #commandPrefix(channelId: ChannelId | undefined): string {
    if (channelId === undefined) return ''
    const channel = this.#runtime.repository.getChannel(channelId)
    return channel?.kind === 'group' ? '@机器人 ' : ''
  }

  #undoHint(action: ExtensionAction): string {
    return action.kind === 'switch' || action.kind === 'community-update' ? '。如需撤销，管理员发送 /ext rollback 扩展名。' : ''
  }

  #notice(channelId: ChannelId | undefined, key: string, text: string): void {
    if (channelId === undefined) return
    void this.#runtime.channels
      .sendHostNotice({ channelId, noticeKey: key, parts: [{ type: 'text', text }] })
      .catch((error: unknown) => {
        console.error('[nekro-nxt] 扩展通知发送失败：', error)
      })
  }

  #tellAgent(record: ExtensionRequestRecord, outcome: 'done' | 'failed' | 'rejected', text: string): void {
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
