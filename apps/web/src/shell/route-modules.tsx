import { useEffect, useState, type ComponentType } from 'react'
import { create } from 'zustand'
import { EmptyState, InlineFeedback } from '../components/product-feedback.js'
import { Button } from '../ui-kit/index.js'

function pageModule(load: () => Promise<ComponentType>, entry: string, exportName: string) {
  let retryUrl: URL | undefined
  let attempt = 0
  const retry = async (): Promise<ComponentType> => {
    if (!retryUrl) return load()
    const url = new URL(retryUrl)
    url.searchParams.set('nxt-retry', String(++attempt))
    // Failed ESM fetches are cached by the browser. Retry only the known, same-origin
    // route entry; shared runtime imports keep their original URLs and identity.
    const module: unknown = await import(/* @vite-ignore */ url.href)
    const component: unknown = module && typeof module === 'object' ? Reflect.get(module, exportName) : undefined
    if (!isPageComponent(component)) throw new Error('页面模块缺少入口。')
    return component
  }
  let component: ComponentType | undefined
  let pending: Promise<void> | undefined
  return {
    get component() {
      return component
    },
    load: () => {
      if (component) return Promise.resolve()
      pending ??= retry().then(
        (value) => {
          component = value
        },
        (cause: unknown) => {
          pending = undefined
          if (cause instanceof Error && typeof window !== 'undefined') {
            const match = cause.message.match(/https?:\/\/[^\s]+/u)?.[0]
            if (match) {
              const url = new URL(match)
              if (
                url.origin === window.location.origin &&
                url.pathname.startsWith(`/assets/${entry}-`) &&
                url.pathname.endsWith('.js')
              )
                retryUrl = url
            }
          }
          throw cause
        },
      )
      return pending
    },
  }
}
function isPageComponent(value: unknown): value is ComponentType {
  return typeof value === 'function'
}
const modules = {
  agents: pageModule(
    () => import('../pages/agents-page.js').then((module) => module.AgentsPage),
    'agents-page',
    'AgentsPage',
  ),
  agent: pageModule(
    () => import('../pages/agents-page.js').then((module) => module.AgentManagePage),
    'agents-page',
    'AgentManagePage',
  ),
  creator: pageModule(
    () => import('../pages/extensions-runtime-pages.js').then((module) => module.CreatorPage),
    'extensions-runtime-pages',
    'CreatorPage',
  ),
  extensions: pageModule(
    () => import('../pages/extensions-runtime-pages.js').then((module) => module.ExtensionsPage),
    'extensions-runtime-pages',
    'ExtensionsPage',
  ),
  settings: pageModule(
    () => import('../pages/settings-page.js').then((module) => module.SettingsPage),
    'settings-page',
    'SettingsPage',
  ),
}
type PageName = keyof typeof modules
const routeModule = (path: string) => {
  const pathname = path.split('?')[0] ?? path
  if (pathname === '/work/agents/new') return modules.agents
  if (pathname.startsWith('/work/agents/')) return modules.agent
  if (pathname.startsWith('/work/creator')) return modules.creator
  if (pathname.startsWith('/extensions')) return modules.extensions
  if (pathname.startsWith('/settings')) return modules.settings
  return undefined
}
export function loadRouteModule(path: string): Promise<void> {
  return routeModule(path)?.load() ?? Promise.resolve()
}
export function prefetchRoute(path: string): void {
  void loadRouteModule(path).catch(() => undefined)
}
const useRouteLoad = create<{ pending: boolean; error: string; retry: (() => void) | undefined }>(() => ({
  pending: false,
  error: '',
  retry: undefined,
}))
let navigationGeneration = 0
export function cancelPreparedNavigation(): void {
  navigationGeneration += 1
  useRouteLoad.setState({ pending: false, error: '', retry: undefined })
}
export function navigateWithRouteModule(path: string, go: () => void): void {
  const token = ++navigationGeneration
  const module = routeModule(path)
  if (!module || module.component) {
    useRouteLoad.setState({ pending: false, error: '', retry: undefined })
    go()
    return
  }
  useRouteLoad.setState({ pending: true, error: '', retry: undefined })
  void module.load().then(
    () => {
      if (token !== navigationGeneration) return
      useRouteLoad.setState({ pending: false, error: '', retry: undefined })
      go()
    },
    () => {
      if (token !== navigationGeneration) return
      useRouteLoad.setState({
        pending: false,
        error: '页面加载失败，当前页面和草稿已保留。',
        retry: () => navigateWithRouteModule(path, go),
      })
    },
  )
}
export function RouteLoadNotice() {
  const state = useRouteLoad()
  if (!state.pending && !state.error) return null
  return (
    <div role="status" style={{ position: 'absolute', top: 56, right: 16, zIndex: 2 }}>
      <InlineFeedback tone={state.error ? 'error' : 'info'}>
        {state.error || '正在加载页面…'}
        {state.retry ? (
          <Button size="small" onClick={state.retry}>
            重试加载
          </Button>
        ) : null}
        <Button size="small" variant="ghost" onClick={cancelPreparedNavigation}>
          取消
        </Button>
      </InlineFeedback>
    </div>
  )
}
export function DeferredProductPage({ name }: { readonly name: PageName }) {
  const [, update] = useState(0)
  const [error, setError] = useState(false)
  const module = modules[name]
  useEffect(() => {
    let active = true
    void module.load().then(
      () => {
        if (active) update((value) => value + 1)
      },
      () => {
        if (active) setError(true)
      },
    )
    return () => {
      active = false
    }
  }, [module])
  const Component = module.component
  if (Component) return <Component />
  return (
    <EmptyState
      loading={!error}
      title={error ? '页面加载失败' : '正在加载页面'}
      description={error ? '请重试，未保存的频道草稿仍保留在当前客户端。' : '页面准备完成后会自动显示。'}
      action={
        error ? (
          <Button
            onClick={() => {
              setError(false)
              void module.load().then(
                () => update((value) => value + 1),
                () => setError(true),
              )
            }}
          >
            重试加载
          </Button>
        ) : undefined
      }
    />
  )
}
