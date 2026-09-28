import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import path from 'node:path'
import type { HostUpgradeStatus } from '@nekro-nxt/client-migrations'
import { z } from 'zod'
import { writeUpgradeJson } from './upgrade-backup.js'

const statusSchema = z.object({
  phase: z.enum(['idle', 'preflight', 'backup', 'migrating', 'checking', 'activating', 'ready', 'recovery']),
  backupId: z.string().optional(),
  currentStepId: z.string().optional(),
  errorSummary: z.string().optional(),
  progress: z
    .object({
      completed: z.number().finite().nonnegative(),
      total: z.number().finite().nonnegative().optional(),
      unit: z.enum(['bytes', 'items']),
    })
    .optional(),
})
const progressSchema = z.object({
  format: z.literal('nxt.host-upgrade-progress'),
  version: z.literal(1),
  releaseId: z.string().min(1),
  runId: z.string().min(1),
  pid: z.number().int().positive(),
  updatedAt: z.number().finite().nonnegative(),
  status: statusSchema,
})
interface Writer {
  readonly releaseId: string
  readonly runId: string
  tail: Promise<void>
  closed: boolean
}
const writers = new Map<string, Writer>()
const filenameFor = (dataRoot: string): string => path.join(path.resolve(dataRoot), 'backups', 'upgrade-progress.json')
const readProgress = async (filename: string): Promise<z.infer<typeof progressSchema> | undefined> => {
  let handle
  try {
    handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
    const info = await handle.stat()
    if (!info.isFile() || info.nlink !== 1) throw new Error('升级进度文件路径冲突。')
    return progressSchema.parse(JSON.parse(await handle.readFile('utf8')))
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  } finally {
    await handle?.close()
  }
}
const enqueue = (writer: Writer, operation: () => Promise<void>): Promise<void> => {
  const task = writer.tail.then(operation)
  // Return this operation's failure, but do not permanently poison subsequent recovery writes.
  writer.tail = task.catch(() => undefined)
  return task
}

/** Caller owns the data-root lease until close/failure publication has settled. */
export function createUpgradeProgress(dataRoot: string, releaseId: string) {
  const filename = filenameFor(dataRoot)
  if (writers.get(filename)?.closed === false) throw new Error('同一数据根已有升级进度写入器。')
  const runId = process.env['NEKRO_UPGRADE_RUN_ID']?.trim() || randomUUID()
  const writer: Writer = { runId, releaseId, tail: Promise.resolve(), closed: false }
  writers.set(filename, writer)
  let status: HostUpgradeStatus = { phase: 'preflight' }
  let published = false
  let heartbeatPending = false
  let closing: Promise<void> | undefined
  const publish = (): Promise<void> =>
    enqueue(writer, async () => {
      if (writers.get(filename) !== writer) throw new Error('升级进度写入器已被替换。')
      if (published) {
        const current = await readProgress(filename)
        if (
          current !== undefined &&
          (current.pid !== process.pid || current.releaseId !== releaseId || current.runId !== runId)
        )
          throw new Error('升级进度已由另一 Host 接管。')
      }
      await writeUpgradeJson(filename, {
        format: 'nxt.host-upgrade-progress',
        version: 1,
        releaseId,
        runId,
        pid: process.pid,
        updatedAt: Date.now(),
        status,
      })
      published = true
    })
  const timer = setInterval(() => {
    if (writer.closed || heartbeatPending) return
    heartbeatPending = true
    void publish()
      .catch(() => undefined)
      .finally(() => {
        heartbeatPending = false
      })
  }, 5000)
  timer.unref()
  return {
    update(next: HostUpgradeStatus): Promise<void> {
      if (writer.closed) return Promise.reject(new Error('升级进度写入器已关闭。'))
      const parsed = statusSchema.parse(next)
      if ((status.phase === 'ready' || status.phase === 'recovery') && parsed.phase !== status.phase)
        return Promise.reject(new Error('已提交的升级终态不能被迟到进度覆盖。'))
      status = {
        phase: parsed.phase,
        ...(parsed.backupId === undefined ? {} : { backupId: parsed.backupId }),
        ...(parsed.currentStepId === undefined ? {} : { currentStepId: parsed.currentStepId }),
        ...(parsed.errorSummary === undefined ? {} : { errorSummary: parsed.errorSummary }),
        ...(parsed.progress === undefined
          ? {}
          : {
              progress: {
                completed: parsed.progress.completed,
                unit: parsed.progress.unit,
                ...(parsed.progress.total === undefined ? {} : { total: parsed.progress.total }),
              },
            }),
      }
      return publish()
    },
    progress(completed: number, total: number): void {
      if (writer.closed || status.phase === 'ready' || status.phase === 'recovery') return
      if (!Number.isFinite(completed) || !Number.isFinite(total) || completed < 0 || total < completed)
        throw new Error('升级进度计数无效。')
      status = { ...status, progress: { completed, total, unit: 'bytes' } }
    },
    close(): Promise<void> {
      if (closing !== undefined) return closing
      writer.closed = true
      clearInterval(timer)
      closing = publish()
      return closing
    },
  }
}

/** Call before releasing the root lease, including when Web startup fails after Runtime readiness. */
export async function markUpgradeProgressFailure(
  dataRoot: string,
  releaseId: string,
  errorSummary: string,
): Promise<void> {
  const filename = filenameFor(dataRoot)
  const writer = writers.get(filename)
  if (writer === undefined || writer.releaseId !== releaseId) return
  if (!writer.closed) throw new Error('标记最终启动失败前必须先关闭升级进度写入器。')
  await enqueue(writer, async () => {
    if (writers.get(filename) !== writer) return
    const current = await readProgress(filename)
    if (
      current === undefined ||
      current.pid !== process.pid ||
      current.releaseId !== releaseId ||
      current.runId !== writer.runId
    )
      return
    await writeUpgradeJson(filename, {
      ...current,
      updatedAt: Date.now(),
      status: { ...current.status, phase: 'recovery', errorSummary: errorSummary.slice(0, 512) },
    })
  })
}
