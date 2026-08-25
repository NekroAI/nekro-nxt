# 公共契约

该包拥有跨 Runtime、Adapter、持久化和进程边界共享的稳定 ID、消息内容、无损 JSON 类型与 Host API Contract Registry。公共 ID 由带前缀格式检查的 Zod brand 推导；HTTP Contract 同时声明 method、path、params、request、response 和 error Schema。它只描述线上和持久边界，不保存业务状态，也不包含 QQ、Web 或 Electron 特例。

Server 必须通过 Registry 解析请求并校验响应，Web Client 必须用同一 Registry 构造路径和验证返回值；不得使用只靠泛型声称响应正确的 `requestJson<T>()`。外部输入必须先通过本包解析函数验证；同进程内已经类型化的数据不重复解析。Desktop 实例描述额外区分宽松的 `InstanceDescriptorWireSchema` 与当前可执行的 `InstanceDescriptorSchema`：前者保留未来新增字段，并读取未知协议数字与 transport 字符串以生成明确的不兼容错误；后者只接受 protocol 1 的 loopback/固定 SPKI TLS，以及 protocol 2 的显式未加密 HTTP。用户可见消息词汇以 `../../docs/03-消息内容与投递协议.md` 为唯一设计事实源。
