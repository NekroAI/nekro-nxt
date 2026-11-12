# 使用文档的结构与发布

`docs/site/` 是使用文档的原文。CI 把它打成一个 JSON 文档包上传到分发桶，社区网站按文档包渲染 [nxt.nekro.ai/docs](https://nxt.nekro.ai/docs)，并提供给实例里的智能体查询。功能改动和对应的文档在同一个提交里更新。

## 目录

| 位置 | 内容 |
| --- | --- |
| `sections.json` | 栏目的 id、名称和页面顺序，也是导航顺序 |
| `<栏目>/<页面>.md` | 一页文档，站内地址 `/docs/<栏目>/<页面>`，发布后不再改名 |
| `flows/` | 界面流程，出图并检查页面是否过期，见下文 |
| `media/` | 效果图：演示舞台拍的群聊、动态创造等画面，发布前手动更新 |
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
| `routes` | 否 | 实例前端路由，界面里的帮助入口按它打开对应页面 |
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

页面在这些情况下标为「待更新」：流程失败、界面上找不到页面引用的「」词。待更新的页面照常发布，截图沿用上一版；正式版发布时有待更新页面会直接失败。

产品代码里的文档链接写成 `https://nxt.nekro.ai/docs/<栏目>/<页面>#<小节>`，检查时会核对页面和小节是否存在。

## 命令

```bash
node scripts/docs-bundle.mjs check               # 检查页面、链接、生成的 README 和代码里的文档链接；已包含在 pnpm check:docs 中
node scripts/docs-bundle.mjs readme              # 增删页面或改了标题、summary 后重新生成 README
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
