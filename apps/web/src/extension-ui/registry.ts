import {
  ExtensionPanelDeclarationSchema,
  RichKindSchema,
  type ExtensionPanelDeclaration,
  type ExtensionUiContributions,
} from '@nekro-nxt/contracts'
import type {
  ExtensionMessageRendererProps,
  ExtensionPanelProps,
  ExtensionToolViewProps,
} from '@nekro-nxt/extension-sdk'
import type { ReactNode } from 'react'

/**
 * Who registered a contribution. An installed extension runs its Client once; its agent and channel panels and tool
 * views follow the agents it is enabled for (looked up live, so enabling never remounts the Client), its connection,
 * channel and rich-message contributions follow its own adapter. Dynamic owners are previews of a creation task and
 * follow the same rules for their agent.
 */
export type ContributionOwner =
  | {
      readonly kind: 'extension'
      readonly key: string
      readonly label: string
      readonly extensionId: string
      readonly revisionId: string
      /** The adapter this extension registers, if any. */
      readonly adapterKey?: string
      /** CSS boundary of this Revision's scoped stylesheet. */
      readonly styleScope: string
    }
  | {
      readonly kind: 'dynamic'
      readonly key: string
      readonly label: string
      readonly agentId: string
      readonly pluginId: string
      readonly styleScope: string
    }

export interface PanelEntry {
  readonly key: string
  readonly owner: ContributionOwner
  readonly declaration: ExtensionPanelDeclaration
  readonly component: (props: ExtensionPanelProps) => ReactNode
}

export interface ToolViewEntry {
  readonly key: string
  readonly owner: ContributionOwner
  readonly tool: string
  readonly component: (props: ExtensionToolViewProps) => ReactNode
}

export interface MessageRendererEntry {
  readonly key: string
  readonly owner: ContributionOwner
  readonly richKind: string
  readonly component: (props: ExtensionMessageRendererProps) => ReactNode
}

const component = <Props extends object>(value: unknown, label: string): ((props: Props) => ReactNode) => {
  if (typeof value !== 'function') throw new TypeError(`${label}必须注册 React 组件。`)
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- 组件已通过函数检查；Props 由宿主渲染入口提供。
  return value as (props: Props) => ReactNode
}

/**
 * The single live set of panels, tool views and message renderers from every Client the shell runs, installed or
 * previewed. Installed owners may only register what their Manifest declares; previews are checked by the Host
 * when the browser reports what it actually rendered.
 */
export class ContributionRegistry {
  readonly #panels = new Map<string, PanelEntry>()
  readonly #toolViews = new Map<string, ToolViewEntry>()
  readonly #messageRenderers = new Map<string, MessageRendererEntry>()
  readonly #listeners = new Set<() => void>()
  #version = 0
  #panelList: readonly PanelEntry[] = []
  #toolViewList: readonly ToolViewEntry[] = []
  #messageRendererList: readonly MessageRendererEntry[] = []

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  version = (): number => this.#version

  panels(): readonly PanelEntry[] {
    return this.#panelList
  }

  toolViews(): readonly ToolViewEntry[] {
    return this.#toolViewList
  }

  messageRenderers(): readonly MessageRendererEntry[] {
    return this.#messageRendererList
  }

  addPanel(
    owner: ContributionOwner,
    declarationInput: unknown,
    componentInput: unknown,
    declared?: ExtensionUiContributions,
  ): () => void {
    const declaration = ExtensionPanelDeclarationSchema.parse(declarationInput)
    if (declared && !declared.panels.some((panel) => panel.id === declaration.id)) {
      throw new Error(`面板 ${declaration.id} 未在扩展声明中出现。`)
    }
    const key = `${owner.key}\0${declaration.id}`
    if (this.#panels.has(key)) throw new Error(`面板重复注册：${declaration.id}`)
    const entry: PanelEntry = {
      key,
      owner,
      declaration,
      component: component<ExtensionPanelProps>(componentInput, `面板 ${declaration.id}`),
    }
    this.#panels.set(key, entry)
    this.#publish()
    return this.#remover(this.#panels, key, entry)
  }

  addToolView(
    owner: ContributionOwner,
    toolInput: unknown,
    componentInput: unknown,
    declared?: ExtensionUiContributions,
  ): () => void {
    if (typeof toolInput !== 'string' || !toolInput.trim() || toolInput.length > 64) {
      throw new TypeError('工具视图必须指定工具名。')
    }
    const tool = toolInput.trim()
    if (declared && !declared.toolViews.includes(tool)) throw new Error(`工具视图 ${tool} 未在扩展声明中出现。`)
    const key = `${owner.key}\0${tool}`
    if (this.#toolViews.has(key)) throw new Error(`工具视图重复注册：${tool}`)
    const entry: ToolViewEntry = {
      key,
      owner,
      tool,
      component: component<ExtensionToolViewProps>(componentInput, `工具视图 ${tool}`),
    }
    this.#toolViews.set(key, entry)
    this.#publish()
    return this.#remover(this.#toolViews, key, entry)
  }

  addMessageRenderer(
    owner: ContributionOwner,
    richKindInput: unknown,
    componentInput: unknown,
    declared?: ExtensionUiContributions,
  ): () => void {
    const richKind = RichKindSchema.parse(richKindInput)
    if (declared && !declared.messageRenderers.includes(richKind)) {
      throw new Error(`富消息渲染器 ${richKind} 未在扩展声明中出现。`)
    }
    const key = `${owner.key}\0${richKind}`
    if (this.#messageRenderers.has(key)) throw new Error(`富消息渲染器重复注册：${richKind}`)
    const entry: MessageRendererEntry = {
      key,
      owner,
      richKind,
      component: component<ExtensionMessageRendererProps>(componentInput, `富消息渲染器 ${richKind}`),
    }
    this.#messageRenderers.set(key, entry)
    this.#publish()
    return this.#remover(this.#messageRenderers, key, entry)
  }

  /** Removes everything one owner registered (unmount, reload or a failed render). */
  removeOwner(ownerKey: string): void {
    let changed = false
    for (const map of [this.#panels, this.#toolViews, this.#messageRenderers] as const) {
      for (const [key, entry] of map) {
        if (entry.owner.key !== ownerKey) continue
        map.delete(key)
        changed = true
      }
    }
    if (changed) this.#publish()
  }

  /** What one owner has registered so far; used to check installed Clients against their Manifest. */
  registeredBy(ownerKey: string): {
    readonly panels: readonly string[]
    readonly toolViews: readonly string[]
    readonly messageRenderers: readonly string[]
  } {
    return {
      panels: this.#panelList.filter((entry) => entry.owner.key === ownerKey).map((entry) => entry.declaration.id),
      toolViews: this.#toolViewList.filter((entry) => entry.owner.key === ownerKey).map((entry) => entry.tool),
      messageRenderers: this.#messageRendererList
        .filter((entry) => entry.owner.key === ownerKey)
        .map((entry) => entry.richKind),
    }
  }

  #remover<Entry>(map: Map<string, Entry>, key: string, entry: Entry): () => void {
    let active = true
    return () => {
      if (!active) return
      active = false
      if (map.get(key) !== entry) return
      map.delete(key)
      this.#publish()
    }
  }

  #publish(): void {
    this.#version += 1
    this.#panelList = [...this.#panels.values()]
    this.#toolViewList = [...this.#toolViews.values()]
    this.#messageRendererList = [...this.#messageRenderers.values()]
    for (const listener of this.#listeners) listener()
  }
}
