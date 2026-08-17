# QQ OpenClaw Adapter

本包拥有 QQ 官方机器人 OpenClaw 的平台协议、结构化 Mention、Markdown 分片、被动回复额度、Gateway 恢复、REST 发送和分片媒体上传。它只通过 Adapter SDK 向 Channel Runtime 提交事实，不读取 Core/DSH 数据库。

平台 OpenID 始终由 Connection 作用域的 Directory 解析；通信工具提供的 `memberId` 在发送前转换为 `<@openid>`，旧 `[@id:...]` 只按普通文本处理。视频继续使用通用 file Part。

主要公共边界：

- `QQOpenClawRuntime`：组合 Connection、Gateway 与可靠停机；
- `QQOpenClawHttpTransport`：Credential Reference、Token、REST 与上传；
- `QQNodeWebSocketFactory`：Desktop/Server 共用的 Node WebSocket；
- `decodeQQInboundMessage`：三类 QQ 消息 dispatch 的确定性规范化；
- `createQQGatewayCheckpointStore`：Connection 作用域 resume 状态。

产品 Host 通过 `QQCoreBridge` 接入 Core 身份、Quote 和两阶段 Asset，并通过 Host-owned Credential Resolver 提供 Secret。无密钥测试覆盖真实生产组合根但替换外部网络边界；通知高亮、平台额度和真实 CDN/上传仍必须使用专用 QQ 账号验收。
