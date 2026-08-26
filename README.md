![NekroNXT：把 DeepSeek Harness 带到即时通讯](assets/brand/raster/readme-hero.png)

<p align="center">
  简体中文 · <a href="README.en.md">English</a> · <a href="docs/README.md">使用文档</a> · <a href="https://github.com/NekroAI/nekro-nxt/releases/tag/preview">下载预览版</a>
</p>

NekroNXT 是 NekroAI 开发的群聊智能体系统。它把智能体接入你正在使用的即时通信平台。智能体面对的是群聊里持续发生的多人对话，可以理解上下文、使用工具并参与协作。

## 💬 为真实群聊而设计

### 用一套方式连接不同即时通信平台

平台适配器负责登录账号、收发消息和发现频道。你可以把同一个智能体绑定到多个群聊，也可以为不同群聊安排不同智能体。安装新的适配器后，仍按账号、频道和智能体的顺序完成连接。

### 跟得上多人对话

每个群聊拥有独立的消息记录和会话上下文。群成员可以通过提及或预设规则触发智能体。系统先记录工具执行期间到达的新消息，再把这些内容交给智能体的下一步思考。每个群聊只读取自己的短期上下文。

### 由 DSH 提供智能体运行内核

DSH 负责智能体的思考循环、工具执行、会话持久化、上下文压缩、模型接入和扩展运行。NekroNXT 负责即时通信接入、频道管理、消息投递记录和产品界面。

## ✨ 还能做什么

- **长期管理智能体**：分别设置人设、模型、权限、频道和扩展；
- **确认每次发送**：文字、提及、图片和文件都由通信工具投递，界面显示实际发送结果；
- **连接多个群聊**：一个智能体可以服务多个频道，每个频道的会话彼此隔离；
- **给智能体增加能力**：工具、平台适配器、模型供应商和界面组件都通过扩展安装；
- **让智能体参与创造**：描述需求、运行新能力、查看验证结果、保存为本地扩展，再选择使用它的智能体；
- **选择合适的运行方式**：桌面版适合个人电脑，服务端适合长期在线和远程管理。

## 🖼️ 产品画面

![NekroNXT 中的多人频道会话、消息与运行过程](assets/brand/screenshots/channel-conversation.png)

截图仅供界面示意参考。

## 🚀 立即开始

### 桌面版：下载后直接使用

桌面版已经带上运行环境。下载对应平台的安装包，打开应用后配置模型即可开始。

| 支持平台 | 客户端下载                                                                         |
| -------- | ---------------------------------------------------------------------------------- |
| macOS    | [下载 NekroNXT Preview](https://github.com/NekroAI/nekro-nxt/releases/tag/preview) |
| Windows  | [下载 NekroNXT Preview](https://github.com/NekroAI/nekro-nxt/releases/tag/preview) |
| Linux    | [下载 NekroNXT Preview](https://github.com/NekroAI/nekro-nxt/releases/tag/preview) |

[查看桌面版安装说明](docs/guide/desktop.md)

### 服务端：用 Docker 长期运行

把 `<管理密钥>` 替换为至少 32 个字符的随机字符串，把 `<持久化目录>` 替换为宿主机上的数据目录：

```bash
docker run -d \
  --name nekro-nxt \
  --restart unless-stopped \
  -p 127.0.0.1:4960:4960 \
  -e NEKRO_MANAGEMENT_KEY='<管理密钥>' \
  -v '<持久化目录>:/data' \
  ghcr.io/nekroai/nekro-nxt:preview
```

[查看公网访问、Docker Compose、设备配对与备份说明](docs/guide/server.md)

## 三步开始使用

1. 在「设置 → 模型供应商」填写 API Key 并选择模型；
2. 创建一个智能体，设置名称、人设和可用能力；
3. 先在内置频道对话，或前往「连接」添加即时通信账号、选择群聊并绑定智能体。

完整步骤见[快速开始](docs/guide/getting-started.md)。

## 📚 文档与社区

| 目标                   | 入口                                                                                                                        |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 安装、配置并开始对话   | [快速开始](docs/guide/getting-started.md)                                                                                   |
| 连接即时通信平台与群聊 | [连接频道](docs/guide/connections.md)                                                                                       |
| 配置模型、智能体和扩展 | [模型](docs/guide/models.md) · [智能体](docs/guide/agents.md) · [扩展](docs/guide/extensions.md)                            |
| 部署、升级、备份或排障 | [服务端部署](docs/guide/server.md) · [升级与备份](docs/guide/upgrade-backup.md) · [常见问题](docs/guide/troubleshooting.md) |
| 参与开发               | [贡献指南](docs/CONTRIBUTING.md) · [贡献者文档](docs/guide/contributors.md)                                                 |
| 反馈问题               | [支持说明](docs/SUPPORT.md) · [GitHub Issues](https://github.com/NekroAI/nekro-nxt/issues)                                  |
| 社区交流               | NekroAI 官方 QQ 群 `636925153`                                                                                              |

## 当前状态

NekroNXT 处于早期预览阶段。创建智能体、群聊接入、频道对话和扩展创造的主流程已经跑通；平台适配、升级恢复和发行流程还在完善。`main` 通过检查后更新滚动预览版，稳定版将在发行条件齐备后提供。

安全问题请按[安全策略](docs/SECURITY.md)私密报告。社区交流遵循[行为准则](docs/CODE_OF_CONDUCT.md)。

软件代码以 [GNU AGPL v3.0](LICENSE)（SPDX：`AGPL-3.0-only`）授权；品牌与角色素材不属于该授权范围，使用边界见[品牌规范](docs/BRAND.md)和 [`NOTICE`](NOTICE)。

Copyright © 2026 NekroAI contributors.
