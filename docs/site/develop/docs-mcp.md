---
summary: 把社区站的公开 MCP 服务加到 Claude、Cursor 等 AI 工具里，查 NekroNXT 的使用文档和社区扩展；也可以直接调用文档接口。
ui: []
routes: []
keywords: [MCP, 文档 MCP, Claude, Cursor, AI 工具, 查文档, 接口, API, docs api]
---

# 在 AI 工具里查文档

社区站提供一个公开、只读的 MCP 服务：`https://nxt.nekro.ai/mcp`。把它加到 Claude、Cursor 这类支持 MCP 的工具里，AI 就能直接搜索和阅读 NekroNXT 的使用文档、查找社区扩展，回答时附上文档链接。不需要登录或密钥。

写扩展时把它和 SDK 一起交给 AI 编程工具，它能查到界面在哪、功能怎么用。NekroNXT 里的智能体用的是自带的“查阅社区文档”能力，不需要另外配置，见[能力与授权](../agents/abilities.md#其他开关)。

## 添加到 AI 工具

支持远程 MCP（Streamable HTTP）的工具，在 MCP 配置里加：

```json
{
  "mcpServers": {
    "nekro-nxt-docs": {
      "url": "https://nxt.nekro.ai/mcp"
    }
  }
}
```

有的工具要写成 `"type": "http"` 加 `"url"`，或者在设置界面里填服务器地址，填同一个地址即可。只支持本地命令的工具，可以借助 `mcp-remote` 转接：

```json
{
  "mcpServers": {
    "nekro-nxt-docs": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://nxt.nekro.ai/mcp"]
    }
  }
}
```

## 提供的工具

| 工具 | 用途 |
| --- | --- |
| `search_docs` | 按关键词搜索文档，返回命中的页面和小节、链接和摘录 |
| `read_doc` | 读一页文档，给出 `anchor` 时只读那一节；截图导览、图解、链路动画、聊天回放、排查向导这些组件换成文字，末尾列出这部分的图和图上画了什么 |
| `get_doc_media` | 按 `read_doc` 给的编号取一张图，连同说明一起返回，能看图的客户端可以直接看 |
| `list_docs` | 列出文档的全部栏目和页面 |
| `search_extensions` | 搜索社区里公开的扩展，返回简介、审查结论和扩展页链接 |

文档默认是稳定版，传 `channel: "preview"` 查预览版。

## 直接调用接口

程序里也可以直接用 REST 接口，返回 JSON，允许跨域：

| 接口 | 内容 |
| --- | --- |
| `GET /api/v1/docs` | 栏目和页面目录 |
| `GET /api/v1/docs/search?q=关键词&limit=5` | 搜索 |
| `GET /api/v1/docs/pages/<栏目>/<页面>?anchor=小节` | 一页或一个小节的 Markdown，`media` 列出其中的图 |
| `GET /api/v1/docs/media?ref=编号` | 一张图的地址和说明 |

都可以加 `channel=preview` 读预览版。

## 限制

- 只读，内容和网站上的[使用文档](https://nxt.nekro.ai/docs)、社区扩展一致；
- 每次请求独立处理，没有会话和推送；
- 按来源地址限流，每分钟约 60 次，超出返回 HTTP 429。
