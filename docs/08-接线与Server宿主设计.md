# NekroNxt 接线与 Server 宿主设计

> 文档编号：08
> 性质：现行 Server↔Web 接线

## 1. 边界

- HTTP、SSE 和静态托管复用 DSH WebServer / frontend-static，不引入第二套 HTTP 框架；
- 领域 API 由 `NekroHostApi` 定义，只经过 Core、Channel Runtime、Asset 和 Extension 公开服务，不把数据库或 DSH `Context` 暴露到 wire；
- Web 不复制业务事实。`ProductHostPort.getSnapshot()` / `subscribe()` / `execute()` 消费 Server 权威投影；Zustand 只保留主题、减少动效和草稿。

## 2. 领域 API

| 方法 | 路由 | 语义 |
|---|---|---|
| 快照 | `GET /api/snapshot` | models、connectionAdapters、agents、channels、connections、extensions、dynamic、workTreeOrder；频道与智能体带 `runtimePhase`；历史按频道读取 |
| 订阅 | `GET /api/events` | SSE：`channel-fact`、`runtime`、`status`、`binding-change` |
| 创建智能体 | `POST /api/agents` | 创建智能体、Web Channel 与默认 Binding |
| 新建网页频道 | `POST /api/channels` | 在系统托管网页连接上创建未绑定网页频道 |
| 发送消息 | `POST /api/channels/:channelId/messages` | 仅网页频道入站 |
| 频道历史 | `GET /api/channels/:channelId/messages` | `(occurredAt, sourceId)` 游标分页 |
| 频道工作轨迹 | `GET /api/channels/:channelId/runtime` | 按频道投影 phase、当前工具、待注入和最近多轮 Turn |
| 频道资源 | `GET /api/channels/:channelId/assets/:assetId` | 校验频道访问权后同源读取 |
| 频道本地名称 | `POST /api/channels/:channelId/display-name` | 只改展示名 |
| 创建连接 | `POST /api/connections` | 按已安装 Adapter schema 创建 |
| 创建绑定 | `POST /api/bindings` | 智能体可多频道；一频道一个当前智能体；已绑定时为换绑 |
| 解除绑定 | `DELETE /api/bindings/:channelId` | 若该频道有活动工作则先 `stopEpisode`，再删除 Binding |
| 工作树顺序 | `PUT /api/work-tree-order` | 智能体 / 频道展示序，未知 id 丢弃，新对象追加 |
| 启用扩展 | `POST /api/agents/:agentId/extensions/:extensionId/activation` | AgentActivation |
| 停用扩展 | `DELETE /api/agents/:agentId/extensions/:extensionId/activation` | 去掉该智能体的启用关系 |
| 修改能力 | `POST /api/agents/:id/capabilities` | 六字段授权 |
| 修改配置 | `POST /api/agents/:id/revision` | 名称、人设、模型；带 expectedCurrentRevisionId |
| 供应商 | `GET/POST /api/llm/providers`、`discover-models`、`test-provider` | DSH settings/credentials |
| QQ 收发测试 | `POST /api/connections/:id/test` | 接收与发送分开 |
| 保存动态包 | `POST /api/extensions/save-from-dynamic` | 不自动启用 |
| 动态回路 | `POST /api/dynamic/:agentId/...` | 审批、Host half、Client 源码、结算 |

快照含 DSH 模型目录、能力可用状态、Adapter 目录、Connection（无 Secret）、Gateway、已绑定频道和动态 Package。Web 搜索是否可用看 DSH 凭据，不靠环境变量名推断。

## 3. Web 与 Server

- `apps/web/src/http-host.ts` 实现 `ProductHostPort`。`execute` 覆盖创建智能体、发消息、改能力、扩展启停、从动态保存、创建/测试连接、动态审批。
- 添加连接先选用户可创建的平台，再按版本化 schema 渲染表单；系统托管 Web 不出现在创建目录。
- 外部频道未发现时说明先向机器人账号发一条消息。网页 Composer 只作为网页频道入站；外部频道不能从网页发言。
- `apps/server/src/main.ts` 使用 `NEKRO_DATA`、`NEKRO_PORT`（默认 4960）。开发工作区为 `<dataRoot>/workspaces/<agentId>/`。
- 启动恢复持久 Web Connection、Extension Activation 和 QQ Connection 的凭据引用；单个 Connection 故障不阻断其他恢复。

一期缺口见 `04-一期开发计划与决策清单.md`。技术栈见 `decisions/accepted/2026-08-16-一期技术栈与UI基础设施.md`。
