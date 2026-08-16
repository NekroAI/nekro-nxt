# Extension SDK

本包是本地扩展源码唯一允许直接导入的版本化契约。它只提供 Host/Client entry factory 与可序列化边界类型，不暴露 Core 数据库、宿主路径、Electron 或 DSH 私有对象。

运行时能力通过 Activation Host 注入；新增 SDK 面必须有已实现 Extension 消费者、兼容版本和卸载测试。
