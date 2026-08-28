import type {
  ExtensionJsonValue,
  HostUiClientEnvironment,
  HostUiClientContext,
  HostUiNavigationProvider,
  HostUiPageProps,
} from '@nekro-nxt/extension-sdk'
import {
  AdapterClientSlotNameSchema,
  HostUiNavigationModelSchema,
  parseJsonValue,
  type HostUiPageEntry,
} from '@nekro-nxt/contracts'
import * as React from 'react'
import { useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import {
  Button,
  Dialog,
  DropdownMenu,
  Field,
  IconButton,
  Input,
  SelectField,
  SidePane,
  Spinner,
  StatusBadge,
  SwitchControl,
  Tabs,
  Textarea,
  Tooltip,
} from './ui-kit/index.js'
import { EmptyState, InlineFeedback, PageHeader } from './components/product-feedback.js'
import { useProductStore } from './product-store.js'
import { DEFAULT_EXTENSION_CLIENT_STYLES } from './extension-client.js'
import { productHostEventStream, type HostEventStreamEvent, type HostEventStreamHandlers } from './host-event-stream.js'
import styles from './host-ui-client.module.css'

type PageComponent = (props: HostUiPageProps) => ReactNode
type PageRegistration = {
  readonly component: PageComponent
  readonly navigation?: HostUiNavigationProvider
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const toRelativePath = (value: string): string => {
  const normalized = value.trim().replace(/^\/+|\/+$/gu, '')
  if (!normalized) return ''
  if (!/^[a-z0-9][a-z0-9/_-]*$/u.test(normalized) || normalized.split('/').includes('..')) {
    throw new Error('页面只能在自己的 routeBase 内导航。')
  }
  return normalized
}

const HOST_UI_TOPIC_EVENTS: ReadonlyMap<string, readonly HostEventStreamEvent[]> = new Map([
  ['agents', ['status']],
  ['channels', ['channel-fact', 'binding-change']],
  ['connections', ['status']],
  ['extensions', ['extensions-changed']],
  ['dsh-plugins', ['dsh-plugins-changed', 'dsh-plugin-operation']],
  ['runtime', ['runtime', 'status']],
  ['messages', ['channel-fact']],
])

export const hostUiKit: HostUiClientEnvironment['ui'] = {
  Button,
  IconButton,
  Input,
  Textarea,
  Select: SelectField,
  Switch: SwitchControl,
  Tabs,
  Dialog,
  Popover: DropdownMenu,
  Tooltip,
  Field,
  StatusBadge,
  InlineFeedback,
  EmptyState,
  Spinner,
  PageHeader,
  Section: (props: { readonly children?: ReactNode }) => <section>{props.children}</section>,
  Stack: (props: { readonly children?: ReactNode }) => <div className={styles.stack}>{props.children}</div>,
  Grid: (props: { readonly children?: ReactNode }) => <div className={styles.grid}>{props.children}</div>,
  DataTable: (props: { readonly children?: ReactNode }) => (
    <div className={styles.tableScroll}>
      <table>{props.children}</table>
    </div>
  ),
  SidePane,
}

export class HostUiModuleRuntime {
  readonly #pages: readonly HostUiPageEntry[]
  readonly #registrations = new Map<string, PageRegistration>()
  readonly #listeners = new Set<() => void>()
  #load: Promise<void> | undefined
  #error: Error | undefined
  #disposeDefinition: (() => void | Promise<void>) | undefined
  #stylesheet: HTMLLinkElement | undefined
  #disposed = false
  #generation = 0
  #revision = 0
  #currentSnapshot: { readonly loading: boolean; readonly error?: Error; readonly revision: number } = {
    loading: false,
    revision: 0,
  }

  constructor(pages: readonly HostUiPageEntry[]) {
    this.#pages = pages
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  snapshot = (): { readonly loading: boolean; readonly error?: Error; readonly revision: number } =>
    this.#currentSnapshot

  registration(entryId: string): PageRegistration | undefined {
    return this.#registrations.get(entryId)
  }

  async ensureLoaded(): Promise<void> {
    if (this.#disposed) throw new Error('页面 Client Runtime 已停止。')
    if (this.#registrations.size > 0) return
    if (this.#load) return this.#load
    const generation = ++this.#generation
    this.#load = this.#mount(generation).catch((error: unknown) => {
      if (!this.#disposed && generation === this.#generation) {
        this.#error = error instanceof Error ? error : new Error(String(error))
        this.#emit()
      }
      throw error
    })
    this.#emit()
    return this.#load
  }

  retry(): void {
    if (this.#disposed) return
    const generation = ++this.#generation
    const dispose = this.#disposeDefinition
    this.#disposeDefinition = undefined
    this.#error = undefined
    this.#registrations.clear()
    this.#stylesheet?.remove()
    this.#stylesheet = undefined
    this.#load = Promise.resolve()
      .then(() => dispose?.())
      .then(() => this.#mount(generation))
      .catch((error: unknown) => {
        if (!this.#disposed && generation === this.#generation) {
          this.#error = error instanceof Error ? error : new Error(String(error))
          this.#emit()
        }
        throw error
      })
    this.#emit()
    void this.#load.catch(() => undefined)
  }

  async #mount(generation: number): Promise<void> {
    const first = this.#pages[0]
    if (!first) throw new Error('页面扩展没有可加载的入口。')
    await this.#mountStyles(first.client.moduleUrl)
    this.#assertGeneration(generation)
    const loaded: unknown = await import(/* @vite-ignore */ first.client.moduleUrl)
    this.#assertGeneration(generation)
    const factory = isRecord(loaded) ? loaded['default'] : undefined
    if (typeof factory !== 'function') throw new Error('页面 Client 默认导出必须是 factory。')
    const allowedEntryIds = new Set(this.#pages.map(({ entryId }) => entryId))
    const environment: HostUiClientEnvironment = {
      React: {
        createElement: (type, props, ...children) => React.createElement(type, props, ...children),
        Fragment: React.Fragment,
        useState: React.useState,
        useEffect: React.useEffect,
        useMemo: React.useMemo,
        useCallback: React.useCallback,
        useRef: React.useRef,
        useSyncExternalStore: React.useSyncExternalStore,
      },
      ui: hostUiKit,
      styles: DEFAULT_EXTENSION_CLIENT_STYLES,
      host: {
        call: (method, input = {}) => this.#call(first, method, input),
        subscribe: (topic, listener) => this.#subscribe(first, topic, listener),
      },
    }
    const context: HostUiClientContext = {
      ui: hostUiKit,
      slots: {
        register: (options) => {
          AdapterClientSlotNameSchema.parse(options.name)
          return () => undefined
        },
      },
      pages: {
        declarePermissions: () => undefined,
        register: (options, component) => {
          this.#assertGeneration(generation)
          const entryId = options.page.entryId
          if (!allowedEntryIds.has(entryId)) {
            throw new Error(`Client 注册了 Manifest 未声明的页面入口：${entryId}`)
          }
          const declared = this.#pages.find((page) => page.entryId === entryId)
          if (!declared) throw new Error(`页面入口未发布：${entryId}`)
          if (
            options.page.title !== declared.title ||
            options.page.objectPane !== declared.objectPane ||
            options.page.startPath !== declared.startPath
          ) {
            throw new Error(`Client 页面元数据与 Manifest 不一致：${entryId}`)
          }
          if (this.#registrations.has(entryId)) throw new Error(`页面入口重复注册：${entryId}`)
          this.#registrations.set(entryId, {
            component,
            ...(options.navigation === undefined ? {} : { navigation: options.navigation }),
          })
          this.#emit()
          return () => {
            this.#registrations.delete(entryId)
            this.#emit()
          }
        },
      },
    }
    const definition: unknown = await Reflect.apply(factory, undefined, [environment])
    this.#assertGeneration(generation)
    const definitionRecord = isRecord(definition) ? definition : undefined
    const apply = definitionRecord?.['apply']
    if (typeof apply !== 'function') throw new Error('页面 Client factory 必须返回 apply。')
    const dispose: unknown = await Reflect.apply(apply, definition, [context])
    if (generation !== this.#generation || this.#disposed) {
      this.#registrations.clear()
      if (typeof dispose === 'function') await Reflect.apply(dispose, definition, [])
      throw new Error('页面 Client Runtime 已被替换。')
    }
    if (typeof dispose === 'function') {
      this.#disposeDefinition = async () => {
        await Reflect.apply(dispose, definition, [])
      }
    }
    for (const entryId of allowedEntryIds) {
      if (!this.#registrations.has(entryId)) throw new Error(`页面 Client 未注册入口：${entryId}`)
    }
    await this.#report(first, 'ready')
    this.#emit()
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    this.#generation += 1
    const dispose = this.#disposeDefinition
    this.#disposeDefinition = undefined
    this.#registrations.clear()
    this.#stylesheet?.remove()
    this.#stylesheet = undefined
    this.#load = undefined
    this.#emit()
    await dispose?.()
  }

  async #mountStyles(moduleUrl: string): Promise<void> {
    if (this.#stylesheet) return
    const href = moduleUrl.replace(/\.mjs(?:\?.*)?$/u, '.css')
    if (href === moduleUrl) return
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = href
    link.dataset['hostUiStyles'] = moduleUrl
    this.#stylesheet = link
    await new Promise<void>((resolve, reject) => {
      link.addEventListener('load', () => resolve(), { once: true })
      link.addEventListener('error', () => reject(new Error('页面 CSS 加载失败。')), { once: true })
      document.head.append(link)
    }).catch((error) => {
      link.remove()
      if (this.#stylesheet === link) this.#stylesheet = undefined
      throw error
    })
  }

  #assertGeneration(generation: number): void {
    if (this.#disposed || generation !== this.#generation) throw new Error('页面 Client Runtime 已被替换。')
  }

  async #call(page: HostUiPageEntry, method: string, input: ExtensionJsonValue): Promise<ExtensionJsonValue> {
    const response = await fetch(`/api/host-ui/pages/${encodeURIComponent(page.pageInstanceId)}/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, input }),
    })
    const body: unknown = await response.json().catch(() => undefined)
    if (!response.ok) {
      const message =
        isRecord(body) && isRecord(body['error']) && typeof body['error']['message'] === 'string'
          ? body['error']['message']
          : `页面 RPC 请求失败（HTTP ${response.status}）。`
      throw new Error(message)
    }
    if (!isRecord(body) || !('value' in body)) throw new Error('页面 RPC 返回格式无效。')
    return parseJsonValue(body['value'])
  }

  #subscribe(page: HostUiPageEntry, topic: string, listener: (value: ExtensionJsonValue) => void): () => void {
    const events = HOST_UI_TOPIC_EVENTS.get(topic)
    if (!events) throw new Error(`页面订阅主题不受支持：${topic}`)
    let cancelled = false
    let unsubscribe = (): void => undefined
    void this.#call(page, 'events.subscribe', { topic })
      .then(() => {
        if (cancelled) return
        const handlers: HostEventStreamHandlers = Object.fromEntries(
          events.map((eventName) => [
            eventName,
            (event: unknown) => {
              if (cancelled || !(event instanceof MessageEvent) || typeof event.data !== 'string') return
              try {
                listener(parseJsonValue(JSON.parse(event.data)))
              } catch {
                // The shared stream has already validated product events; malformed extension projection is ignored.
              }
            },
          ]),
        )
        unsubscribe = productHostEventStream.subscribe(handlers)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
      unsubscribe()
    }
  }

  async #report(page: HostUiPageEntry, status: 'ready' | 'load-failed', message?: string): Promise<void> {
    await fetch(`/api/host-ui/pages/${encodeURIComponent(page.pageInstanceId)}/diagnostic`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status, ...(message === undefined ? {} : { message }) }),
    }).catch(() => undefined)
  }

  #emit(): void {
    this.#revision += 1
    this.#currentSnapshot = {
      loading: this.#load !== undefined && !this.#error && this.#registrations.size === 0,
      ...(this.#error === undefined ? {} : { error: this.#error }),
      revision: this.#revision,
    }
    for (const listener of this.#listeners) listener()
  }
}

type HostUiRuntimeContextValue = {
  runtimeFor(page: HostUiPageEntry): HostUiModuleRuntime
}

const HostUiRuntimeContext = React.createContext<HostUiRuntimeContextValue | null>(null)

export function HostUiClientProvider({ children }: { readonly children: ReactNode }) {
  const pages = useProductStore((state) => state.hostUi.pages)
  const runtimes = useMemo(() => new Map<string, HostUiModuleRuntime>(), [])
  const value = useMemo<HostUiRuntimeContextValue>(
    () => ({
      runtimeFor(page) {
        const key = `${page.client.moduleUrl}:${page.client.buildKey}`
        let runtime = runtimes.get(key)
        if (!runtime) {
          const ownerPages = pages.filter(
            (candidate) =>
              candidate.client.moduleUrl === page.client.moduleUrl &&
              candidate.client.buildKey === page.client.buildKey,
          )
          runtime = new HostUiModuleRuntime(ownerPages)
          runtimes.set(key, runtime)
        }
        return runtime
      },
    }),
    [pages, runtimes],
  )
  useEffect(() => {
    const activeKeys = new Set(pages.map((page) => `${page.client.moduleUrl}:${page.client.buildKey}`))
    for (const [key, runtime] of runtimes) {
      if (activeKeys.has(key)) continue
      runtimes.delete(key)
      void runtime.dispose()
    }
  }, [pages, runtimes])
  useEffect(
    () => () => {
      for (const runtime of runtimes.values()) void runtime.dispose()
      runtimes.clear()
    },
    [runtimes],
  )
  return <HostUiRuntimeContext.Provider value={value}>{children}</HostUiRuntimeContext.Provider>
}

const useRuntime = (page: HostUiPageEntry): HostUiModuleRuntime => {
  const context = React.useContext(HostUiRuntimeContext)
  if (!context) throw new Error('Host UI Runtime Provider 未挂载。')
  return context.runtimeFor(page)
}

class PageErrorBoundary extends React.Component<
  { readonly children: ReactNode; readonly resetKey: string },
  { readonly error: Error | null }
> {
  override state: { readonly error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  override componentDidUpdate(previous: Readonly<{ readonly resetKey: string }>): void {
    if (previous.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null })
  }

  override render() {
    if (!this.state.error) return this.props.children
    return (
      <EmptyState
        title="页面运行失败"
        description={this.state.error.message}
        action={<Button onClick={() => this.setState({ error: null })}>重新加载页面</Button>}
      />
    )
  }
}

export function HostUiPageCanvas() {
  const { pageInstanceId = '', '*': wildcard = '' } = useParams<{ pageInstanceId: string; '*': string }>()
  const page = useProductStore((state) =>
    state.hostUi.pages.find((candidate) => candidate.pageInstanceId === pageInstanceId),
  )
  if (!page) {
    return <EmptyState title="页面入口已撤销" description="扩展已更新、关闭或移除。" />
  }
  return <MountedPageCanvas key={`${page.pageInstanceId}:${page.client.buildKey}`} page={page} wildcard={wildcard} />
}

function MountedPageCanvas({ page, wildcard }: { readonly page: HostUiPageEntry; readonly wildcard: string }) {
  const runtime = useRuntime(page)
  const snapshot = useSyncExternalStore(runtime.subscribe, runtime.snapshot, runtime.snapshot)
  const navigate = useNavigate()
  const location = useLocation()
  useEffect(() => {
    void runtime.ensureLoaded().catch(async (error: unknown) => {
      await fetch(`/api/host-ui/pages/${encodeURIComponent(page.pageInstanceId)}/diagnostic`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          status: 'load-failed',
          message: error instanceof Error ? error.message : String(error),
        }),
      }).catch(() => undefined)
    })
  }, [page.pageInstanceId, runtime])
  const registration = runtime.registration(page.entryId)
  if (snapshot.error) {
    return (
      <EmptyState
        title="无法加载扩展页面"
        description={snapshot.error.message}
        action={
          <Button onClick={() => runtime.retry()}>
            <RefreshCw size={14} aria-hidden="true" /> 重试
          </Button>
        }
      />
    )
  }
  if (!registration) {
    return (
      <div className={styles.loading}>
        <Spinner size={22} />
        <span>正在加载 {page.title}</span>
      </div>
    )
  }
  const search = Object.fromEntries(new URLSearchParams(location.search).entries())
  const props: HostUiPageProps = {
    pageInstanceId: page.pageInstanceId,
    entryId: page.entryId,
    relativePath: wildcard,
    search,
    navigate(path, options) {
      const relative = toRelativePath(path)
      void navigate(`${page.routeBase}${relative ? `/${relative}` : ''}`, {
        ...(options?.replace === undefined ? {} : { replace: options.replace }),
      })
    },
  }
  return (
    <PageErrorBoundary resetKey={`${page.client.buildKey}:${wildcard}:${location.search}`}>
      <div className={styles.pageRoot} data-host-ui-page={page.pageInstanceId}>
        {React.createElement(registration.component, props)}
      </div>
    </PageErrorBoundary>
  )
}

export function HostUiObjectPane({ page }: { readonly page: HostUiPageEntry }) {
  const runtime = useRuntime(page)
  const snapshot = useSyncExternalStore(runtime.subscribe, runtime.snapshot, runtime.snapshot)
  useEffect(() => void runtime.ensureLoaded().catch(() => undefined), [runtime])
  const registration = runtime.registration(page.entryId)
  if (snapshot.error) {
    return (
      <div className={styles.navigationFeedback}>
        <AlertTriangle size={18} aria-hidden="true" />
        <strong>导航不可用</strong>
        <span>{snapshot.error.message}</span>
      </div>
    )
  }
  if (!registration?.navigation)
    return (
      <div className={styles.navigationLoading}>
        <Spinner size={18} />
      </div>
    )
  return <HostUiNavigation page={page} provider={registration.navigation} />
}

function HostUiNavigation({
  page,
  provider,
}: {
  readonly page: HostUiPageEntry
  readonly provider: HostUiNavigationProvider
}) {
  const navigate = useNavigate()
  let model
  try {
    model = HostUiNavigationModelSchema.parse(
      useSyncExternalStore(
        (listener) => provider.subscribe(listener),
        () => provider.getSnapshot(),
        () => provider.getSnapshot(),
      ),
    )
  } catch (error) {
    return (
      <InlineFeedback tone="error" role="alert">
        {error instanceof Error ? error.message : String(error)}
      </InlineFeedback>
    )
  }
  return (
    <nav className={styles.navigation} aria-label={`${page.title}导航`}>
      <PageHeader title={page.title} meta={page.description} quiet />
      {model.groups.map((group) => (
        <section key={group.id} className={styles.navigationGroup}>
          {group.label ? <h2>{group.label}</h2> : null}
          {group.items.map((item) => (
            <Button
              key={item.id}
              variant="ghost"
              size="small"
              disabled={item.disabledReason !== undefined}
              title={item.disabledReason}
              onClick={() => {
                const relative = toRelativePath(item.path)
                void navigate(`${page.routeBase}${relative ? `/${relative}` : ''}`)
              }}
            >
              <span>
                <strong>{item.label}</strong>
                {item.description ? <small>{item.description}</small> : null}
              </span>
              {item.badge ? (
                <StatusBadge tone={item.status === 'error' ? 'error' : (item.status ?? 'neutral')}>
                  {item.badge}
                </StatusBadge>
              ) : null}
            </Button>
          ))}
        </section>
      ))}
    </nav>
  )
}
