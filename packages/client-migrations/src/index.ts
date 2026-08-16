/** A versioned value owned by one client persistence namespace. */
export interface PersistedEnvelope<T = unknown> {
  readonly format: string
  readonly version: number
  readonly data: T
}

/** One deterministic migration from version N to N + 1. */
export interface MigrationStep {
  readonly from: number
  readonly migrate: (data: unknown) => unknown
}

export type MigrationErrorCode =
  'invalid-envelope' | 'unknown-format' | 'future-version' | 'invalid-registry' | 'migration-failed'

/** A classified migration failure that callers can map to reset or recovery UI. */
export class MigrationError extends Error {
  readonly code: MigrationErrorCode
  readonly cause?: unknown

  constructor(code: MigrationErrorCode, message: string, cause?: unknown) {
    super(message)
    this.name = 'MigrationError'
    this.code = code
    if (cause !== undefined) this.cause = cause
  }
}

/** Validates a continuous migration chain and upgrades one namespace without mutating the caller's input. */
export class MigrationRegistry<T> {
  readonly #format: string
  readonly #currentVersion: number
  readonly #steps: ReadonlyMap<number, MigrationStep>
  readonly #parseCurrent: (data: unknown) => T

  constructor(options: {
    readonly format: string
    readonly currentVersion: number
    readonly steps: readonly MigrationStep[]
    readonly parseCurrent: (data: unknown) => T
  }) {
    if (options.format.length === 0 || !Number.isSafeInteger(options.currentVersion) || options.currentVersion < 0) {
      throw new MigrationError('invalid-registry', 'Migration registry requires a format and a non-negative version.')
    }

    const steps = new Map<number, MigrationStep>()
    for (const step of options.steps) {
      if (!Number.isSafeInteger(step.from) || step.from < 0 || step.from >= options.currentVersion) {
        throw new MigrationError('invalid-registry', `Migration step ${step.from} is outside the supported range.`)
      }
      if (steps.has(step.from)) {
        throw new MigrationError('invalid-registry', `Migration step ${step.from} is registered more than once.`)
      }
      steps.set(step.from, step)
    }
    for (let version = 0; version < options.currentVersion; version += 1) {
      if (!steps.has(version)) {
        throw new MigrationError('invalid-registry', `Migration step ${version} → ${version + 1} is missing.`)
      }
    }

    this.#format = options.format
    this.#currentVersion = options.currentVersion
    this.#steps = steps
    this.#parseCurrent = options.parseCurrent
  }

  migrate(envelope: PersistedEnvelope): PersistedEnvelope<T> {
    if (!Number.isSafeInteger(envelope.version) || envelope.version < 0) {
      throw new MigrationError('invalid-envelope', 'Persisted version must be a non-negative integer.')
    }
    if (envelope.format !== this.#format) {
      throw new MigrationError('unknown-format', `Expected format ${this.#format}, received ${envelope.format}.`)
    }
    if (envelope.version > this.#currentVersion) {
      throw new MigrationError(
        'future-version',
        `Stored version ${envelope.version} is newer than supported version ${this.#currentVersion}.`,
      )
    }

    let version = envelope.version
    let data = structuredClone(envelope.data)
    try {
      while (version < this.#currentVersion) {
        const step = this.#steps.get(version)
        if (!step) throw new Error(`Migration registry lost step ${version}.`)
        data = step.migrate(data)
        version += 1
      }
      return { format: this.#format, version, data: this.#parseCurrent(data) }
    } catch (error) {
      if (error instanceof MigrationError) throw error
      throw new MigrationError('migration-failed', `Migration failed at version ${version}.`, error)
    }
  }
}

/** One idempotent Host upgrade step with a stable journal identity. */
export interface UpgradeStep {
  readonly id: string
  readonly run: () => Promise<void>
}

/** Durable journal operations supplied by the Host storage owner. */
export interface UpgradeJournal {
  readonly begin: (id: string) => Promise<void>
  readonly complete: (id: string) => Promise<void>
  readonly fail: (id: string, error: unknown) => Promise<void>
}

/** Runs ordered upgrade steps and publishes completion only after each step succeeds. */
export async function runUpgradePlan(steps: readonly UpgradeStep[], journal: UpgradeJournal): Promise<void> {
  const ids = new Set<string>()
  for (const step of steps) {
    if (step.id.length === 0 || ids.has(step.id)) {
      throw new MigrationError('invalid-registry', `Upgrade step id must be non-empty and unique: ${step.id}`)
    }
    ids.add(step.id)
  }

  for (const step of steps) {
    await journal.begin(step.id)
    try {
      await step.run()
      await journal.complete(step.id)
    } catch (error) {
      await journal.fail(step.id, error)
      throw error
    }
  }
}

export type HostUpgradePhase = 'idle' | 'preflight' | 'backup' | 'migrating' | 'ready' | 'recovery'

export interface HostUpgradeStatus {
  readonly phase: HostUpgradePhase
  readonly backupId?: string
  readonly currentStepId?: string
  readonly errorSummary?: string
}

export interface HostUpgradeLock {
  acquire(): Promise<() => Promise<void>>
}

export interface HostUpgradeCoordinatorOptions {
  readonly lock: HostUpgradeLock
  readonly preflight: () => Promise<void>
  readonly createBackup: () => Promise<{ readonly id: string }>
  readonly steps: readonly UpgradeStep[]
  readonly journal: UpgradeJournal
}

/** Coordinates all owner migrations without pretending they share one transaction. */
export class HostUpgradeCoordinator {
  readonly #options: HostUpgradeCoordinatorOptions
  readonly #listeners = new Set<() => void>()
  #status: HostUpgradeStatus = { phase: 'idle' }
  #task: Promise<HostUpgradeStatus> | undefined

  constructor(options: HostUpgradeCoordinatorOptions) {
    this.#options = options
  }

  getSnapshot(): HostUpgradeStatus {
    return this.#status
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  run(): Promise<HostUpgradeStatus> {
    if (this.#task) return this.#task
    this.#task = this.#run().finally(() => {
      this.#task = undefined
    })
    return this.#task
  }

  async #run(): Promise<HostUpgradeStatus> {
    const release = await this.#options.lock.acquire()
    let backupId: string | undefined
    try {
      this.#publish({ phase: 'preflight' })
      await this.#options.preflight()
      this.#publish({ phase: 'backup' })
      const backup = await this.#options.createBackup()
      backupId = backup.id
      this.#publish({ phase: 'migrating', backupId })
      const journal: UpgradeJournal = {
        begin: async (id) => {
          this.#publish({ phase: 'migrating', backupId: backup.id, currentStepId: id })
          await this.#options.journal.begin(id)
        },
        complete: (id) => this.#options.journal.complete(id),
        fail: (id, error) => this.#options.journal.fail(id, error),
      }
      await runUpgradePlan(this.#options.steps, journal)
      this.#publish({ phase: 'ready', backupId })
      return this.#status
    } catch (error) {
      this.#publish({
        phase: 'recovery',
        ...(backupId === undefined ? {} : { backupId }),
        errorSummary: (error instanceof Error ? error.message : String(error)).slice(0, 512),
      })
      return this.#status
    } finally {
      await release()
    }
  }

  #publish(status: HostUpgradeStatus): void {
    this.#status = status
    for (const listener of this.#listeners) listener()
  }
}
