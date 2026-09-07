# SQLite storage

该包拥有 NekroNXT Core SQLite 的唯一结构事实源、Drizzle Repository、迁移执行和在线备份。DSH Session SQLite 继续由 DSH 自己拥有；本包只协调备份文件，不读取 DSH 私有表。

当前基线使用 `better-sqlite3 13.x + drizzle-orm 0.45.x`。`CoreDatabase` 只公开 typed Drizzle DB、迁移、事务、pragma、backup 和 close；领域代码不得获得原生连接。存储查询可以使用 Drizzle 参数化 SQL；原生 SQL 执行仅由迁移所有者负责，不拼接外部输入。WAL、foreign keys、busy timeout 与在线备份分别使用驱动的 `pragma()` 和 `backup()` API。

数据库按 agents、channels、connection events、runtime、outbox、assets、extensions、动态创造账本和 DSH plugins 分域维护 Repository，另含 Host 工作树顺序单行表与独立 Host Security Repository。Host Security 保存单例实例身份、管理密钥摘要和配对设备 Secret 摘要，不保存管理密钥或设备 Secret。Connection 的可选 `alias` 与其他字段一起经过行 Schema 读取；所有持久 JSON 读出后均经过 `drizzle-zod` 行 Schema 和领域 Schema；ID 使用带格式校验的 Zod brand。

迁移目录保留 Drizzle Kit 生成的 `0000_initial` 至当前增量迁移。空数据库按完整序列应用；已有带当前迁移元数据的数据库顺序应用新增迁移；任何不含 Drizzle migration 元数据的旧实验数据库都会被明确拒绝并要求重置。`CoreDatabase` 沿用 Drizzle 迁移文件与 journal 格式，在 immediate transaction 内执行待应用 SQL、记录迁移并检查全库外键；检查失败同时回滚结构、数据和 journal。事务前暂停外键执行，事务结束后恢复；当前版本无待应用迁移时也检查完整性，未知迁移拒绝降级启动。测试必须覆盖已有子表引用数据的真实表重建。本项目不维护 0000–0016 的升级兼容，也不允许人工编辑迁移 SQL。

`agent_revisions.persona_document` 保存可空的版本化结构化人设 JSON；旧行读取时由 `persona` 合成单一文本段，新 Revision 同时保存权威文档与确定性纯文本兼容投影。平台用户目录直接从 `platform_identities`、Connection、Channel Member 与未删除 Channel 联合投影，保留没有活动频道的历史身份，不复制平台原始用户 ID 到 API DTO。

频道历史在数据库中按时间与 ID 的 BINARY 倒序进行游标分页，隐藏事实在取页前排除。搜索使用 `search_text` 的确定性大小写折叠与参数化 `instr` 字面匹配，只解析限量的候选消息；无命中搜索仍可能扫描频道搜索文本。`%`、`_` 和中文短文本都保持字面语义。

Binding 只表达每个频道的当前归属，以 `channel_id` 为主键；历史消息和 Episode 不依赖历史 Binding 行。Agent Revision 继续不可变，当前 Revision 指针由独立表和复合外键保证归属。Asset Occurrence 以 `(channel_event_id, part_index)` 记录授权来源；Extension Activation 以 `(agent_id, extension_id)` 保存每个智能体当前启用版本。`host_extension_installations` 保存每个 `host-adapter` 或 `host-ui` Extension 当前安装的 Revision，并用复合外键保证 Revision 归属。

`0015_extension_scope_payload_digest` 把 Extension scope 固定到父对象，并给 Revision 增加独立 `payload_digest`。`0016_dsh_plugin_packages` 保存不可变 DSH 包身份、精确版本、来源、内容与 lockfile 摘要、可选 registry integrity、批准构建依赖、Bundle 展开入口、Host/智能体 Activation 和最近 Loader 诊断。Activation 是启用事实源；诊断只记录 `active/load-failed/restore-failed/dispose-failed` 和 Loader 阶段，不代替启用关系。

`0017_host_ui_pages` 保存 Host 级页面实例、共享顺序与显隐 Revision、绑定精确 Extension Revision 或 DSH Artifact 的权限批准，以及页面 Client/导航/RPC/恢复诊断。`host_ui_page_entries` 只在对应 Installation 或 DSH Host Activation 存在时发布；诊断不代替 Installation 或 Activation。扩展命名空间状态复用 `system_settings`，key 使用 owner 摘要隔离，并限制为 128 项、64 KiB。

`0018_productive_starfox` 增加 `dynamic_authoring_tasks`、`dynamic_authoring_attempts` 和 `dynamic_authoring_events`。Task 使用 revision 做乐观并发；Attempt 按任务内 ordinal 追加并保存不可变源码摘要、风险摘要、Runner 临时身份、Host/Client 阶段和验证证据；Event 使用任务内单调 sequence 记录审批、阶段、失败、恢复、停止和完成。诊断不是运行成功事实，只有 Attempt 完成真实验证后 Task 才进入 `ready`。运行中的任务不能直接删除。

`0019_adapter_activity_v2` 把 Channel kind `web` 原子转换为 `internal`，将 Binding 和 Channel Event 的活动列改为 `activity_triggers` / `activity_key`，并创建 `connection_events`。Connection Event 以 `(connection_id, dedupe_key)` 唯一约束去重，以 `(connection_id, received_at, id)` 支持稳定游标分页。`0020_platform_identity_connection_owner_index` 和 `0021_connection_event_identity_ownership` 分两步建立父级复合唯一索引并把 actor/subject 外键收紧到同一 Connection；拆分顺序确保 SQLite 重建表时父键已经存在。旧 Channel Event 的活动 key 原样保留，不搬迁到 Connection Event。

`0022_connection_activity_defaults_and_archive` 增加 `connections.activity_trigger_defaults`、`connections.archived_at` 和 `channel_bindings.activity_trigger_suppressions`。原 `activity_triggers` 数组继续保存显式开启覆盖，新列保存显式关闭覆盖，二者投影成领域层的布尔映射；因此无需改写旧 JSON。归档 Connection 保留所有关联行但退出活动查询，恢复时复用原 ID；永久删除按外键依赖顺序清理 Connection、Channel、成员、事件、Binding、Episode、Admission、Outbound 和连接状态。

`0014_host_extension_installations` 只创建空表和索引，不重建旧表、不回填、不扫描扩展源码。已有用户首次启动新 Release 时由 Drizzle 自动应用，现有 Agent、Connection、Channel、消息、Revision 和 Activation 不变；内置 Adapter 不写入该表。迁移后统一执行 `foreign_key_check`，失败则回滚并拒绝启动。
