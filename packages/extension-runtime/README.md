# Extension Runtime

该包拥有指定动态 Package 快照到不可变本地 Extension Revision 的物化、源码目录原子发布、受控构建缓存，以及按智能体隔离的当前 Activation 挂载。

`ExtensionService` 先完整写入临时源码目录并原子 rename，再调用 `ExtensionRepository.saveExtensionRevision` 在一次仓库事务中保存 `LocalExtension` 与 `Revision`。文件系统与 SQLite 不伪装成跨介质事务；数据库不会发布源码尚未完整落盘的 Revision，数据库事务失败可能留下不可达的源码目录。

`Activation` 以 `(agentId, extensionId)` 为复合身份。切换版本时先构建、进入安全间隙并挂载，挂载成功后才 upsert 当前 Activation；失败时数据库保持不变，并恢复本协调器原先挂载的版本。停用同样使用 `(agentId, extensionId)`，不同智能体的挂载互不影响。

SQLite 实现位于 `storage-sqlite`，DSH/Cordis 挂载位于 Server 组合根；本包不读取其他包数据库，也不依赖 Electron。动态运行、保存 Revision 和给智能体启用仍是三个独立动作。源码 Revision 是持久事实，构建缓存可删除重建。

Revision 目录只保存 `manifest.json`、`source/` 和用于并发发布校验的 `content.sha256`。新 Revision 使用 Manifest V2，包含 `schemaVersion: 2`、稳定身份、当前 Host/Client entrypoint，以及由真实运行时记录的 Tool、RPC 和 NekroNXT 产品 Slot Contribution；旧 V1 继续只读并规范化为没有 Contribution，既不重写旧目录也不采信模型或 Web 自报。Builder 读取并严格校验 Manifest 后，按 entrypoint 构建当前 Host/Client。

`build.json` 是可丢弃缓存清单，只保存 `revisionId`、由固定 Builder/Node ABI/Revision digest 计算的 `buildKey` 和相对产物名；缓存目录和绝对产物路径由 Builder 推导，并在命中前检查产物文件仍存在。损坏的 Manifest 会拒绝构建，损坏或不完整的缓存会重新构建。

Host factory 每个 Activation 只执行一次，RPC handler 也归 Activation 所有；返回的 Cordis Plugin 才按该智能体的每个 DSH Session 挂载 Tool Fiber。Session dispose 不能撤销 RPC，停用或切换 Activation 会同时撤销所有 Tool Fiber、RPC 和 Client Artifact 授权。Client 只运行在 `agent.workbench.sections` 与 `extension.details.panels`，每个智能体拥有独立 SlotCore；加载失败只写诊断并保留 Host Activation。
