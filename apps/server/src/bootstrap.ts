import type { Context } from '@deepseek-ai/cordis'
import { BUILTIN_ADAPTER_CONTRIBUTIONS } from '@nekro-nxt/adapter-builtin-roster'
import {
  AdapterRegistry,
  type AdapterConnectionRuntime,
  type AdapterLocalChannelPort,
  type AdapterTransportService,
  type RegisteredAdapterHandle,
} from '@nekro-nxt/adapter-sdk'
import { ChannelRuntime } from '@nekro-nxt/channel-runtime'
import {
  DshNxtHostUiSchema,
  HostUiPageInstanceIdSchema,
  type AgentId,
  type ChannelId,
  type ConnectionId,
  type DshPluginPackageId,
  type ExtensionId,
  type ExtensionRevisionId,
} from '@nekro-nxt/contracts'
import type { AgentRevisionContent } from '@nekro-nxt/core'
import { AssetService, CoreService } from '@nekro-nxt/core'
import {
  AuthoringArtifactStore,
  DynamicAuthoringService,
  ExtensionActivationCoordinator,
  ExtensionBuilder,
  ExtensionService,
  ExtensionSourceStore,
  HostExtensionInstallationCoordinator,
  hostUiPermissionDigest,
} from '@nekro-nxt/extension-runtime'
import {
  completeDshSessionStoragePreparation,
  openMigratedCoreDatabase,
  prepareDshSessionStorage,
  SqliteCoreRepository,
  SqliteHostSecurityRepository,
  type CoreDatabase,
  type DshSessionStoragePreparation,
} from '@nekro-nxt/storage-sqlite'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { monotonicFactory } from 'ulid'
import { createProductionAdapterTransport } from './adapter-transport.js'
import { AuthoringApplicationService } from './authoring-application.js'
import { ConnectionApplicationService } from './connection-application.js'
import { LocalCredentialStore } from './credentials.js'
import { DshPluginPackageInstaller } from './dsh-plugin-installer.js'
import { ServerAdapterHostInstallationHost } from './host-extension-installation.js'
import { verifyImportedExtensionRevision } from './imported-extension-verifier.js'
import { ChannelExtensionActivationHost, DshHostRuntime } from './index.js'
import { NotificationService } from './notifications.js'
export type { ConnectionTestResult } from './connection-application.js'
/**
 * Single source of truth for the NekroNxt Server main assembly. Extracts the
 * inline composition previously duplicated across tests into one reusable
 * entry that owns every service the domain API drives. Assembly order mirrors
 * the M1–M5 vertical-slice tests; disposal waits for resources to settle in
 * reverse order (docs/06).
 */
export interface NekroRuntimeOptions {
  /** Core domain SQLite file path (opened + migrated). */
  readonly coreDatabasePath: string
  /** DSH Session SQLite file path (host-owned). */
  readonly sessionDatabasePath: string
  /** Asset blob content-addressed storage root. */
  readonly assetRoot: string
  /** Local Extension source Revision root. */
  readonly extensionDataRoot: string
  /** Extension build-artifact cache root. */
  readonly extensionCacheRoot: string
  /** Managed DSH package installation root. Defaults to `<data>/dsh`. */
  readonly dshPluginRoot?: string
  /** Host-owned private credential directory; secrets never enter Core records. */
  readonly credentialRoot?: string
  /** DSH-owned model settings and credential documents. */
  readonly llmSettingsPath?: string
  readonly llmCredentialPath?: string
  /** Absolute workspace root for explicitly granted development capabilities. */
  readonly developmentWorkspaceRoot?: string
  /** Inject a real or test LLM adapter into the DSH Host. */
  readonly configureLlm?: (context: Context) => Promise<void> | void
  /** Idle rollover threshold in ms; default 6h, `false` disables. */
  readonly idleRolloverMs?: number | false
  readonly now?: () => number
  readonly nextUlid?: () => string
  readonly notifications?: { readonly fetch?: typeof fetch }
  /** Replaced by an offline Fake for tests and AI validation; production uses fetch/ws. */
  readonly adapterTransport?: AdapterTransportService
}

/** One deliberate entity registry the domain API reads for its authoritative projection. */
export interface AgentEntity {
  readonly agentId: AgentId
  readonly channelId: ChannelId
  readonly connectionId: ConnectionId
  readonly revisionId: string
  readonly createdAt: number
}

export class NekroRuntime {
  readonly repository: SqliteCoreRepository
  readonly hostSecurity: SqliteHostSecurityRepository
  readonly assetService: AssetService
  readonly core: CoreService
  readonly authoring: AuthoringApplicationService
  readonly host: DshHostRuntime
  readonly channels: ChannelRuntime
  readonly internalConnectionId: ConnectionId
  readonly extensionService: ExtensionService
  readonly activation: ExtensionActivationCoordinator
  readonly installation: HostExtensionInstallationCoordinator
  readonly credentials: LocalCredentialStore
  readonly notifications: NotificationService
  readonly dshPluginInstaller: DshPluginPackageInstaller
  readonly sessionStoragePreparation: DshSessionStoragePreparation
  readonly sessionStorageRetirement:
    { readonly episodesClosed: number; readonly admissionsReleased: number } | undefined
  readonly #database: CoreDatabase
  readonly #now: () => number
  readonly connections: ConnectionApplicationService
  readonly adapters: AdapterRegistry
  readonly #hostClientDiagnostics = new Map<
    ExtensionId,
    {
      readonly revisionId: ExtensionRevisionId
      readonly status: 'loaded' | 'failed'
      readonly message?: string
      readonly observedAt: number
    }
  >()
  readonly #agents = new Map<AgentId, AgentEntity>()
  readonly #unsubscribeDynamicApproval: () => void
  #started = false
  #disposed = false

  private constructor(input: {
    readonly database: CoreDatabase
    readonly repository: SqliteCoreRepository
    readonly hostSecurity: SqliteHostSecurityRepository
    readonly assetService: AssetService
    readonly core: CoreService
    readonly host: DshHostRuntime
    readonly channels: ChannelRuntime
    readonly internalConnectionId: ConnectionId
    readonly extensionService: ExtensionService
    readonly activation: ExtensionActivationCoordinator
    readonly extensionBuilder: ExtensionBuilder
    readonly credentials: LocalCredentialStore
    readonly notifications: NotificationService
    readonly dshPluginInstaller: DshPluginPackageInstaller
    readonly unsubscribeDynamicApproval: () => void
    readonly sessionStoragePreparation: DshSessionStoragePreparation
    readonly sessionStorageRetirement?: { readonly episodesClosed: number; readonly admissionsReleased: number }
    readonly now: () => number
    readonly adapters: AdapterRegistry
    readonly adapterHandles: readonly RegisteredAdapterHandle[]
    readonly adapterRuntimes: Map<ConnectionId, AdapterConnectionRuntime>
    readonly adapterTransport: AdapterTransportService
  }) {
    this.#database = input.database
    this.repository = input.repository
    this.hostSecurity = input.hostSecurity
    this.assetService = input.assetService
    this.core = input.core
    this.host = input.host
    this.authoring = new AuthoringApplicationService(this)
    this.channels = input.channels
    this.internalConnectionId = input.internalConnectionId
    this.extensionService = input.extensionService
    this.activation = input.activation
    this.credentials = input.credentials
    this.notifications = input.notifications
    this.dshPluginInstaller = input.dshPluginInstaller
    this.#unsubscribeDynamicApproval = input.unsubscribeDynamicApproval
    this.sessionStoragePreparation = input.sessionStoragePreparation
    this.sessionStorageRetirement = input.sessionStorageRetirement
    this.#now = input.now
    this.adapters = input.adapters
    this.connections = new ConnectionApplicationService(
      this,
      input.now,
      input.adapterRuntimes,
      input.adapterTransport,
      input.adapterHandles,
      () => ({ started: this.#started, disposed: this.#disposed }),
    )
    this.installation = new HostExtensionInstallationCoordinator(
      this.repository,
      this.extensionService,
      input.extensionBuilder,
      new ServerAdapterHostInstallationHost({
        expectedAdapter: (revision) => {
          const verification = this.repository.getExtensionRevisionVerification(revision.id)
          if (verification?.scope !== 'host-adapter' || !verification.adapter) {
            throw new Error('Host 安装只接受完成适配器验证的 Extension Revision。')
          }
          return { key: verification.adapter.key, descriptorDigest: verification.adapter.descriptorDigest }
        },
        assertAdapterKeyAvailable: (adapterKey, extensionId) => {
          const registered = this.adapters.get(adapterKey)
          const owned = this.adapters.getByOwner(`extension:${extensionId}`)
          if (registered && registered !== owned) {
            throw new Error(`适配器 key 已被占用: ${adapterKey}`)
          }
          return Promise.resolve()
        },
        register: (owner, contribution) => this.registerAdapter(owner, contribution),
        mountConnections: (adapterKey) => this.mountAdapterConnections(adapterKey),
        waitUntilSafe: async (adapterKey) => {
          await this.connections.waitUntilSafe(adapterKey)
        },
      }),
      { now: this.#now },
    )
  }

  static async create(options: NekroRuntimeOptions): Promise<NekroRuntime> {
    const now = options.now ?? Date.now
    const nextUlid = options.nextUlid ?? monotonicFactory()

    const database = await openMigratedCoreDatabase(options.coreDatabasePath)
    const repository = new SqliteCoreRepository(database)
    const hostSecurity = new SqliteHostSecurityRepository(database)
    try {
      const sessionStoragePreparation = await prepareDshSessionStorage({
        databasePath: options.sessionDatabasePath,
        now: () => new Date(now()),
      })
      const sessionStorageRetirement =
        sessionStoragePreparation.kind === 'archived' ? repository.retireDshSessionEpisodes(now()) : undefined
      if (sessionStoragePreparation.kind === 'archived') {
        await completeDshSessionStoragePreparation(options.sessionDatabasePath)
      }
      const assetService = new AssetService(repository, options.assetRoot)
      const authoringWorkspaceRoot =
        options.developmentWorkspaceRoot ?? path.join(path.dirname(options.coreDatabasePath), 'workspaces')
      await mkdir(authoringWorkspaceRoot, { recursive: true, mode: 0o700 })
      const authoringService = new DynamicAuthoringService(
        repository,
        new AuthoringArtifactStore(authoringWorkspaceRoot),
        { now, nextUlid },
      )
      const core = new CoreService(repository, { now, nextUlid })
      const adapters = new AdapterRegistry()
      const adapterHandles = BUILTIN_ADAPTER_CONTRIBUTIONS.map((contribution, index) =>
        adapters.register(`builtin:${index}`, contribution),
      )
      const dshPluginInstaller = new DshPluginPackageInstaller(
        repository,
        options.dshPluginRoot ?? path.join(path.dirname(options.coreDatabasePath), 'dsh'),
        { now, nextUlid },
      )
      await dshPluginInstaller.initialize()
      for (const contribution of adapters.list()) {
        if (contribution.descriptor.provisioning !== 'system-singleton') continue
        const existing = core.listConnectionsByAdapter(contribution.descriptor.key)
        if (existing.length > 1) {
          throw new Error(`System-singleton Adapter has multiple Connections: ${contribution.descriptor.key}`)
        }
        if (existing.length === 0) core.createConnection({ adapterKey: contribution.descriptor.key, config: {} })
      }
      const internalConnections = core.listConnections().filter((connection) => {
        const descriptor = adapters.get(connection.adapterKey)?.descriptor
        return descriptor?.provisioning === 'system-singleton' && descriptor.channelKinds.includes('internal')
      })
      if (internalConnections.length !== 1) {
        throw new Error('Host requires exactly one system-singleton Adapter that provides internal Channels.')
      }
      const internalConnectionId = internalConnections[0]!.id
      const adapterRuntimes = new Map<ConnectionId, AdapterConnectionRuntime>()

      // Adapter inbound and Channel Runtime delivery reference each other lazily.
      const settled: { current?: ChannelRuntime } = {}

      const host = await DshHostRuntime.create({
        sessionDatabasePath: options.sessionDatabasePath,
        ...(options.developmentWorkspaceRoot === undefined
          ? {}
          : { developmentWorkspaceRoot: options.developmentWorkspaceRoot }),
        communication: {
          sendMessage: (input) => {
            if (!settled.current) return Promise.reject(new Error('Channel Runtime is not ready.'))
            return settled.current.sendMessage(input)
          },
          supportsRetraction: (channelId) => {
            const channel = core.getChannel(channelId)
            if (!channel) return false
            return adapterRuntimes.get(channel.connectionId)?.interactions?.retractOwnMessage !== undefined
          },
          supportsNudge: (channelId) => {
            const channel = core.getChannel(channelId)
            if (!channel) return false
            return adapterRuntimes.get(channel.connectionId)?.interactions?.nudgeMember !== undefined
          },
          retractMessage: (input) => {
            if (!settled.current) return Promise.reject(new Error('Channel Runtime is not ready.'))
            return settled.current.retractChannelMessage(input)
          },
          nudgeMember: (input) => {
            if (!settled.current) return Promise.reject(new Error('Channel Runtime is not ready.'))
            return settled.current.nudgeChannelMember(input)
          },
        },
        history: repository,
        resolveAdapterDisplayName: (adapterKey) => adapters.get(adapterKey)?.descriptor.displayName,
        assets: repository,
        assetService,
        resolveAgentRevision: (revisionId) => repository.getAgentRevision(revisionId),
        authoring: {
          service: authoringService,
          resolveInitiatingEvent: (episodeId) => {
            const episode = repository.getEpisode(episodeId)
            return episode?.lastAdmittedEventId ?? episode?.openedAtEventId
          },
        },
        ...(options.llmSettingsPath === undefined ? {} : { llmSettingsPath: options.llmSettingsPath }),
        ...(options.llmCredentialPath === undefined ? {} : { llmCredentialPath: options.llmCredentialPath }),
        ...(options.configureLlm === undefined ? {} : { configureLlm: options.configureLlm }),
        dshPlugins: {
          repository,
          resolveModule: (packageId, moduleName) => dshPluginInstaller.resolveModule(packageId, moduleName),
        },
      })

      const channels = new ChannelRuntime(core, repository, repository, host, {
        now,
        nextUlid,
        idleRolloverMs: options.idleRolloverMs ?? 6 * 60 * 60 * 1000,
        resolveAdapter: (id): AdapterConnectionRuntime | undefined => adapterRuntimes.get(id),
        isActivityTriggerAllowed: (channelId, activityKey) => {
          const channel = core.getChannel(channelId)
          if (!channel) return false
          const connection = core.getConnection(channel.connectionId)
          const descriptor = connection ? adapters.get(connection.adapterKey)?.descriptor : undefined
          const definition = descriptor?.activities.find((activity) => activity.key === activityKey)
          const capability = adapterRuntimes.get(channel.connectionId)?.capabilities.activities[activityKey]
          return (
            definition?.scope === 'channel' &&
            definition.triggerable &&
            definition.channelKinds?.includes(channel.kind) === true &&
            capability?.state !== 'disabled' &&
            capability?.state !== 'unsupported'
          )
        },
        isActivityTriggerEnabledByDefault: (channelId, activityKey) => {
          const channel = core.getChannel(channelId)
          const connection = channel ? core.getConnection(channel.connectionId) : undefined
          return connection?.activityTriggerDefaults.includes(activityKey) === true
        },
        validateActivityTriggerOverrides: (channelId, overrides) => {
          const channel = core.getChannel(channelId)
          if (!channel) throw new Error('频道不存在。')
          const connection = core.getConnection(channel.connectionId)
          const descriptor = connection ? adapters.get(connection.adapterKey)?.descriptor : undefined
          if (!descriptor) return
          for (const activityKey of Object.keys(overrides)) {
            const definition = descriptor.activities.find((activity) => activity.key === activityKey)
            if (
              definition?.scope !== 'channel' ||
              !definition.triggerable ||
              definition.channelKinds?.includes(channel.kind) !== true
            ) {
              throw new Error(`当前频道不支持活动触发：${activityKey}`)
            }
          }
        },
        adapterState: repository,
      })
      settled.current = channels

      const sourceStore = new ExtensionSourceStore(options.extensionDataRoot)
      const extensionBuilder = new ExtensionBuilder(options.extensionCacheRoot)
      const extensionService = new ExtensionService(repository, sourceStore, {
        now,
        nextUlid,
        builder: extensionBuilder,
        importVerifier: verifyImportedExtensionRevision,
      })
      const activation = new ExtensionActivationCoordinator(
        repository,
        extensionService,
        extensionBuilder,
        new ChannelExtensionActivationHost(channels, host),
        { now },
      )
      const credentials = new LocalCredentialStore(
        options.credentialRoot ?? path.join(path.dirname(options.coreDatabasePath), 'credentials'),
      )
      const notifications = new NotificationService(repository, credentials, {
        ...(options.notifications?.fetch === undefined ? {} : { fetch: options.notifications.fetch }),
        now,
      })
      const unsubscribeDynamicApproval = host.subscribeDynamicApprovalRequests((event) => {
        const displayName = repository.getAgent(event.agentId)?.revision.displayName ?? '未命名智能体'
        void notifications
          .notifyDynamicApproval({
            requestId: event.requestId,
            agentDisplayName: displayName,
            extensionName: event.name,
            purpose: event.purpose,
          })
          .catch((error) => {
            console.warn('[nekro-nxt] 通知投递失败：', error instanceof Error ? error.message : String(error))
          })
      })

      const runtime = new NekroRuntime({
        database,
        repository,
        hostSecurity,
        assetService,
        core,
        host,
        channels,
        internalConnectionId,
        extensionService,
        activation,
        extensionBuilder,
        credentials,
        notifications,
        dshPluginInstaller,
        unsubscribeDynamicApproval,
        sessionStoragePreparation,
        ...(sessionStorageRetirement === undefined ? {} : { sessionStorageRetirement }),
        now,
        adapters,
        adapterHandles,
        adapterRuntimes,
        adapterTransport: options.adapterTransport ?? createProductionAdapterTransport(),
      })
      return runtime
    } catch (error) {
      database.close()
      throw error
    }
  }

  /** Start system-managed Adapters so internal messages can be admitted. */
  async start(): Promise<void> {
    if (this.#disposed) throw new Error('NekroRuntime is disposed.')
    if (this.#started) throw new Error('NekroRuntime is already started.')
    this.#started = true
    for (const connection of this.core.listConnections()) {
      const descriptor = this.adapters.get(connection.adapterKey)?.descriptor
      if (descriptor?.provisioning === 'system-singleton') await this.connections.mountAdapter(connection.id)
    }
    if (!this.connections.localChannel(this.internalConnectionId)) {
      throw new Error('The internal Channel Adapter did not provide a localChannel port.')
    }
  }

  get internalChannel(): AdapterLocalChannelPort {
    const port = this.connections.localChannel(this.internalConnectionId)
    if (!port) throw new Error('The internal Channel runtime is unavailable.')
    return port
  }

  async removeDshPluginPackage(packageId: DshPluginPackageId): Promise<void> {
    const packageRecord = this.repository.getDshPluginPackage(packageId)
    if (!packageRecord) throw new Error('DSH 插件包不存在。')
    const entryIds = this.repository.listDshPluginEntries(packageId).map(({ id }) => id)
    await this.host.disableInstalledDshPluginPackage(packageId)
    for (const entryId of entryIds) {
      this.repository.deleteHostUiDshPages(entryId)
      this.repository.deleteHostUiPermissionGrant(`dsh:${entryId}`)
    }
    const trashDirectory = await this.dshPluginInstaller.moveToTrash(packageId)
    try {
      this.repository.deleteDshPluginPackage(packageId)
    } catch (error) {
      await this.dshPluginInstaller.restoreFromTrash(packageId, trashDirectory)
      throw error
    }
  }

  async deleteLocalExtension(extensionId: ExtensionId): Promise<void> {
    const extension = this.repository.getExtension(extensionId)
    if (!extension) throw new Error('本地扩展不存在或已被删除。')
    const revisions = this.repository.listExtensionRevisions(extensionId)
    const activations = this.repository.listActivations().filter((activation) => activation.extensionId === extensionId)
    const installation = this.repository.getHostInstallation(extensionId)
    const disabled: (typeof activations)[number][] = []
    let uninstalled = false
    let stagedSources: string | undefined
    try {
      for (const activation of activations) {
        await this.activation.disable(activation.agentId, extensionId)
        disabled.push(activation)
      }
      if (installation) {
        await this.uninstallHostExtension(extensionId)
        uninstalled = true
      }
      stagedSources = await this.extensionService.stageExtensionDeletion(extensionId)
      this.repository.deleteExtension(extensionId)
    } catch (error) {
      const rollbackFailures: unknown[] = []
      if (stagedSources) {
        try {
          await this.extensionService.restoreStagedExtension(extensionId, stagedSources)
        } catch (restoreError) {
          rollbackFailures.push(restoreError)
        }
      }
      if (uninstalled && installation) {
        try {
          await this.installHostExtension({
            extensionId,
            revisionId: installation.extensionRevisionId,
          })
        } catch (restoreError) {
          rollbackFailures.push(restoreError)
        }
      }
      for (const activation of disabled) {
        try {
          await this.activation.activate({
            agentId: activation.agentId,
            extensionId,
            revisionId: activation.extensionRevisionId,
            config: activation.config,
          })
        } catch (restoreError) {
          rollbackFailures.push(restoreError)
        }
      }
      if (rollbackFailures.length) {
        throw new AggregateError([error, ...rollbackFailures], '删除本地扩展失败，且原运行状态未完整恢复。')
      }
      throw error
    }
    this.#hostClientDiagnostics.delete(extensionId)
    await this.extensionService.deleteRevisionCaches(revisions).catch((error) => {
      console.warn(
        '[nekro-nxt] Extension 已删除，但构建缓存清理失败：',
        error instanceof Error ? error.message : String(error),
      )
    })
  }

  /** Every deliberate Agent entity this Server owns, in creation order. */
  agents(): readonly AgentEntity[] {
    return [...this.#agents.values()]
  }

  /**
   * Closed-loop A primitive: create an intelligent-agent, ensure a Web Channel
   * for it, and bind them with `always` so every Web message triggers a reply.
   */
  async createAgentWithInternalChannel(content: AgentRevisionContent): Promise<AgentEntity> {
    const models = await this.host.listAvailableLlmModels()
    if (!models.some((model) => model.provider === content.model.provider && model.id === content.model.model)) {
      throw new Error(`模型未在当前 DSH Provider 目录注册：${content.model.provider}/${content.model.model}`)
    }
    const agent = this.core.createAgentWithChannel(content, {
      connectionId: this.internalConnectionId,
      kind: 'internal',
      displayName: `${content.displayName.trim()} 的内置频道`,
      triggerPolicy: 'always',
    })
    const entity: AgentEntity = {
      agentId: agent.definition.id,
      channelId: agent.channel.id,
      connectionId: this.internalConnectionId,
      revisionId: agent.revision.id,
      createdAt: agent.definition.createdAt,
    }
    this.#agents.set(entity.agentId, entity)
    return entity
  }

  /**
   * Stops every live channel lane and extension owned by an intelligent-agent,
   * then removes it from active product state without deleting durable history.
   */
  async deleteAgent(
    agentId: AgentId,
    options: { readonly deleteAutoCreatedBuiltInChannels: boolean },
  ): Promise<{ readonly unboundChannelIds: readonly ChannelId[]; readonly deletedChannelIds: readonly ChannelId[] }> {
    if (this.#disposed) throw new Error('NekroRuntime is disposed.')
    if (!this.repository.getAgent(agentId)) throw new Error('智能体不存在。')
    const boundChannels = this.core
      .listConnections()
      .flatMap((connection) => this.core.listChannelsByConnection(connection.id))
      .filter((channel) => this.repository.getBinding(channel.id)?.agentId === agentId)
    const channelsToDelete = options.deleteAutoCreatedBuiltInChannels
      ? boundChannels.filter((channel) => channel.kind === 'internal' && channel.autoCreatedForAgentId === agentId)
      : []
    const deletedChannelIds = channelsToDelete.map((channel) => channel.id)
    const deletedChannelIdSet = new Set(deletedChannelIds)
    const unboundChannelIds = boundChannels
      .filter((channel) => !deletedChannelIdSet.has(channel.id))
      .map((channel) => channel.id)

    for (const channelId of deletedChannelIds) await this.channels.deleteChannel(channelId)
    for (const channelId of unboundChannelIds) await this.channels.clearBinding(channelId)
    for (const activation of this.repository.listActivations(agentId)) {
      await this.activation.disable(agentId, activation.extensionId)
    }
    for (const activation of this.repository
      .listDshPluginActivations()
      .filter((candidate) => candidate.target === 'agent' && candidate.agentId === agentId)) {
      await this.host.disableInstalledDshPlugin(activation.entryId, activation.targetKey)
    }
    this.core.deleteAgent(agentId)
    this.#agents.delete(agentId)
    return { unboundChannelIds, deletedChannelIds }
  }

  /** Resume persisted Episodes, Admissions, Outbounds and active Extensions after a cold start. */
  async recover(): Promise<void> {
    await this.installation.restore()
    await this.#restoreDshHostUiPages()
    for (const connection of this.core.listConnections()) {
      await this.connections.mountAdapter(connection.id)
    }
    await this.channels.recoverProcessingFeedback()
    await this.channels.recover()
    await this.activation.restore()
  }

  async #restoreDshHostUiPages(): Promise<void> {
    for (const activation of this.repository
      .listDshPluginActivations()
      .filter((candidate) => candidate.target === 'host')) {
      const entry = this.repository.getDshPluginEntry(activation.entryId)
      const packageRecord = entry ? this.repository.getDshPluginPackage(entry.packageId) : undefined
      if (!entry || !packageRecord) continue
      if (this.repository.getDshPluginDiagnostic(entry.id, activation.targetKey)?.status !== 'active') {
        this.repository.deleteHostUiDshPages(entry.id)
        continue
      }
      const manifest = packageRecord.manifest
      const nekroNxt =
        typeof manifest === 'object' && manifest !== null && !Array.isArray(manifest) ? manifest['nekroNxt'] : undefined
      const metadata = DshNxtHostUiSchema.safeParse(
        typeof nekroNxt === 'object' && nekroNxt !== null && !Array.isArray(nekroNxt) ? nekroNxt['hostUi'] : undefined,
      )
      if (!metadata.success || metadata.data.entryKey !== entry.entryKey) {
        this.repository.deleteHostUiDshPages(entry.id)
        continue
      }
      const permissionDigest = hostUiPermissionDigest(metadata.data.permissions)
      const grant = this.repository.getHostUiPermissionGrant(`dsh:${entry.id}`)
      if (grant?.artifactDigest !== packageRecord.packageDigest || grant.permissionDigest !== permissionDigest) {
        this.repository.deleteHostUiDshPages(entry.id)
        continue
      }
      try {
        await this.dshPluginInstaller.readHostUiClient(entry.id)
        const pages = this.repository.replaceHostUiDshPages({
          entryId: entry.id,
          artifactDigest: packageRecord.packageDigest,
          pages: metadata.data.pages,
          clientBuildKey: packageRecord.packageDigest,
          now: this.#now(),
          nextPageInstanceId: () => HostUiPageInstanceIdSchema.parse(`hup_${randomUUID().replaceAll('-', '')}`),
        })
        for (const page of pages) {
          this.repository.upsertHostUiDiagnostic({
            pageInstanceId: page.pageInstanceId,
            status: 'ready',
            observedAt: this.#now(),
          })
        }
      } catch (error) {
        const pages = this.repository.replaceHostUiDshPages({
          entryId: entry.id,
          artifactDigest: packageRecord.packageDigest,
          pages: metadata.data.pages,
          clientBuildKey: packageRecord.packageDigest,
          now: this.#now(),
          nextPageInstanceId: () => HostUiPageInstanceIdSchema.parse(`hup_${randomUUID().replaceAll('-', '')}`),
        })
        for (const page of pages) {
          this.repository.upsertHostUiDiagnostic({
            pageInstanceId: page.pageInstanceId,
            status: 'restore-failed',
            message: error instanceof Error ? error.message : String(error),
            observedAt: this.#now(),
          })
        }
      }
    }
  }
  subscribeConnectionChanges(...args: Parameters<ConnectionApplicationService['subscribeConnectionChanges']>) {
    return this.connections.subscribeConnectionChanges(...args)
  }

  adapterConnectionDiagnostic(...args: Parameters<ConnectionApplicationService['adapterConnectionDiagnostic']>) {
    return this.connections.adapterConnectionDiagnostic(...args)
  }

  lastInbound(...args: Parameters<ConnectionApplicationService['lastInbound']>) {
    return this.connections.lastInbound(...args)
  }

  connectionTests(...args: Parameters<ConnectionApplicationService['connectionTests']>) {
    return this.connections.connectionTests(...args)
  }

  hostClientDiagnostic(extensionId: ExtensionId) {
    return this.#hostClientDiagnostics.get(extensionId)
  }

  recordHostClientDiagnostic(
    extensionId: ExtensionId,
    diagnostic: {
      readonly revisionId: ExtensionRevisionId
      readonly status: 'loaded' | 'failed'
      readonly message?: string
    },
  ): void {
    this.#hostClientDiagnostics.set(extensionId, { ...diagnostic, observedAt: this.#now() })
  }
  listConnectionAdapters(...args: Parameters<ConnectionApplicationService['listConnectionAdapters']>) {
    return this.connections.listConnectionAdapters(...args)
  }

  createConnection(...args: Parameters<ConnectionApplicationService['createConnection']>) {
    return this.connections.createConnection(...args)
  }

  updateConnectionAlias(...args: Parameters<ConnectionApplicationService['updateConnectionAlias']>) {
    return this.connections.updateConnectionAlias(...args)
  }

  updateConnectionActivityTriggerDefaults(
    ...args: Parameters<ConnectionApplicationService['updateConnectionActivityTriggerDefaults']>
  ) {
    return this.connections.updateConnectionActivityTriggerDefaults(...args)
  }

  deleteConnection(...args: Parameters<ConnectionApplicationService['deleteConnection']>) {
    return this.connections.deleteConnection(...args)
  }

  restoreConnection(...args: Parameters<ConnectionApplicationService['restoreConnection']>) {
    return this.connections.restoreConnection(...args)
  }

  testConnection(...args: Parameters<ConnectionApplicationService['testConnection']>) {
    return this.connections.testConnection(...args)
  }

  connectionCapabilities(...args: Parameters<ConnectionApplicationService['connectionCapabilities']>) {
    return this.connections.connectionCapabilities(...args)
  }

  registerAdapter(...args: Parameters<ConnectionApplicationService['registerAdapter']>) {
    return this.connections.registerAdapter(...args)
  }

  installHostExtension(input: Parameters<HostExtensionInstallationCoordinator['install']>[0]) {
    return this.installation.install(input)
  }

  updateHostUiPagePreferences(input: Omit<Parameters<SqliteCoreRepository['updateHostUiPagePreferences']>[0], 'now'>) {
    return this.repository.updateHostUiPagePreferences({ ...input, now: this.#now() })
  }

  uninstallHostExtension(extensionId: Parameters<HostExtensionInstallationCoordinator['uninstall']>[0]): Promise<void> {
    return this.installation.uninstall(extensionId)
  }
  mountAdapterConnections(...args: Parameters<ConnectionApplicationService['mountAdapterConnections']>) {
    return this.connections.mountAdapterConnections(...args)
  }

  stopAdapterConnections(...args: Parameters<ConnectionApplicationService['stopAdapterConnections']>) {
    return this.connections.stopAdapterConnections(...args)
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    await this.authoring.dispose()
    const failures: unknown[] = []
    this.#unsubscribeDynamicApproval()
    this.connections.clearObservers()
    for (const operation of [
      () => this.channels.stopProcessingFeedback(),
      () => this.activation.dispose(),
      () => this.installation.dispose(),
    ]) {
      try {
        await operation()
      } catch (error) {
        failures.push(error)
      }
    }
    const stopped = await this.connections.stopAll()
    for (const outcome of stopped) if (outcome.status === 'rejected') failures.push(outcome.reason)
    try {
      await this.host.dispose()
    } catch (error) {
      failures.push(error)
    }
    try {
      await this.dshPluginInstaller.dispose()
    } catch (error) {
      failures.push(error)
    }
    const handles = await this.connections.disposeRegistrations()
    for (const outcome of handles) if (outcome.status === 'rejected') failures.push(outcome.reason)
    this.#hostClientDiagnostics.clear()
    this.#database.close()
    if (failures.length) throw new AggregateError(failures, 'Nekro Runtime disposal failed.')
  }
}
