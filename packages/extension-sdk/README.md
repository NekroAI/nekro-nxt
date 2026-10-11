# Extension SDK

本包是本地扩展源码唯一允许直接导入的版本化契约。它只提供 Host/Client entry factory 与可序列化边界类型，不暴露 Core 数据库、宿主路径、Electron 或 DSH 私有对象。

npm 发布说明见 [PUBLISH-README](PUBLISH-README.md)。运行时能力由宿主在本机实例与智能体挂载中注入；新增 SDK 面必须有已实现 Extension 消费者、兼容版本和卸载测试。

## Manifest V7

扩展只有 Manifest V7（`schemaVersion: 7`），V6 及更早的格式不再读取，导入时提示“这是旧格式的扩展”。一个扩展 = 一个**本机实例** + 每个启用它的智能体一份**智能体挂载**，不再声明 `scope`；设计取舍见[扩展形态统一](../../docs/decisions/accepted/2026-10-09-扩展形态统一.md)。

| 贡献                                       | 归属       | 放置                                                                     |
| ------------------------------------------ | ---------- | ------------------------------------------------------------------------ |
| `tool`                                     | 智能体挂载 | 启用它的智能体在对话中调用                                               |
| `tool-view`                                | 智能体挂载 | 本扩展声明的 Tool 的调用视图                                             |
| `panel`（`agent` / `channel` 锚点）        | 智能体挂载 | 启用它的智能体的资料页、它响应的频道；频道面板也出现在本扩展适配器的频道 |
| `rpc`                                      | 本机实例   | 页面与面板经 `host.call` 调用                                            |
| `panel`（`extension` / `connection` 锚点） | 本机实例   | 工坊扩展详情；接线账号详情（需同时注册适配器）                           |
| `adapter`                                  | 本机实例   | 最多一个，key 在版本之间不变                                             |
| `message-renderer`                         | 本机实例   | 本扩展适配器的 `rich` 消息 kind                                          |
| `host-page`                                | 本机实例   | 最多 8 个顶级页面；至多一个页面声明 `rail` 注册导航轨入口                |

其余字段：`permissions` 为 `{ permissions, networkOrigins, host?, agent? }`——前两项是页面与面板经 `host.call` 的产品读写和 HTTP(S) origin，`host` 是本机实例的能力，`agent` 是智能体挂载的能力（见“宿主能力”）；`config` 为 `{ host?: { schema }, agent?: { schema } }`；可选 `requires: { sdk }`；可选 `icon: { path, sha256 }` 指向包内 `assets/icon.{svg,png,webp}`（64–512 像素正方形、不超过 128 KiB，规则见 [扩展包格式](../extension-format/README.md#扩展图标)）。没有任何贡献的扩展必须声明智能体层能力（例如 MCP 服务），否则拒绝保存。

## Client

Client factory 接收 `{ React, host, styles }`，返回带 `inject` 与 `apply(ctx)` 的插件。一个安装到本机的扩展只运行一份 Client，它的智能体与频道面板、工具视图按“该扩展启用给哪些智能体”实时放置，启用或停用不会重新加载 Client。`ctx` 提供：

- `ctx.panels.register(declaration, Component)`：声明 `id`、`anchor`、`title`（≤24）、可选 `icon`、`densities`（`compact`/`full`）；连接面板另有 `role: setup | status | diagnostics`，频道面板可用 `when.channelKinds` 限定。组件收到 `{ anchor: { kind, id }, density, role? }`，只渲染内容；外框、标题、折叠、加载与失败回退由宿主的 ContributionFrame 绘制。
- `ctx.toolViews.register(tool, Component)`：组件收到 `{ call, density }`，`chip` 是一行摘要，`card` 是展开后的结构化结果。
- `ctx.messageRenderers.register(richKind, Component)`：组件收到 `{ part, messageId, channelId }`，渲染失败或卸载时宿主恢复默认卡片。
- `ctx.pages.register({ page, navigation? }, Component)`：页面使用 Host 分配的 `routeBase`，主画布接收 `relativePath`、只读查询参数和受控 `navigate()`。
- `ctx.data.useAgent/useChannel/useConnection/useChannelRuntime`：订阅产品数据的只读 Hook，分别需要 `agents.read`、`channels.read`、`connections.read`、`runtime.read` 权限，缺少权限时抛错。
- `ctx.ui`：版本化 UI Kit `ui-kit@2`（`HOST_UI_KIT_COMPONENT_NAMES` 中的组件，由产品组件库实现）；各组件的属性见 `NEKRO_NXT_EXTENSION_AUTHORING_REFERENCE.ui.componentProps`。

`host.call(method, input?, { anchor? })` 调用本机实例的 RPC，或权限允许的产品读写。面板应传入组件参数里的 `anchor`：宿主核对锚点（智能体启用了本扩展、频道或连接存在）后，把解析出的 `caller`（锚定的智能体、频道、连接）交给 RPC 处理函数；页面调用不需要 `anchor`。Client CSS 随 Revision 提交，交付时选择器固定到该构建的 `data-host-ui-owner` 作用域；动态预览通过 `styles.insert(css)` 注入同一作用域的样式，安装后由宿主加载，同一份源码在两处都可用。不再提供 `styles` 类名映射，组件直接使用自己 CSS 中的类名。

## 权限与验证

权限分两层批准，各自绑定精确 Artifact 摘要：浏览器侧权限与 `permissions.host` 在安装到本机时批准，`permissions.agent` 在给每个智能体启用时批准；切换版本时只重新批准能力扩大的那一层。凭据只写不读。动态预览、保存与导入会在每种声明的密度与明暗两种主题下真实渲染每个面板，以 `chip` 和 `card` 渲染每个工具视图，渲染每个富消息渲染器，并对页面执行注册与 Navigation；渲染失败、横向溢出或未捕获错误都阻止 `ready`。

## 宿主能力（`nxt`）

Host 入口的 factory 只在本机执行一次（本机实例），参数为 `{ harness, config, nxt }`：

- factory 参数里的 `nxt` 是**本机层**服务：`http`、`secrets`、`storage`（本机分区，即智能体挂载里 `scope: 'shared'` 的同一份数据）、`render`、`parse`，以及扩展资源库 `assets.list/get/release`、`image.info`、`index` 和 `models`，按 `permissions.host`（`{ network?, storage?, assets?: { library }, index?, models? }`）检查；在 RPC 处理函数里使用。
- factory 返回的插件是**智能体挂载**，挂载到每个启用它的智能体的每个 DSH Session；在 `inject` 中加入 `nxt` 后，`ctx.nxt` 是绑定到该智能体与频道的服务，按 `permissions.agent` 检查，下表列出它的全部接口。`ctx.config()` 与 `ctx.nxt.config()` 返回该智能体的配置。

未声明的调用抛出指明缺失字段的错误。正式启用、动态运行和保存/导入验证提供同一接口：动态运行使用临时存储，验证使用临时存储、合成调用上下文和空凭据，网络请求真实发出；动态运行中本机层 `nxt` 要等扩展挂载后才可用。设计取舍见[扩展宿主能力与生态移植](../../docs/decisions/accepted/2026-10-07-扩展宿主能力与生态移植.md)与[扩展形态统一](../../docs/decisions/accepted/2026-10-09-扩展形态统一.md)。

| 接口                                                                     | 需要声明                                                          | 说明                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `http.fetch(url, init)`                                                  | `network`                                                         | `domains`（含 `*.` 子域通配）、`config`（主机取自所列配置字段的当前值，允许用户填写的内网地址）或 `unrestricted`（启用时用户确认风险）；所有模式拦截私网并逐跳校验重定向，跨域重定向去掉 `authorization` 与 `cookie`                                          |
| `secrets.get(key)`                                                       | 配置中 `meta.role: 'secret'` 字段                                 | `config.host` 与 `config.agent` 都可声明（字段名不重复，按声明它的那一层取值）；值保存在宿主凭据存储，配置只存引用；不能有默认值，客户端只看到“已设置”；动态运行只看得到用户在创造任务页填写的测试凭据，保存与导入验证没有凭据                                |
| `assets.create` / `fromUrl`                                              | `assets: { write: true }`（`fromUrl` 另需 `network`）             | 生成当前频道 Asset 并返回 `assetId`，由智能体经通信工具发送                                                                                                                                                                                                   |
| `assets.keep/release/attach`、`create(input, { library: true })`         | `assets: { library: { quotaBytes? } }`                            | 扩展资源库：keep 收录当前频道看得到的 Asset（内容寻址，重复收录只算一份），之后用 attach 在任意频道授权并取得可发送的 `assetId`；默认配额 2 GiB、上限 32 GiB；本机层另有 `assets.list/get/release`，页面用 `host.upload` 上传图片或 zip、`host.assetUrl` 显示 |
| `image.info(assetId)`                                                    | `assets: { library }`                                             | 图片的格式、尺寸、帧数、字节数和 64 位差异哈希；挂载内可读当前频道看得到的图，本机层只读资源库                                                                                                                                                                |
| `index.upsert/delete/count/query`                                        | `index: { collections: [{ name, fields, filters }] }`             | 宿主维护的检索索引，每个集合最多 4 个带权重的文本字段与 4 个过滤字段，两层同时声明时定义必须一致；默认关键词检索（FTS5 + 分词），管理员在「设置 → 检索」下载内置语义模型后自动混合语义检索，扩展不处理向量                                                    |
| 工具 `output.render` 返回 `{ type: 'image', assetId, label }`            | 无（图片须在当前频道可见或在资源库中）                            | 宿主把图片以低细节附给有视觉能力的模型，上下文里已经看得到的图不重复附上，单次最多 6 张；没有视觉能力时只给文字说明；工具返回值不变，编排模式照常可用                                                                                                         |
| `storage.get/set/delete/list`                                            | `storage: { scopes, quotaBytes? }`                                | JSON 键值；`agent`（默认）、`channel`、`member`（需 `memberId`）、`shared`；单值 256 KiB，默认配额 8 MiB                                                                                                                                                      |
| `context.current()`                                                      | 无                                                                | 当前智能体、频道和最近一条入站消息                                                                                                                                                                                                                            |
| `history.list` / `search`                                                | `history: { read: true }`                                         | 只读当前频道已入库的对话消息                                                                                                                                                                                                                                  |
| `llm.complete({ system, messages, maxOutputTokens })`                    | `llm: { maxCallsPerTurn, maxOutputTokens }`                       | 用智能体当前模型完成一次辅助任务，计入该智能体用量；每轮超过次数上限即拒绝，输出长度不超过声明；验证阶段返回固定回复，不消耗模型额度                                                                                                                          |
| `harness.onInbound(handler)`（factory 阶段）                             | `inboundHook: { reads, mayHide, mayForceTrigger, timeoutMs }`     | 消息入库后、唤醒智能体前运行；可不触发、强制触发、对智能体隐藏或附加标注，超时或出错按默认处理；决定只保存一次，恢复时不重跑；动态运行时宿主包装源码以真实调用一次                                                                                            |
| `jobs.schedule/list/cancel`                                              | `jobs: { declared?, runtime?: { maxActive } }`                    | 到期时在频道写入“定时任务”控制事实并唤醒智能体，不形成回应义务；同一计划时刻按去重键只触发一次；动态运行只记录不触发                                                                                                                                          |
| `harness.onJob(handler)`（factory 阶段）                                 | `jobs`                                                            | 本扩展的任务到期时、唤醒智能体之前运行；返回 `{ wake: false }` 让这次到期静默通过，`note` 随到期事件交给智能体；15 秒超时或出错按默认唤醒；动态运行与验证只记录不调用                                                                                         |
| `platform.actions/invoke/raw`                                            | `platform: { actions: [{ adapter, action }], raw: [adapterKey] }` | 只作用于当前频道的连接；类型化动作由 Adapter Descriptor 的 `platformActions` 声明，原始透传需要 Adapter 声明 `rawApi`；都走耐久互动意图并按频道限流；动态运行与验证只模拟执行                                                                                 |
| `mcp: { servers }`（宿主连接，无接口）                                   | 只能由工坊「添加 MCP 服务」或导入带入                             | 启用期间宿主为每个服务加载 DSH MCP 桥接，工具名为 `mcp__<name>__<tool>`；请求头与环境变量可引用凭据字段；动态创造声明会被拒绝；见[MCP 服务接入](../../docs/decisions/implemented/2026-10-07-MCP服务接入.md)                                                   |
| `render.svg(svg, { scale, format, background })`                         | 无（发送需 `assets`）                                             | 用宿主系统字体渲染 SVG，返回 base64 与尺寸，交给 `assets.create` 发送；只允许 `#片段` 与 `data:` 引用，拒绝 DOCTYPE/实体；源文 2 MiB、输出 4096×4096 像素以内                                                                                                 |
| `parse.html(html, { url, mode, maxChars })` / `parse.feed(xml, { url })` | 无（取回内容需 `network`）                                        | 网页转 Markdown（默认 Readability 正文，可 `full`）并给出绝对链接；RSS 2.0、RSS 1.0 与 Atom 统一为条目列表（最多 100 条，摘要为纯文本）                                                                                                                       |
| `prompt.static` / `dynamic`                                              | `context: [{ name, kind, maxChars }]`                             | 静态段是固定字符串；动态上下文每轮开始渲染一次，只读存储与调用上下文，变化时才追加；保存验证要求两次渲染逐字节一致                                                                                                                                            |
| `models.list()` / `models.complete(request)`（本机层）                   | `permissions.host.models: { maxCallsPerMinute, maxOutputTokens }` | 调用用户在「设置 → 模型」里配置好的模型完成页面发起的批量任务（例如给导入的图片写描述），由页面让用户选模型；宿主按模型最低的思考强度调用，避免思考占满输出长度；图片只能来自资源库；只能声明在 `permissions.host`                                            |

以上“需要声明”一列除标明本机层的接口外都写在 `permissions.agent`（原 `permissions.capabilities`），`assets`、`index` 也可以写在 `permissions.host` 供本机层使用。`requires: { sdk }` 声明最低宿主能力等级（当前为 `EXTENSION_SDK_LEVEL`）：用到扩展资源库、检索索引或本机层模型调用时必须声明 8，声明低于实际用到的能力会被拒绝；智能体创建的扩展由宿主自动写入。社区和导入检查按 `EXTENSION_SDK_RELEASES` 显示所需的 NekroNXT 版本，过旧的宿主提示升级。能力扩大（新增键、网络模式升级或新增域名/字段、新增存储作用域、模型调用上限提高）需要重新批准，存储配额变化不需要。

## 配置

`config.host.schema` 与 `config.agent.schema` 都是序列化 Schemastery 的产品子集：object、string、number、natural、percent、boolean、const、const 组成的 union 和原始值 array；两层字段名不能重复。`meta.role: 'secret'` 表示只写凭据；`hint`、`advanced`、`group` 与 `visibleWhen` 控制表单展示。本机配置随安装保存，factory 中用 `harness.config()` 读取；智能体配置按 `(agentId, extensionId)` 随启用保存并在安全间隙生效，挂载内用 `ctx.config()` 读取。动态运行阶段没有已保存配置，使用 Schema 默认值。

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

面板、工具视图、富消息渲染器和页面遵循同一规则：按 Authoring Reference 直接注册。Host RPC、适配器、入站钩子与定时任务处理属于本机实例，必须在 factory 中注册（返回智能体挂载插件之前）。RPC 处理函数签名为 `(input, caller)`；浏览器 RPC 请求不处于 DSH Agent Loop initiator 中，handler 不得依赖 `ctx.agents.currentInitiator()` 获取产品智能体身份，改用 `caller`。没有智能体挂载的扩展（只有页面或适配器）的 factory 可以不返回插件。
