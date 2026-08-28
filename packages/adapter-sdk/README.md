# Adapter SDK

该包拥有聊天平台 Adapter 与 Channel Runtime 之间的公共契约：入站事实、能力声明、Connection 生命周期、物理发送请求、结构化回执，以及供 Host/UI 消费的版本化连接配置描述。Adapter 不选择智能体、不拼模型上下文、不直接写 Core/DSH 数据库，也不自行无限重试。

Internal Web Adapter 声明为系统托管且不可由用户创建；所有内置和已安装 Adapter 都以 `AdapterHostContributionV1` 注册到同一个 `AdapterRegistry`。Registry 拒绝重复 owner、重复 key、不支持的 API 版本和非法 Schema，注销句柄可等待且幂等。产品先选择 Adapter，再按 descriptor 的 `aliasEditable`、`channelDiscovery`、`diagnostics` 和版本化 schema 渲染通用界面。

`credential-reference` 可用 `credentialKey` 指定持久引用字段；原始值只经过 Host 只写通道，Connection 配置和 Adapter factory 只接收引用。`AdapterConnectionHostContext.transport` 是可替换 HTTP/WebSocket 边界：生产使用 Server 的 `fetch`/`ws`，测试和动态验证使用无网络 Fake。

`AdapterConnectionContext` 只暴露当前 Connection 可用的频道、成员、消息映射、Asset、Credential、命名空间状态、诊断和 Transport 服务。Adapter 不读取 Core Repository、SQLite 或宿主路径。远程 Asset 默认只允许 HTTPS；协议明确只提供 HTTP 媒体地址时，Adapter 可在单次 `fetchRemoteBytes` 调用中启用公网 HTTP，Host 仍统一拒绝 URL 凭据、重定向和私网目标。Host 统一创建、恢复、测试和停止 Connection Runtime；Connection 网络或凭据失败只形成诊断，不改变 Adapter Revision 的安装事实。

特殊平台活动使用公共 `ChannelActivityType` 与可选目标消息关系。Adapter 追加事实，不能通过撤回或回应事件删除、覆盖既有消息事实。
