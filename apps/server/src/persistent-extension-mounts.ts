import type { Context } from '@deepseek-ai/cordis'
import { type Fiber } from '@deepseek-ai/cordis'
import type { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { AdapterRegistry, type AdapterHostContributionV2 } from '@nekro-nxt/adapter-sdk'
import { JsonValueSchema, parseJsonValue, type JsonValue } from '@nekro-nxt/contracts'
import { canonicalJson, type AgentRevisionRecord } from '@nekro-nxt/core'
import {
  manifestAdapter,
  type ExtensionBuildArtifact,
  type ExtensionCaller,
  type ExtensionManifest,
  type LoadedExtension,
  type MountedAttachment,
  type Revision,
} from '@nekro-nxt/extension-runtime'
import {
  type ExtensionHostContext,
  type ExtensionHostEnvironment,
  type ExtensionJsonValue,
  type ExtensionPluginDefinition,
  type ExtensionPluginFactory,
  type ExtensionRpcHandler,
  type ExtensionToolDefinition,
  type NxtHostLayerService,
  type NxtHostService,
  type NxtInboundHandler,
  type NxtJobHandler,
} from '@nekro-nxt/extension-sdk'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { defineDshToolFromUnknown, parseDshToolDefinition } from './dsh-interop/unsafe.js'
import { isolatePrivateExtensionServices } from './extension-context.js'
import { NXT_HOST_SERVICE_NAME } from './extension-host-service.js'
import type { SessionRegistry } from './session-registry.js'

const PERSISTENT_EXTENSION_HOST_SERVICES = new Set(['tools', NXT_HOST_SERVICE_NAME])

type AgentId = AgentRevisionRecord['agentId']

interface PersistentExtensionContext extends ExtensionHostContext {
  get(service: string): ToolRuntime | NxtHostService | undefined
}

const persistentExtensionContext = (
  context: Context,
  nxt: NxtHostService | undefined,
  config: JsonValue,
): PersistentExtensionContext => ({
  tools: {
    register: (tool) => context.tools.register(parseDshToolDefinition(tool)),
  },
  ...(nxt === undefined ? {} : { nxt }),
  config: () => config,
  get: (service: string) => (service === 'tools' ? context.tools : service === NXT_HOST_SERVICE_NAME ? nxt : undefined),
})

/** Builds the Session-bound `nxt` of one agent attachment; the Server composition root owns the backends. */
export type PersistentNxtFactory = (input: {
  readonly agentId: AgentId
  readonly revision: Revision
  /** The agent's configuration. */
  readonly config: JsonValue
  /** The host configuration; secrets declared in `config.host` resolve from it. */
  readonly hostConfig: JsonValue
  readonly sessionId: string
  readonly context: Context
}) => NxtHostService

/** Builds the host instance's `nxt`, handed to the Host factory once per installation. */
export type PersistentHostNxtFactory = (input: {
  readonly revision: Revision
  readonly config: JsonValue
}) => NxtHostLayerService

/** Connects the MCP servers an attachment declares inside its Session context; disposed with that context. */
export type PersistentMcpMount = (input: {
  readonly agentId: AgentId
  readonly revision: Revision
  readonly config: JsonValue
  readonly hostConfig: JsonValue
  readonly sessionId: string
  readonly context: Context
}) => Promise<void>

/** Publishes a validated adapter to the product Registry and mounts its connections. */
export interface PersistentAdapterPort {
  register(owner: string, contribution: AdapterHostContributionV2): Promise<{ dispose(): Promise<void> }>
  mountConnections(adapterKey: string): Promise<void>
}

interface Attachment {
  readonly agentId: AgentId
  readonly config: JsonValue
  readonly fibers: Map<string, Fiber>
  readonly mounting: Map<string, Promise<void>>
  active: boolean
}

interface Instance {
  readonly revision: Revision
  readonly config: JsonValue
  readonly plugin?: ExtensionPluginDefinition
  readonly handlers: Map<string, ExtensionRpcHandler>
  readonly inbound?: NxtInboundHandler
  readonly job?: NxtJobHandler
  readonly attachments: Map<AgentId, Attachment>
  active: boolean
}

export interface PersistentInboundHandler {
  readonly agentId: AgentId
  readonly revision: Revision
  readonly config: JsonValue
  readonly hostConfig: JsonValue
  readonly handler: NxtInboundHandler
}

const ExtensionHostFactorySchema = z.custom<ExtensionPluginFactory<ExtensionHostEnvironment>>(
  (value) => typeof value === 'function',
  'Extension Host default export must be a function.',
)

const ExtensionHostModuleSchema = z.object({ default: ExtensionHostFactorySchema }).passthrough()

const ExtensionPluginDefinitionSchema = z
  .object({
    inject: z.array(z.string()).optional(),
    apply: z.custom<ExtensionPluginDefinition['apply']>(
      (value) => typeof value === 'function',
      'Extension Host plugin apply must be a function.',
    ),
  })
  .passthrough()

export const adapterDescriptorDigest = (contribution: AdapterHostContributionV2): string =>
  createHash('sha256')
    .update(canonicalJson(JsonValueSchema.parse(JSON.parse(JSON.stringify(contribution.descriptor)))))
    .digest('hex')

const unavailableHostNxt = (): NxtHostLayerService => {
  const unavailable = (): never => {
    throw new Error('This Host does not provide the nxt Service.')
  }
  return {
    http: { fetch: unavailable },
    secrets: { get: unavailable },
    storage: { get: unavailable, set: unavailable, delete: unavailable, list: unavailable },
    render: { svg: unavailable },
    parse: { html: unavailable, feed: unavailable },
  }
}

/**
 * Live Extensions of this Host (扩展形态统一 §3): one host instance per installed Extension, whose Host factory ran
 * once, plus the agent attachments mounted in every Session of each agent the Extension is enabled for.
 */
export class PersistentExtensionMounts {
  readonly #sessions: SessionRegistry<unknown>
  readonly #instances = new Map<Revision['extensionId'], Instance>()
  readonly #pending = new Set<Promise<unknown>>()
  #disposal: Promise<void> | undefined
  readonly #nxt: PersistentNxtFactory | undefined
  readonly #hostNxt: PersistentHostNxtFactory | undefined
  readonly #mcp: PersistentMcpMount | undefined
  readonly #adapters: PersistentAdapterPort | undefined

  constructor(
    sessions: SessionRegistry<unknown>,
    options: {
      readonly nxt?: PersistentNxtFactory
      readonly hostNxt?: PersistentHostNxtFactory
      readonly mcp?: PersistentMcpMount
      readonly adapters?: PersistentAdapterPort
    } = {},
  ) {
    this.#sessions = sessions
    this.#nxt = options.nxt
    this.#hostNxt = options.hostNxt
    this.#mcp = options.mcp
    this.#adapters = options.adapters
  }

  /** Due-job handler of an Extension attached to the agent, if it registered one. */
  jobHandler(
    agentId: AgentId,
    extensionId: Revision['extensionId'],
  ):
    | {
        readonly revision: Revision
        readonly config: JsonValue
        readonly hostConfig: JsonValue
        readonly handler: NxtJobHandler
      }
    | undefined {
    const instance = this.#instances.get(extensionId)
    const attachment = instance?.attachments.get(agentId)
    return instance?.job === undefined || attachment?.active !== true
      ? undefined
      : { revision: instance.revision, config: attachment.config, hostConfig: instance.config, handler: instance.job }
  }

  /** Inbound hooks of the Extensions attached to the agent, in stable Extension order. */
  inboundHandlers(agentId: AgentId): readonly PersistentInboundHandler[] {
    return [...this.#instances.values()]
      .filter((instance) => instance.active && instance.inbound !== undefined)
      .sort((left, right) => left.revision.extensionId.localeCompare(right.revision.extensionId))
      .flatMap((instance) => {
        const attachment = instance.attachments.get(agentId)
        return attachment?.active === true && instance.inbound !== undefined
          ? [
              {
                agentId,
                revision: instance.revision,
                config: attachment.config,
                hostConfig: instance.config,
                handler: instance.inbound,
              },
            ]
          : []
      })
  }

  /** Runs the Host factory once and registers the Extension's adapter; the result is the live host instance. */
  async load(input: {
    readonly revision: Revision
    readonly manifest: ExtensionManifest
    readonly artifact: ExtensionBuildArtifact
    readonly config: JsonValue
  }): Promise<LoadedExtension> {
    if (this.#disposal) throw new Error('Extension mounts are disposed.')
    if (this.#instances.has(input.revision.extensionId)) throw new Error('这个扩展已经在本机运行。')
    const pending = this.#load(input)
    this.#pending.add(pending)
    try {
      return await pending
    } finally {
      this.#pending.delete(pending)
    }
  }

  async #load(input: {
    readonly revision: Revision
    readonly manifest: ExtensionManifest
    readonly artifact: ExtensionBuildArtifact
    readonly config: JsonValue
  }): Promise<LoadedExtension> {
    const { revision, manifest, artifact, config } = input
    const handlers = new Map<string, ExtensionRpcHandler>()
    const expectedAdapter = manifestAdapter(manifest)
    let inbound: NxtInboundHandler | undefined
    let job: NxtJobHandler | undefined
    let plugin: ExtensionPluginDefinition | undefined
    let adapter: AdapterHostContributionV2 | undefined
    if (artifact.hostEntry) {
      let factoryOpen = true
      const loaded = ExtensionHostModuleSchema.parse(
        await import(`${pathToFileURL(artifact.hostEntry).href}?build=${artifact.buildKey}`),
      )
      const whileFactoryOpen = (name: string) => {
        if (!factoryOpen) throw new Error(`${name} 必须在 factory 阶段注册，不能在每个 Session 中注册。`)
      }
      let factoryResult: unknown
      try {
        factoryResult = await loaded.default({
          harness: {
            defineTool: <Args extends Record<string, ExtensionJsonValue>, Output extends ExtensionJsonValue>(
              options: ExtensionToolDefinition<Args, Output>,
            ): ExtensionToolDefinition<Args, Output> => {
              const definition = defineDshToolFromUnknown(options)
              return Object.assign(options, definition)
            },
            registerTool: (context: ExtensionHostContext, tool: ExtensionToolDefinition) =>
              context.tools.register(tool),
            handle: (method: string, handler: ExtensionRpcHandler) => {
              whileFactoryOpen('harness.handle')
              const normalized = method.trim()
              if (!normalized || typeof handler !== 'function') throw new TypeError('Invalid Extension Host handler.')
              if (handlers.has(normalized)) throw new Error(`界面数据接口重复注册：${normalized}`)
              handlers.set(normalized, handler)
              // The host instance owns the handler; nothing retracts it before the instance is disposed.
              return () => undefined
            },
            registerAdapter: (contribution: AdapterHostContributionV2) => {
              whileFactoryOpen('harness.registerAdapter')
              if (expectedAdapter === undefined) throw new Error('扩展清单没有声明适配器，不能注册适配器。')
              if (adapter !== undefined) throw new Error('一个扩展只能注册一个适配器。')
              adapter = contribution
              return () => undefined
            },
            onInbound: (handler: NxtInboundHandler) => {
              whileFactoryOpen('harness.onInbound')
              if (typeof handler !== 'function') throw new TypeError('harness.onInbound 需要一个处理函数。')
              if (inbound !== undefined) throw new Error('一个扩展只能注册一个入站处理函数。')
              inbound = handler
              return () => {
                inbound = undefined
              }
            },
            onJob: (handler: NxtJobHandler) => {
              whileFactoryOpen('harness.onJob')
              if (typeof handler !== 'function') throw new TypeError('harness.onJob 需要一个处理函数。')
              if (job !== undefined) throw new Error('一个扩展只能注册一个定时任务处理函数。')
              job = handler
              return () => {
                job = undefined
              }
            },
            config: () => config,
          },
          config,
          nxt: this.#hostNxt?.({ revision, config }) ?? unavailableHostNxt(),
        })
      } finally {
        factoryOpen = false
      }
      if (factoryResult !== undefined && factoryResult !== null) {
        const parsedPlugin = ExtensionPluginDefinitionSchema.parse(factoryResult)
        const forbiddenServices = parsedPlugin.inject?.filter(
          (service) => !PERSISTENT_EXTENSION_HOST_SERVICES.has(service),
        )
        if (forbiddenServices && forbiddenServices.length > 0) {
          throw new Error(`Extension Host requested unavailable Services: ${forbiddenServices.join(', ')}`)
        }
        plugin = {
          ...(parsedPlugin.inject === undefined ? {} : { inject: parsedPlugin.inject }),
          apply: parsedPlugin.apply,
        }
      }
    }

    let registered: { dispose(): Promise<void> } | undefined
    if (expectedAdapter !== undefined) {
      if (adapter === undefined) throw new Error('扩展清单声明了适配器，但 Host factory 没有注册适配器。')
      new AdapterRegistry().register(`candidate:${revision.id}`, adapter)
      if (adapter.descriptor.key !== expectedAdapter.key) throw new Error('适配器实际注册的 key 与扩展清单不一致。')
      if (adapterDescriptorDigest(adapter) !== expectedAdapter.descriptorDigest) {
        throw new Error('适配器描述符与扩展清单不一致。')
      }
      if (!this.#adapters) throw new Error('当前宿主不能加载适配器。')
      registered = await this.#adapters.register(`extension:${revision.extensionId}`, adapter)
      try {
        await this.#adapters.mountConnections(expectedAdapter.key)
      } catch (error) {
        await registered.dispose().catch(() => undefined)
        throw error
      }
    }

    const instance: Instance = {
      revision,
      config,
      ...(plugin === undefined ? {} : { plugin }),
      handlers,
      ...(inbound === undefined ? {} : { inbound }),
      ...(job === undefined ? {} : { job }),
      attachments: new Map(),
      active: true,
    }
    this.#instances.set(revision.extensionId, instance)
    return {
      ...(expectedAdapter === undefined ? {} : { adapterKey: expectedAdapter.key }),
      attach: (agentId, agentConfig) => this.#attach(instance, agentId, agentConfig),
      call: (method, value, caller) => this.#call(instance, method, value, caller),
      dispose: async () => {
        instance.active = false
        if (this.#instances.get(revision.extensionId) === instance) this.#instances.delete(revision.extensionId)
        const failures: unknown[] = []
        for (const attachment of [...instance.attachments.values()]) {
          try {
            await this.#detach(instance, attachment)
          } catch (error) {
            failures.push(error)
          }
        }
        handlers.clear()
        try {
          await registered?.dispose()
        } catch (error) {
          failures.push(error)
        }
        if (failures.length === 1) throw failures[0]
        if (failures.length > 1) throw new AggregateError(failures, '扩展停止失败。')
      },
    }
  }

  async #call(instance: Instance, method: string, input: JsonValue, caller: ExtensionCaller): Promise<JsonValue> {
    if (!instance.active) throw new Error('这个扩展当前没有在本机运行。')
    const handler = instance.handlers.get(method)
    if (!handler) throw new Error(`界面数据接口未注册：${method}`)
    return parseJsonValue(JSON.parse(JSON.stringify(await handler(input, caller))))
  }

  async #attach(instance: Instance, agentId: AgentId, config: JsonValue): Promise<MountedAttachment> {
    if (!instance.active) throw new Error('这个扩展当前没有在本机运行。')
    if (instance.attachments.has(agentId)) throw new Error('这个扩展已经挂载给该智能体。')
    const attachment: Attachment = { agentId, config, fibers: new Map(), mounting: new Map(), active: true }
    instance.attachments.set(agentId, attachment)
    try {
      await Promise.all(
        [...this.#sessions.handles()]
          .filter(([sessionId]) => this.#sessions.get(sessionId)?.revision.agentId === agentId)
          .map(([sessionId, handle]) => this.#mountInSession(instance, attachment, sessionId, handle.agent.ctx)),
      )
    } catch (error) {
      try {
        await this.#detach(instance, attachment)
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Extension mount and cleanup failed.')
      }
      throw error
    }
    return { dispose: () => this.#detach(instance, attachment) }
  }

  /** Mounts every attachment of the agent into a Session that just started. */
  async mountIntoSession(agentId: AgentId, sessionId: string, agentContext: Context): Promise<void> {
    for (const instance of this.#instances.values()) {
      const attachment = instance.attachments.get(agentId)
      if (instance.active && attachment?.active === true) {
        await this.#mountInSession(instance, attachment, sessionId, agentContext)
      }
    }
  }

  async #mountInSession(
    instance: Instance,
    attachment: Attachment,
    sessionId: string,
    agentContext: Context,
  ): Promise<void> {
    if (!attachment.active || attachment.fibers.has(sessionId)) return
    const inFlight = attachment.mounting.get(sessionId)
    if (inFlight) return inFlight
    const mounting = (async () => {
      const plugin = instance.plugin
      const wantsNxt = plugin?.inject?.includes(NXT_HOST_SERVICE_NAME) === true
      const nxtFactory = this.#nxt
      if (wantsNxt && nxtFactory === undefined) throw new Error('This Host does not provide the nxt Service.')
      const extensionContext = isolatePrivateExtensionServices(agentContext)
      const apply = plugin?.apply.bind(plugin)
      const extensionPlugin = {
        // `nxt` is handed to apply directly; Cordis must not wait for a Context Service of that name.
        ...(plugin?.inject === undefined
          ? {}
          : { inject: plugin.inject.filter((service) => service !== NXT_HOST_SERVICE_NAME) }),
        apply: async (context: Context) => {
          const nxt =
            wantsNxt && nxtFactory !== undefined
              ? nxtFactory({
                  agentId: attachment.agentId,
                  revision: instance.revision,
                  config: attachment.config,
                  hostConfig: instance.config,
                  sessionId,
                  context,
                })
              : undefined
          await apply?.(persistentExtensionContext(context, nxt, attachment.config))
          await this.#mcp?.({
            agentId: attachment.agentId,
            revision: instance.revision,
            config: attachment.config,
            hostConfig: instance.config,
            sessionId,
            context,
          })
        },
      }
      const fiber = extensionContext.plugin(extensionPlugin)
      try {
        await fiber
      } catch (error) {
        await fiber.dispose()
        throw error
      }
      if (!attachment.active) {
        await fiber.dispose()
        return
      }
      attachment.fibers.set(sessionId, fiber)
      fiber.ctx.effect(
        () => () => {
          attachment.fibers.delete(sessionId)
        },
        'nekro-nxt: Extension session mount',
      )
    })().finally(() => attachment.mounting.delete(sessionId))
    attachment.mounting.set(sessionId, mounting)
    return mounting
  }

  async #detach(instance: Instance, attachment: Attachment): Promise<void> {
    if (!attachment.active) return
    attachment.active = false
    if (instance.attachments.get(attachment.agentId) === attachment) instance.attachments.delete(attachment.agentId)
    await Promise.allSettled([...attachment.mounting.values()])
    const fibers = [...attachment.fibers.values()]
    attachment.fibers.clear()
    const results = await Promise.allSettled(fibers.map((fiber) => fiber.dispose()))
    const failures = results.filter((result) => result.status === 'rejected').map((result): unknown => result.reason)
    if (failures.length) throw new AggregateError(failures, 'Extension Session disposal failed.')
  }

  dispose(): Promise<void> {
    this.#disposal ??= this.#dispose()
    return this.#disposal
  }

  async #dispose(): Promise<void> {
    await Promise.allSettled([...this.#pending])
    const results = await Promise.allSettled(
      [...this.#instances.values()].flatMap((instance) => {
        instance.active = false
        return [...instance.attachments.values()].map((attachment) => this.#detach(instance, attachment))
      }),
    )
    this.#instances.clear()
    const failures = results.filter((result) => result.status === 'rejected').map((result): unknown => result.reason)
    if (failures.length) throw new AggregateError(failures, 'Extension disposal failed.')
  }
}
