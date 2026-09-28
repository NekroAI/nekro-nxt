# DSH 升级维护指南

DSH 仍在预览期。每次升级都使用固定目标版本，在隔离工作树和合成数据根中完成适配，再验收完整产品。可复用的是版本矩阵、备份、协调器、诊断与恢复入口；上游接口差异仍需要逐次审查，不能通过批量替换版本号绕过。

## 1. 数据与版本由谁负责

[DSH compatibility](../packages/dsh-compat/README.md) 的 `src/release.json` 是依赖矩阵的唯一来源，当前锁定 `0.1.7-rc.2`。产品 `releaseId` 标识完整程序包；`sessionCompatibilityId`、`settingsFormatVersion`、`extensionRuntimeAbi` 分别判断 Session、设置和扩展边界。`runtimeFingerprint` 将这些信息与包矩阵绑定，参与扩展缓存和兼容诊断身份。

| 所有者 | 持久事实 | 升级方式 |
| --- | --- | --- |
| Core / storage-sqlite | 聊天、智能体 Revision、绑定、Admission、出站与创造任务 | Drizzle 迁移；业务重置与完成凭据在同一事务提交 |
| DSH Session Provider | Session 日志与句柄生命周期 | 使用公开 Provider；未知格式拒绝，不能改私有表 |
| NXT Host Profile | 固定插件入口、用户配置与配置迁移标记 | 校验后原子发布 Profile；凭据继续由独立存储拥有 |
| Extension Runtime | 不可变源码、安装与启用意图、构建缓存 | 保留源码与旧验证证据；环境改变后重建和检查 |
| Web | 交互状态与未提交输入 | 不迁移 Core；旧页面停止写操作，提示刷新 |
| Host 升级协调器 | 备份、步骤顺序、journal 与启动状态 | 调用所有者步骤，不制造跨 SQLite/文件系统事务 |

协调器支持带输入/输出版本的 checkpoint。持久步骤只有在凭据匹配且 `verify()` 确认产物后才能跳过；普通进程装配步骤每次启动都执行。当前生产入口以“打开存储所有者”“检查并恢复 Runtime”“准备 Web/TLS”“开放 Admission”四个步骤装配；开放运行前，业务接口和 readiness 返回 503。Session 重置凭据与 Profile 标记由各自所有者维护，并未把所有数据迁移拆成协调器 checkpoint。

## 2. 每次升级的固定流程

1. **确定目标与差异。** 运行 `pnpm dsh:check-update`，再运行 `pnpm dsh:plan-upgrade --target <精确版本>`。记录退出发布族的包、公开入口和 peer 差异，冻结目标；调查期间不自动追随新版本。
2. **冻结基线。** 使用合成旧数据覆盖当前 Session/设置格式、活动 Episode、积压入站、已提交出站、创造任务与启用扩展。保留支持范围内的旧 fixture；中间实现不得打开常驻数据根。
3. **登记兼容处理。** 对每个变化的数据所有者选择保留、公开迁移或已经明确授权的重置；未知格式拒绝启动。迁移身份不能只用产品 commit，避免修复版再次重置新会话。
4. **同步整个矩阵。** 更新清单、manifest、lockfile、workspace overrides、Host roster、Client bundle、SDK 和构建依赖。运行 `check:dsh-family`；缺失的旧包必须找到实际替代接入，不能保留无消费者例外。
5. **适配并局部验证。** 只用 DSH 公开 API。优先处理 Session、配置、动态 Runner 和 Client 装配边界；保留 NXT 消息、Revision、权限与真实提交点语义。
6. **验收候选。** 先跑相关所有者测试和 `test:upgrade`，再执行 `verify:product`、升级/恢复生产旅程和双宿主产物检查。安装依赖后完整重启 Web 与 Server，避免 `?raw` bundle 残留旧解析路径。
7. **切换与检查。** 停止旧宿主，保留原完整程序包和独立备份；新宿主创建恢复点并恢复 Runtime。检查匹配 Release 的 `/health/ready`、认证快照、隔离原因与实际聊天。正式发布仍走[发布规范](09-正式发布与更新日志规范.md)。

跨平台候选验证复用 CI 的 `upgrade-candidates`。在非 `main` 升级分支手动触发 CI，质量和 Node 兼容检查通过后，会在 macOS、Windows、Linux 分别运行 `test:upgrade` 并构建完整 Desktop Preview，执行最终打包目录的 Host 验证。候选只保存为短期 Actions artifact，不创建产品 Release；`main` 的既有 Preview 与正式发布流程保持独立。

## 3. 当前 Session 与设置迁移

本次接受自动重置旧模型上下文，不要求旧 DSH Session 连续：已识别的 SQLite schema 15/17 经所有权、完整性和快照校验后归档，切换到 `dsh/sessions/` 下的 JSONL V4。迁移身份包含旧库与 WAL 的内容身份；Core 用该身份登记一次性重置凭据。重试或后续产品修复版不重复退休已经新建的会话。

Core 在同一事务中关闭旧活动 Episode、取消 pending/claimed Admission、中断未完成创造任务，并为现有绑定保存入站事件边界。聊天与附件、智能体及 Revision、Binding、扩展源码、安装与启用意图仍保留，Binding 创建时间不变。边界之前的积压消息不自动补答；下一条符合触发策略的新消息进入新 Episode，不恢复旧摘要、旧子智能体或旧运行身份。

出站投递继续按持久记录恢复：成功投递不重发，不确定投递不盲目重试；不重跑旧模型工具。归档的 Session 与未保存候选源码保留，不能据此认为旧执行轨迹仍可在线续跑。

正常关闭还会在 `dsh/shutdown-inbox/<Session摘要>.json` 暂存 pending inbox：先以 `keepInbox` 取消并等待静止，写 journal 后再释放会清空 inbox 的上游句柄；下次 `agent/created` 通过公开 `inbox.append()` 按消息 ID 去重恢复，flush 后删除。这是必须纳入完整备份的关闭事务暂存，不是第二套长期会话库，也不恢复升级已退休的 Session。

设置从旧 `dsh/settings.yaml` 转为 `dsh/host-profile/` 下 NXT 拥有的稳定 Loader/Profile 入口。旧文档保留，Profile 与迁移标记一起发布，凭据引用及 `dsh/.credentials.yaml` 不搬入普通配置。无法转换的条目隔离；不猜测替代模型或多模态能力。非法整份配置没有可靠条目边界时拒绝启动，不以空配置覆盖。

## 4. 启动、备份与隔离

进程生命周期锁覆盖正常运行和离线恢复，升级锁覆盖协调器执行。恢复点在存储所有者打开前创建，覆盖持久数据与明确配置的外置智能体工作区；排除项、恢复步骤和使用限制见[升级、备份与恢复](guide/upgrade-backup.md)。同一次升级的重试复用已校验的恢复点；完成恢复后再次安装同一目标版本，会创建下一代恢复点，保护恢复之后新增的数据。恢复点不能替代持续增量备份。

必需服务失败阻止启动。可选扩展或模型配置不兼容时保留安装、启用与配置事实，隔离失败对象；不能确认失败资源已经静止时仍属于宿主失败。隔离不是进程沙箱，不承诺容忍同进程插件造成的进程崩溃。

`RuntimeCompatibilityDiagnostic` 用对象、版本、配置修订和环境指纹标识检查结果，记录阶段、原因、可重试性与时间。相同失败身份可抑制重复恢复；配置、版本或环境变化应重新检查。旧环境的验证证据不改写成新环境兼容证明。

认证快照的可选 `upgrade` 汇总运行版本、Session 兼容标识、本次启动是否重置上下文及诊断。`POST /api/runtime/compatibility/retry` 接收 `{ objectKind, objectId }`，执行所有者的实际检查/恢复后返回 `{ diagnostics }`；Web 随后重新读取快照。供应商重试使用保留的当前配置，不擅自改模型。扩展 ID 保持 `extensionId`，智能体关联由配置修订标识区分；请求可能重试该扩展的多个现有启用关系。不能重试的状态由服务端报错，按钮不能只清除提示。

Desktop 与 Server 共用 Server 入口。Server 在 Runtime 恢复后才建立业务 HTTP 服务；Desktop 还必须等到 HTTP readiness 返回同包 Release。升级进度与心跳不能替代最终 readiness。Desktop 普通启动限时 60 秒，升级心跳失联超过 60 秒失败，120 秒没有阶段/步骤/计数变化显示停滞提示；取消在安全边界退出。详见 [Desktop](../apps/desktop/README.md)。

Web 只比较当前页面所属实例的 Release。构建时注入与同包 Server 相同的 `NEKRO_RELEASE_ID`；旧页面在版本不匹配时保留当前输入并停止写操作。频道草稿可在同一标签页刷新恢复，其他未保存表单需在刷新前复制；这不是全部表单的自动迁移机制。

## 5. 验收要求与实现限制

必须覆盖空数据根、已支持旧格式、未知格式拒绝、重复启动、备份损坏/空间不足、各持久提交边界中断、离线恢复，以及合成 A→B→C 中兼容保留与明确重置的区别。还要检查积压不补答、出站不重复、坏扩展不拖垮其他对象、旧审批不提交、配置修复重试和动态创造冷启动恢复。

`test:upgrade` 当前未聚合 Core 重置、Profile、全部隔离与双宿主产物测试，需分别运行相关测试。生产旅程必须使用真实页面；Server 候选容器与 Desktop 各平台产物还需验证 JSONL 依赖、凭据、插件安装/恢复/卸载、健康身份和退出释放。存在测试代码、单测通过或生产构建成功，都不代表这些产物已验收。

目前仍需关注以下边界，不能在交付说明中写成已经消除：

- 生产入口会从已有 `dsh/runtime-identity.json` 读取源环境指纹并写入恢复点；旧版本没有该身份文件时仍缺少源身份。恢复不会自动选择或安装旧程序，部署方必须保留对应完整包与版本记录。稳定迁移 ID 仍是备份接口的可选输入，当前生产恢复点按目标 Release 创建。
- 恢复实现已支持按 manifest 读取外置根并用配置的工作区父目录验证范围；当前 CLI 入口仍从 Core 重新推导并显式传入根目录。Core 损坏、已被移走或智能体目录变化时，这条入口仍可能拒绝续跑，需要完成接线和对应中断验证。
- 生产流程在独立 activation 步骤开放 Admission，之后才建立 HTTP 服务。最终 HTTP 启动失败前可能已有运行活动；因此不能把就绪失败后的数据自动回滚描述为安全操作。
- 通用协调器 checkpoint 已有合成跨版本覆盖；具体所有者和最终产物仍需逐版本验收，不宣称一次测试覆盖未来全部 DSH 升级。
