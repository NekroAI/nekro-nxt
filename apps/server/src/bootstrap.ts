import type { Context } from '@deepseek-ai/cordis'
import { createWebAdapterConnection, WEB_HOST_CONTRIBUTION } from '@nekro-nxt/adapter-web'
import type { WebAdapterConnection } from '@nekro-nxt/adapter-web'
import { createOneBot11HostContribution } from '@nekro-nxt/adapter-onebot-11'
import { createWeComAiBotHostContribution } from '@nekro-nxt/adapter-wecom-ai-bot'
import {
  AdapterRegistry,
  type AdapterConnectionHostContext,
  type AdapterConnectionDiagnostic,
  type AdapterConnectionRuntime,
  type AdapterHostContributionV1,
  type AdapterTransportService,
  type RegisteredAdapterHandle,
} from '@nekro-nxt/adapter-sdk'
import {
  createQQGatewayCheckpointStore,
  QQNodeWebSocketFactory,
  QQOpenClawConfigSchema,
  QQOpenClawHttpTransport,
  QQOpenClawRuntime,
  QQ_OPENCLAW_CONNECTION_DEFINITION,
  type QQGatewayClock,
  type QQGatewaySocketFactory,
  type QQGatewayStatus,
  type QQOpenClawConnectionInput,
} from '@nekro-nxt/adapter-qq-openclaw'
import { ChannelRuntime } from '@nekro-nxt/channel-runtime'
import { AssetService, CoreService } from '@nekro-nxt/core'
import type { AgentRevisionContent, ConnectionRecord } from '@nekro-nxt/core'
import {
  LogicalMessageIdSchema,
  PhysicalDeliveryIdSchema,
  type AgentId,
  type ChannelId,
  type ConnectionId,
  type ExtensionId,
  type ExtensionRevisionId,
  type JsonValue,
} from '@nekro-nxt/contracts'
import {
  ExtensionActivationCoordinator,
  ExtensionBuilder,
  ExtensionService,
  ExtensionSourceStore,
  HostExtensionInstallationCoordinator,
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
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { monotonicFactory } from 'ulid'
import { ChannelExtensionActivationHost, DshHostRuntime } from './index.js'
import { fetchAdapterRemoteBytes } from './adapter-remote-assets.js'
import { LocalCredentialStore } from './credentials.js'
import { NotificationService } from './notifications.js'
import { QQCoreBridge, QQRemoteAssetImporter } from './qq-openclaw.js'
import { ServerAdapterHostInstallationHost } from './host-extension-installation.js'
import { createProductionAdapterTransport } from './adapter-transport.js'

const StoredQQConnectionConfigSchema = QQOpenClawConfigSchema.omit({ clientSecretCredentialRef: true })

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
  readonly qq?: {
    readonly fetch?: typeof fetch
    readonly sockets?: QQGatewaySocketFactory
    readonly clock?: QQGatewayClock
  }
  readonly notifications?: { readonly fetch?: typeof fetch }
  /** Replaced by an offline Fake for tests and AI validation; production uses fetch/ws. */
  readonly adapterTransport?: AdapterTransportService
}

export interface QQConnectionDiagnostic {
  readonly gateway: QQGatewayStatus
  readonly credentialConfigured: boolean
  readonly knownChannelIds: readonly ChannelId[]
  readonly lastInbound?: {
    readonly channelId: ChannelId
    readonly platformMessageId: string
    readonly receivedAt: number
  }
  readonly receiveTest?: ConnectionTestResult
  readonly sendTest?: ConnectionTestResult
}

export type ConnectionTestResult =
  | { readonly status: 'received'; readonly channelId: ChannelId; readonly platformMessageId: string }
  | { readonly status: 'sent'; readonly channelId: ChannelId; readonly platformMessageId?: string }
  | {
      readonly status: 'waiting-for-message' | 'needs-channel' | 'needs-target' | 'not-connected'
      readonly message: string
    }
  | { readonly status: 'failed'; readonly kind: string; readonly message: string; readonly retryAfterMs?: number }

const systemGatewayClock = (): QQGatewayClock => ({
  now: Date.now,
  sleep: (delayMs, signal) =>
    new Promise<void>((resolve, reject) => {
      const finish = (): void => {
        signal.removeEventListener('abort', abort)
        resolve()
      }
      const timer = setTimeout(finish, delayMs)
      const abort = (): void => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        reject(signal.reason instanceof Error ? signal.reason : new Error('QQ Gateway sleep aborted.'))
      }
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    }),
  setInterval: (callback, intervalMs) => {
    const timer = setInterval(callback, intervalMs)
    return () => clearInterval(timer)
  },
})

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
  readonly host: DshHostRuntime
  readonly channels: ChannelRuntime
  readonly web: WebAdapterConnection
  readonly webConnectionId: ConnectionId
  readonly extensionService: ExtensionService
  readonly activation: ExtensionActivationCoordinator
  readonly installation: HostExtensionInstallationCoordinator
  readonly credentials: LocalCredentialStore
  readonly notifications: NotificationService
  readonly sessionStoragePreparation: DshSessionStoragePreparation
  readonly sessionStorageRetirement:
    { readonly episodesClosed: number; readonly admissionsReleased: number } | undefined
  readonly #database: CoreDatabase
  readonly #now: () => number
  readonly #qqOptions: NonNullable<NekroRuntimeOptions['qq']>
  readonly adapters: AdapterRegistry
  readonly #adapterHandles: RegisteredAdapterHandle[] = []
  readonly #adapterRuntimes: Map<ConnectionId, AdapterConnectionRuntime>
  readonly #adapterTransport: AdapterTransportService
  readonly #qqDiagnostics = new Map<ConnectionId, QQConnectionDiagnostic>()
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
  readonly #connectionListeners = new Set<() => void>()
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
    readonly web: WebAdapterConnection
    readonly webConnectionId: ConnectionId
    readonly extensionService: ExtensionService
    readonly activation: ExtensionActivationCoordinator
    readonly extensionBuilder: ExtensionBuilder
    readonly credentials: LocalCredentialStore
    readonly notifications: NotificationService
    readonly unsubscribeDynamicApproval: () => void
    readonly sessionStoragePreparation: DshSessionStoragePreparation
    readonly sessionStorageRetirement?: { readonly episodesClosed: number; readonly admissionsReleased: number }
    readonly now: () => number
    readonly qqOptions: NonNullable<NekroRuntimeOptions['qq']>
    readonly adapters: AdapterRegistry
    readonly adapterRuntimes: Map<ConnectionId, AdapterConnectionRuntime>
    readonly adapterTransport: AdapterTransportService
  }) {
    this.#database = input.database
    this.repository = input.repository
    this.hostSecurity = input.hostSecurity
    this.assetService = input.assetService
    this.core = input.core
    this.host = input.host
    this.channels = input.channels
    this.web = input.web
    this.webConnectionId = input.webConnectionId
    this.extensionService = input.extensionService
    this.activation = input.activation
    this.credentials = input.credentials
    this.notifications = input.notifications
    this.#unsubscribeDynamicApproval = input.unsubscribeDynamicApproval
    this.sessionStoragePreparation = input.sessionStoragePreparation
    this.sessionStorageRetirement = input.sessionStorageRetirement
    this.#now = input.now
    this.#qqOptions = input.qqOptions
    this.adapters = input.adapters
    this.#adapterRuntimes = input.adapterRuntimes
    this.#adapterTransport = input.adapterTransport
    this.#adapterDiagnostics.set(input.webConnectionId, {
      status: 'connected',
      credentialConfigured: true,
      proactiveSend: true,
    })
    this.#adapterHandles.push(
      this.adapters.register('builtin:web', WEB_HOST_CONTRIBUTION),
      this.adapters.register('builtin:qq-openclaw', this.#qqHostContribution()),
      this.adapters.register('builtin:onebot-11', createOneBot11HostContribution()),
      this.adapters.register('builtin:wecom-ai-bot', createWeComAiBotHostContribution()),
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
        waitUntilSafe: () => Promise.resolve(),
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
      const core = new CoreService(repository, { now, nextUlid })
      const adapters = new AdapterRegistry()
      const webConnection =
        core.listConnectionsByAdapter('web')[0] ?? core.createConnection({ adapterKey: 'web', config: {} })
      const webConnectionId = webConnection.id
      const adapterRuntimes = new Map<ConnectionId, AdapterConnectionRuntime>()

      // Channel Runtime and the Web Adapter reference each other lazily: the
      // adapter edits inbound through acceptInbound, the runtime dispatches
      // outbound through the adapter. Use a settled pointer bridge exactly as
      // the vertical-slice tests do.
      const settled: { current?: ChannelRuntime } = {}

      const web = createWebAdapterConnection(
        webConnectionId,
        (event) => {
          if (!settled.current) return Promise.reject(new Error('Channel Runtime is not ready.'))
          return settled.current.acceptInbound(event)
        },
        now,
      )
      adapterRuntimes.set(webConnectionId, web)

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
        ...(options.llmSettingsPath === undefined ? {} : { llmSettingsPath: options.llmSettingsPath }),
        ...(options.llmCredentialPath === undefined ? {} : { llmCredentialPath: options.llmCredentialPath }),
        ...(options.configureLlm === undefined ? {} : { configureLlm: options.configureLlm }),
      })

      const channels = new ChannelRuntime(core, repository, repository, host, {
        now,
        nextUlid,
        idleRolloverMs: options.idleRolloverMs ?? 6 * 60 * 60 * 1000,
        resolveAdapter: (id): AdapterConnectionRuntime | undefined =>
          id === webConnectionId ? web : adapterRuntimes.get(id),
        adapterState: repository,
      })
      settled.current = channels

      const sourceStore = new ExtensionSourceStore(options.extensionDataRoot)
      const extensionBuilder = new ExtensionBuilder(options.extensionCacheRoot)
      const extensionService = new ExtensionService(repository, sourceStore, {
        now,
        nextUlid,
        builder: extensionBuilder,
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
        web,
        webConnectionId,
        extensionService,
        activation,
        extensionBuilder,
        credentials,
        notifications,
        unsubscribeDynamicApproval,
        sessionStoragePreparation,
        ...(sessionStorageRetirement === undefined ? {} : { sessionStorageRetirement }),
        now,
        qqOptions: options.qq ?? {},
        adapters,
        adapterRuntimes,
        adapterTransport: options.adapterTransport ?? createProductionAdapterTransport(),
      })
      return runtime
    } catch (error) {
      database.close()
      throw error
    }
  }

  /** Start the Web Adapter so HTTP-posted messages can be admitted. */
  async start(): Promise<void> {
    if (this.#disposed) throw new Error('NekroRuntime is disposed.')
    if (this.#started) throw new Error('NekroRuntime is already started.')
    this.#started = true
    await this.web.start()
  }

  /** Every deliberate Agent entity this Server owns, in creation order. */
  agents(): readonly AgentEntity[] {
    return [...this.#agents.values()]
  }

  /**
   * Closed-loop A primitive: create an intelligent-agent, ensure a Web Channel
   * for it, and bind them with `always` so every Web message triggers a reply.
   */
  async createAgentWithWebChannel(content: AgentRevisionContent): Promise<AgentEntity> {
    const models = await this.host.listAvailableLlmModels()
    if (!models.some((model) => model.provider === content.model.provider && model.id === content.model.model)) {
      throw new Error(`模型未在当前 DSH Provider 目录注册：${content.model.provider}/${content.model.model}`)
    }
    const agent = this.core.createAgentWithChannel(content, {
      connectionId: this.webConnectionId,
      kind: 'web',
      displayName: `${content.displayName.trim()} 的内置频道`,
      triggerPolicy: 'always',
    })
    const entity: AgentEntity = {
      agentId: agent.definition.id,
      channelId: agent.channel.id,
      connectionId: this.webConnectionId,
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
      ? boundChannels.filter((channel) => channel.kind === 'web' && channel.autoCreatedForAgentId === agentId)
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
    this.core.deleteAgent(agentId)
    this.#agents.delete(agentId)
    return { unboundChannelIds, deletedChannelIds }
  }

  /** Resume persisted Episodes, Admissions, Outbounds and active Extensions after a cold start. */
  async recover(): Promise<void> {
    await this.installation.restore()
    for (const connection of this.core.listConnections()) {
      await this.#mountAdapter(connection.id)
    }
    await this.channels.recoverProcessingFeedback()
    await this.channels.recover()
    await this.activation.restore()
  }

  subscribeConnectionChanges(listener: () => void): () => void {
    this.#connectionListeners.add(listener)
    return () => this.#connectionListeners.delete(listener)
  }

  connectionDiagnostic(connectionId: ConnectionId): QQConnectionDiagnostic | undefined {
    const legacy = this.#qqDiagnostics.get(connectionId)
    if (legacy) return legacy
    const diagnostic = this.#adapterDiagnostics.get(connectionId)
    if (!diagnostic) return undefined
    const tests = this.#connectionTests.get(connectionId)
    return {
      gateway: {
        state: diagnostic.status,
        ...(diagnostic.message === undefined ? {} : { lastError: diagnostic.message }),
      },
      credentialConfigured: diagnostic.credentialConfigured ?? false,
      knownChannelIds: this.core.listChannelsByConnection(connectionId).map((channel) => channel.id),
      ...(tests?.receive === undefined ? {} : { receiveTest: tests.receive }),
      ...(tests?.send === undefined ? {} : { sendTest: tests.send }),
    }
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
    if (!contribution?.descriptor.userCreatable) throw new Error('该连接平台不可由用户创建。')
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

  async createQQConnection(input: QQOpenClawConnectionInput, alias?: string) {
    return this.createConnection({
      adapterKey: QQ_OPENCLAW_CONNECTION_DEFINITION.descriptor.key,
      ...(alias === undefined ? {} : { alias }),
      configuration: {
        appId: input.appId,
        proactiveSend: input.proactiveSend ?? false,
        markdown: input.markdown ?? true,
        maxTextLength: input.maxTextLength ?? 1800,
        maxTextBytes: input.maxTextBytes ?? 7200,
      },
      credentials: { clientSecretCredentialRef: input.clientSecret },
    })
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
    const current = this.#qqDiagnostics.get(connectionId)
    if (!current) return
    this.#setQQDiagnostic(connectionId, {
      ...current,
      ...(direction === 'send' ? { sendTest: result } : { receiveTest: result }),
    })
  }

  registerAdapter(owner: string, contribution: AdapterHostContributionV1): Promise<RegisteredAdapterHandle> {
    const registered = this.adapters.register(owner, contribution)
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

  uninstallHostExtension(extensionId: Parameters<HostExtensionInstallationCoordinator['uninstall']>[0]): Promise<void> {
    return this.installation.uninstall(extensionId)
  }

  async mountAdapterConnections(adapterKey: string): Promise<void> {
    for (const connectionId of this.repository.listConnectionIdsByAdapter(adapterKey))
      await this.#mountAdapter(connectionId)
  }

  async stopAdapterConnections(adapterKey: string): Promise<void> {
    const connectionIds = this.repository.listConnectionIdsByAdapter(adapterKey)
    await Promise.allSettled(
      connectionIds.map(async (connectionId) => {
        const runtime = this.#adapterRuntimes.get(connectionId)
        this.#adapterRuntimes.delete(connectionId)
        await runtime?.stop()
        this.#adapterDiagnostics.set(connectionId, { status: 'stopped', message: '这个连接的适配器未安装。' })
      }),
    )
    this.#notifyConnectionChanges()
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
      this.#adapterRuntimes.set(connectionId, runtime)
      this.#adapterDiagnostics.set(connectionId, {
        status: 'connecting',
        credentialConfigured: Object.keys(connection.credentialRefs).length > 0,
        proactiveSend: runtime.capabilities.proactiveSend,
      })
      await runtime.start()
      if (this.#adapterDiagnostics.get(connectionId)?.status === 'connecting') {
        this.#adapterDiagnostics.set(connectionId, {
          status: 'connected',
          credentialConfigured: Object.keys(connection.credentialRefs).length > 0,
          proactiveSend: runtime.capabilities.proactiveSend,
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

  #adapterContext(connectionId: ConnectionId): AdapterConnectionHostContext {
    return {
      connectionId,
      now: this.#now,
      acceptInbound: async (event) => {
        this.#lastInboundByConnection.set(connectionId, {
          channelId: event.channelId,
          ...(event.platformMessageId === undefined ? {} : { platformMessageId: event.platformMessageId }),
          receivedAt: event.receivedAt,
        })
        return this.channels.acceptInbound(event)
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
            channel?.connectionId !== connectionId || channel.kind === 'web' ? undefined : channel.kind,
          )
        },
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
            proactiveSend: this.#adapterRuntimes.get(connectionId)?.capabilities.proactiveSend ?? false,
          })
          this.#notifyConnectionChanges()
        },
      },
      transport: this.#adapterTransport,
    }
  }

  #qqHostContribution(): AdapterHostContributionV1 {
    return {
      apiVersion: 1,
      descriptor: QQ_OPENCLAW_CONNECTION_DEFINITION.descriptor,
      create: (context, stored) => {
        const connectionId = context.connectionId
        const config = StoredQQConnectionConfigSchema.parse(stored.configuration)
        const credentialReference = stored.credentialRefs['clientSecret']
        if (!credentialReference) throw new Error('这个连接的凭据不可用。')
        const transport = new QQOpenClawHttpTransport({
          appId: config.appId,
          clientSecretCredentialRef: credentialReference,
          credentials: this.credentials,
          ...(this.#qqOptions.fetch === undefined ? {} : { fetch: this.#qqOptions.fetch }),
          now: this.#now,
        })
        const bridge = new QQCoreBridge(
          this.core,
          new QQRemoteAssetImporter(this.assetService, {
            ...(this.#qqOptions.fetch === undefined ? {} : { fetch: this.#qqOptions.fetch }),
          }),
        )
        const runtime = new QQOpenClawRuntime({
          context: {
            ...context,
            acceptInbound: async (event) => {
              const result = await context.acceptInbound(event)
              if (event.platformMessageId) {
                this.#setQQDiagnostic(connectionId, {
                  gateway: this.#qqDiagnostics.get(connectionId)?.gateway ?? { state: 'connected' },
                  credentialConfigured: true,
                  knownChannelIds: this.core.listChannelsByConnection(connectionId).map((channel) => channel.id),
                  lastInbound: {
                    channelId: event.channelId,
                    platformMessageId: event.platformMessageId,
                    receivedAt: event.receivedAt,
                  },
                })
              }
              return result
            },
          },
          config: {
            appId: config.appId,
            clientSecretCredentialRef: credentialReference,
            proactiveSend: config.proactiveSend,
            markdown: config.markdown,
            maxTextLength: config.maxTextLength,
            maxTextBytes: config.maxTextBytes,
          },
          directory: bridge,
          inbound: bridge,
          assets: {
            read: async (assetId) => {
              const asset = this.repository.getAssetById(assetId)
              if (!asset) throw new Error('QQ outbound Asset is unavailable.')
              return {
                bytes: new Uint8Array(await readFile(this.assetService.blobPath(asset))),
                mediaType: asset.mediaType,
              }
            },
          },
          transport,
          onQuoteDiagnostic: (diagnostic) => {
            console.warn('[nekro-nxt] QQ 引用未解析：', JSON.stringify(diagnostic))
          },
          gateway: {
            access: transport,
            sockets: this.#qqOptions.sockets ?? new QQNodeWebSocketFactory(),
            checkpoints: createQQGatewayCheckpointStore(connectionId, this.repository),
            clock: this.#qqOptions.clock ?? systemGatewayClock(),
            onStatus: (gateway) => {
              this.#setQQDiagnostic(connectionId, {
                ...this.#qqDiagnostics.get(connectionId),
                gateway,
                credentialConfigured: true,
                knownChannelIds: this.core.listChannelsByConnection(connectionId).map((channel) => channel.id),
              })
            },
          },
        })
        return Promise.resolve(runtime)
      },
    }
  }

  #setQQDiagnostic(connectionId: ConnectionId, diagnostic: QQConnectionDiagnostic): void {
    this.#qqDiagnostics.set(connectionId, diagnostic)
    this.#adapterDiagnostics.set(connectionId, {
      status: diagnostic.gateway.state,
      ...(diagnostic.gateway.lastError === undefined ? {} : { message: diagnostic.gateway.lastError }),
      credentialConfigured: diagnostic.credentialConfigured,
      proactiveSend: true,
    })
    this.#notifyConnectionChanges()
  }

  #notifyConnectionChanges(): void {
    for (const listener of this.#connectionListeners) {
      try {
        listener()
      } catch {
        // A diagnostic observer cannot interrupt the owned Connection lifecycle.
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    this.#unsubscribeDynamicApproval()
    this.#connectionListeners.clear()
    await this.channels.stopProcessingFeedback()
    await this.activation.dispose()
    await this.installation.dispose()
    await Promise.allSettled([...this.#adapterRuntimes.values()].map((runtime) => runtime.stop()))
    await this.host.dispose()
    await Promise.allSettled(this.#adapterHandles.map((handle) => handle.dispose()))
    this.#adapterHandles.length = 0
    this.#adapterDiagnostics.clear()
    this.#connectionTests.clear()
    this.#hostClientDiagnostics.clear()
    this.#lastInboundByConnection.clear()
    this.#adapterRuntimes.clear()
    this.#database.close()
  }
}
