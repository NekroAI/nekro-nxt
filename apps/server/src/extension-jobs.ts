import type { ChannelRuntime } from '@nekro-nxt/channel-runtime'
import {
  AgentIdSchema,
  ChannelIdSchema,
  ExtensionIdSchema,
  type AgentId,
  type ChannelId,
  type ExtensionDeclaredJob,
  type ExtensionId,
  type JsonValue,
} from '@nekro-nxt/contracts'
import type { NxtJobRecord } from '@nekro-nxt/extension-sdk'
import type { ExtensionJobRecord } from '@nekro-nxt/storage-sqlite'
import { nextJobRun, type NxtJobSchedule, type NxtServiceBackends } from './extension-host-service.js'

/** One-off jobs overdue by more than this are dropped with a diagnostic instead of firing late. */
export const ONCE_JOB_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_TICK_MS = 15_000

export interface ScheduledJobRow {
  readonly id: string
  readonly agentId: AgentId
  readonly extensionId: ExtensionId | null
  readonly channelId: ChannelId
  readonly label: string
  readonly schedule: NxtJobSchedule
  readonly payload: JsonValue
  readonly nextRunAt: number
}

export interface ExtensionJobSchedulerOptions {
  readonly due: (now: number, limit: number) => readonly ScheduledJobRow[]
  /** Optimistic: false when another tick already advanced this job. */
  readonly advance: (input: {
    readonly id: string
    readonly expectedNextRunAt: number
    readonly firedAt: number
    readonly nextRunAt: number | undefined
  }) => boolean
  /** Whether the job's extension is still enabled for its agent; chat-created tasks are always active. */
  readonly active: (row: ScheduledJobRow) => boolean
  readonly extensionName: (extensionId: ExtensionId) => string | undefined
  readonly fire: ChannelRuntime['fireExtensionJob']
  readonly now: () => number
  readonly diagnostic?: (row: ScheduledJobRow, message: string) => void
  /** After each sweep, with how many jobs it advanced. */
  readonly afterSweep?: (advanced: number) => void
  readonly tickMs?: number
}

/**
 * Fires due extension jobs. Each due occurrence is fired first (the Channel Event dedupe key makes a retry a no-op)
 * and then advanced; missed cron occurrences collapse into one late firing because the next run is computed from now.
 */
export class ExtensionJobScheduler {
  readonly #options: ExtensionJobSchedulerOptions
  #timer: NodeJS.Timeout | undefined
  #running: Promise<void> | undefined
  #disposed = false

  constructor(options: ExtensionJobSchedulerOptions) {
    this.#options = options
  }

  start(): void {
    if (this.#timer !== undefined || this.#disposed) return
    this.#timer = setInterval(() => void this.tick(), this.#options.tickMs ?? DEFAULT_TICK_MS)
    this.#timer.unref()
    void this.tick()
  }

  /** Runs one sweep; overlapping calls share the sweep in flight. */
  tick(): Promise<void> {
    if (this.#disposed) return Promise.resolve()
    this.#running ??= this.#sweep().finally(() => {
      this.#running = undefined
    })
    return this.#running
  }

  async dispose(): Promise<void> {
    this.#disposed = true
    if (this.#timer !== undefined) clearInterval(this.#timer)
    this.#timer = undefined
    await this.#running
  }

  async #sweep(): Promise<void> {
    const now = this.#options.now()
    let advanced = 0
    for (const row of this.#options.due(now, 50)) {
      if (this.#disposed) return
      const next = row.schedule.kind === 'cron' ? nextJobRun(row.schedule, now) : undefined
      try {
        if (row.schedule.kind === 'once' && now - row.nextRunAt > ONCE_JOB_EXPIRY_MS) {
          this.#options.diagnostic?.(row, '一次性任务过期超过 7 天，未补触发。')
        } else if (this.#options.active(row)) {
          const extensionName = row.extensionId === null ? undefined : this.#options.extensionName(row.extensionId)
          await this.#options.fire({
            channelId: row.channelId,
            agentId: row.agentId,
            jobId: row.id,
            label: row.label,
            ...(extensionName === undefined ? {} : { extensionName }),
            payload: row.payload,
            scheduledAt: row.nextRunAt,
            firedAt: now,
          })
        }
      } catch (error) {
        this.#options.diagnostic?.(row, error instanceof Error ? error.message : String(error))
      }
      if (this.#options.advance({ id: row.id, expectedNextRunAt: row.nextRunAt, firedAt: now, nextRunAt: next }))
        advanced += 1
    }
    this.#options.afterSweep?.(advanced)
  }
}

interface JobRepository {
  createExtensionJob(record: ExtensionJobRecord): void
  getExtensionJob(id: string): ExtensionJobRecord | undefined
  listExtensionJobs(options: {
    readonly agentId: AgentId
    readonly extensionId?: ExtensionId | null
    readonly channelId?: ChannelId
  }): ExtensionJobRecord[]
  deleteExtensionJob(id: string): boolean
  deleteDeclaredJobsExcept(options: { agentId: AgentId; extensionId: ExtensionId | null; keep: string[] }): number
  countExtensionJobs(options: { agentId: AgentId; extensionId: ExtensionId | null }): number
}

const scheduleOf = (row: ExtensionJobRecord): NxtJobSchedule | undefined =>
  row.scheduleKind === 'once'
    ? row.runAt === null
      ? undefined
      : { kind: 'once', at: row.runAt }
    : row.cron === null
      ? undefined
      : { kind: 'cron', cron: row.cron, timezone: row.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone }

/** Durable rows as scheduler work; malformed or finished rows are skipped. */
export const scheduledJob = (row: ExtensionJobRecord): ScheduledJobRow | undefined => {
  const schedule = scheduleOf(row)
  if (schedule === undefined || row.nextRunAt === null) return undefined
  return {
    id: row.id,
    agentId: row.agentId,
    extensionId: row.extensionId,
    channelId: row.channelId,
    label: row.label,
    schedule,
    payload: row.payloadJson,
    nextRunAt: row.nextRunAt,
  }
}

const jobRecord = (row: ExtensionJobRecord): NxtJobRecord => ({
  jobId: row.id,
  label: row.label,
  ...(row.nextRunAt === null ? {} : { nextRunAt: row.nextRunAt }),
  ...(row.cron === null ? {} : { cron: row.cron }),
  ...(row.runAt === null ? {} : { at: row.runAt }),
})

/** `nxt.jobs` over the Core table: runtime jobs per (agent, extension), quota counted across channels. */
export const sqliteNxtJobs = (
  repository: JobRepository,
  options: { readonly now: () => number; readonly nextId: () => string },
): NxtServiceBackends['jobs'] => ({
  schedule: (binding, job, maxActive) => {
    const agentId = AgentIdSchema.parse(binding.agentId)
    const extensionId = ExtensionIdSchema.parse(binding.ownerKey)
    const active = repository
      .listExtensionJobs({ agentId, extensionId })
      .filter((row) => row.source === 'runtime' && row.nextRunAt !== null).length
    if (active >= maxActive) {
      return Promise.reject(new Error(`这个扩展同时最多保留 ${maxActive} 个定时任务，请先取消不需要的任务。`))
    }
    const row: ExtensionJobRecord = {
      id: `job_${options.nextId()}`,
      agentId,
      extensionId,
      channelId: ChannelIdSchema.parse(binding.channelId),
      source: 'runtime',
      declaredKey: null,
      label: job.label,
      scheduleKind: job.schedule.kind,
      runAt: job.schedule.kind === 'once' ? job.schedule.at : null,
      cron: job.schedule.kind === 'cron' ? job.schedule.cron : null,
      timezone: job.schedule.kind === 'cron' ? job.schedule.timezone : null,
      payloadJson: job.payload,
      nextRunAt: job.nextRunAt,
      lastFiredAt: null,
      paused: false,
      createdAt: options.now(),
    }
    repository.createExtensionJob(row)
    return Promise.resolve(jobRecord(row))
  },
  list: (binding) =>
    Promise.resolve(
      repository
        .listExtensionJobs({
          agentId: AgentIdSchema.parse(binding.agentId),
          extensionId: ExtensionIdSchema.parse(binding.ownerKey),
          channelId: ChannelIdSchema.parse(binding.channelId),
        })
        .filter((row) => row.nextRunAt !== null)
        .map(jobRecord),
    ),
  cancel: (binding, jobId) => {
    const row = repository.getExtensionJob(jobId)
    if (
      row === undefined ||
      row.source !== 'runtime' ||
      row.agentId !== binding.agentId ||
      row.extensionId !== binding.ownerKey
    ) {
      return Promise.resolve(false)
    }
    return Promise.resolve(repository.deleteExtensionJob(jobId))
  },
})

/**
 * Upserts a Revision's declared jobs for one bound channel and removes declared jobs it no longer has. Called when the
 * extension mounts into a Session of that channel, so every bound channel gets its own occurrence.
 */
export const syncDeclaredJobs = (
  repository: JobRepository,
  input: {
    readonly agentId: AgentId
    readonly extensionId: ExtensionId
    readonly channelId: ChannelId
    readonly declared: readonly ExtensionDeclaredJob[]
    readonly now: number
    readonly nextId: () => string
  },
): void => {
  repository.deleteDeclaredJobsExcept({
    agentId: input.agentId,
    extensionId: input.extensionId,
    keep: input.declared.map(({ id }) => id),
  })
  for (const job of input.declared) {
    const schedule: NxtJobSchedule = {
      kind: 'cron',
      cron: job.cron,
      timezone: job.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    }
    const existing = repository
      .listExtensionJobs({ agentId: input.agentId, extensionId: input.extensionId, channelId: input.channelId })
      .find((row) => row.source === 'declared' && row.declaredKey === job.id)
    repository.createExtensionJob({
      id: existing?.id ?? `job_${input.nextId()}`,
      agentId: input.agentId,
      extensionId: input.extensionId,
      channelId: input.channelId,
      source: 'declared',
      declaredKey: job.id,
      label: job.label,
      scheduleKind: 'cron',
      runAt: null,
      cron: job.cron,
      timezone: schedule.timezone,
      payloadJson: {},
      // Keep a pending occurrence; only a changed schedule moves it.
      nextRunAt:
        existing?.nextRunAt !== undefined && existing.nextRunAt !== null && existing.cron === job.cron
          ? existing.nextRunAt
          : (nextJobRun(schedule, input.now) ?? null),
      lastFiredAt: existing?.lastFiredAt ?? null,
      paused: false,
      createdAt: existing?.createdAt ?? input.now,
    })
  }
}
