# Extension Runtime

该包拥有指定动态 Package 快照到不可变本地 Extension Revision 的物化、源码目录原子发布、导入构建、受控构建缓存、扩展的安装与智能体挂载（`ExtensionLifecycleCoordinator`）和本地扩展删除事务。

`ExtensionService` 先完整写入临时源码目录并原子 rename，再调用 `ExtensionRepository.saveExtensionRevision` 在一次仓库事务中保存 `LocalExtension` 与 `Revision`。文件系统与 SQLite 不伪装成跨介质事务；数据库不会发布源码尚未完整落盘的 Revision，数据库事务失败可能留下不可达的源码目录。

一个 Extension 不再有 `scope`（扩展形态统一）：`LocalExtension.provides` 是由最新 Revision 推导的「提供什么」标签（`agent`、`page`、`adapter`、`mcp`），只用于展示与筛选。同一 Extension 的后续 Revision 不能改变 adapter key。Revision 同时保存本地 `contentDigest` 和不含 Extension/Revision 身份的 `payloadDigest`；后者用于跨身份识别相同规范化源码、Manifest 契约和 Contribution。`save-from-dynamic` 可以创建新 Extension，也可以通过 `targetExtensionId` 给现有 Extension 增加下一不可变 Revision。

`ExtensionLifecycleCoordinator` 拥有安装、给智能体启用、切换版本、配置与卸载。一个 Extension 在一台机器上只有一份安装（本机实例：Host factory 只执行一次）与一个当前 Revision；`Activation` 以 `(agentId, extensionId)` 为复合身份，是该智能体的挂载与配置，版本列始终等于安装版本。只给智能体用的扩展在首次给智能体启用时自动安装。切换版本时本机实例与全部挂载在各自的安全间隙停止，用新 Revision 重新加载并挂载，全部成功后由 `commitHostInstallationState` 在一个事务中提交安装、权限批准、页面目录与随之切换的挂载；任一失败整体恢复原 Revision，数据库不变。浏览器侧权限与 `permissions.host` 在安装时批准（owner key `extension:<id>`），`permissions.agent` 在启用时批准（`activation:<agent>:<id>`），切换时只重新批准扩大的那一层。冷启动先 `restoreInstances()`（适配器在连接挂载前注册），频道恢复后再 `restoreAttachments()`。

SQLite 实现位于 `storage-sqlite`，DSH/Cordis 挂载位于 Server 组合根；本包不读取其他包数据库，也不依赖 Electron。动态运行、保存 Revision、给智能体启用和把 Adapter 安装到本机是独立提交点。源码 Revision 是持久事实，构建缓存可删除重建。

动态创造使用 `DynamicAuthoringService` 和 `AuthoringArtifactStore` 维护完整任务账本。每次 Define 先计算规范化快照摘要；同一 Task 重放相同 `runnerPackageId` 和相同摘要时直接返回已有 Attempt，不增加任务修订、事件或源码目录，同一 Package 身份提交不同摘要则明确拒绝。新候选才会把 Host/Client 原始源码、页面声明、权限、CSS/SVG 资源和内容摘要原子发布到 `workspaces/<agentId>/authoring/<taskId>/attempts/<attemptId>/`，再创建或追加 SQLite Attempt；风险摘要只计算 Host/Client 半边、权限、Contribution 和资源种类。Client CSS 在动态预览时由 Server 生成受作用域约束的 `styles.insert()` 包装，保存时由物化器生成受控 CSS 入口；这两层包装不改写 Attempt 保存的原始 Client 源码。重复的阶段回报和相同运行结果的自动续跑通知都幂等，后者使用确定消息身份避免同一结果重复入队。冷启动从最新 Attempt 源码重新定义临时 Runner 身份，并按原有运行意图恢复；资源缺失或预检失败会把任务标记为 `interrupted`。账本只在 Repository 成功提交后发布变化信号，Host 用它刷新创造工作台。删除任务时，Host 先停止并撤销该 Episode 中精确的临时 Plugin，等待运行资源静止，再把整个任务目录移入同一工作区的 `.trash`；数据库删除失败时恢复原目录。

页面 Client 必须同时注入 `pages` 和 `ui`。动态浏览器预览从真实 DOM 记录 NXT UI Kit 组件，并拒绝未经过 UI Kit 的 `button/input/select/textarea/table`；Host 标准页面框统一提供背景、24/32/40px 横向安全边距、24px 顶部、40px 底部和根滚动。预览还记录每个入口的 `pageGeometry`，Server 核对 Insets、PageHeader/正文内容轴、标题区分和横向溢出；`usedUiComponents` 与 `pageGeometry` 随 Authoring Verification 和最终 Revision Verification 保存。页面注册成功但缺少这些证据时不能发布 `ready`，避免把“能渲染”误报为“符合产品界面契约”。Extension CSS 同时拒绝 fixed、100vw/100vh 和负边距越界。

`ready` 表示当前候选通过验证，不单独证明智能体已经完成结果收尾。保存 Task/Attempt 前，Server 会排空该 Session 已排队的 Authoring continuation 并等待智能体空闲，然后重新读取 Task 最新 Attempt；收尾新增候选时拒绝原请求。Web 在智能体非空闲时禁用保存入口，避免用户把短暂的中间 `ready` 当作稳定完成点。

导入只接受经过分享协议检查的单 Revision，并在本机重新物化、构建和执行 Runtime 验证；来源验证证据不成为本机有效 Verification。验证按安装后的方式运行：Host factory 作为本机实例执行一次，适配器（若有）用完整 Fake Host Context 验证注册、启动、入站、出站、凭据引用、状态与 Transport 静止；智能体挂载以合成智能体 apply；每个 Tool 与 RPC 用验证样例真实调用；面板、工具视图、富消息渲染器、页面与 Navigation 全部渲染，最后 dispose。只有本机证据成功后才提交 Revision，导入后仍没有安装或启用。删除 Extension 时，Server 先等待全部 Activation 或 Installation 静止，再把整个源码目录移动到 `extension-data/trash/`，删除数据库事实和 Revision 构建缓存；提交失败时恢复源码与原运行关系。连接、频道和消息不是 Extension 私有数据，不参与删除。

Manifest V7 中工具、工具视图与智能体/频道锚点面板属于智能体挂载，RPC、适配器（最多一个）、页面（最多 8 个）、富消息渲染器与扩展/连接锚点面板属于本机实例；一个扩展可以同时提供它们。V6 及更早的 Manifest 不再读取，对应 Revision 标记为 `unavailable`，不能安装或启用。

新增权限未批准时旧版本不停止。冷启动重建页面目录失败时会停止已加载的候选实例，再记录 `restore-failed`，不会留下未受安装状态拥有的运行时。页面实例按稳定 `entryId` 保留 Host 级顺序和显隐，Client 失败只写诊断。内置 Registry 或其他 Extension 已占用 adapter key 时，在停止任何运行时之前拒绝变更。

智能体 Manifest 的 `permissions.capabilities` 与原有权限一起参与权限摘要：缺省时摘要与引入该字段前完全一致，已有批准不失效；规范化时对域名、配置字段、存储作用域与上下文名称排序。启用时 `permissionRequirement` 在声明任何能力时要求批准，并用 `extensionCapabilitiesExpand` 判断新 Revision 是否扩大已批准范围。配置中的凭据字段跳过 Schema 校验并原样保留宿主写入的凭据引用，`carryExtensionConfig` 在切换 Revision 时同样保留。Manifest 的 `requires.sdk` 超过当前 `EXTENSION_SDK_LEVEL` 时拒绝物化与导入；只有智能体扩展可以声明凭据字段和能力。

Revision 目录保存 `manifest.json`、`source/`、可选 `assets/`，以及用于并发发布校验的 `content.sha256` 和 `payload.sha256`。所有 Revision 使用 Manifest V7，`permissions` 为 `{ permissions, networkOrigins, host?, agent? }`，可选 `config` 为 `{ host?: { schema }, agent?: { schema } }`。`manifest.ts` 是唯一运行格式 Schema，Builder、Materializer 与导入共用，类型从 Schema 推导。Builder 严格校验 Manifest、CSS/SVG 声明和摘要后按 entrypoint 构建当前 Host/Client。Client CSS 必须是受作用域约束的 CSS Module；PostCSS 检查拒绝产品根选择器、裸全局选择器、`:global`、外部 URL、`@import` 和 `@font-face`，Server 交付时再把所有选择器固定到精确 Artifact 的 `data-host-ui-owner` 页面根。SVG 作为单色 mask 使用，拒绝脚本、样式、事件属性、外部引用及可嵌入内容。

`build.json` 是可丢弃缓存清单，只保存 `revisionId`、由固定 Builder/Node ABI/Revision digest 计算的 `buildKey` 和相对产物名；缓存目录和绝对产物路径由 Builder 推导，并在命中前检查产物文件仍存在。Verification 保留验证发生时的构建证据，产品快照和 Client Artifact 地址使用当前 Builder 对同一 Revision 计算出的 key；Builder 升级后会重建并切换地址，不把历史缓存 key 当成当前实现。损坏的 Manifest 会拒绝构建，损坏或不完整的缓存会重新构建。

Host factory 在安装时执行一次，RPC、适配器、入站钩子与定时任务处理归本机实例所有；返回的 Cordis Plugin 是智能体挂载，按每个启用它的智能体的每个 DSH Session 挂载 Tool Fiber。Session dispose 不能撤销 RPC；停用只撤下该智能体的挂载，卸载或切换版本会撤下全部挂载与本机实例。一个安装的扩展在 Web 端只运行一份 Client，由同一个 ExtensionUiRuntime（`apps/web/src/extension-ui/`）挂载与渲染，面板与工具视图按启用的智能体实时放置，单个贡献失败只影响自身，加载失败写诊断并保留 Host 运行。

Tool 与 RPC Contribution 可以携带 `verificationInput`：动态运行验证、保存和导入都用它真实调用对应 Tool 或 RPC，缺省时分别使用 `{}` 与 `null`。样例来自 Authoring 快照的 `verificationInputs`，单个样例不超过 16 KiB；它不参与风险摘要。带验证证据的 `saveDynamicPackage` 在发布源码并构建后，用导入验证器执行物化产物，通过后才提交 Revision；不带证据的低层保存仅发布并构建。`assertClientCssScope` 是 Client CSS 必须伴随 Client 源码的共享规则，动态预检与物化共用；所有带 Client 的扩展都可以提交 CSS。
