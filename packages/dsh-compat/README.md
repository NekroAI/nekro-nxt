# DSH compatibility

所有 NekroNxt 业务包通过本包集中接触 DSH 公共 API。生产依赖只包含当前 Client facade 真实导入的纯 Slot Core；Client Runtime、Host、Bundle 和其他代表性 rc.6 包作为开发期兼容面精确锁定，不进入该 facade 的生产依赖声明。未来 Server 组合根必须自行声明并断言它实际装配的 Host package set。

本包提供代表性公开导出、React singleton、Session/Scope、动态 Cordis 工具、Client Slot 和 SQLite persistence 兼容测试。完整 Base/Web Bundle 只用于开发期组合验证，不能因为版本表而被误认为 NekroNxt 的生产 Runtime。

DSH Client Runtime 的根入口是 Host 插件空壳，`./client` 是交给 DSH Client ModuleLoader 的浏览器模块产物，不是普通 Vite ESM。当前 facade 只直接导出标准 ESM 的纯 `SlotCore` 和必要类型；完整 Runtime 必须由 Host roster 与 Client ModuleLoader 真实装配，禁止用根 `apply()` 冒充已加载。

禁止从相邻源码仓库解析依赖、安装浮动 dist-tag、导入 DSH 私有路径或在业务包中分散版本判断。升级 DSH 时先更新本包的精确版本表和测试，再处理有证据的兼容差异。
