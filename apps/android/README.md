# Android

NekroNXT 的 Android 应用：原生 Kotlin 薄壳，用系统 WebView 加载实例自己的 Web，界面随实例更新。决定与理由见[移动端访问与系统通知](../../docs/decisions/accepted/2026-11-10-移动端访问与系统通知.md)的 A1–A7。

壳只做页面做不到的事：

- **连接与登录**：`ConnectActivity` 读实例描述，按地址判断传输方式（受信任 HTTPS、自签名证书固定指纹、确认风险后的 HTTP），用管理密钥走 Desktop 的配对协议登记设备。管理密钥不保存；设备密钥用 Android Keystore 加密保存。
- **会话**：`WebShellActivity` 用设备密钥开会话并写入 WebView 的 Cookie。页面报告会话结束（`session-expired`），或实例把页面送去 `/login` 时，壳重开会话，不显示浏览器登录页。
- **证书**：原生请求和 WebView 校验同一个 SPKI 指纹（`Pins.kt`）。自签名证书下 Chromium 不注册 Service Worker，所以连不上实例时由壳显示自己的提示页。
- **系统行为**：返回手势先关浮层，再在页面内后退，一级页面直接离开应用；边到边显示，系统栏与键盘的尺寸写入页面的 `--safe-*`；文件选择接系统选择器并提供拍照；站外链接交给系统浏览器；页面生成的文件和带 `download` 的链接存入「下载」；系统栏图标跟随页面主题。

页面与壳之间的消息定义在 `apps/web/src/android-shell.ts`，两边同步修改。

## 构建

需要 JDK 17 与 Android SDK（platform 35）。

```bash
cd apps/android
./gradlew testDebugUnitTest lintDebug assembleDebug
```

开发版包名为 `ai.nekro.nxt.dev`，可以与正式版同时安装。本机构建使用本机的 debug 密钥；CI（`.github/workflows/android.yml`）用仓库密钥 `ANDROID_DEV_KEYSTORE_BASE64`、`ANDROID_DEV_KEYSTORE_PASSWORD`、`ANDROID_DEV_KEY_ALIAS`、`ANDROID_DEV_KEY_PASSWORD` 签名，产物在工作流的 `nekro-nxt-android-dev` 附件里。正式版签名属于 A7，尚未实施。

开发版开启了 WebView 调试，连接电脑后可在 `chrome://inspect` 查看页面。
