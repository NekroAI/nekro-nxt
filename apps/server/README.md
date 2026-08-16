# Server Host

该应用拥有 NekroNxt 的生产 DSH Host roster，并把 DSH Agent Loop 适配到 Channel Runtime。当前 roster 装配 Session、SQLite Persistence、System Prompt、Tool Runtime、Agent Loop、checkpoint、原 Session compaction、Channel 历史工具和受权 Asset 工具；聊天能力通过智能体作用域注册，不加载 DSH CLI 的全局文件与 Shell 工具。

当前公开给组合根的核心对象是 `DshHostRuntime`。它拥有 DSH Agent handle、Episode handoff、图片投影和完整 dispose 边界；Core SQLite、Adapter 和 Channel Runtime 仍由外层应用组合，不能通过 DSH Context 互相读取数据库。
