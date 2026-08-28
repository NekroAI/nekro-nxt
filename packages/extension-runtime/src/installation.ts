import {
  HostUiPermissionDeclarationSchema,
  HostUiPageInstanceIdSchema,
  type ExtensionId,
  type ExtensionRevisionId,
  type JsonValue,
} from '@nekro-nxt/contracts'
import { createHash, randomUUID } from 'node:crypto'
import type { ExtensionBuilder } from './builder.js'
import type { ExtensionService } from './service.js'
import type {
  ExtensionBuildArtifact,
  ExtensionRepository,
  HostUiPermissionGrant,
  HostUiRepository,
  ExtensionRuntimeDiagnostic,
  HostInstallation,
  Revision,
} from './types.js'

export interface MountedHostExtension {
  readonly adapterKey: string
  dispose(): Promise<void>
}

export interface MountedHostUiExtension {
  call(method: string, input: JsonValue): Promise<JsonValue>
  dispose(): Promise<void>
}

export interface HostExtensionInstallationHost {
  assertAdapterKeyAvailable(adapterKey: string, extensionId: ExtensionId): Promise<void>
  waitUntilSafe(adapterKey: string): Promise<void>
  mount(revision: Revision, artifact: ExtensionBuildArtifact): Promise<MountedHostExtension>
  mountHostUi?(revision: Revision, artifact: ExtensionBuildArtifact): Promise<MountedHostUiExtension>
}

type ArtifactBuilder = Pick<ExtensionBuilder, 'build'>
type RevisionSourceResolver = Pick<ExtensionService, 'revisionSourceDirectory'>

const canonicalPermissionDeclaration = (input: unknown) => {
  const parsed = HostUiPermissionDeclarationSchema.parse(input)
  return {
    permissions: [...parsed.permissions].sort(),
    networkOrigins: [...parsed.networkOrigins].sort(),
  }
}

export const hostUiPermissionDigest = (input: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(canonicalPermissionDeclaration(input)))
    .digest('hex')

const extensionOwnerKey = (extensionId: ExtensionId): string => `extension:${extensionId}`

/** Owns install/update/rollback/uninstall for Host-scoped Extension Revisions. */
export class HostExtensionInstallationCoordinator {
  readonly #repository: ExtensionRepository
  readonly #hostUiRepository: HostUiRepository
  readonly #service: RevisionSourceResolver
  readonly #builder: ArtifactBuilder
  readonly #host: HostExtensionInstallationHost
  readonly #now: () => number
  readonly #mounted = new Map<ExtensionId, MountedHostExtension>()
  readonly #mountedHostUi = new Map<ExtensionId, MountedHostUiExtension>()
  readonly #diagnostics = new Map<ExtensionId, ExtensionRuntimeDiagnostic>()
  readonly #transitions = new Map<ExtensionId, Promise<void>>()
  readonly #adapterTransitions = new Map<string, Promise<void>>()
  #disposed = false

  constructor(
    repository: ExtensionRepository & HostUiRepository,
    service: RevisionSourceResolver,
    builder: ArtifactBuilder,
    host: HostExtensionInstallationHost,
    options: { readonly now?: () => number } = {},
  ) {
    this.#repository = repository
    this.#hostUiRepository = repository
    this.#service = service
    this.#builder = builder
    this.#host = host
    this.#now = options.now ?? Date.now
  }

  async install(input: {
    readonly extensionId: ExtensionId
    readonly revisionId: ExtensionRevisionId
    readonly permissionApproval?: { readonly permissionDigest: string }
  }): Promise<HostInstallation> {
    return this.#exclusive(input.extensionId, async () => {
      this.#assertAvailable()
      const revision = this.#requireRevision(input.extensionId, input.revisionId)
      const scope = this.#repository.getExtension(input.extensionId)?.scope
      if (scope === 'host-ui') return this.#installHostUi(input, revision)
      if (scope !== 'host-adapter') throw new Error('只有 Host UI 或适配器扩展可以安装到本机。')
      const verification = this.#repository.getExtensionRevisionVerification(revision.id)
      if (verification?.scope !== 'host-adapter' || !verification.adapter) {
        throw new Error('Host 安装只接受完成适配器验证的 Extension Revision。')
      }
      const adapterPages = verification.renderedPages ?? []
      const permissionRequirement =
        adapterPages.length > 0 ? this.getHostUiPermissionRequirement(input.extensionId, revision.id) : undefined
      if (
        adapterPages.length > 0 &&
        permissionRequirement?.approvalRequired &&
        input.permissionApproval?.permissionDigest !== permissionRequirement.permissionDigest
      ) {
        throw new Error(`permission-approval-required:${permissionRequirement.permissionDigest}`)
      }
      const existing = this.#repository.getHostInstallation(input.extensionId)
      if (existing?.extensionRevisionId === revision.id && this.#mounted.has(input.extensionId)) return existing
      const artifact = await this.#build(revision)
      if (!artifact.hostEntry) throw new Error('适配器 Extension Revision 缺少 Host 构建产物。')
      if (adapterPages.length > 0 && !artifact.clientEntry) {
        throw new Error('带页面入口的适配器扩展缺少 Client 构建产物。')
      }
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
          if (adapterPages.length > 0 && permissionRequirement) {
            this.#hostUiRepository.commitHostInstallationState({
              installation,
              hostUi: {
                grant: {
                  ownerKey: extensionOwnerKey(input.extensionId),
                  artifactDigest: revision.payloadDigest,
                  permissionDigest: permissionRequirement.permissionDigest,
                  declaration: permissionRequirement.declaration,
                  approvedAt: installedAt,
                },
                pages: adapterPages,
                clientBuildKey: artifact.buildKey,
                now: installedAt,
                nextPageInstanceId: () => HostUiPageInstanceIdSchema.parse(`hup_${randomUUID().replaceAll('-', '')}`),
              },
            })
          } else this.#hostUiRepository.commitHostInstallationState({ installation })
        } catch (error) {
          const disposeError = await mounted.dispose().then(
            () => undefined,
            (failure: unknown) => failure,
          )
          await this.#restorePrevious(input.extensionId, previousRevision, previousArtifact, error)
          if (disposeError !== undefined) {
            throw new AggregateError([error, disposeError], 'Host Extension 提交失败，且候选 Runtime 未完整静止。')
          }
          throw error
        }
        this.#mounted.set(input.extensionId, mounted)
        this.#diagnostics.set(input.extensionId, { status: 'active', observedAt: this.#timestamp() })
        return installation
      })
    })
  }

  getHostUiPermissionRequirement(extensionId: ExtensionId, revisionId: ExtensionRevisionId) {
    const revision = this.#requireRevision(extensionId, revisionId)
    const extension = this.#repository.getExtension(extensionId)
    if (extension?.scope !== 'host-ui' && extension?.scope !== 'host-adapter') return undefined
    const verification = this.#repository.getExtensionRevisionVerification(revision.id)
    const declaration = canonicalPermissionDeclaration(
      verification?.permissions ?? {
        permissions: [],
        networkOrigins: [],
      },
    )
    const permissionDigest = hostUiPermissionDigest(declaration)
    const current = this.#hostUiRepository.getHostUiPermissionGrant(extensionOwnerKey(extensionId))
    const currentPermissions = new Set(current?.declaration.permissions ?? [])
    const currentOrigins = new Set(current?.declaration.networkOrigins ?? [])
    const expandsGrant =
      declaration.permissions.some((permission) => !currentPermissions.has(permission)) ||
      declaration.networkOrigins.some((origin) => !currentOrigins.has(origin))
    return {
      declaration,
      permissionDigest,
      approvalRequired:
        declaration.permissions.length > 0 || declaration.networkOrigins.length > 0
          ? current === undefined || expandsGrant
          : false,
    }
  }

  async callHostUi(extensionId: ExtensionId, method: string, input: JsonValue): Promise<JsonValue> {
    const mounted = this.#mountedHostUi.get(extensionId)
    if (!mounted) throw new Error('页面 Host Runtime 当前不可用。')
    return mounted.call(method, input)
  }

  async #installHostUi(
    input: {
      readonly extensionId: ExtensionId
      readonly revisionId: ExtensionRevisionId
      readonly permissionApproval?: { readonly permissionDigest: string }
    },
    revision: Revision,
  ): Promise<HostInstallation> {
    const verification = this.#repository.getExtensionRevisionVerification(revision.id)
    if (verification?.scope !== 'host-ui' || verification.contractVersion !== 'nekro-nxt-extension-v3') {
      throw new Error('Host UI 安装只接受在当前 Host 完成页面验证的扩展版本。')
    }
    const pages = verification.renderedPages ?? []
    if (pages.length === 0 || pages.length > 8) throw new Error('Host UI 扩展必须声明 1 到 8 个页面入口。')
    const requirement = this.getHostUiPermissionRequirement(input.extensionId, revision.id)
    if (!requirement) throw new Error('无法读取 Host UI 权限声明。')
    if (requirement.approvalRequired && input.permissionApproval?.permissionDigest !== requirement.permissionDigest) {
      throw new Error(`permission-approval-required:${requirement.permissionDigest}`)
    }
    const existing = this.#repository.getHostInstallation(input.extensionId)
    if (existing?.extensionRevisionId === revision.id && this.#mountedHostUi.has(input.extensionId)) return existing
    const artifact = await this.#build(revision)
    if (!artifact.clientEntry) throw new Error('Host UI 扩展缺少 Client 构建产物。')
    if (!this.#host.mountHostUi) throw new Error('当前宿主未提供 Host UI Runtime。')
    const previousRevision = existing
      ? this.#requireRevision(existing.extensionId, existing.extensionRevisionId)
      : undefined
    const previousArtifact = previousRevision ? await this.#build(previousRevision) : undefined
    const previousMounted = this.#mountedHostUi.get(input.extensionId)
    if (previousMounted) {
      await previousMounted.dispose()
      this.#mountedHostUi.delete(input.extensionId)
    }

    let mounted: MountedHostUiExtension
    try {
      mounted = await this.#host.mountHostUi(revision, artifact)
    } catch (error) {
      await this.#restorePreviousHostUi(input.extensionId, previousRevision, previousArtifact, error)
      throw error
    }
    const installedAt = this.#timestamp()
    const installation: HostInstallation = {
      extensionId: input.extensionId,
      extensionRevisionId: revision.id,
      installedAt,
    }
    const grant: HostUiPermissionGrant = {
      ownerKey: extensionOwnerKey(input.extensionId),
      artifactDigest: revision.payloadDigest,
      permissionDigest: requirement.permissionDigest,
      declaration: requirement.declaration,
      approvedAt: installedAt,
    }
    try {
      this.#hostUiRepository.commitHostInstallationState({
        installation,
        hostUi: {
          grant,
          pages,
          clientBuildKey: artifact.buildKey,
          now: installedAt,
          nextPageInstanceId: () => HostUiPageInstanceIdSchema.parse(`hup_${randomUUID().replaceAll('-', '')}`),
        },
      })
    } catch (error) {
      const disposeError = await mounted.dispose().then(
        () => undefined,
        (failure: unknown) => failure,
      )
      await this.#restorePreviousHostUi(input.extensionId, previousRevision, previousArtifact, error)
      if (disposeError !== undefined) {
        throw new AggregateError([error, disposeError], 'Host UI 提交失败，且候选 Runtime 未完整静止。')
      }
      throw error
    }
    this.#mountedHostUi.set(input.extensionId, mounted)
    this.#diagnostics.set(input.extensionId, { status: 'active', observedAt: this.#timestamp() })
    return installation
  }

  async restore(): Promise<{ readonly restored: number; readonly failed: number }> {
    this.#assertAvailable()
    const outcomes = await Promise.all(
      this.#repository.listHostInstallations().map(async (installation) => {
        try {
          return await this.#exclusive(installation.extensionId, async () => {
            this.#assertAvailable()
            if (this.#mounted.has(installation.extensionId) || this.#mountedHostUi.has(installation.extensionId)) {
              return 'skipped' as const
            }
            const revision = this.#requireRevision(installation.extensionId, installation.extensionRevisionId)
            if (this.#repository.getExtension(installation.extensionId)?.scope === 'host-ui') {
              await this.#restoreHostUiInstallation(installation.extensionId, revision)
              return 'restored' as const
            }
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
              try {
                if (mounted.adapterKey !== expectedKey) {
                  throw new Error('适配器 Host 实际注册的 key 与验证证据不一致。')
                }
                if ((verification.renderedPages ?? []).length > 0) {
                  if (!artifact.clientEntry) throw new Error('带页面入口的适配器扩展缺少 Client 构建产物。')
                  const requirement = this.getHostUiPermissionRequirement(installation.extensionId, revision.id)
                  const grant = this.#hostUiRepository.getHostUiPermissionGrant(
                    extensionOwnerKey(installation.extensionId),
                  )
                  if (
                    !requirement ||
                    grant?.artifactDigest !== revision.payloadDigest ||
                    grant.permissionDigest !== requirement.permissionDigest
                  ) {
                    throw new Error('permission-approval-required')
                  }
                  this.#hostUiRepository.replaceHostUiExtensionPages({
                    extensionId: installation.extensionId,
                    revisionId: revision.id,
                    pages: verification.renderedPages ?? [],
                    clientBuildKey: artifact.buildKey,
                    now: this.#timestamp(),
                    nextPageInstanceId: () =>
                      HostUiPageInstanceIdSchema.parse(`hup_${randomUUID().replaceAll('-', '')}`),
                  })
                }
              } catch (error) {
                try {
                  await mounted.dispose()
                } catch (disposeError) {
                  throw new AggregateError([error, disposeError], '适配器恢复失败，且候选 Runtime 未完整静止。')
                }
                throw error
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
      if (this.#repository.getExtension(extensionId)?.scope === 'host-ui') {
        await this.#uninstallHostUi(extensionId, installation)
        return
      }
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
          this.#hostUiRepository.deleteHostInstallationState({ extensionId, now: this.#timestamp() })
        } catch (error) {
          if (mounted) await this.#restorePrevious(extensionId, revision, artifact, error)
          throw error
        }
        this.#diagnostics.delete(extensionId)
      })
    })
  }

  async #restoreHostUiInstallation(extensionId: ExtensionId, revision: Revision): Promise<void> {
    const verification = this.#repository.getExtensionRevisionVerification(revision.id)
    if (verification?.scope !== 'host-ui' || verification.contractVersion !== 'nekro-nxt-extension-v3') {
      throw new Error('已安装扩展缺少可恢复的 Host UI 验证证据。')
    }
    const pages = verification.renderedPages ?? []
    if (pages.length === 0 || pages.length > 8) throw new Error('已安装 Host UI 页面入口无效。')
    const requirement = this.getHostUiPermissionRequirement(extensionId, revision.id)
    const grant = this.#hostUiRepository.getHostUiPermissionGrant(extensionOwnerKey(extensionId))
    if (
      !requirement ||
      grant?.artifactDigest !== revision.payloadDigest ||
      grant.permissionDigest !== requirement.permissionDigest
    ) {
      throw new Error('permission-approval-required')
    }
    if (!this.#host.mountHostUi) throw new Error('当前宿主未提供 Host UI Runtime。')
    const artifact = await this.#build(revision)
    if (!artifact.clientEntry) throw new Error('Host UI 扩展缺少 Client 构建产物。')
    const mounted = await this.#host.mountHostUi(revision, artifact)
    try {
      this.#hostUiRepository.replaceHostUiExtensionPages({
        extensionId,
        revisionId: revision.id,
        pages,
        clientBuildKey: artifact.buildKey,
        now: this.#timestamp(),
        nextPageInstanceId: () => HostUiPageInstanceIdSchema.parse(`hup_${randomUUID().replaceAll('-', '')}`),
      })
    } catch (error) {
      try {
        await mounted.dispose()
      } catch (disposeError) {
        throw new AggregateError([error, disposeError], 'Host UI 恢复失败，且候选 Runtime 未完整静止。')
      }
      throw error
    }
    this.#mountedHostUi.set(extensionId, mounted)
    this.#diagnostics.set(extensionId, { status: 'active', observedAt: this.#timestamp() })
  }

  async #uninstallHostUi(extensionId: ExtensionId, installation: HostInstallation): Promise<void> {
    const mounted = this.#mountedHostUi.get(extensionId)
    const revision = this.#requireRevision(extensionId, installation.extensionRevisionId)
    const artifact = await this.#build(revision)
    if (mounted) {
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
      this.#mountedHostUi.delete(extensionId)
    }
    try {
      this.#hostUiRepository.deleteHostInstallationState({ extensionId, now: this.#timestamp() })
    } catch (error) {
      await this.#restorePreviousHostUi(extensionId, revision, artifact, error)
      throw error
    }
    this.#diagnostics.delete(extensionId)
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
    const mountedHostUi = [...this.#mountedHostUi.values()]
    this.#mountedHostUi.clear()
    const outcomes = await Promise.allSettled([...mounted, ...mountedHostUi].map((entry) => entry.dispose()))
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

  async #restorePreviousHostUi(
    extensionId: ExtensionId,
    revision: Revision | undefined,
    artifact: ExtensionBuildArtifact | undefined,
    originalError: unknown,
  ): Promise<void> {
    if (!revision || !artifact || !this.#host.mountHostUi) return
    try {
      this.#mountedHostUi.set(extensionId, await this.#host.mountHostUi(revision, artifact))
    } catch (restoreError) {
      throw new AggregateError([originalError, restoreError], 'Host UI 变更失败，且原扩展版本无法恢复。')
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
