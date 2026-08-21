# Desktop Host

该应用是 NekroNxt 完整本地产品的 Electron 宿主。它不实现第二套领域逻辑，也不连接平台方维护的中心后端：Electron 主进程启动当前安装包内的 Server 生产入口，Server 装配同版本 DSH、Core、Extension Runtime，并托管当前安装包内的 `apps/web/dist`。

Desktop 只接受原子的 `nxt.product-release`。UI、Host、DSH Client/Host 组合、Extension Bridge 与 migration 代码使用同一个 `releaseId`，不提供独立 UI 发布或远程 UI 资源更新。Electron 在 Host `/health/ready` 返回相同 `releaseId` 后才加载页面。

分发脚本用 `pnpm deploy --prod --legacy` 把 Server 及其 workspace/外部生产依赖生成到 Desktop staging。`better-sqlite3` 与 `node-pty` 使用包内 N-API prebuild，Sharp、Koffi 和其他平台可选包按 `supportedArchitectures` 同时安装；准备脚本会拒绝缺少 macOS Universal、Windows x64 或 Linux x64 原生文件的 runtime。Server runtime 和 Web dist 都作为安装包的 `extraResources` 放在应用代码之外。

生产数据固定在 Electron `userData/data/`，安装包替换不得删除该目录。Server 和 Desktop 使用同一个 Server 入口、数据根布局与升级门禁；Electron 只拥有窗口、单实例、外部链接和 Host 子进程生命周期。

当前分发实验使用未签名完整安装包：Windows x64 NSIS、macOS Universal DMG、Linux x64 AppImage。`stable` 与 `preview` 使用不同 appId、NSIS GUID、产品名、可执行文件名和 `userData`，可以同时安装，也不会让预览版迁移正式版数据库。身份的唯一源是 `distributions.json`。

产品版本的唯一手工来源是仓库根 `package.json#version`。正式版使用原值 `X.Y.Z`；预览版确定性派生为 `X.Y.Z-preview.<commit Unix 秒>`，不建立 beta 通道。两类安装包都写入当前 commit、`releaseId` 和 SHA-256 receipt。正式发布 `X.Y.Z` 时，公开仓库的 `vX.Y.Z` tag 必须指向 receipt 中的 commit；构建脚本本身不上传或发布产物。

在 macOS 维护机上可以一次生成三端产物；Windows 交叉打包使用隔离 Wine 容器，macOS 仍必须由 macOS 构建：

```sh
pnpm desktop:preview --platform mac
pnpm desktop:preview --platform win
pnpm desktop:preview --platform linux
pnpm desktop:preview --platform all

pnpm desktop:stable --platform all
```

省略 `--platform` 时构建当前系统对应平台。Release 构建要求 Git worktree 干净。更新通过下载并替换同通道完整产品包完成；自动替换、平台签名、公证和差分资源更新均未开放。

## 验证

```sh
pnpm --filter @nekro-nxt/desktop typecheck
pnpm --filter @nekro-nxt/desktop test
pnpm desktop:preview --platform mac
```
