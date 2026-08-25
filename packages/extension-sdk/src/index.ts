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
  apply(context: Context): void | Promise<void>
}

export interface ExtensionHostEnvironment {
  readonly harness: {
    defineTool<Args extends ExtensionJsonObject, Output extends ExtensionJsonValue>(
      options: ExtensionToolDefinition<Args, Output>,
    ): ExtensionToolDefinition<Args, Output>
    registerTool(context: ExtensionHostContext, tool: ExtensionToolDefinition): () => void
    handle(method: string, handler: ExtensionRpcHandler): () => void
  }
  readonly config: ExtensionJsonValue
}

export type NekroNxtClientSlotName = 'agent.workbench.sections' | 'extension.details.panels'

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

export interface NekroNxtClientSlotPropsMap {
  readonly 'agent.workbench.sections': AgentWorkbenchSlotProps
  readonly 'extension.details.panels': ExtensionDetailsSlotProps
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
    component: (props: NekroNxtClientSlotPropsMap[Name]) => unknown,
  ): () => void
}

export interface ExtensionClientContext {
  readonly slots: ExtensionClientSlotRegistry
}

export interface ExtensionClientEnvironment {
  readonly React: {
    createElement(type: string | ((props: object) => unknown), props?: object | null, ...children: unknown[]): unknown
  }
  readonly host: ExtensionClientHost
  readonly styles: ExtensionClientStyles
}

export type ExtensionPluginFactory<Environment, Context = ExtensionHostContext> = (
  environment: Environment,
) => ExtensionPluginDefinition<Context> | Promise<ExtensionPluginDefinition<Context>>

export interface NekroNxtExtensionAuthoringReference {
  readonly contractVersion: 'nekro-nxt-extension-v1'
  readonly dshVersion: '0.1.1-rc.2'
  readonly supportedContributions: {
    readonly hostTool: true
    readonly hostRpc: true
    readonly clientSlots: readonly NekroNxtClientSlotName[]
    readonly dshNativeWebUi: false
  }
  readonly examples: {
    readonly hostTool: string
    readonly hostRpcAndClientSlot: string
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

export const NEKRO_NXT_EXTENSION_AUTHORING_REFERENCE: NekroNxtExtensionAuthoringReference = {
  contractVersion: 'nekro-nxt-extension-v1',
  dshVersion: '0.1.1-rc.2',
  supportedContributions: {
    hostTool: true,
    hostRpc: true,
    clientSlots: ['agent.workbench.sections', 'extension.details.panels'],
    dshNativeWebUi: false,
  },
  examples: {
    hostTool: HOST_TOOL_EXAMPLE,
    hostRpcAndClientSlot: HOST_RPC_AND_CLIENT_SLOT_EXAMPLE,
  },
  recoveryRules: [
    '一个 Episode 同时只维护一个动态 Plugin；修复必须向同一 Plugin 追加 kind:existing Package。',
    'define、run、保存和启用是四个独立提交点；不得把动态运行声称为已保存或已启用。',
    'ctx.effect 的回调会立即执行；Tool 和 Slot 按示例直接注册，禁止在 effect 回调中立即调用注册返回的 disposer。自管资源必须由 effect 回调返回 teardown。',
    'Host RPC 必须在 Activation factory 注册；浏览器 RPC 没有 Agent Loop initiator，禁止依赖 currentInitiator 读取产品智能体身份。需要的稳定生成期数据应写入当前 Revision 源码或显式配置。',
    'agent.workbench.sections 接收当前智能体的 agentId/displayName，位于智能体配置宿主区块之后；多个贡献按注册顺序排列。',
    'extension.details.panels 只在 active Activation 下接收 agentId/extensionId/revisionId/activation；动态预览固定使用 dynamic-preview 标识，不代表已保存或已启用。',
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
- 禁止注册 root、DSH 官方页面 Slot、整页接管、Composer 或频道顶栏。
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

/** Marks a Client entry factory without executing it during build or import. */
export const defineClientExtension = <
  T extends ExtensionPluginFactory<ExtensionClientEnvironment, ExtensionClientContext>,
>(
  factory: T,
): T => factory
