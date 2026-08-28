# NekroNXT 决策路由

本索引承接[公开知识路由](../README.md)，按任务主题进入仍有效的跨包决定。`accepted` 表示设计已确认但可能尚未完全落地，`implemented` 表示代码已经实现的当前契约。模板、状态流转与写作规则见[开发与测试规范](../06-开发与测试规范.md)；普通局部修复不新增 Decision。

## 产品界面、用户路径与交付

- 技术栈、React、组件与测试基础设施：[一期技术栈与 UI 基础设施](accepted/2026-08-16-一期技术栈与UI基础设施.md)。
- 生产页面旅程门禁：[Web 产品旅程交付门禁](implemented/2026-08-17-Web产品旅程交付门禁.md)。
- 像素级画面验收：[用户可见界面视觉验收](implemented/2026-08-21-用户可见界面视觉验收.md)。
- Desktop、Server、版本与产物身份：[原子产品 Release 与双宿主分发](accepted/2026-08-21-原子产品Release与双宿主分发.md)。
- 公开展示名、兼容身份、品牌权利与 Host 产品元数据：[产品身份与公开元数据](implemented/2026-08-24-产品身份与公开元数据.md)。
- Desktop 多实例、可信浮层、自动 TLS 与设备鉴权：[Desktop 多实例与设备鉴权](implemented/2026-08-23-Desktop多实例与设备鉴权.md)。
- 内置频道来源、上下文操作和实体删除：[内置频道与实体删除语义](implemented/2026-08-22-内置频道与实体删除语义.md)。
- 平台用户目录和人设结构化引用：[平台用户目录与人设实体引用](implemented/2026-08-23-平台用户目录与人设实体引用.md)。

## 消息、频道与运行轨迹

- Channel Runtime、Episode、Admission 与 Outbox：[Channel Runtime 与会话组织](implemented/2026-08-15-Channel-Runtime与会话组织.md)。
- 用户可见发送的唯一出口：[统一使用通信工具发送用户消息](implemented/2026-08-15-统一使用通信工具发送用户消息.md)。
- Asset、内容寻址和图片理解：[内容寻址资源与图片理解](implemented/2026-08-16-内容寻址资源与图片理解.md)。
- Handoff 失败和最近消息恢复：[Handoff 失败降级与最近窗口恢复](implemented/2026-08-18-Handoff失败降级与最近窗口恢复.md)。
- 智能体多频道与频道唯一响应者：[智能体多频道与频道唯一绑定](implemented/2026-08-18-智能体多频道与频道唯一绑定.md)。
- Channel、Episode 和交接事实来源：[频道身份与 Episode 交接来源修复](implemented/2026-08-18-频道身份与Episode交接来源修复.md)。
- 频道通信工具与 DSH 子智能体工具命名：[频道通信工具与 DSH 子智能体工具分名](implemented/2026-08-18-频道通信工具与DSH子智能体工具分名.md)。
- SSE、首载、回放和轨迹数据面：[SSE 消息与轨迹数据面](implemented/2026-08-20-SSE消息与轨迹数据面.md)。
- 运行占用、耗时和缓存投影：[频道运行占用与耗时投影](implemented/2026-08-20-频道运行占用与耗时投影.md)。

## DSH、模型与扩展

- DSH 受管包、Host/智能体 Loader、来源和加载诊断：[DSH 能力插件优先兼容与受管加载](implemented/2026-08-18-DSH能力插件优先兼容与支持识别.md)。
- DSH Session、Tool、Handoff 与群聊组合：[DSH 0.1.1 群聊能力组合](implemented/2026-08-18-DSH-0.1.1群聊能力组合.md)。
- 模型供应商目录和配置来源：[复用 DSH 模型供应商目录](implemented/2026-08-17-复用DSH模型供应商目录.md)。
- 动态包、保存版本与 Activation：[本地扩展持久化](implemented/2026-08-15-本地扩展持久化.md)。
- Adapter Contribution、宿主安装和富消息产品 Slot：[适配器 Host 贡献与产品 Slot](implemented/2026-08-20-适配器Host贡献与产品Slot.md)。

## Adapter、连接与绑定

- OneBot 11 正向 WebSocket、特殊事件、处理中反馈和安全互动：[OneBot 11 正向 WebSocket 适配器](implemented/2026-08-26-OneBot11正向WebSocket适配器.md)。
- 企业微信官方长连接、流式反馈、媒体安全和无消息 ID 回执：[企业微信智能机器人长连接适配器](implemented/2026-08-27-企业微信智能机器人长连接适配器.md)。
- QQ OpenClaw 平台协议与真实验收边界：[首个 QQ OpenClaw Adapter](accepted/2026-08-15-首个QQ-OpenClaw-Adapter.md)。
- 凭据存储、QQ Connection 和宿主职责：[本地凭据与 QQ 连接宿主](implemented/2026-08-17-本地凭据与QQ连接宿主.md)。
- 平台目录与通用 Connection 表单：[连接平台目录与通用配置表单](implemented/2026-08-17-连接平台目录与通用配置表单.md)。
- 绑定闭环和未实现操作门禁：[频道绑定闭环与空操作门禁](implemented/2026-08-17-频道绑定闭环与空操作门禁.md)。

## 数据、版本与迁移

- 客户端状态与宿主迁移步骤：[客户端状态与数据迁移基础设施](accepted/2026-08-16-客户端状态与数据迁移基础设施.md)。
- 智能体能力授权的持久格式：[AgentRevision 能力格式](implemented/2026-08-18-AgentRevision能力格式.md)。
- Core SQLite 基线、备份与类型安全重建：[Core 数据库基线与类型安全重建](implemented/2026-08-18-Core数据库基线与类型安全重建.md)。

需要追溯被替代的旧决定时，从[归档索引](../archive/README.md)进入；归档文件不参与当前冲突裁决。
