# NekroNXT 接线与 Server 宿主设计

> 文档编号：08
> 性质：现行 Server↔Web 接线

## 1. 边界

- HTTP、SSE 和静态托管复用 DSH WebServer / frontend-static，不引入第二套 HTTP 框架；NekroNXT 在同一 WebServer 上显式注册产品 SPA 页面前缀，因为 DSH 0.1.1-rc.2 的静态 fallback 对未知路径返回 404；
- 领域 API 由 `NekroHostApi` 定义，只经过 Core、Channel Runtime、Asset 和 Extension 公开服务，不把数据库或 DSH `Context` 暴露到 wire；
- 普通 JSON 请求体统一限制为 2 MiB，超过限制后停止缓冲并返回明确错误；Extension 分享包限制为 16 MiB，DSH tgz/分享包限制为 64 MiB，各二进制协议再执行自身的解压体积、文件数和文件大小校验；
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
| 安装/切换 Host Revision | `PUT /api/extensions/:extensionId/installation` | 幂等安装或显式更新/回滚 `host-adapter`、`host-ui` Revision；权限扩大时保留旧 Runtime |
| 卸载 Host Revision | `DELETE /api/extensions/:extensionId/installation` | 停止 Runtime 并撤销 Adapter Slot 或页面；保留连接、频道与历史 |
| Client 诊断 | `POST /api/extensions/:extensionId/revisions/:revisionId/client-diagnostic` | 保存当前 Activation 最近一次 loaded/failed；不回滚 Host |
| 删除本地扩展 | `DELETE /api/extensions/:extensionId` | 先关闭全部 Activation 或卸载 Adapter，再删除源码、版本、验证与诊断；失败时恢复原运行关系 |
| Extension 导出/导入 | `GET /api/extensions/:id/revisions/:revisionId/export`、`POST /api/extensions/imports/inspect`、`POST /api/extensions/imports/:token/commit` | 单 Revision `.nxt-extension`；两阶段检查、冲突处理、本机构建，检查凭证十分钟失效，提交后处于关闭状态 |
| Host UI 页面偏好 | `PUT /api/host-ui/page-preferences` | `expectedRevision` 原子提交完整页面顺序与显隐，冲突时以 Host 为准 |
| Host UI 页面服务 | `POST /api/host-ui/pages/:pageInstanceId/call` | 精确 owner、Artifact、权限和输入 Schema 下的产品服务、状态、事件、网络与自定义 RPC |
| Host UI 页面诊断 | `POST /api/host-ui/pages/:pageInstanceId/diagnostic` | 记录 Client、导航或 RPC 故障，不改变 Installation/Activation 事实 |
| DSH 安装检查/提交 | `POST /api/dsh/plugin-installs/inspect`、`POST /api/dsh/plugin-installs` | 精确 npm 版本、tgz 或分享包；脚本逐依赖批准，原子提交后处于关闭状态 |
| DSH 入口配置/启停 | `POST /api/dsh/plugin-entries/:entryId/config/inspect`、`PUT/DELETE /api/dsh/plugin-entries/:entryId/activation` | Config Schema 或高级 JSON；用户确认 Host/智能体作用域，Loader 成功后提交 Activation |
| DSH 导出/移除 | `GET/DELETE /api/dsh/plugin-installs/:packageId[/export]` | 导出根 tgz 与锁元数据；移除先静止关闭全部入口，任一失败不删除包 |

快照含 DSH 模型目录、能力可用状态、Adapter 目录、Connection（无 Secret，含可选 alias）、通用连接状态与动态能力诊断、已绑定频道和动态 Package。连接快照不再把 `appId` 或 Gateway 当作所有平台共有字段；账号标识、实现版本和可选能力来自 Adapter 诊断。已 tombstone 的智能体和频道不进入活动快照与工作树；普通解绑频道继续存在并进入未绑定频道。外部 Adapter 再次发现同一 `(connectionId, platformChannelId)` 时清除 Channel tombstone，复用原 Channel ID 与历史。Web 侧只用 `alias ?? Adapter displayName` 作为连接主辨识名，Adapter displayName 仍作为平台身份的次要信息；频道、对象列、连接详情、智能体频道列表和绑定选择器共享同一投影。Web 搜索是否可用看 DSH 凭据，不靠环境变量名推断。

全局只有一条 `GET /api/events`。消息和工作轨迹不再用「通知后再拉 REST」作为热路径。

- `channel-fact` 携带该频道一批已投影的 `HostSnapshotMessage`（与历史接口同一形状）和该频道消息面 `revision`。同一 `sourceId` 先 planned 再 sent 时按 id 覆盖投递态。Host 对同一频道约 80ms 合并写入，并按 UTF-8 约 48 KiB 预算拆分消息批；单条消息保持原子。
- `runtime` 携带与 `GET /runtime` 相同的裁剪投影（工具预览 160 字、最近 24 轮、可选 occupancy、步骤耗时与用量）和该频道轨迹面 `revision`。占用从 DSH `sessionProjections` 的 `contextPressure` / `tokenUsage` / `contextBreakdown` 投影；缺少窗口或用量样本时省略。服务端在 100ms 合并后再组装。UTF-8 序列化超过约 48 KiB 时只推 `phase` / `summary` / `occupancy` 并标 `truncated`，前端对已打开的工作轨迹回退一次 REST。
- 可回放事件带 `Host epoch:序号` 形式的 SSE `id:`。Web 的共享 `HostEventStream` 先保留浏览器原生重连，使普通网络短断继续自动携带 `Last-Event-ID`；`EventSource` 进入永久关闭状态时按 1、2、4、8、16、30 秒上限退避重建，原生重连超过 5 秒未恢复时也由应用层重建。浏览器重新联网和用户点击「重新连接」会立即重建同一条共享流。连接每次重新打开都刷新权威快照，并对已加载频道重新读取历史与轨迹，因此代理返回 5xx、Host 重启或重建对象丢失浏览器内部游标时也不会留下数据缺口。Host 在内存里保留最近 512 帧；同一 epoch 的窗口内帧补发，窗口外、Host 重启和未来游标都返回 `status.replay = expired`，前端再次执行相同对账。慢客户端最多排队 512 KiB，超过预算就断开并依赖重连对账。权威事实仍是频道 Event Log 和当前 Session 投影，不是这份环形缓冲。
- `status` / `extensions-changed` / `binding-change` / DSH 设置与凭据变更仍是信号，前端刷新对应快照或进度。`dsh-plugin-operation` 使用进程内 Operation ID 报告下载、依赖、构建脚本、校验和提交阶段；进程重启后未提交操作视为中断，staging 在启动时清理。
- 不按频道再建 SSE，不把 `assistant/chunk` 或资源二进制推进帧。

## 3. Web 与 Server

- `apps/web/src/http-host.ts` 实现 `ProductHostPort`。`apps/web/src/host-event-stream.ts` 是浏览器 SSE 的唯一生命周期所有者，产品快照、DSH 设置和动态 Client 只订阅这条共享流，不各自建立连接。`execute` 覆盖创建/删除智能体、删除频道、两种上下文操作、发消息、改能力、扩展启停、从动态保存、创建/测试连接、修改连接别名和动态审批；状态变更成功后重新读取权威快照，失败不发布前端成功状态；`host.refresh` 同时重建共享流和读取快照。
- 每个智能体使用独立产品 SlotCore。Snapshot/SSE 变化驱动 Client Activation 对账；Revision 更新先 dispose 后 mount，刷新与 Server 重启按权威 Activation 恢复。Host Adapter Client 使用独立全局 Runtime，加载当前已安装 Revision 的 Artifact，并接受 Catalog 中的富消息、连接和频道检查器 Slot。Host UI Client 使用第三个独立 Runtime，按 Client Artifact 共享模块实例，每个页面拥有独立错误边界、滚动根和声明式导航 Provider；三类 Registry 不互相注册。
- Host UI 页面路由固定为 `/apps/:pageInstanceId/*`。Web 使用快照中的 `routeBase`，入口隐藏、Activation 关闭或 Extension 删除后跳转到其他可见扩展页面；没有可见页面时进入对应 Extension 或 DSH 详情。系统图标组和底部工具组不参与扩展排序。
- 添加平台连接先选用户可创建的平台，再按版本化 schema 渲染表单；从某适配器详情「再添加一个账号」可跳过选平台。系统托管内置 Adapter 不出现在创建目录。
- `/api/snapshot` 只携带智能体的结构化人设文档，不承载平台用户全集。`/api/platform-users` 从持久身份与活动频道关系独立分页；Web 在 `channel-fact` 后使目录查询失效并防抖刷新。
- 外部频道未发现时说明先向机器人账号发一条消息。`POST /api/channels/:id/messages`：内置频道入站交给智能体；外部频道在已绑定且允许主动发送时，以机器人账号出站，并注入管理员从客户端发出的系统事实。
- `apps/server/src/main.ts` 使用 `NEKRO_DATA`、`NEKRO_PORT`（默认 4960）与可选 `NEKRO_MANAGEMENT_KEY`。开发工作区为 `<dataRoot>/workspaces/<agentId>/`。
- 产品 SPA 深链覆盖 `/work`、`/agents`、`/channels`、`/creator`、`/runtime`、`/settings`、`/connections`、`/extensions`、`/apps` 及其子路径；GET/HEAD 返回经过 DSH index injection 的产品入口，其他方法 405。`/api` 和不存在的静态资源不进入 SPA 回退。
- 生产 CLI 由构建后的 `dist/main.mjs` 直接启动；`NEKRO_HOST` 默认 `127.0.0.1`。公开监听 `0.0.0.0` 必须设置至少 32 个字符的 `NEKRO_MANAGEMENT_KEY`，并在外部 4960 启动自动 TLS 与设备鉴权入口；DSH WebServer 只监听随机 loopback。`GET /health/live` 与 `GET /health/ready` 保持匿名，只返回状态和 Release 身份。
- Desktop 自带本地 Host 使用随机 loopback HTTP，并按 `500ms → 1s → 2s → 5s → 5s` 有界退避恢复。Desktop BrowserWindow 使用可替换 Product View：本地 Profile 指向自带 Host，远程 Profile 指向固定 SPKI 的 Server TLS 入口；每个 Profile 使用独立 partition 和最近路由。切换关闭旧 Product View，不重启任何 Host Runtime。详细安全与 View 边界见 [Desktop 多实例与设备鉴权](decisions/implemented/2026-08-23-Desktop多实例与设备鉴权.md)。
- 生产入口在开放 HTTP 前通过共享 `HostUpgradeCoordinator` 获取 `backups/upgrade.lock`，执行数据根与 SQLite preflight，创建 `backups/release-<releaseId digest>/` 恢复点，再按 `storage-owners-open-v1`、`runtime-recovery-v1` 两个幂等步骤打开各格式所有者并完成冷启动恢复。每个 Release 的 `upgrade-<releaseId digest>.json` 记录尝试、完成或失败摘要；任一步失败进入 `recovery`、释放锁并拒绝上线。当前恢复点仍只覆盖双 SQLite，不代表完整数据根已经可恢复。
- 启动先注册内置 Adapter Contribution，再恢复 `host_extension_installations`，随后按统一 Registry 恢复全部 Connection、处理中反馈、Channel Runtime 与 Agent Activation。单个 Connection 网络或凭据故障不阻断 Installation 或其他 Connection 恢复。

一期缺口见 `04-一期开发计划与决策清单.md`。技术栈见 `decisions/accepted/2026-08-16-一期技术栈与UI基础设施.md`。
