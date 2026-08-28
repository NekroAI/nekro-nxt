import { Context, Service } from '@deepseek-ai/cordis'
import { SlotCore } from '@nekro-nxt/dsh-compat/client'
import type {
  ExtensionClientStyles,
  ExtensionJsonValue,
  NekroNxtClientSlotName,
  NekroNxtClientSlotPropsMap,
} from '@nekro-nxt/extension-sdk'
import * as React from 'react'
import {
  registerDynamicSlot,
  requireProductSlotComponent,
  requireProductSlotCore,
  requireCordisPlugin,
  requireExtensionPluginFactory,
  requireModuleRecord,
} from './dsh-interop/unsafe.js'

class SlotsService extends Service {
  readonly core: SlotCore
  readonly registrationId: string
  nextEntry = 0

  constructor(context: Context, config: { readonly core: SlotCore; readonly registrationId: string }) {
    super(context, 'slots')
    this.core = config.core
    this.registrationId = config.registrationId
  }

  register(options: unknown, component: unknown): () => void {
    this.nextEntry += 1
    const dispose = registerDynamicSlot(this.core, options, component, `${this.registrationId}:${this.nextEntry}`)
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

export interface ProductClientSlotEntry<Props extends object> {
  readonly id: string
  readonly component: (props: Props) => React.ReactNode
}

export const DEFAULT_EXTENSION_CLIENT_STYLES: ExtensionClientStyles = {
  section: 'nxt-extension-section',
  sectionHeading: 'nxt-extension-section-heading',
  secondaryText: 'nxt-extension-secondary-text',
  actionRow: 'nxt-extension-action-row',
  button: 'nxt-extension-button',
  badge: 'nxt-extension-badge',
}

/** Owns Client Extension fibers over the same SlotCore rendered by the NekroNxt Shell. */
export class ExtensionClientRuntime {
  readonly slots = new SlotCore()
  readonly #slotCore = requireProductSlotCore(this.slots)
  readonly #contexts = new Set<Context>()
  readonly #rootDispose: () => void
  #disposed = false

  constructor() {
    this.#rootDispose = this.#slotCore.register(
      {
        name: 'root',
        children: {
          'agent.workbench.sections': { kind: 'list', scope: 'root' },
          'extension.activation.panels': { kind: 'list', scope: 'root' },
          'extension.details.panels': { kind: 'list', scope: 'root' },
          'channel.inspector.agent.sections': { kind: 'list', scope: 'root' },
          'conversation.tool.card': { kind: 'list', scope: 'root' },
        },
        registrant: 'nekro-nxt-product-shell',
      },
      () => null,
    )
  }

  async mount(
    moduleUrl: string,
    host: ExtensionClientHostPort,
    styles: ExtensionClientStyles = DEFAULT_EXTENSION_CLIENT_STYLES,
    registrationId: string = moduleUrl,
  ): Promise<MountedClientExtension> {
    if (this.#disposed) throw new Error('Extension Client Runtime is disposed.')
    const loaded = requireModuleRecord(
      await import(`${moduleUrl}${moduleUrl.includes('?') ? '&' : '?'}nxt=${Date.now()}`),
      'Extension Client module',
    )
    const factory = requireExtensionPluginFactory(loaded['default'])
    const plugin = await factory({ React, host, styles })
    if ((typeof plugin !== 'object' || plugin === null) && typeof plugin !== 'function') {
      throw new TypeError('Extension Client factory must return a Cordis Plugin.')
    }
    const context = new Context()
    this.#contexts.add(context)
    try {
      await context.plugin(SlotsService, { core: this.slots, registrationId })
      const fiber = context.plugin(requireCordisPlugin(plugin, 'Extension Client factory result'))
      await fiber
    } catch (error) {
      this.#contexts.delete(context)
      await context.fiber.dispose()
      throw error
    }
    if (this.#disposed) {
      this.#contexts.delete(context)
      await context.fiber.dispose()
      throw new Error('Extension Client Runtime was disposed during mount.')
    }
    let active = true
    return {
      moduleUrl,
      dispose: async () => {
        if (!active) return
        active = false
        this.#contexts.delete(context)
        await context.fiber.dispose()
      },
    }
  }

  subscribe<Name extends NekroNxtClientSlotName>(name: Name, listener: () => void): () => void {
    return this.#slotCore.subscribe(name, listener)
  }

  slotVersion<Name extends NekroNxtClientSlotName>(name: Name): number {
    return this.#slotCore.getVersion(name)
  }

  entries<Name extends NekroNxtClientSlotName>(
    name: Name,
  ): readonly ProductClientSlotEntry<NekroNxtClientSlotPropsMap[Name]>[] {
    return this.#slotCore.entriesOfSlot(name).map((entry, index) => {
      return {
        id: entry.options.id ?? entry.registrant ?? `${name}:${index}`,
        component: requireProductSlotComponent<NekroNxtClientSlotPropsMap[Name]>(
          entry.component,
          `Extension Client slot ${name}`,
        ),
      }
    })
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    const contexts = [...this.#contexts]
    this.#contexts.clear()
    await Promise.allSettled(contexts.map((context) => context.fiber.dispose()))
    this.#rootDispose()
  }
}

export interface ClientActivationDescriptor {
  readonly activationId: string
  readonly moduleUrl: string
  readonly host: ExtensionClientHostPort
  readonly styles?: ExtensionClientStyles
}

export interface ClientActivationSource {
  getSnapshot(): readonly ClientActivationDescriptor[]
  subscribe(listener: () => void): () => void
}

interface ClientExtensionRuntimeFace {
  mount(
    moduleUrl: string,
    host: ExtensionClientHostPort,
    styles?: ExtensionClientStyles,
    registrationId?: string,
  ): Promise<MountedClientExtension>
}

/** Reconciles committed AgentActivation Client artifacts into the live Slot runtime. */
export class ExtensionClientActivationCoordinator {
  readonly #runtime: ClientExtensionRuntimeFace
  readonly #source: ClientActivationSource
  readonly #onFailure: (activationId: string, error: unknown) => void
  readonly #onMounted: (activationId: string) => void
  readonly #mounted = new Map<string, { readonly moduleUrl: string; readonly handle: MountedClientExtension }>()
  #unsubscribe: (() => void) | undefined
  #queue: Promise<void> = Promise.resolve()
  #disposed = false

  constructor(
    runtime: ClientExtensionRuntimeFace,
    source: ClientActivationSource,
    onFailure: (activationId: string, error: unknown) => void = () => undefined,
    onMounted: (activationId: string) => void = () => undefined,
  ) {
    this.#runtime = runtime
    this.#source = source
    this.#onFailure = onFailure
    this.#onMounted = onMounted
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
        const handle = await this.#runtime.mount(
          descriptor.moduleUrl,
          descriptor.host,
          descriptor.styles,
          descriptor.activationId,
        )
        if (
          this.#disposed ||
          this.#source.getSnapshot().every(({ activationId }) => activationId !== descriptor.activationId)
        ) {
          await handle.dispose()
          continue
        }
        this.#mounted.set(descriptor.activationId, { moduleUrl: descriptor.moduleUrl, handle })
        this.#onMounted(descriptor.activationId)
      } catch (error) {
        this.#onFailure(descriptor.activationId, error)
      }
    }
  }
}
