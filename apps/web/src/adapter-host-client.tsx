import { Context, Service } from '@deepseek-ai/cordis'
import type { AdapterRichMessageSlotProps, ExtensionClientStyles } from '@nekro-nxt/extension-sdk'
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

const CLIENT_STYLES: ExtensionClientStyles = {
  section: 'nxt-extension-section',
  sectionHeading: 'nxt-extension-section-heading',
  secondaryText: 'nxt-extension-secondary-text',
  actionRow: 'nxt-extension-action-row',
  button: 'nxt-extension-button',
  badge: 'nxt-extension-badge',
}

interface AdapterClientEntry {
  readonly owner: string
  readonly key: string
  readonly component: (props: AdapterRichMessageSlotProps) => ReactNode
}

class AdapterSlotsService extends Service {
  private readonly adapterKey: string
  private readonly registerSlot: (key: string, component: unknown) => () => void

  constructor(
    context: Context,
    config: { readonly adapterKey: string; readonly register: (key: string, component: unknown) => () => void },
  ) {
    super(context, 'slots')
    this.adapterKey = config.adapterKey
    this.registerSlot = config.register
  }

  register(options: unknown, component: unknown): () => void {
    const record = requireModuleRecord(options, 'Adapter Client Slot options')
    if (record['name'] !== 'conversation.message.rich') {
      throw new Error('Adapter Client V1 只允许 conversation.message.rich。')
    }
    const key = record['id']
    if (typeof key !== 'string' || !key.startsWith(`${this.adapterKey}:`) || key.length <= this.adapterKey.length + 1) {
      throw new Error(`Adapter Client Slot key 必须使用 ${this.adapterKey}:<kind>。`)
    }
    const slotComponent = requireProductSlotComponent<AdapterRichMessageSlotProps>(
      component,
      'Adapter Client Slot component',
    )
    const dispose = this.registerSlot(key, slotComponent)
    this.ctx.effect(() => dispose, 'nekro-nxt: Adapter Client rich message Slot')
    return dispose
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

  entry(key: string): AdapterClientEntry | undefined {
    return this.#entries.get(key)
  }

  async mount(input: {
    readonly owner: string
    readonly adapterKey: string
    readonly moduleUrl: string
    readonly allowedKeys: readonly string[]
  }): Promise<void> {
    if (this.#disposed) throw new Error('Adapter Host Client Runtime is disposed.')
    if (this.#contexts.has(input.owner)) throw new Error('Adapter Host Client is already mounted.')
    const context = new Context()
    const ownedKeys = new Set<string>()
    const register = (key: string, component: unknown): (() => void) => {
      if (!input.allowedKeys.includes(key)) throw new Error(`Adapter Client 注册了未声明的 rich key：${key}`)
      if (this.#entries.has(key)) throw new Error(`Adapter rich key 已注册：${key}`)
      const entry: AdapterClientEntry = {
        owner: input.owner,
        key,
        component: requireProductSlotComponent<AdapterRichMessageSlotProps>(component, 'Adapter rich component'),
      }
      this.#entries.set(key, entry)
      ownedKeys.add(key)
      this.#publish()
      let active = true
      return () => {
        if (!active) return
        active = false
        if (this.#entries.get(key) === entry) this.#entries.delete(key)
        ownedKeys.delete(key)
        this.#publish()
      }
    }
    try {
      const loaded = requireModuleRecord(
        await import(`${input.moduleUrl}${input.moduleUrl.includes('?') ? '&' : '?'}nxt=${Date.now()}`),
        'Adapter Client module',
      )
      const factory = requireExtensionPluginFactory(loaded['default'])
      const plugin = await factory({
        React,
        styles: CLIENT_STYLES,
        host: { call: () => Promise.reject(new Error('Adapter Client V1 不提供 Host RPC。')) },
      })
      await context.plugin(AdapterSlotsService, { adapterKey: input.adapterKey, register })
      await context.plugin(requireCordisPlugin(plugin, 'Adapter Client factory result'))
      if (input.allowedKeys.some((key) => !ownedKeys.has(key))) {
        throw new Error('Adapter Client 没有注册 Manifest 声明的全部 rich key。')
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
  readonly allowedKeys: readonly string[]
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
        allowedKeys: revision.hostSlots.map(({ key }) => key),
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
  const entry = runtime.entry(slotKey)
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
