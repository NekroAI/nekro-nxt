import type { ExtensionJobFiring } from '@nekro-nxt/channel-runtime'
import type { AgentId, ChannelId, ExtensionId, JsonValue, ScheduledTask } from '@nekro-nxt/contracts'
import type { ExtensionJobRecord } from '@nekro-nxt/storage-sqlite'
import { nextJobRun, type NxtJobSchedule } from './extension-host-service.js'
import { ONCE_JOB_EXPIRY_MS, scheduledJob } from './extension-jobs.js'

/** Chat-created tasks a channel may keep at once; finished one-off tasks do not count. */
export const CHAT_TASK_LIMIT_PER_CHANNEL = 20
/** Fired one-off tasks stay visible this long, then the scheduler sweep removes them. */
export const FINISHED_TASK_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

export interface ScheduledTaskRepository {
  createExtensionJob(record: ExtensionJobRecord): void
  getExtensionJob(id: string): ExtensionJobRecord | undefined
  listExtensionJobs(options: {
    readonly agentId: AgentId
    readonly extensionId?: ExtensionId | null
    readonly channelId?: ChannelId
  }): ExtensionJobRecord[]
  listAllExtensionJobs(): ExtensionJobRecord[]
  updateExtensionJob(
    id: string,
    patch: Partial<
      Pick<
        ExtensionJobRecord,
        | 'label'
        | 'scheduleKind'
        | 'runAt'
        | 'cron'
        | 'timezone'
        | 'payloadJson'
        | 'nextRunAt'
        | 'lastFiredAt'
        | 'paused'
      >
    >,
  ): boolean
  deleteExtensionJob(id: string): boolean
  deleteFinishedExtensionJobs(firedBefore: number): number
}

/** `quiet`: the extension's due-job handler decided not to wake the agent this time. */
export type JobFireOutcome = 'fired' | 'quiet' | 'not-delivered'

export interface ScheduledTasksOptions {
  readonly repository: ScheduledTaskRepository
  /** Whether the owning extension is enabled for the agent; chat tasks have no extension and are always active. */
  readonly extensionActive: (agentId: AgentId, extensionId: ExtensionId) => boolean
  readonly extensionName: (extensionId: ExtensionId) => string | undefined
  /** False for deleted agents; their leftover tasks are hidden and removed by the sweep. */
  readonly agentLive: (agentId: AgentId) => boolean
  readonly fire: (job: ExtensionJobFiring) => Promise<JobFireOutcome>
  readonly now: () => number
  readonly nextId: () => string
}

/** Who acts: the agent from a channel may only touch that channel's tasks; an administrator acts on any task. */
export type ScheduledTaskActor =
  { readonly kind: 'agent'; readonly agentId: AgentId; readonly channelId: ChannelId } | { readonly kind: 'admin' }

type Operation = 'update' | 'pause' | 'resume' | 'delete' | 'run'

/** Which operations each source allows to each actor; see the scheduled-tasks Decision §2. */
const ALLOWED: Record<ScheduledTask['source'], Record<ScheduledTaskActor['kind'], readonly Operation[]>> = {
  chat: { agent: ['update', 'pause', 'resume', 'delete', 'run'], admin: ['pause', 'resume', 'delete', 'run'] },
  declared: { agent: ['pause', 'resume'], admin: ['pause', 'resume', 'run'] },
  runtime: { agent: ['pause', 'resume', 'delete'], admin: ['pause', 'resume', 'delete', 'run'] },
}

const OPERATION_LABEL: Record<Operation, string> = {
  update: '修改',
  pause: '暂停',
  resume: '恢复',
  delete: '删除',
  run: '立即执行',
}

export class ScheduledTaskError extends Error {
  override readonly name = 'ScheduledTaskError'
  constructor(
    message: string,
    readonly code: 'not-found' | 'forbidden' | 'invalid' | 'limit',
  ) {
    super(message)
  }
}

const sourceOf = (row: ExtensionJobRecord): ScheduledTask['source'] => (row.source === 'reminder' ? 'chat' : row.source)

const noteOf = (payload: JsonValue): string | undefined =>
  payload !== null && typeof payload === 'object' && !Array.isArray(payload) && typeof payload['note'] === 'string'
    ? payload['note']
    : undefined

const scheduleColumns = (schedule: NxtJobSchedule) => ({
  scheduleKind: schedule.kind,
  runAt: schedule.kind === 'once' ? schedule.at : null,
  cron: schedule.kind === 'cron' ? schedule.cron : null,
  timezone: schedule.kind === 'cron' ? schedule.timezone : null,
})

/**
 * Scheduled tasks as one product feature over the job table: chat tools, the Host API and the snapshot all go through
 * here so source rules, the per-channel cap and change notifications live in one place.
 */
export class ScheduledTasks {
  readonly #options: ScheduledTasksOptions
  readonly #listeners = new Set<() => void>()

  constructor(options: ScheduledTasksOptions) {
    this.#options = options
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** Called after the scheduler advanced or removed tasks, so clients refresh next and last run. */
  changed(): void {
    for (const listener of this.#listeners) listener()
  }

  project(row: ExtensionJobRecord): ScheduledTask {
    const job = scheduledJob(row)
    const schedule: ScheduledTask['schedule'] =
      row.scheduleKind === 'once'
        ? { kind: 'once', at: row.runAt ?? 0 }
        : { kind: 'cron', cron: row.cron ?? '', timezone: row.timezone ?? '' }
    const inactive = row.extensionId !== null && !this.#options.extensionActive(row.agentId, row.extensionId)
    const extensionName = row.extensionId === null ? undefined : this.#options.extensionName(row.extensionId)
    const note = noteOf(row.payloadJson)
    return {
      id: row.id,
      agentId: row.agentId,
      channelId: row.channelId,
      source: sourceOf(row),
      ...(row.extensionId === null ? {} : { extensionId: row.extensionId }),
      ...(extensionName === undefined ? {} : { extensionName }),
      label: row.label,
      ...(note === undefined ? {} : { note }),
      schedule,
      state: job === undefined ? 'finished' : row.paused ? 'paused' : inactive ? 'inactive' : 'scheduled',
      ...(row.nextRunAt === null ? {} : { nextRunAt: row.nextRunAt }),
      ...(row.lastFiredAt === null ? {} : { lastFiredAt: row.lastFiredAt }),
      createdAt: row.createdAt,
    }
  }

  list(filter: { readonly agentId?: AgentId; readonly channelId?: ChannelId } = {}): ScheduledTask[] {
    const rows =
      filter.agentId === undefined
        ? this.#options.repository.listAllExtensionJobs()
        : this.#options.repository.listExtensionJobs({
            agentId: filter.agentId,
            ...(filter.channelId === undefined ? {} : { channelId: filter.channelId }),
          })
    return rows
      .filter((row) => filter.channelId === undefined || row.channelId === filter.channelId)
      .filter((row) => this.#options.agentLive(row.agentId))
      .map((row) => this.project(row))
  }

  create(input: {
    readonly agentId: AgentId
    readonly channelId: ChannelId
    readonly label: string
    readonly note?: string
    readonly schedule: NxtJobSchedule
  }): ScheduledTask {
    const label = this.#label(input.label)
    const kept = this.#options.repository
      .listExtensionJobs({ agentId: input.agentId, extensionId: null, channelId: input.channelId })
      .filter((row) => row.source === 'reminder' && row.nextRunAt !== null).length
    if (kept >= CHAT_TASK_LIMIT_PER_CHANNEL) {
      throw new ScheduledTaskError(
        `当前频道最多保留 ${CHAT_TASK_LIMIT_PER_CHANNEL} 个定时任务，请先删除不需要的任务。`,
        'limit',
      )
    }
    const now = this.#options.now()
    const nextRunAt = nextJobRun(input.schedule, now)
    if (nextRunAt === undefined) throw new ScheduledTaskError('这个时间之后不会再触发。', 'invalid')
    const row: ExtensionJobRecord = {
      id: `job_${this.#options.nextId()}`,
      agentId: input.agentId,
      extensionId: null,
      channelId: input.channelId,
      source: 'reminder',
      declaredKey: null,
      label,
      ...scheduleColumns(input.schedule),
      payloadJson: input.note === undefined || input.note.trim() === '' ? {} : { note: input.note.trim() },
      nextRunAt,
      lastFiredAt: null,
      paused: false,
      createdAt: now,
    }
    this.#options.repository.createExtensionJob(row)
    this.changed()
    return this.project(row)
  }

  /** Changes a chat task's content or schedule; a new schedule restarts it from now. */
  update(
    actor: ScheduledTaskActor,
    id: string,
    patch: { readonly label?: string; readonly note?: string; readonly schedule?: NxtJobSchedule },
  ): ScheduledTask {
    const row = this.#authorize(actor, id, 'update')
    const now = this.#options.now()
    const nextRunAt = patch.schedule === undefined ? undefined : nextJobRun(patch.schedule, now)
    if (patch.schedule !== undefined && nextRunAt === undefined) {
      throw new ScheduledTaskError('这个时间之后不会再触发。', 'invalid')
    }
    this.#options.repository.updateExtensionJob(row.id, {
      ...(patch.label === undefined ? {} : { label: this.#label(patch.label) }),
      ...(patch.note === undefined ? {} : { payloadJson: patch.note.trim() === '' ? {} : { note: patch.note.trim() } }),
      ...(patch.schedule === undefined ? {} : { ...scheduleColumns(patch.schedule), nextRunAt: nextRunAt ?? null }),
    })
    return this.#reload(row.id)
  }

  pause(actor: ScheduledTaskActor, id: string): ScheduledTask {
    const row = this.#authorize(actor, id, 'pause')
    this.#options.repository.updateExtensionJob(row.id, { paused: true })
    return this.#reload(row.id)
  }

  /** A periodic task resumes from its next occurrence after now; a one-off task whose time passed fires once. */
  resume(actor: ScheduledTaskActor, id: string): ScheduledTask {
    const row = this.#authorize(actor, id, 'resume')
    const job = scheduledJob(row)
    const now = this.#options.now()
    const nextRunAt =
      job?.schedule.kind === 'cron' && row.nextRunAt !== null && row.nextRunAt < now
        ? (nextJobRun(job.schedule, now) ?? null)
        : row.nextRunAt
    this.#options.repository.updateExtensionJob(row.id, { paused: false, nextRunAt })
    return this.#reload(row.id)
  }

  delete(actor: ScheduledTaskActor, id: string): void {
    const row = this.#authorize(actor, id, 'delete')
    this.#options.repository.deleteExtensionJob(row.id)
    this.changed()
  }

  /** Fires one occurrence now without moving the plan; `woke` is false when the extension let it pass quietly. */
  async run(actor: ScheduledTaskActor, id: string): Promise<{ readonly task: ScheduledTask; readonly woke: boolean }> {
    const row = this.#authorize(actor, id, 'run')
    if (row.extensionId !== null && !this.#options.extensionActive(row.agentId, row.extensionId)) {
      throw new ScheduledTaskError('这个任务所属的扩展已停用，启用后才能执行。', 'invalid')
    }
    const now = this.#options.now()
    const extensionName = row.extensionId === null ? undefined : this.#options.extensionName(row.extensionId)
    const outcome = await this.#options.fire({
      channelId: row.channelId,
      agentId: row.agentId,
      jobId: row.id,
      label: row.label,
      ...(extensionName === undefined ? {} : { extensionName }),
      payload: row.payloadJson,
      scheduledAt: now,
      firedAt: now,
    })
    if (outcome === 'not-delivered') {
      throw new ScheduledTaskError('频道已解绑或不再由这个智能体响应，无法执行。', 'invalid')
    }
    this.#options.repository.updateExtensionJob(row.id, { lastFiredAt: now })
    return { task: this.#reload(row.id), woke: outcome === 'fired' }
  }

  /** Removes tasks of deleted agents and one-off tasks that fired long ago; one-off tasks overdue past expiry are already dropped by the sweep. */
  prune(): void {
    let removed = this.#options.repository.deleteFinishedExtensionJobs(
      this.#options.now() - Math.max(FINISHED_TASK_RETENTION_MS, ONCE_JOB_EXPIRY_MS),
    )
    for (const row of this.#options.repository.listAllExtensionJobs()) {
      if (!this.#options.agentLive(row.agentId) && this.#options.repository.deleteExtensionJob(row.id)) removed += 1
    }
    if (removed > 0) this.changed()
  }

  #label(value: string): string {
    const label = value.trim()
    if (label === '' || label.length > 200) throw new ScheduledTaskError('任务内容需要 1–200 个字符。', 'invalid')
    return label
  }

  #authorize(actor: ScheduledTaskActor, id: string, operation: Operation): ExtensionJobRecord {
    const row = this.#options.repository.getExtensionJob(id)
    if (
      row === undefined ||
      (actor.kind === 'agent' && (row.agentId !== actor.agentId || row.channelId !== actor.channelId))
    ) {
      throw new ScheduledTaskError('没有找到这个定时任务。', 'not-found')
    }
    const source = sourceOf(row)
    if (!ALLOWED[source][actor.kind].includes(operation)) {
      throw new ScheduledTaskError(
        `${source === 'chat' ? '对话创建的' : '扩展的'}定时任务不能在这里${OPERATION_LABEL[operation]}。`,
        'forbidden',
      )
    }
    return row
  }

  #reload(id: string): ScheduledTask {
    const row = this.#options.repository.getExtensionJob(id)
    if (row === undefined) throw new ScheduledTaskError('没有找到这个定时任务。', 'not-found')
    this.changed()
    return this.project(row)
  }
}

export const hostTimezone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone

const zoneParts = (epoch: number, timezone: string) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(epoch))
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? 0)
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute'),
    second: value('second'),
  }
}

const zoneOffset = (epoch: number, timezone: string): number => {
  const p = zoneParts(epoch, timezone)
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(epoch / 1000) * 1000
}

/** Wall-clock time in a zone to epoch milliseconds; a time skipped by a DST change moves forward. */
const zonedEpoch = (fields: readonly number[], timezone: string): number => {
  const [year = 0, month = 1, day = 1, hour = 0, minute = 0, second = 0] = fields
  const wall = Date.UTC(year, month - 1, day, hour, minute, second)
  const first = wall - zoneOffset(wall, timezone)
  return wall - zoneOffset(first, timezone)
}

/** `2026-10-08 08:00` in the given zone, for tool results and diagnostics. */
export const formatTaskTime = (epoch: number, timezone: string): string => {
  const p = zoneParts(epoch, timezone)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`
}

const LOCAL_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/u

/**
 * Schedule from what a model reliably writes: an ISO time with offset, a wall-clock time in `timezone`, minutes from
 * now, or a five-field cron. Exactly one of `at`, `delayMinutes` and `cron` must be present.
 */
export const parseTaskSchedule = (
  input: {
    readonly at?: string | undefined
    readonly delayMinutes?: number | undefined
    readonly cron?: string | undefined
    readonly timezone?: string | undefined
  },
  now: number,
): NxtJobSchedule => {
  const given = [input.at, input.delayMinutes, input.cron].filter((value) => value !== undefined).length
  if (given !== 1) throw new ScheduledTaskError('at、delayMinutes 与 cron 需要且只能提供其中一个。', 'invalid')
  const timezone = input.timezone ?? hostTimezone()
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone })
  } catch {
    throw new ScheduledTaskError(`时区无效：${timezone}`, 'invalid')
  }
  if (input.cron !== undefined) {
    const cron = input.cron.trim()
    if (cron.split(/\s+/u).length !== 5)
      throw new ScheduledTaskError('cron 只支持五段表达式，例如 0 8 * * *。', 'invalid')
    const schedule: NxtJobSchedule = { kind: 'cron', cron, timezone }
    try {
      nextJobRun(schedule, now)
    } catch (error) {
      throw new ScheduledTaskError(`cron 无效：${error instanceof Error ? error.message : String(error)}`, 'invalid')
    }
    return schedule
  }
  let at: number
  if (input.delayMinutes !== undefined) {
    if (!Number.isFinite(input.delayMinutes) || input.delayMinutes <= 0) {
      throw new ScheduledTaskError('delayMinutes 必须是正数。', 'invalid')
    }
    at = now + Math.round(input.delayMinutes * 60_000)
  } else {
    const text = (input.at ?? '').trim()
    const local = LOCAL_TIME.exec(text)
    at =
      local === null
        ? Date.parse(text)
        : zonedEpoch(
            local.slice(1).map((part) => Number(part ?? 0)),
            timezone,
          )
    if (!Number.isFinite(at)) {
      throw new ScheduledTaskError('at 需要形如 2026-10-08 08:00 或带时区偏移的 ISO 时间。', 'invalid')
    }
  }
  if (at <= now) throw new ScheduledTaskError('时间已经过去，请给出将来的时间。', 'invalid')
  return { kind: 'once', at }
}
