# 已实施：M5 QQ OpenClaw Adapter 离线实现

> 归档日期：2026-08-19。过程日记，已冻结，不是现行规范。

状态：implemented

## 结论

QQ OpenClaw Adapter 的无凭据实现已经形成完整离线闭环：Gateway、REST Token 与发送、C2C/群入站、Connection 作用域身份、结构化 Mention、Quote、媒体、被动回复额度、重放、故障分类和静止停机均有可执行证据。真实 QQ 账号、专用测试群和产品配置/诊断页面仍是明确的外部验收与 M6 UI 工作，不在本记录中伪造完成。

## 平台与协议边界

- 一个 Connection 对应一个 QQ 机器人账号；Secret 只以 `clientSecretCredentialRef` 出现在普通配置中；
- Node WebSocket 实现支持 Hello、Identify、Resume、Heartbeat/ACK、Reconnect、Invalid Session、READY/RESUMED 和指数重连；
- Gateway Session checkpoint 使用 Connection 命名空间的受控 SQLite runtime state，App ID 不符、过期或损坏时清理；
- dispatch 只有在 Channel fact/checkpoint 提交后才推进；未提交事件立即重连，不会被后续序号越过；重复和迟到序号不会再次 dispatch 或让 checkpoint 回退；
- 确定性毒事件默认最多重试三次，然后以截断、脱敏摘要进入 quarantine 回调并推进，避免单条坏 payload 永久阻塞 Connection；
- 原始事件解码覆盖 `C2C_MESSAGE_CREATE`、`GROUP_AT_MESSAGE_CREATE` 和 `GROUP_MESSAGE_CREATE`，包括 OpenID、Mention、附件、时间戳、`message_scene.ext` 与 quote `msg_elements` 优先级；
- 普通群消息始终进入事实流，`mentionedBot`、`replyToBot` 和 `targetKind` 只作为 Binding Policy 输入，Adapter 不替智能体决定触发；
- 机器人自身 Mention 从显示文本移除并保留触发事实；其他 Mention 转成稳定 `memberId`。出站只接受结构化 Mention 并输出原子 `<@openid>`，旧 `[@id:...]` 永远是普通文本；
- Server 产品投影通过成员目录补充群消息发送者和 Mention 昵称，Web 不再把所有外部成员显示为“你”，也不展示 `memberId` 或 OpenID；DSH 准入消息同时包含发送者名称、稳定成员标识、成员 Mention 和“提及机器人账号”事实，因此触发语义不会在进入智能体上下文前丢失；
- QQ 平台表情标记先降级为可读的“QQ 表情”，历史数据在 Web 投影时同样脱敏，不再泄漏 `<faceType=...>` 协议文本；
- 视频沿用通用 file Part，不增加专用类型或虚假的视频理解能力。

## 身份、Quote 与媒体

- Core 新增 `PlatformIdentity` 和 `ChannelMember`：唯一键分别为 `(connectionId, platformUserId)` 与 `(channelId, platformIdentityId)`，记录首次、最近出现时间和次数；
- Core 在入站提交前验证 sender member 属于目标 Channel；跨 Connection 的 memberId 不能解析或发送；
- 入站和出站均具有规范 `LogicalMessageId`。平台 message ID 与逻辑 ID 的双向映射由 Core/Receipt 查询提供，平台私有 ID 只进入 PhysicalDelivery 的 `adapterContext`；
- Quote planner 在 Outbox 提交前完成映射，不能引用未知消息或多个不同目标；被动额度不足以覆盖整个物理消息组时，整组选择主动发送或在提交前失败，不混用两种模式；
- 远端媒体只允许 HTTPS 且禁止重定向，响应头和实际字节均受大小上限；
- 媒体采用两阶段提交：先按内容摘要预留规范 Asset ID，Channel Event 提交后再完成 blob 与确定性 Occurrence；崩溃重放补齐同一阶段，不产生第二份 blob 或重复 receive count；
- 图片按实际字节 MIME 进入 image，音频进入 audio，视频与其他内容进入 file；文件名和声明 MIME 只作为 Occurrence 元数据。

## REST、上传与失败语义

- Token 按有效期缓存，并在 401 后只刷新重试一次；认证请求、API 请求和错误摘要不记录 Secret 或 Token；
- 文字支持 Markdown/纯文本，Mention Token 不拆分，代码围栏跨分片关闭与重开；发送前同时校验平台字符上限和最终 UTF-8 字节上限；
- 媒体实现 `upload_prepare`、预签名 part PUT、`upload_part_finish`、`files` 和最终 media message；计算协议要求的 MD5、SHA1 与首段 MD5；
- 401/403、429、永久 4xx、可重试失败和请求可能已提交分别映射为 `authentication`、`rate-limited`、`permanent`、`transient` 与 `unknown`；`Retry-After` 转成结构化毫秒；
- 上传成功不等于消息成功；发送响应丢失返回 `unknown`，Channel Runtime 不盲目自动重发；
- 被动 reply quota 先保留、成功或未知时消费、确定失败时释放；`msg_seq` 一旦保留就不复用，Gateway 重放不会重置已消费额度。

## 持久格式与接缝

Core SQLite schema 当前升级到版本 13，新增：

- `platform_identities`、`channel_members`；
- `adapter_runtime_states`；
- 入站 `logical_message_id`；
- PhysicalDelivery `adapter_context_json`。

Adapter 不读取这些表。`QQCoreBridge` 只调用 Core Service，远端媒体只调用 Asset Service；Server 和未来 Desktop Host 可以复用相同边界。

## 验证证据

- QQ 包覆盖原始解码、Mention、Quote、额度、HTTP、分片上传、WebSocket、Gateway resume/重复/迟到/毒事件和组合 Runtime；
- 同一事件重放 100 次只产生一个 Channel Event；同一媒体重放只保留一个 blob、一个 Occurrence 和一次 receive count；
- Token 过期、429、响应丢失、跨 Connection member、视频 file、三条物理消息第二条失败均有无密钥测试；
- Runtime 停止会等待 Gateway 与 Transport 静止；
- 当前全仓共有 22 个测试文件、86 项测试，`pnpm check`、`pnpm test` 与 `pnpm build` 通过。

## 后续进展与真实环境边界

- Connection 表单、一次性 Credential 录入、Gateway 状态、已知 Channel、收发测试、重启恢复和可操作错误已经由后续 Server 组合根实现，见 `../accepted/2026-08-17-本地凭据与QQ连接宿主.md`；
- 使用专用 QQ 账号与测试群验证真正的通知高亮、平台额度、断网恢复、C2C/群收发和实际 CDN/上传响应；
- 真实平台验收可能校准默认字符、字节、文件大小和 TTL，但不得改变结构化 MessagePart、身份作用域、失败联合或 checkpoint 提交顺序。

## 未来方向与参考取舍

关联方向：更多 Adapter、多媒体、智能体多频道、长期 Job、Webhook 和多账号管理。

保留接缝：Adapter SDK、Connection runtime state、双向消息映射、声明式配置、可选 UI Slot、Transport/Directory/Asset Bridge 和平台无关 Outbox。没有把 QQ OpenID、Markdown、Gateway sequence 或上传对象写进 Core 通用消息，因此未锁死其他平台。

本次明确不提前实现：Webhook、完整成员同步、`@昵称` 模糊猜测、专用 video Part、STT/TTS、按钮卡片、平台命令和旧项目数据导入。

参考 Nekro Agent `qqbot_openclaw`、Issue #321 和腾讯 `openclaw-qqbot` v2.0.1；借鉴 Gateway opcode、OpenID、`ref_idx/msg_idx`、上传协议、被动额度与群消息经验；拒绝 Python API、chat key、本地路径媒体、同步 JSON 状态、文本 AT 协议和布尔发送结果。
