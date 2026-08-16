# NekroNxt 接线与 Server 宿主设计

> 文档编号：08
>
> 状态：设计已确认，M6 接线实施中
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

传输：`WebServer.register` 的具名路由 + 一个 `GET /api/events` SSE 端。

| 方法 | 路由 | 语义 | 对应服务 |
|---|---|---|---|
| 快照 | `GET /api/snapshot` | 返回 agents/channels/messages/connections/extensions/approvals 权威投影 | CoreService + Runtime 查询 |
| 订阅 | `GET /api/events` (SSE) | 推送频道事件、智能体状态、扩展回执 | ChannelRuntime 出站 + 状态变化 |
| 创建智能体 | `POST /api/agents` | createAgent + ensureChannel + createBinding（自动 Web Channel） | CoreService |
| 修改能力 | `POST /api/agents/:id/capabilities` | 切换到新 AgentRevision | CoreService.reviseAgent |
| 发送消息 | `POST /api/channels/:id/messages` | 构造入站事件并经 acceptInbound 进入 Runtime | ChannelRuntime |
| 创建连接 | `POST /api/connections` | 创建 Connection（未来含 QQ 凭据引用） | CoreService +
Adapter 装配 |
| 连接测试 | `POST /api/connections/:id/test` | 触发 receive/send 测试 | Adapter + Runtime |
| 保存扩展 | `POST /api/extensions` | Draft → 本地 Extension Revision（不自动启用） | ExtensionService |
| 启用/停用 | `POST /api/extensions/:id/activation` | AgentActivation 切换（安全间隙） | ExtensionActivationCoordinator |

（实现过程中以最终代码声明的端点为准，本表为准入范围。）

### 3.2 Web 侧

- `apps/web/src` 实现 `ProductHostPort` 的真实 Host：`getSnapshot()` 用 `fetch('/api/snapshot')`，`subscribe()` 用 `EventSource('/api/events')`，`execute()` 映射到对应 POST/PATCH。
- `apps/web` 的 Vite `dev` 增加 `server.proxy`，把 `/api` 代理到 Server 端口；生产构建由 `dsh-host-frontend-static` 直接托管。

### 3.3 Server 可执行入口

- `apps/server` 新增 `src/main.ts`（或 `start.ts`）可执行入口 + `dev`/`start` 脚本；把测试内联的主装配（DB→Core→Asset→Host→ChannelRuntime→Extension）抽成 `src/bootstrap.ts` 的可复用 `NekroRuntime` 装配函数。
- 需要把 `dsh-host-webserver`、`dsh-host-frontend-static` 提升为 `apps/server` 的 dependencies，并补齐 `data/` 数据目录、`dist/` 前端产物路径约定。

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
