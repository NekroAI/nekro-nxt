import { serializeDataLocationPointer, type DataLocationFiles } from './data-location.js'
import {
  describeFailure,
  runDataMove,
  undoDataMove,
  withoutRewrites,
  writeDataLocationPointer,
  writeDataMoveRecord,
  type DataMoveFailure,
  type DataMoveProgress,
  type DataMoveRecord,
} from './data-move.js'
import type { DataMoveViewState } from './data-move-window.js'

/**
 * The migration-mode launch: moves or undoes the data directory while nothing else has it open, then hands back to a
 * normal launch. Everything Electron-specific comes in through the options so the sequence is testable.
 */
export interface DataMoveModeOptions {
  readonly files: DataLocationFiles
  readonly record: DataMoveRecord
  readonly kind: 'migrate' | 'undo'
  readonly publish: (state: Omit<DataMoveViewState, 'diagnostics'>) => void
  readonly checkSqlite: (file: string) => void | Promise<void>
  /** Starts the app normally and exits this process. */
  readonly relaunch: () => void
  readonly now?: () => number
  readonly heartbeatMs?: number
}

const INTERRUPTED: DataMoveFailure = { message: '上次更改数据目录没有完成，数据已回到原来的目录。' }

export const runDataMoveMode = async (options: DataMoveModeOptions): Promise<'relaunched' | 'stopped'> => {
  const now = options.now ?? Date.now
  let current: DataMoveRecord = { ...options.record, pid: process.pid, heartbeatAt: now() }
  // One writer: progress steps and the heartbeat must not overwrite each other with an older copy of the record.
  let writes: Promise<void> = Promise.resolve()
  const writeRecord = (record: DataMoveRecord): Promise<void> => {
    current = record
    const next = writes.catch(() => undefined).then(() => writeDataMoveRecord(options.files.record, record))
    writes = next
    return next
  }
  const heartbeat = setInterval(() => {
    void writeRecord({ ...current, heartbeatAt: now() }).catch(() => undefined)
  }, options.heartbeatMs ?? 5_000)
  const base = { method: current.method, source: current.source, target: current.target }
  const undo = async (failure: DataMoveFailure, mode: 'failed' | 'interrupted'): Promise<'stopped'> => {
    options.publish({ ...base, mode: 'undoing' })
    try {
      await undoDataMove(current)
    } catch (error) {
      // The record stays unfinished, so the next launch tries the undo again before opening anything.
      options.publish({
        ...base,
        mode: 'failed',
        failure: { message: `没能恢复原来的目录：${describeFailure(error).message}。重新打开 NekroNXT 会再试一次。` },
      })
      return 'stopped'
    }
    await writeRecord({ ...withoutRewrites(current), phase: 'failed', failure, finishedAt: now(), heartbeatAt: now() })
    options.publish({ ...base, mode, ...(mode === 'failed' ? { failure } : {}) })
    return 'stopped'
  }
  try {
    // Claim the record: a normal launch now sees a live owner and waits instead of opening the directory.
    await writeRecord(current)
    if (options.kind === 'undo') return await undo(INTERRUPTED, 'interrupted')
    await writeRecord({ ...current, phase: 'moving' })
    options.publish({ ...base, mode: 'moving' })
    let moved: DataMoveRecord
    try {
      moved = await runDataMove(current, {
        writeRecord,
        checkSqlite: options.checkSqlite,
        now,
        onProgress: (progress: DataMoveProgress) => options.publish({ ...base, mode: 'moving', progress }),
      })
    } catch (error) {
      return await undo(describeFailure(error), 'failed')
    }
    options.publish({ ...base, mode: 'switching' })
    // The pointer is the switch-over point: once it names the target, every later launch opens the new directory.
    try {
      await writeDataLocationPointer(options.files.pointer, serializeDataLocationPointer(moved.target))
    } catch (error) {
      return await undo({ message: `无法保存新的数据目录位置：${describeFailure(error).message}` }, 'failed')
    }
    try {
      await writeRecord({ ...current, phase: 'switched' })
      await writeRecord({ ...withoutRewrites(current), phase: 'completed', finishedAt: now() })
    } catch (error) {
      // The pointer already names the target; the next launch finishes the record.
      console.error('[desktop] 数据目录已切换，迁移记录未能更新。', error)
    }
    options.relaunch()
    return 'relaunched'
  } finally {
    clearInterval(heartbeat)
    await writes.catch(() => undefined)
  }
}
