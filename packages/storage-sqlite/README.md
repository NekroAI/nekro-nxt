# SQLite storage

该包拥有 NekroNxt Core SQLite 接入，以及 Host 对多个 SQLite 所有者执行在线快照所需的窄基础设施。M0 验证 Node 内置 `node:sqlite`、Drizzle schema、FTS5、WAL、在线备份和 Core/DSH 双快照提交；协调器不读取 DSH Session 私有表，也不提前建立尚无领域消费者的正式业务表。

若 Drizzle 没有对 `node:sqlite` 的稳定驱动，本包保留 Drizzle schema/migration，并通过窄 Repository 使用原生 `DatabaseSync`，不因此引入 `better-sqlite3` 或第二种数据库。

`bindings_active_agent_uq` 是部分唯一索引，只约束每个智能体最多一个活动 Binding；历史 Binding 保留以维持 Episode 外键和审计语义。Agent Revision 的历史复用和当前指针切换也在事务提交边界内完成。
