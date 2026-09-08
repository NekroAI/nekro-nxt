# Server Host

该应用拥有 NekroNXT 的生产 DSH Host roster，并把 DSH Agent Loop 适配到 Channel Runtime。当前 roster 装配 Session、SQLite Persistence、System Prompt、Tool Runtime、Agent Loop、checkpoint、Session compaction、LLM retry、工具结果裁剪、工具超时、Spill、官方 in-process 子智能体、DeepSeek Web Provider、通用 pi-ai 模型路由和官方 DeepSeek 多模态路由；频道通信、历史、Asset、批量图片检查、子智能体控制、网页搜索、文件和 Shell 工具都按智能体 Revision 在根 Session Scope 注册，不照搬 DSH CLI 的全局工具面。Host 使用 DSH 公开 Scope 父链让 foreground/continuable child 加入精确父 Scope；child 自动继承父 Revision 的非沟通工具，频道发送、结束回应义务、撤回、戳一戳和子智能体协调仍由根 Session 独占。

Session 身份、固定 Revision、频道、Episode 与可选运行资源由 `SessionRegistry` 的同一记录持有。`SessionRuntimeProjection` 读取该记录并拥有运行状态订阅、频道通知合并与计时器释放；`HostModelSettings` 通过 DSH 公开服务处理模型目录、配置、凭据和隔离连接测试。`PersistentExtensionMounts` 拥有持久扩展工厂、Session 挂载和 RPC 注册；同一版本初始化互斥，关闭等待进行中的初始化和卸载，释放失败向调用方上报。创造任务批准、停止的并发检查和状态提交由共享 `DynamicAuthoringService` 执行；HTTP 仅解析契约、调用宿主入口并投影结果，服务的提交通知供各入口共同订阅。`SessionImageContext` 负责图片投影、驻留诊断和压缩后恢复，共用同一 Session 注册表；附件读取继续核对频道访问范围。`DshHostRuntime` 保留对外适配入口，固定包版本与内置设置所有者来自 `dsh-roster.ts`。

`DynamicAuthoringRuntime` 拥有动态候选续接与审批订阅；`AuthoringApplicationService` 协调验证、保存及任务提交，并在关闭时等待保存结束。`HostQueries` 批量读取快照关联事实，HTTP 按创造、连接、扩展、设置和工作区注册路由；共享契约读取与错误响应由 `host-route-support.ts` 提供。

人设 Revision 的权威内容是 `PromptDocumentV1`。无引用时 Host 继续注入原始纯文本；存在平台用户、频道或扩展引用时，Host 解析当前可用状态，使用转义后的 `<nxt-persona-document>` 内联标记，并先注入固定引用协议。展示名称和扩展描述始终作为不可信数据，引用不扩大权限、频道访问或工具目录。

`NekroRuntime` 是生产组合根：它拥有 Core SQLite、Channel Runtime、Extension 恢复、本地凭据目录、统一 `AdapterRegistry`、Connection Runtime Map 和 `HostExtensionInstallationCoordinator`。第一方 Adapter 只从 `@nekro-nxt/adapter-builtin-roster` 的贡献集合注册；Server 不导入、比较或投影任何具体 Adapter 名称、key 和协议字段。内置与动态安装 Revision 走同一创建、恢复、测试和停止路径；Secret 只由 Host 凭据存储解析，Core 只保存引用。系统单例内置频道通过 Descriptor 的 `internal` kind 和 Runtime 的 `localChannel` 自动发现。Adapter Revision 切换会暂停该 key 的新入站，等待关联 Session 进入安全间隙，再停止全部 Connection Runtime；任一 `stop()` 失败会聚合上抛并恢复已停止的连接，不提交安装变化。启动顺序是内置 Registry → Host Installation → Connection → Agent Activation，关闭时反向撤销并等待静止。

频道活动设置分两层：具体 Connection 保存默认开启列表，Binding 保存按频道的布尔覆盖；Channel Runtime 每次触发和恢复时重新解析最终值。用户 Connection 删除前先停止相关 Channel lane 与 Adapter Runtime；保留频道数据时归档原 Connection 供明确恢复，选择同时删除时再清理 Connection 范围内的频道和运行事实。系统单例不进入删除流程。

Host 分别接收 Channel Inbound 和 Connection Inbound。两条入口都按 Connection 所属 Registry 贡献验证 Adapter、活动 scope 和 Channel kind；失败时拒绝提交并发布诊断。Connection Event 通过 `/api/connections/:connectionId/events` 分页和 `connection-fact` SSE 投影，只进入连接详情，不进入 Channel Runtime、Episode 或智能体上下文。Snapshot 透传完整 Descriptor 与每个 Runtime 的活动能力，Web 不依赖 Server 维护全局活动表。

Host Adapter 产物先在候选 Registry 执行 factory，实际 key、API 版本和 descriptor digest 与验证证据一致后才进入产品 Registry。安装、更新、回滚和卸载通过 `/api/extensions/:extensionId/installation` 提交；网络不通或凭据失效形成 Connection 诊断。全局 Adapter Client Runtime 接受 Catalog 声明的富消息、连接创建/状态/测试和频道检查器 Slot；富消息 id 使用 `<adapterKey>:<kind>`，其他 Adapter Slot id 等于 `adapterKey`。带 `host-page` 的 Adapter Revision 同时进入 Host UI 页面目录。

`DshHostRuntime` 继续只拥有 DSH Agent handle、Episode handoff、频道回复守卫、图片投影、压缩后视觉恢复和智能体作用域扩展；Adapter 和 Core 不能通过 DSH Context 互相读取数据库。应答型 Turn 第一次缺少成功的 `send_channel_message` 时通过公开 `agent/turn-stopping` 接缝在同一 Turn 提醒一次，第二次仍缺失则持久投影为 `unreplied`，不自动投递模型原始文字。根频道环境说明如实告知普通模型文字不可见、同一 Turn 可多次发送，并建议把高噪声工作委派但不强制路由；child 继承完整人设和频道背景，只通过普通最终输出或 `report` 回报父级，不读取父 transcript。人设和成员偏好可以减少过程消息，Host 不增加中途计时或自动进度。模型可见的入站、出站、Handoff 和历史统一使用 `logicalMessageId`，quote 只在当前频道展开一层。图片是否走原生路径只取决于 DSH 模型目录的 `inputModalities`；缺失声明按文本路径运行，不能按模型名推断。

动态创造以持久 Authoring Task/Attempt/Event 账本拥有用户任务，DSH Plugin/Package/Run ID 只是当前进程的临时执行身份。根 Session 的所有直接 child 可以调用同一个 Runner；Cordis owner 在入口按公开 Session Header、在线根 Agent、Channel、Episode 和不可变 Revision 规范化到根 Session，另一棵树、孙级和陈旧调用拒绝。`nekro_nxt_extension_define` 在 DSH Define 前接收并预检源码、页面、权限和 CSS/SVG 资源；旧 `cordis_define` 继续兼容不带这些元数据的普通动态包。专属页面必须同时注入 `pages` 和 `ui`；Inspect 与开发上下文提供版本化 `nxt-host-ui-design-v1` 责任契约，明确 Host 拥有背景、外边距和根滚动。浏览器从真实 DOM 上报 UI Kit 组件清单及页面 Insets、内容轴、标题区分和横向溢出，Server 逐入口复核；默认交互控件、裸表格、缺少标准页面框或几何证据会被 Client Guard 拒绝。普通智能体首次确认后，风险摘要不变的同任务修订自动运行；`dynamicClientApprovalPolicy: automatic` 对风险扩大也保持完全自动。审批、验证、Authoring continuation 和最终运行结果仍归根 Episode，并通过安全间隙注入根 Session。冷启动从 `workspaces/<agentId>/authoring/` 重建 Runner 临时身份和原启用意图，不能恢复时写 `interrupted`。

Task 的候选可以在智能体收尾前短暂进入 `ready`。Task 身份保存会先等待该 Session 的 Authoring continuation 和 Agent Loop 全部静止，再重新核对最新 Attempt；期间出现新候选时拒绝保存旧 Attempt。这个等待只保护 Task/Attempt 精确保存，不把动态运行、保存 Revision 和安装/启用合并成一个提交点。

智能体、Adapter 与 Host Page 使用共享 Catalog 中彼此隔离的名称集合；未知名称、错误 key 和跨作用域混装会被拒绝。含 Client 半边的候选必须在产品 Slot 或创造工作台页面画布中真实渲染，实际页面和权限必须与 Define 时的风险声明完全一致；Host-only 候选也必须完成真实 Tool/RPC 调用。验证成功后 Task 才进入 `ready`。保存 API 优先使用 `taskId + attemptId`，只接受当前最后一个已验证候选；旧 `agentId + episodeId + pluginId + packageId` 暂时保留兼容。页面证据包含入口、对象列、权限和资源，Adapter 验证还覆盖注册、启动、入站、出站、凭据隔离、WebSocket/HTTP/状态存储和停止静止。扩展 Revision 的验证证据保留生成证据时的实际 DSH 版本；升级不会改写或拒绝旧版本证据，新验证使用当前锁定的 rc.2。

Host UI 页面由独立 Runtime 承载。页面实例、显隐、跨扩展顺序和权限批准来自 Host 快照；Server 为精确 Artifact 提供页面 Client/CSS/SVG、类型化产品服务、扩展命名空间状态、事件订阅和受控网络请求。网络请求逐跳校验获准 origin，并把已验证的公网地址固定到实际 socket，阻断私网、loopback、链路本地和 DNS 重绑定。Credential 明文不进入 SQLite，也不返回 Client；`credentials.write` 生成五分钟、owner 与 Adapter 绑定的一次性 token。Client 加载失败写页面诊断，不撤销已成功的 Host Installation 或 DSH Loader Activation。

持久 Extension Host factory 每个 Activation 执行一次并拥有 RPC；返回的 Cordis Plugin 只负责向该智能体的每个 Session 挂载 Tool Fiber。Client Artifact、Activation RPC 和最近一次加载诊断分别通过 Revision 精确路由；stale build、错误智能体和已停用 Revision 都被拒绝，Client 失败不回滚 Host Tool。

生产入口在创建 `NekroRuntime` 前通过共享 `HostUpgradeCoordinator` 获取 `backups/upgrade.lock`，完成 preflight 和 Release 双 SQLite 备份，再以持久 journal 记录存储所有者打开与 Runtime 冷启动恢复；任一步失败都进入 `recovery` 并阻止 HTTP 就绪。`NekroRuntime.create()` 在挂载 DSH Session Provider 前验证 `sessions.sqlite` 所有权。schema 17 正常使用；DSH 0.1.0-rc.6 的 schema 15 先归档到 `dsh/session-archives/<UTC>-schema15/`。归档前检查 application id 并执行 WAL checkpoint，SQLite backup 完成后校验快照 `quick_check`，发布成功才退休旧库。归档的 `manifest.json` 含 SHA-256、版本与原路径；未知 schema、外部 application id 和非空未版本化库拒绝启动，不修改 DSH 私有表。管理员确认新版本稳定后可转移或清理归档，系统不自动删除。

归档成功后，Core 在同一事务中以 `incompatible-session-storage` 关闭全部 opening/active Episode，释放其 pending/claimed Admission；尚未写入旧 Session 的 Channel Event 可在下一条消息到来时进入新 Episode，由 rc.2 创建 schema 17 会话。已写入旧 Session 的频道事实、智能体 Revision、Binding、Asset 和 Extension Activation 均保留。

每个根 Session 通过常驻系统提示和 `nekro_nxt_channel_context` 获得 Host 权威的 Channel/Episode 身份；发送、历史、Asset 与该只读工具都绑定当前频道。Episode handoff 只总结该 Episode 已准入的 Channel Event 与自身 Outbound，上一份派生 handoff、频道原文和智能体旧出站分区标注；最近 12 条频道原文仍作为独立恢复窗口注入。摘要请求不设置 `maxTokens`、使用 180 秒边界，任何摘要失败都降级且不阻断 rollover。

图片策略随人设和模型进入不可变 Revision。视觉主模型按 MessagePart 顺序收到原图，同一 Surface 以 Asset `contentDigest` 去重；`asset_inspect_images` 接受 1–20 张图片、整批 `question` 和逐图 `focus`，视觉主模型直接收到 Tool Result ImageBlock，文本主模型只接收辅助视觉模型经 Schema 校验的结构化证据。辅助调用不拆批，只允许一次不重发图片的 JSON 修复，并在同一 Session 以频道、模型、有序 digest、问题和协议版本精确缓存。所有调用写 log-only terminal audit，Snapshot 检查器投影视觉驻留、重复跳过、最近检查、Token usage、恢复和阻塞项。

Compaction 使用 `NekroNxtCompactionEngine` 继承 DSH `BasicCompactionEngine`，不替换摘要算法。成功提交后从当前频道最近策略窗口恢复已离开 Surface 的不同图片；恢复消息只属于 DSH 上下文，不创建 Channel Event 或主动回复，并以 compaction ID 幂等。TokenMeter 会从最旧候选开始缩减，避免形成“压缩—恢复—再压缩”循环。DSH 请求图片版本通过 rc.2 官方 `readImageRequest` 投影器缓存在 `dataRoot/dsh/request-images/`，canonical 原件仍只属于 Asset Service。

模型供应商直接复用 DSH `dsh-llm-pi-ai`、`dsh-llm-deepseek`、`dsh-settings-file` 与 `dsh-credentials-local`：Web 设置页从 DSH 可配置供应商目录读取候选，通过 DSH settings 保存 profile，通过 DSH credentials 只写保存 API Key，并可调用 DSH 模型发现。官方 `deepseek-official` 路由始终挂载，默认目录包含明确声明图片能力的视觉模型；`NEKRO_LLM_PROVIDERS` 中同名路由会从 pi-ai 列表排除，避免双重注册。设置页“测试连接”把当前未保存的 Key、Base URL、协议与模型 Draft 交给 Server；通用 Draft 仍在隔离 Cordis Context 中挂载一次性 `LlmRuntime + dsh-llm-pi-ai` 和只读内存凭据 Provider，执行最小请求后完整 dispose，不修改 Settings、Credential 或实时 Adapter registry。页面未填写新 Key 时只在 Server 内回退当前 Credential Reference。设置和凭据持久化在主要数据目录的 `dsh/` 下，Server 重启后自动恢复；API 快照继续从实时 `ctx.llm` registry 投影模型列表，NekroNXT 不维护第二份供应商或模型目录。环境变量仅保留为无页面部署的可选组合层，不是本地产品的日常配置入口。

`GET /api/events` 直接推送频道消息和裁剪后的工作轨迹；历史与轨迹 REST 只用于首载、翻页和重连对账。可回放帧带 `id:`，内存窗口响应 `Last-Event-ID`，过期则让前端 REST 对账。接线见 `docs/08-接线与Server宿主设计.md`。

公开容器入口使用自动 TLS 与设备鉴权。`NEKRO_HOST=0.0.0.0` 必须同时设置至少 32 个字符的 `NEKRO_MANAGEMENT_KEY`；证书写入 `/data/host/tls/`，实例身份和配对设备写入 Core SQLite。除健康、实例描述和配对/设备 Session 必要端点外，产品页面、API、SSE、Asset 与 Extension Client 默认要求设备 Session；Mutation 同时校验同源与 CSRF。管理密钥只参与 HMAC proof，轮换会撤销旧设备。协议见 [Desktop 多实例与设备鉴权](../../docs/decisions/implemented/2026-08-23-Desktop多实例与设备鉴权.md)。

DSH 0.1.1-rc.2 的 `frontend-static` 只服务真实文件和明确的 index 路径，未知路径返回 404。Server 因此为 NekroNXT 的产品页面前缀显式注册 SPA index 路由；`/api` 和不存在的 Asset 仍保持各自的 JSON/404 语义，不能用全局 index 回退掩盖错误路径。

通用 DSH 配置面直接投影当前 Host：`GET /api/dsh/plugins` 返回固定生产 roster 的包身份、版本、来源和实时 Settings namespace，内置包不按运行验收或外部服务结果评级；`GET /api/dsh/settings` 返回所有可安全上线的脱敏 Settings descriptor。`agent-loop` 与 `shell` 等运行时 namespace 归入实际内置包，未知运行时注册项作为其他扩展显示。路径级修改走 `POST /api/dsh/settings/:namespace/mutate` 并强制 `expectedRevision`，凭据只通过 `describe`、`PUT` 和 `DELETE` 端点读状态或写入/清除，响应和日志不返回值。Settings/Credentials 提交事件通过同一 SSE 通知产品中的通用配置表单刷新；DSH 原生 WebUI 不接入。

DSH 0.1.1-rc.2 的 `redactSecrets` 尚不能证明 union、intersect、transform、lazy 中 Secret 的线安全，序列化 schema 也可能携带 Secret default。因此 Server 在 descriptor 离开 Host 前做 fail-closed 检查：发现不受 0.1.1-rc.2 redactor 覆盖的 Secret 或 Secret default 时，不向 Web 暴露该 namespace，也拒绝通用 mutation；这不是提示词或表单层防护。待上游提供完备 `describeForWire()` 后再通过兼容 fixture 收敛此包装边界。

用户 DSH 插件使用独立受管项目安装到 `dsh/plugin-packages/<packageInstallId>/project/`，每个精确版本拥有自己的 lockfile 和 `node_modules`。Server 通过随应用交付的固定 pnpm CLI 和 `process.execPath` 安装，不调用 shell，也不依赖系统 Node/pnpm。安装先使用 `--ignore-scripts`，只有 pnpm 实际报告且静态检查确认的 blocked build 才要求逐项批准；批准绑定精确插件版本和 lockfile 摘要。检查必须证明每个 Bundle 入口能从受管项目解析为普通文件，凭证十分钟失效并清理 staging。staging 校验成功后原子提交；进程重启清理未提交 staging，并把数据库没有对应安装事实的正式目录移入 `plugin-trash/`，不直接删除可能可恢复的包。

生产 `DshHostRuntime` 同时拥有 Host Loader、常驻 Agent Probe Loader 和每个智能体 Session 的 Agent Loader。普通入口同一时刻只能使用一种作用域；Bundle 使用公开 `composeEntries()` 展开后逐入口配置。Loader 的 create/update/remove、`await()` 和官方 Inventory 决定真实结果；智能体作用域变更先等待目标 Session 空闲。Config、Activation、NXT 权限和页面目录只在全部目标 Loader 成功后以一个 SQLite 事务提交，失败时恢复旧挂载。冷启动按入口隔离恢复，坏插件写 `restore-failed` 但不阻止智能体 Session 和其他插件；无存活 Session 的候选通过常驻 Probe 验证，不销毁根 Context Service。移除先关闭包下所有 Activation，任何 dispose 失败都会恢复已卸载 Loader 并保留安装记录和目录。

DSH Settings 使用现有路径级 mutate 与 Credentials；普通 Cordis Config 优先序列化 Schema 表单，没有 Schema 时提供高级 JSON。Secret/credential-ref Config 拒绝持久化。DSH 原生 WebUI 不接入产品，`dsh.client` 只形成“原生界面未接入”提示。安装检查与提交使用进程内 Operation ID，通过 SSE 报告下载、依赖、构建脚本、校验和原子提交阶段。

## 数据根与恢复边界

生产容器使用 `/data`，本地由 `NEKRO_DATA` 或宿主参数指定数据根。组合根当前管理 `core.sqlite`、`sessions.sqlite`、`assets/`、`credentials/`、`dsh/`、`extension-data/`、`extension-cache/`、`workspaces/`、`backups/` 和公开入口的 `host/tls/`。Core 与 DSH 分别拥有数据库格式；Asset Service、本地凭据存储、DSH 服务、Extension Runtime、工作区和 Host 升级/安全入口各自拥有对应目录。`extension-cache/` 与 `dsh/request-images/` 可重建；扩展源码、Spill、工作区和凭据是持久数据，不能按缓存清理。

SQLite 的 `-wal`、`-shm` 是运行期伴生文件，不是独立数据分区，不得手工移动或删除。`backups/` 中的 Release 恢复点当前只覆盖双 SQLite；完整备份与恢复操作见[升级、备份与恢复](../../docs/guide/upgrade-backup.md)。扩大自动恢复覆盖面时，必须同时定义资源、凭据、扩展源码、Spill 和工作区的恢复顺序、空间预算与崩溃 fixture。

新增顶层项必须记录唯一所有者、当前消费者及持久/缓存和恢复语义；现有布局归并需作为有迁移、备份与恢复验证的独立任务，不能随局部功能静默搬移用户数据。测试使用临时根或本地专用分区，不写常驻 `data/`。`data/` 及其中的工作区副本不属于产品源码，ESLint、Prettier 和类型检查 include 必须排除；公开边界检查禁止 Git 跟踪该目录，不把未跟踪运行产物按产品源码扫描。

`dataRoot` 是 Server 唯一数据根，生产入口会创建 `dataRoot/workspaces/`，并在智能体首次使用开发 Shell 或文件工具时自动创建私有的 `workspaces/<agentId>/`。开发 Shell 的默认 `cwd` 和文件工具的默认 `cwd` 都使用该目录；`workspace-write` 只限制写入位置，DSH 0.1.1-rc.2 的 read/grep/glob 仍能读取 Server 进程有权读取的宿主文件，因此文件工具默认关闭且界面必须如实警示读取范围。完整文件访问只把已启用文件工具或开发 Shell 的策略提升为 `danger-full-access`，不会单独提供工具，也不改变默认 `cwd`。Host 的 Authoring Attempt 源码固定写入 `workspaces/<agentId>/authoring/<taskId>/attempts/<attemptId>/`，按需创建私有目录；这项 Host 写入不授予智能体文件工具、Shell 或宿主路径访问。高级部署可用 `developmentWorkspaceRoot` 或 `NEKRO_DEVELOPMENT_WORKSPACE_ROOT` 覆盖工作区根，覆盖后仍自动追加 `<agentId>`。

Spill 由 Server 自有的 DSH `SpillStore` 实现写入 `dataRoot/dsh/spill/`，单 artifact 8 MiB、单 Session 64 MiB、Host 总量 2 GiB；每次写入串行核算，重启后重新扫描现有文件。该目录是持久备份数据，不是 Asset 或 Adapter 路径身份。关闭文件工具后已有 locator 仍有效，但智能体不能自行回读，界面与模型提示会要求先重新授权文件工具。

本地开发统一运行根命令 `pnpm dev`：Web 固定监听 `http://127.0.0.1:4961` 并代理 `127.0.0.1:4960` 的 Server；端口被占用时直接失败，不静默落到另一个地址。默认数据根固定为仓库根的 `data/`，不会随 pnpm 的 package cwd 在 `apps/server/data/` 生成平行数据。workspace 库用 `tsdown --watch --no-clean` 重建，避免并行启动时暂时删除 Server 需要的包入口；Server 用 `tsx watch` 监听自身源码和各库的 `dist/*.mjs`，依赖实现变化后会优雅重启。仓库 `data/` 整体排除在 watch 外：Extension 构建缓存虽然会被 Server 动态导入，但安装、更新或删除这些运行文件不得触发 Server 源码重启。不要分别启动一个长期不重载的 Server 进程，否则可能出现前端/路由已更新而进程内 Core 类仍是旧版本的“半新半旧”状态。`pnpm install` 或 DSH 版本族升级后必须完整重启 Web 与 Server；Vite 对 `?raw` Client bundle 的解析路径会跨普通 HMR 保留，长期进程可能继续从 pnpm store 的旧物理目录加载已不在 lockfile 中的 DSH bundle。改完会触发重载的代码后，必须确认 Web 与 Server 快照仍可访问，不能只看 watch 进程还在；规则见 `docs/06-开发与测试规范.md` §6.1。
