import type { Context } from '@deepseek-ai/cordis'
import { type Fiber } from '@deepseek-ai/cordis'
import type { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { parseJsonValue, type JsonValue } from '@nekro-nxt/contracts'
import type { AgentRevisionRecord } from '@nekro-nxt/core'
import { type ExtensionBuildArtifact, type MountedExtension, type Revision } from '@nekro-nxt/extension-runtime'
import {
  type ExtensionHostContext,
  type ExtensionHostEnvironment,
  type ExtensionJsonValue,
  type ExtensionPluginDefinition,
  type ExtensionPluginFactory,
  type ExtensionToolDefinition,
} from '@nekro-nxt/extension-sdk'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { defineDshToolFromUnknown, parseDshToolDefinition } from './dsh-interop/unsafe.js'
import { isolatePrivateExtensionServices } from './extension-context.js'
import type { SessionRegistry } from './session-registry.js'
const PERSISTENT_EXTENSION_HOST_SERVICES = new Set(['tools'])

interface PersistentExtensionContext extends ExtensionHostContext {
  get(service: string): ToolRuntime | undefined
}

const persistentExtensionContext = (context: Context): PersistentExtensionContext => ({
  tools: {
    register: (tool) => context.tools.register(parseDshToolDefinition(tool)),
  },
  get: (service: string) => (service === 'tools' ? context.tools : undefined),
})

interface PersistentExtensionRegistration {
  readonly key: string
  readonly agentId: AgentRevisionRecord['agentId']
  readonly revision: Revision
  readonly artifact: ExtensionBuildArtifact
  readonly config: JsonValue
  readonly plugin?: ExtensionPluginDefinition
  readonly fibers: Map<string, Fiber>
  readonly mounting: Map<string, Promise<void>>
  readonly handlers: Map<string, (input: ExtensionJsonValue) => ExtensionJsonValue | Promise<ExtensionJsonValue>>
  active: boolean
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
export class PersistentExtensionMounts {
  readonly #sessions: SessionRegistry<unknown>
  readonly #persistentExtensions = new Map<string, PersistentExtensionRegistration>()
  readonly #pendingMounts = new Map<string, Promise<MountedExtension>>()
  readonly #unmounting = new WeakMap<PersistentExtensionRegistration, Promise<void>>()
  readonly #pendingUnmounts = new Set<Promise<void>>()
  #disposal: Promise<void> | undefined
  constructor(sessions: SessionRegistry<unknown>) {
    this.#sessions = sessions
  }
  async invokeExtensionHost(
    dshSessionId: string,
    extensionRevisionId: string,
    method: string,
    input: JsonValue = null,
  ): Promise<JsonValue> {
    const agentId = this.#sessions.get(dshSessionId)?.revision.agentId
    if (!agentId) throw new Error(`DSH Agent Session is not live: ${dshSessionId}`)
    const registration = [...this.#persistentExtensions.values()].find(
      (candidate) => candidate.agentId === agentId && candidate.revision.id === extensionRevisionId,
    )
    const handler = registration?.handlers.get(method)
    if (!handler) throw new Error(`Extension Host method is unavailable: ${method}`)
    return parseJsonValue(JSON.parse(JSON.stringify(await handler(input))))
  }

  async invokeExtensionActivation(
    agentId: AgentRevisionRecord['agentId'],
    extensionRevisionId: string,
    method: string,
    input: JsonValue = null,
  ): Promise<JsonValue> {
    const registration = [...this.#persistentExtensions.values()].find(
      (candidate) => candidate.agentId === agentId && candidate.revision.id === extensionRevisionId && candidate.active,
    )
    const handler = registration?.handlers.get(method)
    if (!handler) throw new Error(`Extension Host method is unavailable: ${method}`)
    return parseJsonValue(JSON.parse(JSON.stringify(await handler(input))))
  }

  async mount(
    agentId: AgentRevisionRecord['agentId'],
    revision: Revision,
    artifact: ExtensionBuildArtifact,
    config: JsonValue,
  ): Promise<MountedExtension> {
    if (this.#disposal) throw new Error('Extension mounts are disposed.')
    const key = `${agentId}\0${revision.extensionId}\0${revision.id}`
    if (this.#pendingMounts.has(key)) throw new Error('Extension Revision is already mounting for this Agent.')
    const pending = this.#mount(agentId, revision, artifact, config).finally(() => this.#pendingMounts.delete(key))
    this.#pendingMounts.set(key, pending)
    return pending
  }

  async #mount(
    agentId: AgentRevisionRecord['agentId'],
    revision: Revision,
    artifact: ExtensionBuildArtifact,
    config: JsonValue,
  ): Promise<MountedExtension> {
    const key = `${agentId}\0${revision.extensionId}\0${revision.id}`
    if (this.#persistentExtensions.has(key)) throw new Error('Extension Revision is already mounted for this Agent.')
    const handlers = new Map<string, (input: ExtensionJsonValue) => ExtensionJsonValue | Promise<ExtensionJsonValue>>()
    let plugin: ExtensionPluginDefinition | undefined
    if (artifact.hostEntry) {
      let factoryOpen = true
      const loaded = ExtensionHostModuleSchema.parse(
        await import(`${pathToFileURL(artifact.hostEntry).href}?build=${artifact.buildKey}`),
      )
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
            handle: (
              method: string,
              handler: (input: ExtensionJsonValue) => ExtensionJsonValue | Promise<ExtensionJsonValue>,
            ) => {
              if (!factoryOpen) {
                throw new Error('Extension Host RPC must be registered by the Activation factory, not per Session.')
              }
              if (!method.trim() || typeof handler !== 'function') {
                throw new TypeError('Invalid Extension Host handler.')
              }
              if (handlers.has(method)) throw new Error(`Extension Host handler is already registered: ${method}`)
              handlers.set(method, handler)
              // The Activation owns the handler. A Session fiber cannot retract it.
              return () => undefined
            },
            registerAdapter: () => {
              throw new Error('宿主适配器不能通过智能体 Activation 加载；请安装这个适配器 Revision。')
            },
          },
          config,
        })
      } finally {
        factoryOpen = false
      }
      const parsedPlugin = ExtensionPluginDefinitionSchema.parse(factoryResult)
      plugin = {
        ...(parsedPlugin.inject === undefined ? {} : { inject: parsedPlugin.inject }),
        apply: parsedPlugin.apply,
      }
      const forbiddenServices = parsedPlugin.inject?.filter(
        (service) => !PERSISTENT_EXTENSION_HOST_SERVICES.has(service),
      )
      if (forbiddenServices && forbiddenServices.length > 0) {
        throw new Error(`Extension Host requested unavailable Services: ${forbiddenServices.join(', ')}`)
      }
    }
    const registration: PersistentExtensionRegistration = {
      key,
      agentId,
      revision,
      artifact,
      config,
      ...(plugin === undefined ? {} : { plugin }),
      fibers: new Map(),
      mounting: new Map(),
      handlers,
      active: true,
    }
    this.#persistentExtensions.set(key, registration)
    try {
      await Promise.all(
        [...this.#sessions.handles()]
          .filter(([sessionId]) => this.#sessions.get(sessionId)?.revision.agentId === agentId)
          .map(([sessionId, handle]) =>
            this.#mountPersistentExtensionInSession(registration, sessionId, handle.agent.ctx),
          ),
      )
    } catch (error) {
      try {
        await this.#unmountPersistentExtension(registration)
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Extension mount and cleanup failed.')
      }
      throw error
    }
    return {
      evidence: {
        hostLoaded: artifact.hostEntry !== undefined,
        clientBuilt: artifact.clientEntry !== undefined,
        details: [
          `revision:${revision.id}`,
          `sessions:${registration.fibers.size}`,
          ...(artifact.clientEntry === undefined ? [] : [`client:${path.basename(artifact.clientEntry)}`]),
        ],
      },
      dispose: () => this.#unmountPersistentExtension(registration),
    }
  }

  async mountIntoSession(
    agentId: AgentRevisionRecord['agentId'],
    sessionId: string,
    agentContext: Context,
  ): Promise<void> {
    for (const registration of this.#persistentExtensions.values()) {
      if (registration.agentId === agentId && registration.active) {
        await this.#mountPersistentExtensionInSession(registration, sessionId, agentContext)
      }
    }
  }

  async #mountPersistentExtensionInSession(
    registration: PersistentExtensionRegistration,
    sessionId: string,
    agentContext: Context,
  ): Promise<void> {
    if (!registration.active || registration.fibers.has(sessionId)) return
    const inFlight = registration.mounting.get(sessionId)
    if (inFlight) return inFlight
    const mounting = (async () => {
      const plugin = registration.plugin
      if (plugin === undefined) return
      const apply = plugin.apply.bind(plugin)
      const extensionContext = isolatePrivateExtensionServices(agentContext)
      const extensionPlugin = {
        ...(plugin.inject === undefined ? {} : { inject: [...plugin.inject] }),
        apply: async (context: Context) => {
          await apply(persistentExtensionContext(context))
        },
      }
      const fiber = extensionContext.plugin(extensionPlugin)
      try {
        await fiber
      } catch (error) {
        await fiber.dispose()
        throw error
      }
      if (!registration.active) {
        await fiber.dispose()
        return
      }
      registration.fibers.set(sessionId, fiber)
      fiber.ctx.effect(
        () => () => {
          registration.fibers.delete(sessionId)
        },
        'nekro-nxt: Extension session mount',
      )
    })().finally(() => registration.mounting.delete(sessionId))
    registration.mounting.set(sessionId, mounting)
    return mounting
  }

  #unmountPersistentExtension(registration: PersistentExtensionRegistration): Promise<void> {
    const pending = this.#unmounting.get(registration)
    if (pending) return pending
    const unmounting = this.#unmount(registration).finally(() => this.#pendingUnmounts.delete(unmounting))
    this.#pendingUnmounts.add(unmounting)
    this.#unmounting.set(registration, unmounting)
    return unmounting
  }

  async #unmount(registration: PersistentExtensionRegistration): Promise<void> {
    if (!registration.active && !this.#persistentExtensions.has(registration.key)) return
    registration.active = false
    if (this.#persistentExtensions.get(registration.key) === registration) {
      this.#persistentExtensions.delete(registration.key)
    }
    await Promise.allSettled([...registration.mounting.values()])
    const fibers = [...registration.fibers.values()]
    registration.fibers.clear()
    registration.handlers.clear()
    const results = await Promise.allSettled(fibers.map((fiber) => fiber.dispose()))
    const failures = results.filter((result) => result.status === 'rejected').map((result): unknown => result.reason)
    if (failures.length) throw new AggregateError(failures, 'Extension Session disposal failed.')
  }
  dispose(): Promise<void> {
    this.#disposal ??= this.#dispose()
    return this.#disposal
  }

  async #dispose(): Promise<void> {
    await Promise.allSettled([...this.#pendingMounts.values()])
    const results = await Promise.allSettled([
      ...this.#pendingUnmounts,
      ...[...this.#persistentExtensions.values()].map((entry) => this.#unmountPersistentExtension(entry)),
    ])
    const failures = results.filter((result) => result.status === 'rejected').map((result): unknown => result.reason)
    if (failures.length) throw new AggregateError(failures, 'Extension disposal failed.')
  }
}
