import { Context, Service } from '@deepseek-ai/cordis'
import type {
  AdapterChannelInspectorSlotProps,
  AdapterClientSlotPropsMap,
  AdapterConnectionSlotProps,
  AdapterHostClientEnvironment,
  AdapterRichMessageSlotProps,
} from '@nekro-nxt/extension-sdk'
import {
  AdapterClientSlotNameSchema,
  HostPageContributionSchema,
  HostUiPermissionDeclarationSchema,
  type AdapterClientSlotName,
} from '@nekro-nxt/contracts'
import * as React from 'react'
import {
  Component,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import {
  requireCordisPlugin,
  requireExtensionPluginFactory,
  requireModuleRecord,
  requireProductSlotComponent,
} from './dsh-interop/unsafe.js'
import { useProductStore, type LocalExtensionSummary } from './product-store.js'
import { hostUiKit } from './host-ui-client.js'
import { DEFAULT_EXTENSION_CLIENT_STYLES } from './extension-client.js'

interface AdapterClientEntry<Name extends AdapterClientSlotName = AdapterClientSlotName> {
  readonly owner: string
  readonly name: Name
  readonly key: string
  readonly component: (props: AdapterClientSlotPropsMap[Name]) => ReactNode
}

const adapterSlotIdentity = (name: AdapterClientSlotName, key: string): string => `${name}\0${key}`

class AdapterSlotsService extends Service {
  private readonly adapterKey: string
  private readonly registerSlot: (name: AdapterClientSlotName, key: string, component: unknown) => () => void

  constructor(
    context: Context,
    config: {
      readonly adapterKey: string
      readonly register: (name: AdapterClientSlotName, key: string, component: unknown) => () => void
    },
  ) {
    super(context, 'slots')
    this.adapterKey = config.adapterKey
    this.registerSlot = config.register
  }

  register(options: unknown, component: unknown): () => void {
    const record = requireModuleRecord(options, 'Adapter Client Slot options')
    const name = AdapterClientSlotNameSchema.parse(record['name'])
    const key = record['id']
    if (typeof key !== 'string') throw new Error('Adapter Client Slot 必须声明稳定 id。')
    if (
      name === 'conversation.message.rich'
        ? !key.startsWith(`${this.adapterKey}:`) || key.length <= this.adapterKey.length + 1
        : key !== this.adapterKey
    ) {
      throw new Error(
        name === 'conversation.message.rich'
          ? `富消息 Slot key 必须使用 ${this.adapterKey}:<kind>。`
          : `Adapter 产品 Slot id 必须等于 ${this.adapterKey}。`,
      )
    }
    const slotComponent = requireProductSlotComponent<AdapterClientSlotPropsMap[typeof name]>(
      component,
      'Adapter Client Slot component',
    )
    const dispose = this.registerSlot(name, key, slotComponent)
    this.ctx.effect(() => dispose, `nekro-nxt: Adapter Client ${name} Slot`)
    return dispose
  }
}

class AdapterPagesService extends Service {
  readonly #allowedEntryIds: ReadonlySet<string>

  constructor(context: Context, config: { readonly allowedEntryIds: readonly string[] }) {
    super(context, 'pages')
    this.#allowedEntryIds = new Set(config.allowedEntryIds)
  }

  declarePermissions(declaration: unknown): void {
    HostUiPermissionDeclarationSchema.parse(declaration)
  }

  register(options: unknown, component: unknown): () => void {
    const record = requireModuleRecord(options, 'Adapter page registration')
    const page = HostPageContributionSchema.parse(record['page'])
    if (!this.#allowedEntryIds.has(page.entryId)) {
      throw new Error(`Adapter Client 注册了 Manifest 未声明的页面入口：${page.entryId}`)
    }
    if (typeof component !== 'function') throw new Error(`页面 ${page.entryId} 必须注册 React 组件。`)
    return () => undefined
  }
}

export class AdapterHostClientRuntime {
  readonly #entries = new Map<string, AdapterClientEntry>()
  readonly #contexts = new Map<string, Context>()
  readonly #listeners = new Set<() => void>()
  #version = 0
  #disposed = false

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  version = (): number => this.#version

  entry(key: string): AdapterClientEntry<'conversation.message.rich'> | undefined
  entry<Name extends AdapterClientSlotName>(name: Name, key: string): AdapterClientEntry<Name> | undefined
  entry(nameOrKey: string, key?: string): unknown {
    const name = key === undefined ? 'conversation.message.rich' : AdapterClientSlotNameSchema.parse(nameOrKey)
    const resolvedKey = key ?? nameOrKey
    return this.#entries.get(adapterSlotIdentity(name, resolvedKey))
  }

  async mount(input: {
    readonly owner: string
    readonly adapterKey: string
    readonly moduleUrl: string
    readonly allowedSlots?: readonly { readonly name: AdapterClientSlotName; readonly key: string }[]
    readonly allowedKeys?: readonly string[]
    readonly allowedPageEntryIds?: readonly string[]
  }): Promise<void> {
    if (this.#disposed) throw new Error('Adapter Host Client Runtime is disposed.')
    if (this.#contexts.has(input.owner)) throw new Error('Adapter Host Client is already mounted.')
    const context = new Context()
    context.reflect.provide('ui', hostUiKit)
    const allowedSlots =
      input.allowedSlots ??
      (input.allowedKeys ?? []).map((key) => ({ name: 'conversation.message.rich' as const, key }))
    const ownedSlots = new Set<string>()
    const register = (name: AdapterClientSlotName, key: string, component: unknown): (() => void) => {
      const identity = adapterSlotIdentity(name, key)
      if (!allowedSlots.some((slot) => slot.name === name && slot.key === key)) {
        throw new Error(`Adapter Client 注册了未声明的产品 Slot：${name}:${key}`)
      }
      if (this.#entries.has(identity)) throw new Error(`Adapter 产品 Slot 已注册：${name}:${key}`)
      const entry: AdapterClientEntry = {
        owner: input.owner,
        name,
        key,
        component: requireProductSlotComponent(component, `Adapter ${name} component`),
      }
      this.#entries.set(identity, entry)
      ownedSlots.add(identity)
      this.#publish()
      let active = true
      return () => {
        if (!active) return
        active = false
        if (this.#entries.get(identity) === entry) this.#entries.delete(identity)
        ownedSlots.delete(identity)
        this.#publish()
      }
    }
    try {
      const loaded = requireModuleRecord(
        await import(`${input.moduleUrl}${input.moduleUrl.includes('?') ? '&' : '?'}nxt=${Date.now()}`),
        'Adapter Client module',
      )
      const factory = requireExtensionPluginFactory<AdapterHostClientEnvironment>(loaded['default'])
      const plugin = await factory({
        React,
        styles: DEFAULT_EXTENSION_CLIENT_STYLES,
        ui: hostUiKit,
        host: { call: () => Promise.reject(new Error('Adapter Client 不提供自定义 Host RPC。')) },
      })
      await context.plugin(AdapterSlotsService, { adapterKey: input.adapterKey, register })
      await context.plugin(AdapterPagesService, { allowedEntryIds: input.allowedPageEntryIds ?? [] })
      await context.plugin(requireCordisPlugin(plugin, 'Adapter Client factory result'))
      if (allowedSlots.some(({ name, key }) => !ownedSlots.has(adapterSlotIdentity(name, key)))) {
        throw new Error('Adapter Client 没有注册 Manifest 声明的全部产品 Slot。')
      }
      this.#contexts.set(input.owner, context)
    } catch (error) {
      await context.fiber.dispose()
      throw error
    }
  }

  async unmount(owner: string): Promise<void> {
    const context = this.#contexts.get(owner)
    if (!context) return
    this.#contexts.delete(owner)
    await context.fiber.dispose()
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    const contexts = [...this.#contexts.values()]
    this.#contexts.clear()
    await Promise.allSettled(contexts.map((context) => context.fiber.dispose()))
    this.#entries.clear()
    this.#publish()
  }

  #publish(): void {
    this.#version += 1
    for (const listener of this.#listeners) listener()
  }
}

interface DesiredAdapterClient {
  readonly owner: string
  readonly revisionId: string
  readonly adapterKey: string
  readonly moduleUrl: string
  readonly allowedSlots: readonly { readonly name: AdapterClientSlotName; readonly key: string }[]
  readonly allowedPageEntryIds: readonly string[]
}

const desiredClients = (extensions: readonly LocalExtensionSummary[]): readonly DesiredAdapterClient[] =>
  extensions.flatMap((extension) => {
    const installed = extension.installation
    if (!installed) return []
    const revision = extension.revisions.find((candidate) => candidate.id === installed.revisionId)
    const adapterContribution = revision?.contributions.find((entry) => entry.startsWith('适配器：'))
    const adapterKey = adapterContribution?.slice('适配器：'.length)
    if (!revision?.clientBuilt || !revision.buildKey || !adapterKey || revision.hostSlots.length === 0) return []
    return [
      {
        owner: extension.id,
        revisionId: revision.id,
        adapterKey,
        moduleUrl: `/api/extensions/${encodeURIComponent(extension.id)}/revisions/${encodeURIComponent(revision.id)}/client/${revision.buildKey}.mjs`,
        allowedSlots: revision.hostSlots.map(({ name, key }) => ({
          name: AdapterClientSlotNameSchema.parse(name),
          key,
        })),
        allowedPageEntryIds: revision.pages.map(({ entryId }) => entryId),
      },
    ]
  })

class AdapterHostClientCoordinator {
  readonly runtime = new AdapterHostClientRuntime()
  readonly #mounted = new Map<string, string>()
  #queue: Promise<void> = Promise.resolve()

  sync(extensions: readonly LocalExtensionSummary[]): Promise<void> {
    const desired = desiredClients(extensions)
    this.#queue = this.#queue.then(async () => {
      const next = new Map(desired.map((entry) => [entry.owner, entry]))
      for (const [owner, moduleUrl] of [...this.#mounted]) {
        if (next.get(owner)?.moduleUrl === moduleUrl) continue
        await this.runtime.unmount(owner)
        this.#mounted.delete(owner)
      }
      for (const entry of desired) {
        if (this.#mounted.has(entry.owner)) continue
        try {
          await this.runtime.mount(entry)
          this.#mounted.set(entry.owner, entry.moduleUrl)
          void this.#report(entry.owner, entry.revisionId, 'loaded').catch(() => undefined)
        } catch (error) {
          await this.runtime.unmount(entry.owner)
          void this.#report(entry.owner, entry.revisionId, 'failed', error).catch(() => undefined)
        }
      }
    })
    return this.#queue
  }

  async disableOwner(owner: string): Promise<void> {
    const extension = useProductStore.getState().extensions.find((candidate) => candidate.id === owner)
    if (extension?.installation) {
      void this.#report(owner, extension.installation.revisionId, 'failed', new Error('富消息组件渲染失败。')).catch(
        () => undefined,
      )
    }
    await this.runtime.unmount(owner)
    this.#mounted.delete(owner)
  }

  async dispose(): Promise<void> {
    await this.#queue.catch(() => undefined)
    this.#mounted.clear()
    await this.runtime.dispose()
  }

  async #report(owner: string, revisionId: string, status: 'loaded' | 'failed', error?: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '未知界面错误'
    await useProductStore.getState().reportHostExtensionClientDiagnostic({
      extensionId: owner,
      revisionId,
      status,
      ...(error === undefined ? {} : { message }),
    })
  }
}

const AdapterHostClientContext = createContext<AdapterHostClientCoordinator | null>(null)

export function AdapterHostClientProvider({ children }: { readonly children: ReactNode }) {
  const coordinator = useMemo(() => new AdapterHostClientCoordinator(), [])
  const disposeTimer = useRef<number | undefined>(undefined)
  const installationVersion = useProductStore((state) =>
    state.extensions
      .map((extension) => `${extension.id}:${extension.installation?.revisionId ?? ''}`)
      .sort()
      .join('|'),
  )

  useEffect(() => {
    if (disposeTimer.current !== undefined) window.clearTimeout(disposeTimer.current)
    void coordinator.sync(useProductStore.getState().extensions)
    return () => {
      disposeTimer.current = window.setTimeout(() => void coordinator.dispose(), 0)
    }
  }, [coordinator, installationVersion])

  return <AdapterHostClientContext.Provider value={coordinator}>{children}</AdapterHostClientContext.Provider>
}

class RichSlotBoundary extends Component<
  {
    readonly owner: string
    readonly fallback: ReactNode
    readonly onFailure: (owner: string) => void
    readonly children: ReactNode
  },
  { readonly failed: boolean }
> {
  override state = { failed: false }

  static getDerivedStateFromError(): { readonly failed: boolean } {
    return { failed: true }
  }

  override componentDidCatch(): void {
    this.props.onFailure(this.props.owner)
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

export function AdapterRichMessageRenderer({
  slotKey,
  props,
  fallback,
}: {
  readonly slotKey: string
  readonly props: AdapterRichMessageSlotProps
  readonly fallback: ReactNode
}) {
  const coordinator = useContext(AdapterHostClientContext)
  if (!coordinator) return fallback
  return (
    <MountedAdapterRichMessageRenderer coordinator={coordinator} slotKey={slotKey} props={props} fallback={fallback} />
  )
}

function MountedAdapterRichMessageRenderer({
  coordinator,
  slotKey,
  props,
  fallback,
}: {
  readonly coordinator: AdapterHostClientCoordinator
  readonly slotKey: string
  readonly props: AdapterRichMessageSlotProps
  readonly fallback: ReactNode
}) {
  const runtime = coordinator.runtime
  useSyncExternalStore(runtime.subscribe, runtime.version, runtime.version)
  const entry = runtime.entry('conversation.message.rich', slotKey)
  if (!entry) return fallback
  const Entry = entry.component
  return (
    <RichSlotBoundary
      key={`${entry.owner}:${entry.key}`}
      owner={entry.owner}
      fallback={fallback}
      onFailure={(owner) => void coordinator.disableOwner(owner)}
    >
      <Entry {...props} />
    </RichSlotBoundary>
  )
}

function AdapterRuntimeSlot<Name extends Exclude<AdapterClientSlotName, 'conversation.message.rich'>>({
  name,
  adapterKey,
  props,
}: {
  readonly name: Name
  readonly adapterKey: string
  readonly props: AdapterClientSlotPropsMap[Name]
}) {
  const coordinator = useContext(AdapterHostClientContext)
  if (!coordinator) return null
  const runtime = coordinator.runtime
  useSyncExternalStore(runtime.subscribe, runtime.version, runtime.version)
  const entry = runtime.entry(name, adapterKey)
  if (!entry) return null
  const Entry = entry.component
  return (
    <RichSlotBoundary
      key={`${entry.owner}:${name}:${entry.key}`}
      owner={entry.owner}
      fallback={null}
      onFailure={(owner) => void coordinator.disableOwner(owner)}
    >
      <Entry {...props} />
    </RichSlotBoundary>
  )
}

export function AdapterConnectionExtensionSlot({
  name,
  props,
}: {
  readonly name: 'connection.adapter.setup' | 'connection.adapter.status' | 'connection.adapter.test'
  readonly props: AdapterConnectionSlotProps
}) {
  return <AdapterRuntimeSlot name={name} adapterKey={props.adapterKey} props={props} />
}

export function AdapterChannelInspectorExtensionSlots(props: AdapterChannelInspectorSlotProps) {
  return <AdapterRuntimeSlot name="channel.inspector.adapter.sections" adapterKey={props.adapterKey} props={props} />
}
