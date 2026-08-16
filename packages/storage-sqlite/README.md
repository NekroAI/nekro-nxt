# SQLite storage

该包拥有 NekroNxt Core SQLite 接入，以及 Host 对多个 SQLite 所有者执行在线快照所需的窄基础设施。M0 验证 Node 内置 `node:sqlite`、Drizzle schema、FTS5、WAL、在线备份和 Core/DSH 双快照提交；协调器不读取 DSH Session 私有表，也不提前建立尚无领域消费者的正式业务表。

若 Drizzle 没有对 `node:sqlite` 的稳定驱动，本包保留 Drizzle schema/migration，并通过窄 Repository 使用原生 `DatabaseSync`，不因此引入 `better-sqlite3` 或第二种数据库。
