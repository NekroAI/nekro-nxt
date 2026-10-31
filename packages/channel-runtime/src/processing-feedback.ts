import type { AdapterCapabilityState, AdapterRuntimeStateStore } from '@nekro-nxt/adapter-sdk'
import type { ChannelId, ConnectionId, EpisodeId } from '@nekro-nxt/contracts'
import {
  ChannelIdSchema,
  ConnectionIdSchema,
  EpisodeIdSchema,
  JsonValueSchema,
  parseJsonValue,
} from '@nekro-nxt/contracts'
import type { BindingRecord, ChannelEventRecord, CoreRepository } from '@nekro-nxt/core'
import type { ChannelRuntimeOptions, EpisodeRecord } from './index.js'
const FEEDBACK_STATE_KEY = 'host/processing-feedback-leases'

const FEEDBACK_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const

const FEEDBACK_MAX_AGE_MS = 24 * 60 * 60 * 1000

interface ProcessingFeedbackLease {
  readonly id: string
  readonly connectionId: ConnectionId
  readonly channelId: ChannelId
  readonly episodeId: EpisodeId
  readonly platformMessageId: string
  readonly state: 'planned' | 'active' | 'cleanup-pending'
  readonly attempts: number
  readonly createdAt: number
  readonly updatedAt: number
}

const parseFeedbackLease = (candidate: unknown): ProcessingFeedbackLease | undefined => {
  const parsed = JsonValueSchema.safeParse(candidate)
  if (!parsed.success || typeof parsed.data !== 'object' || parsed.data === null || Array.isArray(parsed.data))
    return undefined
  const row = parsed.data
  const connectionId = ConnectionIdSchema.safeParse(row['connectionId'])
  const channelId = ChannelIdSchema.safeParse(row['channelId'])
  const episodeId = EpisodeIdSchema.safeParse(row['episodeId'])
  const state = row['state']
  if (
    typeof row['id'] !== 'string' ||
    !connectionId.success ||
    !channelId.success ||
    !episodeId.success ||
    typeof row['platformMessageId'] !== 'string' ||
    (state !== 'planned' && state !== 'active' && state !== 'cleanup-pending') ||
    typeof row['attempts'] !== 'number' ||
    typeof row['createdAt'] !== 'number' ||
    typeof row['updatedAt'] !== 'number'
  )
    return undefined
  return {
    id: row['id'],
    connectionId: connectionId.data,
    channelId: channelId.data,
    episodeId: episodeId.data,
    platformMessageId: row['platformMessageId'],
    state,
    attempts: row['attempts'],
    createdAt: row['createdAt'],
    updatedAt: row['updatedAt'],
  }
}
type FeedbackStatus =
  { readonly kind: 'unsupported'; readonly message: string } | { readonly kind: 'failed'; readonly message: string }

export class ProcessingFeedback {
  #stopping = false
  readonly #retryTimers = new Map<ReturnType<typeof setTimeout>, () => void>()
  readonly #coreRepository: CoreRepository
  readonly #resolveAdapter: ChannelRuntimeOptions['resolveAdapter']
  readonly #adapterState: AdapterRuntimeStateStore | undefined
  readonly #timestamp: () => number
  constructor(
    repository: CoreRepository,
    resolveAdapter: ChannelRuntimeOptions['resolveAdapter'],
    state: AdapterRuntimeStateStore | undefined,
    timestamp: () => number,
  ) {
    this.#coreRepository = repository
    this.#resolveAdapter = resolveAdapter
    this.#adapterState = state
    this.#timestamp = timestamp
  }
  readonly #feedbackLeases = new Map<string, ProcessingFeedbackLease>()
  // One claim per processing cycle, retained even if delivery consumes its platform feedback early.
  readonly #feedbackCycles = new Map<EpisodeId, { readonly leaseId: string; idleTracked: boolean }>()
  readonly #feedbackDisabledConnections = new Set<ConnectionId>()
  readonly #feedbackTasks = new Set<Promise<void>>()
  readonly #feedbackCleanups = new Map<string, Promise<void>>()
  readonly #feedbackEndReasons = new Map<
    EpisodeId,
    'idle' | 'error' | 'cancelled' | 'timeout' | 'shutdown' | 'recovery'
  >()
  readonly #feedbackPersistence = new Map<ConnectionId, Promise<void>>()
  // The latest problem per connection, cleared by the next success; shown next to the channel's feedback switch.
  readonly #feedbackStatus = new Map<ConnectionId, FeedbackStatus>()
  readonly #statusListeners = new Set<(connectionId: ConnectionId) => void>()
  status(connectionId: ConnectionId): AdapterCapabilityState | undefined {
    const status = this.#feedbackStatus.get(connectionId)
    if (status === undefined) return undefined
    return status.kind === 'unsupported'
      ? { state: 'unsupported', reason: `协议端不支持处理中回应，重启后再试：${status.message}` }
      : { state: 'degraded', reason: `最近一次没挂上：${status.message}` }
  }
  subscribeStatus(listener: (connectionId: ConnectionId) => void): () => void {
    this.#statusListeners.add(listener)
    return () => this.#statusListeners.delete(listener)
  }
  markEndReason(episodeId: EpisodeId, reason: 'cancelled' | 'timeout'): void {
    this.#feedbackEndReasons.set(episodeId, reason)
  }
  getLease(id: string): ProcessingFeedbackLease | undefined {
    return this.#feedbackLeases.get(id)
  }
  latestActiveLease(episodeId: EpisodeId): ProcessingFeedbackLease | undefined {
    const cycle = this.#feedbackCycles.get(episodeId)
    const lease = cycle === undefined ? undefined : this.#feedbackLeases.get(cycle.leaseId)
    return lease?.state === 'active' ? lease : undefined
  }
  finishWhenIdle(episodeId: EpisodeId, idle: Promise<void>): void {
    const cycle = this.#feedbackCycles.get(episodeId)
    if (!cycle || cycle.idleTracked) return
    cycle.idleTracked = true
    this.#trackFeedbackTask(
      idle.then(async () => {
        if (this.#feedbackCycles.get(episodeId) === cycle) this.#feedbackCycles.delete(episodeId)
        // An older idle observer must never clean up a newer cycle in the same Episode.
        await this.cleanupFeedbackLease(cycle.leaseId, this.#feedbackEndReasons.get(episodeId) ?? 'idle')
        if (![...this.#feedbackLeases.values()].some((lease) => lease.episodeId === episodeId)) {
          this.#feedbackEndReasons.delete(episodeId)
        }
      }),
    )
  }

  async recoverProcessingFeedback(): Promise<void> {
    this.#stopping = false
    if (!this.#adapterState) return
    for (const connectionId of this.#coreRepository.listConnectionIdsByAdapter()) {
      const raw = await this.#adapterState.load(connectionId, FEEDBACK_STATE_KEY)
      if (!Array.isArray(raw)) continue
      for (const candidate of raw) {
        const lease = parseFeedbackLease(candidate)
        if (!lease) continue
        if (lease.connectionId !== connectionId) continue
        this.#feedbackLeases.set(lease.id, lease)
        this.#trackFeedbackTask(this.cleanupFeedbackLease(lease.id, 'recovery'))
      }
    }
  }

  async stopProcessingFeedback(): Promise<void> {
    this.#stopping = true
    this.#feedbackCycles.clear()
    for (const [timer, resolve] of this.#retryTimers) {
      clearTimeout(timer)
      resolve()
    }
    this.#retryTimers.clear()
    for (const lease of this.#feedbackLeases.values())
      this.#trackFeedbackTask(this.cleanupFeedbackLease(lease.id, 'shutdown'))
    while (this.#feedbackTasks.size > 0) await Promise.allSettled([...this.#feedbackTasks])
  }

  async startProcessingFeedback(
    binding: BindingRecord,
    episode: EpisodeRecord,
    event: ChannelEventRecord,
  ): Promise<string | undefined> {
    if (
      this.#stopping ||
      binding.processingFeedback !== 'auto' ||
      event.kind !== 'message-created' ||
      event.activityKey !== undefined ||
      event.platformMessageId === undefined
    )
      return undefined
    if (this.#feedbackCycles.has(episode.id)) return undefined
    const channel = this.#coreRepository.getChannel(event.channelId)
    if (!channel || channel.kind !== 'group' || this.#feedbackDisabledConnections.has(channel.connectionId))
      return undefined
    const adapter = this.#resolveAdapter(channel.connectionId)
    if (!adapter?.interactions?.startProcessingFeedback) return undefined
    const now = this.#timestamp()
    const lease: ProcessingFeedbackLease = {
      // A finished wait can react to a message an earlier cycle already used, so the time keeps leases apart.
      id: `feedback:${episode.id}:${event.id}:${now}`,
      connectionId: channel.connectionId,
      channelId: channel.id,
      episodeId: episode.id,
      platformMessageId: event.platformMessageId,
      state: 'planned',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    }
    const cycle = { leaseId: lease.id, idleTracked: false }
    this.#feedbackCycles.set(episode.id, cycle)
    this.#feedbackLeases.set(lease.id, lease)
    try {
      await this.#persistFeedbackLeases(channel.connectionId)
      const outcome = await adapter.interactions
        .startProcessingFeedback({
          leaseId: lease.id,
          channelId: channel.id,
          platformMessageId: event.platformMessageId,
        })
        .catch((error: unknown) => ({
          status: 'failed' as const,
          message: error instanceof Error ? error.message : String(error),
        }))
      if (outcome.status === 'unsupported') {
        this.#disable(channel.connectionId, outcome.message)
        this.#feedbackLeases.delete(lease.id)
        if (this.#feedbackCycles.get(episode.id) === cycle) this.#feedbackCycles.delete(episode.id)
        await this.#persistFeedbackLeases(channel.connectionId)
        return undefined
      }
      if (outcome.status === 'succeeded') {
        this.#recordStatus(channel.connectionId, undefined)
        this.#feedbackLeases.set(lease.id, { ...lease, state: 'active', updatedAt: this.#timestamp() })
      } else {
        console.warn(
          `[nekro-nxt] 连接 ${channel.connectionId} 没能给消息 ${event.platformMessageId} 挂处理中回应：${outcome.message}`,
        )
        this.#recordStatus(channel.connectionId, { kind: 'failed', message: outcome.message })
        // A definite failure left nothing on the message; only an unknown outcome may still need removing.
        if (outcome.status === 'failed') this.#feedbackLeases.delete(lease.id)
        else this.#feedbackLeases.set(lease.id, { ...lease, state: 'cleanup-pending', updatedAt: this.#timestamp() })
      }
      await this.#persistFeedbackLeases(channel.connectionId)
      // The cycle stays claimed either way, so one message is never retried within the same turn.
      return lease.id
    } catch (error) {
      if (this.#feedbackCycles.get(episode.id) === cycle) this.#feedbackCycles.delete(episode.id)
      this.#trackFeedbackTask(this.cleanupFeedbackLease(lease.id, 'error'))
      throw error
    }
  }

  async cleanupEpisodeFeedback(
    episodeId: EpisodeId,
    reason?: 'idle' | 'error' | 'cancelled' | 'timeout' | 'shutdown' | 'recovery',
  ): Promise<void> {
    this.#feedbackCycles.delete(episodeId)
    if (reason !== undefined) this.#feedbackEndReasons.set(episodeId, reason)
    const resolvedReason = this.#feedbackEndReasons.get(episodeId) ?? 'idle'
    const leases = [...this.#feedbackLeases.values()].filter((lease) => lease.episodeId === episodeId)
    await Promise.allSettled(leases.map((lease) => this.cleanupFeedbackLease(lease.id, resolvedReason)))
    if (![...this.#feedbackLeases.values()].some((lease) => lease.episodeId === episodeId)) {
      this.#feedbackEndReasons.delete(episodeId)
    }
  }

  async cleanupFeedbackLease(
    leaseId: string,
    reason: 'idle' | 'error' | 'cancelled' | 'timeout' | 'shutdown' | 'recovery',
  ): Promise<void> {
    const current = this.#feedbackCleanups.get(leaseId)
    if (current) return current
    const cleanup = this.#performFeedbackCleanup(leaseId, reason)
    const tracked = cleanup.finally(() => {
      if (this.#feedbackCleanups.get(leaseId) === tracked) this.#feedbackCleanups.delete(leaseId)
    })
    this.#feedbackCleanups.set(leaseId, tracked)
    return tracked
  }

  async #performFeedbackCleanup(
    leaseId: string,
    reason: 'idle' | 'error' | 'cancelled' | 'timeout' | 'shutdown' | 'recovery',
  ): Promise<void> {
    const lease = this.#feedbackLeases.get(leaseId)
    if (!lease) return
    if (this.#timestamp() - lease.createdAt >= FEEDBACK_MAX_AGE_MS) return
    const adapter = this.#resolveAdapter(lease.connectionId)
    if (!adapter?.interactions?.finishProcessingFeedback) return
    const outcome = await adapter.interactions
      .finishProcessingFeedback({
        leaseId: lease.id,
        channelId: lease.channelId,
        platformMessageId: lease.platformMessageId,
        reason,
      })
      .catch((error: unknown) => ({
        status: 'failed' as const,
        message: error instanceof Error ? error.message : String(error),
      }))
    if (outcome.status === 'succeeded' || outcome.status === 'unsupported') {
      if (outcome.status === 'unsupported') this.#disable(lease.connectionId, outcome.message)
      this.#feedbackLeases.delete(lease.id)
      await this.#persistFeedbackLeases(lease.connectionId)
      return
    }
    const attempts = lease.attempts + 1
    this.#feedbackLeases.set(lease.id, {
      ...lease,
      state: 'cleanup-pending',
      attempts,
      updatedAt: this.#timestamp(),
    })
    await this.#persistFeedbackLeases(lease.connectionId)
    if (this.#stopping) return
    const delay = FEEDBACK_RETRY_DELAYS_MS[attempts - 1]
    if (delay === undefined) {
      // Give up on this one message only; a stuck reaction must not switch feedback off for the whole connection.
      console.warn(
        `[nekro-nxt] 连接 ${lease.connectionId} 重试 ${attempts} 次仍没能撤下消息 ${lease.platformMessageId} 的处理中回应：${outcome.message}`,
      )
      this.#recordStatus(lease.connectionId, { kind: 'failed', message: `撤下回应失败：${outcome.message}` })
      this.#feedbackLeases.delete(lease.id)
      await this.#persistFeedbackLeases(lease.connectionId)
      return
    }
    this.#trackFeedbackTask(
      new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.#retryTimers.delete(timer)
          resolve()
        }, delay)
        this.#retryTimers.set(timer, resolve)
      }).then(() => {
        if (!this.#stopping) return this.cleanupFeedbackLease(lease.id, reason)
        return undefined
      }),
    )
  }

  async #persistFeedbackLeases(connectionId: ConnectionId): Promise<void> {
    if (!this.#adapterState) return
    const previous = this.#feedbackPersistence.get(connectionId) ?? Promise.resolve()
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const leases = [...this.#feedbackLeases.values()].filter((lease) => lease.connectionId === connectionId)
        if (leases.length === 0) await this.#adapterState!.clear(connectionId, FEEDBACK_STATE_KEY)
        else await this.#adapterState!.save(connectionId, FEEDBACK_STATE_KEY, parseJsonValue(leases), this.#timestamp())
      })
    this.#feedbackPersistence.set(connectionId, next)
    try {
      await next
    } finally {
      if (this.#feedbackPersistence.get(connectionId) === next) this.#feedbackPersistence.delete(connectionId)
    }
  }

  #disable(connectionId: ConnectionId, message: string): void {
    this.#feedbackDisabledConnections.add(connectionId)
    console.warn(`[nekro-nxt] 连接 ${connectionId} 的协议端不支持处理中回应，重启前不再尝试：${message}`)
    this.#recordStatus(connectionId, { kind: 'unsupported', message })
  }

  #recordStatus(connectionId: ConnectionId, status: FeedbackStatus | undefined): void {
    const previous = this.#feedbackStatus.get(connectionId)
    if (previous?.kind === 'unsupported') return
    if (previous?.kind === status?.kind && previous?.message === status?.message) return
    if (status === undefined) this.#feedbackStatus.delete(connectionId)
    else this.#feedbackStatus.set(connectionId, status)
    for (const listener of this.#statusListeners) listener(connectionId)
  }

  #trackFeedbackTask(task: Promise<void>): void {
    this.#feedbackTasks.add(task)
    void task.finally(() => this.#feedbackTasks.delete(task)).catch(() => undefined)
  }

  async settleConsumedFeedback(leaseId: string): Promise<void> {
    const lease = this.#feedbackLeases.get(leaseId)
    if (!lease) return
    this.#feedbackLeases.delete(leaseId)
    await this.#persistFeedbackLeases(lease.connectionId)
  }
}
