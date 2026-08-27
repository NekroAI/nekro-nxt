# Test harness

该包只保存多个垂直切片都会使用的确定性测试原语。`VirtualClock` 与 `ScenarioDriver` 避免 Channel Runtime、Gateway 恢复和 migration 测试依赖真实 sleep；`FakeAdapterConnection` 直接实现公开 Adapter 契约。`createFakeAdapterHostContext`、`FakeAdapterTransport` 和 `FakeAdapterWebSocket` 提供凭据引用、目录、诊断、HTTP/WebSocket 与资源静止检查，使生成的 Adapter 在无网络条件下覆盖配置解析、入站发现、出站回执和 stop。

Fake 只模拟平台边界，不自己实现 Core 去重、Admission 或重试；这些行为必须通过真实 Channel Runtime 验证。
