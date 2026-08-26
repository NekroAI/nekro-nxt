# Desktop Host

该应用是 NekroNXT 完整本地产品的 Electron 宿主。它不实现第二套领域逻辑，也不连接平台方维护的中心后端：Electron 主进程启动当前安装包内的 Server 生产入口，Server 装配同版本 DSH、Core、Extension Runtime，并托管当前安装包内的 `apps/web/dist`。

Desktop 自带本地 `nxt.product-release`，并可保存多个远程服务实例。每个远程实例加载该 Server 同包 Web UI，通过 management/chrome protocol 版本门禁保持 UI、Host、DSH 与 Extension Bridge 匹配。Electron 在本地 Host `/health/ready` 返回相同 `releaseId` 后开放本地 Profile。

每次 Desktop 运行只为本地 Host 分配一次 loopback 端口。Host 就绪后若异常退出，主进程按 `500ms → 1s → 2s → 5s → 5s` 有界退避在同一端口启动替代进程；60 秒滚动窗口内最多发起 5 次恢复。应用退出会取消退避和就绪探测，终止当前 Host，并等待子进程退出。

BrowserWindow 使用 Product、Instance Overlay 与 Trusted Fallback 三类 `WebContentsView`。本地与每个远程 Profile 使用独立持久 partition；切换时先在旧 Product 上方预加载背景透明、正文隐藏的同主题状态页，再用 240ms 淡入完整覆盖旧实例，随后才销毁旧 Product。整段切换从淡入开始至少约 2 秒；新 Product 完成同源校验且最短时间满足后，状态页用 240ms 淡出以露出新实例，避免暴露 WebContents 裸帧或两端硬切。正常切换只显示“服务实例 / 正在切换”，内部 Trusted Fallback 名称不进入界面。Instance Overlay 覆盖顶栏下方的窗口正文，以整面 scrim 承接外部点击，左下角承载 420px 宽、最大 560px 高的可信 Sheet；实例项使用与频道选择器一致的 4px 间距和滑动选中标记，Dialog 本身无焦点描边，表单空白点击显式 blur。Product 与 Overlay Renderer 都在根元素保存当前命中控件的稳定 cursor 意图，避免原生 View 重绘期间在 pointer/default 之间闪烁。Sheet 始终位于 Product 或 Fallback 上方。Overlay 顶层导航只允许安装包内精确 `instance-overlay.html` file URL，Fallback 只允许当前 data 恢复页与主进程消费的固定恢复动作；两者都拒绝其他 navigation/redirect。每次 Fallback load 持有独立 token 与当次 Profile/action，旧 load 的迟到 abort/reject 不处理新页面，旧 data 页也不能借新 Profile action。Overlay 每个可信 document load 都复核精确 URL，打开时按 document/intent 代际只恢复一次 visibility，关闭时 reload 不会误开。Overlay 敏感 IPC 同时核对 WebContents id、顶层 `senderFrame` 和精确可信 URL。Manager dispose 先注销自己记录的全部 IPC handle 与精确 listener，再清空解密后的运行时设备凭据、通知 cursor、availability 和其他内存状态，最后拆除 View；同进程可以安全重建 manager，且不会移除其他模块的 listener。远程页面只有当前实例展示和打开实例 Sheet 的窄 Bridge。Profile 位于 Electron `userData`，设备 Secret 通过 `safeStorage` 加密并与 Profile 分离。窗口样式和系统通知由 Desktop 主进程拥有。

本地 Profile 健康只消费 HostSupervisor 的就绪、重启、恢复和致命停止提交点；成功加载 Product 或手工重试后可重新确认 `ready`。远程 Profile 由单一串行循环检查：一轮的健康、认证和通知读取全部结束后才安排下一轮，并用 Profile generation 拒绝切换、修改、重新认证、移除或 dispose 前发起的迟到结果。monitor 的取消与总探测超时贯穿 health、TLS/SPKI、descriptor 和 management session，停止后当前轮可以 settle，单个挂起实例不会永久堵住后续 Profile；任意意外 callback throw 被轮次边界记录并吸收，下一轮仍按间隔运行。通知读取与健康提交分离，通知接口、JSON 或授权错误不会把已经健康的实例改成离线。新 Desktop 发送单调 revision；Web 同时兼容 frozen desktop chrome protocol 1 不带 revision 的旧桥：legacy subscription 按到达顺序提交，迟到 initial Promise 不能覆盖已经收到的订阅事件。

Electron 精确锁定在经过依赖年龄门禁的 `42.9.0`。Electron 42.0.x 在 macOS Content View 的命中测试回归会吞掉 `WebContentsView` 内的 hover 等指针状态；上游在 [electron/electron#51617](https://github.com/electron/electron/issues/51617) 与 [electron/electron#51626](https://github.com/electron/electron/pull/51626) 修复并从 42.1.0 发布。Desktop 运行时依赖测试同时约束批准版本、lockfile 一致性，并禁止通过 `minimumReleaseAgeExclude` 绕过年龄门禁。

远程 Profile 的规范化地址与实例身份全局唯一。名称可直接编辑；地址变化或填写管理密钥时重新检查并认证，只有目标仍返回原实例身份才保留 Profile id 并提交，迁址同时轮换 partition；另一实例身份必须作为新服务实例添加。管理密钥不持久化。无协议地址按 HTTPS 处理，不探测或静默降级；显式标准端口保持标准端口，只有真正省略端口时才补 4960。显式非回环 HTTP 在任何实例请求前由可信浮层确认未加密风险，主进程同时核对确认的规范化 Origin；地址编辑使确认失效。HTTPS inspection 首次观察 TLS/SPKI，之后 descriptor、challenge、enrollment、session 和 revoke 的每条连接都在发送正文或接收数据前验证相同 SPKI。远程 Session 请求固定精确目标并使用 `redirect: error`；运行时提供最终响应 URL 时再核对其 Origin 与完整地址，Electron `session.fetch` 留空该字段时以已固定且禁止跳转的请求地址为准。Product View 同时阻止跨 Origin navigation/redirect 并在加载后复核最终 Origin。未配置管理密钥的 loopback HTTP Server 直接通过实例描述配对，不创建设备凭据；显式远程 HTTP 使用独立的 `explicit-http-v1` transport 与 management protocol 2，不声明 SPKI 或其他加密保证。添加或编辑连接在 Profile 提交前失败时清理新凭据并尽力撤销新设备；提交成功后旧设备、旧凭据与旧 partition 尽力清理。Profile Store、Credential Vault 与实例变更 IPC 串行写入，但不声明跨进程崩溃恢复日志。实例 IPC 在主进程可信边界映射为稳定错误码和简洁用户文案，Electron channel、method 与堆栈只进入诊断日志。

Windows、macOS 与 Linux Desktop 均保留 F12 渲染器诊断入口。焦点位于产品页面、服务实例 Sheet 或可信恢复页时，F12 打开对应 `WebContentsView` 的 DevTools。

分发脚本用 `pnpm deploy --prod --legacy` 把 Server 及其 workspace/外部生产依赖生成到 Desktop staging。`better-sqlite3` 与 `node-pty` 使用包内 N-API prebuild，Sharp、Koffi 和其他平台可选包按 `supportedArchitectures` 同时安装；Server runtime 同时携带 macOS arm64/x64 两套 N-API prebuild，运行时按 `process.arch` 选择，不参与 macOS 架构合并。准备脚本会拒绝缺少 macOS arm64/x64、Windows x64 或 Linux x64 原生文件的 runtime。Server runtime 和 Web dist 都作为安装包的 `extraResources` 放在应用代码之外。

生产数据固定在 Electron `userData/data/`，安装包替换不得删除该目录。Server 和 Desktop 使用同一个 Server 入口、数据根布局与升级门禁；Electron 只拥有窗口、单实例、外部链接和 Host 子进程生命周期。

Desktop 使用 Renderer 自绘的统一 48px 品牌顶栏，不显示系统标题栏。macOS 采用 `hiddenInset` 并为左侧 traffic lights 预留 84px；Windows/Linux 采用 `frame: false + titleBarOverlay` 并为右侧窗口控件预留 138px。主进程只注入根级安全区 CSS 变量，Renderer 顶栏负责拖动区域和业务内容，Web 保持同一几何但不伪造窗口按钮。

当前分发实验使用未签名完整安装包：Windows x64 NSIS、macOS arm64 与 x64 两个独立 DMG、Linux x64 AppImage。macOS 一次构建产出 `*-mac-arm64-v*.dmg` 与 `*-mac-x64-v*.dmg`，Apple Silicon 选择 arm64 包、Intel 选择 x64 包，每个 DMG 都带独立 receipt；server-runtime 的双架构 N-API prebuild 不参与架构合并。`stable` 与 `preview` 使用不同 appId、NSIS GUID、产品名、可执行文件名和 `userData`，可以同时安装，也不会让预览版迁移正式版数据库。身份的唯一源是 `distributions.json`。

平台品牌资源位于 `resources/stable/` 与 `resources/preview/`。两端分别提供 ICNS、ICO、Linux PNG 图标组、DMG 背景和 NSIS assisted installer 图；Preview 通过黄铜三节点校准胶囊与 Stable 区分，不建立 beta 品牌身份。ICNS 使用视觉占位更大的 macOS 专用母版，Windows、Linux 与 Web 仍使用通用源；DMG 保持固定 Finder 窗口并让必要内容在首次打开时完整可见。图标来源、DMG 精确尺寸、坐标和安全区以[品牌资产视觉规则](../../assets/brand/README.md#视觉规则)为唯一权威。electron-builder 按当前 channel 选择对应 `buildResources`，这些文件不进入应用运行资源。

产品版本的唯一手工来源是仓库根 `package.json#version`。正式版使用原值 `X.Y.Z`；预览版按 Git commit 时间与 commit 短哈希确定性派生为 `X.Y.Z-YYYYMMDD-HHmmssutc.g<commit 前 12 位>`，因此不同 commit 的版本和附件名必然不同。Preview 只由产品名和产物前缀表达一次，版本号不再重复加入 `preview`。两类安装包都写入当前 commit、`releaseId`、正整数 bytes 和 SHA-256 receipt；上传前重新计算本地安装包的 bytes 与 SHA-256，滚动发布时再核对 GitHub 安装包附件大小及可用 digest。正式发布 `X.Y.Z` 时，公开仓库的 `vX.Y.Z` tag 必须指向 receipt 中的 commit；本地构建命令只生成文件，不隐式上传。

`main` 的 push 在完整 CI 通过后由三个原生 GitHub runner 构建 Preview，并直接更新固定 `preview` tag 对应的滚动 Prerelease。公开 Release 只保留 Windows、Linux、macOS arm64 与 macOS x64 四个安装包；各 runner 生成的 receipt 作为短期 Actions Artifact 交给最终发布 job，不进入用户下载列表。四个安装包与内部 receipt 验证成功、且候选 commit 是远端 `main` 最新 HEAD 时才前移 `preview`；失败或已经过期的构建只在 `preview` tag 尚未指向该候选 commit 时清理自己的候选安装包，同 commit workflow 重跑失败不会删除已经发布的当前附件。正式版 `vX.Y.Z` tag 不可移动。

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
