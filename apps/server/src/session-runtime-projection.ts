import type { Context } from '@deepseek-ai/cordis'
import type { AgentStatus } from '@deepseek-ai/dsh-agent'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { AgentRevisionRecord } from '@nekro-nxt/core'
import type { ChannelId, ChannelRuntimeOccupancy } from '@nekro-nxt/contracts'
import type { SessionRegistry } from './session-registry.js'
import { shouldBroadcastChannelRuntime } from './channel-runtime-events.js'
import { projectSessionOccupancy, type RuntimePerformanceTotals } from './channel-runtime-projection.js'

/** Projects live Session facts and owns the lifetime of projection subscriptions. */
export class SessionRuntimeProjection {
  readonly #context: Context
  readonly #sessions: SessionRegistry<unknown>
  readonly #subscriptions = new Set<() => void>()

  constructor(context: Context, sessions: SessionRegistry<unknown>) {
    this.#context = context
    this.#sessions = sessions
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
    return { status: agent.status, events: agent.session.events }
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
    })
    const performanceTotals = snapshot.values.sessionStats
    if (occupancy === undefined && performanceTotals === undefined) return undefined
    return {
      ...(occupancy === undefined ? {} : { occupancy }),
      ...(performanceTotals === undefined ? {} : { performanceTotals }),
    }
  }

  subscribeChannelRuntime(listener: (channelId: ChannelId) => void): () => void {
    const offStatus = this.#context.on('agent/status', ({ agent }) => {
      const channelId = this.#sessions.get(String(agent.id))?.channelId
      if (channelId !== undefined) notify(channelId)
    })
    const pending = new Set<ChannelId>()
    let timer: ReturnType<typeof setTimeout> | undefined
    const flush = (): void => {
      timer = undefined
      const channelIds = [...pending]
      pending.clear()
      for (const channelId of channelIds) listener(channelId)
    }
    const notify = (channelId: ChannelId): void => {
      pending.add(channelId)
      timer ??= setTimeout(flush, 100)
    }
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
      if (timer !== undefined) clearTimeout(timer)
      offStatus()
      offEvent()
      offOccupancy()
    }
    this.#subscriptions.add(dispose)
    return dispose
  }

  dispose(): void {
    for (const dispose of this.#subscriptions) dispose()
  }
}
