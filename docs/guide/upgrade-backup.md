# 升级、备份与恢复

升级必须可理解、可验证并在失败时恢复。NekroNXT 不在运行容器中执行 `git pull`，也不把 Preview 数据目录当作 Stable 数据目录。

## Desktop

- 升级同一通道时安装新的完整包；
- Stable 与 Preview 可以并装，分别使用既有 `NekroNxt` 和 `NekroNxt Preview` 数据目录；
- 卸载默认保留数据；
- 备份前完全退出应用，再复制当前通道 `userData/data/`；
- 恢复时先保留现有目录副本，再用完整备份替换同一通道的数据根。

应用展示名改为 `NekroNXT` 不会迁移或重命名旧数据目录。

## Server

- `/data` 是唯一需要作为整体保护的主要数据根；
- 备份前停止容器，复制命名卷或绑定目录；
- 使用新镜像创建替代容器，并挂载原 `/data`；
- 观察健康检查、Release ID 和迁移结果后再删除旧容器；
- 恢复时停止服务、保留失败现场，再还原完整 `/data`。

不要只复制 Core SQLite 而遗漏 DSH、扩展、资源、工作区和 Host 凭据。当前尚未提供一键完整数据根恢复，正式升级前应保留可回滚的完整副本。

![水月荧展示升级或备份完成的档案舱](../../assets/brand/raster/upgrade-complete.png)
