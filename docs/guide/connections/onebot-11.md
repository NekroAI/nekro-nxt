# 接入 OneBot V11

本文介绍如何将 NekroNXT 接入支持 OneBot V11 的 QQ 协议端。协议端负责登录 QQ 并提供 Universal WebSocket Server；NekroNXT 作为 WebSocket 客户端建立连接，并将发现的群聊或私聊绑定给智能体。

```text
QQ 账号
  ↕
SnowLuma / NapCat / LLBot
  ← NekroNXT 主动连接正向 Universal WebSocket Server
  → 发现群聊或私聊 → 绑定智能体
```

NekroNXT 不自动安装或维护协议端。本文覆盖双方的 OneBot V11 连接配置；协议端安装、账号登录与风险控制请参阅对应项目的官方文档。

## 开始前准备

准备以下环境与信息：

- 一个独立运行并已登录 QQ 的 SnowLuma、NapCat 或 LLBot；
- NekroNXT 所在设备或容器能够访问协议端的 WebSocket 监听地址；
- 协议端生成或配置的 Access Token；
- NekroNXT 中至少一个可用的智能体，用于完成频道绑定。

第三方协议端登录可能触发平台安全校验或账号限制。正式接入前，建议使用独立测试账号完成验收，并核对协议端许可及平台规则。

## 协议端共同配置

无论使用哪一种协议端，都应满足以下配置：

| 配置项 | 应选择的值 |
|---|---|
| OneBot 版本 | OneBot V11 |
| 服务模式 | Universal WebSocket Server / 正向 WebSocket |
| 消息格式 | `array`（数组） |
| Access Token | 建议启用，并在 NekroNXT 中配置相同值 |
| 监听地址 | NekroNXT 能够访问的地址 |
| 监听端口 | 任意未占用端口，例如 `3001` |

NekroNXT 作为 WebSocket 客户端主动建立连接，因此协议端需要启用 WebSocket Server。Reverse WebSocket、`ws-reverse` 和 WebSocket Client 属于反向连接模式，不适用于本适配器。

消息格式必须设置为数组。CQ 码字符串会被标记为消息格式错误，其中的文字、图片和 Mention 不进入结构化消息解析。

## 配置 SnowLuma v1.9.13

[SnowLuma v1.9.13](https://github.com/SnowLuma/SnowLuma/releases/tag/v1.9.13) 的 OneBot WebSocket Server 默认配置是：

| 配置项 | 默认值 |
|---|---|
| Host | `0.0.0.0` |
| Port | `3001` |
| Path | `/` |
| Role | `Universal` |
| Message Format | `array` |
| Access Token | 首次配置时自动生成 |

协议端与 NekroNXT 在同一台非容器设备上时，典型 Endpoint 是：

```text
ws://127.0.0.1:3001/
```

末尾的 `/` 是 SnowLuma 默认 Path。Path 配置为 `/onebot/v11` 时，Endpoint 必须保留完整路径：

```text
ws://onebot.example.test:3001/onebot/v11
```

SnowLuma 的 WebUI 默认使用端口 `5099`，OneBot WebSocket 默认使用端口 `3001`。NekroNXT 的 Endpoint 应填写后者。

根据 v1.9.13 发布说明，Linux 版本提供桥接能力，NTQQ 注入在 Windows 上运行。SnowLuma 当前许可对第三方镜像和自动化部署设有约束，因此本教程采用官方发行物作为部署基线。部署前应核对当前许可与发布说明。

## 配置 NapCat 4.18.19

在 NapCat WebUI 中前往「网络配置 → Websocket 服务器 → 新建」，创建 WebSocket Server。启用连接，并设置：

- Host：同机可使用 `127.0.0.1`；跨设备或跨容器时改为实际可达的监听地址；
- Port：例如 `3001`；
- Message Format：`array`；
- Token：保留自动生成的值，或设置一个随机 Token；
- 强制推送事件：开启。

如果使用默认根路径，协议端与 NekroNXT 在同一台非容器设备上的 Endpoint 示例为：

```text
ws://127.0.0.1:3001/
```

连接类型应选择 WebSocket Server。具体界面和字段可能随版本调整，请同时参考 [NapCat 文档](https://napneko.github.io/)与 [v4.18.19 发布说明](https://github.com/NapNeko/NapCatQQ/releases/tag/v4.18.19)。

## 配置 LLBot v8.1.9

在 LLBot WebUI 或配置文件中启用 OneBot 11，并添加 `type: "ws"` 的连接。下面使用虚构配置展示需要的字段：

```json
{
  "ob11": {
    "enable": true,
    "connect": [
      {
        "type": "ws",
        "enable": true,
        "port": 3001,
        "token": "请替换为随机Token",
        "messageFormat": "array"
      }
    ]
  }
}
```

`type: "ws"` 表示 LLBot 监听正向 WebSocket Server，与 NekroNXT 的连接方式匹配。`type: "ws-reverse"` 属于反向连接模式。使用默认根路径并且双方在同一台非容器设备上时，Endpoint 示例为：

```text
ws://127.0.0.1:3001/
```

LLBot WebUI 默认地址为 `http://localhost:3080`；OneBot WebSocket Endpoint 使用连接配置中的端口。跨设备访问需要关闭 `onlyLocalhost`，同时配置 Access Token。具体配置以 [LLBot 配置文档](https://github.com/LLOneBot/LuckyLilliaDoc/blob/main/content/docs/config.mdx)与 [v8.1.9 发布说明](https://github.com/LLOneBot/LuckyLilliaBot/releases/tag/v8.1.9)为准。

## 选择正确的 Endpoint

Endpoint 是 NekroNXT 访问 OneBot WebSocket Server 的完整 `ws://` 或 `wss://` 地址。主机、端口和路径必须与协议端的监听配置一致；WebUI 地址仅用于协议端管理。

| 部署关系 | Endpoint 示例 | 说明 |
|---|---|---|
| 双方在同一台设备，均不在容器内 | `ws://127.0.0.1:3001/` | `127.0.0.1` 指当前设备 |
| NekroNXT 在 Docker，协议端在 macOS/Windows 宿主机 | `ws://host.docker.internal:3001/` | 协议端必须允许来自容器的连接 |
| 双方在同一 Docker 网络 | `ws://onebot-endpoint:3001/` | 使用协议端的 Compose 服务名或容器 DNS 名 |
| 协议端在另一台局域网设备 | `ws://onebot.example.test:3001/` | 示例域名需替换成实际可达主机 |
| 通过 TLS 反向代理 | `wss://onebot.example.test/onebot/v11` | 代理必须保留 WebSocket 升级和完整路径 |

Endpoint 的主机部分以 NekroNXT 运行环境为参照。NekroNXT 在容器内运行时，`127.0.0.1` 指向该容器；访问宿主机协议端应使用 `host.docker.internal` 或实际可达地址。

公网连接应使用 `wss://`，通过防火墙或可信专网限制来源，并配置强随机 Token。明文 `ws://` 适用于受信任的本机或局域网环境。

## 在 NekroNXT 添加连接

1. 前往「连接」，点击「添加平台连接」或「再添加一个账号」；
2. 选择「OneBot 11」，进入连接配置；
3. 在「WebSocket Endpoint」填写完整地址，包括协议、端口和实际 Path；
4. 在「Access Token」填写协议端配置的同一个 Token；协议端未配置 Token 时留空；
5. 初次接入采用默认事件设置：「记录戳一戳事件」开启，「记录普通消息回应」关闭；
6. 可填写连接别名，例如“测试账号”，然后创建连接。

Access Token 是只写凭据，保存后页面仅显示“已保存”。提交前应核对内容，并从截图和问题报告中移除真实 Token。

连接成功后，页面状态显示「已连接」，并显示协议端返回的连接账号。NekroNXT 在首次连接时锁定账号标识。Endpoint 切换至其他 QQ 账号后，连接状态变为异常并保留原频道归属；此时应恢复原账号，或为新账号创建连接。

## 发现频道并绑定智能体

1. 从另一个 QQ 账号向机器人账号发送一条群消息或私聊消息；
2. 回到连接页面，确认「最近收到消息」已更新且「已发现频道」不再为零；
3. 展开「收发测试」，点击「测试接收」；
4. 选择刚发现的群聊或私聊，再点击「发送测试消息」；
5. 点击「绑定智能体」，选择频道、响应智能体和响应方式；
6. 前往已绑定频道，用符合响应方式的消息触发一次智能体。

初次验收使用默认的「被提及或回复时」。确认 Mention 和回复链路后，可按频道需要改为「每条消息」。「仅观察」用于记录频道事实，普通消息和特殊事件均不触发智能体。

## 处理中状态和特殊事件

绑定完成后，在频道右侧的「绑定」区域可以配置 OneBot 11 的平台互动：

- 「显示处理中状态」默认开启。群消息触发智能体时，NekroNXT 为触发消息临时添加表情回应，并在处理结束后移除；该功能仅作用于群聊；
- 「设置特殊事件」可以逐项允许戳一戳、成员进退、消息撤回、文件上传等事件触发智能体；
- 特殊事件默认只记录，其触发设置独立于普通消息的响应方式；
- 「记录普通消息回应」决定协议端上报的普通回应是否进入频道事实流。系统产生的临时处理中回应由内部关联机制抑制。

特殊事件在频道中显示为独立状态行，不显示成员头像或普通消息气泡。成员进群会区分邀请加入、申请通过和其他加入方式，并显示新成员及协议端提供的邀请人；离群、禁言、撤回、名片、头衔、频道改名、群文件等事件也会保留操作者、目标、持续时间或新旧值。成员名称优先读取群名片，其次读取昵称；无法取得名称时显示中性称呼，不显示平台账号 ID。

`set_msg_emoji_like` 和 `send_poke` 属于协议端可选扩展。NekroNXT 根据实际调用结果记录支持状态；连接状态用于确认标准 WebSocket 和 OneBot Action，可选互动状态单独记录在连接诊断中。

## 最小验收清单

接入完成后，至少确认：

- 连接状态为「已连接」，错误 Token 会明确连接失败；
- 群聊和私聊各能接收一条文字消息；
- 群聊和私聊各能收到 NekroNXT 的发送测试消息；
- Mention、回复、图片和语音至少各测试一次；
- 群聊触发智能体时，处理中回应能添加并在结束后移除；
- 断开协议端再恢复后，NekroNXT 能自动重连；
- NekroNXT 重启并恢复连接后，遗留的处理中回应能够完成清理。

合并转发、JSON 卡片、戳一戳、消息撤回、成员进退和群文件等扩展事件建议按实际使用范围继续验收。协议端当前兼容状态和发布门槛由 [OneBot 11 Decision](../../decisions/implemented/2026-08-26-OneBot11正向WebSocket适配器.md)统一维护。

## 按症状排障

### 一直显示正在连接或连接异常

- 核对 Endpoint 的 `ws://` 或 `wss://` 协议、OneBot 服务端口和完整 Path；
- 确认协议端启用 WebSocket Server / `ws` 模式；
- 在 NekroNXT 所在设备或容器内验证主机名和端口可达；
- 跨设备或跨容器时，确认协议端没有只监听 `127.0.0.1`；
- 查看连接页显示的最近错误，认证失败时重新核对 Access Token。

### 已连接，但收不到消息

- 把协议端消息格式改为 `array`；
- 确认协议端会向 Universal WebSocket 推送事件，NapCat 中开启强制推送事件；
- 从外部账号发送一条新消息，再运行「测试接收」；
- 检查机器人账号是否实际在目标群聊中，以及协议端日志是否收到该消息。

### 能接收，但发送测试失败

- 从目标群聊或私聊发送消息，确认 NekroNXT 已发现频道；
- 确认机器人账号仍在群聊中且没有被禁言；
- 查看协议端 Action 回执和连接页错误；缺少 `message_id` 的发送回执记为结果未知；
- 图片或语音失败时确认单个 Asset 不超过 20 MiB。

### 图片或语音显示下载失败

- 确认协议端上报的媒体段包含 `url`，而不是只有协议端本机文件路径；
- NekroNXT 接受公网 HTTP 和 HTTPS 媒体地址，但会拒绝 URL 中的用户名或密码、重定向、私网地址、链路本地地址和元数据地址；
- 确认 NekroNXT 所在设备或容器能直接访问协议端返回的媒体域名；
- QQ 下载 URL 的 `rkey` 可能过期。发送一条新图片重新验收，并检查协议端能否生成当前有效的下载 URL。

### 处理中回应没有出现或没有移除

- 确认消息来自群聊且已经触发智能体；
- 确认频道中的「显示处理中状态」已开启；
- 协议端需要同时支持 `set_msg_emoji_like` 的添加和移除；
- 协议端明确缺少 Action 或移除能力持续异常时，NekroNXT 会停用该连接的后续处理中回应；
- 重启后遗留回应会在连接恢复时清理；清理持续失败时检查协议端日志和连接诊断。

### 戳一戳或消息回应没有进入频道

- 戳一戳默认记录，确认连接配置中的「记录戳一戳事件」已开启；
- 普通消息回应默认不记录，需要在连接配置中开启「记录普通消息回应」；
- 事件记录与智能体触发采用独立设置；在频道「设置特殊事件」中开启对应事件后，该事件才会触发智能体；
- 各协议端的扩展通知字段、自动化兼容与真实账号验收状态以兼容矩阵为准。

## 支持边界

首版范围为 OneBot V11 正向 WebSocket、数组消息和受限语义工具。反向 WebSocket、HTTP API + Webhook、OneBot 12、CQ 字符串消息和 raw OneBot Action 暂未纳入；主动文件、任意表情回应、群卡片、AI 语音、公告、签到、精华和群管理操作保留扩展接缝。

SnowLuma、NapCat 和 LLBot 是独立项目，其许可证和发布方式可能变化。NekroNXT 仅通过 OneBot V11 协议互操作，协议端代码、二进制和容器不属于 NekroNXT 分发内容。平台合规性与生产可用性需要按所选协议端单独评估。

返回[连接频道](../connections.md)，或继续阅读[创建智能体](../agents.md)和[消息内容与投递协议](../../03-消息内容与投递协议.md)。
