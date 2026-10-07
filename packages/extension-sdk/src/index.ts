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
  /** Present for textual responses: `text/*`, JSON, XML, JavaScript and `+xml` / `+json` types such as XHTML or Atom. */
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

export interface NxtRenderSvgOptions {
  /** Output pixels per SVG user unit; default 2, at most 4. */
  readonly scale?: number
  readonly format?: 'png' | 'jpeg' | 'webp'
  /** CSS color painted behind transparent areas; JPEG defaults to white. */
  readonly background?: string
}

/** Rendered bytes as base64; pass `{ base64, mediaType }` to `assets.create` to send it. */
export interface NxtRenderedImage {
  readonly base64: string
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp'
  readonly width: number
  readonly height: number
  readonly byteSize: number
}

export interface NxtParseHtmlOptions {
  /** Page address; relative links and images become absolute. */
  readonly url?: string
  /** `article` (default) keeps the main content; `full` converts the whole body. */
  readonly mode?: 'article' | 'full'
  /** Markdown length limit; default 20000, at most 200000. */
  readonly maxChars?: number
}

export interface NxtParsedHtml {
  readonly title?: string
  readonly excerpt?: string
  readonly markdown: string
  readonly truncated: boolean
  /** Distinct absolute http(s) links in the converted content, at most 200. */
  readonly links: readonly { readonly text: string; readonly url: string }[]
}

export interface NxtFeedItem {
  /** `guid` / `id`, else the link or title; stable for de-duplication. */
  readonly id: string
  readonly title?: string
  readonly link?: string
  /** Milliseconds since epoch. */
  readonly published?: number
  readonly author?: string
  /** Plain text, at most 2000 characters. */
  readonly summary?: string
}

export interface NxtFeed {
  readonly kind: 'rss2' | 'rss1' | 'atom'
  readonly title?: string
  readonly description?: string
  readonly link?: string
  /** At most 100, in feed order. */
  readonly items: readonly NxtFeedItem[]
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

export interface NxtInboundMessage {
  readonly logicalMessageId: string
  readonly channel: {
    readonly id: string
    readonly kind: 'internal' | 'direct' | 'group'
    readonly displayName?: string
  }
  readonly sender?: NxtMemberSummary
  readonly text: string
  /** Whether the message mentions or replies to this agent's bot account. */
  readonly mentionsAgent: boolean
  /** Whether the binding's trigger policy would wake the agent without any hook. */
  readonly wouldTrigger: boolean
  readonly receivedAt: number
}

/** All fields optional: returning nothing keeps the default behaviour. */
export interface NxtInboundDecision {
  /** `force` needs `mayForceTrigger`; `suppress` keeps the agent asleep for this message. */
  readonly trigger?: 'default' | 'suppress' | 'force'
  /** Needs `mayHide`. The message stays in the channel timeline but the agent never sees it. */
  readonly hideFromAgent?: boolean
  /** Short note shown to the agent next to the message (max 500 characters). */
  readonly annotation?: string
}

/** `nxt` here is bound to the message's channel; it has no prompt registration. */
export type NxtInboundHandler = (
  message: NxtInboundMessage,
  nxt: NxtHostService,
) => NxtInboundDecision | undefined | Promise<NxtInboundDecision | undefined>

/** A job of this extension that came due in one channel. */
export interface NxtJobDue {
  readonly jobId: string
  readonly label: string
  readonly payload: ExtensionJsonValue
  /** Planned time; earlier than `firedAt` when the Host was offline. */
  readonly scheduledAt: number
  readonly firedAt: number
  /** `jobs.declared[].id` for a fixed plan; absent for jobs created with `nxt.jobs.schedule`. */
  readonly declaredId?: string
  readonly channel: {
    readonly id: string
    readonly kind: 'internal' | 'direct' | 'group'
    readonly displayName?: string
  }
}

export interface NxtJobDecision {
  /** `false` lets the due time pass without waking the agent, e.g. an RSS check that found nothing new. */
  readonly wake?: boolean
  /** Shown to the agent with the due event, e.g. what is new; at most 2000 characters. */
  readonly note?: string
}

export type NxtJobHandler = (
  job: NxtJobDue,
  nxt: NxtHostService,
) => NxtJobDecision | undefined | Promise<NxtJobDecision | undefined>

export interface NxtPlatformAction {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly risk: 'low' | 'admin'
  readonly parameters: ExtensionJsonValue
}

export interface NxtPlatformResult {
  readonly status: 'succeeded' | 'partially-succeeded' | 'failed' | 'unknown'
  readonly message: string
  /** Platform response, when the Adapter returns one. */
  readonly value?: ExtensionJsonValue
}

export interface NxtJobScheduleInput {
  readonly label: string
  /** One-off run at this epoch millisecond time; mutually exclusive with `cron`. */
  readonly at?: number
  /** Five-field cron expression, e.g. `0 8 * * *`; mutually exclusive with `at`. */
  readonly cron?: string
  /** IANA time zone for `cron`, default the Host time zone. */
  readonly timezone?: string
  /** JSON shown to the agent when the job fires. */
  readonly payload?: ExtensionJsonValue
}

export interface NxtJobRecord {
  readonly jobId: string
  readonly label: string
  readonly nextRunAt?: number
  readonly cron?: string
  readonly at?: number
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
  readonly platform: {
    /** Typed actions of the current channel's Adapter that this extension declared and the channel kind allows. */
    actions(): Promise<readonly NxtPlatformAction[]>
    /** Runs one declared action in the current channel; members are referenced by `memberId`. */
    invoke(action: string, args: Readonly<Record<string, ExtensionJsonValue>>): Promise<NxtPlatformResult>
    /** Raw API of the current channel's Adapter; requires `platform.raw` to list that Adapter. */
    raw(api: string, params: Readonly<Record<string, ExtensionJsonValue>>): Promise<NxtPlatformResult>
  }
  readonly jobs: {
    /**
     * Wakes the agent in the current channel when due; whether it speaks is up to the agent. Requires
     * `permissions.capabilities.jobs.runtime`.
     */
    schedule(input: NxtJobScheduleInput): Promise<NxtJobRecord>
    /** This extension's jobs for this agent in the current channel. */
    list(): Promise<readonly NxtJobRecord[]>
    cancel(jobId: string): Promise<boolean>
  }
  readonly llm: {
    /**
     * One completion with the agent's configured model, counted in the agent's usage. Requires
     * `permissions.capabilities.llm`; calls beyond `maxCallsPerTurn` in one turn are rejected.
     */
    complete(request: NxtLlmRequest): Promise<NxtLlmResponse>
  }
  readonly render: {
    /**
     * Rasterizes SVG with the Host's system fonts (use generic families such as `sans-serif`). References are limited
     * to `#fragment` and `data:` URLs. No capability needed; sending the image needs `assets`.
     */
    svg(svg: string, options?: NxtRenderSvgOptions): Promise<NxtRenderedImage>
  }
  readonly parse: {
    /** HTML to Markdown, main content by default. No capability needed; fetching the page needs `network`. */
    html(html: string, options?: NxtParseHtmlOptions): Promise<NxtParsedHtml>
    /** RSS 2.0, RSS 1.0 or Atom into one item list. */
    feed(xml: string, options?: { readonly url?: string }): Promise<NxtFeed>
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
     * Agent extensions that declare `permissions.capabilities.inboundHook` register one inbound handler during
     * factory evaluation (like `handle`). It runs after the message is stored and before the agent is woken.
     */
    onInbound?(handler: NxtInboundHandler): () => void
    /**
     * Agent extensions with `permissions.capabilities.jobs` register one due-job handler during factory evaluation. It
     * runs before the agent is woken for this extension's jobs and can decide not to wake it; without a handler every
     * due job wakes the agent.
     */
    onJob?(handler: NxtJobHandler): () => void
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
      "harness.onInbound((message, nxt) => decision)：在 factory 阶段（与 harness.handle 相同）注册唯一的入站处理函数，消息入库后、唤醒智能体前运行；返回 { trigger: 'default' | 'suppress' | 'force', hideFromAgent, annotation } 或不返回。需要 inboundHook: { reads: 'triggered' | 'all', mayHide, mayForceTrigger, timeoutMs }；reads: 'triggered' 只看原本会唤醒智能体的消息。nxt 参数绑定到该消息所在频道，可读写存储、调用模型，但不能注册上下文。超时或抛错按默认处理；消息始终入库，hideFromAgent 只是不让智能体看到。",
      'ctx.nxt.jobs.schedule({ label, at | cron, timezone, payload }) / list() / cancel(jobId)：在当前频道创建定时任务，到期时以“定时任务到期”事件唤醒智能体，由智能体决定是否发言；需要 jobs: { runtime: { maxActive } }。固定计划写在 jobs.declared: [{ id, label, cron, timezone }]，会在启用它的智能体绑定的每个频道触发。动态运行中创建的任务不会真的触发。',
      'harness.onJob((job, nxt) => ({ wake, note }))：声明了 jobs 的扩展可在 factory 阶段注册唯一的到期处理函数，本扩展的任务到期时先运行它（job 含 jobId、label、payload、scheduledAt、declaredId、channel），nxt 绑定到任务所在频道；返回 { wake: false } 则这次不唤醒智能体（例如订阅检查没有新内容），返回 note 会随到期事件交给智能体（例如新文章列表，最多 2000 字）。15 秒内未返回或抛错时按默认唤醒。轮询类需求一定要用它，避免每次检查都消耗一次模型调用。',
      'ctx.nxt.platform.actions() / invoke(action, args) / raw(api, params)：在当前频道执行平台动作（例如 OneBot 的 like_member、mute_member、kick_member、set_member_card、set_essence_message，成员用 memberId 引用）；需要 platform: { actions: [{ adapter, action }], raw: [adapterKey] }。先用 actions() 查询当前平台实际支持的动作。动态运行和保存验证只模拟执行，返回“预览模式”结果，启用后才真正调用平台。',
      "ctx.nxt.render.svg(svg, { scale, format: 'png' | 'jpeg' | 'webp', background }) → { base64, mediaType, width, height }：用宿主系统字体把 SVG 渲染成图片，无需声明能力；把结果交给 assets.create({ base64, mediaType, name }) 再由智能体发送。文字用 font-family=\"sans-serif\"；SVG 只能引用 #片段或 data: 内联资源，网络图片先用 http.fetch 取回再以 data: 内联。适合卡片、榜单、签到图、运势图等。",
      "ctx.nxt.parse.html(html, { url, mode: 'article' | 'full', maxChars }) → { title, excerpt, markdown, truncated, links }：把网页转成 Markdown，默认只保留正文，传 url 时链接变为绝对地址；parse.feed(xml, { url }) → { kind, title, link, items: [{ id, title, link, published, author, summary }] }：统一解析 RSS 2.0、RSS 1.0 与 Atom，id 可用于去重。两者都无需声明能力，取回网页或订阅源仍需要 network。",
      "ctx.nxt.prompt.static(name, text) / dynamic(name, render)：向智能体提供补充说明；需要在 context 中按名称声明 { name, kind: 'static' | 'dynamic', maxChars }。",
    ],
    rules: [
      "config.schema 是序列化 Schemastery，不是 JSON Schema：顶层固定为 { type: 'object', dict: { 字段名: 节点 } }，节点如 { type: 'string', meta: { description: '默认城市', default: '示例市' } }、{ type: 'number', meta: { description: '次数', default: 3, min: 1, max: 10 } }、{ type: 'boolean', meta: { description: '启用', default: true } }，凭据为 { type: 'string', meta: { description: 'API Key', role: 'secret' } }。不要写 properties、required 数组或 additionalProperties。",
      '工具 parameters 中类型为 object 的参数必须显式写 additionalProperties: true 或 false；尽量用扁平的 string/number/boolean 参数。',
      'permissions.permissions 与 networkOrigins 只用于浏览器端界面（ctx.data Hook 与 Client 的 network.request）；Host 端联网只声明 permissions.capabilities.network，两者不要混用。',
      "工具的 output.schema 必须与 execute 的真实返回一致：返回对象就声明 { type: 'json' } 或完整的 object Schema，返回字符串才声明 { type: 'string' }；不确定时用 { type: 'json' }。",
      '静态说明只能是固定字符串，只在版本或配置切换时变化；会变化的状态放进 dynamic，宿主每轮开始渲染一次，内容不变就不会追加新的上下文。',
      '动态上下文禁止写入时间戳、随机数和精确计数，写“好感度：友好”这类粗粒度描述；保存时宿主会用相同输入渲染两次，结果不同则拒绝保存。',
      'render 只能读存储和调用上下文，不能联网或调用模型；大块内容改为提供查询工具，让智能体按需调用。',
      '缺少凭据、网络失败或外部服务报错时，工具应返回 { ok: false, message } 这样可读的结果，而不是抛出异常；保存验证会真实调用工具，凭据此时为空。',
      '需要凭据才能真实试运行时，请用户在频道里打开这个创造任务页面，在「测试凭据」中填写；测试凭据只在本任务的试运行中可见，保存时的验证仍然没有凭据，用户启用扩展时再填写正式凭据。',
      'memberId 是频道成员 ID（形如 mbr_ 开头），来自 context.current().latestInbound.sender、history 消息的 sender 或入站钩子的 message.sender；不要用平台账号或昵称作为存储键。',
      'channel.kind 取值为 internal（内置频道）、direct（私聊）或 group（群聊）；平台动作通常只在 direct 或 group 中可用，先用 platform.actions() 确认。',
      'history.list 每次返回 { messages, next }，messages 按时间从新到旧；要继续向前翻页，把 next 原样作为 before 传入。',
      '动态上下文会以「[扩展：显示名]」小节出现在模型看到的运行时上下文中；静态说明以同样的标题出现在系统提示词里。',
      'verification 样例必须没有副作用：验证会真实发出网络请求，样例应是查询而不是提交、发送或付款。',
      '扩展本身不能在频道发言；要发送图片、文件或语音时，返回 assetId 让智能体调用 send_channel_message。',
      '入站处理函数要快且确定：先做本地判断，确实需要时再调用模型；它看到的是用户消息原文，不要把内容写进日志或外发。',
      '不要声明 permissions.capabilities.mcp：MCP 服务只能由用户在工坊用「添加 MCP 服务」连接，动态创造声明 mcp 会被拒绝；用户想接入某个 MCP 服务时，告诉他去工坊添加。',
      '过滤、防抖、关键词监听这类需求用 onInbound；定时推送、提醒这类需求用 jobs，到期后由智能体自己发言，扩展不直接发送消息；定时检查类需求在 onJob 里先检查，没有新内容就返回 { wake: false }。',
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
- 可选扩展图标：在 \`resources\` 放 \`assets/icon.svg\`（推荐，规则同页面 SVG 图标）或 64–512 像素正方形、不超过 128 KiB 的 \`assets/icon.png\` / \`assets/icon.webp\`（内容填标准 base64），再用 \`iconPath\` 指向它；图标显示在工坊、社区和智能体能力列表。

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
