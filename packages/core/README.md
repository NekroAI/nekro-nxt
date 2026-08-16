# Core

该包拥有 NekroNxt 的产品事实与不可变版本语义：智能体、Connection、Channel、Binding 和规范化 Channel Event。它不依赖具体聊天平台，不读取 DSH 私有存储，也不负责模型循环。

`CoreRepository` 是存储所有者必须实现的窄提交边界；领域服务只在 Repository 成功后返回已发布事实。首个实现位于 `storage-sqlite`。Channel Runtime、Asset Service 和 Extension 生命周期在各自垂直切片进入时复用这些稳定身份，不在 Core 中写平台特例。
