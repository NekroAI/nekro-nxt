import type { ExtensionUiContributions, HostUiPermission } from '@nekro-nxt/contracts'
import type { ExtensionClientContext, ExtensionClientHost, HostUiPageRegistry } from '@nekro-nxt/extension-sdk'
import type { ProductRuntime } from '../product-runtime.js'
import { createExtensionData } from './data.js'
import type { ContributionOwner, ContributionRegistry } from './registry.js'
import { extensionReactFacade, extensionUiKit } from './ui-kit.js'

export interface MountedClient {
  readonly owner: ContributionOwner
  dispose(): Promise<void>
}

export interface ClientMountInput {
  readonly owner: ContributionOwner
  readonly moduleUrl: string
  /** Scoped stylesheet of the same build; an empty response means the Revision has no CSS. */
  readonly cssUrl?: string
  /** What the Manifest declares; the Client must register exactly these. */
  readonly declared: ExtensionUiContributions
  readonly permissions: readonly HostUiPermission[]
  readonly host: ExtensionClientHost
  readonly registry: ContributionRegistry
  readonly store: ProductRuntime['store']
  /** Pages are rendered by the page runtime; other runtimes accept and ignore them. */
  readonly pages?: HostUiPageRegistry
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null

/** Installed CSS is linked by the shell, so `styles.insert` is a no-op that keeps preview source portable. */
const INSTALLED_STYLES = { insert: (): (() => void) => () => undefined }

const ignoredPages: HostUiPageRegistry = { register: () => () => undefined }

const loadStylesheet = async (href: string, owner: string): Promise<HTMLLinkElement> => {
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = href
  link.dataset['extensionUiStyles'] = owner
  await new Promise<void>((resolve, reject) => {
    link.addEventListener('load', () => resolve(), { once: true })
    link.addEventListener('error', () => reject(new Error('扩展样式加载失败。')), { once: true })
    document.head.append(link)
  }).catch((error: unknown) => {
    link.remove()
    throw error
  })
  return link
}

/**
 * Builds the context one Client's `apply(ctx)` receives. Every registration is tracked so disposal removes exactly
 * what this Client added, even if it never calls the returned disposers itself.
 */
export const createClientContext = (input: {
  readonly owner: ContributionOwner
  readonly registry: ContributionRegistry
  readonly store: ProductRuntime['store']
  readonly permissions: readonly HostUiPermission[]
  readonly declared?: ExtensionUiContributions
  readonly pages?: HostUiPageRegistry
}): { readonly context: ExtensionClientContext; dispose(): void } => {
  const disposers = new Set<() => void>()
  const track = (dispose: () => void): (() => void) => {
    const once = () => {
      if (!disposers.delete(once)) return
      dispose()
    }
    disposers.add(once)
    return once
  }
  const { owner, registry, declared } = input
  const context: ExtensionClientContext = {
    panels: { register: (declaration, component) => track(registry.addPanel(owner, declaration, component, declared)) },
    toolViews: { register: (tool, component) => track(registry.addToolView(owner, tool, component, declared)) },
    messageRenderers: {
      register: (richKind, component) => track(registry.addMessageRenderer(owner, richKind, component, declared)),
    },
    pages: input.pages ?? ignoredPages,
    data: createExtensionData(input.store, new Set(input.permissions)),
    ui: extensionUiKit,
  }
  return {
    context,
    dispose: () => {
      for (const dispose of [...disposers]) dispose()
    },
  }
}

/** Loads one installed Client build and applies it against the shared registry. */
export const mountClient = async (input: ClientMountInput): Promise<MountedClient> => {
  const stylesheet = input.cssUrl ? await loadStylesheet(input.cssUrl, input.owner.key) : undefined
  const scope = createClientContext(input)
  let disposeDefinition: (() => unknown) | undefined
  try {
    const loaded: unknown = await import(
      /* @vite-ignore */ `${input.moduleUrl}${input.moduleUrl.includes('?') ? '&' : '?'}nxt=${Date.now()}`
    )
    const factory = isRecord(loaded) ? loaded['default'] : undefined
    if (typeof factory !== 'function') throw new TypeError('扩展 Client 的默认导出必须是 factory。')
    const definition: unknown = await Reflect.apply(factory, undefined, [
      { React: extensionReactFacade, host: input.host, styles: INSTALLED_STYLES },
    ])
    const apply = typeof definition === 'function' ? definition : isRecord(definition) ? definition['apply'] : undefined
    if (typeof apply !== 'function') throw new TypeError('扩展 Client 必须返回带 apply(ctx) 的插件。')
    const disposed: unknown = await Reflect.apply(apply, definition, [scope.context])
    if (typeof disposed === 'function') disposeDefinition = () => Reflect.apply(disposed, definition, [])
    const registered = input.registry.registeredBy(input.owner.key)
    const missing = [
      ...input.declared.panels
        .filter((panel) => !registered.panels.includes(panel.id))
        .map((panel) => `面板 ${panel.id}`),
      ...input.declared.toolViews
        .filter((tool) => !registered.toolViews.includes(tool))
        .map((tool) => `工具视图 ${tool}`),
      ...input.declared.messageRenderers
        .filter((kind) => !registered.messageRenderers.includes(kind))
        .map((kind) => `富消息渲染器 ${kind}`),
    ]
    if (missing.length > 0) throw new Error(`扩展 Client 没有注册声明的内容：${missing.join('、')}`)
  } catch (error) {
    scope.dispose()
    input.registry.removeOwner(input.owner.key)
    stylesheet?.remove()
    throw error
  }
  let active = true
  return {
    owner: input.owner,
    dispose: async () => {
      if (!active) return
      active = false
      try {
        await disposeDefinition?.()
      } finally {
        scope.dispose()
        input.registry.removeOwner(input.owner.key)
        stylesheet?.remove()
      }
    },
  }
}
