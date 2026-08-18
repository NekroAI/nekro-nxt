# Server Host

该应用拥有 NekroNxt 的生产 DSH Host roster，并把 DSH Agent Loop 适配到 Channel Runtime。当前 roster 装配 Session、SQLite Persistence、System Prompt、Tool Runtime、Agent Loop、checkpoint、原 Session compaction、Channel 历史工具和受权 Asset 工具；聊天能力通过智能体作用域注册，不加载 DSH CLI 的全局文件与 Shell 工具。

`NekroRuntime` 是生产组合根：它拥有 Core SQLite、Channel Runtime、Extension 恢复、稳定 Web Connection、本地凭据目录，以及已安装 Adapter 的连接目录与运行实例。用户创建连接先选择 Adapter，再提交该贡献声明的普通配置和只写凭据；当前 QQ Connection 使用 HTTP/Gateway Runtime，Secret 只由 Host 凭据存储解析，Core 只保存引用。Gateway、Adapter 注册和诊断监听均在 dispose 时撤销并等待静止。

`DshHostRuntime` 继续只拥有 DSH Agent handle、Episode handoff、图片投影和智能体作用域扩展；Adapter 和 Core 不能通过 DSH Context 互相读取数据库。

模型供应商直接复用 DSH `dsh-llm-pi-ai`、`dsh-settings-file` 与 `dsh-credentials-local`：Web 设置页从 DSH 可配置供应商目录读取候选，通过 DSH settings 保存 profile，通过 DSH credentials 只写保存 API Key，并可调用 DSH 模型发现。设置和凭据持久化在主要数据目录的 `dsh/` 下，Server 重启后自动恢复；API 快照继续从实时 `ctx.llm` registry 投影模型列表，NekroNxt 不维护第二份供应商或模型目录。环境变量仅保留为无页面部署的可选组合层，不是本地产品的日常配置入口。

`dataRoot` 是 Server 唯一数据根，生产入口会创建 `dataRoot/workspaces/`，并在智能体首次使用开发 Shell 或文件能力时自动创建私有的 `workspaces/<agentId>/`。DSH Session 的 `cwd`、文件工具和 Shell 工具始终使用同一个智能体目录；完整文件访问只提升策略，不改变该默认 `cwd`。高级部署可用 `developmentWorkspaceRoot` 或 `NEKRO_DEVELOPMENT_WORKSPACE_ROOT` 覆盖工作区根，覆盖后仍自动追加 `<agentId>`，普通本地使用不需要配置环境变量。

本地开发统一运行根命令 `pnpm dev`：workspace 库用 `tsdown --watch` 重建，Server 用 `tsx watch` 监听自身源码和各库的 `dist/*.mjs`，依赖实现变化后会优雅重启。不要分别启动一个长期不重载的 Server 进程，否则可能出现前端/路由已更新而进程内 Core 类仍是旧版本的“半新半旧”状态。
