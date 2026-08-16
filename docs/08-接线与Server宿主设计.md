# NekroNxt 接线与 Server 宿主设计

> 文档编号：08
>
> 状态：切片1 闭环 A、切片3 扩展生命周期（实时 SSE、保存动态包、浏览器动态 client 回路）、切片2 QQ 连接配置与诊断已落地；实际浏览器中 DSH 动态 Client UI 的视觉 Slot 渲染、QQ 真实收发待真实浏览器/外部凭据
>
> 日期：2026-08-16
>
> 目标：把已有「Server 领域运行时」与「Web 产品 UI」之间的 mock 数据层替换为真实接线，满足「普通用户不用终端完成两条一期闭环」的 M6 完成标准

## 1. 背景与问题

一期 M1–M5 已形成可验证的领域运行时：`apps/server` 的 `DshHostRuntime` 组装 DSH 引擎，`CoreService`/`ChannelRuntime`/`AssetService`/Extension 体系提供智能体、会话、扩展与 QQ 能力。但存在两个未收口缺口：

1. **`apps/server` 无可执行入口**：`src/index.ts` 只导出库形态（`DshHostRuntime` 等），没有可 listen 的 server 进程，也没有 `dev`/`start` 脚本；领域主装配只存在于测试文件内联代码中。
2. **`apps/web` 数据层是 mock**：`product-store.ts` 是纯 Zustand 演示数据，所有动作只改本地内存；已定义 `ProductHostPort` 外接端口接口，但没有真实实现，也没有任何 fetch/SSE/WebSocket 调用后端。

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

Web 端不复制一份业务事实到 Zustand。`ProductHostPort.getSnapshot()` 返回 Server 权威投影；`subscribe()` 订阅 SSH 事实流（频道事件、智能体状态、扩展回执）；`execute(command, input)` 派发一次性操作（创建智能体、发送消息、创建连接、保存扩展等）。Zustand 只保留 UI 本地态（主题、减少动效、草稿）。

## 3. 接线形态

### 3.1 领域 API（`NekroHostApi`，落在 apps/server）

传输：`WebServer.register` 的具名路由 + 一个 `GET /api/events` SSE 端。已实现状态以✅/⏳标注：

| 方法 | 路由 | 语义 | 状态 |
|---|---|---|---|
| 快照 | `GET /api/snapshot` | 返回 agents/channels/messages/connections/extensions/approvals 权威投影 | ✅ |
| 订阅 | `GET /api/events` (SSE) | 推送频道 `channel-fact`（智能体回复）与 `status`；心跳保持 | ✅ |
| 创建智能体 | `POST /api/agents` | createAgent + ensureChannel + createBinding（自动 Web Channel） | ✅ |
| 发送消息 | `POST /api/channels/:id/messages` | 构造入站事件并经 acceptInbound 进入 Runtime | ✅ |
| 创建连接 | `POST /api/connections` | 创建 configured Connection；QQ 凭据只保存引用不泄 secret | ✅ |
| 启用扩展 | `POST /api/extensions/:id/activation` | AgentActivation 启用（body `{agentId, revisionId}`） | ✅ |
| 停用扩展 | `DELETE /api/extensions/:id/activation` | 停用当前 Activation（安全间隙后完成） | ✅ |
| 创建智能体引导跑动 | —— | —— | —— |
| 修改能力 | `POST /api/agents/:id/capabilities` | 按当前 Revision 生成新不可变 AgentRevision，更新 dynamicCreation/developmentShell/fullFileAccess | ✅ Server+Web 命令+store 委托 |
| QQ 收发测试 | `POST /api/connections/:id/test` | Web 连接真实收发；QQ 无真实凭据时诚实返回 `needs-credentials`（拒假成功） | ✅ 入口已接通；真实凭据收发待外部环境 |
| 保存动态包 | `POST /api/extensions/save-from-dynamic` | 把活动会话中的运行动态 Package 保存为本地 Extension Revision（不自动启用） | ✅ |
| 动态审批/调用 | `POST /api/dynamic/:agentId/{approve\|decline\|invoke\|run-host-half\|get-client-code\|settle-user-run\|report-render-failure}` | 解析智能体活动会话并调用 DshHostRuntime 动态方法（审批解析、Host half 启动、Client 源码获取、Host 方法调用、用户 run 结算、渲染失败上报） | ✅ 服务端+Web `HttpDynamicClientHost`；浏览器视觉 Slot 渲染待真实浏览器 |

`GET /api/snapshot` 现在投影：全部 `Connection`（Web + QQ，credentialRefs 只含引用）、已绑定 Agent、频道、近期频道事实、全部已保存本地扩展（含当前 AgentActivation 状态）、各智能体活动会话中运行的动态 Package（plugin/package/审批状态）。

### 3.2 Web 侧

- `apps/web/src/http-host.ts` 实现 `ProductHostPort`：`getSnapshot()` 缓存式 `fetch('/api/snapshot')`；`subscribe()` 用 `EventSource('/api/events')`（`channel-fact`/`status` 触发刷新，网络故障静默降级+自动重连）；`execute()` 映射真实命令。
- `execute` 命令表：`agents.create`、`channels.sendMessage`、`agents`（占位）、`extensions.activate`、`extensions.deactivate`、`extensions.saveFromDynamic`、`connections.create`、`connections.test`、`dynamic.approve`、`dynamic.decline`；未知命令静默返回 `null`（不崩 UI，等切片后续补齐）。
- `product-store` 的 `createAgent`/`sendMessage`/`createConnection`/`setExtensionActive`/`resolveApproval` 在有活动 Host 时委托 `execute`，无 Host 保留 demo 数据（现有 UI 测试不破）。
- 创造工作台（Creator 页）改读快照投影的真实 `dynamic`（运行动态 Package + 审批请求），`resolveApproval` 经 `dynamic.approve/decline` 派发真实审批；`HttpDynamicClientHost` 实现 `DynamicClientHostPort` 驱动浏览器动态 Client 回路。
- `main.tsx` 启动 `ProductHostCoordinator(new HttpProductHost())`；Vite `dev` 把 `/api` proxy 到 4949（`NEKRO_API_PROXY` 可覆盖）。

### 3.3 Server 可执行入口

- `apps/server/src/bootstrap.ts` 抽成可复用 `NekroRuntime` 装配；`src/main.ts` + `dev`/`start` 脚本；`NEKRO_DATA`/`NEKRO_PORT`(默认4949)/`NEKRO_DIST_INDEX` 环境变量；启动时创建数据目录。
- `dsh-host-webserver`、`dsh-host-frontend-static` 提升为 `apps/server` dependencies，静态 dist 由 fallback 席位同源托管。

## 4. 完成证据

- `pnpm test` 增加针对 `NekroHostApi` 的「真实组装」测试：真的用 `WebServer` listen，真的用 `fetch`/`EventSource` 走一遍 REST/SSE，再断言快照与频道回执。
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
