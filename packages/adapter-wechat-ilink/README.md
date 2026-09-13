# @nekro-nxt/adapter-wechat-ilink

微信 iLink 实验通道 Adapter。它覆盖 Phase 1 的私聊文本闭环与入站媒体接收：文本入站、图片/文件导入 Asset Service、基于最近 context_token 的文本回复、Connection scoped state、连接诊断和确定性单测。出站仍只开放文本。

## 创建连接

- 用户在产品界面只通过“扫码登录”创建微信 iLink 连接，不填写账号 ID、访问令牌、API 地址或 CDN 地址。
- 扫码成功后，Host 根据登录结果保存连接配置，并把访问令牌写入 Host-owned Credential；这些协议字段不进入用户可见配置表单。
- 同一个微信账号同时只能有一个活动 Connection；重复扫码和与现有活动连接冲突的归档恢复都会被拒绝。
- 已创建连接的详情页提供“入站媒体接收”开关。关闭时收到图片或文件会记录可解释占位内容；开启后收到图片或文件会主动下载并导入为频道资源。

## 当前边界

- 该通道基于非官方微信 iLink / OpenIlink 协议 SDK，协议稳定性、账号风控和合规风险不由 NekroNXT 保证；建议只使用专用微信机器人账号。
- 首版不开放群聊、Mention、语音、引用、撤回、主动发送或出站媒体能力；图片和文件仅支持入站接收，优先按 SDK 解密下载入站 media，下载失败时记录可解释的 rich fallback。
- 入站文件只作为频道资源保存和展示，不主动复制到智能体开发工作区。
- syncBuf 与会话 context_token 由 Connection scoped state 保存。
- context_token 只作为投递凭据使用，不进入消息 facts、日志或用户可见响应；未先收到目标私聊消息时，发送会返回 failed.invalid。

## 能力声明

- inbound text/image/file: true
- outbound text: true
- mentions/audio/replies/mixedContent/outbound files/outbound images: false
- proactiveSend: false
- maxTextLength: 4000
- outbound acceptedMimeTypes: text/plain
- inbound media types: 图片使用下载响应或协议字段声明的 image/png、image/jpeg、image/webp、image/gif 等类型导入 Asset Service；文件使用协议字段或下载响应声明的媒体类型导入 Asset Service
