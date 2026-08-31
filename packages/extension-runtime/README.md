# Extension Runtime

该包拥有指定动态 Package 快照到不可变本地 Extension Revision 的物化、源码目录原子发布、导入构建、受控构建缓存、按智能体隔离的 Activation、宿主级 Adapter/Host UI Installation 和本地扩展删除事务。

`ExtensionService` 先完整写入临时源码目录并原子 rename，再调用 `ExtensionRepository.saveExtensionRevision` 在一次仓库事务中保存 `LocalExtension` 与 `Revision`。文件系统与 SQLite 不伪装成跨介质事务；数据库不会发布源码尚未完整落盘的 Revision，数据库事务失败可能留下不可达的源码目录。

`LocalExtension.scope` 固定为 `agent | host-adapter | host-ui`。同一 Extension 的所有 Revision 必须保持 scope，Adapter Extension 还必须保持同一个 adapter key。Revision 同时保存本地 `contentDigest` 和不含 Extension/Revision 身份的 `payloadDigest`；后者用于跨身份识别相同规范化源码、Manifest 契约和 Contribution。`save-from-dynamic` 可以创建新 Extension，也可以通过 `targetExtensionId` 给现有 Extension 增加下一不可变 Revision。

`Activation` 以 `(agentId, extensionId)` 为复合身份。切换版本时先构建、进入安全间隙并挂载，挂载成功后才 upsert 当前 Activation；失败时数据库保持不变，并恢复本协调器原先挂载的版本。停用同样使用 `(agentId, extensionId)`，不同智能体的挂载互不影响。

SQLite 实现位于 `storage-sqlite`，DSH/Cordis 挂载位于 Server 组合根；本包不读取其他包数据库，也不依赖 Electron。动态运行、保存 Revision、给智能体启用和把 Adapter 安装到本机是独立提交点。源码 Revision 是持久事实，构建缓存可删除重建。

动态创造使用 `DynamicAuthoringService` 和 `AuthoringArtifactStore` 维护完整任务账本。每次 Define 先计算规范化快照摘要；同一 Task 重放相同 `runnerPackageId` 和相同摘要时直接返回已有 Attempt，不增加任务修订、事件或源码目录，同一 Package 身份提交不同摘要则明确拒绝。新候选才会把 Host/Client 原始源码、页面声明、权限、CSS/SVG 资源和内容摘要原子发布到 `workspaces/<agentId>/authoring/<taskId>/attempts/<attemptId>/`，再创建或追加 SQLite Attempt；风险摘要只计算 Host/Client 半边、权限、Contribution 和资源种类。页面 CSS 在动态预览时由 Server 生成受作用域约束的 `styles.insert()` 包装，保存时由物化器生成受控 CSS 入口；这两层包装不改写 Attempt 保存的原始 Client 源码。重复的阶段回报和相同运行结果的自动续跑通知都幂等，后者使用确定消息身份避免同一结果重复入队。冷启动从最新 Attempt 源码重新定义临时 Runner 身份，并按原有运行意图恢复；资源缺失或预检失败会把任务标记为 `interrupted`。账本只在 Repository 成功提交后发布变化信号，Host 用它刷新创造工作台。删除任务时，Host 先停止并撤销该 Episode 中精确的临时 Plugin，等待运行资源静止，再把整个任务目录移入同一工作区的 `.trash`；数据库删除失败时恢复原目录。

页面 Client 必须同时注入 `pages` 和 `ui`。动态浏览器预览从真实 DOM 记录 NXT UI Kit 组件，并拒绝未经过 UI Kit 的 `button/input/select/textarea/table`；Host 标准页面框统一提供背景、24/32/40px 横向安全边距、24px 顶部、40px 底部和根滚动。预览还记录每个入口的 `pageGeometry`，Server 核对 Insets、PageHeader/正文内容轴、标题区分和横向溢出；`usedUiComponents` 与 `pageGeometry` 随 Authoring Verification 和最终 Revision Verification 保存。页面注册成功但缺少这些证据时不能发布 `ready`，避免把“能渲染”误报为“符合产品界面契约”。Extension CSS 同时拒绝 fixed、100vw/100vh 和负边距越界。

`ready` 表示当前候选通过验证，不单独证明智能体已经完成结果收尾。保存 Task/Attempt 前，Server 会排空该 Session 已排队的 Authoring continuation 并等待智能体空闲，然后重新读取 Task 最新 Attempt；收尾新增候选时拒绝原请求。Web 在智能体非空闲时禁用保存入口，避免用户把短暂的中间 `ready` 当作稳定完成点。

导入只接受经过分享协议检查的单 Revision，并在本机重新物化、构建和执行 Runtime 验证；来源验证证据不成为本机有效 Verification。智能体扩展会真实执行 Host factory、Tool、RPC、Client Slot 和 dispose；Host UI 会执行 Host RPC、页面注册、组件、Navigation 与 dispose；Adapter 会使用完整 Fake Host Context 验证注册、启动、入站、出站、凭据引用、状态、Transport 静止和 Client Slot。只有本机证据成功后才提交 Revision，导入后仍没有 Activation 或 Installation。删除 Extension 时，Server 先等待全部 Activation 或 Installation 静止，再把整个源码目录移动到 `extension-data/trash/`，删除数据库事实和 Revision 构建缓存；提交失败时恢复源码与原运行关系。连接、频道和消息不是 Extension 私有数据，不参与删除。

Manifest V3 固定 `scope: host-adapter`，必须有一个 Host entry、恰好一个 Adapter Contribution，并可附带 Adapter 产品 Slot 与最多 8 个 `host-page`；Tool、Agent RPC 和智能体 Slot 混装会在物化和验证阶段失败。V1/V2 继续只读兼容并走 `AgentActivation`。同一 Extension 的后续 Adapter Revision 不能改变 key。

`HostExtensionInstallationCoordinator` 按 scope 分派 Adapter Driver 或 Host UI Driver。Host UI 使用 `nekro-nxt-extension-v3`、Manifest V4、精确权限摘要和 1–8 个页面贡献；新增权限未批准时旧版本不停止。Installation、权限批准和页面目录由 Repository 在一个 SQLite 事务中发布或撤销，任何一表失败都保留原事实。冷启动重建页面目录失败时会 dispose 已挂载的候选 Runtime，再记录 `restore-failed`，不会留下未受安装状态拥有的挂载。页面实例按稳定 `entryId` 保留 Host 级顺序和显隐，Client 失败只写诊断。Adapter 安装继续在 `adapterKey` 级别串行，内置 Registry 或其他 Extension 已占用 key 时在停止连接 Runtime 前拒绝变更。

Revision 目录保存 `manifest.json`、`source/`、可选 `assets/`，以及用于并发发布校验的 `content.sha256` 和 `payload.sha256`。智能体 Revision 使用 Manifest V2，Adapter Revision 使用 Manifest V3，纯页面 Revision 使用 Manifest V4；旧 V1 继续只读且不重写。Builder 严格校验 Manifest、CSS/SVG 声明和摘要后按 entrypoint 构建当前 Host/Client。Client CSS 必须是受作用域约束的 CSS Module；PostCSS 检查拒绝产品根选择器、裸全局选择器、`:global`、外部 URL、`@import` 和 `@font-face`，Server 交付时再把所有选择器固定到精确 Artifact 的 `data-host-ui-owner` 页面根。SVG 作为单色 mask 使用，拒绝脚本、样式、事件属性、外部引用及可嵌入内容。

`build.json` 是可丢弃缓存清单，只保存 `revisionId`、由固定 Builder/Node ABI/Revision digest 计算的 `buildKey` 和相对产物名；缓存目录和绝对产物路径由 Builder 推导，并在命中前检查产物文件仍存在。Verification 保留验证发生时的构建证据，产品快照和 Client Artifact 地址使用当前 Builder 对同一 Revision 计算出的 key；Builder 升级后会重建并切换地址，不把历史缓存 key 当成当前实现。损坏的 Manifest 会拒绝构建，损坏或不完整的缓存会重新构建。

Host factory 每个 Activation 执行一次，RPC handler 也归 Activation 所有；返回的 Cordis Plugin 按该智能体的每个 DSH Session 挂载 Tool Fiber。Session dispose 不能撤销 RPC，停用或切换 Activation 会同时撤销所有 Tool Fiber、RPC 和 Client Artifact 授权。智能体 Client 可注册 Catalog 中的 `agent.workbench.sections`、`extension.activation.panels`、`channel.inspector.agent.sections` 和 keyed `conversation.tool.card`；`extension.details.panels` 保留兼容映射。每个智能体拥有独立 SlotCore，加载失败写诊断并保留 Host Activation。Adapter Client 使用独立 Host Runtime，可注册富消息、连接创建/状态/测试和频道检查器 Slot；页面 Client 使用独立 Host UI Runtime，不与前两者共享 Registry。
