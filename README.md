# NekroNxt

> 包名：`nekro-nxt`  
> 状态：立项与交互确认阶段

NekroNxt 是 NekroAI 的下一代智能体产品：以 DSH 为核心智能体引擎，原生支持网页与多平台群聊，同时兼具娱乐性、生产力和可由智能体参与开发的动态扩展能力。

## 当前目录

```text
nekro-nxt/
├─ AGENTS.md                 # AI 与开发者共同遵循的中文约束
├─ docs/                     # 可公开的当前设计、协议与决策
├─ prototype/                # 无依赖、可交互的需求确认原型
├─ assets/product-concepts/  # 早期概念图，仅作视觉参考
├─ apps/                     # 未来 Desktop、Server、Web 应用
└─ packages/                 # 未来核心、运行时和扩展包
```

## 从哪里开始

1. 阅读 [`docs/00-文档公开边界.md`](docs/00-文档公开边界.md)；
2. 阅读 [`docs/01-术语与文案规范.md`](docs/01-术语与文案规范.md)；
3. 阅读 [`docs/NekroNxt项目共识.md`](docs/NekroNxt项目共识.md)；
4. 新功能设计前阅读 [`docs/02-未来扩展方向.md`](docs/02-未来扩展方向.md) 和相关 Decision Note；
5. 消息、频道或 Adapter 工作必须阅读 [`docs/03-消息内容与投递协议.md`](docs/03-消息内容与投递协议.md)；
6. 开始一期实现前阅读 [`docs/06-一期开发计划与决策清单.md`](docs/06-一期开发计划与决策清单.md)；
7. 打开 [`prototype/index.html`](prototype/index.html) 验证产品交互；
8. 需要深入架构时再阅读完整设计和专题协议。

## 当前最重要的产品约束

- 产品名统一为 **NekroNxt**，包名统一为 `nekro-nxt`；
- 面向用户只使用“智能体”，不混用 Agent、AI 成员、机器人或助手；
- DSH 作为外部核心引擎集成，尽量不 Fork；
- Adapter、工具、Preset、UI Slot 等能力位于同一扩展体系；
- 所有用户可见消息经通信工具发送，模型原始输出只用于后台运行观察；
- 首版先打通本地动态创造、运行、验证、保存和启用闭环；
- 不迁移 Nekro Agent 的数据和资产，不承担兼容包袱；
- Desktop 与 Server 复用同一核心，Server 目标为单容器与单主要数据目录。

## 原型

原型是纯 HTML/CSS/JavaScript，不连接真实模型，也不写入真实配置。顶部可以快速跳转七个场景并显示交互逻辑标注。刷新页面会恢复初始状态。

概念图中仍可能出现旧称 Agent，它们已被标记为历史视觉参考；后续实现以原型和术语规范为准。
