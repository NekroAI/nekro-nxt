import { Context, Service, type Fiber } from '@deepseek-ai/cordis'
import { SlotCore } from '@nekro-nxt/dsh-compat/client'
import type { ExtensionJsonValue } from '@nekro-nxt/extension-sdk'
import * as React from 'react'
import {
  registerDynamicSlot,
  requireCordisPlugin,
  requireExtensionPluginFactory,
  requireModuleRecord,
} from './dsh-interop/unsafe.js'

class SlotsService extends Service {
  readonly core: SlotCore

  constructor(context: Context, config: { readonly core: SlotCore }) {
    super(context, 'slots')
    this.core = config.core
  }

  register(options: unknown, component: unknown): () => void {
    const dispose = registerDynamicSlot(this.core, options, component)
    this.ctx.effect(() => dispose, 'nekro-nxt: Client Extension Slot')
    return dispose
  }
}

export interface ExtensionClientHostPort {
  call(method: string, input?: ExtensionJsonValue): Promise<ExtensionJsonValue>
}

export interface MountedClientExtension {
  readonly moduleUrl: string
  dispose(): Promise<void>
}

/** Owns Client Extension fibers over the same SlotCore rendered by the NekroNxt Shell. */
export class ExtensionClientRuntime {
  readonly slots = new SlotCore()
  readonly #context = new Context()
  readonly #fibers = new Set<Fiber>()
  readonly #ready: Promise<void>
  #disposed = false

  constructor() {
    this.#ready = Promise.resolve(this.#context.plugin(SlotsService, { core: this.slots })).then(() => undefined)
  }

  async mount(
    moduleUrl: string,
    host: ExtensionClientHostPort,
    styles: Readonly<Record<string, string>> = {},
  ): Promise<MountedClientExtension> {
    if (this.#disposed) throw new Error('Extension Client Runtime is disposed.')
    await this.#ready
    const loaded = requireModuleRecord(
      await import(`${moduleUrl}${moduleUrl.includes('?') ? '&' : '?'}nxt=${Date.now()}`),
      'Extension Client module',
    )
    const factory = requireExtensionPluginFactory(loaded['default'])
    const plugin = await factory({ React, host, styles })
    if ((typeof plugin !== 'object' || plugin === null) && typeof plugin !== 'function') {
      throw new TypeError('Extension Client factory must return a Cordis Plugin.')
    }
    const fiber = this.#context.plugin(requireCordisPlugin(plugin, 'Extension Client factory result'))
    try {
      await fiber
    } catch (error) {
      await fiber.dispose()
      throw error
    }
    if (this.#disposed) {
      await fiber.dispose()
      throw new Error('Extension Client Runtime was disposed during mount.')
    }
    this.#fibers.add(fiber)
    let active = true
    return {
      moduleUrl,
      dispose: async () => {
        if (!active) return
        active = false
        this.#fibers.delete(fiber)
        await fiber.dispose()
      },
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    const fibers = [...this.#fibers]
    this.#fibers.clear()
    await Promise.allSettled(fibers.map((fiber) => fiber.dispose()))
    await this.#context.fiber.dispose()
  }
}

export interface ClientActivationDescriptor {
  readonly activationId: string
  readonly moduleUrl: string
  readonly host: ExtensionClientHostPort
  readonly styles?: Readonly<Record<string, string>>
}

export interface ClientActivationSource {
  getSnapshot(): readonly ClientActivationDescriptor[]
  subscribe(listener: () => void): () => void
}

interface ClientExtensionRuntimeFace {
  mount(
    moduleUrl: string,
    host: ExtensionClientHostPort,
    styles?: Readonly<Record<string, string>>,
  ): Promise<MountedClientExtension>
}

/** Reconciles committed AgentActivation Client artifacts into the live Slot runtime. */
export class ExtensionClientActivationCoordinator {
  readonly #runtime: ClientExtensionRuntimeFace
  readonly #source: ClientActivationSource
  readonly #onFailure: (activationId: string, error: unknown) => void
  readonly #mounted = new Map<string, { readonly moduleUrl: string; readonly handle: MountedClientExtension }>()
  #unsubscribe: (() => void) | undefined
  #queue: Promise<void> = Promise.resolve()
  #disposed = false

  constructor(
    runtime: ClientExtensionRuntimeFace,
    source: ClientActivationSource,
    onFailure: (activationId: string, error: unknown) => void = () => undefined,
  ) {
    this.#runtime = runtime
    this.#source = source
    this.#onFailure = onFailure
  }

  async start(): Promise<void> {
    if (this.#disposed) throw new Error('Client Activation coordinator is disposed.')
    if (this.#unsubscribe) throw new Error('Client Activation coordinator is already started.')
    this.#unsubscribe = this.#source.subscribe(() => this.#schedule())
    this.#schedule()
    await this.idle()
  }

  idle(): Promise<void> {
    return this.#queue
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    this.#unsubscribe?.()
    this.#unsubscribe = undefined
    await this.#queue
    const mounted = [...this.#mounted.values()]
    this.#mounted.clear()
    await Promise.allSettled(mounted.map(({ handle }) => handle.dispose()))
  }

  #schedule(): void {
    this.#queue = this.#queue.then(() => this.#reconcile())
  }

  async #reconcile(): Promise<void> {
    if (this.#disposed) return
    const desired = new Map(this.#source.getSnapshot().map((descriptor) => [descriptor.activationId, descriptor]))
    for (const [activationId, mounted] of [...this.#mounted]) {
      const descriptor = desired.get(activationId)
      if (descriptor?.moduleUrl === mounted.moduleUrl) continue
      this.#mounted.delete(activationId)
      await mounted.handle.dispose()
    }
    for (const descriptor of desired.values()) {
      if (this.#mounted.has(descriptor.activationId)) continue
      try {
        const handle = await this.#runtime.mount(descriptor.moduleUrl, descriptor.host, descriptor.styles ?? {})
        if (
          this.#disposed ||
          this.#source.getSnapshot().every(({ activationId }) => activationId !== descriptor.activationId)
        ) {
          await handle.dispose()
          continue
        }
        this.#mounted.set(descriptor.activationId, { moduleUrl: descriptor.moduleUrl, handle })
      } catch (error) {
        this.#onFailure(descriptor.activationId, error)
      }
    }
  }
}
