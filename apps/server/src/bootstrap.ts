import { AuthoringApplicationService } from './authoring-application.js'
import type { Context } from '@deepseek-ai/cordis'
import { BUILTIN_ADAPTER_CONTRIBUTIONS } from '@nekro-nxt/adapter-builtin-roster'
import {
  AdapterRegistry,
  parseAdapterCapabilities,
  type AdapterConnectionHostContext,
  type AdapterConnectionDiagnostic,
  type AdapterConnectionRuntime,
  type AdapterHostContributionV2,
  type AdapterLocalChannelPort,
  type AdapterTransportService,
  type RegisteredAdapterHandle,
} from '@nekro-nxt/adapter-sdk'
import { ChannelRuntime } from '@nekro-nxt/channel-runtime'
import { AssetService, CoreService } from '@nekro-nxt/core'
import type { AgentRevisionContent, ConnectionEventRecord, ConnectionRecord } from '@nekro-nxt/core'
import {
  LogicalMessageIdSchema,
  DshNxtHostUiSchema,
  HostUiPageInstanceIdSchema,
  PhysicalDeliveryIdSchema,
  type AgentId,
  type AdapterActivityKey,
  type ChannelId,
  type ConnectionId,
  type ExtensionId,
  type ExtensionRevisionId,
  type DshPluginPackageId,
  type JsonValue,
} from '@nekro-nxt/contracts'
import {
  ExtensionActivationCoordinator,
  AuthoringArtifactStore,
  DynamicAuthoringService,
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
import { mkdir, readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { monotonicFactory } from 'ulid'
import { ChannelExtensionActivationHost, DshHostRuntime } from './index.js'
import { fetchAdapterRemoteBytes } from './adapter-remote-assets.js'
import { LocalCredentialStore } from './credentials.js'
import { NotificationService } from './notifications.js'
import { ServerAdapterHostInstallationHost } from './host-extension-installation.js'
import { createProductionAdapterTransport } from './adapter-transport.js'
import { verifyImportedExtensionRevision } from './imported-extension-verifier.js'
import { DshPluginPackageInstaller } from './dsh-plugin-installer.js'

const parseStoredAdapterConfiguration = (value: JsonValue): Readonly<Record<string, string | number | boolean>> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('连接配置必须是对象。')
  }
  const configuration: Record<string, string | number | boolean> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string' && typeof entry !== 'number' && typeof entry !== 'boolean') {
      throw new TypeError(`连接配置字段 ${key} 的持久格式无效。`)
    }
    configuration[key] = entry
  }
  return configuration
}
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

export type ConnectionTestResult =
  | { readonly status: 'received'; readonly channelId: ChannelId; readonly platformMessageId: string }
  | { readonly status: 'sent'; readonly channelId: ChannelId; readonly platformMessageId?: string }
  | {
      readonly status: 'waiting-for-message' | 'needs-channel' | 'needs-target' | 'not-connected'
      readonly message: string
    }
  | { readonly status: 'failed'; readonly kind: string; readonly message: string; readonly retryAfterMs?: number }

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
  readonly adapters: AdapterRegistry
  readonly #adapterHandles: RegisteredAdapterHandle[] = []
  readonly #adapterRuntimes: Map<ConnectionId, AdapterConnectionRuntime>
  readonly #quiescingAdapterKeys = new Set<string>()
  readonly #adapterTransport: AdapterTransportService
  readonly #adapterDiagnostics = new Map<ConnectionId, AdapterConnectionDiagnostic>()
  readonly #connectionTests = new Map<
    ConnectionId,
    { readonly receive?: ConnectionTestResult; readonly send?: ConnectionTestResult }
  >()
  readonly #hostClientDiagnostics = new Map<
    ExtensionId,
    {
      readonly revisionId: ExtensionRevisionId
      readonly status: 'loaded' | 'failed'
      readonly message?: string
      readonly observedAt: number
    }
  >()
  readonly #lastInboundByConnection = new Map<
    ConnectionId,
    { readonly channelId: ChannelId; readonly platformMessageId?: string; readonly receivedAt: number }
  >()
  readonly #connectionListeners = new Set<(event?: ConnectionEventRecord) => void>()
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
    this.#adapterHandles.push(...input.adapterHandles)
    this.#adapterRuntimes = input.adapterRuntimes
    this.#adapterTransport = input.adapterTransport
    this.#adapterDiagnostics.set(input.internalConnectionId, {
      status: 'connected',
      credentialConfigured: true,
      proactiveSend: true,
    })
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
          this.#quiescingAdapterKeys.add(adapterKey)
          try {
            await this.channels.waitUntilConnectionsSafe(this.repository.listConnectionIdsByAdapter(adapterKey))
          } catch (error) {
            this.#quiescingAdapterKeys.delete(adapterKey)
            throw error
          }
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
      if (descriptor?.provisioning === 'system-singleton') await this.#mountAdapter(connection.id)
    }
    if (!this.#adapterRuntimes.get(this.internalConnectionId)?.localChannel) {
      throw new Error('The internal Channel Adapter did not provide a localChannel port.')
    }
  }

  get internalChannel(): AdapterLocalChannelPort {
    const port = this.#adapterRuntimes.get(this.internalConnectionId)?.localChannel
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
      await this.#mountAdapter(connection.id)
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

  subscribeConnectionChanges(listener: (event?: ConnectionEventRecord) => void): () => void {
    this.#connectionListeners.add(listener)
    return () => this.#connectionListeners.delete(listener)
  }

  adapterConnectionDiagnostic(connectionId: ConnectionId): AdapterConnectionDiagnostic | undefined {
    return this.#adapterDiagnostics.get(connectionId)
  }

  lastInbound(connectionId: ConnectionId) {
    return this.#lastInboundByConnection.get(connectionId)
  }

  connectionTests(connectionId: ConnectionId) {
    return this.#connectionTests.get(connectionId)
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

  listConnectionAdapters() {
    return this.adapters.list().map(({ descriptor }) => descriptor)
  }

  async createConnection(input: {
    readonly adapterKey: string
    readonly alias?: string | undefined
    readonly configuration?: Readonly<Record<string, unknown>>
    readonly credentials?: Readonly<Record<string, unknown>>
  }) {
    if (!this.#started || this.#disposed) throw new Error('NekroRuntime is not accepting new Connections.')
    const contribution = this.adapters.get(input.adapterKey)
    if (contribution?.descriptor.provisioning !== 'user-created') throw new Error('该连接平台不可由用户创建。')
    const descriptor = contribution.descriptor
    const configurationInput = input.configuration ?? {}
    const credentialsInput = input.credentials ?? {}
    const configuration: Record<string, string | number | boolean> = {}
    const rawCredentials: Array<{ readonly key: string; readonly value: string }> = []
    for (const key of Object.keys(configurationInput)) {
      const property = descriptor.configSchema.properties[key]
      if (!property || property.type === 'credential-reference') throw new TypeError(`连接配置包含未知字段：${key}`)
    }
    for (const key of Object.keys(credentialsInput)) {
      const property = descriptor.configSchema.properties[key]
      if (!property || property.type !== 'credential-reference') throw new TypeError(`连接凭据包含未知字段：${key}`)
    }
    for (const [key, property] of Object.entries(descriptor.configSchema.properties)) {
      if (property.type === 'credential-reference') {
        const raw = credentialsInput[key]
        if (raw === undefined && descriptor.configSchema.required.includes(key))
          throw new TypeError(`请填写${property.title}。`)
        if (raw !== undefined) {
          if (typeof raw !== 'string' || !raw.trim()) throw new TypeError(`请填写${property.title}。`)
          rawCredentials.push({ key: property.credentialKey?.trim() || key, value: raw })
        }
        continue
      }
      const value = configurationInput[key] ?? property.default
      if (value === undefined) {
        if (descriptor.configSchema.required.includes(key)) throw new TypeError(`请填写${property.title}。`)
        continue
      }
      if (property.type === 'string' && typeof value === 'string') configuration[key] = value
      else if (property.type === 'number' && typeof value === 'number') configuration[key] = value
      else if (property.type === 'boolean' && typeof value === 'boolean') configuration[key] = value
      else throw new TypeError(`${property.title}的类型无效。`)
    }
    const credentialRefs: Record<string, string> = {}
    try {
      for (const credential of rawCredentials)
        credentialRefs[credential.key] = await this.credentials.save(credential.value)
      const connection = this.core.createConnection({
        adapterKey: descriptor.key,
        ...(input.alias === undefined ? {} : { alias: input.alias }),
        config: configuration,
        credentialRefs,
      })
      await this.#mountAdapter(connection.id)
      return connection
    } catch (error) {
      await Promise.allSettled(Object.values(credentialRefs).map((reference) => this.credentials.delete(reference)))
      throw error
    }
  }

  updateConnectionAlias(connectionId: ConnectionId, alias?: string): ConnectionRecord {
    if (this.#disposed) throw new Error('NekroRuntime is disposed.')
    const connection = this.core.getConnection(connectionId)
    if (!connection) throw new Error('连接不存在。')
    const descriptor = this.adapters.get(connection.adapterKey)?.descriptor
    if (!descriptor?.aliasEditable) throw new Error('系统托管连接不需要编辑别名。')
    const updated = this.core.updateConnectionAlias(connectionId, alias)
    this.#notifyConnectionChanges()
    return updated
  }

  updateConnectionActivityTriggerDefaults(
    connectionId: ConnectionId,
    activityKeys: readonly AdapterActivityKey[],
  ): ConnectionRecord {
    if (this.#disposed) throw new Error('NekroRuntime is disposed.')
    const connection = this.core.getConnection(connectionId)
    if (!connection) throw new Error('连接不存在。')
    const descriptor = this.adapters.get(connection.adapterKey)?.descriptor
    if (!descriptor) throw new Error('这个连接的适配器未安装，无法修改活动默认值。')
    if (new Set(activityKeys).size !== activityKeys.length) throw new Error('连接活动默认值不能包含重复项。')
    for (const activityKey of activityKeys) {
      const definition = descriptor.activities.find((activity) => activity.key === activityKey)
      const capability = this.connectionCapabilities(connectionId)?.activities[activityKey]
      if (
        definition?.scope !== 'channel' ||
        !definition.triggerable ||
        capability?.state === 'disabled' ||
        capability?.state === 'unsupported'
      ) {
        throw new Error(`当前连接不支持活动触发：${activityKey}`)
      }
    }
    const updated = this.core.updateConnectionActivityTriggerDefaults(connectionId, activityKeys)
    this.#notifyConnectionChanges()
    return updated
  }

  async deleteConnection(
    connectionId: ConnectionId,
    options: { readonly deleteChannelData: boolean },
  ): Promise<{ readonly archived: boolean }> {
    if (this.#disposed) throw new Error('NekroRuntime is disposed.')
    if (connectionId === this.internalConnectionId) throw new Error('系统托管连接不能删除。')
    const connection = this.core.getConnection(connectionId) ?? this.repository.getArchivedConnection(connectionId)
    if (!connection) throw new Error('连接不存在。')
    const active = this.core.getConnection(connectionId)
    if (active) {
      for (const channel of this.core.listChannelsByConnection(connectionId))
        await this.channels.suspendChannel(channel.id)
      await this.channels.waitUntilConnectionsSafe([connectionId])
      const runtime = this.#adapterRuntimes.get(connectionId)
      await runtime?.stop()
      this.#adapterRuntimes.delete(connectionId)
    }
    this.#adapterDiagnostics.delete(connectionId)
    this.#connectionTests.delete(connectionId)
    if (options.deleteChannelData) {
      this.core.purgeConnection(connectionId)
      await Promise.allSettled(
        Object.values(connection.credentialRefs).map((reference) => this.credentials.delete(reference)),
      )
      this.#notifyConnectionChanges()
      return { archived: false }
    }
    if (active) this.core.archiveConnection(connectionId)
    this.#notifyConnectionChanges()
    return { archived: true }
  }

  async restoreConnection(connectionId: ConnectionId): Promise<ConnectionRecord> {
    if (!this.#started || this.#disposed) throw new Error('NekroRuntime is not accepting restored Connections.')
    const archived = this.repository.getArchivedConnection(connectionId)
    if (!archived) throw new Error('可恢复的连接不存在。')
    if (this.adapters.get(archived.adapterKey)?.descriptor.provisioning !== 'user-created') {
      throw new Error('这个连接当前无法恢复。')
    }
    const connection = this.core.restoreConnection(connectionId)
    await this.#mountAdapter(connectionId)
    this.#notifyConnectionChanges()
    return connection
  }

  async testConnection(
    connectionId: ConnectionId,
    direction: 'send' | 'receive',
    targetChannelId?: ChannelId,
  ): Promise<ConnectionTestResult> {
    const connection = this.core.listConnections().find((candidate) => candidate.id === connectionId)
    if (!connection) throw new Error('Connection does not exist.')
    const descriptor = this.adapters.get(connection.adapterKey)?.descriptor
    if (!descriptor?.diagnostics[direction]) throw new Error('该连接平台不提供这个测试流程。')
    const runtime = this.#adapterRuntimes.get(connectionId)
    const diagnostic = this.#adapterDiagnostics.get(connectionId)
    if (!runtime || diagnostic?.status !== 'connected') {
      return { status: 'not-connected', message: diagnostic?.message ?? '尚未连接到该平台。' }
    }
    if (direction === 'receive') {
      const inbound = this.#lastInboundByConnection.get(connectionId)
      const result: ConnectionTestResult = inbound?.platformMessageId
        ? {
            status: 'received',
            channelId: inbound.channelId,
            platformMessageId: inbound.platformMessageId,
          }
        : { status: 'waiting-for-message', message: '请先从平台发送一条消息，再重新测试接收。' }
      this.#recordConnectionTest(connectionId, direction, result)
      return result
    }
    const channels = this.core.listChannelsByConnection(connectionId)
    if (targetChannelId !== undefined && !channels.some(({ id }) => id === targetChannelId)) {
      throw new Error('测试目标不属于这个连接。')
    }
    const channelId = targetChannelId ?? (channels.length === 1 ? channels[0]?.id : undefined)
    if (!channelId) {
      return channels.length === 0
        ? { status: 'needs-channel', message: '尚未发现频道；请先从平台发送一条消息。' }
        : { status: 'needs-target', message: '该连接发现了多个频道，请选择发送测试的目标频道。' }
    }
    try {
      const parts = [{ type: 'text' as const, text: 'NekroNXT 连接诊断测试消息。' }]
      const plans = runtime.planOutbound ? await runtime.planOutbound({ connectionId, channelId, parts }) : [{ parts }]
      let platformMessageId: string | undefined
      for (const [index, plan] of plans.entries()) {
        const receipt = await runtime.deliver(
          {
            deliveryId: PhysicalDeliveryIdSchema.parse(`phy_TEST${this.#now()}${index}`),
            logicalMessageId: LogicalMessageIdSchema.parse(`msg_TEST${this.#now()}${index}`),
            connectionId,
            channelId,
            parts: plan.parts,
            ...(plan.adapterContext === undefined ? {} : { adapterContext: plan.adapterContext }),
          },
          AbortSignal.timeout(15_000),
        )
        if (receipt.status === 'failed') {
          return { status: 'failed', kind: receipt.failure.kind, message: receipt.failure.message }
        }
        if (receipt.status === 'unknown') return { status: 'failed', kind: 'transient', message: receipt.message }
        platformMessageId = receipt.platformMessageId ?? platformMessageId
      }
      const result: ConnectionTestResult = {
        status: 'sent',
        channelId,
        ...(platformMessageId === undefined ? {} : { platformMessageId }),
      }
      this.#recordConnectionTest(connectionId, direction, result)
      return result
    } catch (error) {
      return { status: 'failed', kind: 'transient', message: error instanceof Error ? error.message : String(error) }
    }
  }

  connectionCapabilities(connectionId: ConnectionId) {
    return this.#adapterRuntimes.get(connectionId)?.capabilities
  }

  #recordConnectionTest(connectionId: ConnectionId, direction: 'send' | 'receive', result: ConnectionTestResult): void {
    this.#connectionTests.set(connectionId, { ...this.#connectionTests.get(connectionId), [direction]: result })
    this.#notifyConnectionChanges()
  }

  registerAdapter(owner: string, contribution: AdapterHostContributionV2): Promise<RegisteredAdapterHandle> {
    const registered = this.adapters.register(owner, contribution)
    this.#cleanAdapterBindings(contribution.descriptor.key)
    this.#notifyConnectionChanges()
    return Promise.resolve({
      ...registered,
      dispose: async () => {
        await this.stopAdapterConnections(contribution.descriptor.key)
        await registered.dispose()
        this.#notifyConnectionChanges()
      },
    })
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

  async mountAdapterConnections(adapterKey: string): Promise<void> {
    this.#quiescingAdapterKeys.delete(adapterKey)
    for (const connectionId of this.repository.listConnectionIdsByAdapter(adapterKey))
      await this.#mountAdapter(connectionId)
  }

  async stopAdapterConnections(adapterKey: string): Promise<void> {
    const connectionIds = this.repository.listConnectionIdsByAdapter(adapterKey)
    const outcomes = await Promise.allSettled(
      connectionIds.map(async (connectionId) => {
        const runtime = this.#adapterRuntimes.get(connectionId)
        await runtime?.stop()
        this.#adapterRuntimes.delete(connectionId)
        this.#adapterDiagnostics.set(connectionId, { status: 'stopped', message: '这个连接的适配器未安装。' })
      }),
    )
    this.#notifyConnectionChanges()
    const failures = outcomes
      .map((outcome, index) => ({ outcome, connectionId: connectionIds[index]! }))
      .filter(
        (item): item is { outcome: PromiseRejectedResult; connectionId: ConnectionId } =>
          item.outcome.status === 'rejected',
      )
    if (failures.length) {
      this.#quiescingAdapterKeys.delete(adapterKey)
      for (const { connectionId, outcome } of failures) {
        this.#adapterDiagnostics.set(connectionId, {
          status: 'failed',
          message: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
        })
      }
      const remounts = await Promise.allSettled(
        outcomes.flatMap((outcome, index) =>
          outcome.status === 'fulfilled' ? [this.#mountAdapter(connectionIds[index]!)] : [],
        ),
      )
      const remountFailures = remounts
        .filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
        .map((outcome): unknown => outcome.reason)
      this.#notifyConnectionChanges()
      throw new AggregateError(
        [
          ...failures.map(({ outcome }) =>
            outcome.reason instanceof Error ? outcome.reason : new Error(String(outcome.reason)),
          ),
          ...remountFailures,
        ],
        '适配器连接未能全部静止；安装状态保持不变。',
      )
    }
  }

  async #mountAdapter(connectionId: ConnectionId): Promise<void> {
    if (this.#adapterRuntimes.has(connectionId)) return
    const connection = this.core.getConnection(connectionId)
    if (!connection) throw new Error('Connection does not exist.')
    const contribution = this.adapters.get(connection.adapterKey)
    if (!contribution) {
      this.#adapterDiagnostics.set(connectionId, { status: 'stopped', message: '这个连接的适配器未安装。' })
      this.#notifyConnectionChanges()
      return
    }
    this.#cleanConnectionBindings(connectionId, contribution)
    let credentialsAvailable = true
    try {
      for (const reference of Object.values(connection.credentialRefs)) {
        let available = false
        try {
          available = await this.credentials.has(reference)
        } catch {
          available = false
        }
        if (!available) {
          credentialsAvailable = false
          throw new Error('这个连接的凭据不可用。')
        }
      }
      const configuration = parseStoredAdapterConfiguration(connection.config)
      const runtime = await contribution.create(this.#adapterContext(connectionId), {
        configuration,
        credentialRefs: connection.credentialRefs,
      })
      const capabilities = parseAdapterCapabilities(runtime.capabilities)
      const declaredActivityKeys = new Set(contribution.descriptor.activities.map((activity) => activity.key))
      const capabilityKeys = Object.keys(capabilities.activities)
      if (
        capabilityKeys.some((key) => !declaredActivityKeys.has(key)) ||
        contribution.descriptor.activities.some((activity) => capabilities.activities[activity.key] === undefined)
      ) {
        throw new Error('Adapter runtime activity capabilities do not match its Descriptor.')
      }
      if (
        (contribution.descriptor.features.processingFeedback === undefined) !==
        (capabilities.processingFeedback === undefined)
      ) {
        throw new Error('Adapter runtime processing-feedback capability does not match its Descriptor.')
      }
      this.#adapterRuntimes.set(connectionId, runtime)
      this.#adapterDiagnostics.set(connectionId, {
        status: 'connecting',
        credentialConfigured: Object.keys(connection.credentialRefs).length > 0,
        proactiveSend: runtime.capabilities.outbound.proactiveSend,
      })
      await runtime.start()
      if (this.#adapterDiagnostics.get(connectionId)?.status === 'connecting') {
        this.#adapterDiagnostics.set(connectionId, {
          status: 'connected',
          credentialConfigured: Object.keys(connection.credentialRefs).length > 0,
          proactiveSend: runtime.capabilities.outbound.proactiveSend,
        })
      }
    } catch (error) {
      const runtime = this.#adapterRuntimes.get(connectionId)
      this.#adapterRuntimes.delete(connectionId)
      await runtime?.stop().catch(() => undefined)
      this.#adapterDiagnostics.set(connectionId, {
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
        credentialConfigured: credentialsAvailable && Object.keys(connection.credentialRefs).length > 0,
      })
    }
    this.#notifyConnectionChanges()
  }

  #cleanAdapterBindings(adapterKey: string): void {
    const contribution = this.adapters.get(adapterKey)
    if (!contribution) return
    for (const connectionId of this.repository.listConnectionIdsByAdapter(adapterKey)) {
      this.#cleanConnectionBindings(connectionId, contribution)
    }
  }

  #cleanConnectionBindings(connectionId: ConnectionId, contribution: AdapterHostContributionV2): void {
    const connection = this.core.getConnection(connectionId)
    if (connection) {
      const activityTriggerDefaults = connection.activityTriggerDefaults.filter((key) => {
        const definition = contribution.descriptor.activities.find((activity) => activity.key === key)
        return definition?.scope === 'channel' && definition.triggerable
      })
      if (activityTriggerDefaults.length !== connection.activityTriggerDefaults.length) {
        this.repository.updateConnectionActivityTriggerDefaults(connectionId, activityTriggerDefaults)
      }
    }
    for (const channel of this.core.listChannelsByConnection(connectionId)) {
      const binding = this.repository.getBinding(channel.id)
      if (!binding) continue
      const activityTriggerOverrides = Object.fromEntries(
        Object.entries(binding.activityTriggerOverrides).filter(([key]) => {
          const definition = contribution.descriptor.activities.find((activity) => activity.key === key)
          return (
            definition?.scope === 'channel' &&
            definition.triggerable &&
            definition.channelKinds?.includes(channel.kind) === true
          )
        }),
      )
      if (Object.keys(activityTriggerOverrides).length !== Object.keys(binding.activityTriggerOverrides).length) {
        this.repository.replaceBinding({ ...binding, activityTriggerOverrides })
      }
    }
  }

  #adapterContext(connectionId: ConnectionId): AdapterConnectionHostContext {
    const rejectEvent = (message: string): never => {
      const current = this.#adapterDiagnostics.get(connectionId)
      this.#adapterDiagnostics.set(connectionId, {
        status: current?.status ?? 'connected',
        message,
        credentialConfigured: current?.credentialConfigured ?? false,
        proactiveSend: current?.proactiveSend ?? false,
        details: { eventRejected: true },
      })
      this.#notifyConnectionChanges()
      throw new Error(message)
    }
    const resolveOwnedDescriptor = (adapterKey: string) => {
      const connection = this.core.getConnection(connectionId)
      if (!connection || connection.adapterKey !== adapterKey) {
        return rejectEvent('适配器提交的事件不属于当前连接。')
      }
      const descriptor = this.adapters.get(connection.adapterKey)?.descriptor
      if (!descriptor) return rejectEvent('提交事件的适配器当前未注册。')
      return descriptor
    }
    return {
      connectionId,
      now: this.#now,
      acceptChannelInbound: async (event) => {
        if (event.connectionId !== connectionId) return rejectEvent('适配器提交了其他连接的频道事件。')
        const adapterKey = this.core.getConnection(connectionId)?.adapterKey
        if (adapterKey && this.#quiescingAdapterKeys.has(adapterKey)) {
          throw new Error('适配器正在进入安全间隙，暂不接收新的频道事件。')
        }
        const descriptor = resolveOwnedDescriptor(event.adapterKey)
        const channel = this.core.getChannel(event.channelId)
        if (!channel || channel.connectionId !== connectionId) {
          return rejectEvent('适配器提交的频道事件不属于当前连接。')
        }
        if (event.activityKey !== undefined) {
          const activity = descriptor.activities.find((candidate) => candidate.key === event.activityKey)
          if (activity?.scope !== 'channel') return rejectEvent(`适配器提交了未声明的频道活动：${event.activityKey}`)
          if (activity.channelKinds?.includes(channel.kind) !== true) {
            return rejectEvent(`频道活动 ${event.activityKey} 不适用于当前频道类型。`)
          }
        }
        this.#lastInboundByConnection.set(connectionId, {
          channelId: event.channelId,
          ...(event.platformMessageId === undefined ? {} : { platformMessageId: event.platformMessageId }),
          receivedAt: event.receivedAt,
        })
        return this.channels.acceptChannelInbound(event)
      },
      acceptConnectionInbound: (event) => {
        if (event.connectionId !== connectionId) return rejectEvent('适配器提交了其他连接的连接活动。')
        const descriptor = resolveOwnedDescriptor(event.adapterKey)
        const activity = descriptor.activities.find((candidate) => candidate.key === event.activityKey)
        if (activity?.scope !== 'connection') {
          return rejectEvent(`适配器提交了未声明的连接活动：${event.activityKey}`)
        }
        const commit = this.core.appendConnectionInbound(event)
        if (commit.inserted) this.#notifyConnectionChanges(commit.event)
        return Promise.resolve({ connectionEventId: commit.event.id, inserted: commit.inserted })
      },
      channels: {
        ensure: (input) =>
          Promise.resolve(
            this.core.ensureChannel({
              connectionId,
              platformChannelId: input.platformChannelId,
              kind: input.kind,
              ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
              observedAt: input.observedAt,
            }).id,
          ),
        updateDisplayName: (channelId, displayName) => {
          const channel = this.core.getChannel(channelId)
          if (channel?.connectionId !== connectionId)
            throw new Error('Adapter cannot update another Connection channel.')
          this.core.updateChannelDisplayName(channelId, displayName)
          return Promise.resolve()
        },
        resolvePlatformChannelId: (channelId) => {
          const channel = this.core.getChannel(channelId)
          return Promise.resolve(channel?.connectionId === connectionId ? channel.platformChannelId : undefined)
        },
        resolveKind: (channelId) => {
          const channel = this.core.getChannel(channelId)
          return Promise.resolve(
            channel?.connectionId !== connectionId || channel.kind === 'internal' ? undefined : channel.kind,
          )
        },
      },
      identities: {
        ensure: (input) =>
          Promise.resolve(
            this.core.ensurePlatformIdentity({
              connectionId,
              platformUserId: input.platformUserId,
              ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
              observedAt: input.observedAt,
            }).id,
          ),
      },
      members: {
        ensure: (input) =>
          Promise.resolve(
            this.core.observeChannelMember({
              connectionId,
              channelId: input.channelId,
              platformUserId: input.platformUserId,
              ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
              observedAt: input.observedAt,
            }).member.id,
          ),
        resolvePlatformUserId: (channelId, memberId) =>
          Promise.resolve(this.core.resolveChannelMemberIdentity(connectionId, channelId, memberId)?.platformUserId),
      },
      messages: {
        resolvePlatformMessage: (channelId, platformMessageId) =>
          Promise.resolve(this.core.resolvePlatformMessage(connectionId, channelId, platformMessageId)),
        resolvePlatformMessageId: (channelId, logicalMessageId) =>
          Promise.resolve(this.core.resolveLogicalMessagePlatformId(connectionId, channelId, logicalMessageId)),
        resolveLogicalMessage: (channelId, logicalMessageId) =>
          Promise.resolve(this.repository.resolveLogicalMessage(connectionId, channelId, logicalMessageId)),
      },
      assets: {
        importBytes: async (input) => {
          const prepared = await this.assetService.prepare(input)
          return {
            assetId: prepared.asset.id,
            mediaType: prepared.asset.mediaType,
            byteSize: prepared.asset.byteSize,
          }
        },
        read: async ({ assetId, channelId }) => {
          if (!this.repository.canAccessAsset(assetId, channelId)) {
            throw new Error('Adapter Asset is not authorized for this Channel.')
          }
          const asset = this.repository.getAssetById(assetId)
          if (!asset) throw new Error('Adapter Asset is unavailable.')
          return {
            bytes: new Uint8Array(await readFile(this.assetService.blobPath(asset))),
            mediaType: asset.mediaType,
            byteSize: asset.byteSize,
          }
        },
        fetchRemoteBytes: fetchAdapterRemoteBytes,
      },
      credentials: { resolve: (reference) => this.credentials.resolve(reference) },
      state: {
        load: (key) => this.repository.load(connectionId, key),
        save: (key, value) => this.repository.save(connectionId, key, value, this.#now()),
        clear: (key) => this.repository.clear(connectionId, key),
      },
      diagnostics: {
        publish: (diagnostic) => {
          this.#adapterDiagnostics.set(connectionId, {
            ...diagnostic,
            credentialConfigured: Object.keys(this.core.getConnection(connectionId)?.credentialRefs ?? {}).length > 0,
            proactiveSend: this.#adapterRuntimes.get(connectionId)?.capabilities.outbound.proactiveSend ?? false,
          })
          this.#notifyConnectionChanges()
        },
      },
      transport: this.#adapterTransport,
    }
  }

  #notifyConnectionChanges(event?: ConnectionEventRecord): void {
    for (const listener of this.#connectionListeners) {
      try {
        listener(event)
      } catch {
        // A diagnostic observer cannot interrupt the owned Connection lifecycle.
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    await this.authoring.dispose()
    const failures: unknown[] = []
    this.#unsubscribeDynamicApproval()
    this.#connectionListeners.clear()
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
    const stopped = await Promise.allSettled([...this.#adapterRuntimes.values()].map((runtime) => runtime.stop()))
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
    const handles = await Promise.allSettled(this.#adapterHandles.map((handle) => handle.dispose()))
    for (const outcome of handles) if (outcome.status === 'rejected') failures.push(outcome.reason)
    this.#adapterHandles.length = 0
    this.#adapterDiagnostics.clear()
    this.#connectionTests.clear()
    this.#hostClientDiagnostics.clear()
    this.#lastInboundByConnection.clear()
    this.#adapterRuntimes.clear()
    this.#database.close()
    if (failures.length) throw new AggregateError(failures, 'Nekro Runtime disposal failed.')
  }
}
