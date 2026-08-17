# Adapter SDK

该包拥有聊天平台 Adapter 与 Channel Runtime 之间的公共契约：入站事实、能力声明、Connection 生命周期、物理发送请求、结构化回执，以及供 Host/UI 消费的版本化连接配置描述。Adapter 不选择智能体、不拼模型上下文、不直接写 Core/DSH 数据库，也不自行无限重试。

Internal Web Adapter 声明为系统托管且不可由用户创建；QQ OpenClaw Adapter 通过同一描述贡献名称、说明和 JSON Schema 子集。产品先选择 Adapter，再按 schema 渲染通用表单；`credential-reference` 字段通过独立只写通道提交，不进入普通配置。平台特有字段只能进入受控配置或 `adapterContext`，不能污染 Core 消息词汇。
