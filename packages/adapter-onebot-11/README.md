# OneBot 11 Adapter

该包实现 OneBot 11 正向 Universal WebSocket 客户端。NekroNXT 不识别、下载、启动或升级具体协议端；SnowLuma、NapCat、LLBot 等实现均作为用户独立部署的外部服务接入。

Connection 只保存 `endpoint`、可选 Access Token 凭据引用和事件采集开关。标准消息与通知按 OneBot 11 映射；`set_msg_emoji_like`、`send_poke` 等扩展 Action 通过真实调用探测并按 Connection 缓存，不根据 `app_name` 改变行为。

首版只支持正向 WebSocket，不支持反向 WebSocket、HTTP + Webhook、OneBot 12 或 raw Action 透传。
