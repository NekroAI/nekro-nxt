# SQLite storage

该包拥有 NekroNXT Core SQLite 的唯一结构事实源、Drizzle Repository、迁移执行和在线备份。DSH Session SQLite 继续由 DSH 自己拥有；本包只协调备份文件，不读取 DSH 私有表。

当前基线使用 `better-sqlite3 13.x + drizzle-orm 0.45.x`。`CoreDatabase` 只公开 typed Drizzle DB、迁移、事务、pragma、backup 和 close；领域代码不得获得原生连接，也不得调用 `.prepare()`、`.exec()`、`sql.raw()` 或拼接 SQL。WAL、foreign keys、busy timeout 与在线备份分别使用驱动的 `pragma()` 和 `backup()` API。

数据库按 agents、channels、runtime、outbox、assets、extensions 六个 Repository 文件维护，另含 Host 工作树顺序单行表与独立 Host Security Repository。Host Security 保存单例实例身份、管理密钥摘要和配对设备 Secret 摘要，不保存管理密钥或设备 Secret。Connection 的可选 `alias` 与其他字段一起经过行 Schema 读取；所有持久 JSON 读出后均经过 `drizzle-zod` 行 Schema 和领域 Schema；ID 使用带格式校验的 Zod brand。

迁移目录保留 Drizzle Kit 生成的 `0000_initial` 至当前增量迁移。空数据库按完整序列应用；已有带当前迁移元数据的数据库顺序应用新增迁移；任何不含 Drizzle migration 元数据的旧实验数据库都会被明确拒绝并要求重置。Drizzle 在事务内执行 SQLite 表重建，而 SQLite 不允许在事务内切换 `foreign_keys`，因此 `CoreDatabase` 在迁移事务开始前暂停外键执行，迁移完成后先运行全库 `foreign_key_check`，再恢复外键；发现任何违规都拒绝启动。测试必须覆盖已有子表引用数据的真实表重建。本项目不维护 0000–0016 的升级兼容，也不允许人工编辑迁移 SQL。

`agent_revisions.persona_document` 保存可空的版本化结构化人设 JSON；旧行读取时由 `persona` 合成单一文本段，新 Revision 同时保存权威文档与确定性纯文本兼容投影。平台用户目录直接从 `platform_identities`、Connection、Channel Member 与未删除 Channel 联合投影，保留没有活动频道的历史身份，不复制平台原始用户 ID 到 API DTO。

频道历史搜索保存规范化 `search_text`，按频道分页后在 TypeScript 中执行字面子串匹配。`%`、`_` 和中文短文本都保持字面语义。

Binding 只表达每个频道的当前归属，以 `channel_id` 为主键；历史消息和 Episode 不依赖历史 Binding 行。Agent Revision 继续不可变，当前 Revision 指针由独立表和复合外键保证归属。Asset Occurrence 以 `(channel_event_id, part_index)` 记录授权来源；Extension Activation 以 `(agent_id, extension_id)` 保存每个智能体当前启用版本，`extension_client_diagnostics` 只保留该 Activation 最近一次 Client loaded/failed 结果并随停用级联删除。
