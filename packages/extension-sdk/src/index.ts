import { DSH_RUNTIME_RELEASE } from '@nekro-nxt/dsh-compat/release'
import type { AdapterHostContributionV2 } from '@nekro-nxt/adapter-sdk'
import type { ElementType, ReactNode } from 'react'
import { EXTENSION_DATA_HOOK_PERMISSIONS, EXTENSION_SDK_LEVEL } from '@nekro-nxt/contracts'
import type {
  ConfigSchemaDocument,
  ConnectionPanelRole,
  ExtensionPanelAnchor,
  ExtensionPanelDeclaration,
  HostPageContribution,
  HostUiKitComponentName,
  HostUiNavigationModel,
  HostUiPermission,
  MessagePart,
  PanelDensity,
  ToolViewDensity,
} from '@nekro-nxt/contracts'

export type {
  ConfigSchemaDocument,
  ConnectionPanelRole,
  ExtensionPanelAnchor,
  ExtensionPanelDeclaration,
  HostIconName,
  HostPageContribution,
  HostUiKitComponentName,
  HostUiNavigationModel,
  HostUiPermission,
  HostUiPermissionDeclaration,
  PanelDensity,
  ToolViewDensity,
} from '@nekro-nxt/contracts'

export { configSchema } from '@nekro-nxt/contracts'

export type {
  AdapterConnectionHostContext,
  AdapterConnectionRuntime,
  AdapterDeliveryReceipt,
  AdapterHostContributionV2,
  AdapterStoredConnectionConfiguration,
  AdapterOutboundCapabilities,
  AdapterWebSocketConnection,
  PhysicalDeliveryRequest,
} from '@nekro-nxt/adapter-sdk'

export type ExtensionJsonValue =
  null | boolean | number | string | readonly ExtensionJsonValue[] | { readonly [key: string]: ExtensionJsonValue }

export type ExtensionJsonObject = { readonly [key: string]: ExtensionJsonValue }

export interface ExtensionJsonSchema {
  readonly type: string
  readonly description?: string
  readonly properties?: Readonly<Record<string, ExtensionJsonSchema>>
  readonly required?: readonly string[]
  readonly additionalProperties?: boolean
  readonly items?: ExtensionJsonSchema
  readonly enum?: readonly ExtensionJsonValue[]
  readonly const?: ExtensionJsonValue
}

export type ExtensionToolParameter = Omit<ExtensionJsonSchema, 'required'> & {
  readonly required?: boolean
}

export interface ExtensionToolResultBlock {
  readonly type: 'text'
  readonly text: string
}

export interface ExtensionToolDefinition<
  Args extends ExtensionJsonObject = ExtensionJsonObject,
  Output extends ExtensionJsonValue = ExtensionJsonValue,
> {
  readonly name: string
  readonly description: string
  readonly parameters: Readonly<Record<string, ExtensionToolParameter>>
  readonly output: {
    readonly schema: ExtensionJsonSchema
    render(args: Args, value: Output): readonly ExtensionToolResultBlock[]
  }
  execute(args: Args): Output | Promise<Output>
}

export interface ExtensionToolRegistry {
  register(tool: ExtensionToolDefinition): () => void
}

export interface ExtensionHostContext {
  readonly tools: ExtensionToolRegistry
  /** Present when the plugin declares `inject: ['tools', 'nxt']`; see {@link NxtHostService}. */
  readonly nxt?: NxtHostService
}

/** Request accepted by `ctx.nxt.http.fetch`; `body` and `bodyBase64` are mutually exclusive. */
export interface NxtFetchInit {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string
  readonly bodyBase64?: string
}

export interface NxtFetchResponse {
  /** Final URL after redirects. */
  readonly url: string
  readonly status: number
  /** Lower-case header names; `set-cookie` is removed. */
  readonly headers: Readonly<Record<string, string>>
  readonly contentType: string
  /** Present for textual responses (text, JSON, XML, JavaScript). */
  readonly text?: string
  /** Present for every other response. */
  readonly base64?: string
}

export interface NxtAssetCreateInput {
  readonly text?: string
  readonly base64?: string
  readonly mediaType?: string
  readonly name?: string
}

export interface NxtAssetRecord {
  /** Pass to the agent so it can send the asset with `send_channel_message` image/file/audio parts. */
  readonly assetId: string
  readonly byteSize: number
  readonly mediaType: string
}

export type NxtStorageScope = 'agent' | 'channel' | 'member' | 'shared'

export interface NxtStorageOptions {
  /** Defaults to `agent`. Must be listed in `permissions.capabilities.storage.scopes`. */
  readonly scope?: NxtStorageScope
  /** Required for `member` scope: a channel member ID from `context.current()` or history. */
  readonly memberId?: string
}

export interface NxtStorageListOptions extends NxtStorageOptions {
  readonly prefix?: string
  /** 1–200, default 50. */
  readonly limit?: number
  /** `next` from the previous page. */
  readonly after?: string
}

export interface NxtStorageEntry {
  readonly key: string
  readonly value: ExtensionJsonValue
  readonly updatedAt: number
}

export interface NxtMemberSummary {
  readonly memberId: string
  readonly displayName?: string
}

export interface NxtCallContext {
  readonly agent: { readonly id: string; readonly name: string }
  readonly channel: {
    readonly id: string
    readonly kind: 'internal' | 'direct' | 'group'
    readonly displayName?: string
    /** Connection display name, e.g. the platform account the channel belongs to. */
    readonly connectionName?: string
  }
  /** The newest inbound message in this channel when the call started, if any. */
  readonly latestInbound?: {
    readonly logicalMessageId: string
    readonly sender?: NxtMemberSummary
    readonly text: string
    readonly receivedAt: number
  }
}

export interface NxtHistoryMessage {
  readonly logicalMessageId: string
  readonly direction: 'inbound' | 'outbound'
  readonly sender?: NxtMemberSummary
  readonly text: string
  readonly occurredAt: number
  /** Opaque pagination cursor for `history.list({ before })`. */
  readonly cursor: string
}

export interface NxtLlmRequest {
  /** Task instructions for this call; the Host prefixes that it serves the extension and must not call tools. */
  readonly system?: string
  readonly messages: readonly { readonly role: 'user' | 'assistant'; readonly text: string }[]
  /** Capped by the declared `maxOutputTokens`. */
  readonly maxOutputTokens?: number
}

export interface NxtLlmResponse {
  readonly text: string
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number }
}

/** Read-only view handed to dynamic context renderers; it cannot reach the network or the model. */
export interface NxtPromptRenderApi {
  readonly storage: Pick<NxtHostService['storage'], 'get' | 'list'>
  readonly context: NxtCallContext
}

/**
 * NekroNXT Host capabilities for agent-scope extensions. Every call is async and JSON in, JSON out; a call that
 * needs an undeclared or unapproved capability throws an error naming the Manifest field to add.
 */
export interface NxtHostService {
  readonly http: {
    /** Requires `permissions.capabilities.network`. */
    fetch(url: string, init?: NxtFetchInit): Promise<NxtFetchResponse>
  }
  readonly secrets: {
    /** Reads a `meta.role: 'secret'` config field; `undefined` until the user sets it. */
    get(key: string): Promise<string | undefined>
  }
  readonly assets: {
    /** Requires `permissions.capabilities.assets`. Saves a current-channel Asset (max 8 MiB). */
    create(input: NxtAssetCreateInput): Promise<NxtAssetRecord>
    /** Requires `assets` and `network`; downloads through the controlled fetch. */
    fromUrl(url: string, options?: { readonly name?: string }): Promise<NxtAssetRecord>
  }
  readonly storage: {
    get(key: string, options?: NxtStorageOptions): Promise<ExtensionJsonValue | undefined>
    set(key: string, value: ExtensionJsonValue, options?: NxtStorageOptions): Promise<void>
    delete(key: string, options?: NxtStorageOptions): Promise<boolean>
    list(
      options?: NxtStorageListOptions,
    ): Promise<{ readonly entries: readonly NxtStorageEntry[]; readonly next?: string }>
  }
  readonly context: {
    current(): Promise<NxtCallContext>
  }
  readonly history: {
    /** Requires `permissions.capabilities.history`. Newest first, current channel only. */
    list(options?: {
      readonly limit?: number
      readonly before?: string
    }): Promise<{ readonly messages: readonly NxtHistoryMessage[]; readonly next?: string }>
    search(query: string, options?: { readonly limit?: number }): Promise<readonly NxtHistoryMessage[]>
  }
  readonly llm: {
    /**
     * One completion with the agent's configured model, counted in the agent's usage. Requires
     * `permissions.capabilities.llm`; calls beyond `maxCallsPerTurn` in one turn are rejected.
     */
    complete(request: NxtLlmRequest): Promise<NxtLlmResponse>
  }
  readonly prompt: {
    /** Fixed text added to the system prompt; declare `{ name, kind: 'static' }` in `permissions.capabilities.context`. */
    static(name: string, text: string): () => void
    /**
     * Rendered once at the start of each turn and appended to the runtime context only when it changes. Keep it
     * coarse: no timestamps, random values or exact counters. Declare `{ name, kind: 'dynamic' }`.
     */
    dynamic(name: string, render: (api: NxtPromptRenderApi) => string | Promise<string>): () => void
  }
}

export type ExtensionRpcHandler = (input: ExtensionJsonValue) => ExtensionJsonValue | Promise<ExtensionJsonValue>

export interface ExtensionPluginDefinition<Context = ExtensionHostContext> {
  readonly inject?: readonly string[]
  apply(context: Context): void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>
}

export interface ExtensionHostEnvironment {
  readonly harness: {
    defineTool<Args extends ExtensionJsonObject, Output extends ExtensionJsonValue>(
      options: ExtensionToolDefinition<Args, Output>,
    ): ExtensionToolDefinition<Args, Output>
    registerTool(context: ExtensionHostContext, tool: ExtensionToolDefinition): () => void
    handle(method: string, handler: ExtensionRpcHandler): () => void
    /** Host-scoped Adapter Revisions register exactly one contribution during factory evaluation. */
    registerAdapter(contribution: AdapterHostContributionV2): () => void
    /**
     * Current configuration validated against the Manifest config schema. Dynamic runs have no saved configuration;
     * read it as `harness.config?.() ?? {}` so the same source works before and after saving.
     */
    config(): ExtensionJsonValue
  }
  readonly config: ExtensionJsonValue
}

export type AdapterRichMessagePart = Extract<MessagePart, { readonly type: 'rich' }>

/** Props of every panel. The panel reads the object it is anchored to through `ctx.data`. */
export interface ExtensionPanelProps {
  readonly anchor: { readonly kind: ExtensionPanelAnchor; readonly id: string }
  readonly density: PanelDensity
  readonly role?: ConnectionPanelRole
}

export interface ExtensionToolCall {
  readonly callId: string
  readonly toolName: string
  readonly state: 'running' | 'succeeded' | 'failed'
  readonly input?: string
  readonly result?: string
  readonly durationMs?: number
}

/** `chip` is the one-line summary in the conversation; `card` is the expanded x-ray view. */
export interface ExtensionToolViewProps {
  readonly call: ExtensionToolCall
  readonly density: ToolViewDensity
}

export interface ExtensionMessageRendererProps {
  readonly part: AdapterRichMessagePart
  readonly messageId: string
  readonly channelId: string
}

export interface ExtensionPanelRegistry {
  register(declaration: ExtensionPanelDeclaration, component: (props: ExtensionPanelProps) => ReactNode): () => void
}

export interface ExtensionToolViewRegistry {
  register(tool: string, component: (props: ExtensionToolViewProps) => ReactNode): () => void
}

export interface ExtensionMessageRendererRegistry {
  register(richKind: string, component: (props: ExtensionMessageRendererProps) => ReactNode): () => void
}

export interface HostUiPageProps {
  readonly pageInstanceId: string
  readonly entryId: string
  readonly relativePath: string
  readonly search: Readonly<Record<string, string>>
  navigate(path: string, options?: { readonly replace?: boolean }): void
}

export interface HostUiNavigationProvider {
  getSnapshot(): HostUiNavigationModel
  subscribe(listener: () => void): () => void
}

export interface HostUiPageRegistry {
  register(
    options: {
      readonly page: HostPageContribution
      readonly navigation?: HostUiNavigationProvider
    },
    component: (props: HostUiPageProps) => ReactNode,
  ): () => void
}

export interface ExtensionAgentView {
  readonly id: string
  readonly name: string
  readonly phase: 'idle' | 'thinking' | 'using-tool' | 'waiting-input' | 'unavailable'
}

export interface ExtensionChannelView {
  readonly id: string
  readonly name: string
  readonly kind: 'internal' | 'direct' | 'group'
  readonly connectionId: string
  readonly agentId?: string
}

export interface ExtensionConnectionView {
  readonly id: string
  readonly adapterKey: string
  readonly name: string
  readonly state: 'stopped' | 'connecting' | 'connected' | 'reconnecting' | 'failed'
}

export interface ExtensionChannelRuntimeView {
  readonly channelId: string
  readonly phase: 'idle' | 'thinking' | 'using-tool' | 'waiting-input' | 'unavailable'
  readonly contextTokens?: number
  readonly contextWindow?: number
}

/**
 * Read-only product data for UI contributions. Each Hook re-renders on product events and requires the matching
 * permission (`agents.read`, `channels.read`, `connections.read`, `runtime.read`); without it the Hook throws.
 */
export interface ExtensionClientData {
  useAgent(agentId: string): ExtensionAgentView | undefined
  useChannel(channelId: string): ExtensionChannelView | undefined
  useConnection(connectionId: string): ExtensionConnectionView | undefined
  useChannelRuntime(channelId: string): ExtensionChannelRuntimeView | undefined
}

/** Everything one Client half can register. Unused registries are simply ignored. */
export interface ExtensionClientContext {
  readonly panels: ExtensionPanelRegistry
  readonly toolViews: ExtensionToolViewRegistry
  readonly messageRenderers: ExtensionMessageRendererRegistry
  readonly pages: HostUiPageRegistry
  readonly data: ExtensionClientData
  readonly ui: HostUiKit
}

export type HostUiReactFacade = {
  createElement(type: ElementType, props?: object | null, ...children: ReactNode[]): ReactNode
  readonly Fragment: unknown
  useState<Value>(initial: Value | (() => Value)): [Value, (value: Value | ((current: Value) => Value)) => void]
  useEffect(effect: () => void | (() => void), dependencies?: readonly unknown[]): void
  useMemo<Value>(factory: () => Value, dependencies: readonly unknown[]): Value
  useCallback<Value extends (...args: never[]) => unknown>(callback: Value, dependencies: readonly unknown[]): Value
  useRef<Value>(initial: Value): { current: Value }
  useSyncExternalStore<Snapshot>(
    subscribe: (listener: () => void) => () => void,
    getSnapshot: () => Snapshot,
    getServerSnapshot?: () => Snapshot,
  ): Snapshot
}

/**
 * `ui-kit@2`: the versioned component surface every UI contribution renders with. It renders with the product's own
 * components and tokens, so contributions follow the theme, density and focus behaviour of the rest of the client.
 */
export interface HostUiKit {
  readonly version: 'ui-kit@2'
  readonly Button: ElementType
  readonly IconButton: ElementType
  readonly Input: ElementType
  readonly Textarea: ElementType
  readonly Select: ElementType
  readonly Switch: ElementType
  readonly Tabs: ElementType
  readonly Dialog: ElementType
  readonly Popover: ElementType
  readonly Tooltip: ElementType
  readonly Field: ElementType
  readonly StatusBadge: ElementType
  readonly InlineFeedback: ElementType
  readonly EmptyState: ElementType
  readonly Spinner: ElementType
  readonly PageHeader: ElementType
  readonly MetricStrip: ElementType
  readonly Metric: ElementType
  readonly Section: ElementType
  readonly Stack: ElementType
  readonly Grid: ElementType
  readonly DataTable: ElementType
  readonly PropertyList: ElementType
  readonly PropertyRow: ElementType
}

export interface ExtensionClientHost {
  /** Calls a Host RPC of this Revision, or a product method allowed by the declared permissions. */
  call(method: string, input?: ExtensionJsonValue): Promise<ExtensionJsonValue>
  subscribe(topic: string, listener: (value: ExtensionJsonValue) => void): () => void
}

export interface ExtensionClientEnvironment {
  readonly React: HostUiReactFacade
  readonly host: ExtensionClientHost
  /** Owned by the dynamic runner during previews; installed Revisions load their CSS Module automatically. */
  readonly styles: unknown
}

export type ExtensionPluginFactory<Environment, Context = ExtensionHostContext> = (
  environment: Environment,
) => ExtensionPluginDefinition<Context> | Promise<ExtensionPluginDefinition<Context>>

export interface NekroNxtExtensionAuthoringReference {
  readonly contractVersion: 'nekro-nxt-extension-v4'
  readonly dshVersion: string
  readonly scopes: {
    readonly agent: {
      readonly contributions: readonly ['tool', 'rpc', 'panel', 'tool-view']
      readonly panelAnchors: readonly ExtensionPanelAnchor[]
    }
    readonly hostAdapter: {
      readonly apiVersion: 2
      readonly registration: 'harness.registerAdapter'
      readonly contributions: readonly ['adapter', 'panel', 'message-renderer', 'host-page']
      readonly panelAnchors: readonly ExtensionPanelAnchor[]
      readonly connectionPanelRoles: readonly ConnectionPanelRole[]
      readonly allowedHostServices: readonly string[]
      readonly configSchemaExample: ConfigSchemaDocument
    }
    readonly hostUi: { readonly contributions: readonly ['host-page']; readonly maxPages: 8 }
  }
  readonly ui: {
    readonly kitVersion: 'ui-kit@2'
    readonly componentProps: Readonly<Record<HostUiKitComponentName, string>>
    readonly components: readonly HostUiKitComponentName[]
    readonly panelDensities: readonly PanelDensity[]
    readonly toolViewDensities: readonly ToolViewDensity[]
    readonly dataHooks: readonly (keyof ExtensionClientData)[]
    readonly hookPermissions: Readonly<Record<keyof ExtensionClientData, HostUiPermission>>
    readonly designContract: {
      readonly version: 'nxt-host-ui-design-v2'
      readonly responsibilities: readonly {
        readonly owner: 'host' | 'extension' | 'ui-kit'
        readonly provided: readonly string[]
        readonly forbidden: readonly string[]
      }[]
      readonly compositionRules: readonly string[]
    }
  }
  readonly dshNativeWebUi: false
  readonly hostCapabilities: {
    readonly sdkLevel: number
    readonly declaration: string
    readonly services: readonly string[]
    readonly rules: readonly string[]
  }
  readonly examples: {
    readonly hostTool: string
    readonly hostCapabilities: string
    readonly hostRpcAndPanel: string
    readonly toolView: string
    readonly hostAdapter: string
    readonly hostPage: string
  }
  readonly recoveryRules: readonly string[]
}

/** One line per `ui-kit@2` component: the props a contribution passes. Rendered into the authoring skill. */
const UI_KIT_COMPONENT_PROPS: Readonly<Record<HostUiKitComponentName, string>> = {
  Button:
    "children、onClick、variant（'default' | 'primary' | 'ghost' | 'danger'）、size（'default' | 'small'）、busy、disabled、icon",
  IconButton: 'label（必填，读屏与悬停提示）、children（图标）、onClick、size',
  Input: '原生 input 属性：value、onChange、placeholder、type、disabled',
  Textarea: '原生 textarea 属性：value、onChange、placeholder、rows',
  Select: 'options（{ value, label, disabled? }[]）、value、onValueChange(value)、placeholder、disabled、aria-label',
  Switch: 'checked、onCheckedChange(checked)、label（必填）、disabled',
  Tabs: 'label（必填）、options（{ value, label }[]）、value、onChange(value)；只渲染标签条，内容由调用方按 value 切换',
  Dialog: 'open、onOpenChange(open)、title、children、actions（底部按钮）、wide',
  Popover: 'trigger（触发按钮元素）、label（必填）、children、align',
  Tooltip: 'content、children（单个可聚焦元素）、side',
  Field: 'label、hint、error、children（单个输入控件，自动关联标签）',
  StatusBadge: "tone（'neutral' | 'success' | 'warning' | 'error' | 'info'）、children",
  InlineFeedback: "tone（'info' | 'success' | 'warning' | 'error'）、children、action",
  EmptyState: 'title、description、action、loading',
  Spinner: '无参数',
  PageHeader: 'title、meta（一行说明）、actions；只用于 host-page，面板标题由宿主绘制',
  MetricStrip: 'children（若干 Metric）',
  Metric: 'label、value、detail',
  Section: 'title、children',
  Stack: 'children（纵向间距一致的内容）',
  Grid: 'children（自动换列的卡片或指标）',
  DataTable: 'children（thead 与 tbody）；宿主负责边框、表头与滚动',
  PropertyList: 'children（若干 PropertyRow）、framed',
  PropertyRow: "label、description、children（值或控件）、layout（'inline' | 'stacked'）",
}

const HOST_TOOL_EXAMPLE = `return {
  inject: ['tools'],
  apply(ctx) {
    const tool = harness.defineTool({
      name: 'project_status',
      description: 'Return a synthetic status for one project.',
      // parameters maps each argument name to its schema; mark required arguments with required: true.
      parameters: {
        project: { type: 'string', required: true, description: 'Project name to look up.' }
      },
      output: {
        schema: { type: 'string' },
        render(_args, value) { return [{ type: 'text', text: value }] }
      },
      execute({ project }) {
        const settings = harness.config?.() ?? {}
        return project + (settings.verbose ? ': ready (verbose)' : ': ready')
      }
    })
    harness.registerTool(ctx, tool)
  }
}`

const HOST_RPC_AND_PANEL_EXAMPLE = `// Host half
// RPC belongs to the Activation, so register it in the factory before returning the per-Session plugin.
harness.handle('summary', () => ({ text: 'Synthetic extension summary' }))
return {
  apply() {}
}

// Client half: declare where the panel belongs; the Host decides the page, frame and title bar.
return {
  inject: ['panels', 'data', 'ui'],
  apply(ctx) {
    const { Button, Stack } = ctx.ui
    const SummaryPanel = ({ anchor, density }) => {
      const agent = ctx.data.useAgent(anchor.id)
      const [text, setText] = React.useState('')
      return React.createElement(
        Stack,
        null,
        React.createElement('p', null, (agent ? agent.name : '智能体') + (density === 'compact' ? '' : ' 的摘要')),
        text ? React.createElement('p', null, text) : null,
        React.createElement(Button, {
          onClick: async () => setText((await host.call('summary')).text)
        }, '刷新摘要')
      )
    }
    ctx.panels.register(
      { id: 'summary', anchor: 'agent', title: '摘要', icon: 'file-text', densities: ['full', 'compact'] },
      SummaryPanel
    )
  }
}`

const TOOL_VIEW_EXAMPLE = `// Client half of an agent extension that declares the Tool project_status.
return {
  inject: ['toolViews', 'ui'],
  apply(ctx) {
    const { StatusBadge } = ctx.ui
    ctx.toolViews.register('project_status', ({ call, density }) =>
      density === 'chip'
        ? React.createElement('span', null, call.result ?? '查询中')
        : React.createElement(
            StatusBadge,
            { tone: call.state === 'failed' ? 'error' : 'success' },
            call.result ?? '查询中'
          )
    )
  }
}`

const HOST_CAPABILITIES_EXAMPLE = `// nekro_nxt_extension_define arguments (abridged):
// config: { schema: { type: 'object', dict: {
//   city: { type: 'string', meta: { description: '默认城市', default: '示例市' } },
//   apiKey: { type: 'string', meta: { description: 'API Key', role: 'secret' } } } } }
// permissions: { permissions: [], networkOrigins: [], capabilities: {
//   network: { mode: 'domains', domains: ['api.example.com'] },
//   storage: { scopes: ['member'] },
//   assets: { write: true },
//   context: [{ name: 'usage', kind: 'static', maxChars: 300 }, { name: 'favorite', kind: 'dynamic', maxChars: 200 }] } }
return {
  inject: ['tools', 'nxt'],
  apply(ctx) {
    ctx.nxt.prompt.static('usage', '用户问天气时调用 weather_today；结果里的 assetId 用 send_channel_message 的 image 块发送。')
    ctx.nxt.prompt.dynamic('favorite', async ({ storage, context }) => {
      const sender = context.latestInbound?.sender
      if (!sender) return ''
      const city = await storage.get('favorite-city', { scope: 'member', memberId: sender.memberId })
      return typeof city === 'string' ? sender.displayName + ' 常查的城市：' + city : ''
    })
    harness.registerTool(ctx, harness.defineTool({
      name: 'weather_today',
      description: 'Look up today weather for a city and render a poster asset.',
      parameters: { city: { type: 'string', description: 'City name; defaults to the configured city.' } },
      output: {
        schema: { type: 'json' },
        render(_args, value) { return [{ type: 'text', text: JSON.stringify(value) }] }
      },
      async execute({ city }) {
        const apiKey = await ctx.nxt.secrets.get('apiKey')
        if (!apiKey) return { ok: false, message: '请先在扩展配置中填写 API Key。' }
        const target = city || (harness.config?.() ?? {}).city || '示例市'
        const response = await ctx.nxt.http.fetch('https://api.example.com/weather?city=' + encodeURIComponent(target), {
          headers: { authorization: 'Bearer ' + apiKey }
        })
        if (response.status !== 200) return { ok: false, message: '天气服务返回 ' + response.status }
        const sender = (await ctx.nxt.context.current()).latestInbound?.sender
        if (sender) await ctx.nxt.storage.set('favorite-city', target, { scope: 'member', memberId: sender.memberId })
        const poster = await ctx.nxt.assets.create({ text: target + '：' + response.text, mediaType: 'text/plain' })
        return { ok: true, summary: response.text, assetId: poster.assetId }
      }
    }))
  }
}`

const HOST_ADAPTER_EXAMPLE = `const descriptor = {
  key: 'example-chat',
  displayName: 'Example Chat',
  description: 'Synthetic Adapter example.',
  provisioning: 'user-created',
  aliasEditable: true,
  channelDiscovery: 'adapter-observed',
  channelKinds: ['direct', 'group'],
  activities: [],
  features: {},
  diagnostics: { receive: true, send: true },
  // Serialized Schemastery. role: 'secret' fields are write-only credentials keyed by the field name.
  configSchema: {
    type: 'object',
    dict: {
      endpoint: { type: 'string', meta: { description: 'Endpoint', required: true, default: 'wss://chat.example.invalid/events' } },
      token: { type: 'string', meta: { description: 'Token', required: true, role: 'secret' } },
      verbose: { type: 'boolean', meta: { description: '详细日志', default: false, advanced: true } }
    }
  }
}
harness.registerAdapter({
  apiVersion: 2,
  descriptor,
  async create(context, stored) {
    // Only resolve stored.credentialRefs through context.credentials; never read raw secrets from configuration.
    return createRuntime(context, stored)
  }
})
return { apply() {} }`

const HOST_PAGE_EXAMPLE = `return {
  inject: ['pages', 'ui'],
  apply(ctx) {
    const { DataTable, Metric, MetricStrip, PageHeader, Section, Stack, StatusBadge } = ctx.ui
    const records = [
      { name: '接口联调', owner: '研发组', status: '已通过' },
      { name: '桌面端回归', owner: '质量组', status: '进行中' }
    ]
    const navigation = {
      getSnapshot: () => ({
        revision: 1,
        groups: [{
          id: 'main',
          items: [
            { id: 'overview', label: '概览', path: 'overview' },
            { id: 'details', label: '明细', path: 'details' }
          ]
        }]
      }),
      subscribe: () => () => undefined
    }
    const AcceptancePage = ({ relativePath }) => {
      const details = relativePath === 'details'
      return React.createElement(
        Stack,
        null,
        React.createElement(PageHeader, {
          title: details ? '验收明细' : '验收概览',
          meta: details ? '逐项检查负责人和当前状态' : '查看项目当前的验收进展'
        }),
        details
          ? React.createElement(
              Section,
              null,
              React.createElement(
                DataTable,
                null,
                React.createElement('thead', null,
                  React.createElement('tr', null,
                    React.createElement('th', null, '验收项'),
                    React.createElement('th', null, '负责人'),
                    React.createElement('th', null, '状态')
                  )
                ),
                React.createElement('tbody', null,
                  ...records.map((record) => React.createElement('tr', { key: record.name },
                    React.createElement('td', null, record.name),
                    React.createElement('td', null, record.owner),
                    React.createElement('td', null, React.createElement(
                      StatusBadge,
                      { tone: record.status === '已通过' ? 'success' : 'info' },
                      record.status
                    ))
                  ))
                )
              )
            )
          : React.createElement(
              Section,
              null,
              React.createElement(
                MetricStrip,
                null,
                React.createElement(Metric, { label: '验收项', value: String(records.length) }),
                React.createElement(Metric, { label: '已通过', value: '1' })
              )
            )
      )
    }
    ctx.pages.register({
      page: {
        kind: 'host-page',
        entryId: 'acceptance',
        title: '验收看板',
        icon: { kind: 'host-icon', name: 'layout-dashboard' },
        objectPane: 'navigation',
        startPath: 'overview'
      },
      navigation
    }, AcceptancePage)
  }
}`

export const NEKRO_NXT_EXTENSION_AUTHORING_REFERENCE: NekroNxtExtensionAuthoringReference = {
  contractVersion: 'nekro-nxt-extension-v4',
  dshVersion: DSH_RUNTIME_RELEASE.dshVersion,
  scopes: {
    agent: { contributions: ['tool', 'rpc', 'panel', 'tool-view'], panelAnchors: ['agent', 'channel', 'extension'] },
    hostAdapter: {
      apiVersion: 2,
      registration: 'harness.registerAdapter',
      contributions: ['adapter', 'panel', 'message-renderer', 'host-page'],
      panelAnchors: ['connection', 'channel'],
      connectionPanelRoles: ['setup', 'status', 'diagnostics'],
      allowedHostServices: [
        'channels',
        'identities',
        'members',
        'messages',
        'assets',
        'credentials',
        'state',
        'diagnostics',
        'transport',
      ],
      configSchemaExample: {
        type: 'object',
        dict: {
          endpoint: { type: 'string', meta: { description: 'Endpoint', required: true } },
          token: { type: 'string', meta: { description: 'Token', required: true, role: 'secret' } },
        },
      },
    },
    hostUi: { contributions: ['host-page'], maxPages: 8 },
  },
  ui: {
    kitVersion: 'ui-kit@2',
    components: [
      'Button',
      'IconButton',
      'Input',
      'Textarea',
      'Select',
      'Switch',
      'Tabs',
      'Dialog',
      'Popover',
      'Tooltip',
      'Field',
      'StatusBadge',
      'InlineFeedback',
      'EmptyState',
      'Spinner',
      'PageHeader',
      'MetricStrip',
      'Metric',
      'Section',
      'Stack',
      'Grid',
      'DataTable',
      'PropertyList',
      'PropertyRow',
    ],
    componentProps: UI_KIT_COMPONENT_PROPS,
    panelDensities: ['compact', 'full'],
    toolViewDensities: ['chip', 'card'],
    dataHooks: ['useAgent', 'useChannel', 'useConnection', 'useChannelRuntime'],
    hookPermissions: EXTENSION_DATA_HOOK_PERMISSIONS,
    designContract: {
      version: 'nxt-host-ui-design-v2',
      responsibilities: [
        {
          owner: 'host',
          provided: ['面板外框、标题、图标与折叠', '页面背景、安全边距与根滚动', '加载与失败回退', '进出场动效'],
          forbidden: ['不得把外框、背景、外边距或根滚动交给 Extension'],
        },
        {
          owner: 'extension',
          provided: ['业务数据', '业务操作', '内容区块顺序', '局部受作用域样式'],
          forbidden: ['重复绘制标题栏或卡片外框', '页面根背景与 padding', '负边距越界', '100vw/100vh', '固定定位'],
        },
        {
          owner: 'ui-kit',
          provided: ['基础控件状态', '内容表面', '表格外壳', '反馈', 'Dialog/Popover/Tooltip'],
          forbidden: ['破坏控件可访问性或焦点管理'],
        },
      ],
      compositionRules: [
        '面板只渲染内容：标题与图标写在注册声明里，不在组件里再画一次。',
        'compact 密度用于检查器等窄栏：只放一两行关键信息和至多一个操作；full 密度用于资料页。',
        '工具视图的 chip 是一行摘要，card 是展开后的结构化结果；不要直接输出原始 JSON。',
        '解释性文字只写用户需要的结论，不描述内部运行机制。',
        '状态名称、汇总数量、日期和表格数据必须互相一致。',
      ],
    },
  },
  dshNativeWebUi: false,
  examples: {
    hostTool: HOST_TOOL_EXAMPLE,
    hostCapabilities: HOST_CAPABILITIES_EXAMPLE,
    hostRpcAndPanel: HOST_RPC_AND_PANEL_EXAMPLE,
    toolView: TOOL_VIEW_EXAMPLE,
    hostAdapter: HOST_ADAPTER_EXAMPLE,
    hostPage: HOST_PAGE_EXAMPLE,
  },
  hostCapabilities: {
    sdkLevel: EXTENSION_SDK_LEVEL,
    declaration:
      '在 nekro_nxt_extension_define.permissions.capabilities 声明，并在 Host 插件 inject 中加入 nxt；未声明的能力调用会抛出指明缺失字段的错误。',
    services: [
      "ctx.nxt.http.fetch(url, { method, headers, body | bodyBase64 }) → { status, headers, contentType, text | base64 }；需要 network：{ mode: 'domains', domains: ['api.example.com', '*.cdn.example.com'] }、{ mode: 'config', fields: ['baseUrl'] }（地址取自用户配置）或 { mode: 'unrestricted', purpose }（启用时用户需确认风险）。",
      "ctx.nxt.secrets.get(key)：读取 config.schema 中 meta.role: 'secret' 的字段；用户未填写时返回 undefined。凭据字段不能有默认值，也不能出现在 harness.config() 中。",
      'ctx.nxt.assets.create({ text | base64, mediaType, name }) / fromUrl(url)：生成当前频道 Asset 并返回 assetId；需要 assets: { write: true }，fromUrl 还需要 network。把 assetId 交给智能体，由它用 send_channel_message 的 image/file/audio 块发送。',
      'ctx.nxt.storage.get/set/delete/list：JSON 键值存储；需要 storage: { scopes }，scope 为 agent（默认）、channel、member（必须传 memberId）或 shared（跨智能体共享）。单值不超过 256 KiB，默认配额 8 MiB。',
      'ctx.nxt.context.current() → { agent, channel, latestInbound?: { sender, text } }：当前智能体、频道和最近一条入站消息。',
      'ctx.nxt.history.list({ limit, before }) / search(query)：读取当前频道聊天记录；需要 history: { read: true }。',
      "ctx.nxt.llm.complete({ system, messages: [{ role: 'user', text }], maxOutputTokens }) → { text }：用智能体当前的模型完成一次辅助任务（分析、分类、改写），计入智能体用量；需要 llm: { maxCallsPerTurn, maxOutputTokens }。不能流式输出，也不能调用工具。",
      "ctx.nxt.prompt.static(name, text) / dynamic(name, render)：向智能体提供补充说明；需要在 context 中按名称声明 { name, kind: 'static' | 'dynamic', maxChars }。",
    ],
    rules: [
      '静态说明只能是固定字符串，只在版本或配置切换时变化；会变化的状态放进 dynamic，宿主每轮开始渲染一次，内容不变就不会追加新的上下文。',
      '动态上下文禁止写入时间戳、随机数和精确计数，写“好感度：友好”这类粗粒度描述；保存时宿主会用相同输入渲染两次，结果不同则拒绝保存。',
      'render 只能读存储和调用上下文，不能联网或调用模型；大块内容改为提供查询工具，让智能体按需调用。',
      '缺少凭据、网络失败或外部服务报错时，工具应返回 { ok: false, message } 这样可读的结果，而不是抛出异常；保存验证会真实调用工具，凭据此时为空。',
      'verification 样例必须没有副作用：验证会真实发出网络请求，样例应是查询而不是提交、发送或付款。',
      '扩展本身不能在频道发言；要发送图片、文件或语音时，返回 assetId 让智能体调用 send_channel_message。',
    ],
  },
  recoveryRules: [
    '一个 Episode 同时只维护一个动态 Plugin；修复必须向同一 Plugin 追加 kind:existing Package。',
    'define、run、保存和启用是四个独立提交点；不得把动态运行声称为已保存或已启用。',
    '适配器使用 registerAdapter 在隔离 Host Harness 中验证；保存后仍是未安装，必须再执行安装到本机。',
    '一个适配器 Revision 只允许一个稳定 adapterKey，且不能混装智能体 Tool、RPC 或工具视图。',
    '智能体扩展不能贡献顶级页面；需要页面时拆成独立的页面扩展。',
    'ctx.effect 的回调会立即执行；面板、工具视图和页面按示例直接注册，禁止在 effect 回调中立即调用注册返回的 disposer。',
    'Host RPC 必须在 Activation factory 注册；浏览器 RPC 没有 Agent Loop initiator，禁止依赖 currentInitiator 读取产品智能体身份。',
    '读取配置使用 harness.config?.() ?? {}；动态运行阶段没有保存的配置，使用 Schema 默认值。',
    '面板读取对象数据使用 ctx.data 的 Hook，并在 nekro_nxt_extension_define.permissions 中声明对应读取权限。',
    '验证会在每种声明的密度和明暗两种主题下真实渲染面板，并渲染工具视图的 chip 与 card；任一渲染失败都不能保存。',
    'Host 或 Client 失败后先读取 Inspect 诊断，再修复同一 Plugin；不要静默新建替代 Plugin。',
    '每次 define 都会成为任务的最新候选，只有最新候选通过验证后才能保存。查看状态使用 cordis_inspect_self。',
    'Plugin 已有运行版本时，新 Package 用 mode:update 运行；Runner 返回的 invalid-mode 提示会说明应使用的模式。',
    '只使用本参考公布的贡献类型；禁止注册 root、DSH 官方 WebUI Slot、Composer 或频道顶栏。',
  ],
}

export const renderNekroNxtExtensionDevelopmentSkill = (
  reference: NekroNxtExtensionAuthoringReference = NEKRO_NXT_EXTENSION_AUTHORING_REFERENCE,
): string => `# NekroNXT Extension Development

宿主是 NekroNXT，DSH Cordis 只提供动态执行 ABI。你的目标是开发 NekroNXT 系统扩展，不是 DSH 官方 WebUI 插件。

## 强制边界

- 定义候选使用 \`nekro_nxt_extension_define\`：页面、权限、配置 Schema 和资源都写入持久任务账本并在运行前预检。
- \`scope\` 按真实产物选择：智能体 Tool/RPC/面板/工具视图使用 \`agent\`，平台 Adapter 使用 \`host-adapter\`，顶级专属页面使用 \`host-ui\`。
- 智能体面板锚点：${reference.scopes.agent.panelAnchors.map((anchor) => `\`${anchor}\``).join('、')}；适配器面板锚点：${reference.scopes.hostAdapter.panelAnchors.map((anchor) => `\`${anchor}\``).join('、')}，连接面板必须声明角色 ${reference.scopes.hostAdapter.connectionPanelRoles.map((role) => `\`${role}\``).join('、')}。
- 面板声明 \`densities\`（${reference.ui.panelDensities.join('、')}），宿主决定放在哪个页面、绘制标题栏与外框。
- 工具视图按 Tool 名注册，渲染 \`chip\` 与 \`card\` 两种密度；适配器用 \`message-renderer\` 按 rich kind 渲染富消息。
- 数据 Hook：${reference.ui.dataHooks.map((hook) => `\`${hook}\`（${reference.ui.hookPermissions[hook]}）`).join('、')}。
- 配置 Schema 是序列化 Schemastery；\`meta.advanced\` 默认折叠，\`meta.hint\` 是帮助文字。只有智能体扩展可以声明 \`meta.role: 'secret'\` 凭据字段，Host 用 \`ctx.nxt.secrets.get(key)\` 读取。
- 禁止注册 root、DSH 官方页面 Slot、Composer 或频道顶栏。
- 动态运行、保存不可变扩展 Revision、给智能体启用扩展彼此独立；每一步都必须等待真实结果。
- 运行验证会用 \`nekro_nxt_extension_define.verification\` 中的样例真实调用每个 Tool 和 RPC；未提供时 Tool 用 \`{}\`、RPC 用 \`null\` 调用。

## 界面组件（${reference.ui.kitVersion}）

通过 \`ctx.ui\` 取用，只使用下列组件和属性；颜色、间距与主题由宿主决定，不要自行绘制按钮、输入框或表格外框。

${reference.ui.components.map((name) => `- \`${name}\`：${reference.ui.componentProps[name]}`).join('\n')}

## 界面责任契约（${reference.ui.designContract.version}）

${reference.ui.designContract.responsibilities
  .map(({ owner, provided, forbidden }) => `- ${owner} 提供：${provided.join('、')}；禁止：${forbidden.join('、')}。`)
  .join('\n')}
${reference.ui.designContract.compositionRules.map((rule) => `- ${rule}`).join('\n')}

## Host Tool 示例

\`\`\`js
${reference.examples.hostTool}
\`\`\`

## 宿主能力（ctx.nxt，能力等级 ${reference.hostCapabilities.sdkLevel}）

${reference.hostCapabilities.declaration}

${reference.hostCapabilities.services.map((line) => `- ${line}`).join('\n')}

${reference.hostCapabilities.rules.map((rule) => `- ${rule}`).join('\n')}

\`\`\`js
${reference.examples.hostCapabilities}
\`\`\`

## Host RPC + 面板示例

\`\`\`js
${reference.examples.hostRpcAndPanel}
\`\`\`

## 工具视图示例

\`\`\`js
${reference.examples.toolView}
\`\`\`

## Host Adapter 示例

\`\`\`js
${reference.examples.hostAdapter}
\`\`\`

## Host Page 示例

\`startPath\`、导航项 \`path\` 和 \`navigate()\` 都使用当前入口内的相对路径，不得以 \`/\` 开头。把页面的完整 Contribution 放进 \`nekro_nxt_extension_define.pages\`，权限放进 \`permissions\`；CSS Module 和 SVG 通过 \`resources\` 提交。

\`\`\`js
${reference.examples.hostPage}
\`\`\`

## 修复与停止

${reference.recoveryRules.map((rule) => `- ${rule}`).join('\n')}

契约版本：${reference.contractVersion}；DSH：${reference.dshVersion}。`

/** Browser/Host-neutral implementation bundled by the controlled Extension builder. */
export const EXTENSION_SDK_BUNDLE_SOURCE = `
export const defineHostExtension = (factory) => factory
export const defineClientExtension = (factory) => factory
`

/** Marks a Host entry factory without executing it during build or import. */
export const defineHostExtension = <T extends ExtensionPluginFactory<ExtensionHostEnvironment>>(factory: T): T =>
  factory

/** Marks the single Client entry factory of any scope without executing it during build or import. */
export const defineClientExtension = <
  T extends ExtensionPluginFactory<ExtensionClientEnvironment, ExtensionClientContext>,
>(
  factory: T,
): T => factory
