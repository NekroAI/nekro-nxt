# Extension SDK

本包是本地扩展源码唯一允许直接导入的版本化契约。它只提供 Host/Client entry factory 与可序列化边界类型，不暴露 Core 数据库、宿主路径、Electron 或 DSH 私有对象。

运行时能力通过 Activation Host 注入；新增 SDK 面必须有已实现 Extension 消费者、兼容版本和卸载测试。

## Manifest V6

扩展只有 Manifest V6（`schemaVersion: 6`），旧格式不再读取或重建。`scope` 为 `agent | host-adapter | host-ui`，每种 scope 都声明 `permissions`（可为空），可选 `config: { schema }` 使用序列化 Schemastery，可选 `requires: { sdk }`；智能体扩展的 `permissions` 另可包含 `capabilities`（见“宿主能力”）。贡献与放置规则见[客户端体验重构与扩展界面统一 §5](../../docs/decisions/accepted/2026-10-04-客户端体验重构与扩展界面统一.md)：

| 贡献               | scope                                                                               | 放置                               |
| ------------------ | ----------------------------------------------------------------------------------- | ---------------------------------- |
| `tool` / `rpc`     | agent                                                                               | 智能体工具与界面数据接口           |
| `panel`            | agent（锚点 `agent`/`channel`/`extension`）、host-adapter（`connection`/`channel`） | 宿主按锚点决定页面与位置           |
| `tool-view`        | agent                                                                               | 本 Revision 声明的 Tool 的调用视图 |
| `message-renderer` | host-adapter                                                                        | 本 Adapter 的 `rich` 消息 kind     |
| `adapter`          | host-adapter                                                                        | 恰好一个                           |
| `page`             | host-adapter、host-ui                                                               | 最多 8 个顶级页面                  |

## Client

Client factory 接收 `{ React, host, styles }`，返回带 `inject` 与 `apply(ctx)` 的插件。`ctx` 提供：

- `ctx.panels.register(declaration, Component)`：声明 `id`、`anchor`、`title`（≤24）、可选 `icon`、`densities`（`compact`/`full`）；连接面板另有 `role: setup | status | diagnostics`，频道面板可用 `when.channelKinds` 限定。组件收到 `{ anchor: { kind, id }, density, role? }`，只渲染内容；外框、标题、折叠、加载与失败回退由宿主的 ContributionFrame 绘制。
- `ctx.toolViews.register(tool, Component)`：组件收到 `{ call, density }`，`chip` 是一行摘要，`card` 是展开后的结构化结果。
- `ctx.messageRenderers.register(richKind, Component)`：组件收到 `{ part, messageId, channelId }`，渲染失败或卸载时宿主恢复默认卡片。
- `ctx.pages.register({ page, navigation? }, Component)`：页面使用 Host 分配的 `routeBase`，主画布接收 `relativePath`、只读查询参数和受控 `navigate()`。
- `ctx.data.useAgent/useChannel/useConnection/useChannelRuntime`：订阅产品数据的只读 Hook，分别需要 `agents.read`、`channels.read`、`connections.read`、`runtime.read` 权限，缺少权限时抛错。
- `ctx.ui`：版本化 UI Kit `ui-kit@2`（`HOST_UI_KIT_COMPONENT_NAMES` 中的组件，由产品组件库实现）；各组件的属性见 `NEKRO_NXT_EXTENSION_AUTHORING_REFERENCE.ui.componentProps`。

`host.call(method, input?)` 调用本 Revision 的 Host RPC，或权限允许的产品读写。Client CSS 随 Revision 提交，交付时选择器固定到该构建的 `data-host-ui-owner` 作用域；动态预览通过 `styles.insert(css)` 注入同一作用域的样式，安装后由宿主加载，同一份源码在两处都可用。不再提供 `styles` 类名映射，组件直接使用自己 CSS 中的类名。

## 权限与验证

权限批准绑定精确 Artifact 摘要：智能体扩展在给智能体启用时批准，Host 扩展在安装时批准；凭据只写不读。动态预览、保存与导入会在每种声明的密度与明暗两种主题下真实渲染每个面板，以 `chip` 和 `card` 渲染每个工具视图，渲染每个富消息渲染器，并对页面执行注册与 Navigation；渲染失败、横向溢出或未捕获错误都阻止 `ready`。

## 宿主能力（`ctx.nxt`）

智能体扩展的 Host 半边在 `inject` 中加入 `nxt` 后，通过 `ctx.nxt` 使用宿主能力；能力在 `permissions.capabilities` 声明，未声明的调用抛出指明缺失字段的错误。正式启用、动态运行和保存/导入验证提供同一接口：动态运行使用临时存储，验证使用临时存储、合成调用上下文和空凭据，网络请求真实发出。设计取舍见[扩展宿主能力与生态移植](../../docs/decisions/accepted/2026-10-07-扩展宿主能力与生态移植.md)。

| 接口                                                  | 需要声明                                                          | 说明                                                                                                                                                                                                                 |
| ----------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `http.fetch(url, init)`                               | `network`                                                         | `domains`（含 `*.` 子域通配）、`config`（主机取自所列配置字段的当前值，允许用户填写的内网地址）或 `unrestricted`（启用时用户确认风险）；所有模式拦截私网并逐跳校验重定向，跨域重定向去掉 `authorization` 与 `cookie` |
| `secrets.get(key)`                                    | 配置中 `meta.role: 'secret'` 字段                                 | 值保存在宿主凭据存储，Activation 配置只存引用；不能有默认值，客户端只看到“已设置”                                                                                                                                    |
| `assets.create` / `fromUrl`                           | `assets: { write: true }`（`fromUrl` 另需 `network`）             | 生成当前频道 Asset 并返回 `assetId`，由智能体经通信工具发送                                                                                                                                                          |
| `storage.get/set/delete/list`                         | `storage: { scopes, quotaBytes? }`                                | JSON 键值；`agent`（默认）、`channel`、`member`（需 `memberId`）、`shared`；单值 256 KiB，默认配额 8 MiB                                                                                                             |
| `context.current()`                                   | 无                                                                | 当前智能体、频道和最近一条入站消息                                                                                                                                                                                   |
| `history.list` / `search`                             | `history: { read: true }`                                         | 只读当前频道已入库的对话消息                                                                                                                                                                                         |
| `llm.complete({ system, messages, maxOutputTokens })` | `llm: { maxCallsPerTurn, maxOutputTokens }`                       | 用智能体当前模型完成一次辅助任务，计入该智能体用量；每轮超过次数上限即拒绝，输出长度不超过声明；验证阶段返回固定回复，不消耗模型额度                                                                                 |
| `harness.onInbound(handler)`（factory 阶段）          | `inboundHook: { reads, mayHide, mayForceTrigger, timeoutMs }`     | 消息入库后、唤醒智能体前运行；可不触发、强制触发、对智能体隐藏或附加标注，超时或出错按默认处理；决定只保存一次，恢复时不重跑；动态运行时宿主包装源码以真实调用一次                                                   |
| `jobs.schedule/list/cancel`                           | `jobs: { declared?, runtime?: { maxActive } }`                    | 到期时在频道写入“定时任务”控制事实并唤醒智能体，不形成回应义务；同一计划时刻按去重键只触发一次；动态运行只记录不触发                                                                                                 |
| `platform.actions/invoke/raw`                         | `platform: { actions: [{ adapter, action }], raw: [adapterKey] }` | 只作用于当前频道的连接；类型化动作由 Adapter Descriptor 的 `platformActions` 声明，原始透传需要 Adapter 声明 `rawApi`；都走耐久互动意图并按频道限流；动态运行与验证只模拟执行                                        |
| `prompt.static` / `dynamic`                           | `context: [{ name, kind, maxChars }]`                             | 静态段是固定字符串；动态上下文每轮开始渲染一次，只读存储与调用上下文，变化时才追加；保存验证要求两次渲染逐字节一致                                                                                                   |

`requires: { sdk }` 声明最低宿主能力等级（当前为 `EXTENSION_SDK_LEVEL`），过旧的宿主在导入时提示升级。能力扩大（新增键、网络模式升级或新增域名/字段、新增存储作用域、模型调用上限提高）需要重新批准，存储配额变化不需要。

## 配置

`config.schema` 是序列化 Schemastery 的产品子集：object、string、number、natural、percent、boolean、const、const 组成的 union 和原始值 array。`meta.role: 'secret'` 表示只写凭据，只允许智能体扩展声明；`hint`、`advanced`、`group` 与 `visibleWhen` 控制表单展示。Host 侧读取当前配置使用 `harness.config?.() ?? {}`，动态运行阶段没有已保存配置，使用 Schema 默认值。智能体扩展的配置按 `(agentId, extensionId)` 随 Activation 保存并在安全间隙生效，Host 扩展的配置随 Installation 保存。

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

面板、工具视图、富消息渲染器和页面遵循同一规则：按 Authoring Reference 直接注册。Host RPC 属于 Activation，必须在 factory 返回 per-Session Plugin 之前调用 `harness.handle(...)`。浏览器 RPC 请求不处于 DSH Agent Loop initiator 中，handler 不得依赖 `ctx.agents.currentInitiator()` 获取产品智能体身份；生成期稳定数据写入不可变 Revision 源码，需要运行期变化的数据通过配置传入。
