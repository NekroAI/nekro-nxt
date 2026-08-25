# Desktop Host

该应用是 NekroNXT 完整本地产品的 Electron 宿主。它不实现第二套领域逻辑，也不连接平台方维护的中心后端：Electron 主进程启动当前安装包内的 Server 生产入口，Server 装配同版本 DSH、Core、Extension Runtime，并托管当前安装包内的 `apps/web/dist`。

Desktop 自带本地 `nxt.product-release`，并可保存多个远程服务实例。每个远程实例加载该 Server 同包 Web UI，通过 management/chrome protocol 版本门禁保持 UI、Host、DSH 与 Extension Bridge 匹配。Electron 在本地 Host `/health/ready` 返回相同 `releaseId` 后开放本地 Profile。

每次 Desktop 运行只为本地 Host 分配一次 loopback 端口。Host 就绪后若异常退出，主进程按 `500ms → 1s → 2s → 5s → 5s` 有界退避在同一端口启动替代进程；60 秒滚动窗口内最多发起 5 次恢复。应用退出会取消退避和就绪探测，终止当前 Host，并等待子进程退出。

BrowserWindow 使用 Product、Instance Overlay 与 Trusted Fallback 三类 `WebContentsView`。本地与每个远程 Profile 使用独立持久 partition；切换关闭旧 Product View。远程页面只有当前实例展示和打开实例浮层的窄 Bridge。Profile 位于 Electron `userData`，设备 Secret 通过 `safeStorage` 加密并与 Profile 分离。窗口样式和系统通知由 Desktop 主进程拥有。

Electron 精确锁定在经过依赖年龄门禁的 `42.9.0`。Electron 42.0.x 在 macOS Content View 的命中测试回归会吞掉 `WebContentsView` 内的 hover 等指针状态；上游在 [electron/electron#51617](https://github.com/electron/electron/issues/51617) 与 [electron/electron#51626](https://github.com/electron/electron/pull/51626) 修复并从 42.1.0 发布。Desktop 运行时依赖测试同时约束批准版本、lockfile 一致性，并禁止通过 `minimumReleaseAgeExclude` 绕过年龄门禁。

远程 Profile 的规范化地址与实例身份全局唯一，且创建后不可变；地址或实例身份变化时必须添加新的服务实例。现有 Profile 只允许改名、切换通知、重试、针对原地址与原实例身份重新认证和移除。无协议地址按 HTTPS 处理，不探测或静默降级；显式标准端口保持标准端口，只有真正省略端口时才补 4960。显式非回环 HTTP 在任何实例请求前由可信浮层确认未加密风险，主进程同时核对确认的规范化 Origin；地址编辑使确认失效。HTTPS inspection 首次观察 TLS/SPKI，之后 descriptor、challenge、enrollment、session 和 revoke 的每条连接都在发送正文或接收数据前验证相同 SPKI。远程 Session 请求使用 `redirect: error` 并核对最终 URL，Product View 同时阻止跨 Origin navigation/redirect 并在加载后复核最终 Origin。未配置管理密钥的 loopback HTTP Server 直接通过实例描述配对，不创建设备凭据；显式远程 HTTP 使用独立的 `explicit-http-v1` transport 与 management protocol 2，不声明 SPKI 或其他加密保证。注册后的本地凭据或 Profile 提交失败会在当前进程内清理新凭据并尽力撤销新设备。Profile Store、Credential Vault 与实例变更 IPC 串行写入，但不声明跨进程崩溃恢复日志。实例 IPC 在主进程可信边界映射为稳定错误码和简洁用户文案，Electron channel、method 与堆栈只进入诊断日志。

分发脚本用 `pnpm deploy --prod --legacy` 把 Server 及其 workspace/外部生产依赖生成到 Desktop staging。`better-sqlite3` 与 `node-pty` 使用包内 N-API prebuild，Sharp、Koffi 和其他平台可选包按 `supportedArchitectures` 同时安装；准备脚本会拒绝缺少 macOS Universal、Windows x64 或 Linux x64 原生文件的 runtime。Server runtime 和 Web dist 都作为安装包的 `extraResources` 放在应用代码之外。

生产数据固定在 Electron `userData/data/`，安装包替换不得删除该目录。Server 和 Desktop 使用同一个 Server 入口、数据根布局与升级门禁；Electron 只拥有窗口、单实例、外部链接和 Host 子进程生命周期。

Desktop 使用 Renderer 自绘的统一 48px 品牌顶栏，不显示系统标题栏。macOS 采用 `hiddenInset` 并为左侧 traffic lights 预留 84px；Windows/Linux 采用 `frame: false + titleBarOverlay` 并为右侧窗口控件预留 138px。主进程只注入根级安全区 CSS 变量，Renderer 顶栏负责拖动区域和业务内容，Web 保持同一几何但不伪造窗口按钮。

当前分发实验使用未签名完整安装包：Windows x64 NSIS、macOS Universal DMG、Linux x64 AppImage。`stable` 与 `preview` 使用不同 appId、NSIS GUID、产品名、可执行文件名和 `userData`，可以同时安装，也不会让预览版迁移正式版数据库。身份的唯一源是 `distributions.json`。

平台品牌资源位于 `resources/stable/` 与 `resources/preview/`。两端分别提供 ICNS、ICO、Linux PNG 图标组、DMG 背景和 NSIS assisted installer 图；Preview 通过黄铜三节点校准胶囊与 Stable 区分，不建立 beta 品牌身份。ICNS 使用视觉占位更大的 macOS 专用母版，Windows、Linux 与 Web 仍使用通用源；DMG 保持固定 Finder 窗口并让必要内容在首次打开时完整可见。图标来源、DMG 精确尺寸、坐标和安全区以[品牌资产视觉规则](../../assets/brand/README.md#视觉规则)为唯一权威。electron-builder 按当前 channel 选择对应 `buildResources`，这些文件不进入应用运行资源。

产品版本的唯一手工来源是仓库根 `package.json#version`。正式版使用原值 `X.Y.Z`；预览版按 Git commit 时间确定性派生为可读的 `X.Y.Z-YYYYMMDD-HHmmutc`。Preview 只由产品名和产物前缀表达一次，版本号不再重复加入 `preview`。两类安装包都写入当前 commit、`releaseId` 和 SHA-256 receipt。正式发布 `X.Y.Z` 时，公开仓库的 `vX.Y.Z` tag 必须指向 receipt 中的 commit；本地构建命令只生成文件，不隐式上传。

`main` 的 push 在完整 CI 通过后由三个原生 GitHub runner 构建 Preview，并直接更新固定 `preview` tag 对应的滚动 Prerelease，不使用 Actions Artifact 分发客户端。三端构建与 receipt 全部成功、且候选 commit 仍是远端 `main` 最新 HEAD 时才前移 `preview`；失败或已经过期的构建清理自己的候选附件并保留上一版完整 Preview。滚动页只保留最新一组三端安装包与 receipt，正式版 `vX.Y.Z` tag 不可移动。

在 macOS 维护机上可以一次生成三端产物；macOS 仍必须由 macOS 构建。未签名 Windows 包关闭依赖 Wine 的 EXE 资源编辑，保留 NSIS 安装身份和完整应用内容。Windows 引导安装保留“仅当前用户/所有用户”两种范围；electron-builder 固定使用包含安全 `UserProgramFiles` 路径读取修复的 `26.15.3`，不得降级到仍会在当前用户路径解析阶段越界退出的版本。获得签名证书后恢复 EXE 资源编辑与签名：

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
