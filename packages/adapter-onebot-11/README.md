# OneBot 11 Adapter

该包实现 OneBot 11 正向 Universal WebSocket 客户端。NekroNXT 通过标准协议接入独立运行的 SnowLuma、NapCat、LLBot 等协议端；协议端安装与账号登录由其官方工具完成。

Connection 只保存 `endpoint`、可选 Access Token 凭据引用和事件采集开关。标准消息与通知按 OneBot 11 映射；`set_msg_emoji_like`、`send_poke` 等扩展 Action 通过真实调用探测并按 Connection 缓存，不根据 `app_name` 改变行为。

首版只支持正向 WebSocket，不支持反向 WebSocket、HTTP + Webhook、OneBot 12 或 raw Action 透传。
