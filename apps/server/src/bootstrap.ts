import type { Context } from '@deepseek-ai/cordis'
import { createWebAdapterConnection } from '@nekro-nxt/adapter-web'
import type { WebAdapterConnection } from '@nekro-nxt/adapter-web'
import type { AdapterConnectionRuntime } from '@nekro-nxt/adapter-sdk'
import { ChannelRuntime } from '@nekro-nxt/channel-runtime'
import { AssetService, CoreService } from '@nekro-nxt/core'
import type { AgentRevisionContent } from '@nekro-nxt/core'
import type { AgentId, ChannelId, ConnectionId } from '@nekro-nxt/contracts'
import {
  ExtensionActivationCoordinator,
  ExtensionBuilder,
  ExtensionService,
  ExtensionSourceStore,
} from '@nekro-nxt/extension-runtime'
import { openMigratedCoreDatabase, SqliteCoreRepository } from '@nekro-nxt/storage-sqlite'
import type { DatabaseSync } from 'node:sqlite'
import { monotonicFactory } from 'ulid'
import { ChannelExtensionActivationHost, DshHostRuntime } from './index.js'

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
  /** Absolute workspace root for explicitly granted development capabilities. */
  readonly developmentWorkspaceRoot?: string
  /** Inject a real or test LLM adapter into the DSH Host. */
  readonly configureLlm?: (context: Context) => Promise<void> | void
  /** Idle rollover threshold in ms; default 6h, `false` disables. */
  readonly idleRolloverMs?: number | false
  readonly now?: () => number
  readonly nextUlid?: () => string
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
  readonly assetService: AssetService
  readonly core: CoreService
  readonly host: DshHostRuntime
  readonly channels: ChannelRuntime
  readonly web: WebAdapterConnection
  readonly webConnectionId: ConnectionId
  readonly extensionService: ExtensionService
  readonly activation: ExtensionActivationCoordinator
  readonly #database: DatabaseSync
  readonly #now: () => number
  readonly #agents = new Map<AgentId, AgentEntity>()
  #started = false
  #disposed = false

  private constructor(input: {
    readonly database: DatabaseSync
    readonly repository: SqliteCoreRepository
    readonly assetService: AssetService
    readonly core: CoreService
    readonly host: DshHostRuntime
    readonly channels: ChannelRuntime
    readonly web: WebAdapterConnection
    readonly webConnectionId: ConnectionId
    readonly extensionService: ExtensionService
    readonly activation: ExtensionActivationCoordinator
    readonly now: () => number
  }) {
    this.#database = input.database
    this.repository = input.repository
    this.assetService = input.assetService
    this.core = input.core
    this.host = input.host
    this.channels = input.channels
    this.web = input.web
    this.webConnectionId = input.webConnectionId
    this.extensionService = input.extensionService
    this.activation = input.activation
    this.#now = input.now
  }

  static async create(options: NekroRuntimeOptions): Promise<NekroRuntime> {
    const now = options.now ?? Date.now
    const nextUlid = options.nextUlid ?? monotonicFactory()

    const database = await openMigratedCoreDatabase(options.coreDatabasePath)
    const repository = new SqliteCoreRepository(database)
    try {
      const assetService = new AssetService(repository, options.assetRoot)
      const core = new CoreService(repository, { now, nextUlid })
      const webConnection = core.createConnection({ adapterKey: 'web', config: {} })
      const webConnectionId = webConnection.id

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
        assets: repository,
        assetService,
        resolveAgentRevision: (revisionId) => repository.getAgentRevision(revisionId),
        ...(options.configureLlm === undefined ? {} : { configureLlm: options.configureLlm }),
      })

      const channels = new ChannelRuntime(core, repository, repository, host, {
        now,
        nextUlid,
        idleRolloverMs: options.idleRolloverMs ?? 6 * 60 * 60 * 1000,
        resolveAdapter: (id): AdapterConnectionRuntime | undefined => (id === webConnectionId ? web : undefined),
      })
      settled.current = channels

      const sourceStore = new ExtensionSourceStore(options.extensionDataRoot)
      const extensionService = new ExtensionService(repository, sourceStore, { now, nextUlid })
      const activation = new ExtensionActivationCoordinator(
        repository,
        extensionService,
        new ExtensionBuilder(options.extensionCacheRoot),
        new ChannelExtensionActivationHost(channels, host),
        { now, nextUlid },
      )

      return new NekroRuntime({
        database,
        repository,
        assetService,
        core,
        host,
        channels,
        web,
        webConnectionId,
        extensionService,
        activation,
        now,
      })
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
  createAgentWithWebChannel(content: AgentRevisionContent): AgentEntity {
    const agent = this.core.createAgent(content)
    const channel = this.core.ensureChannel({
      connectionId: this.webConnectionId,
      platformChannelId: `web-${agent.definition.id}`,
      kind: 'web',
      displayName: `${agent.revision.displayName} 的网页频道`,
      observedAt: this.#now(),
    })
    this.core.createBinding({ channelId: channel.id, agentId: agent.definition.id, triggerPolicy: 'always' })
    const entity: AgentEntity = {
      agentId: agent.definition.id,
      channelId: channel.id,
      connectionId: this.webConnectionId,
      revisionId: agent.revision.id,
      createdAt: agent.definition.createdAt,
    }
    this.#agents.set(entity.agentId, entity)
    return entity
  }

  /** Resume persisted Episodes/Admissions/Outbounds/Assets after a cold start. */
  async recover(): Promise<void> {
    await this.assetService.recover()
    await this.channels.recover()
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    await Promise.allSettled([this.activation.dispose(), this.web.stop(), this.host.dispose()])
    this.#database.close()
  }
}
