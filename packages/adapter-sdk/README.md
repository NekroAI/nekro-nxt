# Adapter SDK

该包拥有聊天平台 Adapter 与 Host 之间的公共契约：Connection 生命周期、频道与连接入站事实、运行能力、物理发送、结构化回执、受限 Host Service，以及供产品消费的版本化 Descriptor。Adapter 不选择智能体、不拼模型上下文、不直接写 Core/DSH 数据库，也不自行无限重试。

所有内置和已安装 Adapter 都以 `AdapterHostContributionV2` 注册到同一个 `AdapterRegistry`。Registry 只接受 `apiVersion: 2`，并拒绝重复 owner/key、重复活动 key、非法 scope、非法 Channel kind、可触发的 Connection 活动、越界的处理中反馈能力和不合法 Schema。注销句柄可等待且幂等。

Descriptor 声明 `provisioning`、可编辑别名、频道发现方式、`internal | direct | group` 范围、诊断动作、配置 Schema、活动目录和可选处理中反馈。活动 key 是开放字符串；新增活动不修改 contracts、Core 或 Web。Runtime 以 `outbound + activities + processingFeedback` 报告动态能力状态，Host 会核对它与 Descriptor 一致。

`AdapterConnectionHostContext` 按当前 Connection 暴露 `channels`、`identities`、`members`、`messages`、`assets`、`credentials`、`state`、`diagnostics` 和 `transport`。`acceptChannelInbound` 只提交属于具体频道的消息或活动；`acceptConnectionInbound` 提交账号和关系事实，不创建 Channel/ChannelMember，也不进入智能体运行时。

配置 Schema 是序列化 Schemastery（可用 `configSchema` 构建器生成），产品表单直接渲染。`meta.role: 'secret'` 的字段是只写凭据：原始值只经过 Host 只写通道，以字段名为键存入 `credentialRefs`，Connection 配置和 Adapter factory 只接收引用。配置更新只替换 Schema 声明的非凭据字段，Adapter 写入的其他私有字段保持不变。`transport` 是可替换的 HTTP/WebSocket 边界：生产使用 Server 网络实现，测试和动态验证使用无网络 Fake。远程 Asset 默认只允许 HTTPS；协议明确需要 HTTP 时可为单次抓取开启公网 HTTP，Host 仍拒绝 URL 凭据、重定向和私网目标。

`AdapterConnectionRuntime.localChannel` 是可选的应用内消息端口。Host 通过 Descriptor 的系统单例与 `internal` 能力发现唯一内置实现，不比较 Adapter key。

Adapter Descriptor 可选声明 `platformActions`（名称、标题、说明、风险等级 `low | admin`、适用的频道 kind 与参数对象 Schema）和 `rawApi`；对应地，`AdapterConnectionInteractions` 可选实现 `invokePlatformAction` 与 `invokeRawApi`，返回互动结果并可附带平台返回值。成员参数统一用频道成员 ID（`memberId`），由 Adapter 自行解析为平台账号。缺省字段不改变已有 Descriptor 的摘要。智能体扩展经 `ctx.nxt.platform` 调用，宿主只开放扩展声明过且当前频道 kind 适用的动作。
