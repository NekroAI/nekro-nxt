import type { AgentId, ExtensionId, ExtensionRevisionId, JsonValue } from '@nekro-nxt/contracts'
import type { ExtensionBuilder } from './builder.js'
import type { ExtensionService } from './service.js'
import type {
  Activation,
  ExtensionBuildArtifact,
  ExtensionRepository,
  ExtensionRuntimeDiagnostic,
  Revision,
} from './types.js'

export interface MountedExtension {
  readonly evidence: {
    readonly hostLoaded: boolean
    readonly clientBuilt: boolean
    readonly details: readonly string[]
  }
  dispose(): Promise<void>
}

export interface ExtensionActivationHost {
  waitUntilSafe(agentId: AgentId): Promise<void>
  mount(
    agentId: AgentId,
    revision: Revision,
    artifact: ExtensionBuildArtifact,
    config: JsonValue,
  ): Promise<MountedExtension>
}

type ArtifactBuilder = Pick<ExtensionBuilder, 'build'>
type RevisionSourceResolver = Pick<ExtensionService, 'revisionSourceDirectory'>

export class ExtensionActivationCoordinator {
  readonly #repository: ExtensionRepository
  readonly #service: RevisionSourceResolver
  readonly #builder: ArtifactBuilder
  readonly #host: ExtensionActivationHost
  readonly #now: () => number
  readonly #mounted = new Map<string, MountedExtension>()
  readonly #diagnostics = new Map<string, ExtensionRuntimeDiagnostic>()
  readonly #transitions = new Map<string, Promise<void>>()
  #disposed = false
  #disposePromise: Promise<void> | undefined

  constructor(
    repository: ExtensionRepository,
    service: RevisionSourceResolver,
    builder: ArtifactBuilder,
    host: ExtensionActivationHost,
    options: { readonly now?: () => number } = {},
  ) {
    this.#repository = repository
    this.#service = service
    this.#builder = builder
    this.#host = host
    this.#now = options.now ?? Date.now
  }

  async activate(input: {
    readonly agentId: AgentId
    readonly extensionId: ExtensionId
    readonly revisionId: ExtensionRevisionId
    readonly config?: JsonValue
  }): Promise<Activation> {
    const key = this.#key(input.agentId, input.extensionId)
    return this.#exclusive(key, async () => {
      this.#assertAvailable()
      const revision = this.#repository.getExtensionRevision(input.revisionId)
      if (!revision || revision.extensionId !== input.extensionId) {
        throw new Error('Activation requires a Revision owned by the selected Extension.')
      }
      if (this.#repository.getExtensionRevisionVerification(revision.id)?.scope === 'host-adapter') {
        throw new Error('适配器 Revision 必须安装到本机，不能启用给智能体。')
      }
      if (this.#repository.getExtension(input.extensionId)?.scope !== 'agent') {
        throw new Error('Only Agent-scoped Extensions can be activated for an intelligent agent.')
      }

      const artifact = await this.#build(revision)
      const previous = this.#repository.getActivation(input.agentId, input.extensionId)
      const previousInstance = this.#mounted.get(key)
      const rollback = previousInstance && previous ? await this.#prepareRollback(previous) : undefined
      await this.#host.waitUntilSafe(input.agentId)

      if (previousInstance) {
        await previousInstance.dispose()
        this.#mounted.delete(key)
      }

      let mounted: MountedExtension
      try {
        mounted = await this.#host.mount(input.agentId, revision, artifact, input.config ?? {})
      } catch (error) {
        await this.#restorePrevious(key, rollback, error)
        throw error
      }

      const activation: Activation = {
        agentId: input.agentId,
        extensionId: input.extensionId,
        extensionRevisionId: input.revisionId,
        config: input.config ?? {},
        activatedAt: this.#timestamp(),
      }
      try {
        this.#repository.upsertActivation(activation)
      } catch (error) {
        await mounted.dispose().catch(() => undefined)
        await this.#restorePrevious(key, rollback, error)
        throw error
      }
      this.#mounted.set(key, mounted)
      this.#diagnostics.set(key, { status: 'active', observedAt: this.#timestamp() })
      return activation
    })
  }

  /** Mounts the repository's committed current Activations without inventing failure states. */
  async restore(): Promise<{ readonly restored: number; readonly failed: number }> {
    this.#assertAvailable()
    let restored = 0
    let failed = 0
    for (const activation of this.#repository.listActivations()) {
      const key = this.#key(activation.agentId, activation.extensionId)
      try {
        const mounted = await this.#exclusive(key, async () => {
          this.#assertAvailable()
          if (this.#mounted.has(key)) return false
          const revision = this.#repository.getExtensionRevision(activation.extensionRevisionId)
          if (!revision || revision.extensionId !== activation.extensionId) {
            throw new Error('Activation refers to an unavailable Extension Revision.')
          }
          const artifact = await this.#build(revision)
          this.#mounted.set(key, await this.#host.mount(activation.agentId, revision, artifact, activation.config))
          this.#diagnostics.set(key, { status: 'active', observedAt: this.#timestamp() })
          return true
        })
        if (mounted) restored += 1
      } catch (error) {
        this.#diagnostics.set(key, {
          status: 'restore-failed',
          message: error instanceof Error ? error.message : String(error),
          observedAt: this.#timestamp(),
        })
        failed += 1
      }
    }
    return { restored, failed }
  }

  async disable(agentId: AgentId, extensionId: ExtensionId): Promise<void> {
    const key = this.#key(agentId, extensionId)
    await this.#exclusive(key, async () => {
      this.#assertAvailable()
      const activation = this.#repository.getActivation(agentId, extensionId)
      if (!activation) throw new Error(`Extension is not active for Agent: ${extensionId}`)
      const instance = this.#mounted.get(key)
      const rollback = instance ? await this.#prepareRollback(activation) : undefined
      await this.#host.waitUntilSafe(agentId)
      if (instance) {
        try {
          await instance.dispose()
        } catch (error) {
          this.#diagnostics.set(key, {
            status: 'dispose-failed',
            message: error instanceof Error ? error.message : String(error),
            observedAt: this.#timestamp(),
          })
          throw error
        }
        this.#mounted.delete(key)
      }
      try {
        this.#repository.deleteActivation(agentId, extensionId)
      } catch (error) {
        await this.#restorePrevious(key, rollback, error)
        throw error
      }
      this.#diagnostics.delete(key)
    })
  }

  getDiagnostic(agentId: AgentId, extensionId: ExtensionId): ExtensionRuntimeDiagnostic | undefined {
    return this.#diagnostics.get(this.#key(agentId, extensionId))
  }

  async dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise
    this.#disposed = true
    this.#disposePromise = (async () => {
      await Promise.allSettled([...this.#transitions.values()])
      const instances = [...this.#mounted.values()]
      this.#mounted.clear()
      const outcomes = await Promise.allSettled(instances.map((instance) => instance.dispose()))
      const failures = outcomes
        .filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
        .map((outcome): unknown => outcome.reason)
      if (failures.length) throw new AggregateError(failures, 'Extension Activation disposal failed.')
    })()
    return this.#disposePromise
  }

  async #build(revision: Revision): Promise<ExtensionBuildArtifact> {
    return this.#builder.build({
      extensionId: revision.extensionId,
      revisionId: revision.id,
      contentDigest: revision.contentDigest,
      sourceDirectory: this.#service.revisionSourceDirectory(revision),
    })
  }

  async #prepareRollback(activation: Activation): Promise<{
    readonly activation: Activation
    readonly revision: Revision
    readonly artifact: ExtensionBuildArtifact
  }> {
    const revision = this.#repository.getExtensionRevision(activation.extensionRevisionId)
    if (!revision || revision.extensionId !== activation.extensionId) {
      throw new Error('Current Activation refers to an unavailable Extension Revision.')
    }
    return { activation, revision, artifact: await this.#build(revision) }
  }

  async #restorePrevious(
    key: string,
    rollback:
      | { readonly activation: Activation; readonly revision: Revision; readonly artifact: ExtensionBuildArtifact }
      | undefined,
    originalError: unknown,
  ): Promise<void> {
    if (!rollback) return
    try {
      this.#mounted.set(
        key,
        await this.#host.mount(
          rollback.activation.agentId,
          rollback.revision,
          rollback.artifact,
          rollback.activation.config,
        ),
      )
    } catch (restoreError) {
      throw new AggregateError(
        [originalError, restoreError],
        'Activation failed and the previous mount could not be restored.',
      )
    }
  }

  async #exclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const preceding = this.#transitions.get(key) ?? Promise.resolve()
    const result = preceding.catch(() => undefined).then(operation)
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    this.#transitions.set(key, tail)
    try {
      return await result
    } finally {
      if (this.#transitions.get(key) === tail) this.#transitions.delete(key)
    }
  }

  #key(agentId: AgentId, extensionId: ExtensionId): string {
    return `${agentId}\0${extensionId}`
  }

  #assertAvailable(): void {
    if (this.#disposed) throw new Error('Extension Activation coordinator is disposed.')
  }

  #timestamp(): number {
    const value = this.#now()
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Clock must return a non-negative integer.')
    return value
  }
}
