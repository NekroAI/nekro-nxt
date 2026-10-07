# SQLite storage

该包拥有 NekroNXT Core SQLite 的唯一结构事实源、Drizzle Repository、迁移执行和在线备份。DSH Session 由 DSH 的 JSONL Provider 拥有；本包只识别旧 SQLite 的 application ID / schema、协调归档和 Core 上下文重置，不读取或改写 DSH 私有表。

当前基线使用 `better-sqlite3 13.x + drizzle-orm 0.45.x`。`CoreDatabase` 只公开 typed Drizzle DB、迁移、事务、pragma、backup 和 close；领域代码不得获得原生连接。存储查询可以使用 Drizzle 参数化 SQL；原生 SQL 执行仅由迁移所有者负责，不拼接外部输入。WAL、foreign keys、busy timeout 与在线备份分别使用驱动的 `pragma()` 和 `backup()` API。

数据库按 agents、channels、connection events、runtime、outbox、assets、extensions、动态创造账本和 DSH plugins 分域维护 Repository，另含 Host 工作树顺序单行表与独立 Host Security Repository。Host Security 保存单例实例身份、管理密钥摘要和配对设备 Secret 摘要，不保存管理密钥或设备 Secret。Connection 的可选 `alias` 与其他字段一起经过行 Schema 读取；所有持久 JSON 读出后均经过 `drizzle-zod` 行 Schema 和领域 Schema；ID 使用带格式校验的 Zod brand。

迁移目录保留 Drizzle Kit 生成的 `0000_initial` 至当前增量迁移。空数据库按完整序列应用；已有带当前迁移元数据的数据库顺序应用新增迁移；任何不含 Drizzle migration 元数据的旧实验数据库都会被明确拒绝并要求重置。`CoreDatabase` 沿用 Drizzle 迁移文件与 journal 格式，在 immediate transaction 内执行待应用 SQL、记录迁移并检查全库外键；检查失败同时回滚结构、数据和 journal。事务前暂停外键执行，事务结束后恢复；当前版本无待应用迁移时也检查完整性，超出当前最新时间标识的未来迁移拒绝降级启动；已经支持的历史 journal 时间差异保留，不能据此拒绝现有数据。测试必须覆盖已有子表引用数据的真实表重建。不接管无 Drizzle journal 的旧实验格式；不修改已经发布的迁移文件。

`agent_revisions.persona_document` 保存可空的版本化结构化人设 JSON；旧行读取时由 `persona` 合成单一文本段，新 Revision 同时保存权威文档与确定性纯文本兼容投影。平台用户目录直接从 `platform_identities`、Connection、Channel Member 与未删除 Channel 联合投影，保留没有活动频道的历史身份，不复制平台原始用户 ID 到 API DTO。

频道历史在数据库中按时间与 ID 的 BINARY 倒序进行游标分页，隐藏事实在取页前排除。搜索使用 `search_text` 的确定性大小写折叠与参数化 `instr` 字面匹配，只解析限量的候选消息；无命中搜索仍可能扫描频道搜索文本。`%`、`_` 和中文短文本都保持字面语义。

Binding 只表达每个频道的当前归属，以 `channel_id` 为主键；历史消息和 Episode 不依赖历史 Binding 行。Agent Revision 继续不可变，当前 Revision 指针由独立表和复合外键保证归属。Asset Occurrence 以 `(channel_event_id, part_index)` 记录授权来源；Extension Activation 以 `(agent_id, extension_id)` 保存每个智能体当前启用版本。`host_extension_installations` 保存每个 `host-adapter` 或 `host-ui` Extension 当前安装的 Revision，并用复合外键保证 Revision 归属。

`0015_extension_scope_payload_digest` 把 Extension scope 固定到父对象，并给 Revision 增加独立 `payload_digest`。`0016_dsh_plugin_packages` 保存不可变 DSH 包身份、精确版本、来源、内容与 lockfile 摘要、可选 registry integrity、批准构建依赖、Bundle 展开入口、Host/智能体 Activation 和最近 Loader 诊断。Activation 是启用事实源；诊断只记录 `active/load-failed/restore-failed/dispose-failed` 和 Loader 阶段，不代替启用关系。

`0017_host_ui_pages` 保存 Host 级页面实例、共享顺序与显隐 Revision、绑定精确 Extension Revision 或 DSH Artifact 的权限批准，以及页面 Client/导航/RPC/恢复诊断。`host_ui_page_entries` 只在对应 Installation 或 DSH Host Activation 存在时发布；诊断不代替 Installation 或 Activation。扩展命名空间状态复用 `system_settings`，key 使用 owner 摘要隔离，并限制为 128 项、64 KiB。

`0018_productive_starfox` 增加 `dynamic_authoring_tasks`、`dynamic_authoring_attempts` 和 `dynamic_authoring_events`。Task 使用 revision 做乐观并发；Attempt 按任务内 ordinal 追加并保存不可变源码摘要、风险摘要、Runner 临时身份、Host/Client 阶段和验证证据；Event 使用任务内单调 sequence 记录审批、阶段、失败、恢复、停止和完成。诊断不是运行成功事实，只有 Attempt 完成真实验证后 Task 才进入 `ready`。运行中的任务不能直接删除。

`0019_adapter_activity_v2` 把 Channel kind `web` 原子转换为 `internal`，将 Binding 和 Channel Event 的活动列改为 `activity_triggers` / `activity_key`，并创建 `connection_events`。Connection Event 以 `(connection_id, dedupe_key)` 唯一约束去重，以 `(connection_id, received_at, id)` 支持稳定游标分页。`0020_platform_identity_connection_owner_index` 和 `0021_connection_event_identity_ownership` 分两步建立父级复合唯一索引并把 actor/subject 外键收紧到同一 Connection；拆分顺序确保 SQLite 重建表时父键已经存在。旧 Channel Event 的活动 key 原样保留，不搬迁到 Connection Event。

`0022_connection_activity_defaults_and_archive` 增加 `connections.activity_trigger_defaults`、`connections.archived_at` 和 `channel_bindings.activity_trigger_suppressions`。原 `activity_triggers` 数组继续保存显式开启覆盖，新列保存显式关闭覆盖，二者投影成领域层的布尔映射；因此无需改写旧 JSON。归档 Connection 保留所有关联行但退出活动查询，恢复时复用原 ID；永久删除按外键依赖顺序清理 Connection、Channel、成员、事件、Binding、Episode、Admission、Outbound 和连接状态。

`0014_host_extension_installations` 只创建空表和索引，不重建旧表、不回填、不扫描扩展源码。已有用户首次启动新 Release 时由 Drizzle 自动应用，现有 Agent、Connection、Channel、消息、Revision 和 Activation 不变；内置 Adapter 不写入该表。迁移后统一执行 `foreign_key_check`，失败则回滚并拒绝启动。

`0025_dsh_session_reset_receipts` 增加 Admission 的 `cancelled` 终态、`dsh_session_resets` 提交凭据和 `binding_admission_cutoffs` 入站截止点。`retireDshSessionEpisodes({ migrationId, closedAt })` 在单个 immediate transaction 内关闭旧活动 Episode、取消未完成 Admission、中断未完成创造任务并追加事件、停止相关候选运行并清除旧 run ID、记录每个现有 Binding 的入站边界及迁移 receipt。聊天、附件、Revision、Binding 创建时间、已提交 Outbound 和候选源码路径均保留。重复 migrationId 只返回原 receipt，不修改随后创建的 Session；`getDshSessionStorageRetirement(migrationId)` 用于读取该提交凭据。Admission 与事件关联不删除，已取消的 Admission 不再认领或写回；新入站按 `(received_at, id)` 严格超过绑定截止点才进入自动 Admission。解绑删除该绑定的截止点，新绑定不继承它。

`0026_ui_projections` 只新增五张表，不重建或回填既有表：`agent_appearances` 保存智能体色相（0–359）与可选头像 Asset，独立于不可变 Revision，随智能体级联删除、头像 Asset 删除时置空；`read_viewers` 与 `channel_read_cursors` 按观察者保存每个频道单调推进的 `(read_at, read_source_id)` 阅读位置；`attention_dismissals` 按关注指纹保存忽略时间，写入时清理超过保留期的旧记录；`outbound_resolutions` 记录管理员对失败或未知出站的 `retry` / `confirm-delivered` 处理，包括处理前的意图状态和物理投递快照。`ProjectionRepository`（`core.projections`）提供未读计数（只读上限加一行）、按时间桶的活跃度聚合、未结出站列表和事务内的投递处理；`resolveOutbound` 的重试以意图当前状态做 CAS，冲突或不可处理时抛出 `OutboundResolutionError`。

`0028_extension_storage` 新增 `extension_storage_entries`，保存扩展私有 JSON 键值数据，主键为 `(extension_id, owner, partition, key)`。`owner` 是智能体 ID 或 `shared`，`agent_id` 外键与之一致（共享条目为空），`partition` 为空、频道 ID 或 `频道ID:成员ID`。删除本地扩展级联删除全部条目，删除智能体只级联删除该智能体的条目，共享条目保留。单值上限 256 KiB；写入在 immediate transaction 内按扩展汇总字节数并与调用方给出的配额比较，替换同一键时扣除旧值，超出时抛出 `ExtensionStorageQuotaError`。前缀查询用 `instr` 做字面匹配，`%`、`_` 不是通配符。

`prepareDshSessionStorage({ databasePath, sessionRoot?, sessionCompatibilityId?, now?, onProgress? })` 需要 Host 已独占数据根并完成完整备份。它只接受 DSH application ID `1146308688` 下的 schema 15/17，使用 SQLite backup API 生成并校验独立快照，发布归档与重置标记后才逐个移走旧文件。新根默认为旧库同级的 `dsh/sessions`，以 `dsh/session-storage.json` 持久化 `jsonl-v4` 身份；未知数据库、未来身份或没有身份的非空 JSONL 根拒绝启动。归档、重置标记与源文件保留校验信息；中断后检查归档和剩余源文件，不能因重试覆盖损坏归档或新写入。`onProgress` 报告四个已完成阶段，可由宿主推进 journal 或由测试注入中断。

准备结果返回 `sessionRoot`、`sessionCompatibilityId` 与 `new/compatible/archived` 状态。仅 `archived` 返回稳定 `migrationId`，其依据是源存储身份和目标兼容格式，与产品 commit 无关。调用方提交 Core 重置事务后，再调用 `completeDshSessionStoragePreparation(databasePath, migrationId)` 清除待重置标记；重复完成安全，身份不匹配拒绝。未来升级必须为新兼容格式登记明确迁移，不按产品版本变化自动清空会话。

Host 的完整恢复点通过本包公开的 `readBackupAgentIds(databasePath)` 枚举外置工作区所有者；它只读旧 Core，无 `agent_definitions` 表返回空列表，非法智能体 ID 拒绝。`createSqliteFileSnapshot(source, destination)` 使用 SQLite backup API 将已提交 WAL 合入独立快照；`verifySqliteSnapshot(path)` 用只读连接执行 `quick_check`。这些接口不执行迁移，也不创建缺失源库，Server 和 Desktop 无需自行持有原生 SQLite 连接。

宿主必须先调用只读 `preflightDshSessionStorage({ databasePath })`，再创建完整恢复点、执行 Core 迁移和 Session 准备。Preflight 不创建数据根、不归档、不发布身份或重置标记；已存在的身份、待重置标记及已知旧 schema 都需通过检查，未知未来格式在改变 Core 前拒绝。只读 SQLite 检查在没有未合入 WAL 时使用 immutable URI，避免产生 sidecar；存在 WAL 时不能忽略其提交内容，必须有可读的现有共享内存文件，否则拒绝并要求先恢复源库。目标快照由创建者转换成 DELETE journal，`verifySqliteSnapshot` 使用 immutable 连接验证，不改写被验证文件。

`acquireSqliteFileLease(path)` 以固定 SQLite 文件持有操作系统级排他事务锁，返回可重复调用的同步释放函数。释放只回滚并关闭连接，不 unlink 锁库；进程退出由操作系统释放锁。数据根身份、跨宿主诊断和锁文件元数据仍由 Host 管理。

`0029_extension_jobs_hooks` 新增两张表支持扩展定时任务与入站钩子能力。`extension_jobs` 保存声明式与运行时创建的定时任务，主键为 `id`（格式 `job_` 前缀），外键指向 `(agent_id, extension_id, channel_id)` 三元组，`extension_id` 可为空（代表对话创建的任务）；`source` 区分声明式、运行时创建和对话创建（值为 `reminder`），声明式任务按 `(agent_id, extension_id, channel_id, declared_key)` 唯一；支持一次性（`schedule_kind = 'once'` 时填 `run_at`）或 Cron 计划（`schedule_kind = 'cron'` 时填 `cron` 与 `timezone`），`next_run_at` 用于查询到期任务并按升序排列，`paused` 是单个任务的暂停状态（扩展停用不改它，调度器按启用状态静默该扩展的任务）；索引支持 `(paused, next_run_at)` 查询到期任务和 `(agent_id, extension_id)` 查询扩展的任务。`inbound_hook_decisions` 以 `(channel_event_id, agent_id)` 为主键记录钩子决定（消息已入库，决定不可覆盖），保存触发状态、隐藏标志、标注和参与决定的扩展列表；用于恢复时读取已保存决定，避免重复执行钩子。级联删除规则保证任务在删除扩展、智能体或频道时被清理。
