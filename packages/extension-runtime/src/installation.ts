import type { ExtensionId, ExtensionRevisionId } from '@nekro-nxt/contracts'
import type { ExtensionBuilder } from './builder.js'
import type { ExtensionService } from './service.js'
import type {
  ExtensionBuildArtifact,
  ExtensionRepository,
  ExtensionRuntimeDiagnostic,
  HostInstallation,
  Revision,
} from './types.js'

export interface MountedHostExtension {
  readonly adapterKey: string
  dispose(): Promise<void>
}

export interface HostExtensionInstallationHost {
  assertAdapterKeyAvailable(adapterKey: string, extensionId: ExtensionId): Promise<void>
  waitUntilSafe(adapterKey: string): Promise<void>
  mount(revision: Revision, artifact: ExtensionBuildArtifact): Promise<MountedHostExtension>
}

type ArtifactBuilder = Pick<ExtensionBuilder, 'build'>
type RevisionSourceResolver = Pick<ExtensionService, 'revisionSourceDirectory'>

/** Owns install/update/rollback/uninstall for Host-scoped Extension Revisions. */
export class HostExtensionInstallationCoordinator {
  readonly #repository: ExtensionRepository
  readonly #service: RevisionSourceResolver
  readonly #builder: ArtifactBuilder
  readonly #host: HostExtensionInstallationHost
  readonly #now: () => number
  readonly #mounted = new Map<ExtensionId, MountedHostExtension>()
  readonly #diagnostics = new Map<ExtensionId, ExtensionRuntimeDiagnostic>()
  readonly #transitions = new Map<ExtensionId, Promise<void>>()
  readonly #adapterTransitions = new Map<string, Promise<void>>()
  #disposed = false

  constructor(
    repository: ExtensionRepository,
    service: RevisionSourceResolver,
    builder: ArtifactBuilder,
    host: HostExtensionInstallationHost,
    options: { readonly now?: () => number } = {},
  ) {
    this.#repository = repository
    this.#service = service
    this.#builder = builder
    this.#host = host
    this.#now = options.now ?? Date.now
  }

  async install(input: {
    readonly extensionId: ExtensionId
    readonly revisionId: ExtensionRevisionId
  }): Promise<HostInstallation> {
    return this.#exclusive(input.extensionId, async () => {
      this.#assertAvailable()
      const revision = this.#requireRevision(input.extensionId, input.revisionId)
      if (this.#repository.getExtension(input.extensionId)?.scope !== 'host-adapter') {
        throw new Error('Only Host Adapter Extensions can be installed on this Host.')
      }
      const verification = this.#repository.getExtensionRevisionVerification(revision.id)
      if (verification?.scope !== 'host-adapter' || !verification.adapter) {
        throw new Error('Host 安装只接受完成适配器验证的 Extension Revision。')
      }
      const existing = this.#repository.getHostInstallation(input.extensionId)
      if (existing?.extensionRevisionId === revision.id && this.#mounted.has(input.extensionId)) return existing
      const artifact = await this.#build(revision)
      if (!artifact.hostEntry) throw new Error('适配器 Extension Revision 缺少 Host 构建产物。')
      const previousRevision = existing
        ? this.#requireRevision(existing.extensionId, existing.extensionRevisionId)
        : undefined
      const previousArtifact = previousRevision ? await this.#build(previousRevision) : undefined
      const previousMounted = this.#mounted.get(input.extensionId)
      const expectedKey = verification.adapter.key
      if (previousRevision) {
        const previousVerification = this.#repository.getExtensionRevisionVerification(previousRevision.id)
        if (previousVerification?.adapter?.key !== expectedKey) {
          throw new Error('同一个 Extension 的适配器 key 不得跨 Revision 改变。')
        }
      }
      if (previousMounted && previousMounted.adapterKey !== expectedKey) {
        throw new Error('同一个 Extension 的适配器 key 不得跨 Revision 改变。')
      }
      const installedAt = this.#timestamp()

      return this.#exclusiveAdapter(expectedKey, async () => {
        await this.#assertAdapterKeyAvailable(input.extensionId, expectedKey)
        await this.#host.waitUntilSafe(expectedKey)
        if (previousMounted) {
          await previousMounted.dispose()
          this.#mounted.delete(input.extensionId)
        }

        let mounted: MountedHostExtension
        try {
          mounted = await this.#host.mount(revision, artifact)
          if (mounted.adapterKey !== expectedKey) {
            await mounted.dispose()
            throw new Error('适配器 Host 实际注册的 key 与验证证据不一致。')
          }
        } catch (error) {
          await this.#restorePrevious(input.extensionId, previousRevision, previousArtifact, error)
          throw error
        }
        const installation: HostInstallation = {
          extensionId: input.extensionId,
          extensionRevisionId: revision.id,
          installedAt,
        }
        try {
          this.#repository.upsertHostInstallation(installation)
        } catch (error) {
          await mounted.dispose().catch(() => undefined)
          await this.#restorePrevious(input.extensionId, previousRevision, previousArtifact, error)
          throw error
        }
        this.#mounted.set(input.extensionId, mounted)
        this.#diagnostics.set(input.extensionId, { status: 'active', observedAt: this.#timestamp() })
        return installation
      })
    })
  }

  async restore(): Promise<{ readonly restored: number; readonly failed: number }> {
    this.#assertAvailable()
    const outcomes = await Promise.all(
      this.#repository.listHostInstallations().map(async (installation) => {
        try {
          return await this.#exclusive(installation.extensionId, async () => {
            this.#assertAvailable()
            if (this.#mounted.has(installation.extensionId)) return 'skipped' as const
            const revision = this.#requireRevision(installation.extensionId, installation.extensionRevisionId)
            const verification = this.#repository.getExtensionRevisionVerification(revision.id)
            if (verification?.scope !== 'host-adapter' || !verification.adapter) {
              throw new Error('Host 安装只接受完成适配器验证的 Extension Revision。')
            }
            const expectedKey = verification.adapter.key
            const artifact = await this.#build(revision)
            if (!artifact.hostEntry) throw new Error('适配器 Extension Revision 缺少 Host 构建产物。')
            await this.#exclusiveAdapter(expectedKey, async () => {
              await this.#assertAdapterKeyAvailable(installation.extensionId, expectedKey)
              const mounted = await this.#host.mount(revision, artifact)
              if (mounted.adapterKey !== expectedKey) {
                await mounted.dispose()
                throw new Error('适配器 Host 实际注册的 key 与验证证据不一致。')
              }
              this.#mounted.set(installation.extensionId, mounted)
              this.#diagnostics.set(installation.extensionId, {
                status: 'active',
                observedAt: this.#timestamp(),
              })
            })
            return 'restored' as const
          })
        } catch (error) {
          this.#diagnostics.set(installation.extensionId, {
            status: 'restore-failed',
            message: error instanceof Error ? error.message : String(error),
            observedAt: this.#timestamp(),
          })
          return 'failed' as const
        }
      }),
    )
    return {
      restored: outcomes.filter((outcome) => outcome === 'restored').length,
      failed: outcomes.filter((outcome) => outcome === 'failed').length,
    }
  }

  async uninstall(extensionId: ExtensionId): Promise<void> {
    await this.#exclusive(extensionId, async () => {
      this.#assertAvailable()
      const installation = this.#repository.getHostInstallation(extensionId)
      if (!installation) throw new Error('这个扩展尚未安装到本机。')
      const mounted = this.#mounted.get(extensionId)
      const revision = this.#requireRevision(extensionId, installation.extensionRevisionId)
      const artifact = await this.#build(revision)
      const verification = this.#repository.getExtensionRevisionVerification(revision.id)
      const adapterKey = mounted?.adapterKey ?? verification?.adapter?.key
      if (!adapterKey) throw new Error('已安装 Revision 缺少适配器 key。')
      await this.#exclusiveAdapter(adapterKey, async () => {
        if (mounted) {
          await this.#host.waitUntilSafe(adapterKey)
          try {
            await mounted.dispose()
          } catch (error) {
            this.#diagnostics.set(extensionId, {
              status: 'dispose-failed',
              message: error instanceof Error ? error.message : String(error),
              observedAt: this.#timestamp(),
            })
            throw error
          }
          this.#mounted.delete(extensionId)
        }
        try {
          this.#repository.deleteHostInstallation(extensionId)
        } catch (error) {
          if (mounted) await this.#restorePrevious(extensionId, revision, artifact, error)
          throw error
        }
        this.#diagnostics.delete(extensionId)
      })
    })
  }

  getDiagnostic(extensionId: ExtensionId): ExtensionRuntimeDiagnostic | undefined {
    return this.#diagnostics.get(extensionId)
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    await Promise.allSettled([...this.#transitions.values()])
    await Promise.allSettled([...this.#adapterTransitions.values()])
    const mounted = [...this.#mounted.values()]
    this.#mounted.clear()
    const outcomes = await Promise.allSettled(mounted.map((entry) => entry.dispose()))
    const failures = outcomes
      .filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
      .map((outcome): unknown => outcome.reason)
    if (failures.length) throw new AggregateError(failures, 'Host Extension Installation disposal failed.')
  }

  async #restorePrevious(
    extensionId: ExtensionId,
    revision: Revision | undefined,
    artifact: ExtensionBuildArtifact | undefined,
    originalError: unknown,
  ): Promise<void> {
    if (!revision || !artifact) return
    try {
      this.#mounted.set(extensionId, await this.#host.mount(revision, artifact))
    } catch (restoreError) {
      throw new AggregateError([originalError, restoreError], 'Host Extension 变更失败，且原 Revision 无法恢复。')
    }
  }

  #requireRevision(extensionId: ExtensionId, revisionId: ExtensionRevisionId): Revision {
    const revision = this.#repository.getExtensionRevision(revisionId)
    if (!revision || revision.extensionId !== extensionId) throw new Error('Revision 不属于所选 Extension。')
    return revision
  }

  #build(revision: Revision): Promise<ExtensionBuildArtifact> {
    return this.#builder.build({
      extensionId: revision.extensionId,
      revisionId: revision.id,
      contentDigest: revision.contentDigest,
      sourceDirectory: this.#service.revisionSourceDirectory(revision),
    })
  }

  async #exclusive<T>(extensionId: ExtensionId, operation: () => Promise<T>): Promise<T> {
    const preceding = this.#transitions.get(extensionId) ?? Promise.resolve()
    const result = preceding.catch(() => undefined).then(operation)
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    this.#transitions.set(extensionId, tail)
    try {
      return await result
    } finally {
      if (this.#transitions.get(extensionId) === tail) this.#transitions.delete(extensionId)
    }
  }

  async #exclusiveAdapter<T>(adapterKey: string, operation: () => Promise<T>): Promise<T> {
    const preceding = this.#adapterTransitions.get(adapterKey) ?? Promise.resolve()
    const result = preceding.catch(() => undefined).then(operation)
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    this.#adapterTransitions.set(adapterKey, tail)
    try {
      return await result
    } finally {
      if (this.#adapterTransitions.get(adapterKey) === tail) this.#adapterTransitions.delete(adapterKey)
    }
  }

  async #assertAdapterKeyAvailable(extensionId: ExtensionId, adapterKey: string): Promise<void> {
    const occupied = [...this.#mounted.entries()].find(
      ([mountedExtensionId, mounted]) => mountedExtensionId !== extensionId && mounted.adapterKey === adapterKey,
    )
    if (occupied) throw new Error(`适配器 key 已由其他 Extension 安装: ${adapterKey}`)
    await this.#host.assertAdapterKeyAvailable(adapterKey, extensionId)
  }

  #timestamp(): number {
    const value = this.#now()
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Clock must return a non-negative integer.')
    return value
  }

  #assertAvailable(): void {
    if (this.#disposed) throw new Error('Host Extension Installation coordinator is disposed.')
  }
}
