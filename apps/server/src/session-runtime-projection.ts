import { sessionEvents } from './session-event-history.js'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentStatus } from '@deepseek-ai/dsh-agent'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { AgentRevisionRecord } from '@nekro-nxt/core'
import {
  ChannelIdSchema,
  type ChannelId,
  type ChannelRuntimeOccupancy,
  type ChannelRuntimeToolProgress,
} from '@nekro-nxt/contracts'
import type { SessionRegistry } from './session-registry.js'
import { shouldBroadcastChannelRuntime } from './channel-runtime-events.js'
import { projectSessionOccupancy, type RuntimePerformanceTotals } from './channel-runtime-projection.js'

/** A running tool's progress reaches the channel at most this often. */
export const TOOL_PROGRESS_INTERVAL_MS = 500
const TOOL_PROGRESS_MAX_CHARS = 200

/** A progress report as a tool sent it, or undefined when it is not one. */
const ProgressInputSchema = z.object({ text: z.string(), fraction: z.unknown().optional() })

export const toolProgressUpdate = (update: unknown): ChannelRuntimeToolProgress | undefined => {
  const parsed = ProgressInputSchema.safeParse(update)
  if (!parsed.success || parsed.data.text.trim() === '') return undefined
  const { fraction } = parsed.data
  const trimmed = parsed.data.text.trim()
  return {
    text: trimmed.length <= TOOL_PROGRESS_MAX_CHARS ? trimmed : `${trimmed.slice(0, TOOL_PROGRESS_MAX_CHARS - 1)}…`,
    ...(typeof fraction === 'number' && Number.isFinite(fraction)
      ? { fraction: Math.min(1, Math.max(0, fraction)) }
      : {}),
  }
}

const CallIdSchema = z.union([z.string(), z.number()]).transform(String)
const ToolResultDataSchema = z.object({ message: z.object({ toolCallId: CallIdSchema }) })
const PtcDispatchDataSchema = z.object({ subCallId: CallIdSchema })

/** The call a `tool/result` or a `run_code` sub-call result event closes. */
const returnedCallId = (event: { readonly type?: string; readonly data?: unknown } | undefined): string | undefined => {
  if (event?.type === 'tool/result') return ToolResultDataSchema.safeParse(event.data).data?.message.toolCallId
  if (event?.type === 'tool/ptc-dispatch') return PtcDispatchDataSchema.safeParse(event.data).data?.subCallId
  return undefined
}

/** Projects live Session facts and owns the lifetime of projection subscriptions. */
export class SessionRuntimeProjection {
  readonly #context: Context
  readonly #sessions: SessionRegistry<unknown>
  readonly #subscriptions = new Set<() => void>()
  readonly #channelNotifiers = new Set<(channelId: ChannelId) => void>()
  /** Latest progress of running tools per Session, kept in memory until the call returns or the Session idles. */
  readonly #toolProgress = new Map<string, Map<string, ChannelRuntimeToolProgress>>()
  readonly #progressPublishedAt = new Map<string, number>()
  readonly #progressTimers = new Map<string, NodeJS.Timeout>()
  readonly #now: () => number

  constructor(context: Context, sessions: SessionRegistry<unknown>, now: () => number = Date.now) {
    this.#context = context
    this.#sessions = sessions
    this.#now = now
    const offStatus = context.on('agent/status', ({ agent }) => {
      if (agent.status !== 'running') this.#clearProgress(String(agent.id))
    })
    const offResult = context.on(
      'session/event',
      (session: { readonly id: string }, event?: { readonly type?: string; readonly data?: unknown }) => {
        const callId = returnedCallId(event)
        if (callId !== undefined) this.#toolProgress.get(String(session.id))?.delete(callId)
      },
    )
    this.#subscriptions.add(() => {
      offStatus()
      offResult()
    })
  }

  /**
   * Records the latest progress of one running tool call and republishes its channel, at most every
   * {@link TOOL_PROGRESS_INTERVAL_MS}; reports in between replace each other and the last one is published.
   */
  reportToolProgress(sessionId: string, callId: string, update: unknown): void {
    const progress = toolProgressUpdate(update)
    const channelId = this.#sessions.get(sessionId)?.channelId
    if (progress === undefined || channelId === undefined) return
    let calls = this.#toolProgress.get(sessionId)
    if (calls === undefined) this.#toolProgress.set(sessionId, (calls = new Map<string, ChannelRuntimeToolProgress>()))
    calls.set(callId, progress)
    const key = `${sessionId}\0${callId}`
    if (this.#progressTimers.has(key)) return
    const wait = (this.#progressPublishedAt.get(key) ?? 0) + TOOL_PROGRESS_INTERVAL_MS - this.#now()
    const publish = (): void => {
      this.#progressTimers.delete(key)
      this.#progressPublishedAt.set(key, this.#now())
      this.touchChannel(channelId)
    }
    if (wait <= 0) publish()
    else {
      const timer = setTimeout(publish, wait)
      timer.unref()
      this.#progressTimers.set(key, timer)
    }
  }

  /** Latest progress of the Session's running tool calls, by call id. */
  toolProgress(sessionId: string): ReadonlyMap<string, ChannelRuntimeToolProgress> {
    return this.#toolProgress.get(sessionId) ?? new Map<string, ChannelRuntimeToolProgress>()
  }

  #clearProgress(sessionId: string): void {
    this.#toolProgress.delete(sessionId)
    for (const [key, timer] of this.#progressTimers) {
      if (!key.startsWith(`${sessionId}\0`)) continue
      clearTimeout(timer)
      this.#progressTimers.delete(key)
    }
    for (const key of this.#progressPublishedAt.keys()) {
      if (key.startsWith(`${sessionId}\0`)) this.#progressPublishedAt.delete(key)
    }
  }

  /** Aggregate the public DSH status of every live Session owned by one product intelligent-agent. */
  runtimeStatus(agentId: AgentRevisionRecord['agentId']): AgentStatus {
    for (const {
      sessionId,
      revision: { agentId: ownedAgentId },
    } of this.#sessions.records()) {
      if (ownedAgentId === agentId && this.#context.agents.get(SessionId(sessionId))?.status === 'running') {
        return 'running'
      }
    }
    return 'idle'
  }

  /** Notify the product projection when DSH enters or leaves active turn processing. */
  subscribeRuntimeStatus(
    listener: (change: { readonly agentId: AgentRevisionRecord['agentId']; readonly status: AgentStatus }) => void,
  ): () => boolean {
    const off = this.#context.on('agent/status', ({ agent }) => {
      const agentId = this.#sessions.get(agent.id)?.revision.agentId
      if (agentId === undefined) return
      listener({ agentId, status: this.runtimeStatus(agentId) })
    })
    const dispose = () => {
      this.#subscriptions.delete(dispose)
      return off()
    }
    this.#subscriptions.add(dispose)
    return dispose
  }

  tryLiveSession(
    dshSessionId: string,
  ): { readonly status: AgentStatus; readonly events: readonly SessionEvent[] } | undefined {
    const agent = this.#context.agents.get(SessionId(dshSessionId))
    if (!agent) return undefined
    return { status: agent.status, events: sessionEvents(agent.session) }
  }

  sessionRuntimeMetrics(
    dshSessionId: string,
  ):
    | { readonly occupancy?: ChannelRuntimeOccupancy; readonly performanceTotals?: RuntimePerformanceTotals }
    | undefined {
    const agent = this.#context.agents.get(SessionId(dshSessionId))
    if (!agent) return undefined
    const snapshot = this.#context.sessionProjections.snapshot(agent.session)
    const occupancy = projectSessionOccupancy({
      projectedTokens: snapshot.values.contextPressure?.projectedTokens,
      contextWindow: snapshot.values.contextPressure?.contextWindow,
      systemTokens: snapshot.values.contextBreakdown?.systemTokens,
      toolsTokens: snapshot.values.contextBreakdown?.toolsTokens,
      messageTokens: snapshot.values.contextBreakdown?.messageTokens,
      imageCount: agent.session
        .deriveMessages()
        .reduce(
          (count, message) =>
            count + message.content.filter((block) => block.type === 'image' && block.offloaded !== true).length,
          0,
        ),
    })
    const performanceTotals = snapshot.values.sessionStats
    if (occupancy === undefined && performanceTotals === undefined) return undefined
    return {
      ...(occupancy === undefined ? {} : { occupancy }),
      ...(performanceTotals === undefined ? {} : { performanceTotals }),
    }
  }

  /** Re-publish a channel's runtime when something outside its session changed it, such as a compaction wait. */
  touchChannel(channelId: string): void {
    for (const notify of this.#channelNotifiers) notify(ChannelIdSchema.parse(channelId))
  }

  subscribeChannelRuntime(listener: (channelId: ChannelId) => void): () => void {
    const offStatus = this.#context.on('agent/status', ({ agent }) => {
      const channelId = this.#sessions.get(String(agent.id))?.channelId
      if (channelId !== undefined) notify(channelId)
    })
    const pending = new Set<ChannelId>()
    // A deterministic failure would repeat on every event; report it once until the channel recovers.
    const failing = new Set<ChannelId>()
    let timer: ReturnType<typeof setTimeout> | undefined
    const flush = (): void => {
      timer = undefined
      const channelIds = [...pending]
      pending.clear()
      for (const channelId of channelIds) {
        try {
          listener(channelId)
          failing.delete(channelId)
        } catch (error) {
          if (failing.has(channelId)) continue
          failing.add(channelId)
          this.#context.logger.error('频道运行状态推送失败（%s）：%s', channelId, error)
        }
      }
    }
    const notify = (channelId: ChannelId): void => {
      pending.add(channelId)
      timer ??= setTimeout(flush, 100)
    }
    this.#channelNotifiers.add(notify)
    const offEvent = this.#context.on(
      'session/event',
      (session: { readonly id: string }, event?: { readonly type?: string }) => {
        if (!shouldBroadcastChannelRuntime(event?.type)) return
        const channelId = this.#sessions.get(String(session.id))?.channelId
        if (channelId !== undefined) notify(channelId)
      },
    )
    const offOccupancy = this.#context.sessionProjections.onChanged((session, key) => {
      if (key !== 'contextPressure' && key !== 'contextBreakdown' && key !== 'sessionStats') return
      const channelId = this.#sessions.get(String(session.id))?.channelId
      if (channelId !== undefined) notify(channelId)
    })
    const dispose = () => {
      this.#subscriptions.delete(dispose)
      pending.clear()
      failing.clear()
      if (timer !== undefined) clearTimeout(timer)
      this.#channelNotifiers.delete(notify)
      offStatus()
      offEvent()
      offOccupancy()
    }
    this.#subscriptions.add(dispose)
    return dispose
  }

  dispose(): void {
    for (const dispose of this.#subscriptions) dispose()
    for (const timer of this.#progressTimers.values()) clearTimeout(timer)
    this.#progressTimers.clear()
    this.#toolProgress.clear()
  }
}
