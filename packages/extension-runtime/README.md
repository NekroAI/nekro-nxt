# Extension Runtime

该包拥有动态 Package 捕获、ExtensionDraft、不可变 ExtensionRevision、受控构建缓存和 AgentActivation 状态机。SQLite 实现位于 `storage-sqlite`，DSH/Cordis 挂载位于 Server 组合根；本包不读取其他包数据库，也不依赖 Electron。

动态运行、保存 Revision 和给智能体启用是三个独立提交动作。源码 Revision 是持久事实，构建缓存可删除重建；失败 Revision 或 Activation 不能阻止 Core 启动。
