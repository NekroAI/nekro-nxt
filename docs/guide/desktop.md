# 桌面版安装

NekroNXT 桌面版（Desktop）把界面与完整运行环境放进一个安装包，日常使用不要求预装 Node.js、pnpm、Python 或 Docker。

## 下载渠道

- **预览版（Preview）**：`main` 完整 CI 通过后更新的滚动构建；
- **稳定版（Stable）**：由固定版本 Tag 发布，当前尚未提供公开稳定版。

每个平台安装包旁都有 `receipt.json`，其中包含版本、Release ID、commit、文件大小和 SHA-256，可以用来核对下载文件。

## 平台

### macOS

下载与芯片匹配的 DMG：Apple Silicon Mac 选择文件名含 `-mac-arm64-` 的包，Intel Mac 选择含 `-mac-x64-` 的包，每个 DMG 都有独立 `receipt.json` 核对。打开后将 NekroNXT 拖入“应用程序”。当前预览包尚未签名，macOS 可能要求在“隐私与安全性”中确认首次打开。

### Windows

下载 x64 `setup.exe`。安装向导允许选择当前用户安装目录，卸载默认保留产品数据。

### Linux

下载 x64 AppImage，赋予执行权限后运行：

```bash
chmod +x nekro-nxt-*.AppImage
./nekro-nxt-*.AppImage
```

## 稳定版与预览版

两条通道使用不同 appId、安装身份、快捷方式和数据目录，可以并装。Preview 图标右下角带黄铜—流明蓝—黄铜三节点标记；不要把两个通道的数据目录互相覆盖。

升级同一通道时安装新的安装包。应用展示名是 `NekroNXT`，现有 `NekroNxt` 数据目录和可执行文件标识沿用原名，升级后会找到原来的数据。

## 数据与远程实例

桌面版的本地实例数据位于 Electron `userData/data/`。窗口还可以保存多个远程服务端；每个实例拥有独立设备凭据和浏览器存储。切换实例只改变当前管理界面，其他实例中的智能体照常运行。

备份和恢复见[升级、备份与恢复](upgrade-backup.md)。
