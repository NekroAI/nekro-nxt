# Extension Runtime

该包拥有指定动态 Package 快照到不可变本地 Extension Revision 的物化、源码目录原子发布、受控构建缓存、按智能体隔离的 Activation，以及宿主级 Adapter Installation。

`ExtensionService` 先完整写入临时源码目录并原子 rename，再调用 `ExtensionRepository.saveExtensionRevision` 在一次仓库事务中保存 `LocalExtension` 与 `Revision`。文件系统与 SQLite 不伪装成跨介质事务；数据库不会发布源码尚未完整落盘的 Revision，数据库事务失败可能留下不可达的源码目录。

`Activation` 以 `(agentId, extensionId)` 为复合身份。切换版本时先构建、进入安全间隙并挂载，挂载成功后才 upsert 当前 Activation；失败时数据库保持不变，并恢复本协调器原先挂载的版本。停用同样使用 `(agentId, extensionId)`，不同智能体的挂载互不影响。

SQLite 实现位于 `storage-sqlite`，DSH/Cordis 挂载位于 Server 组合根；本包不读取其他包数据库，也不依赖 Electron。动态运行、保存 Revision、给智能体启用和把 Adapter 安装到本机是独立提交点。源码 Revision 是持久事实，构建缓存可删除重建。

Manifest V3 固定 `scope: host-adapter`，必须有一个 Host entry、恰好一个 Adapter Contribution，并可附带 `conversation.message.rich` Host Client Slot；Tool、Agent RPC 和智能体 Slot 混装会在物化和验证阶段失败。V1/V2 继续只读兼容并只走 `AgentActivation`。同一 Extension 的后续 Adapter Revision 不能改变 key。

`HostExtensionInstallationCoordinator` 只接受已保存、构建成功且带 `nekro-nxt-extension-v2` Adapter 证据的 Revision。安装、冷启动恢复和卸载在 `adapterKey` 级别串行；内置 Registry 或其他 Extension 已占用该 key 时，会在停止任何连接 Runtime 之前拒绝变更。更新和回滚先停止旧 Runtime，再发布新 Registry Contribution 和数据库 Installation；构建、注册或数据库提交失败会恢复旧贡献。卸载保留 Extension、Revision、Connection、Credential、Channel 和历史；重新安装相同 key 后恢复 Connection。

Revision 目录只保存 `manifest.json`、`source/` 和用于并发发布校验的 `content.sha256`。智能体 Revision 使用 Manifest V2；Adapter Revision 使用 Manifest V3；旧 V1 继续只读且不重写。Builder 严格校验 Manifest 后按 entrypoint 构建当前 Host/Client。

`build.json` 是可丢弃缓存清单，只保存 `revisionId`、由固定 Builder/Node ABI/Revision digest 计算的 `buildKey` 和相对产物名；缓存目录和绝对产物路径由 Builder 推导，并在命中前检查产物文件仍存在。损坏的 Manifest 会拒绝构建，损坏或不完整的缓存会重新构建。

Host factory 每个 Activation 只执行一次，RPC handler 也归 Activation 所有；返回的 Cordis Plugin 才按该智能体的每个 DSH Session 挂载 Tool Fiber。Session dispose 不能撤销 RPC，停用或切换 Activation 会同时撤销所有 Tool Fiber、RPC 和 Client Artifact 授权。Client 只运行在 `agent.workbench.sections` 与 `extension.details.panels`，每个智能体拥有独立 SlotCore；加载失败只写诊断并保留 Host Activation。
