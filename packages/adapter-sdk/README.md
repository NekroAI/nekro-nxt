# Adapter SDK

该包拥有聊天平台 Adapter 与 Channel Runtime 之间的公共契约：入站事实、能力声明、Connection 生命周期、物理发送请求、结构化回执，以及供 Host/UI 消费的版本化连接配置描述。Adapter 不选择智能体、不拼模型上下文、不直接写 Core/DSH 数据库，也不自行无限重试。

Internal Web Adapter 声明为系统托管且不可由用户创建；QQ OpenClaw 与 OneBot 11 Adapter 通过同一描述贡献名称、说明和 JSON Schema 子集。产品先选择 Adapter，再按 schema 渲染通用表单；`credential-reference` 字段通过独立只写通道提交，不进入普通配置。平台特有字段只能进入受控配置或 `adapterContext`，不能污染 Core 消息词汇。

`AdapterConnectionContext` 只暴露当前 Connection 可用的频道、成员、消息映射、Asset、Credential、命名空间状态和诊断服务。Adapter 不读取 Core Repository、SQLite 或宿主路径。`AdapterConnectionRuntime.interactions` 是可选语义接口，只提供处理中反馈、撤回自身消息和成员互动；SDK 不提供平台 raw Action 透传。

特殊平台活动使用公共 `ChannelActivityType` 与可选目标消息关系。Adapter 追加事实，不能通过撤回或回应事件删除、覆盖既有消息事实。
