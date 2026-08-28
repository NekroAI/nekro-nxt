import type { AdapterHostContributionV1 } from '@nekro-nxt/adapter-sdk'
import type { ElementType, ReactNode } from 'react'
import type {
  AdapterClientSlotName,
  AgentClientSlotName,
  HostPageContribution,
  HostUiNavigationModel,
  HostUiPermissionDeclaration,
  MessagePart,
} from '@nekro-nxt/contracts'

export type {
  AdapterClientSlotName,
  AgentClientSlotName,
  HostIconName,
  HostPageContribution,
  HostUiNavigationModel,
  HostUiPermission,
  HostUiPermissionDeclaration,
} from '@nekro-nxt/contracts'

export type {
  AdapterConnectionHostContext,
  AdapterConnectionRuntime,
  AdapterDeliveryReceipt,
  AdapterHostContributionV1,
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
    registerAdapter(contribution: AdapterHostContributionV1): () => void
  }
  readonly config: ExtensionJsonValue
}

export type NekroNxtClientSlotName = AgentClientSlotName

export interface AgentWorkbenchSlotProps {
  readonly agentId: string
  readonly displayName: string
}

export interface ExtensionDetailsSlotProps {
  readonly agentId: string
  readonly extensionId: string
  readonly revisionId: string
  readonly activation: 'active' | 'inactive'
}

export interface ExtensionActivationSlotProps extends ExtensionDetailsSlotProps {
  readonly activationId: string
  readonly runtimeStatus: 'active' | 'restore-failed' | 'dispose-failed'
}

export interface ChannelInspectorAgentSlotProps {
  readonly agentId: string
  readonly channelId: string
  readonly connectionId: string
  readonly episodeId?: string
  readonly runtimePhase: 'idle' | 'thinking' | 'using-tool' | 'waiting-input' | 'unavailable'
}

export interface ConversationToolCardSlotProps {
  readonly agentId: string
  readonly channelId: string
  readonly callId: string
  readonly toolName: string
  readonly displayName: string
  readonly state: 'running' | 'succeeded' | 'failed'
  readonly surface: 'stream' | 'trajectory'
  readonly inputPresentation?: string
  readonly resultPresentation?: string
  readonly durationMs?: number
  readonly wroteToChannel?: boolean
}

export interface NekroNxtClientSlotPropsMap {
  readonly 'agent.workbench.sections': AgentWorkbenchSlotProps
  readonly 'extension.activation.panels': ExtensionActivationSlotProps
  readonly 'extension.details.panels': ExtensionDetailsSlotProps
  readonly 'channel.inspector.agent.sections': ChannelInspectorAgentSlotProps
  readonly 'conversation.tool.card': ConversationToolCardSlotProps
}

export type AdapterRichMessagePart = Extract<MessagePart, { readonly type: 'rich' }>

export interface AdapterRichMessageSlotProps {
  readonly part: AdapterRichMessagePart
  readonly messageId: string
  readonly channelId: string
}

export interface AdapterConnectionSlotProps {
  readonly adapterKey: string
  readonly connectionId?: string
  readonly phase: 'setup' | 'active' | 'testing'
  readonly diagnostic?: ExtensionJsonObject
}

export interface AdapterChannelInspectorSlotProps {
  readonly adapterKey: string
  readonly connectionId: string
  readonly channelId: string
  readonly channelKind: 'web' | 'group' | 'direct'
}

export interface AdapterClientSlotPropsMap {
  readonly 'conversation.message.rich': AdapterRichMessageSlotProps
  readonly 'connection.adapter.setup': AdapterConnectionSlotProps
  readonly 'connection.adapter.status': AdapterConnectionSlotProps
  readonly 'connection.adapter.test': AdapterConnectionSlotProps
  readonly 'channel.inspector.adapter.sections': AdapterChannelInspectorSlotProps
}

export interface AdapterHostClientSlotRegistry {
  register<Name extends AdapterClientSlotName>(
    options: { readonly name: Name; readonly id: string },
    component: (props: AdapterClientSlotPropsMap[Name]) => ReactNode,
  ): () => void
}

export interface AdapterHostClientContext {
  readonly slots: AdapterHostClientSlotRegistry
  readonly pages: HostUiPageRegistry
  readonly ui: HostUiKit
}

export type AdapterHostClientEnvironment = Pick<ExtensionClientEnvironment, 'React' | 'styles' | 'host'> & {
  readonly ui: HostUiKit
}

export interface ExtensionClientStyles {
  readonly section: string
  readonly sectionHeading: string
  readonly secondaryText: string
  readonly actionRow: string
  readonly button: string
  readonly badge: string
}

export interface ExtensionClientHost {
  call(method: string, input?: ExtensionJsonValue): Promise<ExtensionJsonValue>
}

export interface ExtensionClientSlotRegistry {
  register<Name extends NekroNxtClientSlotName>(
    options: { readonly name: Name; readonly id?: string },
    component: (props: NekroNxtClientSlotPropsMap[Name]) => ReactNode,
  ): () => void
}

export interface ExtensionClientContext {
  readonly slots: ExtensionClientSlotRegistry
}

export interface ExtensionClientEnvironment {
  readonly React: {
    createElement(type: ElementType, props?: object | null, ...children: ReactNode[]): ReactNode
  }
  readonly host: ExtensionClientHost
  readonly styles: ExtensionClientStyles
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
  declarePermissions(declaration: HostUiPermissionDeclaration): void
  register(
    options: {
      readonly page: HostPageContribution
      readonly navigation?: HostUiNavigationProvider
    },
    component: (props: HostUiPageProps) => ReactNode,
  ): () => void
}

export interface HostUiClientContext {
  readonly pages: HostUiPageRegistry
  /** Present for a host-adapter Revision that also contributes pages; page-only clients leave it unused. */
  readonly slots: AdapterHostClientSlotRegistry
  /** Mirrors the environment facade so dynamic preview and installed pages use the same component surface. */
  readonly ui: HostUiKit
}

export type HostUiReactFacade = ExtensionClientEnvironment['React'] & {
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

export interface HostUiKit {
  readonly Button: ElementType
  readonly IconButton: ElementType
  readonly Input: ElementType
  readonly Textarea: ElementType
  readonly Select: ElementType
  readonly Switch: ElementType
  readonly Tabs: object
  readonly Dialog: object
  readonly Popover: object
  readonly Tooltip: object
  readonly Field: ElementType
  readonly StatusBadge: ElementType
  readonly InlineFeedback: ElementType
  readonly EmptyState: ElementType
  readonly Spinner: ElementType
  readonly PageHeader: ElementType
  readonly Section: ElementType
  readonly Stack: ElementType
  readonly Grid: ElementType
  readonly DataTable: ElementType
  readonly SidePane: ElementType
}

export interface HostUiClientEnvironment {
  readonly React: HostUiReactFacade
  readonly ui: HostUiKit
  readonly styles: ExtensionClientStyles
  readonly host: ExtensionClientHost & {
    subscribe(topic: string, listener: (value: ExtensionJsonValue) => void): () => void
  }
}

export interface HostUiExtensionDefinition {
  readonly pages: readonly HostPageContribution[]
  readonly permissions: HostUiPermissionDeclaration
}

export type ExtensionPluginFactory<Environment, Context = ExtensionHostContext> = (
  environment: Environment,
) => ExtensionPluginDefinition<Context> | Promise<ExtensionPluginDefinition<Context>>

export interface NekroNxtExtensionAuthoringReference {
  readonly contractVersion: 'nekro-nxt-extension-v3'
  readonly dshVersion: '0.1.1-rc.2'
  readonly supportedContributions: {
    readonly hostTool: true
    readonly hostRpc: true
    readonly clientSlots: readonly NekroNxtClientSlotName[]
    readonly hostPages: { readonly maxEntries: 8 }
    readonly hostAdapter: {
      readonly apiVersion: 1
      readonly scope: 'host-adapter'
      readonly registration: 'harness.registerAdapter'
      readonly oneStableKey: true
      readonly clientSlots: readonly AdapterClientSlotName[]
      readonly allowedHostServices: readonly [
        'channels',
        'members',
        'messages',
        'assets',
        'credentials',
        'state',
        'diagnostics',
        'transport',
      ]
      readonly configSchemaExample: AdapterHostContributionV1['descriptor']['configSchema']
      readonly cannotMixWith: readonly ['tool', 'rpc', 'agent-client-slot']
    }
    readonly dshNativeWebUi: false
  }
  readonly examples: {
    readonly hostTool: string
    readonly hostRpcAndClientSlot: string
    readonly hostAdapter: string
  }
  readonly recoveryRules: readonly string[]
}

const HOST_TOOL_EXAMPLE = `return {
  inject: ['tools'],
  apply(ctx) {
    const tool = harness.defineTool({
      name: 'project_status',
      description: 'Return a synthetic project status.',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render(_args, value) { return [{ type: 'text', text: value }] }
      },
      execute() { return 'ready' }
    })
    harness.registerTool(ctx, tool)
  }
}`

const HOST_RPC_AND_CLIENT_SLOT_EXAMPLE = `// Host half
// RPC belongs to the Activation, so register it in the factory before returning the per-Session plugin.
harness.handle('summary', () => ({ text: 'Synthetic extension summary' }))
return {
  apply() {}
}

// Client half: use only a Slot returned by NekroNXT Inspect.
return {
  inject: ['slots'],
  apply(ctx) {
    ctx.slots.register(
      { name: 'agent.workbench.sections', id: 'main' },
      (props) => React.createElement(
        'section',
        { className: styles.section },
        React.createElement('h3', { className: styles.sectionHeading }, props.displayName),
        React.createElement('button', {
          className: styles.button,
          onClick: async () => { await host.call('summary', {}) }
        }, 'Refresh')
      )
    )
  }
}`

const HOST_ADAPTER_EXAMPLE = `const descriptor = {
  key: 'example-chat',
  displayName: 'Example Chat',
  description: 'Synthetic Adapter example.',
  userCreatable: true,
  aliasEditable: true,
  channelDiscovery: 'adapter-observed',
  diagnostics: { receive: true, send: true },
  configSchema: {
    schemaVersion: 1,
    type: 'object',
    required: ['endpoint', 'token'],
    properties: {
      endpoint: { type: 'string', title: 'Endpoint', default: 'wss://chat.example.invalid/events' },
      token: { type: 'credential-reference', credentialKey: 'token', title: 'Token' }
    }
  }
}
harness.registerAdapter({
  apiVersion: 1,
  descriptor,
  async create(context, stored) {
    // Only resolve stored.credentialRefs through context.credentials; never read raw secrets from configuration.
    return createRuntime(context, stored)
  }
})
return { apply() {} }`

export const NEKRO_NXT_EXTENSION_AUTHORING_REFERENCE: NekroNxtExtensionAuthoringReference = {
  contractVersion: 'nekro-nxt-extension-v3',
  dshVersion: '0.1.1-rc.2',
  supportedContributions: {
    hostTool: true,
    hostRpc: true,
    clientSlots: [
      'agent.workbench.sections',
      'extension.activation.panels',
      'channel.inspector.agent.sections',
      'conversation.tool.card',
    ],
    hostPages: { maxEntries: 8 },
    hostAdapter: {
      apiVersion: 1,
      scope: 'host-adapter',
      registration: 'harness.registerAdapter',
      oneStableKey: true,
      clientSlots: [
        'conversation.message.rich',
        'connection.adapter.setup',
        'connection.adapter.status',
        'connection.adapter.test',
        'channel.inspector.adapter.sections',
      ],
      allowedHostServices: [
        'channels',
        'members',
        'messages',
        'assets',
        'credentials',
        'state',
        'diagnostics',
        'transport',
      ],
      configSchemaExample: {
        schemaVersion: 1,
        type: 'object',
        required: ['endpoint', 'token'],
        properties: {
          endpoint: { type: 'string', title: 'Endpoint', default: 'wss://chat.example.invalid/events' },
          token: { type: 'credential-reference', credentialKey: 'token', title: 'Token' },
        },
      },
      cannotMixWith: ['tool', 'rpc', 'agent-client-slot'],
    },
    dshNativeWebUi: false,
  },
  examples: {
    hostTool: HOST_TOOL_EXAMPLE,
    hostRpcAndClientSlot: HOST_RPC_AND_CLIENT_SLOT_EXAMPLE,
    hostAdapter: HOST_ADAPTER_EXAMPLE,
  },
  recoveryRules: [
    '一个 Episode 同时只维护一个动态 Plugin；修复必须向同一 Plugin 追加 kind:existing Package。',
    'define、run、保存和启用是四个独立提交点；不得把动态运行声称为已保存或已启用。',
    '适配器使用 registerAdapter 在隔离 Host Harness 中验证；保存后仍是未安装，必须再执行安装到本机。',
    '一个适配器 Revision 只允许一个稳定 adapterKey，且不能混装智能体 Tool、RPC 或智能体 Client Slot。',
    'ctx.effect 的回调会立即执行；Tool 和 Slot 按示例直接注册，禁止在 effect 回调中立即调用注册返回的 disposer。自管资源必须由 effect 回调返回 teardown。',
    'Host RPC 必须在 Activation factory 注册；浏览器 RPC 没有 Agent Loop initiator，禁止依赖 currentInitiator 读取产品智能体身份。需要的稳定生成期数据应写入当前 Revision 源码或显式配置。',
    'agent.workbench.sections 接收当前智能体的 agentId/displayName，位于智能体配置宿主区块之后；多个贡献按注册顺序排列。',
    'extension.activation.panels 只接收用户明确选中的 active Activation；动态预览使用 synthetic 标识，不代表已保存、已安装或已启用。',
    'Host 或 Client 失败后先读取 Inspect 诊断，再修复同一 Plugin；不要静默新建替代 Plugin。',
    '只使用 NekroNXT Inspect 公布的 Contribution 和 Slot；禁止注册 root 或 DSH 官方 WebUI Slot。',
  ],
}

export const renderNekroNxtExtensionDevelopmentSkill = (
  reference: NekroNxtExtensionAuthoringReference = NEKRO_NXT_EXTENSION_AUTHORING_REFERENCE,
): string => `# NekroNXT Extension Development

宿主是 NekroNXT，DSH Cordis 只提供动态执行 ABI。你的目标是开发 NekroNXT 系统扩展，不是 DSH 官方 WebUI 插件。

## 强制边界

- 只能使用 cordis_inspect_list / cordis_inspect_query 公布的 NekroNXT Host Contribution 与 Client Slot。
- Client 只允许：${reference.supportedContributions.clientSlots.map((slot) => `\`${slot}\``).join('、')}。
- Adapter Client 还可使用：${reference.supportedContributions.hostAdapter.clientSlots.map((slot) => `\`${slot}\``).join('、')}；除富消息外，稳定 id 等于 adapterKey。
- 禁止注册 root、DSH 官方页面 Slot、Composer 或频道顶栏；顶级页面只能使用 Host Page Contribution。
- 动态运行、保存不可变扩展 Revision、给智能体启用扩展彼此独立；每一步都必须等待真实结果。
- Host Tool 必须通过真实 Tool Runtime 调用验证；RPC 必须由 Client 预览真实调用；Client 必须在相同产品 Slot 与合成 Props 中渲染成功。

## Host Tool 示例

\`\`\`js
${reference.examples.hostTool}
\`\`\`

## Host RPC + NekroNXT Client Slot 示例

\`\`\`js
${reference.examples.hostRpcAndClientSlot}
\`\`\`

## Host Adapter 示例

\`\`\`js
${reference.examples.hostAdapter}
\`\`\`

## 修复与停止

${reference.recoveryRules.map((rule) => `- ${rule}`).join('\n')}

契约版本：${reference.contractVersion}；DSH：${reference.dshVersion}。`

/** Browser/Host-neutral implementation bundled by the controlled Extension builder. */
export const EXTENSION_SDK_BUNDLE_SOURCE = `
export const defineHostExtension = (factory) => factory
export const defineClientExtension = (factory) => factory
export const defineAdapterClientExtension = (factory) => factory
export const defineHostUiExtension = (factory) => factory
export const defineHostUiClientExtension = (factory) => factory
`

/** Marks a Host entry factory without executing it during build or import. */
export const defineHostExtension = <T extends ExtensionPluginFactory<ExtensionHostEnvironment>>(factory: T): T =>
  factory

/** Marks a Client entry factory without executing it during build or import. */
export const defineClientExtension = <
  T extends ExtensionPluginFactory<ExtensionClientEnvironment, ExtensionClientContext>,
>(
  factory: T,
): T => factory

/** Marks a Host Adapter Client factory; V1 only receives the keyed rich-message Slot. */
export const defineAdapterClientExtension = <
  T extends ExtensionPluginFactory<AdapterHostClientEnvironment, AdapterHostClientContext>,
>(
  factory: T,
): T => factory

/** Marks a Host UI server factory without executing it during build or import. */
export const defineHostUiExtension = <T extends ExtensionPluginFactory<ExtensionHostEnvironment>>(factory: T): T =>
  factory

/** Marks a Host UI Client factory; page registrations are owned by one Host installation. */
export const defineHostUiClientExtension = <
  T extends ExtensionPluginFactory<HostUiClientEnvironment, HostUiClientContext>,
>(
  factory: T,
): T => factory
