# Desktop Host

该应用是 NekroNxt 完整本地产品的 Electron 宿主。它不实现第二套领域逻辑，也不连接平台方维护的中心后端：Electron 主进程启动当前安装包内的 Server 生产入口，Server 装配同版本 DSH、Core、Extension Runtime，并托管当前安装包内的 `apps/web/dist`。

Desktop 只接受原子的 `nxt.product-release`。UI、Host、DSH Client/Host 组合、Extension Bridge 与 migration 代码使用同一个 `releaseId`，不提供独立 UI 发布或远程 UI 资源更新。Electron 在 Host `/health/ready` 返回相同 `releaseId` 后才加载页面。

分发脚本用 `pnpm deploy --prod --legacy` 把 Server 及其 workspace/外部生产依赖生成到 Desktop staging，再只为目标 Electron ABI 重建 `better-sqlite3` 与 `node-pty`。Server runtime 和 Web dist 都作为安装包的 `extraResources` 放在应用代码之外，electron-builder 不扫描或混装其他平台的 DSH 可选原生包；Windows、macOS 和 Linux 必须在各自目标系统构建。

生产数据固定在 Electron `userData/data/`，安装包替换不得删除该目录。Server 和 Desktop 使用同一个 Server 入口、数据根布局与升级门禁；Electron 只拥有窗口、单实例、外部链接和 Host 子进程生命周期。

当前分发实验使用未签名完整安装包：Windows NSIS、macOS DMG、Linux AppImage。稳定应用标识是 `io.github.nekroai.nekronxt`，Windows NSIS 安装身份固定为 `2BED256D-E4EA-4EA9-B730-6B63FF416CE8`，二者均不随版本或架构变化。更新通过下载并替换完整产品包完成；自动替换、平台签名、公证和差分资源更新均未开放。

## 验证

```sh
pnpm --filter @nekro-nxt/desktop typecheck
pnpm --filter @nekro-nxt/desktop test
pnpm --filter @nekro-nxt/desktop dist:dir
```
