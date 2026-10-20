import { Worker } from 'node:worker_threads'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  hostLogEntrySchema,
  hostLogPageSchema,
  hostLogQuerySchema,
  hostLogSourceSchema,
  hostLogSettingsSchema,
  hostLogDebugRequestSchema,
  type HostLogInput,
  type HostLogSource,
  type HostLogScope,
  type HostLogQuery,
  type HostLogSettings,
  type HostLogStatus,
  type HostLogDebugLease,
} from '@nekro-nxt/contracts'
import { z } from 'zod'
import { normalizeLog } from './redact.js'
import { SecretRegistry } from '../secret-registry.js'

const MAX_QUEUE = 8 * 1024 * 1024
const statsSchema = z.object({
  bytes: z.number(),
  count: z.number(),
  oldestTimestamp: z.string().nullable(),
  newestTimestamp: z.string().nullable(),
  headCursor: z.string(),
})
type Stats = z.infer<typeof statsSchema>
type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
type Entry = ReturnType<typeof normalizeLog> & { receipt: string }
export interface HostLogWriter {
  debug(message: string, details?: unknown): void
  info(message: string, details?: unknown): void
  warn(message: string, details?: unknown): void
  error(message: string, details?: unknown): void
}
export interface HostLogSink {
  registerSecret?(value: string): void
  write(input: HostLogInput): void
  logger(source: HostLogSource, scope?: HostLogScope): HostLogWriter
}

/** One host owns this worker; runtime children borrow the write port and cannot close it. */
export class HostLogService implements HostLogSink {
  readonly runId = randomUUID()
  readonly #root: string
  readonly #now: () => number
  #worker: Worker | undefined
  #serial = 0
  #pending = new Map<number, Pending>()
  #listeners = new Set<() => void>()
  #settings: HostLogSettings = { retentionDays: 7, maxSizeMiB: 256, revision: 0 }
  #stats: Stats = { bytes: 0, count: 0, oldestTimestamp: null, newestTimestamp: null, headCursor: '' }
  #state: HostLogStatus['state'] = 'degraded'
  #error: string | undefined
  #configError = false
  #queue: Array<{ entry: Entry; bytes: number }> = []
  #bytes = 0
  #dropped = 0
  #reportedDrops = 0
  #debug = new Map<string, HostLogDebugLease>()
  #flushing: Promise<void> | undefined
  #opening: Promise<void> | undefined
  #timer: ReturnType<typeof setInterval> | undefined
  #lastCleanup = 0
  #lastRetry = 0
  #exportId: number | undefined
  #closing = false
  #settingsTail = Promise.resolve()
  /** Shared with everything that reaches the model, so one registration hides a value everywhere. */
  readonly secrets = new SecretRegistry()
  registerSecret(value: string): void {
    this.secrets.register(value)
  }
  private constructor(dataRoot: string, now: () => number) {
    this.#root = dataRoot
    this.#now = now
  }
  static async open({ dataRoot, now = Date.now }: { dataRoot: string; now?: () => number }): Promise<HostLogService> {
    const service = new HostLogService(dataRoot, now)
    try {
      service.#settings = hostLogSettingsSchema.parse(
        JSON.parse(await readFile(path.join(dataRoot, 'host', 'logging.json'), 'utf8')),
      )
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        service.#configError = true
        service.#error = '日志设置无法读取，已暂停保存，请重新保存日志设置。'
      }
    }
    if (!service.#configError) await service.#openWorker()
    service.#timer = setInterval(() => void service.#tick(), 100)
    service.#timer.unref()
    return service
  }
  async #openWorker(): Promise<void> {
    if (this.#opening) return this.#opening
    this.#opening = (async () => {
      try {
        const source = new URL(import.meta.url).pathname.endsWith('.ts')
        const worker = new Worker(
          new URL(source ? './worker-bootstrap.mjs' : './logs/storage-worker.mjs', import.meta.url),
          { execArgv: [], workerData: { dataRoot: this.#root, settings: this.#settings } },
        )
        this.#worker = worker
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('日志存储启动超时。')), 10_000)
          worker.once('error', (error) => {
            clearTimeout(timer)
            reject(error)
          })
          worker.on('message', (raw: unknown) => {
            const message = z
              .object({
                ready: z.boolean().optional(),
                id: z.number().optional(),
                result: z.unknown().optional(),
                error: z.string().optional(),
              })
              .parse(raw)
            if (message.ready) {
              clearTimeout(timer)
              resolve()
              return
            }
            const pending = message.id === undefined ? undefined : this.#pending.get(message.id)
            if (!pending) return
            clearTimeout(pending.timer)
            this.#pending.delete(message.id!)
            if (message.error) pending.reject(new Error(message.error))
            else pending.resolve(message.result)
          })
        })
        worker.on('error', () => this.#fail('日志保存暂时不可用。'))
        worker.on('exit', (code) => {
          if (!this.#closing && this.#worker === worker) this.#fail(`日志工作线程已退出（${code}）。`)
        })
        this.#state = 'ready'
        this.#error = undefined
        this.#stats = statsSchema.parse(await this.#request('stats'))
        this.#notify()
      } catch {
        this.#fail('日志保存暂时不可用，请检查数据目录和磁盘空间。')
        await this.#worker?.terminate()
        this.#worker = undefined
      }
    })().finally(() => {
      this.#opening = undefined
    })
    return this.#opening
  }
  #fail(message: string): void {
    this.#state = 'degraded'
    this.#error = message
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error(message))
    }
    this.#pending.clear()
    this.#notify()
  }
  #request(method: string, args?: unknown, signal?: AbortSignal): Promise<unknown> {
    if (!this.#worker || (this.#state !== 'ready' && method !== 'close'))
      return Promise.reject(new Error('日志保存暂时不可用。'))
    if (signal?.aborted) return Promise.reject(new Error('操作已取消。'))
    const id = ++this.#serial
    if (method === 'export') this.#exportId = id
    const abort = () => this.#worker?.postMessage({ id, method: 'cancel' })
    signal?.addEventListener('abort', abort, { once: true })
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          abort()
          this.#pending.delete(id)
          reject(new Error('日志操作超时。'))
        },
        method === 'export' ? 60_000 : 15_000,
      )
      this.#pending.set(id, { resolve, reject, timer })
      this.#worker!.postMessage({ id, method, args })
    }).finally(() => {
      signal?.removeEventListener('abort', abort)
      if (this.#exportId === id) this.#exportId = undefined
    })
  }
  write(input: HostLogInput): void {
    if (this.#closing) return
    try {
      if (
        input.level === 'debug' &&
        !this.#leases().some(
          (lease) =>
            lease.source === undefined ||
            (lease.source.kind === input.source.kind && lease.source.id === input.source.id),
        )
      )
        return
      const entry = { ...normalizeLog(input, this.runId, this.#now(), this.secrets.logValues()), receipt: randomUUID() }
      const bytes = Buffer.byteLength(JSON.stringify(entry))
      if (this.#bytes + bytes > MAX_QUEUE) {
        const expendable =
          input.level === 'error' || input.level === 'warn'
            ? this.#queue.findIndex(({ entry }) => entry.level === 'debug' || entry.level === 'info')
            : -1
        if (expendable < 0) {
          this.#dropped++
          return
        }
        const [removed] = this.#queue.splice(expendable, 1)
        this.#bytes -= removed!.bytes
        this.#dropped++
        if (this.#bytes + bytes > MAX_QUEUE) {
          this.#dropped++
          return
        }
      }
      this.#queue.push({ entry, bytes })
      this.#bytes += bytes
      if (this.#bytes > MAX_QUEUE * 0.75 && this.#exportId !== undefined)
        this.#worker?.postMessage({ id: this.#exportId, method: 'cancel' })
    } catch {
      this.#dropped++
    }
  }
  logger(source: HostLogSource, scope?: HostLogScope): HostLogWriter {
    const log = (level: HostLogInput['level']) => (message: string, details?: unknown) =>
      this.write({
        level,
        message,
        source,
        ...(scope === undefined ? {} : { scope }),
        ...(details === undefined ? {} : { details }),
      })
    return { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') }
  }
  async #tick(): Promise<void> {
    if (this.#closing || this.#opening || this.#configError) return
    this.#leases()
    if (this.#state !== 'ready') {
      if (this.#now() - this.#lastRetry > 5000) {
        this.#lastRetry = this.#now()
        await this.#worker?.terminate()
        this.#worker = undefined
        await this.#openWorker()
      }
      return
    }
    await this.flush()
  }
  async flush(): Promise<void> {
    if (this.#flushing) return this.#flushing
    if (this.#state !== 'ready') return
    this.#flushing = (async () => {
      try {
        if (this.#dropped > this.#reportedDrops && !this.#closing) {
          const count = this.#dropped - this.#reportedDrops
          this.write({
            level: 'warn',
            message: `日志过量或保存失败，${count} 条记录未能保留。`,
            code: 'logs.dropped',
            source: { kind: 'system', id: 'logging', name: '日志服务' },
            details: { count },
          })
          this.#reportedDrops = this.#dropped
        }
        while (this.#queue.length) {
          const batch = this.#queue.splice(0, 100)
          try {
            await this.#request(
              'append',
              batch.map(({ entry }) => entry),
            )
          } catch (error) {
            this.#queue.unshift(...batch)
            throw error
          }
          this.#bytes -= batch.reduce((sum, item) => sum + item.bytes, 0)
          this.#notify()
        }
        if (this.#now() - this.#lastCleanup > 30_000) {
          this.#lastCleanup = this.#now()
          this.#stats = statsSchema.parse(await this.#request('cleanup', this.#now()))
        }
      } catch {
        this.#fail('日志保存暂时不可用，请检查磁盘空间。')
      }
    })().finally(() => {
      this.#flushing = undefined
    })
    return this.#flushing
  }
  async query(query: HostLogQuery = {}) {
    return hostLogPageSchema.parse(await this.#request('query', hostLogQuerySchema.parse(query)))
  }
  async get(id: string) {
    return hostLogEntrySchema.optional().parse(await this.#request('get', id))
  }
  async sources() {
    return z.array(hostLogSourceSchema).parse(await this.#request('sources'))
  }
  settings(): HostLogSettings {
    return { ...this.#settings }
  }
  updateSettings(input: HostLogSettings): Promise<HostLogSettings> {
    const operation = this.#settingsTail.then(async () => {
      const parsed = hostLogSettingsSchema.parse(input)
      if (parsed.revision !== this.#settings.revision) throw new Error('日志设置已被修改，请刷新后再试。')
      const updated = { ...parsed, revision: parsed.revision + 1 }
      const directory = path.join(this.#root, 'host')
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const filename = path.join(directory, 'logging.json')
      const temporary = `${filename}.${randomUUID()}.tmp`
      await writeFile(temporary, JSON.stringify(updated), { mode: 0o600 })
      await rename(temporary, filename)
      this.#settings = updated
      if (this.#configError) {
        this.#configError = false
        await this.#openWorker()
      }
      if (this.#state === 'ready') await this.#request('settings', updated)
      this.#notify()
      return this.settings()
    })
    this.#settingsTail = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }
  #leases(): HostLogDebugLease[] {
    let changed = false
    for (const [id, lease] of this.#debug)
      if (Date.parse(lease.expiresAt) <= this.#now()) {
        this.#debug.delete(id)
        changed = true
      }
    if (changed) this.#notify()
    return [...this.#debug.values()]
  }
  startDebug(input: unknown): HostLogDebugLease {
    const request = hostLogDebugRequestSchema.parse(input)
    const current = this.#leases().find(
      (lease) => lease.source?.kind === request.source?.kind && lease.source?.id === request.source?.id,
    )
    if (current) this.#debug.delete(current.id)
    if (this.#debug.size >= 100) throw new Error('临时调试任务太多，请先关闭不再需要的任务。')
    const lease = {
      ...request,
      id: randomUUID(),
      expiresAt: new Date(this.#now() + request.durationMinutes * 60_000).toISOString(),
    }
    this.#debug.set(lease.id, lease)
    this.#notify()
    return lease
  }
  stopDebug(id: string): void {
    this.#debug.delete(id)
    this.#notify()
  }
  async status(): Promise<HostLogStatus> {
    if (this.#state === 'ready') {
      try {
        this.#stats = statsSchema.parse(await this.#request('stats'))
      } catch {
        this.#fail('日志状态暂时不可用。')
      }
    }
    return this.currentStatus()
  }
  currentStatus(): HostLogStatus {
    return {
      ...this.#stats,
      state: this.#state,
      runId: this.runId,
      queuedBytes: this.#bytes,
      droppedCount: this.#dropped,
      debugLeases: this.#leases(),
      ...(this.#error === undefined ? {} : { error: this.#error }),
    }
  }
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }
  #notify(): void {
    for (const listener of this.#listeners) {
      try {
        listener()
      } catch {
        /* Observers cannot interrupt the host. */
      }
    }
  }
  async export(query: HostLogQuery, format: 'text' | 'jsonl', signal?: AbortSignal): Promise<Uint8Array> {
    if (this.#exportId !== undefined) throw new Error('已有日志正在导出，请等待完成。')
    const result = await this.#request('export', { query: hostLogQuerySchema.parse(query), format }, signal)
    if (!(result instanceof Uint8Array)) throw new Error('日志导出结果无效。')
    return result
  }
  async close(): Promise<void> {
    if (this.#closing) return
    this.#closing = true
    clearInterval(this.#timer)
    await this.#settingsTail
    if (this.#exportId !== undefined) this.#worker?.postMessage({ id: this.#exportId, method: 'cancel' })
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      this.flush(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 5000)
      }),
    ])
    clearTimeout(timer)
    this.#state = 'closed'
    this.#listeners.clear()
    this.#debug.clear()
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('日志服务已关闭。'))
    }
    this.#pending.clear()
    await this.#worker?.terminate()
    this.#worker = undefined
  }
}
