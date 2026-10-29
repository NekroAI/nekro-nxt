import { lstat } from 'node:fs/promises'
import path from 'node:path'
import type { DataLocationFiles, UserDataSource } from './data-location.js'
import {
  createDataMoveRecord,
  readDataMoveRecord,
  writeDataMoveRecord,
  type DataMoveFailure,
  type DataMoveRecord,
} from './data-move.js'
import { directorySize, preflightMove, type MoveMethod, type PreflightProblem } from './data-move-plan.js'
import type { StorageFacts } from './storage-location.js'

/** What Settings → 存储 shows for the local instance. Sent over the product preload bridge as plain JSON. */
export interface DataDirectoryStatus {
  readonly available: boolean
  /** Why the directory cannot be changed here. */
  readonly lockedBy?: 'environment'
  readonly path: string
  /** Left behind by the last move: everything (copy) or only the upgrade recovery points (move). */
  readonly oldDirectory?: { readonly path: string; readonly method: MoveMethod }
  readonly lastFailure?: DataMoveFailure & { readonly target: string }
}

export interface DataDirectorySizes {
  readonly current: number
  readonly oldDirectory?: number
}

export type DataDirectoryChoice =
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'rejected'; readonly target: string; readonly problem: PreflightProblem }
  | {
      readonly kind: 'ready'
      readonly target: string
      readonly method: MoveMethod
      readonly bytes: number
      readonly estimatedSeconds: number
    }

export interface DataDirectoryServiceOptions {
  readonly userData: string
  readonly source: UserDataSource
  readonly files: DataLocationFiles
  readonly storage: StorageFacts
  readonly pickDirectory: () => Promise<string | undefined>
  /** Stops the local service and waits for it to exit. */
  readonly stopHost: () => Promise<void>
  /** Restarts the app in migration mode; does not return in production. */
  readonly relaunchForMove: () => void
  readonly showItemInFolder: (target: string) => void
  readonly now?: () => number
}

const exists = async (target: string): Promise<boolean> =>
  lstat(target).then(
    () => true,
    () => false,
  )

export type DesktopDataDirectory = Pick<
  DataDirectoryService,
  'status' | 'sizes' | 'choose' | 'start' | 'revealOldDirectory' | 'dismissNotice'
>

/** Owns the data-directory entry in Settings: status, choosing a target, and handing over to migration mode. */
export class DataDirectoryService {
  readonly #options: DataDirectoryServiceOptions
  #starting = false

  constructor(options: DataDirectoryServiceOptions) {
    this.#options = options
  }

  get #available(): boolean {
    return this.#options.source !== 'environment'
  }

  async #record(): Promise<DataMoveRecord | undefined> {
    return this.#available ? readDataMoveRecord(this.#options.files.record) : undefined
  }

  async #oldDirectory(record: DataMoveRecord | undefined): Promise<DataDirectoryStatus['oldDirectory']> {
    if (record?.phase !== 'completed' || record.noticeDismissed === true) return undefined
    if (path.resolve(record.source) === path.resolve(this.#options.userData)) return undefined
    if (!(await exists(record.source))) return undefined
    return { path: record.source, method: record.method }
  }

  async status(): Promise<DataDirectoryStatus> {
    const record = await this.#record()
    const oldDirectory = await this.#oldDirectory(record)
    return {
      available: this.#available,
      ...(this.#available ? {} : { lockedBy: 'environment' as const }),
      path: this.#options.userData,
      ...(oldDirectory === undefined ? {} : { oldDirectory }),
      ...(record?.phase === 'failed' && record.noticeDismissed !== true && record.failure !== undefined
        ? { lastFailure: { ...record.failure, target: record.target } }
        : {}),
    }
  }

  async sizes(): Promise<DataDirectorySizes> {
    const oldDirectory = await this.#oldDirectory(await this.#record())
    const [current, old] = await Promise.all([
      directorySize(this.#options.userData),
      oldDirectory === undefined ? Promise.resolve(undefined) : directorySize(oldDirectory.path),
    ])
    return { current, ...(old === undefined ? {} : { oldDirectory: old }) }
  }

  async #preflight(target: string): Promise<DataDirectoryChoice> {
    const result = await preflightMove(this.#options.userData, target, { storage: this.#options.storage })
    if (!result.ok) return { kind: 'rejected', target, problem: result.problem }
    const { plan } = result
    return {
      kind: 'ready',
      target: plan.target,
      method: plan.method,
      bytes: plan.bytes,
      estimatedSeconds: plan.estimatedSeconds,
    }
  }

  async choose(): Promise<DataDirectoryChoice> {
    if (!this.#available) throw new Error('The data directory is set by NEKRO_DESKTOP_USER_DATA.')
    const target = await this.#options.pickDirectory()
    if (target === undefined) return { kind: 'cancelled' }
    return this.#preflight(target)
  }

  /**
   * Checks the target again, records the request, stops the local service and relaunches into migration mode. Returns
   * a rejection when the target stopped qualifying since it was chosen.
   */
  async start(target: string): Promise<DataDirectoryChoice> {
    if (!this.#available) throw new Error('The data directory is set by NEKRO_DESKTOP_USER_DATA.')
    if (this.#starting) throw new Error('A data directory move is already starting.')
    this.#starting = true
    try {
      const result = await preflightMove(this.#options.userData, target, { storage: this.#options.storage })
      if (!result.ok) return { kind: 'rejected', target, problem: result.problem }
      const now = (this.#options.now ?? Date.now)()
      const record = createDataMoveRecord(result.plan, now, process.pid)
      await writeDataMoveRecord(this.#options.files.record, record)
      try {
        await this.#options.stopHost()
      } catch (error) {
        await writeDataMoveRecord(this.#options.files.record, {
          ...record,
          phase: 'failed',
          failure: { message: '本机服务没有停止，数据目录没有更改。' },
          finishedAt: (this.#options.now ?? Date.now)(),
        })
        throw error
      }
      this.#options.relaunchForMove()
      return {
        kind: 'ready',
        target: result.plan.target,
        method: result.plan.method,
        bytes: result.plan.bytes,
        estimatedSeconds: result.plan.estimatedSeconds,
      }
    } finally {
      this.#starting = false
    }
  }

  async revealOldDirectory(): Promise<void> {
    const oldDirectory = await this.#oldDirectory(await this.#record())
    if (oldDirectory !== undefined) this.#options.showItemInFolder(oldDirectory.path)
  }

  /** Hides the old-directory row or the last failure; the files themselves are the user's to delete. */
  async dismissNotice(): Promise<void> {
    const record = await this.#record()
    if (record === undefined || (record.phase !== 'completed' && record.phase !== 'failed')) return
    await writeDataMoveRecord(this.#options.files.record, { ...record, noticeDismissed: true })
  }
}
