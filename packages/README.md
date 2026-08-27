# Packages

当前只保留已有验证消费者的包：

- [`contracts`](contracts/README.md)：跨持久与进程边界的不透明 ID、消息内容和运行时校验；
- [`adapter-sdk`](adapter-sdk/README.md)、[`adapter-web`](adapter-web/README.md)：平台能力、入站、物理投递和内置频道 Adapter；
- [`adapter-onebot-11`](adapter-onebot-11/README.md)：协议端无关的 OneBot 11 正向 Universal WebSocket、消息映射、特殊事件和可选互动；
- [`adapter-wecom-ai-bot`](adapter-wecom-ai-bot/README.md)：企业微信官方智能机器人长连接、媒体上传、流式处理中状态和反馈事件；
- [`core`](core/README.md)：智能体 Revision、Connection、Channel、Binding、Event 与 Asset Service；
- [`channel-runtime`](channel-runtime/README.md)：Episode、Admission、Outbox、回执和当前频道历史契约；
- [`client-migrations`](client-migrations/README.md)：纯函数客户端状态迁移与宿主升级步骤协调；
- [`dsh-compat`](dsh-compat/README.md)：DSH 精确版本断言和公开 API 兼容探针；
- [`extension-sdk`](extension-sdk/README.md)：本地扩展唯一允许导入的版本化 Host/Client 契约；
- [`extension-runtime`](extension-runtime/README.md)：动态 Package 捕获、源码 Revision、构建缓存和 Activation 状态机；
- [`storage-sqlite`](storage-sqlite/README.md)：Core/Runtime/Asset 的 SQLite 持久化、WAL 与备份；频道历史按分页后的字面子串检索；
- [`adapter-qq-openclaw`](adapter-qq-openclaw/README.md)：首个外部 Adapter，QQ 开放平台 WebSocket Gateway 与 HTTP 发送；
- [`test-harness`](test-harness/README.md)：Virtual Clock 等确定性场景基础设施。

没有当前消费者和验证价值的目录不提前建立。Desktop 在 M7 进入。
