# OneBot 11 Adapter

该包实现 OneBot 11 正向 Universal WebSocket 客户端。NekroNXT 通过标准协议接入独立运行的 SnowLuma、NapCat、LLBot 等协议端；协议端安装与账号登录由其官方工具完成。

Connection 只保存 `endpoint`、可选 Access Token 凭据引用和事件采集开关。标准消息与通知按 OneBot 11 映射；`set_msg_emoji_like`、`send_poke` 等扩展 Action 通过真实调用探测并按 Connection 缓存，不根据 `app_name` 改变行为。

入站媒体允许协议端提供的公网 HTTP 或 HTTPS URL，同时拒绝 URL 凭据、重定向和私网目标。成员进退等通知读取 `sub_type` 和参与者字段，并通过 `get_group_member_info` / `get_stranger_info` 补全显示名称；邀请人、操作者、目标成员、持续时间和新旧值等协议端已提供的信息会进入结构化频道系统事实，不压成泛化摘要，也不把平台 ID 显示给用户。

首版只支持正向 WebSocket，不支持反向 WebSocket、HTTP + Webhook、OneBot 12 或 raw Action 透传。
