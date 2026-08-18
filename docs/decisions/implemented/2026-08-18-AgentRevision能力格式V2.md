# 已实施：AgentRevision 能力格式 V2

状态：implemented

## 结论

智能体能力授权从历史三字段升级为六项独立授权：`subagents`、`fileTools`、`webSearch`、`dynamicCreation`、`developmentShell`、`unrestrictedFileAccess`。本决定冻结领域格式、持久兼容与文件/Shell 装配语义；子智能体和网页搜索的后续组装见《DSH rc.6 群聊能力组合》实施记录。

## 持久兼容

- V1 是无版本 envelope 的三字段严格对象：`dynamicCreation/developmentShell/fullFileAccess`；读取时 `developmentShell || fullFileAccess` 映射为 `fileTools`，`fullFileAccess` 映射为 `unrestrictedFileAccess`，新增授权默认关闭；
- V2 新写入统一为 `{ version: 2, grants: AgentCapabilityGrants }`，未知字段、混合 V1/V2 和未来版本均拒绝；
- 历史 `capabilities_json` 与 `content_digest` 永不原地改写。SQLite migration 0015 只把 schema 提升到 16，使旧二进制拒绝打开可能含 V2 的数据库；
- V2 digest 为 `v2:sha256:<hex>`，输入使用域分隔 `nekro-nxt.agent-revision.v2\0` 和 canonical payload，避免与旧格式或未来格式碰撞；
- `reviseAgent` 先判断当前 Revision 的规范语义是否不变，再按 V2 digest 查找，最后扫描同一智能体的历史 Revision 做语义复用。旧 digest 不妨碍切回历史配置。

## 文件与 Shell 语义

- `fileTools` 独立控制 read/grep/glob/write/edit 等 DSH 文件工具；`developmentShell` 独立控制 Bash；
- 两者都关闭时不创建工作区。任一开启时使用 `workspaces/<agentId>/` 作为默认工作目录；
- `unrestrictedFileAccess` 只在文件工具或 Shell 已开启时把 Sandbox Policy 从 `workspace-write` 提升到 `danger-full-access`，本身不提供任何工具；
- DSH rc.6 的 `workspace-write` 只约束写入。文件工具开启后，读取范围仍是 Server 进程有权读取的宿主文件范围，所以该能力默认关闭，产品界面必须给出真实警示，不能把提示词或默认 `cwd` 描述成读取权限边界。

## 验证与未来接缝

测试覆盖 V1 三种映射、V2 编解码、未知格式拒绝、digest 稳定性、语义 no-op、历史 Revision 复用、schema 15→16 不改写和未来 schema 拒绝。现有每根 Session Scope 的文件/Shell Service 隔离继续保留；在 DSH rc.6 公开组合 Spike 证明 Host 全局 Service 不会跨智能体或扩展越权前，不迁移为全局 Service。

关联未来方向：子智能体、网页搜索、动态创造和高级开发能力共用不可变 Revision 授权接缝。该 envelope 可按新版本单调扩展，没有锁死未来 Provider、Preset 或 RuntimeKind。

本次明确不提前实现：子智能体/Web Provider 服务组装、能力可用状态、Spill、可靠性插件、频道级权限限制和自研资源调度器。

参考 DSH rc.6 的公开 Sandbox、FS、Bash 与 Scope API；借鉴其组合边界，拒绝 Fork 内核、用 Prompt 冒充权限边界或把 `tools.restrict()` 当成安全隔离。
