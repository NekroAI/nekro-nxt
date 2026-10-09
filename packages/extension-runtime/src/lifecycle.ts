import type { ExtensionCompatibilityIdentity, ExtensionCompatibilityPort } from './compatibility.js'
import {
  HostUiPageInstanceIdSchema,
  type AgentId,
  type ExtensionId,
  type ExtensionRevisionId,
  type JsonValue,
} from '@nekro-nxt/contracts'
import {
  hasAgentLayer,
  LEGACY_EXTENSION_MESSAGE,
  manifestAdapter,
  type ExtensionManifest,
} from '@nekro-nxt/extension-format'
import { randomUUID } from 'node:crypto'
import type { ExtensionBuilder } from './builder.js'
import {
  activationOwnerKey,
  agentPermissionRequirement,
  carryExtensionConfig,
  extensionOwnerKey,
  hostPermissionRequirement,
  permissionApprovalError,
  resolveExtensionConfig,
  type PermissionRequirement,
} from './permissions.js'
import type { ExtensionService } from './service.js'
import type {
  Activation,
  ExtensionActivationTransition,
  ExtensionBuildArtifact,
  ExtensionRepository,
  ExtensionRuntimeDiagnostic,
  HostInstallation,
  HostUiPermissionGrant,
  HostUiRepository,
  Revision,
} from './types.js'

/** Where an RPC call comes from; panel anchors are checked by the Host before the call reaches the extension. */
export type ExtensionCaller =
  | { readonly surface: 'page' }
  | {
      readonly surface: 'panel'
      readonly anchor: { readonly kind: 'agent' | 'channel' | 'extension' | 'connection'; readonly id: string }
      readonly agentId?: string
      readonly channelId?: string
      readonly connectionId?: string
    }
  | { readonly surface: 'verification' }

export interface MountedAttachment {
  dispose(): Promise<void>
}

/** The live host instance of one installed Extension: its factory ran once and its adapter, if any, is registered. */
export interface LoadedExtension {
  readonly adapterKey?: string
  /** Mounts the agent attachment in every live and future Session of the agent. */
  attach(agentId: AgentId, config: JsonValue): Promise<MountedAttachment>
  call(method: string, input: JsonValue, caller: ExtensionCaller): Promise<JsonValue>
  /** Disposes the host instance; attachments are disposed by the coordinator first. */
  dispose(): Promise<void>
}

/** What the Server composition root provides: running factories, Sessions, adapters and safe gaps. */
export interface ExtensionRuntimeHost {
  load(input: {
    readonly revision: Revision
    readonly manifest: ExtensionManifest
    readonly artifact: ExtensionBuildArtifact
    readonly config: JsonValue
  }): Promise<LoadedExtension>
  waitUntilAgentSafe(agentId: AgentId): Promise<void>
  waitUntilAdapterSafe(adapterKey: string): Promise<void>
  assertAdapterKeyAvailable(adapterKey: string, extensionId: ExtensionId): Promise<void>
}

type ArtifactBuilder = Pick<ExtensionBuilder, 'build'>
type RevisionSourceResolver = Pick<ExtensionService, 'revisionSourceDirectory' | 'revisionManifest'>

interface LiveAttachment {
  readonly config: JsonValue
  readonly mounted: MountedAttachment
}

interface LiveExtension {
  readonly revision: Revision
  readonly manifest: ExtensionManifest
  readonly artifact: ExtensionBuildArtifact
  readonly config: JsonValue
  readonly loaded: LoadedExtension
  readonly attachments: Map<AgentId, LiveAttachment>
}

/** A running state to restore when a switch fails. */
interface Snapshot {
  readonly revision: Revision
  readonly manifest: ExtensionManifest
  readonly artifact: ExtensionBuildArtifact
  readonly config: JsonValue
  readonly attachments: readonly { readonly agentId: AgentId; readonly config: JsonValue }[]
}

const nextPageInstanceId = () => HostUiPageInstanceIdSchema.parse(`hup_${randomUUID().replaceAll('-', '')}`)

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * Owns install, enable, switch, configuration and removal of Extensions (扩展形态统一 §6). One Extension has one host
 * instance per machine and at most one attachment per agent, all on the installed Revision. A switch stops every
 * attachment and the instance at their safe gaps, loads the new Revision and re-attaches; any failure restores the
 * previous Revision and leaves the database unchanged.
 */
export class ExtensionLifecycleCoordinator {
  readonly #repository: ExtensionRepository & HostUiRepository
  readonly #service: RevisionSourceResolver
  readonly #builder: ArtifactBuilder
  readonly #host: ExtensionRuntimeHost
  readonly #compatibility: ExtensionCompatibilityPort | undefined
  readonly #now: () => number
  readonly #live = new Map<ExtensionId, LiveExtension>()
  readonly #diagnostics = new Map<ExtensionId, ExtensionRuntimeDiagnostic>()
  readonly #attachmentDiagnostics = new Map<string, ExtensionRuntimeDiagnostic>()
  readonly #locks = new Map<ExtensionId, Promise<void>>()
  readonly #requests = new Map<string, ExtensionActivationTransition>()
  #disposed = false
  #disposePromise: Promise<void> | undefined

  constructor(
    repository: ExtensionRepository & HostUiRepository,
    service: RevisionSourceResolver,
    builder: ArtifactBuilder,
    host: ExtensionRuntimeHost,
    options: { readonly now?: () => number; readonly compatibility?: ExtensionCompatibilityPort } = {},
  ) {
    this.#repository = repository
    this.#service = service
    this.#builder = builder
    this.#host = host
    this.#now = options.now ?? Date.now
    this.#compatibility = options.compatibility
  }

  // —— Requirements ——

  /** What installing (or switching to) this Revision asks the user to approve for the machine. */
  hostRequirement(extensionId: ExtensionId, revisionId: ExtensionRevisionId): PermissionRequirement {
    const { manifest } = this.#current(extensionId, revisionId)
    return hostPermissionRequirement(
      manifest,
      this.#repository.getHostUiPermissionGrant(extensionOwnerKey(extensionId)),
    )
  }

  /** What enabling this Revision for the agent asks the user to approve. */
  agentRequirement(agentId: AgentId, extensionId: ExtensionId, revisionId: ExtensionRevisionId): PermissionRequirement {
    const { manifest } = this.#current(extensionId, revisionId)
    return agentPermissionRequirement(
      manifest,
      this.#repository.getHostUiPermissionGrant(activationOwnerKey(agentId, extensionId)),
    )
  }

  /**
   * What switching the installation to this Revision asks the agents it is enabled for to approve again. The
   * declaration is the same for every agent, so one approval covers all of them; `undefined` when none expands.
   */
  switchAgentRequirement(extensionId: ExtensionId, revisionId: ExtensionRevisionId): PermissionRequirement | undefined {
    const { manifest } = this.#current(extensionId, revisionId)
    return this.#repository
      .listActivations()
      .filter((activation) => activation.extensionId === extensionId)
      .map((activation) =>
        agentPermissionRequirement(
          manifest,
          this.#repository.getHostUiPermissionGrant(activationOwnerKey(activation.agentId, extensionId)),
        ),
      )
      .find((requirement) => requirement.approvalRequired)
  }

  // —— Installation ——

  /**
   * Installs the Revision on this machine, or switches the installation to it. Agents already using the Extension move
   * with it; their configuration is carried when still valid for the new Revision.
   */
  async install(input: {
    readonly extensionId: ExtensionId
    readonly revisionId: ExtensionRevisionId
    readonly config?: JsonValue
    readonly permissionApproval?: { readonly permissionDigest: string }
    readonly agentPermissionApproval?: { readonly permissionDigest: string }
  }): Promise<HostInstallation> {
    return this.#exclusive(input.extensionId, () => this.#install(input))
  }

  async #install(input: Parameters<ExtensionLifecycleCoordinator['install']>[0]): Promise<HostInstallation> {
    this.#assertAvailable()
    const { revision, manifest } = this.#current(input.extensionId, input.revisionId)
    this.#assertVerified(revision)
    const hostRequirement = hostPermissionRequirement(
      manifest,
      this.#repository.getHostUiPermissionGrant(extensionOwnerKey(input.extensionId)),
    )
    if (
      hostRequirement.approvalRequired &&
      input.permissionApproval?.permissionDigest !== hostRequirement.permissionDigest
    ) {
      throw permissionApprovalError(hostRequirement)
    }
    const existing = this.#repository.getHostInstallation(input.extensionId)
    const live = this.#live.get(input.extensionId)
    if (existing?.extensionRevisionId === revision.id && live && input.config === undefined) return existing

    const activations = this.#repository.listActivations().filter((entry) => entry.extensionId === input.extensionId)
    if (activations.length > 0 && !hasAgentLayer(manifest)) {
      throw new Error('这份保存记录没有智能体能力，请先给正在使用它的智能体停用这个扩展。')
    }
    const agentGrants = activations.map((activation) => {
      const requirement = agentPermissionRequirement(
        manifest,
        this.#repository.getHostUiPermissionGrant(activationOwnerKey(activation.agentId, input.extensionId)),
      )
      if (
        requirement.approvalRequired &&
        input.agentPermissionApproval?.permissionDigest !== requirement.permissionDigest
      ) {
        throw permissionApprovalError(requirement)
      }
      return { activation, requirement }
    })

    const config =
      input.config === undefined
        ? carryExtensionConfig(manifest, 'host', existing?.config)
        : resolveExtensionConfig(manifest, 'host', input.config)
    const attachments = activations.map((activation) => ({
      agentId: activation.agentId,
      config: carryExtensionConfig(manifest, 'agent', activation.config),
    }))
    const artifact = await this.#build(revision)
    const adapterKey = manifestAdapter(manifest)?.key
    if (adapterKey !== undefined) await this.#host.assertAdapterKeyAvailable(adapterKey, input.extensionId)
    const previous = live === undefined ? undefined : this.#snapshot(live)

    await this.#stop(input.extensionId, live)
    let next: LiveExtension
    try {
      next = await this.#start({ revision, manifest, artifact, config, attachments })
    } catch (error) {
      await this.#restore(input.extensionId, previous, error)
      throw error
    }

    const now = this.#timestamp()
    const installation: HostInstallation = {
      extensionId: input.extensionId,
      extensionRevisionId: revision.id,
      installedAt: existing?.extensionRevisionId === revision.id ? existing.installedAt : now,
      config,
    }
    try {
      this.#repository.commitHostInstallationState({
        installation,
        hostUi: {
          grant: this.#grant(extensionOwnerKey(input.extensionId), revision, hostRequirement, now),
          pages: this.#pages(revision),
          clientBuildKey: artifact.buildKey,
          now,
          nextPageInstanceId,
        },
        attachments: agentGrants.map(({ activation, requirement }) => ({
          activation: {
            ...activation,
            extensionRevisionId: revision.id,
            config: attachments.find((entry) => entry.agentId === activation.agentId)?.config ?? activation.config,
          },
          grant: this.#grant(activationOwnerKey(activation.agentId, input.extensionId), revision, requirement, now),
        })),
      })
    } catch (error) {
      await this.#stop(input.extensionId, next).catch(() => undefined)
      await this.#restore(input.extensionId, previous, error)
      throw error
    }
    this.#live.set(input.extensionId, next)
    this.#diagnostics.set(input.extensionId, { status: 'active', observedAt: this.#timestamp() })
    this.#compatibility?.record(this.#instanceIdentity(installation), {
      status: 'compatible',
      phase: 'restore',
      retryable: true,
    })
    return installation
  }

  /** Applies a new host configuration by reloading the host instance and re-attaching its agents. */
  async updateHostConfig(extensionId: ExtensionId, value: JsonValue): Promise<HostInstallation> {
    const installation = this.#repository.getHostInstallation(extensionId)
    if (!installation) throw new Error('这个扩展尚未安装到本机。')
    return this.install({ extensionId, revisionId: installation.extensionRevisionId, config: value })
  }

  /** Stops every attachment and the host instance, then removes the installation and its agent attachments. */
  async uninstall(extensionId: ExtensionId): Promise<void> {
    await this.#exclusive(extensionId, async () => {
      this.#assertAvailable()
      const installation = this.#repository.getHostInstallation(extensionId)
      if (!installation) throw new Error('这个扩展尚未安装到本机。')
      const live = this.#live.get(extensionId)
      const previous = live === undefined ? undefined : this.#snapshot(live)
      await this.#stop(extensionId, live)
      const activations = this.#repository.listActivations().filter((entry) => entry.extensionId === extensionId)
      try {
        for (const activation of activations) this.#repository.deleteActivation(activation.agentId, extensionId)
        this.#repository.deleteHostInstallationState({ extensionId, now: this.#timestamp() })
      } catch (error) {
        await this.#restore(extensionId, previous, error)
        throw error
      }
      for (const activation of activations) {
        this.#repository.deleteHostUiPermissionGrant(activationOwnerKey(activation.agentId, extensionId))
        this.#attachmentDiagnostics.delete(this.#agentKey(activation.agentId, extensionId))
      }
      this.#diagnostics.delete(extensionId)
    })
  }

  // —— Agent attachments ——

  /**
   * Enables the Extension for an agent. An Extension not yet on this machine is installed first from `revisionId`;
   * a different `revisionId` switches the installation (and every agent using it) to that Revision.
   */
  async activate(input: {
    readonly agentId: AgentId
    readonly extensionId: ExtensionId
    readonly revisionId: ExtensionRevisionId
    readonly config?: JsonValue
    readonly permissionApproval?: { readonly permissionDigest: string }
    readonly hostPermissionApproval?: { readonly permissionDigest: string }
  }): Promise<Activation> {
    const key = this.#agentKey(input.agentId, input.extensionId)
    return this.#tracked(
      key,
      {
        agentId: input.agentId,
        extensionId: input.extensionId,
        target: 'enabled',
        extensionRevisionId: input.revisionId,
      },
      () =>
        this.#exclusive(input.extensionId, async () => {
          this.#assertAvailable()
          const { manifest } = this.#current(input.extensionId, input.revisionId)
          if (!hasAgentLayer(manifest)) throw new Error('这个扩展没有智能体能力，安装到本机即可使用。')
          const installation = this.#repository.getHostInstallation(input.extensionId)
          if (installation?.extensionRevisionId !== input.revisionId || !this.#live.has(input.extensionId)) {
            await this.#install({
              extensionId: input.extensionId,
              revisionId: input.revisionId,
              ...(input.hostPermissionApproval === undefined
                ? {}
                : { permissionApproval: input.hostPermissionApproval }),
              ...(input.permissionApproval === undefined ? {} : { agentPermissionApproval: input.permissionApproval }),
            })
          }
          return this.#attach(input, manifest)
        }),
    )
  }

  async #attach(
    input: Parameters<ExtensionLifecycleCoordinator['activate']>[0],
    manifest: ExtensionManifest,
  ): Promise<Activation> {
    const live = this.#requireLive(input.extensionId)
    const requirement = agentPermissionRequirement(
      manifest,
      this.#repository.getHostUiPermissionGrant(activationOwnerKey(input.agentId, input.extensionId)),
    )
    if (requirement.approvalRequired && input.permissionApproval?.permissionDigest !== requirement.permissionDigest) {
      throw permissionApprovalError(requirement)
    }
    const previous = this.#repository.getActivation(input.agentId, input.extensionId)
    const config =
      input.config === undefined
        ? carryExtensionConfig(manifest, 'agent', previous?.config)
        : resolveExtensionConfig(manifest, 'agent', input.config)
    const current = live.attachments.get(input.agentId)
    await this.#host.waitUntilAgentSafe(input.agentId)
    if (current) {
      await current.mounted.dispose()
      live.attachments.delete(input.agentId)
    }
    const restorePrevious = async (error: unknown) => {
      if (!current) return
      try {
        live.attachments.set(input.agentId, {
          config: current.config,
          mounted: await live.loaded.attach(input.agentId, current.config),
        })
      } catch (restoreError) {
        throw new AggregateError([error, restoreError], '启用扩展失败，且原挂载无法恢复。')
      }
    }
    let mounted: MountedAttachment
    try {
      mounted = await live.loaded.attach(input.agentId, config)
    } catch (error) {
      await restorePrevious(error)
      throw error
    }
    const now = this.#timestamp()
    const activation: Activation = {
      agentId: input.agentId,
      extensionId: input.extensionId,
      extensionRevisionId: live.revision.id,
      config,
      activatedAt: previous?.activatedAt ?? now,
    }
    try {
      this.#repository.upsertActivation(activation)
      this.#repository.upsertHostUiPermissionGrant(
        this.#grant(activationOwnerKey(input.agentId, input.extensionId), live.revision, requirement, now),
      )
    } catch (error) {
      await mounted.dispose().catch(() => undefined)
      await restorePrevious(error)
      throw error
    }
    live.attachments.set(input.agentId, { config, mounted })
    const key = this.#agentKey(input.agentId, input.extensionId)
    this.#attachmentDiagnostics.set(key, { status: 'active', observedAt: this.#timestamp() })
    this.#compatibility?.record(this.#attachmentIdentity(activation), {
      status: 'compatible',
      phase: 'restore',
      retryable: true,
    })
    return activation
  }

  /** Applies a new agent configuration by re-attaching the agent at its next safe gap. */
  async updateAgentConfig(agentId: AgentId, extensionId: ExtensionId, value: JsonValue): Promise<Activation> {
    const activation = this.#repository.getActivation(agentId, extensionId)
    if (!activation) throw new Error('这个扩展尚未启用给该智能体。')
    return this.activate({ agentId, extensionId, revisionId: activation.extensionRevisionId, config: value })
  }

  async disable(agentId: AgentId, extensionId: ExtensionId): Promise<void> {
    const key = this.#agentKey(agentId, extensionId)
    await this.#tracked(key, { agentId, extensionId, target: 'disabled' }, () =>
      this.#exclusive(extensionId, async () => {
        this.#assertAvailable()
        const activation = this.#repository.getActivation(agentId, extensionId)
        if (!activation) throw new Error('这个扩展尚未启用给该智能体。')
        const live = this.#live.get(extensionId)
        const current = live?.attachments.get(agentId)
        if (live && current) {
          await this.#host.waitUntilAgentSafe(agentId)
          try {
            await current.mounted.dispose()
          } catch (error) {
            this.#attachmentDiagnostics.set(key, {
              status: 'dispose-failed',
              message: message(error),
              observedAt: this.#timestamp(),
            })
            throw error
          }
          live.attachments.delete(agentId)
        }
        try {
          this.#repository.deleteActivation(agentId, extensionId)
        } catch (error) {
          if (live && current) {
            live.attachments.set(agentId, {
              config: current.config,
              mounted: await live.loaded.attach(agentId, current.config),
            })
          }
          throw error
        }
        this.#repository.deleteHostUiPermissionGrant(activationOwnerKey(agentId, extensionId))
        this.#attachmentDiagnostics.delete(key)
      }),
    )
  }

  // —— Calls ——

  async call(extensionId: ExtensionId, method: string, input: JsonValue, caller: ExtensionCaller): Promise<JsonValue> {
    const live = this.#live.get(extensionId)
    if (!live) throw new Error('这个扩展当前没有在本机运行。')
    return live.loaded.call(method, input, caller)
  }

  /** The installed Revision whose host instance is live, if any. */
  liveRevision(extensionId: ExtensionId): Revision | undefined {
    return this.#live.get(extensionId)?.revision
  }

  isAttached(agentId: AgentId, extensionId: ExtensionId): boolean {
    return this.#live.get(extensionId)?.attachments.has(agentId) === true
  }

  // —— Restore ——

  /** Loads the host instance of every committed installation (adapters register here, before connections mount). */
  async restoreInstances(
    retry = false,
    extensionId?: ExtensionId,
  ): Promise<{ readonly restored: number; readonly failed: number }> {
    this.#assertAvailable()
    let restored = 0
    let failed = 0
    for (const installation of this.#repository.listHostInstallations()) {
      if (extensionId !== undefined && installation.extensionId !== extensionId) continue
      const identity = this.#instanceIdentity(installation)
      try {
        const previous = this.#compatibility?.read(identity)
        if (!retry && previous?.status === 'isolated') throw new Error(previous.reason ?? '扩展等待兼容性修复。')
        const loaded = await this.#exclusive(installation.extensionId, async () => {
          this.#assertAvailable()
          if (this.#live.has(installation.extensionId)) return false
          const { revision, manifest } = this.#current(installation.extensionId, installation.extensionRevisionId)
          this.#assertVerified(revision)
          const requirement = hostPermissionRequirement(
            manifest,
            this.#repository.getHostUiPermissionGrant(extensionOwnerKey(installation.extensionId)),
          )
          if (requirement.approvalRequired) throw new Error('permission-approval-required')
          const artifact = await this.#build(revision)
          const adapterKey = manifestAdapter(manifest)?.key
          if (adapterKey !== undefined) await this.#host.assertAdapterKeyAvailable(adapterKey, installation.extensionId)
          const live = await this.#start({ revision, manifest, artifact, config: installation.config, attachments: [] })
          try {
            this.#repository.replaceHostUiExtensionPages({
              extensionId: installation.extensionId,
              revisionId: revision.id,
              pages: this.#pages(revision),
              clientBuildKey: artifact.buildKey,
              now: this.#timestamp(),
              nextPageInstanceId,
            })
          } catch (error) {
            await this.#stop(installation.extensionId, live).catch(() => undefined)
            throw error
          }
          this.#live.set(installation.extensionId, live)
          this.#diagnostics.set(installation.extensionId, { status: 'active', observedAt: this.#timestamp() })
          return true
        })
        if (loaded) restored += 1
        this.#compatibility?.record(identity, { status: 'compatible', phase: 'restore', retryable: true })
      } catch (error) {
        if (error instanceof AggregateError) throw error
        this.#compatibility?.record(identity, {
          status: 'isolated',
          phase: 'restore',
          retryable: true,
          reason: message(error).slice(0, 2048),
        })
        this.#diagnostics.set(installation.extensionId, {
          status: 'restore-failed',
          message: message(error),
          observedAt: this.#timestamp(),
        })
        failed += 1
      }
    }
    return { restored, failed }
  }

  /** Attaches every committed agent attachment whose host instance is live. */
  async restoreAttachments(
    retry = false,
    extensionId?: ExtensionId,
  ): Promise<{ readonly restored: number; readonly failed: number }> {
    this.#assertAvailable()
    let restored = 0
    let failed = 0
    for (const activation of this.#repository.listActivations()) {
      if (extensionId !== undefined && activation.extensionId !== extensionId) continue
      const key = this.#agentKey(activation.agentId, activation.extensionId)
      const identity = this.#attachmentIdentity(activation)
      try {
        const previous = this.#compatibility?.read(identity)
        if (!retry && previous?.status === 'isolated') throw new Error(previous.reason ?? '扩展等待兼容性修复。')
        const attached = await this.#exclusive(activation.extensionId, async () => {
          this.#assertAvailable()
          const live = this.#live.get(activation.extensionId)
          if (!live) {
            throw new Error(
              this.#diagnostics.get(activation.extensionId)?.message ??
                '这个扩展的本机实例没有运行，无法给智能体挂载。',
            )
          }
          if (live.attachments.has(activation.agentId)) return false
          if (live.revision.id !== activation.extensionRevisionId) {
            throw new Error('智能体使用的保存记录与本机安装不一致。')
          }
          const requirement = agentPermissionRequirement(
            live.manifest,
            this.#repository.getHostUiPermissionGrant(activationOwnerKey(activation.agentId, activation.extensionId)),
          )
          if (requirement.approvalRequired) throw new Error('permission-approval-required')
          live.attachments.set(activation.agentId, {
            config: activation.config,
            mounted: await live.loaded.attach(activation.agentId, activation.config),
          })
          this.#attachmentDiagnostics.set(key, { status: 'active', observedAt: this.#timestamp() })
          return true
        })
        if (attached) restored += 1
        this.#compatibility?.record(identity, { status: 'compatible', phase: 'restore', retryable: true })
      } catch (error) {
        if (error instanceof AggregateError) throw error
        this.#compatibility?.record(identity, {
          status: 'isolated',
          phase: 'restore',
          retryable: true,
          reason: message(error).slice(0, 2048),
        })
        this.#attachmentDiagnostics.set(key, {
          status: 'restore-failed',
          message: message(error),
          observedAt: this.#timestamp(),
        })
        failed += 1
      }
    }
    return { restored, failed }
  }

  // —— Diagnostics ——

  getDiagnostic(extensionId: ExtensionId): ExtensionRuntimeDiagnostic | undefined {
    return this.#diagnostics.get(extensionId)
  }

  getAttachmentDiagnostic(agentId: AgentId, extensionId: ExtensionId): ExtensionRuntimeDiagnostic | undefined {
    return this.#attachmentDiagnostics.get(this.#agentKey(agentId, extensionId))
  }

  /** Enable or disable requests of this Extension that are still waiting for a safe gap or failed last time. */
  listTransitions(extensionId: ExtensionId): readonly ExtensionActivationTransition[] {
    return [...this.#requests.values()].filter((request) => request.extensionId === extensionId)
  }

  getTransition(agentId: AgentId, extensionId: ExtensionId): ExtensionActivationTransition | undefined {
    return this.#requests.get(this.#agentKey(agentId, extensionId))
  }

  async dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise
    this.#disposed = true
    this.#disposePromise = (async () => {
      await Promise.allSettled([...this.#locks.values()])
      const live = [...this.#live.entries()]
      this.#live.clear()
      const outcomes = await Promise.allSettled(
        live.map(([extensionId, entry]) => this.#stop(extensionId, entry, false)),
      )
      const failures = outcomes
        .filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
        .map((outcome): unknown => outcome.reason)
      if (failures.length) throw new AggregateError(failures, '扩展运行时释放失败。')
    })()
    return this.#disposePromise
  }

  // —— Internals ——

  /** Loads the host instance and attaches the given agents; a partial start is fully stopped before rethrowing. */
  async #start(input: {
    readonly revision: Revision
    readonly manifest: ExtensionManifest
    readonly artifact: ExtensionBuildArtifact
    readonly config: JsonValue
    readonly attachments: readonly { readonly agentId: AgentId; readonly config: JsonValue }[]
  }): Promise<LiveExtension> {
    const loaded = await this.#host.load(input)
    const live: LiveExtension = {
      revision: input.revision,
      manifest: input.manifest,
      artifact: input.artifact,
      config: input.config,
      loaded,
      attachments: new Map(),
    }
    try {
      for (const attachment of input.attachments) {
        live.attachments.set(attachment.agentId, {
          config: attachment.config,
          mounted: await loaded.attach(attachment.agentId, attachment.config),
        })
      }
    } catch (error) {
      try {
        await this.#stop(input.revision.extensionId, live, false)
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], '扩展启动失败，且候选运行时未完整静止。')
      }
      throw error
    }
    return live
  }

  /** Stops attachments at each agent's safe gap, then the host instance at its adapter's safe gap. */
  async #stop(extensionId: ExtensionId, live: LiveExtension | undefined, waitForSafeGap = true): Promise<void> {
    if (!live) return
    if (this.#live.get(extensionId) === live) this.#live.delete(extensionId)
    const failures: unknown[] = []
    for (const [agentId, attachment] of [...live.attachments]) {
      try {
        if (waitForSafeGap) await this.#host.waitUntilAgentSafe(agentId)
        await attachment.mounted.dispose()
      } catch (error) {
        failures.push(error)
      }
      live.attachments.delete(agentId)
    }
    try {
      if (waitForSafeGap && live.loaded.adapterKey !== undefined) {
        await this.#host.waitUntilAdapterSafe(live.loaded.adapterKey)
      }
      await live.loaded.dispose()
    } catch (error) {
      failures.push(error)
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, '扩展停止失败。')
  }

  #snapshot(live: LiveExtension): Snapshot {
    return {
      revision: live.revision,
      manifest: live.manifest,
      artifact: live.artifact,
      config: live.config,
      attachments: [...live.attachments].map(([agentId, attachment]) => ({ agentId, config: attachment.config })),
    }
  }

  async #restore(extensionId: ExtensionId, previous: Snapshot | undefined, originalError: unknown): Promise<void> {
    if (!previous) return
    try {
      this.#live.set(extensionId, await this.#start(previous))
    } catch (restoreError) {
      this.#diagnostics.set(extensionId, {
        status: 'restore-failed',
        message: message(restoreError),
        observedAt: this.#timestamp(),
      })
      throw new AggregateError([originalError, restoreError], '扩展变更失败，且原保存记录无法恢复运行。')
    }
  }

  #grant(
    ownerKey: string,
    revision: Revision,
    requirement: PermissionRequirement,
    approvedAt: number,
  ): HostUiPermissionGrant {
    return {
      ownerKey,
      artifactDigest: revision.payloadDigest,
      permissionDigest: requirement.permissionDigest,
      declaration: requirement.declaration,
      approvedAt,
    }
  }

  #pages(revision: Revision) {
    return this.#repository.getExtensionRevisionVerification(revision.id)?.renderedPages ?? []
  }

  #assertVerified(revision: Revision): void {
    if (this.#repository.getExtensionRevisionVerification(revision.id)?.contractVersion !== 'nekro-nxt-extension-v5') {
      throw new Error('只能安装在本机完成验证的扩展保存记录。')
    }
  }

  #current(
    extensionId: ExtensionId,
    revisionId: ExtensionRevisionId,
  ): {
    readonly revision: Revision
    readonly manifest: ExtensionManifest
  } {
    const revision = this.#repository.getExtensionRevision(revisionId)
    if (!revision || revision.extensionId !== extensionId) throw new Error('这份保存记录不属于所选扩展。')
    const manifest = this.#service.revisionManifest(revision)
    if (!manifest) throw new Error(LEGACY_EXTENSION_MESSAGE)
    return { revision, manifest }
  }

  #requireLive(extensionId: ExtensionId): LiveExtension {
    const live = this.#live.get(extensionId)
    if (!live) throw new Error('这个扩展当前没有在本机运行。')
    return live
  }

  #build(revision: Revision): Promise<ExtensionBuildArtifact> {
    return this.#builder.build({
      extensionId: revision.extensionId,
      revisionId: revision.id,
      contentDigest: revision.contentDigest,
      sourceDirectory: this.#service.revisionSourceDirectory(revision),
    })
  }

  #instanceIdentity(installation: HostInstallation): ExtensionCompatibilityIdentity {
    return {
      objectKind: 'extension',
      objectId: installation.extensionId,
      objectVersion: installation.extensionRevisionId,
      configurationRevision: 'host',
    }
  }

  #attachmentIdentity(activation: Activation): ExtensionCompatibilityIdentity {
    return {
      objectKind: 'extension',
      objectId: activation.extensionId,
      objectVersion: activation.extensionRevisionId,
      configurationRevision: JSON.stringify([activation.agentId, activation.config]),
    }
  }

  /**
   * Publishes an enable or disable request as waiting until it settles. Success leaves only the committed state;
   * failure stays visible with its reason until the next request for the same agent replaces it.
   */
  async #tracked<T>(
    key: string,
    request: Pick<ExtensionActivationTransition, 'agentId' | 'extensionId' | 'target' | 'extensionRevisionId'>,
    operation: () => Promise<T>,
  ): Promise<T> {
    const waiting: ExtensionActivationTransition = { ...request, state: 'waiting', since: this.#timestamp() }
    this.#requests.set(key, waiting)
    try {
      const result = await operation()
      if (this.#requests.get(key) === waiting) this.#requests.delete(key)
      return result
    } catch (error) {
      if (this.#requests.get(key) === waiting) {
        this.#requests.set(key, { ...request, state: 'failed', message: message(error), since: this.#timestamp() })
      }
      throw error
    }
  }

  async #exclusive<T>(extensionId: ExtensionId, operation: () => Promise<T>): Promise<T> {
    const preceding = this.#locks.get(extensionId) ?? Promise.resolve()
    const result = preceding.catch(() => undefined).then(operation)
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    this.#locks.set(extensionId, tail)
    try {
      return await result
    } finally {
      if (this.#locks.get(extensionId) === tail) this.#locks.delete(extensionId)
    }
  }

  #agentKey(agentId: AgentId, extensionId: ExtensionId): string {
    return `${agentId}\0${extensionId}`
  }

  #assertAvailable(): void {
    if (this.#disposed) throw new Error('扩展运行时已停止。')
  }

  #timestamp(): number {
    const value = this.#now()
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Clock must return a non-negative integer.')
    return value
  }
}
