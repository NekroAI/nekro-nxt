# 首个外部 Adapter：QQ OpenClaw

状态：accepted

首个外部 Adapter 是 QQ 官方机器人 OpenClaw 渠道，实现位于 `packages/adapter-qq-openclaw`。一个 Connection 对应一个机器人账号，Transport 为 WebSocket。

## 现行契约

- 支持 C2C 与群频道；文本、结构化 Mention、图片、文件、音频和引用入库；视频作为普通 file；
- Mention 只接受 `memberId`。Adapter 解析同一 Connection 的 OpenID，Markdown 输出 `<@openid>`，不把 `@昵称` 当发送协议；
- 身份拆成 Connection 范围内的 `PlatformIdentity` 与频道内 `ChannelMember`；
- Adapter 只报告 `mentionedBot`、`replyToBot` 等平台事实；是否触发由 Binding 策略决定：`always`、`mentioned-or-replied`、`command`、`observe-only`；
- 有有效被动回复额度时优先被动回复，否则按 Connection 配置降级主动发送；部分成功与未知结果不能标成已发送；
- 凭据只写保存，快照只显示是否已配置。频道由真实 Gateway 事件发现。

真实账号的通知高亮、额度、媒体上传和回执验收尚未完成，见 `docs/04-一期开发计划与决策清单.md`。Webhook、多账号 UI、`@全体成员` 和专用视频类型未开放。
