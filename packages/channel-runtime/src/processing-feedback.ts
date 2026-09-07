import type { AdapterRuntimeStateStore } from '@nekro-nxt/adapter-sdk'
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
  readonly #feedbackDisabledConnections = new Set<ConnectionId>()
  readonly #feedbackTasks = new Set<Promise<void>>()
  readonly #feedbackCleanups = new Map<string, Promise<void>>()
  readonly #feedbackEndReasons = new Map<
    EpisodeId,
    'idle' | 'error' | 'cancelled' | 'timeout' | 'shutdown' | 'recovery'
  >()
  readonly #feedbackPersistence = new Map<ConnectionId, Promise<void>>()
  markEndReason(episodeId: EpisodeId, reason: 'cancelled' | 'timeout'): void {
    this.#feedbackEndReasons.set(episodeId, reason)
  }
  getLease(id: string): ProcessingFeedbackLease | undefined {
    return this.#feedbackLeases.get(id)
  }
  latestActiveLease(episodeId: EpisodeId): ProcessingFeedbackLease | undefined {
    return [...this.#feedbackLeases.values()]
      .filter((lease) => lease.episodeId === episodeId && lease.state === 'active')
      .sort((left, right) => right.createdAt - left.createdAt)[0]
  }
  finishWhenIdle(episodeId: EpisodeId, idle: Promise<void>): void {
    this.#trackFeedbackTask(idle.then(() => this.cleanupEpisodeFeedback(episodeId)))
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
    const channel = this.#coreRepository.getChannel(event.channelId)
    if (!channel || channel.kind !== 'group' || this.#feedbackDisabledConnections.has(channel.connectionId))
      return undefined
    const adapter = this.#resolveAdapter(channel.connectionId)
    if (!adapter?.interactions?.startProcessingFeedback) return undefined
    const now = this.#timestamp()
    const lease: ProcessingFeedbackLease = {
      id: `feedback:${episode.id}:${event.id}`,
      connectionId: channel.connectionId,
      channelId: channel.id,
      episodeId: episode.id,
      platformMessageId: event.platformMessageId,
      state: 'planned',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    }
    this.#feedbackLeases.set(lease.id, lease)
    await this.#persistFeedbackLeases(channel.connectionId)
    const outcome = await adapter.interactions
      .startProcessingFeedback({ leaseId: lease.id, channelId: channel.id, platformMessageId: event.platformMessageId })
      .catch((error: unknown) => ({
        status: 'failed' as const,
        message: error instanceof Error ? error.message : String(error),
      }))
    if (outcome.status === 'unsupported') {
      this.#feedbackDisabledConnections.add(channel.connectionId)
      this.#feedbackLeases.delete(lease.id)
      await this.#persistFeedbackLeases(channel.connectionId)
      return undefined
    }
    this.#feedbackLeases.set(lease.id, {
      ...lease,
      state: outcome.status === 'succeeded' ? 'active' : 'cleanup-pending',
      updatedAt: this.#timestamp(),
    })
    await this.#persistFeedbackLeases(channel.connectionId)
    return lease.id
  }

  async cleanupEpisodeFeedback(
    episodeId: EpisodeId,
    reason?: 'idle' | 'error' | 'cancelled' | 'timeout' | 'shutdown' | 'recovery',
  ): Promise<void> {
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
      if (outcome.status === 'unsupported') this.#feedbackDisabledConnections.add(lease.connectionId)
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
      this.#feedbackDisabledConnections.add(lease.connectionId)
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
