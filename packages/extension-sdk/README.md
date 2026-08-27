# Extension SDK

本包是本地扩展源码唯一允许直接导入的版本化契约。它只提供 Host/Client entry factory 与可序列化边界类型，不暴露 Core 数据库、宿主路径、Electron 或 DSH 私有对象。

运行时能力通过 Activation Host 注入；新增 SDK 面必须有已实现 Extension 消费者、兼容版本和卸载测试。

智能体扩展契约为 `nekro-nxt-extension-v1`；Host Adapter 验证证据为 `nekro-nxt-extension-v2`，两者对应 DSH `0.1.1-rc.2`。Host Tool/RPC Client 只允许 `agent.workbench.sections` 与 `extension.details.panels`；Adapter Host 使用 `harness.registerAdapter()`，Adapter Client V1 只允许 `conversation.message.rich`。

Adapter Client 的 `id` 必须是当前 `<adapterKey>:<kind>`，Props 只含结构化 rich part、`messageId` 和 `channelId`。它没有 Host RPC、Core、宿主路径或平台原始事件。组件加载失败、抛错、未命中或卸载时撤销当前贡献并回退宿主卡片。

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

`agent.workbench.sections` 位于智能体配置页全部宿主区块之后、绑定与删除确认 Dialog 之前。它只在该智能体存在已加载的 Client Activation 时渲染，接收 `{ agentId, displayName }`。这是 `list` 槽：多个贡献按注册顺序纵向排列，每个贡献自行使用 `styles.section` 建立与宿主一致的区块，不得接管页头、保存动作、危险操作或右侧检查器。

`extension.details.panels` 位于扩展详情的“使用范围”之后。宿主只为当前详情页选中的一个 active Activation 渲染它，接收 `{ agentId, extensionId, revisionId, activation: 'active' }`；未启用时不显示。它同样是 `list` 槽，多个贡献按注册顺序纵向排列。动态创造预览固定使用 `extensionId: 'dynamic-preview'`、`revisionId: 'dynamic-preview'` 和 `activation: 'active'`，这些值只表示尚未保存的预览环境，不能据此声称扩展已保存或已启用。

```text
智能体配置页                         扩展详情页
├─ 人设与模型等宿主区块              ├─ 版本与验证信息
├─ 授权能力                          ├─ 使用范围 / Activation
│  └─ 动态创造策略                   └─ extension.details.panels[]
├─ 危险操作                             └─ 按 Client 注册顺序纵向追加
└─ agent.workbench.sections[]
   └─ 按 Client 注册顺序纵向追加
```

持久 Client 的生命周期跟随 `agentId + Extension Activation Revision`：Snapshot/SSE 对账发现新增或换版时加载，换版先 dispose 旧注册再挂载新注册，停用、删除或 Provider 卸载时撤销全部 Slot 与 RPC。单个贡献渲染异常由 Slot Error Boundary 隔离；持久 Client 加载失败时宿主显示“扩展界面加载失败”和重新加载动作，其他扩展及宿主页保持可用。动态预览的加载、Host/Client 半边失败会回写动态运行诊断，不会伪造验证成功。

新增 Slot 必须同时具备真实宿主位置和至少一个当前消费者。实施顺序是：在 `NekroNxtClientSlotName`、Props Map 和 SlotCore 声明中增加类型；在 DSH interop allowlist 与动态 Client 验证中放行；在产品页面加入明确的 `renderSlot` 宿主；把名称、Props 和示例写入 `NEKRO_NXT_EXTENSION_AUTHORING_REFERENCE`；最后覆盖注册顺序、Props、dispose、未知槽拒绝、失败 fallback、动态预览与生产页面真实渲染。缺少任一环节时不得只预声明空槽。
