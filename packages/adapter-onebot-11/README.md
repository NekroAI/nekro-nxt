# OneBot 11 Adapter

该包实现 OneBot 11 正向 Universal WebSocket 客户端。NekroNXT 通过标准协议接入独立运行的 SnowLuma、NapCat、LLBot 等协议端；协议端安装与账号登录由其官方工具完成。

Connection 只保存 `endpoint`、可选 Access Token 凭据引用和事件采集开关。标准消息与通知按 OneBot 11 映射；`set_msg_emoji_like`、`send_poke` 等扩展 Action 通过真实调用探测并按 Connection 缓存，不根据 `app_name` 改变行为。

入站媒体允许协议端提供的公网 HTTP 或 HTTPS URL，同时拒绝 URL 凭据、重定向和私网目标。成员进退等频道通知读取 `sub_type` 和参与者字段，并通过 `get_group_member_info` / `get_stranger_info` 补全显示名称；邀请人、操作者、目标成员、持续时间和新旧值等协议端已提供的信息会进入结构化频道系统事实，不压成泛化摘要，也不把平台 ID 显示给用户。

Descriptor 分别声明 Channel 活动和 Connection 活动。好友新增、账号资料获赞等账号事实走 `acceptConnectionInbound`，只确保 Connection Identity 并写连接活动，不创建私聊频道或 ChannelMember，也不触发智能体；成员、撤回、回应和文件等频道事实继续走 `acceptChannelInbound`。

这些 Channel 活动的触发默认值属于具体 Connection，不属于 OneBot Adapter 类型本身；同一 Adapter 创建的两个连接可以分别设置。单个群聊或私聊使用三态覆盖，缺省跟随所属 Connection。

首版只支持正向 WebSocket，不支持反向 WebSocket、HTTP + Webhook、OneBot 12 或 raw Action 透传。

平台动作：`like_member`（`send_like`，私聊与群聊）、`mute_member`（`set_group_ban`，0 秒解除）、`kick_member`（`set_group_kick`）、`set_member_card`（`set_group_card`）和 `set_essence_message`（`set_essence_msg`），除点赞外均为 `admin` 级。原始透传调用 OneBot 动作，群聊中缺少 `group_id` 时补上当前群号；会改变连接本身的动作（重启、清缓存、修改登录信息与账号资料等）在黑名单中直接拒绝。
