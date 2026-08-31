# Extension SDK

本包是本地扩展源码唯一允许直接导入的版本化契约。它只提供 Host/Client entry factory 与可序列化边界类型，不暴露 Core 数据库、宿主路径、Electron 或 DSH 私有对象。

运行时能力通过 Activation Host 注入；新增 SDK 面必须有已实现 Extension 消费者、兼容版本和卸载测试。

智能体和 Adapter 旧契约继续只读兼容；当前 Client 契约是 `nekro-nxt-extension-v3`。Manifest V4 的 `host-ui` Revision 必须包含 Client、1–8 个 `host-page` 和完整权限声明。页面通过 `defineHostUiClientExtension()` 注册，使用 Host 分配的 `routeBase`、React Hooks 子集和 NXT UI Kit，不接管产品外壳。

Adapter Client 的 `conversation.message.rich` id 使用 `<adapterKey>:<kind>`；`connection.adapter.setup/status/test` 与 `channel.inspector.adapter.sections` 的 id 等于当前 `adapterKey`。Props 是裁剪后的连接、频道或富消息展示投影，不包含 Core、宿主路径、Secret 或平台原始事件。组件加载失败、抛错、未命中或卸载时撤销当前贡献；富消息恢复宿主卡片，局部增强恢复宿主原有界面。

Host UI 页面使用 `ctx.pages.register({ page, navigation? }, component)` 注册 Manifest 已声明的入口。`navigation` 返回版本化声明对象，路径限制在 Host 分配的 `routeBase` 内；主画布接收 `relativePath`、只读查询参数和受控 `navigate()`。`host.call()` 提供权限绑定的产品服务、扩展命名空间状态、事件订阅和受控网络请求。权限批准绑定精确 Artifact；凭据通过短期写入 token 交给 Connection 创建，不提供明文读取。Client CSS 和 SVG 必须通过 Manifest 资源清单、摘要与 Runtime 安全校验。

页面 Client 声明 `inject: ['pages', 'ui']`，并从 `ctx.ui` 使用 NXT UI Kit。`supportedContributions.hostPages.designContract` 使用 `nxt-host-ui-design-v1` 明确 Host 提供页面背景、安全边距、根滚动、对象列和 Portal，Extension 只提供当前视图内容与局部样式；普通用户不需要在需求中给出组件名或 CSS 数值。概览数字使用 `MetricStrip + Metric` 形成紧凑数字带，不用 `Grid + Section` 生成卡片墙。原生元素只用于无交互语义容器和 `DataTable` 内部表格结构；按钮、输入框、选择器、文本域、表格外壳、页头、状态和反馈不得退回浏览器默认样式。动态预览会读取真实 DOM 的 UI Kit 标记和页面几何，把组件清单、Insets、内容轴、标题区分和横向溢出写入验证证据；裸控件、缺少标准页面框、标题重复、边距/内容轴错误或没有 UI Kit 使用证据都会拒绝候选。

## Host 工具注册与 `ctx.effect`

`ctx.effect` 的回调会立即执行；回调返回值才是 Fiber 销毁时调用的 disposer。需要自行管理的资源应在回调中创建，并返回清理函数：

```ts
ctx.effect(() => {
  const unsubscribe = subscribeToSomething()
  return () => unsubscribe()
}, 'my-extension: subscription')
```

`harness.registerTool(ctx, tool)` 已把 Tool 注册绑定到当前 Fiber，Fiber 销毁时会自动撤销。因此动态插件直接注册即可：

```ts
const tool = harness.defineTool({/* ... */})
harness.registerTool(ctx, tool)
```

不要把注册返回的 disposer 再立即调用，或写成下面这样：

```ts
const disposeTool = harness.registerTool(ctx, tool)
ctx.effect(() => disposeTool()) // 错误：effect 现在执行，Tool 随即被注销
```

Client Slot 遵循同一规则：按 Authoring Reference 直接调用 `ctx.slots.register(...)`。Host RPC 则属于 Activation，必须在 factory 返回 per-Session Plugin 之前调用 `harness.handle(...)`。浏览器 RPC 请求不处于 DSH Agent Loop initiator 中，handler 不得依赖 `ctx.agents.currentInitiator()` 获取产品智能体身份；生成期稳定数据写入不可变 Revision 源码，需要运行期变化的数据通过明确的 SDK 契约或配置传入。

## Client Slot 宿主契约

`agent.workbench.sections` 位于智能体配置页“可用扩展”之后、“危险操作”之前。它在该智能体存在已加载的 Client Activation 时渲染，接收 `{ agentId, displayName }`。这是 `list` 槽：多个贡献按注册顺序纵向排列，每个贡献自行使用 `styles.section` 建立与宿主一致的区块，不得接管页头、保存动作、危险操作或右侧检查器。

`extension.activation.panels` 位于扩展详情的“使用范围”之后。用户明确选择一个 active Activation 后，宿主传入对应 `agentId`、`extensionId`、`revisionId`、`activationId` 和运行状态。旧 `extension.details.panels` 只作为 V1 兼容映射。

```text
智能体配置页                         扩展详情页
├─ 人设、模型、频道与授权             ├─ 修订与验证信息
├─ 可用扩展                          ├─ 使用范围 / Activation
├─ agent.workbench.sections[]        └─ extension.activation.panels[]
│  └─ 按 Client 注册顺序纵向追加          └─ 按 Client 注册顺序纵向追加
└─ 危险操作
```

`channel.inspector.agent.sections` 位于频道检查器“运行”与“绑定”之间，接收当前频道、绑定智能体和裁剪后的运行状态。`conversation.tool.card` 按 Tool name keyed，在会话工作流和工作轨迹详情中共享同一展示投影；参数和结果经过长度限制与脱敏，不传 DSH 内部对象。Catalog 未列出的名称、跨作用域注册和 Adapter id 不匹配都会立即失败。

持久 Client 的生命周期跟随 `agentId + Extension Activation Revision`：Snapshot/SSE 对账发现新增或换版时加载，换版先 dispose 旧注册再挂载新注册，停用、删除或 Provider 卸载时撤销全部 Slot 与 RPC。单个贡献渲染异常由 Slot Error Boundary 隔离；持久 Client 加载失败时宿主显示“扩展界面加载失败”和重新加载动作，其他扩展及宿主页保持可用。动态预览的加载、Host/Client 半边失败会回写动态运行诊断，不会伪造验证成功。

新增 Slot 必须同时具备真实宿主位置和至少一个当前消费者。实施顺序是：在 `NekroNxtClientSlotName`、Props Map 和 SlotCore 声明中增加类型；在 DSH interop allowlist 与动态 Client 验证中放行；在产品页面加入明确的 `renderSlot` 宿主；把名称、Props 和示例写入 `NEKRO_NXT_EXTENSION_AUTHORING_REFERENCE`；最后覆盖注册顺序、Props、dispose、未知槽拒绝、失败 fallback、动态预览与生产页面真实渲染。缺少任一环节时不得只预声明空槽。
