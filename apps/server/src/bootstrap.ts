import type { Context } from '@deepseek-ai/cordis'
import { createWebAdapterConnection, WEB_CONNECTION_DEFINITION } from '@nekro-nxt/adapter-web'
import type { WebAdapterConnection } from '@nekro-nxt/adapter-web'
import {
  parseAdapterConnectionConfiguration,
  type AdapterConnectionDescriptor,
  type AdapterConnectionRuntime,
} from '@nekro-nxt/adapter-sdk'
import {
  createQQGatewayCheckpointStore,
  isQQTransportError,
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
import type { AgentId, ChannelId, ConnectionId } from '@nekro-nxt/contracts'
import {
  ExtensionActivationCoordinator,
  ExtensionBuilder,
  ExtensionService,
  ExtensionSourceStore,
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
import { LocalCredentialStore } from './credentials.js'
import { QQCoreBridge, QQRemoteAssetImporter } from './qq-openclaw.js'

const StoredQQConnectionConfigSchema = QQOpenClawConfigSchema.omit({ clientSecretCredentialRef: true })
const ADAPTER_CONNECTION_DEFINITIONS = [WEB_CONNECTION_DEFINITION, QQ_OPENCLAW_CONNECTION_DEFINITION]

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
  | { readonly status: 'sent'; readonly channelId: ChannelId; readonly platformMessageId: string }
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
  readonly credentials: LocalCredentialStore
  readonly sessionStoragePreparation: DshSessionStoragePreparation
  readonly sessionStorageRetirement:
    { readonly episodesClosed: number; readonly admissionsReleased: number } | undefined
  readonly #database: CoreDatabase
  readonly #now: () => number
  readonly #qqOptions: NonNullable<NekroRuntimeOptions['qq']>
  readonly #qqRuntimes = new Map<ConnectionId, QQOpenClawRuntime>()
  readonly #adapterRuntimes: Map<ConnectionId, AdapterConnectionRuntime>
  readonly #qqDiagnostics = new Map<ConnectionId, QQConnectionDiagnostic>()
  readonly #connectionListeners = new Set<() => void>()
  readonly #agents = new Map<AgentId, AgentEntity>()
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
    readonly credentials: LocalCredentialStore
    readonly sessionStoragePreparation: DshSessionStoragePreparation
    readonly sessionStorageRetirement?: { readonly episodesClosed: number; readonly admissionsReleased: number }
    readonly now: () => number
    readonly qqOptions: NonNullable<NekroRuntimeOptions['qq']>
    readonly adapterRuntimes: Map<ConnectionId, AdapterConnectionRuntime>
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
    this.sessionStoragePreparation = input.sessionStoragePreparation
    this.sessionStorageRetirement = input.sessionStorageRetirement
    this.#now = input.now
    this.#qqOptions = input.qqOptions
    this.#adapterRuntimes = input.adapterRuntimes
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
        },
        history: repository,
        resolveAdapterDisplayName: (adapterKey) =>
          ADAPTER_CONNECTION_DEFINITIONS.find((definition) => definition.descriptor.key === adapterKey)?.descriptor
            .displayName,
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
        credentials,
        sessionStoragePreparation,
        ...(sessionStorageRetirement === undefined ? {} : { sessionStorageRetirement }),
        now,
        qqOptions: options.qq ?? {},
        adapterRuntimes,
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
    await this.channels.recover()
    await this.activation.restore()
    for (const connection of this.core.listConnectionsByAdapter('qq-openclaw')) await this.#mountQQ(connection.id)
  }

  subscribeConnectionChanges(listener: () => void): () => void {
    this.#connectionListeners.add(listener)
    return () => this.#connectionListeners.delete(listener)
  }

  connectionDiagnostic(connectionId: ConnectionId): QQConnectionDiagnostic | undefined {
    return this.#qqDiagnostics.get(connectionId)
  }

  listConnectionAdapters(): readonly AdapterConnectionDescriptor[] {
    return ADAPTER_CONNECTION_DEFINITIONS.map(({ descriptor }) => descriptor)
  }

  async createConnection(input: {
    readonly adapterKey: string
    readonly alias?: string | undefined
    readonly configuration?: Readonly<Record<string, unknown>>
    readonly credentials?: Readonly<Record<string, unknown>>
  }) {
    const definition = ADAPTER_CONNECTION_DEFINITIONS.find((candidate) => candidate.descriptor.key === input.adapterKey)
    if (!definition?.descriptor.userCreatable) throw new Error('该连接平台不可由用户创建。')
    if (definition !== QQ_OPENCLAW_CONNECTION_DEFINITION) {
      throw new Error(`连接平台尚未实现创建流程：${definition.descriptor.key}`)
    }
    const parsed = parseAdapterConnectionConfiguration(QQ_OPENCLAW_CONNECTION_DEFINITION, input)
    return this.createQQConnection(
      QQ_OPENCLAW_CONNECTION_DEFINITION.create(parsed.configuration, parsed.credentials),
      input.alias,
    )
  }

  async createQQConnection(input: QQOpenClawConnectionInput, alias?: string) {
    if (!this.#started || this.#disposed) throw new Error('NekroRuntime is not accepting new Connections.')
    const credentialReference = await this.credentials.save(input.clientSecret)
    let connection
    try {
      connection = this.core.createConnection({
        adapterKey: 'qq-openclaw',
        ...(alias === undefined ? {} : { alias }),
        config: {
          appId: input.appId,
          proactiveSend: input.proactiveSend ?? false,
          markdown: input.markdown ?? true,
          maxTextLength: input.maxTextLength ?? 1800,
          maxTextBytes: input.maxTextBytes ?? 7200,
        },
        credentialRefs: { clientSecret: credentialReference },
      })
    } catch (error) {
      await this.credentials.delete(credentialReference)
      throw error
    }
    await this.#mountQQ(connection.id)
    return this.core.listConnections().find((candidate) => candidate.id === connection.id)!
  }

  updateConnectionAlias(connectionId: ConnectionId, alias?: string): ConnectionRecord {
    if (this.#disposed) throw new Error('NekroRuntime is disposed.')
    const connection = this.core.getConnection(connectionId)
    if (!connection) throw new Error('连接不存在。')
    if (connection.adapterKey === 'web') throw new Error('系统托管网页连接不需要编辑别名。')
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
    if (!connection || connection.adapterKey !== 'qq-openclaw') throw new Error('QQ Connection does not exist.')
    const diagnostic = this.#qqDiagnostics.get(connectionId)
    let result: ConnectionTestResult
    if (!diagnostic || diagnostic.gateway.state !== 'connected') {
      result = { status: 'not-connected', message: '尚未连接到该平台；请先检查凭据和网络。' }
      this.#recordConnectionTest(connectionId, direction, result)
      return result
    }
    if (direction === 'receive') {
      result = diagnostic.lastInbound
        ? {
            status: 'received',
            channelId: diagnostic.lastInbound.channelId,
            platformMessageId: diagnostic.lastInbound.platformMessageId,
          }
        : { status: 'waiting-for-message', message: '请先在测试群或私聊中向该机器人账号发送一条消息，再重新测试接收。' }
      this.#recordConnectionTest(connectionId, direction, result)
      return result
    }
    if (targetChannelId !== undefined && !diagnostic.knownChannelIds.includes(targetChannelId)) {
      throw new Error('QQ test target does not belong to this Connection.')
    }
    const channelId =
      targetChannelId ?? (diagnostic.knownChannelIds.length === 1 ? diagnostic.knownChannelIds[0] : undefined)
    if (!channelId) {
      result =
        diagnostic.knownChannelIds.length === 0
          ? { status: 'needs-channel', message: '尚未发现频道；请先向机器人账号发送一条消息。' }
          : { status: 'needs-target', message: '该连接发现了多个频道，请明确选择发送测试的目标频道。' }
      this.#recordConnectionTest(connectionId, direction, result)
      return result
    }
    try {
      const platformMessageId = await this.#qqRuntimes
        .get(connectionId)!
        .testSend(channelId, AbortSignal.timeout(15_000))
      result = { status: 'sent', channelId, platformMessageId }
    } catch (error) {
      if (isQQTransportError(error)) {
        result = {
          status: 'failed',
          kind: error.kind,
          message: error.message,
          ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
        }
      } else {
        result = {
          status: 'failed',
          kind: 'transient',
          message: error instanceof Error ? error.message : String(error),
        }
      }
    }
    this.#recordConnectionTest(connectionId, direction, result)
    return result
  }

  #recordConnectionTest(connectionId: ConnectionId, direction: 'send' | 'receive', result: ConnectionTestResult): void {
    const current = this.#qqDiagnostics.get(connectionId)
    if (!current) return
    this.#setQQDiagnostic(connectionId, {
      ...current,
      ...(direction === 'send' ? { sendTest: result } : { receiveTest: result }),
    })
  }

  async #mountQQ(connectionId: ConnectionId): Promise<void> {
    if (this.#qqRuntimes.has(connectionId)) return
    const connection = this.core.listConnections().find((candidate) => candidate.id === connectionId)
    if (!connection || connection.adapterKey !== 'qq-openclaw') throw new Error('QQ Connection does not exist.')
    const config = StoredQQConnectionConfigSchema.parse(connection.config)
    const appId = config.appId
    const credentialReference = connection.credentialRefs['clientSecret']
    let credentialConfigured = false
    if (credentialReference) {
      try {
        credentialConfigured = await this.credentials.has(credentialReference)
      } catch {
        // Persisted data can be damaged independently from the Server binary.
        // Isolate the failure to this Connection instead of aborting all recovery.
      }
    }
    if (!appId || !credentialReference || !credentialConfigured) {
      this.#setQQDiagnostic(connectionId, {
        gateway: { state: 'failed', lastError: '这个连接的凭据不可用。' },
        credentialConfigured: false,
        knownChannelIds: this.core.listChannelsByConnection(connectionId).map((channel) => channel.id),
      })
      return
    }
    const transport = new QQOpenClawHttpTransport({
      appId,
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
        connectionId,
        now: this.#now,
        acceptInbound: async (event) => {
          const result = await this.channels.acceptInbound(event)
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
        appId,
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
    this.#qqRuntimes.set(connectionId, runtime)
    this.#adapterRuntimes.set(connectionId, runtime)
    this.#setQQDiagnostic(connectionId, {
      gateway: { state: 'connecting' },
      credentialConfigured: true,
      knownChannelIds: this.core.listChannelsByConnection(connectionId).map((channel) => channel.id),
    })
    try {
      await runtime.start()
    } catch (error) {
      this.#qqRuntimes.delete(connectionId)
      this.#adapterRuntimes.delete(connectionId)
      this.#setQQDiagnostic(connectionId, {
        gateway: { state: 'failed', lastError: error instanceof Error ? error.message : String(error) },
        credentialConfigured: true,
        knownChannelIds: this.core.listChannelsByConnection(connectionId).map((channel) => channel.id),
      })
    }
  }

  #setQQDiagnostic(connectionId: ConnectionId, diagnostic: QQConnectionDiagnostic): void {
    this.#qqDiagnostics.set(connectionId, diagnostic)
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
    this.#connectionListeners.clear()
    await Promise.allSettled([
      ...[...this.#qqRuntimes.values()].map((runtime) => runtime.stop()),
      this.activation.dispose(),
      this.web.stop(),
      this.host.dispose(),
    ])
    this.#qqRuntimes.clear()
    this.#adapterRuntimes.clear()
    this.#database.close()
  }
}
