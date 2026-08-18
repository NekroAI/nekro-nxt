# Server Host

该应用拥有 NekroNxt 的生产 DSH Host roster，并把 DSH Agent Loop 适配到 Channel Runtime。当前 roster 装配 Session、SQLite Persistence、System Prompt、Tool Runtime、Agent Loop、checkpoint、Session compaction、LLM retry、工具结果裁剪、工具超时、Spill、官方 in-process 子智能体与 DeepSeek Web Provider；频道通信、历史、Asset、子智能体控制、网页搜索、文件和 Shell 工具都按智能体 Revision 在根 Session Scope 注册，不照搬 DSH CLI 的全局工具面。

`NekroRuntime` 是生产组合根：它拥有 Core SQLite、Channel Runtime、Extension 恢复、稳定 Web Connection、本地凭据目录，以及已安装 Adapter 的连接目录与运行实例。用户创建连接先选择 Adapter，再提交该贡献声明的普通配置和只写凭据；当前 QQ Connection 使用 HTTP/Gateway Runtime，Secret 只由 Host 凭据存储解析，Core 只保存引用。Gateway、Adapter 注册和诊断监听均在 dispose 时撤销并等待静止。

`DshHostRuntime` 继续只拥有 DSH Agent handle、Episode handoff、图片投影和智能体作用域扩展；Adapter 和 Core 不能通过 DSH Context 互相读取数据库。

模型供应商直接复用 DSH `dsh-llm-pi-ai`、`dsh-settings-file` 与 `dsh-credentials-local`：Web 设置页从 DSH 可配置供应商目录读取候选，通过 DSH settings 保存 profile，通过 DSH credentials 只写保存 API Key，并可调用 DSH 模型发现。设置和凭据持久化在主要数据目录的 `dsh/` 下，Server 重启后自动恢复；API 快照继续从实时 `ctx.llm` registry 投影模型列表，NekroNxt 不维护第二份供应商或模型目录。环境变量仅保留为无页面部署的可选组合层，不是本地产品的日常配置入口。

`dataRoot` 是 Server 唯一数据根，生产入口会创建 `dataRoot/workspaces/`，并在智能体首次使用开发 Shell 或文件工具时自动创建私有的 `workspaces/<agentId>/`。开发 Shell 的默认 `cwd` 和文件工具的默认 `cwd` 都使用该目录；`workspace-write` 只限制写入位置，DSH rc.6 的 read/grep/glob 仍能读取 Server 进程有权读取的宿主文件，因此文件工具默认关闭且界面必须如实警示读取范围。完整文件访问只把已启用文件工具或开发 Shell 的策略提升为 `danger-full-access`，不会单独提供工具，也不改变默认 `cwd`。高级部署可用 `developmentWorkspaceRoot` 或 `NEKRO_DEVELOPMENT_WORKSPACE_ROOT` 覆盖工作区根，覆盖后仍自动追加 `<agentId>`。

Spill 由 Server 自有的 DSH `SpillStore` 实现写入 `dataRoot/dsh/spill/`，单 artifact 8 MiB、单 Session 64 MiB、Host 总量 2 GiB；每次写入串行核算，重启后重新扫描现有文件。该目录是持久备份数据，不是 Asset 或 Adapter 路径身份。关闭文件工具后已有 locator 仍有效，但智能体不能自行回读，界面与模型提示会要求先重新授权文件工具。

本地开发统一运行根命令 `pnpm dev`：workspace 库用 `tsdown --watch` 重建，Server 用 `tsx watch` 监听自身源码和各库的 `dist/*.mjs`，依赖实现变化后会优雅重启。不要分别启动一个长期不重载的 Server 进程，否则可能出现前端/路由已更新而进程内 Core 类仍是旧版本的“半新半旧”状态。
