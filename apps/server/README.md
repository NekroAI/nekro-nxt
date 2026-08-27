# Server Host

该应用拥有 NekroNXT 的生产 DSH Host roster，并把 DSH Agent Loop 适配到 Channel Runtime。当前 roster 装配 Session、SQLite Persistence、System Prompt、Tool Runtime、Agent Loop、checkpoint、Session compaction、LLM retry、工具结果裁剪、工具超时、Spill、官方 in-process 子智能体、DeepSeek Web Provider、通用 pi-ai 模型路由和官方 DeepSeek 多模态路由；频道通信、历史、Asset、批量图片检查、子智能体控制、网页搜索、文件和 Shell 工具都按智能体 Revision 在根 Session Scope 注册，不照搬 DSH CLI 的全局工具面。

人设 Revision 的权威内容是 `PromptDocumentV1`。无引用时 Host 继续注入原始纯文本；存在平台用户、频道或扩展引用时，Host 解析当前可用状态，使用转义后的 `<nxt-persona-document>` 内联标记，并先注入固定引用协议。展示名称和扩展描述始终作为不可信数据，引用不扩大权限、频道访问或工具目录。

`NekroRuntime` 是生产组合根：它拥有 Core SQLite、Channel Runtime、Extension 恢复、稳定 Web Connection、本地凭据目录，以及已安装 Adapter 的连接目录与运行实例。用户创建连接先选择 Adapter，再提交该贡献声明的普通配置和只写凭据；QQ 官方机器人使用 HTTP/Gateway Runtime，OneBot 11 与企业微信智能机器人使用正向 WebSocket Runtime。Secret 只由 Host 凭据存储解析，Core 只保存引用。Gateway、Adapter 注册和诊断监听均在 dispose 时撤销并等待静止。

`DshHostRuntime` 继续只拥有 DSH Agent handle、Episode handoff、频道回复守卫、图片投影、压缩后视觉恢复和智能体作用域扩展；Adapter 和 Core 不能通过 DSH Context 互相读取数据库。应答型 Turn 第一次缺少成功的 `send_channel_message` 时通过公开 `agent/turn-stopping` 接缝在同一 Turn 提醒一次，第二次仍缺失则持久投影为 `unreplied`，不自动投递模型原始文字。频道环境说明如实告知普通模型文字不可见、同一 Turn 可多次发送，并默认建议长任务先确认再按真实阶段同步；人设和成员偏好可以减少过程消息，Host 不增加中途计时或自动进度。模型可见的入站、出站、Handoff 和历史统一使用 `logicalMessageId`，quote 只在当前频道展开一层。图片是否走原生路径只取决于 DSH 模型目录的 `inputModalities`；缺失声明按文本路径运行，不能按模型名推断。

动态创造的所有浏览器修改操作都显式携带 `episodeId`，Server 校验 Agent、Episode 和 DSH Session 的精确归属，不按智能体猜“第一个活动会话”。动态 Client 与持久 Client 只接受 NekroNXT 的 `agent.workbench.sections`、`extension.details.panels`；DSH 官方 WebUI Slot 和 `root` 会在浏览器 Guard 阶段撤回并报告给原动态 Run。含 Client 半边的 Package 必须先在产品 Slot 提交渲染证据才能保存。扩展 Revision 的验证证据保留生成证据时的实际 DSH 版本；升级不会改写或拒绝旧版本证据，新验证使用当前锁定的 rc.2。

持久 Extension Host factory 每个 Activation 执行一次并拥有 RPC；返回的 Cordis Plugin 只负责向该智能体的每个 Session 挂载 Tool Fiber。Client Artifact、Activation RPC 和最近一次加载诊断分别通过 Revision 精确路由；stale build、错误智能体和已停用 Revision 都被拒绝，Client 失败不回滚 Host Tool。

`NekroRuntime.create()` 在挂载 DSH Session Provider 前验证 `sessions.sqlite` 所有权。schema 17 正常使用；DSH 0.1.0-rc.6 的 schema 15 先以 SQLite backup 归档到 `dsh/session-archives/<UTC>-schema15/`，再以 `incompatible-session-storage` 关闭旧 Episode 并释放未完成 Admission，由 rc.2 创建全新 schema 17 会话。归档含 SHA-256、版本与原路径，未知或外部数据库拒绝启动，NekroNXT 不修改 DSH 私有表也不自动删除归档。

每个根 Session 通过常驻系统提示和 `nekro_nxt_channel_context` 获得 Host 权威的 Channel/Episode 身份；发送、历史、Asset 与该只读工具都绑定当前频道。Episode handoff 只总结该 Episode 已准入的 Channel Event 与自身 Outbound，上一份派生 handoff、频道原文和智能体旧出站分区标注；最近 12 条频道原文仍作为独立恢复窗口注入。摘要请求不设置 `maxTokens`、使用 180 秒边界，任何摘要失败都降级且不阻断 rollover。

图片策略随人设和模型进入不可变 Revision。视觉主模型按 MessagePart 顺序收到原图，同一 Surface 以 Asset `contentDigest` 去重；`asset_inspect_images` 接受 1–20 张图片、整批 `question` 和逐图 `focus`，视觉主模型直接收到 Tool Result ImageBlock，文本主模型只接收辅助视觉模型经 Schema 校验的结构化证据。辅助调用不拆批，只允许一次不重发图片的 JSON 修复，并在同一 Session 以频道、模型、有序 digest、问题和协议版本精确缓存。所有调用写 log-only terminal audit，Snapshot 检查器投影视觉驻留、重复跳过、最近检查、Token usage、恢复和阻塞项。

Compaction 使用 `NekroNxtCompactionEngine` 继承 DSH `BasicCompactionEngine`，不替换摘要算法。成功提交后从当前频道最近策略窗口恢复已离开 Surface 的不同图片；恢复消息只属于 DSH 上下文，不创建 Channel Event 或主动回复，并以 compaction ID 幂等。TokenMeter 会从最旧候选开始缩减，避免形成“压缩—恢复—再压缩”循环。DSH 请求图片版本通过 rc.2 官方 `readImageRequest` 投影器缓存在 `dataRoot/dsh/request-images/`，canonical 原件仍只属于 Asset Service。

模型供应商直接复用 DSH `dsh-llm-pi-ai`、`dsh-llm-deepseek`、`dsh-settings-file` 与 `dsh-credentials-local`：Web 设置页从 DSH 可配置供应商目录读取候选，通过 DSH settings 保存 profile，通过 DSH credentials 只写保存 API Key，并可调用 DSH 模型发现。官方 `deepseek-official` 路由始终挂载，默认目录包含明确声明图片能力的视觉模型；`NEKRO_LLM_PROVIDERS` 中同名路由会从 pi-ai 列表排除，避免双重注册。设置页“测试连接”把当前未保存的 Key、Base URL、协议与模型 Draft 交给 Server；通用 Draft 仍在隔离 Cordis Context 中挂载一次性 `LlmRuntime + dsh-llm-pi-ai` 和只读内存凭据 Provider，执行最小请求后完整 dispose，不修改 Settings、Credential 或实时 Adapter registry。页面未填写新 Key 时只在 Server 内回退当前 Credential Reference。设置和凭据持久化在主要数据目录的 `dsh/` 下，Server 重启后自动恢复；API 快照继续从实时 `ctx.llm` registry 投影模型列表，NekroNXT 不维护第二份供应商或模型目录。环境变量仅保留为无页面部署的可选组合层，不是本地产品的日常配置入口。

`GET /api/events` 直接推送频道消息和裁剪后的工作轨迹；历史与轨迹 REST 只用于首载、翻页和重连对账。可回放帧带 `id:`，内存窗口响应 `Last-Event-ID`，过期则让前端 REST 对账。接线见 `docs/08-接线与Server宿主设计.md`。

公开容器入口使用自动 TLS 与设备鉴权。`NEKRO_HOST=0.0.0.0` 必须同时设置至少 32 个字符的 `NEKRO_MANAGEMENT_KEY`；证书写入 `/data/host/tls/`，实例身份和配对设备写入 Core SQLite。除健康、实例描述和配对/设备 Session 必要端点外，产品页面、API、SSE、Asset 与 Extension Client 默认要求设备 Session；Mutation 同时校验同源与 CSRF。管理密钥只参与 HMAC proof，轮换会撤销旧设备。协议见 [Desktop 多实例与设备鉴权](../../docs/decisions/implemented/2026-08-23-Desktop多实例与设备鉴权.md)。

DSH 0.1.1-rc.2 的 `frontend-static` 只服务真实文件和明确的 index 路径，未知路径返回 404。Server 因此为 NekroNXT 的产品页面前缀显式注册 SPA index 路由；`/api` 和不存在的 Asset 仍保持各自的 JSON/404 语义，不能用全局 index 回退掩盖错误路径。

通用 DSH 配置面直接投影当前 Host：`GET /api/dsh/plugins` 返回固定生产 roster 的分能力面支持诊断，`GET /api/dsh/settings` 返回所有可安全上线的脱敏 Settings descriptor；路径级修改走 `POST /api/dsh/settings/:namespace/mutate` 并强制 `expectedRevision`，凭据只通过 `describe`、`PUT` 和 `DELETE` 端点读状态或写入/清除，响应和日志不返回值。Settings/Credentials 提交事件通过同一 SSE 通知普通表单和 DSH 原生界面失效刷新。

DSH 0.1.1-rc.2 的 `redactSecrets` 尚不能证明 union、intersect、transform、lazy 中 Secret 的线安全，序列化 schema 也可能携带 Secret default。因此 Server 在 descriptor 离开 Host 前做 fail-closed 检查：发现不受 0.1.1-rc.2 redactor 覆盖的 Secret 或 Secret default 时，不向 Web 暴露该 namespace，也拒绝通用 mutation；这不是提示词或表单层防护。待上游提供完备 `describeForWire()` 后再通过兼容 fixture 收敛此包装边界。

Loader/Profile Spike 已验证 0.1.1-rc.2 Loader 的 create/update/remove、失败激活回滚、官方 inventory 和隔离 Context；同时确认 Profile 只描述 Cordis 插件树，不携带 NekroNXT 的智能体配置版本、频道和私有 Service 授权语义。因此当前不开放用户安装/启用 DSH 包入口，固定 roster 保持不变；后续必须先补齐 Session/Preset 分层、冷启动恢复和静止关闭的完整组合证据。

`dataRoot` 是 Server 唯一数据根，生产入口会创建 `dataRoot/workspaces/`，并在智能体首次使用开发 Shell 或文件工具时自动创建私有的 `workspaces/<agentId>/`。开发 Shell 的默认 `cwd` 和文件工具的默认 `cwd` 都使用该目录；`workspace-write` 只限制写入位置，DSH 0.1.1-rc.2 的 read/grep/glob 仍能读取 Server 进程有权读取的宿主文件，因此文件工具默认关闭且界面必须如实警示读取范围。完整文件访问只把已启用文件工具或开发 Shell 的策略提升为 `danger-full-access`，不会单独提供工具，也不改变默认 `cwd`。高级部署可用 `developmentWorkspaceRoot` 或 `NEKRO_DEVELOPMENT_WORKSPACE_ROOT` 覆盖工作区根，覆盖后仍自动追加 `<agentId>`。

Spill 由 Server 自有的 DSH `SpillStore` 实现写入 `dataRoot/dsh/spill/`，单 artifact 8 MiB、单 Session 64 MiB、Host 总量 2 GiB；每次写入串行核算，重启后重新扫描现有文件。该目录是持久备份数据，不是 Asset 或 Adapter 路径身份。关闭文件工具后已有 locator 仍有效，但智能体不能自行回读，界面与模型提示会要求先重新授权文件工具。

本地开发统一运行根命令 `pnpm dev`：Web 固定监听 `http://127.0.0.1:4961` 并代理 `127.0.0.1:4960` 的 Server；端口被占用时直接失败，不静默落到另一个地址。默认数据根固定为仓库根的 `data/`，不会随 pnpm 的 package cwd 在 `apps/server/data/` 生成平行数据。workspace 库用 `tsdown --watch --no-clean` 重建，避免并行启动时暂时删除 Server 需要的包入口；Server 用 `tsx watch` 监听自身源码和各库的 `dist/*.mjs`，依赖实现变化后会优雅重启。不要分别启动一个长期不重载的 Server 进程，否则可能出现前端/路由已更新而进程内 Core 类仍是旧版本的“半新半旧”状态。`pnpm install` 或 DSH 版本族升级后必须完整重启 Web 与 Server；Vite 对 `?raw` Client bundle 的解析路径会跨普通 HMR 保留，长期进程可能继续从 pnpm store 的旧物理目录加载已不在 lockfile 中的 DSH bundle。改完会触发重载的代码后，必须确认 Web 与 Server 快照仍可访问，不能只看 watch 进程还在；规则见 `docs/06-开发与测试规范.md` §6.1。
