# 升级、备份与恢复

升级必须可理解、可验证并在失败时恢复。NekroNXT 不在运行容器中执行 `git pull`，也不把预览版数据目录当作稳定版数据目录。

## 桌面版

- 升级同一通道时安装新的完整包；
- 稳定版与预览版可以并装，分别使用既有 `NekroNxt` 和 `NekroNxt Preview` 数据目录；
- 卸载默认保留数据；
- 备份前完全退出应用，再复制当前通道 `userData/data/`；
- 恢复时先保留现有目录副本，再用完整备份替换同一通道的数据根。

应用展示名是 `NekroNXT`，现有数据目录名称沿用原名。

## 服务端

- `/data` 是唯一需要作为整体保护的主要数据根；
- 备份前停止容器，复制命名卷或绑定目录；
- 使用新镜像创建替代容器，并挂载原 `/data`；
- 观察健康检查、发行标识和迁移结果后再删除旧容器；
- 恢复时停止服务、保留失败现场，再还原完整 `/data`。

不要只复制主数据库而遗漏 DSH 会话、扩展、资源、工作区和设备凭据。当前尚未提供一键完整数据根恢复，正式升级前应保留可回滚的完整副本。

每次生产启动都会先获取 `/data/backups/upgrade.lock`，避免多个 Host 同时迁移同一数据根。每个新 Release 第一次打开 Runtime 前，会把已有 `core.sqlite` 和 `sessions.sqlite` 备份到 `/data/backups/release-<releaseId摘要>/`，同一 Release 不重复创建。随后存储所有者执行现行迁移，Host 完成插件、Connection、频道和智能体运行关系恢复；对应 `upgrade-<releaseId摘要>.json` 只有全部成功才标记 `ready`。备份、迁移或恢复失败时 journal 标记 `recovery`，Server 不开放业务端口，原始数据保留供重试或人工恢复。

Release 恢复点不包含 Extension 源码、资源、凭据和工作区，因此不能替代升级前的完整 `/data` 备份。没有 Drizzle 基线元数据的早期开发数据库仍拒绝自动升级，不建立特殊迁移路径；数据库 downgrade 不受支持，程序回滚必须同时恢复升级前备份。

![水月荧展示升级或备份完成的档案舱](../../assets/brand/raster/upgrade-complete.png)
