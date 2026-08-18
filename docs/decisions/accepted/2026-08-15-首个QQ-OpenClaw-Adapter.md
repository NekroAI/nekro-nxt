# 决策：首个外部 Adapter 采用 QQ OpenClaw

状态：accepted

离线实现证据见 `../implemented/2026-08-16-M5-QQ-OpenClaw-Adapter离线实现.md`；产品配置、凭据宿主与诊断 UI 的后续实现见 `2026-08-17-本地凭据与QQ连接宿主.md`，当前只剩真实账号环境验收。

## 问题

NekroNxt 首期需要一个真实外部平台验证 Connection、Channel、Binding、稳定成员身份、Mention、媒体、引用、触发、安全间隙注入和可靠出站。现有 Nekro Agent QQ OpenClaw 适配器已跑通基础链路，但仍是半成品，不能直接复制为 NekroNxt 的首版契约。

## 决定

首个外部 Adapter 选择 QQ 官方机器人 OpenClaw 渠道，参考：

- Nekro Agent 当前 `qqbot_openclaw` 实现；
- `KroMiose/nekro-agent#321` 的 Markdown Mention 问题；
- 腾讯 `openclaw-qqbot` v2.0.1 的平台行为与工程经验。

代码使用纯 TypeScript，按 NekroNxt `AdapterContribution`、Connection、Channel 和统一消息协议重新设计，不迁移 Python 接口或旧 chat key。

## 选择理由

- QQ 群聊符合 NekroNxt 的原生群聊定位；
- OpenClaw 使用官方机器人通道，安装和维护成本低于 Napcat/OneBot；
- 真实存在 Mention、引用、被动回复额度、主动发送、媒体和断线恢复等平台差异，能验证 Adapter seam 是否成立；
- Nekro Agent 与腾讯上游都有可核实源码，不需要从零猜测协议。

## 首期范围

### 必须完成

1. 单个 Connection 对应一个 QQ 机器人账号；
2. WebSocket Gateway、Token 刷新、心跳、Resume、断线重连；
3. C2C 私聊和 QQ 群 Channel；
4. 文本、结构化 Mention、图片、文件、音频和引用；视频作为普通文件处理；
5. 群消息被 Mention、回复机器人、总是响应、仅观察等 Binding 触发策略；
6. 普通群消息可靠入库但不一定触发；
7. Markdown 文本和 `<@openid>` Mention 正确发送；
8. 被动回复次数/有效期约束和主动发送降级；
9. 逻辑消息、物理消息、平台 message ID 和部分成功回执；
10. 平台事件去重、Gateway 重放和 Channel checkpoint；
11. 收发测试分离；
12. Connection、Channel 与 Binding 的完整前端配置和诊断；
13. Fake Gateway、契约测试和少量真实账号手工验收。

### 明确保留接缝但不进入首期

- 多账号：Connection 模型允许多个实例，但首期一个 Connection 一个账号；
- Webhook：Transport 联合类型保留，首期只实现 WebSocket；
- 视频：首期不增加专用 video 类型，平台 `video/*` 资源按普通 file 完整入库和转发；
- STT/TTS、Typing、流式更新、按钮和平台命令；
- 私聊 pairing 和复杂群级工具策略；
- 全量群成员同步；QQ 平台未必提供可靠完整列表，首期使用“已知成员目录”。

## 身份模型

OpenID 只在机器人账号范围内稳定，不同 Connection 不能混用。建议：

```text
PlatformIdentity
├─ id
├─ connectionId
├─ platformUserId      # user_openid/member_openid
├─ displayName
├─ firstSeenAt / lastSeenAt
└─ seenCount

ChannelMember
├─ id                  # MessagePart.memberId 指向这里
├─ channelId
├─ platformIdentityId
├─ channelDisplayName?
└─ firstSeenAt / lastSeenAt / seenCount
```

`PlatformIdentity` 唯一约束为 `(connectionId, platformUserId)`，`ChannelMember` 唯一约束为 `(channelId, platformIdentityId)`。不能只用 OpenID，也不能把昵称当身份。Channel 中引用成员使用 NekroNxt `memberId`，Adapter 发送前通过 ChannelMember 和同一 Connection 的 PlatformIdentity 解析平台 OpenID。

## Mention 设计

### 出站

统一通信工具仍接收：

```ts
{ type: 'mention', memberId: string }
```

QQ Adapter 执行以下步骤：

1. 通过 `memberId` 解析同一 Connection 下的 OpenID；
2. 验证成员属于目标 Channel 的已知成员范围，或显式允许跨 Channel 的同 Connection 私聊身份；
3. Markdown 模式输出原子 Token `<@platformUserId>`；
4. 保持 MessagePart 顺序，不先退化成 `@昵称`；
5. 分片器把 Mention 当不可拆原子，不能把 `<@...>` 从中切断；
6. 回执保留“真实 Mention”或“显示文本降级”的 capability outcome。

### Issue #321 的处理

Nekro Agent 的内部 `[@id:xxx@]` 是旧框架协议。NekroNxt 不把这种文本标记带入新 Core，也不依赖正则从最终文本猜 Mention；结构化 `MessagePart` 是唯一正常路径。

新项目不导入 Nekro Agent 数据，也不兼容旧文本协议，因此 QQ Adapter 不识别 `[@id:...]`。模型若输出类似文本，它只是一段普通文字；真正 Mention 只能由通信工具提交结构化 `memberId`，再由 Adapter 转成 `<@openid>`。

### `@昵称` 反查

不推荐把 `@昵称` 自动反查作为发送主路径：昵称不唯一、会变化，QQ 也未必提供完整成员列表。可选方案：

- A：只允许结构化 memberId，失败时明确报错；最可靠，推荐首期；
- B：只在已知成员目录中唯一匹配时转换，零个或多个匹配都要求用户选择；可作为 UI 增强；
- C：模糊匹配后直接发送；拒绝。

### `@全体成员`

首期不提供普通 Mention 到 `all` 的隐式转换。未来如平台和权限允许，应设计独立 `mention-all` capability、Binding 权限和显式高风险工具参数。

## 入站内容

- 使用平台 `mentions[]` 生成结构化 Mention part；
- 对机器人自身 Mention 从普通显示文本中移除，但保留触发事实；
- 对其他成员 Mention 保留成员 ID 和显示名；
- 无法获得精确文本位置时，保留平台给出的结构顺序证据并使用确定性降级，不伪造精确位置；
- 图片、文件、音频和视频文件先进入内容寻址 Asset Service，Channel Event 只保存 `assetId` 与本次 Occurrence；
- 引用映射到规范化 `messageId`，平台 `ref_idx` 只属于 Adapter checkpoint/索引；
- 编辑、撤回等事件若当前 Gateway 不提供，capability 明确声明不支持。

## 触发与群聊策略

Adapter 只报告平台事实，例如 `mentionedBot`、`replyToBot`。最终是否触发由 Binding Policy 决定：

- `always`；
- `mentioned-or-replied`；
- `command`；
- `observe-only`。

“只 @ 其他人”仍写入 Channel Log；是否不触发由 Binding 决定，不在 Adapter 中静默丢弃。平台访问控制（群 disabled/allowlist）仍属于 Connection 层，在入库前拒绝未授权 Channel。

## 被动回复与主动发送

QQ 平台对同一入站消息的被动回复次数和有效期有限制。Adapter capability 应声明：

```ts
interface QQReplyContext {
  platformMessageId: string
  expiresAt?: number
  remainingReplies?: number
}
```

发送规划：

1. 有有效 reply context 时优先被动回复；
2. 每个物理消息发送成功后消费一次额度；
3. 额度不足以发送拆分后的全部 parts 时，在发送前选择全部主动发送，避免半组被动、半组主动造成顺序混乱；
4. 被动上下文过期且 Connection 允许主动发送时降级主动发送；
5. 主动发送被平台拦截时记录永久/可重试失败，不声称成功。

首期默认额度与 TTL 不应写死为产品常量；从平台返回或 Adapter 配置解析，并通过测试覆盖。

## Markdown 与分片

分片器接收有序 MessagePart，而不是先拼成字符串再任意截断：

- text 可按 Unicode code point 和 Markdown block 安全边界拆分；
- mention、quote 和媒体是原子 part；
- 围栏代码块跨消息时确定性关闭与重开；
- URL、链接、Mention Token 不从中拆开；
- 每个 chunk 生成独立 PhysicalDelivery，共用 logicalMessageId；
- 发送前校验最终 UTF-8 字节和平台字符限制。

## 媒体

- 模型和 Extension 只能提供 `assetId`；
- Adapter 从 Asset Service 获取受控字节流、MIME、文件名和大小；
- 不接受宿主绝对路径和任意 URL 作为公共发送输入；
- 上传 prepare、分片、finish 和消息发送分别记录 attempt；
- 上传成功但消息发送失败时，逻辑消息仍为 failed/partial，不能只因获得 `file_info` 就成功；
- 首期按 QQ 实际限制实现图片、音频和文件；视频使用 file Part，不做转码、抽帧或内容理解。

## 连接恢复与幂等

- Session resume 信息属于 Connection runtime state，使用受控持久化；
- 每个入站事件先按 platform event/message ID 去重；
- checkpoint 只在 ChannelEvent 持久化后推进；
- 重连重放不得重复创建 Turn；
- 出站 `clientRequestId` 在 Runtime 层去重；
- `msg_seq` 以平台 reply context 为作用域递增；
- 请求已提交但响应丢失时标记 unknown，不能自动重复发送。

## capability 声明

首期 QQ Adapter 应显式声明：

- text：支持；
- mentions：支持，要求同 Connection 已知成员；
- images：支持；
- files：支持；
- audio：支持；
- replies：支持；
- mixedContent：按平台约束拆分；
- proactiveSend：条件支持；
- receiveEdits/deletes/reactions：按实测结果声明；
- maxTextLength、maxAssetBytes、acceptedMimeTypes；
- transport：`websocket`。

## 前端配置与 DSH 插件通用性

> 后续兼容说明：本节要求 `AdapterContribution` 的范围仅限把聊天平台接入 NekroNxt 的 Connection、Channel 与 Binding 领域，不代表普通 DSH 能力插件必须专门适配 NekroNxt。能力插件的零适配优先原则与支持识别见 `2026-08-18-DSH能力插件优先兼容与支持识别.md`。

DSH 社区插件兼容和 NekroNxt 产品级 Adapter 体验采用渐进层级，不创建第二套插件系统：

### 层级 1：普通 DSH/Cordis 插件

- 通过 DSH 标准 Plugin、Bundle、Preset 与 Scope 机制安装和运行；
- 可出现在通用插件清单和 DSH 已有 Slot 中；
- 没有 `AdapterContribution` 时，不自动获得 NekroNxt 的 Connection、Channel、凭据和 Binding UI；
- NekroNxt 不猜测任意插件设置就是聊天平台连接配置。

### 层级 2：声明式 NekroNxt Adapter Extension

Extension 仍是标准 DSH/Cordis 插件，只额外声明 NekroNxt 元数据与 `AdapterContribution`。声明式配置确定采用 NekroNxt 自有、可版本化的 JSON Schema 子集；开发工具可以转换常见 Schemastery 字段，但运行时契约不依赖 DSH Web 的手写控件：

- Connection 配置 schema、字段说明、默认值和校验；
- Secret 字段只声明 credential slot，实际值保存为 Credential Reference，不进入普通 settings、日志或 Extension config；
- Adapter capability、连接状态、可发现 Channel 类型和 Binding trigger policy；
- Core 根据 schema 渲染统一 Connection 创建/编辑页，因此大多数 Adapter 不需要自写前端；
- 配置实例属于 NekroNxt Connection 领域对象，不塞进 DSH 全局 Plugin Settings，也不暴露 Core 数据库。

这避开 DSH 当前第三方 settings namespace 需要 Host allowlist、Preset 多实例可能发生全局 namespace 冲突，以及 Schemastery schema 没有通用 React renderer 的限制。

### 层级 3：可选 Client UI 增强

复杂 Adapter 可以向稳定 NekroNxt Slot 注册可逆 Client contribution：

- `connection.adapter.setup`：二维码、OAuth 或分步开通；
- `connection.adapter.status`：平台状态、Gateway、Token 与限流信息；
- `connection.adapter.test`：独立接收测试和发送测试；
- `channel.binding.setup`：平台特有触发和权限提示；
- `extension.details.panels`：诊断、版本和平台说明。

自定义 UI 只能调用公开 Adapter/Connection Service，不直接访问数据库或 Secret。未提供自定义 UI 时，通用 schema 表单仍必须覆盖完整配置闭环；提供自定义 UI 也不能改变 Connection、Channel、Binding 和 Credential 的领域语义。

QQ 首期采用层级 2 + 层级 3：通用表单负责 App ID、Credential Reference、连接策略等稳定字段；自定义面板负责 Gateway 状态、已知 Channel、收发测试、回复额度诊断和可操作故障说明。DSH 自带 `settings.plugin.item` 或 `settings.plugins.tab` 只用于插件级非实例偏好，不承载 QQ Connection 实例。

## 测试计划

### 纯契约测试

- OpenID 按 Connection 隔离；
- `<@openid>` 发送与入站 Mention 解析；
- `[@id:...]`、代码块、URL、邮箱中的 `@` 都只作为普通文字，不被改写；
- `@all` 不被隐式触发；
- Mention Token 和 Markdown 链接不被分片；
- 被动额度耗尽前后的主动发送降级；
- 混合消息拆分与部分成功；
- 同一事件重复 100 次只入库一次；
- Gateway 断线、Resume、乱序和重复 dispatch；
- 上传成功/发送失败、上传部分失败和超限；
- Connection A 的 memberId 不能通过 Connection B 发送。

### Fake Gateway 场景

- Tool 运行十秒期间收到普通消息、@机器人、@其他人和 Owner 停止；
- 重连后重放同一批事件；
- 回复上下文过期；
- 平台返回限流、认证过期、永久拒绝和响应丢失；
- 同一逻辑消息拆成三条，第二条失败。

### 真实账号验收

- C2C 与群聊收发；
- 真正触发 QQ Mention 通知和高亮；
- 引用机器人消息触发；
- 图片、文件、音频，以及作为普通文件接收的视频；
- 断网后恢复；
- 收发测试分别显示结果。

真实测试使用专用账号和测试群，不把凭据与平台原始 payload 提交到仓库。

## 已确认范围

- 首期只实现 WebSocket，Webhook 只保留 Transport 接缝；
- 一个 Connection 对应一个机器人账号，领域模型允许创建多个 Connection，多连接管理 UI 延后；
- 通信工具只接受 `memberId`，UI 可以从已知成员目录中选择或唯一匹配，不做自由文本模糊反查；
- 视频首期作为普通 file；专用 video Part 与理解能力等待真实消费者后再设计；
- QQ Adapter 是独立 Extension package，通过 Adapter SDK 接入，不编进 Channel Runtime。

## 未来方向检查

关联方向：更多 Adapter、多媒体、智能体多频道、主动 Job。

保留接缝：Connection 与 Adapter 分离、账号作用域成员 ID、Adapter capability、Transport 联合类型、逻辑/物理消息分离、声明式配置和可选 UI Slot 分层。

避免锁死：不把 OpenID 当全局用户 ID，不把 QQ Markdown 写入 Core，不把单账号写进 Adapter 接口，不让 Job 绕过通信工具。

本次不做：Webhook、多账号 UI、STT/TTS、专用视频理解/转码、按钮卡片、平台命令、完整成员同步、旧数据导入和旧文本协议兼容。

## 参考证据

参考：Nekro Agent `qqbot_openclaw` 当前源码和测试、Issue #321、腾讯 `openclaw-qqbot` v2.0.1。

借鉴：Gateway、OpenID、引用索引、上传协议、回复额度、群策略和断线恢复。

明确拒绝：不复制 Python Adapter API、`[@id:...]` 文本协议、同步 JSON 状态、框架命令和布尔发送结果。
