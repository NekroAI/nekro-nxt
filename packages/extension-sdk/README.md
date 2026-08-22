# Extension SDK

本包是本地扩展源码唯一允许直接导入的版本化契约。它只提供 Host/Client entry factory 与可序列化边界类型，不暴露 Core 数据库、宿主路径、Electron 或 DSH 私有对象。

运行时能力通过 Activation Host 注入；新增 SDK 面必须有已实现 Extension 消费者、兼容版本和卸载测试。

当前公开契约为 `nekro-nxt-extension-v1`，对应 DSH `0.1.1-rc.2`。Host 暴露类型化 Tool 注册和 JSON RPC；Client 只允许注册 `agent.workbench.sections` 与 `extension.details.panels`，并只接收 `section`、`sectionHeading`、`secondaryText`、`actionRow`、`button`、`badge` 六个稳定样式键。`NEKRO_NXT_EXTENSION_AUTHORING_REFERENCE` 是 Skill、Inspect 和测试共同消费的唯一开发参考，禁止在各入口复制另一套示例。

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
