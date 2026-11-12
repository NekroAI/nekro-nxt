# 使用文档的结构与发布

`docs/site/` 是使用文档的原文。CI 把它打成一个 JSON 文档包上传到分发桶，社区网站按文档包渲染 [nxt.nekro.ai/docs](https://nxt.nekro.ai/docs)，并提供给实例里的智能体查询。功能改动和对应的文档在同一个提交里更新。

## 目录

| 位置 | 内容 |
| --- | --- |
| `sections.json` | 栏目的 id、名称和页面顺序，也是导航顺序 |
| `<栏目>/<页面>.md` | 一页文档，站内地址 `/docs/<栏目>/<页面>`，发布后不再改名 |
| `flows/` | 界面流程，出图并检查页面是否过期，见下文 |
| `media/` | 效果图：演示舞台拍的群聊、动态创造等画面，发布前手动更新 |
| `widgets/` | 组件：数据格式与文字版（`spec.mjs`），网站上的交互版（`runtime/`） |
| `images/` | 其他图片 |
| `README.md` | 按栏目列出全部页面，由脚本生成 |

## 页面格式

每页以头部开始，接着是 `# 标题`：

```markdown
---
summary: 一句话说明这页解决什么
ui: [设置 → 模型]
routes: [/settings/models]
keywords: [模型, API Key]
---

# 接入模型供应商
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `summary` | 是 | 一句话，用于导航、搜索结果和页面描述 |
| `ui` | 否 | 这页对应的界面位置，智能体回答时用它告诉用户去哪里操作 |
| `routes` | 否 | 实例前端路由，顶栏的「?」按它打开对应页面；一个路由只能属于一页，最深的匹配优先 |
| `keywords` | 否 | 用户可能用来描述问题的词，参与搜索 |
| `since` | 否 | 页面所讲功能的起始版本 |
| `flow` | 否 | 对应的界面流程文件，用于出图和检查文档是否过期 |

头部只支持 `键: 值` 和 `键: [甲, 乙]` 两种写法。正文里不能再出现 `#` 一级标题；`##` 和 `###` 小节会生成锚点，锚点规则与 GitHub 相同。每个 `##` 小节应能单独读懂，智能体按小节读取。

链接直接写仓库里的相对路径：指向其他页面的会变成站内地址，并检查页面和小节是否存在；指向仓库其他文件的会变成 GitHub 地址；图片按内容哈希上传。

## 界面截图与流程

界面截图不进仓库，发布时由流程现拍。流程是 `flows/<名字>.flow.ts`，用 Playwright 在一个空白、构建好的实例上照着页面的步骤操作一遍：

```ts
import { expect, test } from './kit.js'

test.use({ modelReplies: ['你好！我是小奈。'] }) // 内置 DeepSeek 由本地假模型应答，按顺序说这些话

test('quickstart', async ({ page, docs }) => {
  await page.goto('/settings/models?provider=deepseek-official')
  await page.getByLabel('API 密钥', { exact: true }).fill('sk-docs-example')
  await docs.shot('quickstart-model-key', [page.getByText('全部供应商'), page.getByRole('button', { name: '添加模型' })])
})
```

- `docs.shot(名字, 元素?)` 浅色、深色各拍一张；给了元素就裁到这些元素的范围，不给就是整个窗口。截图名在所有流程里不能重复。
- 页面头部写 `flow: <名字>`，正文用 `![说明](shot:<截图名>)` 引用，说明文字显示在图下。只能引用自己流程里的截图。
- 页面里用「」括起来的词必须是 NekroNXT 界面上的文字，流程运行时会核对这些词是否真的出现过（`设置 → 模型` 按 → 拆开核对）。外部平台的界面文字用“”。
- 流程每次截图时记下屏幕上的文字；只在两张截图之间出现的文字，用 `docs.see()` 记一次。

效果图放在 `media/<名字>.webp`，正文写 `![说明](media:<名字>)`。

## 组件

讲流程、讲关系、带人一步步操作的地方，用组件代替大段文字。组件写成 `nxt:<种类>` 代码块，里面是 YAML；一份数据生成四样东西：

| 产出 | 给谁 |
| --- | --- |
| 交互版 | 网站读者：可以点、可以播放 |
| 文字版 | 智能体和搜索：打包时由数据生成，说清图上的全部内容 |
| 静态图 | 网站加载前、外部读者、智能体发给用户：每个关键状态浅色深色各一张 |
| 动图 | 带动画的组件另出一张 GIF，用来发进聊天 |

文字版直接由数据生成，所以数据里的文字要能单独读懂：步骤写成完整的一句，节点的 note 写清它做什么。

### 截图导览 `nxt:tour`

流程截图上按顺序标出要点的地方，读者点哪一步就高亮哪里，也可以逐步播放。每一步另有一张静态图，智能体可以只发“第 2 步”给用户。

```yaml
id: quickstart-wiring-tour        # 全站唯一，智能体按它找图
title: 在接线页把群交给智能体
shot: quickstart-wiring           # 本页流程里的截图
steps:                            # 1–8 步
  - mark: add                     # 流程里 docs.shot 的 marks 名
    text: 点「添加平台账号」，按平台提示登录或填写凭据。
```

要标的元素在流程里用 `marks` 交给 `docs.shot`，位置由流程现量，界面改版后会自动对齐：

```ts
await docs.shot('quickstart-wiring', targets, { marks: { add: page.getByRole('button', { name: '添加平台账号' }) } })
```

步骤里的「」词和正文一样会核对。

### 图解 `nxt:diagram`

三种固定样式，全站的图长得一致：

- `type: flow`：方框和箭头。不写 `at` 就按节点顺序连成一串，放不下时折行；写了 `at: [列, 行]` 就按格子摆，`edges` 写连线和线上的字。`animate: true` 时一个点沿连线依次走过，并另出一张 GIF。
- `type: layers`：从上到下的几层，每层可以列几项。
- `type: compare`：几列并排对照，`tone` 用 `positive`、`neutral`、`negative` 标出好坏。

```yaml
id: concepts-map
title: 几样东西怎么连在一起
type: flow
nodes:
  - id: account
    label: 平台账号                # 最多 16 字
    note: QQ 机器人、微信……         # 最多 40 字
    at: [0, 0]
  - id: channel
    label: 频道
    at: [1, 0]
edges:
  - from: account
    to: channel
    label: 带进来
```

### 链路动画 `nxt:pipeline`

一样东西依次经过固定的几环，一个点沿着走，下方说明这一环做什么。读者可以播放、暂停、前后单步，点某一环停在那里。每一环另有一张静态图，另出一张 GIF。比 `flow` 的 `animate` 多一层：每一环都有一段说明。

```yaml
id: concepts-message-path
title: 一条群消息怎么变成回复
stages:                           # 2–8 环
  - label: 群友发言                # 最多 8 字
    note: 比如 @ 了她              # 可选，最多 16 字
    detail: 群里有人说了一句话，比如 @ 了她。   # 最多 120 字
```

### 聊天回放 `nxt:chat`

一段虚构的群聊逐条出现。写了 `modes` 时，上方可以切换方式，同一段聊天按所选方式重放；别的方式会回、这种方式不回的消息下面标出来。每种方式各一张静态图；GIF 依次播放每种方式。不写 `modes` 时，`reply` 直接写她的回复。

```yaml
id: response-trigger-modes
title: 同一段群聊，三种触发方式
agent: 小荧                       # 群里显示的名字，虚构
modes:                            # 可选，2–4 种
  - id: mention
    label: 被提及时
    note: 只有 @ 她或回复她的消息时才叫醒她
  - id: smart
    label: 智能响应
messages:                         # 最多 14 条
  - from: 小林
    text: '@小荧 周六山上会下雨吗'  # @ 开头要加引号
    reply:
      mention: 周六多云转晴。        # 没写的方式就是不回
      smart: mention              # 和另一种方式回得一样
```

### 排查向导 `nxt:wizard`

一次问一个问题，按回答走到下一问，最后落到一个办法。答过的问题留在上方，点一下回到那里。文字版是整棵问答树，智能体可以照着在聊天里一问一答地带用户排查；只出第一问的静态图，不出 GIF。

```yaml
id: troubleshoot-no-reply
title: 群里没反应
steps:                            # 第一步是起点，必须是问题
  - id: paused
    ask: 频道右侧的「暂停回应」开着吗？
    choices:                      # 2–4 个
      - label: 开着
        next: resume
      - label: 没开
        next: inspect
  - id: resume
    answer: 关掉「暂停回应」，或在群里发 /resume。
    link: ../channels/response.md#暂停回应   # 可选，和正文链接写法一样；本页小节写 '#小节'
  - id: inspect
    answer: 打开「透视」看她这一轮做了什么。
```

每一步都要走得到，问题不能绕回去。问题、选项、办法和链路说明里的「」词和正文一样会核对。

### 出图与发布

`pnpm docs:shots` 先跑流程，再用 `scripts/docs-widgets.mjs` 给每个组件出图，写入 `.local/docs-shots/widgets`。打包时组件的运行时、图片和文字版一起进文档包；网站先显示静态图，运行时加载后换成交互版。组件出图失败时沿用上一版的图，正式版发布时直接失败；截图导览的截图或标注不见了，页面标为「待更新」。

智能体读文档时，组件换成文字版和总览图；页面里所有图（截图、效果图、组件各状态）列成可发送的清单，每张有编号和说明。

页面在这些情况下标为「待更新」：流程失败、界面上找不到页面引用的「」词。待更新的页面照常发布，截图沿用上一版；正式版发布时有待更新页面会直接失败。

`readme` 命令同时生成 `apps/web/src/app/shell/docs-routes.ts`，即顶栏「?」用的路由表。

「扩展开发 → SDK 参考」是手写的；检查时会核对 `packages/extension-sdk` 里 `NxtHostService`、`NxtHostLayerService` 的每项能力和 `harness` 的每个方法都在这一页以代码形式出现，SDK 新增接口时要同时补上说明。

产品代码里的文档链接写成 `https://nxt.nekro.ai/docs/<栏目>/<页面>#<小节>`，检查时会核对页面和小节是否存在。

## 命令

```bash
node scripts/docs-bundle.mjs check               # 检查页面、链接、生成的 README 和代码里的文档链接；已包含在 pnpm check:docs 中
node scripts/docs-bundle.mjs readme              # 增删页面或改了标题、summary、routes 后重新生成 README 和路由表
pnpm build && pnpm docs:shots                    # 运行全部流程，截图和报告写入 .local/docs-shots
node scripts/docs-bundle.mjs build preview       # 在 .local/docs-bundle 生成文档包；--strict 时有待更新页面就失败
node scripts/docs-bundle.mjs upload preview      # 上传到分发桶，需要 R2_ACCOUNT_ID、R2_ACCESS_KEY_ID、R2_SECRET_ACCESS_KEY
```

## 发布

稳定版文档随正式版发布，预览版文档随预览版发布，所以文档和对应安装包的界面一致。

分发桶里的位置：

| 键 | 内容 |
| --- | --- |
| `nxt/docs/<channel>/manifest.json` | 指向当前文档包，`channel` 为 `stable` 或 `preview` |
| `nxt/docs/<channel>/bundles/<sha256>.json` | 文档包，按内容寻址，不会修改 |
| `nxt/docs/assets/<哈希>.<扩展名>` | 图片和截图，两个通道共用 |

先上传图片和文档包，最后替换 `manifest.json`，读取方不会看到只上传了一半的版本。

manifest：

```json
{ "schemaVersion": 1, "channel": "stable", "version": "0.9.0", "commit": "<40 位>", "builtAt": "<ISO 时间>", "bundle": "bundles/<sha256>.json" }
```

文档包（`schemaVersion: 1`）：

```ts
interface DocsBundle {
  schemaVersion: 1
  channel: 'stable' | 'preview'
  version: string
  commit: string
  builtAt: string
  sections: { id: string; title: string; pages: string[] }[] // 没有页面的栏目不出现
  shots: Record<string, { light: string; dark: string; width: number; height: number }> // 正文里的 shot:<名字>
  pages: {
    id: string // '<栏目>/<页面>'
    section: string
    title: string
    summary: string
    since?: string
    ui: string[]
    routes: string[]
    keywords: string[]
    stale: boolean // 流程失败或界面文字对不上，正文待更新
    markdown: string // 不含头部和 # 标题；站内链接为 /docs/<id>#<锚点>，图片为绝对地址，截图保留为 shot:<名字>
    headings: { depth: 2 | 3; text: string; anchor: string }[]
  }[]
}
```

## 旧地址

已发布的版本和发布说明里有指向 `docs/guide/` 的链接，这些位置保留了迁移说明：[快速开始](../guide/getting-started.md)、[桌面版](../guide/desktop.md)、[服务端部署](../guide/server.md)、[手机](../guide/mobile.md)、[升级与备份](../guide/upgrade-backup.md)。
