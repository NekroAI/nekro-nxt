# 已实施：AgentRevision 能力格式收敛

状态：implemented

## 结论

智能体能力授权使用六项独立授权：`subagents`、`fileTools`、`webSearch`、`dynamicCreation`、`developmentShell`、`unrestrictedFileAccess`。Core 基线重建后直接保存这一严格对象，不再保留历史三字段映射或 V2 envelope；文件/Shell 装配语义不变。

## 当前持久格式

- `capabilities_json` 只接受六字段严格对象，读写共同使用 `AgentCapabilityGrantsSchema`；
- 旧 V1、V2 envelope、混合字段和未知字段全部拒绝；项目早期不编写逐版本兼容，旧实验数据库由基线门禁整体拒绝；
- `content_digest` 对当前规范化 Revision 内容计算稳定 SHA-256；语义未变化不生成新 Revision，切回已有内容复用该智能体的历史 Revision；
- 唯一 Core 基线为 Drizzle Kit 生成的 `0000_initial`，不存在 schema 15→16 条件升级。

## 文件与 Shell 语义

- `fileTools` 独立控制 read/grep/glob/write/edit 等 DSH 文件工具；`developmentShell` 独立控制 Bash；
- 两者都关闭时不创建工作区。任一开启时使用 `workspaces/<agentId>/` 作为默认工作目录；
- `unrestrictedFileAccess` 只在文件工具或 Shell 已开启时把 Sandbox Policy 从 `workspace-write` 提升到 `danger-full-access`，本身不提供任何工具；
- DSH rc.6 的 `workspace-write` 只约束写入。文件工具开启后，读取范围仍是 Server 进程有权读取的宿主文件范围，所以该能力默认关闭，产品界面必须给出真实警示，不能把提示词或默认 `cwd` 描述成读取权限边界。

## 验证与未来接缝

测试覆盖严格六字段解析、旧 envelope 拒绝、digest 稳定性、语义 no-op、历史 Revision 复用和旧实验数据库拒绝。现有每根 Session Scope 的文件/Shell Service 隔离继续保留；在 DSH rc.6 公开组合 Spike 证明 Host 全局 Service 不会跨智能体或扩展越权前，不迁移为全局 Service。

关联方向：子智能体、网页搜索、动态创造和高级开发能力共用不可变 Revision 授权接缝。当前没有为未知能力预留 envelope、Provider、Preset 或 RuntimeKind 字段。

本次明确不提前实现：子智能体/Web Provider 服务组装、能力可用状态、Spill、可靠性插件、频道级权限限制和自研资源调度器。

参考 DSH rc.6 的公开 Sandbox、FS、Bash 与 Scope API；借鉴其组合边界，拒绝 Fork 内核、用 Prompt 冒充权限边界或把 `tools.restrict()` 当成安全隔离。
