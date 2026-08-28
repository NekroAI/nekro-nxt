# OneBot 11 正向 WebSocket 适配器

状态：implemented

## 结论

NekroNXT 通过 `@nekro-nxt/adapter-onebot-11` 连接用户独立部署的 OneBot 11 协议端。Host 只作为正向 Universal WebSocket 客户端，不识别、下载、启动、升级或控制 SnowLuma、NapCat、LLBot 等具体实现，也不根据 `app_name` 改变协议行为。

Connection 只配置完整 `ws://` 或 `wss://` Endpoint、可选只写 Access Token，以及戳一戳和普通消息回应的采集开关。Access Token 由 Host Credential Store 保存，Core 只持久化引用；WebSocket 使用 `Authorization: Bearer`。一个 Connection 首次成功连接后把 `self_id` 锁进 Connection 命名空间状态，Endpoint 后续切换账号时进入失败状态，避免把既有频道静默归给另一个账号。

首版不支持反向 WebSocket、HTTP API + Webhook、OneBot 12、CQ 字符串解析或 raw Action 透传。

## Adapter Host 边界

`AdapterConnectionContext` 向 Adapter 提供受限服务：创建或解析频道和成员、平台消息与逻辑消息双向映射、导入和读取已授权 Asset、解析 Credential Reference、读写 Connection 命名空间状态、发布连接诊断。Adapter 不获得 Core、Repository、SQLite、宿主路径或任意文件访问。

Server 用 Adapter Driver 目录统一分派用户创建、冷启动挂载、测试与停止。`qq-openclaw` 和 `onebot-11` 都通过该目录注册；新增 Adapter 不在公共创建和恢复流程增加 `adapterKey` 判断。

## 消息和媒体

群聊平台频道 ID 为 `group:<group_id>`，私聊为 `private:<user_id>`。`text`、`at`、`image`、`record`、`reply` 映射公共 `MessagePart`；`json`、`xml`、`markdown`、`keyboard`、`mface`、未知段和无法解析的引用使用安全 `rich` 摘要。合并转发通过 `get_forward_msg` 展开，最多 50 个节点和 64 KiB 结构化摘要，不保存平台原始 dump。

协议端必须上报数组消息。字符串消息不会解析 CQ 码，只产生 `invalid-message-format` 富消息和连接诊断。

入站图片和语音接受协议端给出的公网 HTTP 或 HTTPS URL，因为 SnowLuma 等 OneBot 实现会生成 HTTP 媒体地址。Host 仍禁止 URL 凭据、重定向和私网目标，并在流式读取期间执行 20 MiB 上限，再导入内容寻址 Asset；OneBot 对公网 HTTP 的允许是单次显式选择，不改变其他 Adapter 默认只接受 HTTPS 的策略。出站图片和音频从当前频道已授权 Asset 字节生成 `base64://`，不使用路径、`file://` 或共享卷。普通发送使用消息段数组和 `send_group_msg` / `send_private_msg`，回执缺少 `message_id` 时结果为 `unknown`。

## 特殊事件与 Binding

公共 `ChannelActivityType` 覆盖戳一戳、资料卡点赞、成员进退、禁言、管理员、名片、头衔、频道名称、撤回、消息回应、群文件、精华和好友新增。特殊事件追加关系事实，使用 `targetPlatformMessageId` 解析 `targetLogicalMessageId`；不会删除或改写原始消息事实。

OneBot 通知中的 `sub_type`、`user_id`、`operator_id`、`sender_id`、`target_id`、禁言时长、名片新旧值、频道新名称和文件元数据按各自语义保存。Adapter 优先调用 `get_group_member_info` 补全群名片或昵称，成员已离群等失败场景再调用 `get_stranger_info`，两者都失败时使用不泄漏平台 ID 的中性称呼。参与者保存为 `mention` part 和稳定成员关系；Host 快照将事件投影为系统消息，客户端在低噪声状态行中原位显示参与者名称，不显示成员头像、发送者标题、普通消息气泡或富卡片。

Binding 持久化 `processingFeedback: auto | off` 和逐项 `eventTriggers`。迁移后默认 `auto` 与空事件列表。普通 `triggerPolicy` 只决定普通消息；特殊事件只有明确列入 `eventTriggers` 才触发智能体，`observe-only` 始终不触发。

`capturePokeEvents` 默认开启，`captureMessageReactionEvents` 默认关闭。Host 自己添加或移除的处理中回应按账号、消息、表情和短期窗口抑制，不进入事实流。Host 主动撤回成功后会立即写入本地关系事实，同一次操作的平台撤回回流通知会被短期抑制，避免重复展示。

## 处理中反馈和互动工具

真正触发群聊 Admission 时，Channel Runtime 在平台调用前把 Feedback Lease 写入 Connection 命名空间状态，再调用 `set_msg_emoji_like` 添加表情 `212`。DSH Session 空闲、Admission 失败或 Host 停止时移除；进程重启后先恢复清理遗留 Lease。清理失败使用有限退避，24 小时后不再重试。明确不支持 Action 时缓存为不支持并停用该 Connection 后续反馈；网络错误不会被缓存成不支持。私聊不发送降级文本。

OneBot Connection 的智能体会话按运行时能力注册两个工具：

- `retract_channel_message(logicalMessageId)` 只能撤回当前频道中同一智能体自己发送且已有成功物理回执的消息，多段投递逐条处理并报告完整、部分、失败或未知；成功后追加本地撤回关系事实。
- `nudge_channel_member(memberId)` 只能作用于当前频道已知成员；同一成员 30 秒冷却，每频道每分钟最多三次。

互动在 Connection 命名空间状态中按 `clientRequestId` 持久化 `planned → sending → settled`。Host 重启时未结算的互动变为 `unknown`，不自动重试用户可见副作用。

## 传输与能力探测

Action 使用 Connection 前缀和随机 ID 作为 `echo`，响应与事件在同一 Socket 分流。Action 回执即时解析，入站事件按帧顺序串行提交给 Host；旧 Socket 的延迟回调不能改写新连接状态。请求默认 15 秒超时；写入后断线或超时记为未知。连接按 1、2、4 秒起步并最高 30 秒持续重连；`stop()` 清除定时器、关闭 Socket、拒绝待定请求，并等待已接收事件处理完成。单帧上限 16 MiB，二进制帧被拒绝。

连接后调用 `get_login_info` 与 `get_version_info`。版本信息只用于诊断。`set_msg_emoji_like` 和 `send_poke` 通过真实 Action 回执探测；只有明确的 unknown-action / unsupported 回执才缓存为不支持。

## 兼容状态

| 协议端基线 | 当前状态 | 证据 |
|---|---|---|
| SnowLuma v1.9.13 | 可加载但未完成真实账号验收 | 合成字段夹具、标准/扩展 Action 契约和自动化 WebSocket 测试 |
| NapCat 4.18.19 | 可加载但未验证 | 合成字段夹具与扩展 Action 契约 |
| LLBot 8.1.9 | 可加载但未验证 | 合成字段夹具与扩展 Action 契约 |

“可加载”不等于“已验证支持”。SnowLuma v1.9.13 的本地正向 WS + Token、群聊/私聊/临时会话、媒体、转发、卡片、处理中回应、撤回、戳一戳、特殊事件、断网和重启清理仍是发布前真实验收硬门槛。没有独立测试账号和该环境时，不得把状态改为“已验证”。

本实现只做协议互操作，不复制或捆绑协议端代码和二进制。SnowLuma 与 NapCat 的公开许可包含商业使用限制；LLBot 为 GPL-2.0。它们不是 NekroNXT 的依赖或分发组成部分。

## 明确未实现

首版不主动发送文件、任意表情回应、群卡片、AI 语音、公告、签到、精华或群管理操作。群文件通知会尝试通过 `get_group_file_url` 安全导入 Asset，失败时只保存文件名等摘要；需要主动文件发送、卡片发送或管理能力时，应新增受限 Contribution 或独立语义工具，不能开放 raw OneBot Action。
