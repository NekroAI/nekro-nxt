# AgentRevision 能力格式

状态：implemented

智能体能力是六项独立授权：`subagents`、`fileTools`、`webSearch`、`dynamicCreation`、`developmentShell`、`unrestrictedFileAccess`。`capabilities_json` 只接受这一严格对象，读写共用 `AgentCapabilityGrantsSchema`，未知字段拒绝。

- `content_digest` 对规范化 Revision 内容计算 SHA-256；语义未变不生成新 Revision，切回已有内容复用历史 Revision；
- `fileTools` 控制文件工具，`developmentShell` 控制 Bash；两者都关则不创建工作区，任一开启则使用 `workspaces/<agentId>/`；
- `unrestrictedFileAccess` 只在文件或 Shell 已开启时把策略提升到 `danger-full-access`，本身不提供工具；
- DSH `workspace-write` 只约束写入。文件工具开启后，读取范围仍是 Server 进程可读范围，产品必须如实警示。

无法识别的 Core 数据库拒绝打开。不预留未知能力 envelope 或 `RuntimeKind`。
