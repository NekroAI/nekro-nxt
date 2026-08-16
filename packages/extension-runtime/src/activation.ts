import type { AgentActivationId, AgentId, ExtensionId, ExtensionRevisionId, JsonValue } from '@nekro-nxt/contracts'
import { monotonicFactory } from 'ulid'
import type { ExtensionBuilder } from './builder.js'
import type { ExtensionService } from './service.js'
import type {
  AgentActivationRecord,
  ExtensionBuildArtifact,
  ExtensionRepository,
  ExtensionRevisionRecord,
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
    revision: ExtensionRevisionRecord,
    artifact: ExtensionBuildArtifact,
    config: JsonValue,
  ): Promise<MountedExtension>
}

export class ExtensionActivationCoordinator {
  readonly #repository: ExtensionRepository
  readonly #service: ExtensionService
  readonly #builder: ExtensionBuilder
  readonly #host: ExtensionActivationHost
  readonly #now: () => number
  readonly #nextUlid: () => string
  readonly #mounted = new Map<AgentActivationId, MountedExtension>()

  constructor(
    repository: ExtensionRepository,
    service: ExtensionService,
    builder: ExtensionBuilder,
    host: ExtensionActivationHost,
    options: { readonly now?: () => number; readonly nextUlid?: () => string } = {},
  ) {
    this.#repository = repository
    this.#service = service
    this.#builder = builder
    this.#host = host
    this.#now = options.now ?? Date.now
    this.#nextUlid = options.nextUlid ?? monotonicFactory()
  }

  async activate(input: {
    readonly agentId: AgentId
    readonly extensionId: ExtensionId
    readonly revisionId: ExtensionRevisionId
    readonly config?: JsonValue
  }): Promise<AgentActivationRecord> {
    const revision = this.#repository.getExtensionRevision(input.revisionId)
    if (!revision || revision.extensionId !== input.extensionId || revision.storageState !== 'saved') {
      throw new Error('Activation requires a saved Revision owned by the selected Extension.')
    }
    const activation: AgentActivationRecord = {
      id: this.#id<AgentActivationId>('act'),
      agentId: input.agentId,
      extensionId: input.extensionId,
      extensionRevisionId: input.revisionId,
      config: input.config ?? {},
      state: 'pending',
      runtimeKind: 'in-process',
      createdAt: this.#timestamp(),
    }
    this.#repository.createActivation(activation)
    const previous = this.#repository.getActiveActivation(input.agentId, input.extensionId)
    try {
      const artifact = await this.#build(revision)
      this.#repository.markActivationWaiting(activation.id)
      await this.#host.waitUntilSafe(input.agentId)
      const previousInstance = previous ? this.#mounted.get(previous.id) : undefined
      await previousInstance?.dispose()
      if (previous) this.#mounted.delete(previous.id)
      let mounted: MountedExtension
      try {
        mounted = await this.#host.mount(input.agentId, revision, artifact, activation.config)
      } catch (error) {
        if (previous) await this.#restorePrevious(previous)
        throw error
      }
      try {
        this.#repository.commitActivationSwitch(activation.id, previous?.id, this.#timestamp())
      } catch (error) {
        await mounted.dispose()
        if (previous) await this.#restorePrevious(previous)
        throw error
      }
      this.#mounted.set(activation.id, mounted)
      this.#repository.markExtensionValidation(revision.id, 'succeeded')
      return this.#repository.getActivation(activation.id)!
    } catch (error) {
      this.#repository.failActivation(activation.id, error instanceof Error ? error.message : String(error))
      this.#repository.markExtensionValidation(revision.id, 'failed')
      throw error
    }
  }

  async restore(): Promise<{ readonly restored: number; readonly failed: number }> {
    let restored = 0
    let failed = 0
    for (const activation of this.#repository.listActiveActivations()) {
      const revision = this.#repository.getExtensionRevision(activation.extensionRevisionId)
      if (!revision || revision.storageState !== 'saved') {
        this.#repository.failActivation(activation.id, 'Activation Revision source is unavailable.')
        failed += 1
        continue
      }
      try {
        const artifact = await this.#build(revision)
        this.#mounted.set(
          activation.id,
          await this.#host.mount(activation.agentId, revision, artifact, activation.config),
        )
        restored += 1
      } catch (error) {
        this.#repository.failActivation(activation.id, error instanceof Error ? error.message : String(error))
        failed += 1
      }
    }
    return { restored, failed }
  }

  async disable(id: AgentActivationId): Promise<void> {
    const activation = this.#repository.getActivation(id)
    if (!activation || activation.state !== 'active') throw new Error(`Activation is not active: ${id}`)
    await this.#host.waitUntilSafe(activation.agentId)
    await this.#mounted.get(id)?.dispose()
    this.#mounted.delete(id)
    this.#repository.disableActivation(id, this.#timestamp())
  }

  async dispose(): Promise<void> {
    const instances = [...this.#mounted.values()]
    this.#mounted.clear()
    await Promise.allSettled(instances.map((instance) => instance.dispose()))
  }

  async #build(revision: ExtensionRevisionRecord): Promise<ExtensionBuildArtifact> {
    try {
      const artifact = await this.#builder.build({
        revisionId: revision.id,
        contentDigest: revision.contentDigest,
        sourceDirectory: this.#service.revisionSourceDirectory(revision),
      })
      this.#repository.markExtensionBuild(revision.id, 'succeeded')
      return artifact
    } catch (error) {
      this.#repository.markExtensionBuild(revision.id, 'failed')
      throw error
    }
  }

  async #restorePrevious(previous: AgentActivationRecord): Promise<void> {
    const revision = this.#repository.getExtensionRevision(previous.extensionRevisionId)
    if (!revision) return
    const artifact = await this.#build(revision)
    this.#mounted.set(previous.id, await this.#host.mount(previous.agentId, revision, artifact, previous.config))
  }

  #id<T extends string>(prefix: string): T {
    return `${prefix}_${this.#nextUlid()}` as T
  }

  #timestamp(): number {
    const value = this.#now()
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Clock must return a non-negative integer.')
    return value
  }
}
