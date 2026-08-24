# QQ OpenClaw Adapter

本包拥有 QQ 官方机器人 OpenClaw 的平台协议、结构化 Mention、Markdown 分片、被动回复额度、Gateway 恢复、REST 发送和分片媒体上传。它只通过 Adapter SDK 向 Channel Runtime 提交事实，不读取 Core/DSH 数据库。

平台 OpenID 始终由 Connection 作用域的 Directory 解析；通信工具提供的 `memberId` 在发送前转换为 `<@openid>`，旧 `[@id:...]` 只按普通文本处理。视频继续使用通用 file Part。

主要公共边界：

- `QQOpenClawRuntime`：组合 Connection、Gateway 与可靠停机；
- `QQOpenClawHttpTransport`：Credential Reference、Token、REST 与上传；
- `QQNodeWebSocketFactory`：Desktop/Server 共用的 Node WebSocket；
- `decodeQQInboundMessage`：三类 QQ 消息 dispatch 的确定性规范化，保留正文中的 Mention token，并把卡片/小程序/转发编成 `rich`；
- `splitQQContentAtoms`：按原文位置把 Mention 切成有序 content atom，供入站 `parts` 使用；
- `parseQQCardDump` / `parseQQChatRecordDump` / `parseQQRichPayload`：把 `[卡片消息]` 倾倒、`[群聊的聊天记录] === 消息 N ===` 拍扁转发、embed 和 ark 编成可兜底的 rich 载荷；
- `createQQGatewayCheckpointStore`：Connection 作用域 resume 状态。

产品 Host 通过 `QQCoreBridge` 接入 Core 身份、Quote 和两阶段 Asset，并通过 Host-owned Credential Resolver 提供 Secret。无密钥测试覆盖真实生产组合根但替换外部网络边界；通知高亮、平台额度和真实 CDN/上传仍必须使用专用 QQ 账号验收。

QQ 引用只在当前 Connection 和 Channel 内把平台引用映射为 `logicalMessageId`。`message_type` 表示回复但缺少引用字段、或平台引用无法命中已持久消息时，Adapter 发布不包含原始 payload、平台消息 ID 或成员标识的原因诊断；入站正文继续提交，但不伪造 quote。
