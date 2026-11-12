# 使用文档的结构与发布

`docs/site/` 是使用文档的原文。CI 把它打成一个 JSON 文档包上传到分发桶，社区网站按文档包渲染 [nxt.nekro.ai/docs](https://nxt.nekro.ai/docs)，并提供给实例里的智能体查询。功能改动和对应的文档在同一个提交里更新。

## 目录

| 位置 | 内容 |
| --- | --- |
| `sections.json` | 栏目的 id、名称和页面顺序，也是导航顺序 |
| `<栏目>/<页面>.md` | 一页文档，站内地址 `/docs/<栏目>/<页面>`，发布后不再改名 |
| `images/` | 文档里引用的图片 |
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

产品代码里的文档链接写成 `https://nxt.nekro.ai/docs/<栏目>/<页面>#<小节>`，检查时会核对页面和小节是否存在。

## 命令

```bash
node scripts/docs-bundle.mjs check               # 检查页面、链接、生成的 README 和代码里的文档链接；已包含在 pnpm check:docs 中
node scripts/docs-bundle.mjs readme              # 增删页面或改了标题、summary 后重新生成 README
node scripts/docs-bundle.mjs build preview       # 在 .local/docs-bundle 生成文档包
node scripts/docs-bundle.mjs upload preview      # 上传到分发桶，需要 R2_ACCOUNT_ID、R2_ACCESS_KEY_ID、R2_SECRET_ACCESS_KEY
```

## 发布

稳定版文档随正式版发布，预览版文档随预览版发布，所以文档和对应安装包的界面一致。

分发桶里的位置：

| 键 | 内容 |
| --- | --- |
| `nxt/docs/<channel>/manifest.json` | 指向当前文档包，`channel` 为 `stable` 或 `preview` |
| `nxt/docs/<channel>/bundles/<sha256>.json` | 文档包，按内容寻址，不会修改 |
| `nxt/docs/assets/<哈希>.<扩展名>` | 图片，两个通道共用 |

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
  pages: {
    id: string // '<栏目>/<页面>'
    section: string
    title: string
    summary: string
    since?: string
    ui: string[]
    routes: string[]
    keywords: string[]
    stale: boolean // 界面已变、正文待更新
    markdown: string // 不含头部和 # 标题；站内链接为 /docs/<id>#<锚点>，图片为绝对地址
    headings: { depth: 2 | 3; text: string; anchor: string }[]
  }[]
}
```

## 旧地址

已发布的版本和发布说明里有指向 `docs/guide/` 的链接，这些位置保留了迁移说明：[快速开始](../guide/getting-started.md)、[桌面版](../guide/desktop.md)、[服务端部署](../guide/server.md)、[手机](../guide/mobile.md)、[升级与备份](../guide/upgrade-backup.md)。
