# NekroNxt 接线与 Server 宿主设计

> 文档编号：08
>
> 状态：QQ 凭据录入、私有本地存储、生产 Runtime、Gateway 状态、真实收发诊断与重启恢复已接通；动态 Client Runtime 已挂入真实浏览器入口并通过生产旅程。外部 QQ 账号手工验收和闭环 A 的连续保存/启用/重启产品验收仍待完成
>
> 日期：2026-08-16
>
> 目标：把已有「Server 领域运行时」与「Web 产品 UI」之间的 mock 数据层替换为真实接线，满足「普通用户不用终端完成两条一期闭环」的 M6 完成标准

## 1. 背景与问题

一期 M1–M5 已形成可验证的领域运行时：`apps/server` 的 `DshHostRuntime` 组装 DSH 引擎，`CoreService`/`ChannelRuntime`/`AssetService`/Extension 体系提供智能体、会话、扩展与 QQ 能力。开始本轮接线前存在两个缺口，后续章节记录其收口结果：

1. **`apps/server` 当时无可执行入口**：`src/index.ts` 只导出库形态（`DshHostRuntime` 等），没有可 listen 的 server 进程，也没有 `dev`/`start` 脚本；领域主装配只存在于测试文件内联代码中。
2. **`apps/web` 当时只有演示数据层**：`product-store.ts` 的动作只改本地内存；虽然已定义 `ProductHostPort`，但没有真实 fetch/SSE 接线。

## 2. 架构决策

### 2.1 复用 DSH Host 接缝，不引入独立 HTTP 框架（决策 D24 落实）

按 `docs/04` D24 与 `docs/decisions/accepted/2026-08-16-一期技术栈与UI基础设施.md`，Core API Host **复用 DSH WebServer 接缝**，避免两个服务器和两套 RPC/实时状态所有者：

- HTTP：`@deepseek-ai/dsh-host-webserver` 的 `register({kind, path, handler})`，handler 直接处理 `node:http` 的 `IncomingMessage`/`ServerResponse`；
- 实时（SSE）：`register` 的 handler 可持有响应开放，用 SSE push 频道事实流；WebSocket 需要时走 `registerUpgrade`；
- 静态托管：`@deepseek-ai/dsh-host-frontend-static`（配置 `distIndex`）占据 webserver 唯一 fallback 席位，服务 Vite 构建产物并为 SPA 路由回退到 `index.html`；
- **不引入 hono / fastify / express**。

### 2.2 NekroNxt 领域 API，不泄漏 DSH Session 领域

DSH 自带的 `apiproxy`/Typert 协议深度绑定 DSH 自己的 `SessionsApi`/`HostApi`/`EventsApi`（DSH 智能体会话模型）。NekroNxt 的产品领域是「智能体/Connection/Channel/Extension」更高层抽象，其状态是 `CoreService` 与 `ChannelRuntime`，不是 DSH Session 日志。

因此接线只复用 DSH 的**传输载体接缝**（WebServer + SSE + 静态托管），而领域 API 由 NekroNxt 自己定义、落在 `apps/server` 的 `NekroHostApi` 上。它只经由已验证的 `CoreService`/`ChannelRuntime`/Asset/Extension 公开服务访问状态，不把数据库连接或 DSH `Context` 暴露到 wire。

### 2.3 单一数据入口：Web 是消费端

Web 端不复制一份业务事实到 Zustand。`ProductHostPort.getSnapshot()` 返回 Server 权威投影；`subscribe()` 订阅 SSE 事实流（频道事件、智能体状态、扩展回执）；`execute(command, input)` 派发一次性操作（创建智能体、发送消息、创建连接、保存扩展等）。Zustand 只保留 UI 本地态（主题、减少动效、草稿）。

## 3. 接线形态

### 3.1 领域 API（`NekroHostApi`，落在 apps/server）

传输：`WebServer.register` 的具名路由 + 一个 `GET /api/events` SSE 端。已实现状态以✅/⏳标注：

| 方法 | 路由 | 语义 | 状态 |
|---|---|---|---|
| 快照 | `GET /api/snapshot` | 返回 models/connectionAdapters/agents/channels/connections/extensions/dynamic 权威投影；`messages` 保持空数组，历史按频道读取 | ✅ |
| 订阅 | `GET /api/events` (SSE) | 推送频道 `channel-fact`（智能体回复）与 `status`；心跳保持 | ✅ |
| 创建智能体 | `POST /api/agents` | createAgent + ensureChannel + createBinding（自动 Web Channel） | ✅ |
| 发送消息 | `POST /api/channels/:id/messages` | 构造入站事件并经 acceptInbound 进入 Runtime | ✅ |
| 频道历史 | `GET /api/channels/:id/messages` | 按 `(occurredAt, sourceId)` 游标读取频道内消息；默认最近 40 条，返回 oldest-first 与 `hasMore` | ✅ |
| 频道资源 | `GET /api/channels/:channelId/assets/:assetId` | 校验频道访问权和 blob 状态后同源读取图片、音频或文件，不暴露宿主路径 | ✅ |
| 频道本地名称 | `POST /api/channels/:id/display-name` | 保存仅用于 NekroNxt 展示的频道名称，不修改平台频道 ID | ✅ |
| 创建连接 | `POST /api/connections` | 接收 `adapterKey + configuration + credentials`；按已安装 Adapter schema 校验，Host 私有存储凭据后创建对应 Runtime | ✅ |
| 创建频道绑定 | `POST /api/bindings` | 对已发现 Channel 与指定智能体创建独立 Binding，保存触发策略；智能体可绑定多个频道，频道换绑时只保留一个活动智能体 | ✅ |
| 启用扩展 | `POST /api/extensions/:id/activation` | AgentActivation 启用（body `{agentId, revisionId}`） | ✅ |
| 停用扩展 | `DELETE /api/extensions/:id/activation` | 停用当前 Activation（安全间隙后完成） | ✅ |
| 创建智能体引导跑动 | —— | —— | —— |
| 修改能力 | `POST /api/agents/:id/capabilities` | 按当前 Revision 生成或复用不可变 AgentRevision，更新 subagents/fileTools/webSearch/dynamicCreation/developmentShell/unrestrictedFileAccess | ✅ V2 codec、Server+Web 命令+store 委托、Revision Scope 运行时 |
| 修改智能体配置 | `POST /api/agents/:id/revision` | 携带 expectedCurrentRevisionId 保存名称、人设与 DSH provider/model 为新不可变 AgentRevision；冲突要求刷新 | ✅ Server+Web 管理页 |
| 模型供应商目录 | `GET /api/llm/providers` | 投影 DSH 可配置供应商、脱敏 settings 层、凭据状态和活动模型 | ✅ |
| 保存模型供应商 | `POST /api/llm/providers/:id` | 用 DSH settings mutate 保存 profile，API Key 经 DSH credentials 只写保存 | ✅ |
| 发现供应商模型 | `POST /api/llm/discover-models` | 通过 DSH `discoverModels` 查询表单当前端点，不隐式保存凭据 | ✅ |
| 测试模型供应商 | `POST /api/llm/test-provider` | 经 DSH 发起最小真实模型请求，不返回生成内容，脱敏呈现认证、额度与限流错误 | ✅ |
| QQ 收发测试 | `POST /api/connections/:id/test` | 接收只在真实 Gateway 入站提交后通过；发送经已发现 Channel 的 QQ HTTP Transport 返回平台 message ID | ✅ 生产装配测试通过；外部账号待手工验收 |
| 保存动态包 | `POST /api/extensions/save-from-dynamic` | 把活动会话中的运行动态 Package 保存为本地 Extension Revision（不自动启用） | ✅ |
| 动态审批/调用 | `POST /api/dynamic/:agentId/{inventory\|approve\|decline\|invoke\|run-host-half\|get-client-code\|settle-user-run\|report-render-failure}` | 解析智能体活动会话并调用 DshHostRuntime 动态方法（清单、审批解析、Host half 启动、Client 源码获取、Host 方法调用、用户 run 结算、渲染失败上报） | ✅ 服务端、Web Host 与生产浏览器 Slot 旅程 |

`GET /api/snapshot` 现在投影：DSH 实时注册的 provider/model 目录和 `idle/running` 状态、子智能体与 Web 搜索可用状态、已安装 Adapter 的连接配置描述、全部 `Connection`（不返回 Secret）、Gateway 状态、凭据是否已配置、收发测试、已绑定智能体、频道、全部已保存本地扩展（含当前 AgentActivation 状态）、各智能体活动会话中运行的动态 Package。Web 搜索状态通过 DSH settings/credentials 接缝计算，未配置 Provider 凭据时不可用，不以环境变量名称存在推断可用。快照不附带每个频道的近期消息；发送者、Mention、资源和回执由频道历史端点按需投影。

### 3.2 Web 侧

- `apps/web/src/http-host.ts` 实现 `ProductHostPort`：`getSnapshot()` 缓存式 `fetch('/api/snapshot')`；`subscribe()` 用 `EventSource('/api/events')`（`channel-fact`/`status` 触发刷新，网络故障静默降级+自动重连）；`execute()` 映射真实命令。
- `execute` 命令表：`agents.create`、`channels.sendMessage`、`agents.updateCapabilities`、`extensions.activate`、`extensions.deactivate`、`extensions.saveFromDynamic`、`connections.create`、`connections.test`、`dynamic.approve`、`dynamic.decline`。
- 创建智能体的模型选择器来自快照中的 DSH 实时目录，并把确切 `{provider, model}` 写入不可变 AgentRevision；Server 未注册模型时明确阻止创建，不再硬编码显示文案或伪造模型 ID。
- 添加连接先从 Server 投影的 `connectionAdapters` 选择用户可创建的平台，再按 Adapter 的版本化 JSON Schema 子集渲染通用表单；`credential-reference` 字段经独立只写对象提交。系统托管的本地 Web 不出现在创建目录，也不显示 QQ 账号字段或收发测试。
- 智能体频道页从全量 Connection Channel 投影选择频道和触发策略，经 `bindings.create` 创建真实 Binding。外部 Connection 尚未收到消息、因此没有发现 Channel 时明确提示先发送一条平台消息，不再保留空按钮。
- 消息页按智能体分组频道；每个频道首次进入才读取最近一页，滚到顶部按游标加载更早消息，prepend 后补偿滚动高度并记忆频道位置。图片、音频和文件只使用频道受控资源 URL，图片由浏览器懒加载。
- QQ 群名称只消费平台事件可选的 `group_name/group_nick/group_title`；QQ 事件仅提供 `group_openid` 时不伪造名称，允许用户保存本地频道名称，稳定 `platformChannelId` 不变。
- QQ 当前贡献 App ID、Client Secret、主动发送和平台限制字段；Secret 提交成功后立即从浏览器表单清除，快照只显示“已配置”。Gateway 状态、最后错误、已知频道数和收发测试来自 Server 权威投影。
- 创建连接与收发测试等待真实 HTTP 结果；失败时保留创建弹窗或在诊断区展示 Server 错误，不会静默清空 Secret 或把失败表现为成功。
- 发送测试不会任意选择群聊；发现一个频道时可直接使用，发现多个频道时必须由用户明确选择目标。
- `product-store` 的 `createAgent`/`sendMessage`/`createConnection`/`setExtensionActive`/`resolveApproval` 在有活动 Host 时委托 `execute`，无 Host 保留 demo 数据（现有 UI 测试不破）。
- 创造工作台（Creator 页）改读快照投影的真实 `dynamic`（运行动态 Package + 审批请求），`resolveApproval` 经产品级 DSH Client Coordinator 派发真实审批；Coordinator 安装官方 React Slot Renderer，以一个页面级 ModuleLoader 按当前选中智能体切换清单，避免跨会话短插件 ID 冲突，并在状态变化或离开页面时 retract。`HttpDynamicClientHost` 实现 `DynamicClientHostPort` 驱动浏览器动态 Client 回路。
- `main.tsx` 启动 `ProductHostCoordinator(new HttpProductHost())`；Vite `dev` 把 `/api` proxy 到 4960（`NEKRO_API_PROXY` 可覆盖）。

### 3.3 Server 可执行入口

- `apps/server/src/bootstrap.ts` 抽成可复用 `NekroRuntime` 装配；`src/main.ts` + `dev`/`start` 脚本；`NEKRO_DATA`/`NEKRO_PORT`（默认 4960）/`NEKRO_DIST_INDEX` 环境变量；启动时创建数据目录。智能体开发工作区零配置落在 `<dataRoot>/workspaces/<agentId>/`，开启开发 Shell 或文件能力后自动创建；`NEKRO_DEVELOPMENT_WORKSPACE_ROOT` 仅作为高级宿主覆盖，仍保留智能体子目录隔离。
- Server 始终以休眠姿态挂载 DSH `dsh-llm-pi-ai`，Web 设置页通过 DSH settings/credentials 激活 provider；端点、协议、模型 catalog、推理档位和凭据引用由锁定的 DSH 版本拥有，NekroNxt 不复制第二份供应商实现。`NEKRO_LLM_PROVIDERS` 仅保留为无页面部署的可选组合层。
- `NekroRuntime` 复用持久 Web Connection，恢复 Extension save/Activation，并按持久 QQ Connection 的凭据引用重建 HTTP、Gateway、checkpoint 和 Adapter 注册；凭据目录位于主要数据目录下。
- `dsh-host-webserver`、`dsh-host-frontend-static` 提升为 `apps/server` dependencies，静态 dist 由 fallback 席位同源托管。

## 4. 完成证据

- `pnpm test` 增加针对 QQ 生产组合根的真实组装测试：经 HTTP 提交一次性 Secret，验证私有文件权限与 API/Core 不泄漏；真实 QQ Gateway/HTTP 实现只替换外部网络边界，断言入站提交、频道发现、平台发送回执与重启恢复。
- 冷启动恢复覆盖凭据文件缺失和持久引用损坏；故障只隔离到对应 QQ Connection，不阻断其他 Runtime 恢复。
- `pnpm check` / `pnpm test` / `pnpm build` 全绿。
- 术语检查通过：UI 面向用户只用「智能体」。

## 5. 当前保留的接缝

- 领域 API 只暴露稳定 ID 与不可变 Revision，不暴露内部实现；
- SSE 只推送频道事实与可观测状态，不泄漏 DSH 内部轨迹；
- 未来可把 NekroNxt 领域 API 开放为多客户端（Desktop、Server），与本地 Runtime 共用同一套 `contracts`。

## 6. 本次明确不提前实现

- 不重写 DSH 自带 `apiproxy`/Typert 的 RPC 协议；NekroNxt 领域 API 走自己的 REST/SSE 面；
- 不做多用户鉴权（Desktop/本地 Server 首版单用户）；
- 不引入 TanStack Query / Redux；业务事实只存一份于 Server，Zustand 只留 UI 本地态；
- 不做 Webhook / Process Remote / 云同步。
