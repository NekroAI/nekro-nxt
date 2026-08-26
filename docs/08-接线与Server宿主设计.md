# NekroNXT 接线与 Server 宿主设计

> 文档编号：08
> 性质：现行 Server↔Web 接线

## 1. 边界

- HTTP、SSE 和静态托管复用 DSH WebServer / frontend-static，不引入第二套 HTTP 框架；NekroNXT 在同一 WebServer 上显式注册产品 SPA 页面前缀，因为 DSH 0.1.1-rc.2 的静态 fallback 对未知路径返回 404；
- 领域 API 由 `NekroHostApi` 定义，只经过 Core、Channel Runtime、Asset 和 Extension 公开服务，不把数据库或 DSH `Context` 暴露到 wire；
- Web 不复制业务事实。`ProductHostPort.getSnapshot()` / `subscribe()` / `execute()` 消费 Server 权威投影；Zustand 只保留主题、减少动效和草稿。

## 2. 领域 API

| 方法 | 路由 | 语义 |
|---|---|---|
| 快照 | `GET /api/snapshot` | models、connectionAdapters、agents、channels、connections、extensions、dynamic、workTreeOrder；频道与智能体带 `runtimePhase`；历史按频道读取 |
| 订阅 | `GET /api/events` | SSE 数据面：`channel-fact` 带消息、`runtime` 带裁剪投影；`status` / `binding-change` / 扩展与 DSH 设置仍是信号 |
| 创建智能体 | `POST /api/agents` | 创建智能体、内置频道与默认 Binding |
| 删除智能体 | `DELETE /api/agents/:agentId` | 校验当前配置版本和名称确认；先停止全部频道运行、停用扩展并写 tombstone；默认同时 tombstone 仍归属于它的自动创建内置频道，其他频道解绑；保留历史事实和文件 |
| 新建内置频道 | `POST /api/channels` | 在系统托管内置连接上创建未绑定内置频道 |
| 删除 / 移除频道 | `DELETE /api/channels/:channelId` | 携带预期 Binding；立即停止运行、解除绑定并写 Channel tombstone，保留全部历史；外部频道不影响平台真实对象 |
| 通知设置 | `PUT /api/settings/notifications` | Core SQLite 保存系统/Bark 渠道和功能开关；Bark Device Key 只保存本机凭据引用 |
| 客户端通知 | `GET /api/client-notifications?cursor=` | 返回进程内短暂脱敏事件；无 cursor 只建立当前位置，供在线 Desktop 本地或已认证远程 Session 拉取 |
| 发送消息 | `POST /api/channels/:channelId/messages` | 仅内置频道入站 |
| 频道历史 | `GET /api/channels/:channelId/messages` | `(occurredAt, sourceId)` 游标分页；首载、翻页、重连对账 |
| 频道工作轨迹 | `GET /api/channels/:channelId/runtime` | 按频道投影 phase、当前工具、待注入、上下文占用、当前 Episode 缓存分析和最近多轮 Turn（含耗时与本步用量）；首载与重连对账 |
| 上下文操作 | `POST /api/channels/:channelId/context-reset` | 携带 `expectedEpisodeId`；`clear` 中止后无交接清空，`compact` 中止后生成 Handoff 并建立新 Episode |
| 频道资源 | `GET /api/channels/:channelId/assets/:assetId` | 校验频道访问权后同源读取 |
| 频道本地名称 | `POST /api/channels/:channelId/display-name` | 只改展示名 |
| 创建连接 | `POST /api/connections` | 按已安装 Adapter schema 创建，可选保存 80 字符以内的连接别名 |
| 修改连接别名 | `POST /api/connections/:connectionId/alias` | trim 后保存或清除非系统托管连接的别名；系统托管 Web 连接拒绝编辑 |
| 创建绑定 | `POST /api/bindings` | 智能体可多频道；一频道一个当前智能体；已绑定时为换绑 |
| 解除绑定 | `DELETE /api/bindings/:channelId` | 若该频道有活动工作则先 `stopEpisode`，再删除 Binding |
| 工作树顺序 | `PUT /api/work-tree-order` | 智能体 / 频道展示序，未知 id 丢弃，新对象追加 |
| 启用扩展 | `POST /api/agents/:agentId/extensions/:extensionId/activation` | AgentActivation |
| 停用扩展 | `DELETE /api/agents/:agentId/extensions/:extensionId/activation` | 去掉该智能体的启用关系 |
| 修改能力 | `POST /api/agents/:id/capabilities` | 六字段授权 |
| 修改配置 | `POST /api/agents/:id/revision` | 名称、人设、模型；带 expectedCurrentRevisionId |
| 查询平台用户 | `GET /api/platform-users` | 名称、Adapter、平台连接筛选与游标分页；不返回平台原始用户 ID |
| 供应商 | `GET/POST /api/llm/providers`、`discover-models`、`test-provider` | DSH settings/credentials |
| Connection 收发测试 | `POST /api/connections/:id/test` | 由已安装 Adapter Driver 执行，接收与发送分开 |
| 保存动态包 | `POST /api/extensions/save-from-dynamic` | 不自动启用 |
| 动态回路 | `POST /api/dynamic/:agentId/...` | 每次请求携带精确 `episodeId`；审批、Host half、Client 源码、渲染证据、Guard 报告与结算不猜活动 Session |
| Client Artifact | `GET /api/extensions/:extensionId/revisions/:revisionId/client/:buildKey.mjs` | 只向匹配当前 Agent Activation 的精确构建提供源码 |
| Extension RPC | `POST /api/extensions/:extensionId/revisions/:revisionId/call` | 按 `agentId + revisionId + method` 调用 Activation handler |
| Client 诊断 | `POST /api/extensions/:extensionId/revisions/:revisionId/client-diagnostic` | 保存当前 Activation 最近一次 loaded/failed；不回滚 Host |

快照含 DSH 模型目录、能力可用状态、Adapter 目录、Connection（无 Secret，含可选 alias）、通用连接状态与动态能力诊断、已绑定频道和动态 Package。连接快照不再把 `appId` 或 Gateway 当作所有平台共有字段；账号标识、实现版本和可选能力来自 Adapter 诊断。已 tombstone 的智能体和频道不进入活动快照与工作树；普通解绑频道继续存在并进入未绑定频道。外部 Adapter 再次发现同一 `(connectionId, platformChannelId)` 时清除 Channel tombstone，复用原 Channel ID 与历史。Web 侧只用 `alias ?? Adapter displayName` 作为连接主辨识名，Adapter displayName 仍作为平台身份的次要信息；频道、对象列、连接详情、智能体频道列表和绑定选择器共享同一投影。Web 搜索是否可用看 DSH 凭据，不靠环境变量名推断。

全局只有一条 `GET /api/events`。消息和工作轨迹不再用「通知后再拉 REST」作为热路径。

- `channel-fact` 携带该频道一批已投影的 `HostSnapshotMessage`（与历史接口同一形状）和该频道消息面 `revision`。同一 `sourceId` 先 planned 再 sent 时按 id 覆盖投递态。Host 对同一频道约 80ms 合并写入，并按 UTF-8 约 48 KiB 预算拆分消息批；单条消息保持原子。
- `runtime` 携带与 `GET /runtime` 相同的裁剪投影（工具预览 160 字、最近 24 轮、可选 occupancy、步骤耗时与用量）和该频道轨迹面 `revision`。占用从 DSH `sessionProjections` 的 `contextPressure` / `tokenUsage` / `contextBreakdown` 投影；缺少窗口或用量样本时省略。服务端在 100ms 合并后再组装。UTF-8 序列化超过约 48 KiB 时只推 `phase` / `summary` / `occupancy` 并标 `truncated`，前端对已打开的工作轨迹回退一次 REST。
- 可回放事件带 `Host epoch:序号` 形式的 SSE `id:`。浏览器 `EventSource` 重连自动带 `Last-Event-ID`，连接重新打开时先刷新权威快照。Host 在内存里保留最近 512 帧；同一 epoch 的窗口内帧补发，窗口外、Host 重启和未来游标都返回 `status.replay = expired`，前端对已加载频道拉一次历史或轨迹。慢客户端最多排队 512 KiB，超过预算就断开并依赖重连对账。权威事实仍是频道 Event Log 和当前 Session 投影，不是这份环形缓冲。
- `status` / `extensions-changed` / `binding-change` / DSH 设置与凭据变更仍是信号，前端刷新对应快照或进度。
- 不按频道再建 SSE，不把 `assistant/chunk` 或资源二进制推进帧。

## 3. Web 与 Server

- `apps/web/src/http-host.ts` 实现 `ProductHostPort`。`execute` 覆盖创建/删除智能体、删除频道、两种上下文操作、发消息、改能力、扩展启停、从动态保存、创建/测试连接、修改连接别名和动态审批；状态变更成功后重新读取权威快照，失败不发布前端成功状态。
- 每个智能体使用独立产品 SlotCore。Snapshot/SSE 变化驱动 Client Activation 对账；Revision 更新先 dispose 后 mount，刷新与 Server 重启按权威 Activation 恢复。只有含 Client 构建证据的 Revision 请求 Artifact，Host-only Activation 全程没有 Client 请求。
- 添加平台连接先选用户可创建的平台，再按版本化 schema 渲染表单；从某适配器详情「再添加一个账号」可跳过选平台。系统托管内置 Adapter 不出现在创建目录。
- `/api/snapshot` 只携带智能体的结构化人设文档，不承载平台用户全集。`/api/platform-users` 从持久身份与活动频道关系独立分页；Web 在 `channel-fact` 后使目录查询失效并防抖刷新。
- 外部频道未发现时说明先向机器人账号发一条消息。`POST /api/channels/:id/messages`：内置频道入站交给智能体；外部频道在已绑定且允许主动发送时，以机器人账号出站，并注入管理员从客户端发出的系统事实。
- `apps/server/src/main.ts` 使用 `NEKRO_DATA`、`NEKRO_PORT`（默认 4960）与可选 `NEKRO_MANAGEMENT_KEY`。开发工作区为 `<dataRoot>/workspaces/<agentId>/`。
- 产品 SPA 深链只覆盖 `/work`、`/agents`、`/channels`、`/creator`、`/runtime`、`/settings`、`/connections`、`/extensions` 及其子路径；GET/HEAD 返回经过 DSH index injection 的产品入口，其他方法 405。`/api` 和不存在的静态资源不进入 SPA 回退。
- 生产 CLI 由构建后的 `dist/main.mjs` 直接启动；`NEKRO_HOST` 默认 `127.0.0.1`。公开监听 `0.0.0.0` 必须设置至少 32 个字符的 `NEKRO_MANAGEMENT_KEY`，并在外部 4960 启动自动 TLS 与设备鉴权入口；DSH WebServer 只监听随机 loopback。`GET /health/live` 与 `GET /health/ready` 保持匿名，只返回状态和 Release 身份。
- Desktop 自带本地 Host 使用随机 loopback HTTP，并按 `500ms → 1s → 2s → 5s → 5s` 有界退避恢复。Desktop BrowserWindow 使用可替换 Product View：本地 Profile 指向自带 Host，远程 Profile 指向固定 SPKI 的 Server TLS 入口；每个 Profile 使用独立 partition 和最近路由。切换关闭旧 Product View，不重启任何 Host Runtime。详细安全与 View 边界见 [Desktop 多实例与设备鉴权](decisions/implemented/2026-08-23-Desktop多实例与设备鉴权.md)。
- Runtime 打开双 SQLite 前，生产入口在 `backups/release-<releaseId digest>/` 为已有数据库创建一次 Release 恢复点；失败拒绝启动。该实验恢复点不覆盖数据根文件目录，完整升级协调仍以 Client migration Decision 为准。
- 启动通过 Adapter Driver 目录恢复持久 Web、QQ OpenClaw 和 OneBot 11 Connection，再恢复处理中反馈、Channel Runtime 与 Extension Activation；单个 Connection 故障不阻断其他恢复。

一期缺口见 `04-一期开发计划与决策清单.md`。技术栈见 `decisions/accepted/2026-08-16-一期技术栈与UI基础设施.md`。
