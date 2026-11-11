# Android

NekroNXT 的 Android 应用：原生 Kotlin 薄壳，用系统 WebView 加载实例自己的 Web，界面随实例更新。决定与理由见[移动端访问与系统通知](../../docs/decisions/accepted/2026-11-10-移动端访问与系统通知.md)的 A1–A7。

壳只做页面做不到的事：

- **连接与登录**：`ConnectActivity` 以扫码为主：已登录设备显示的配对二维码带地址、证书指纹和一次性配对码（A5）；系统相机打开的配对链接经 `PairLinkActivity` 转入，连接前显示地址。手动方式填地址，再填配对码或管理密钥（走 Desktop 的配对协议）。按地址判断传输方式（受信任 HTTPS、自签名证书固定指纹、确认风险后的 HTTP）。管理密钥不保存；设备密钥用 Android Keystore 加密保存。
- **会话**：`WebShellActivity` 用设备密钥开会话并写入 WebView 的 Cookie。页面报告会话结束（`session-expired`），或实例把页面送去 `/login` 时，壳重开会话，不显示浏览器登录页。
- **证书**：原生请求和 WebView 校验同一个 SPKI 指纹（`Pins.kt`）。自签名证书下 Chromium 不注册 Service Worker，所以连不上实例时由壳显示自己的提示页。
- **系统行为**：返回手势先关浮层，再在页面内后退，一级页面直接离开应用；边到边显示，系统栏与键盘的尺寸写入页面的 `--safe-*`；文件选择接系统选择器并提供拍照；站外链接交给系统浏览器；页面生成的文件和带 `download` 的链接存入「下载」；系统栏图标跟随页面主题。

- **后台通知**（A4）：`BackgroundService` 是前台服务，长轮询 `/api/client-notifications?events=1`，按事件分设通知类别，点击打开对应页面；首次连接后说明用途，由用户开启。开机和更新后自动恢复。
- **更新**（A7）：`Updater` 读 `dl.nekro.ai/nxt/android/<渠道>/manifest.json`，下载、核对后交给系统安装；开发版跟随预览版，正式版跟随正式发布。

页面与壳之间的消息定义在 `apps/web/src/android-shell.ts`，壳在 `WebShellActivity.onPageMessage` 里处理，两边同步修改。

## 构建

需要 JDK 17 与 Android SDK（platform 35）。

```bash
cd apps/android
./gradlew testDebugUnitTest lintDebug assembleDebug
```

开发版包名为 `ai.nekro.nxt.dev`，可以与正式版同时安装。本机构建使用本机的 debug 密钥；CI 用仓库密钥 `ANDROID_DEV_KEYSTORE_BASE64`、`ANDROID_DEV_KEYSTORE_PASSWORD`、`ANDROID_DEV_KEY_ALIAS`、`ANDROID_DEV_KEY_PASSWORD` 签名：`.github/workflows/android.yml` 检查每次改动，`ci.yml` 的 `preview-android` 把它附到滚动预览版。

正式版：把 `app/build.gradle.kts` 的 `versionName` 改成新版本并合入 `main`，再推送标签 `android-vX.Y.Z`。`.github/workflows/android-release.yml` 在受保护环境 `android-release` 中运行，需要所有者批准；环境密钥为 `ANDROID_RELEASE_KEYSTORE_BASE64`、`ANDROID_RELEASE_KEYSTORE_PASSWORD`、`ANDROID_RELEASE_KEY_ALIAS`、`ANDROID_RELEASE_KEY_PASSWORD`。发布脚本是 `scripts/android-release.mjs`。

开发版开启了 WebView 调试，连接电脑后可在 `chrome://inspect` 查看页面。
