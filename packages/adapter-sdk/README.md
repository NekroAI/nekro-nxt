# Adapter SDK

该包拥有聊天平台 Adapter 与 Channel Runtime 之间的公共契约：入站事实、能力声明、Connection 生命周期、物理发送请求和结构化回执。Adapter 不选择智能体、不拼模型上下文、不直接写 Core/DSH 数据库，也不自行无限重试。

当前消费者是 `test-harness` 的 Fake Adapter；后续 Internal Web Adapter 与 QQ OpenClaw Adapter 必须实现同一接口。平台特有字段只能进入受控 `adapterContext`，不能污染 Core 消息词汇。
