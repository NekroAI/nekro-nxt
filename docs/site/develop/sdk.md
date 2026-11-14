---
summary: 扩展能用的宿主能力、每项需要声明的权限、配置和凭据、钩子、定时任务、聊天命令和数据迁移。
ui: []
routes: []
keywords: [SDK, extension-sdk, API, 接口, 权限, permissions, nxt, harness, http.fetch, storage, 配置, 凭据, 钩子, 定时任务, 能力等级, requires.sdk]
---

# SDK 参考

`@nekro-nxt/extension-sdk` 主要是类型定义，加两个入口函数 `defineHostExtension` 和 `defineClientExtension`。真正的能力由 NekroNXT 在运行时注入：没有声明的能力调用时会报错，并指出缺了哪个声明。

```bash
npm i -D @nekro-nxt/extension-sdk
```

完整的类型和逐项细节见 [SDK 包说明](../../../packages/extension-sdk/README.md)；SDK 里也带了一份按主题分节的开发参考，智能体写扩展时读的就是它。

## 两层：本机实例和智能体挂载

一个扩展 = 一个**本机实例** + 每个启用它的智能体一份**智能体挂载**：

- `defineHostExtension(async ({ harness, config, nxt, logger }) => …)` 的函数在这台机器上只执行一次。这里注册界面的数据接口、平台适配器、钩子、命令和定时任务处理；参数里的 `nxt` 是本机层服务，按清单的 `permissions.host` 检查；
- 函数返回的插件挂到每个启用它的智能体上。在 `apply(ctx)` 里注册工具；`inject` 里加上 `nxt` 后，`ctx.nxt` 是绑定到这个智能体和当前频道的服务，按 `permissions.agent` 检查。

## harness：注册

| 方法 | 用途 |
| --- | --- |
| `defineTool`、`registerTool` | 定义并注册智能体的工具，在 `apply(ctx)` 里调用 |
| `handle` | 注册页面和面板调用的数据接口（`rpc`），在本机实例阶段调用 |
| `registerAdapter` | 注册一个聊天平台适配器，每个扩展最多一个 |
| `registerCommand` | 注册聊天命令，完整名是 `/扩展ID:命令` |
| `onInbound` | 消息入库后、唤醒智能体前处理入站消息 |
| `onOutbound` | 处理智能体发出的消息：读取、改写或取消 |
| `onJob` | 本扩展的定时任务到期、唤醒智能体之前运行 |
| `migrateData` | 数据格式升级时迁移旧数据 |
| `config` | 读取本机配置 |

注册工具时直接 `harness.registerTool(ctx, tool)`。不要写成 `ctx.effect(() => …)` 再返回注销函数，那样工具一注册就会被注销。

## nxt：宿主能力

“声明”一列写在清单的 `permissions.agent` 里；也能在本机层使用的写在 `permissions.host` 里。

| 能力 | 做什么 | 需要声明 |
| --- | --- | --- |
| `http` | `http.fetch` 发网络请求，响应最大 32 MiB。已经拦截内网和云元数据地址，不要绕开它直接用全局 `fetch` | `network`，见[网络](#网络) |
| `secrets` | 读取配置里的凭据字段；`secrets.placeholder` 返回占位符，NekroNXT 发请求时才替换成真值 | 配置字段 `meta.role: 'secret'` |
| `storage` | JSON 键值存储，按智能体、频道、成员或共享分区 | `storage: { scopes, quotaBytes? }` |
| `assets` | 生成、收录和读取图片等资源 | `assets` |
| `image` | 读取图片的格式、尺寸、帧数 | `assets: { library }` |
| `files` | 临时工作文件和缓存，`files.fromUrl` 下载文件 | `files` |
| `media` | 用附加功能里的 ffmpeg 探测、截帧、提取音频、转换格式 | `media: true` |
| `commands` | 运行附加功能提供的程序（ffmpeg、ffprobe），高风险 | `commands: { profiles }` |
| `speech` | 用附加功能里的语音识别转写 | `speech` |
| `index` | 宿主维护的检索索引，支持语义检索 | `index: { collections }` |
| `context` | 当前智能体、频道、最近一条入站消息 | 无 |
| `members` | 读取频道成员的信息 | 无 |
| `history` | 只读当前频道的对话记录 | `history: { read: true }` |
| `platform` | 调用当前频道所在平台的动作 | `platform: { actions, raw }` |
| `jobs` | 定时任务：建、查、取消 | `jobs` |
| `llm` | 用智能体当前的模型完成一次辅助任务，计入她的用量 | `llm: { maxCallsPerTurn, maxOutputTokens }` |
| `render` | 用系统字体把 SVG 渲染成图片 | 无 |
| `parse` | 网页转 Markdown，解析 RSS/Atom | 无 |
| `prompt` | 往智能体的提示词里加固定段落或每轮刷新的动态上下文 | `context` |
| `logger` | 写运行日志，在「日志」里按来源查看 | 无 |

本机层（factory 参数里的 `nxt`）还有 `models`：用「设置 → 模型」里的模型完成页面发起的任务，需要在 `permissions.host` 里声明 `models`。

工具的 `execute(args, { signal, progress })` 可以响应取消、报告进度；`timeoutSeconds` 设 1–900 秒的超时。工具结果可以返回图片 `{ type: 'image', assetId, label }`，交给有视觉能力的模型。

## 权限

只申请用得到的权限：

- 本机层（`permissions.host`）在安装时确认，对整台机器生效；智能体层（`permissions.agent`）在为智能体启用时确认，只对那个智能体生效；
- 联网尽量限定域名，不要申请任意联网；
- 能用 `secrets.placeholder` 就不要读取凭据原文；
- 页面只用的联网写在本机层，不要写在智能体层。

社区审查会逐项判断每个权限是“必要且最小”“超出需要”还是“使用可疑”，见[发布到社区](publish.md#审查)。

### 网络

`network` 有三种写法：

| 写法 | 能访问 |
| --- | --- |
| `{ mode: 'domains', domains: ['api.example.com', '*.cdn.example.com'] }` | 列出的域名 |
| `{ mode: 'config', fields: ['baseUrl'] }` | 所列配置字段里填写的地址 |
| `{ mode: 'unrestricted', purpose, fields? }` | 任意公网地址，启用时用户要确认风险 |

本机和局域网地址一律拦截，只有一种例外：`fields` 所列配置字段里用户填写的地址，主机和端口都对上时可以访问。用户把自建服务填成 `http://127.0.0.1:7860` 或局域网里的 `http://nas.local:8080`，扩展能连上；智能体代填的地址不算。重定向每一跳都重新检查。

既要下载任意网址、又要连用户自建服务的扩展，用 `unrestricted` 加 `fields`，需要 `requires: { sdk: 16 }`。

## 配置

`config.host`（本机配置，所有智能体共用）和 `config.agent`（每个智能体一份）用 `configSchema` 描述，支持对象、字符串、数字、布尔、枚举和数组。字段可以设：

- `meta.role: 'secret'`：凭据，用户从「设置 → 凭据」里选择或新建；
- `meta.role: 'textarea'`：多行文本；
- 说明文字、高级选项、分组和按条件显示。

在工具里用 `ctx.config()` 读取智能体配置，凭据字段读到的是占位符，直接拼进请求头即可。

## 界面

`defineClientExtension(({ React, host, styles }) => …)` 注册页面、面板、工具结果的展示和富消息。界面通过 `host.call` 调用本机实例里用 `harness.handle` 注册的数据接口，用宿主提供的组件库，保持和 NekroNXT 一致的外观。导入和保存时，每个面板都会在各种密度和明暗主题下真实渲染一遍，渲染失败、横向溢出、未捕获的错误都会拒绝。

## 能力等级

清单的 `requires.sdk` 声明需要的最低宿主能力等级，用到较新的接口时要调高，否则保存会被拒绝。较旧的 NekroNXT 看到要求更高等级的扩展时，会提示先升级。

| 等级 | 新增 | 最早支持的 NekroNXT |
| --- | --- | --- |
| 7 | Manifest V7 | 0.4.0 |
| 8 | 扩展资源库、检索索引、本机层模型 | 0.5.0 |
| 9–11 | 聊天命令、数据迁移和版本谱系 | 0.6.0 |
| 12–13 | 凭据占位符、出站钩子 | 0.7.0 |
| 14 | 工作文件、媒体处理、命令、语音识别、工具超时和进度 | 0.8.0 |
| 15 | `files.fromUrl` | 0.8.1 |
| 16 | 任意网络下访问配置里的本机和局域网地址（`unrestricted` 加 `fields`） | 0.10.0 |

## 数据迁移

扩展的存储数据格式变了，要在清单里提高 `dataVersion`，并注册 `harness.migrateData` 把旧数据转成新格式。迁移要能重复执行、不无故删数据。切换版本时 NekroNXT 会先留快照，迁移失败就恢复快照并退回原版本。
