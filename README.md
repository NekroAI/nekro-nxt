# NekroNxt

<p align="center">
  <img src="apps/web/public/brand/mark.svg" width="96" height="96" alt="NekroNxt Logo" />
</p>

<p align="center"><strong>月潮观测所</strong> · 冷静、精密、有生命感</p>

> 包名：`nekro-nxt`  
> 进度见 [`docs/04-一期开发计划与决策清单.md`](docs/04-一期开发计划与决策清单.md)

NekroNxt 是 NekroAI 的下一代智能体产品：以 DSH 为核心智能体引擎，原生支持网页与多平台群聊，同时兼具娱乐性、生产力和可由智能体参与开发的动态扩展能力。

## 当前目录

```text
nekro-nxt/
├─ AGENTS.md                 # AI 与开发者共同遵循的中文约束
├─ docs/                     # 可公开的当前设计、协议与决策
├─ prototype/                # 无依赖、可交互的需求确认原型
├─ assets/product-concepts/  # 早期概念图，仅作视觉参考
├─ apps/                     # Desktop、Server Host 与共享 Web UI
└─ packages/                 # 核心、运行时、Adapter 与共享基础包
```

## 从哪里开始

1. 阅读 [`AGENTS.md`](AGENTS.md) 与 [`docs/01-术语与文案规范.md`](docs/01-术语与文案规范.md)；
2. 阅读 [`docs/NekroNxt项目共识.md`](docs/NekroNxt项目共识.md) 了解产品范围；
3. 看一期进度读 [`docs/04-一期开发计划与决策清单.md`](docs/04-一期开发计划与决策清单.md)；
4. 消息、频道或 Adapter 工作阅读 [`docs/03-消息内容与投递协议.md`](docs/03-消息内容与投递协议.md)；
5. 改页面时阅读 [`docs/NekroNxt界面交互模型.md`](docs/NekroNxt界面交互模型.md) 和 [`docs/05-桌面UI与动效规范.md`](docs/05-桌面UI与动效规范.md)；
6. 工程约束阅读 [`docs/06-开发与测试规范.md`](docs/06-开发与测试规范.md)；
7. 引入外部机制或改公共契约时再读 [`docs/02-未来扩展方向.md`](docs/02-未来扩展方向.md) 与 [`docs/07-参考项目复用指南.md`](docs/07-参考项目复用指南.md)。

`docs/archive/` 是冻结历史，不是现行规范。`prototype/` 与概念图只作视觉参考，不以它们为准实现产品。

## 当前最重要的产品约束

- 产品名统一为 **NekroNxt**，包名统一为 `nekro-nxt`；
- 面向用户只使用“智能体”，不混用 Agent、AI 成员、机器人或助手；
- DSH 作为外部核心引擎集成，尽量不 Fork；
- Adapter、工具、Preset、UI Slot 等能力位于同一扩展体系；
- 所有用户可见消息经通信工具发送，模型原始输出只用于后台运行观察；
- 首版先打通本地动态创造、运行、验证、保存和启用闭环；
- 不迁移 Nekro Agent 的数据和资产，不承担兼容包袱；
- Desktop 与 Server 复用同一核心，Server 目标为单容器与单主要数据目录。

`prototype/` 与概念图只作视觉参考，实现以 `apps/web` 和现行文档为准。

## 完整产品分发实验

- `pnpm desktop:preview --platform mac|win|linux|all`：构建可与正式版并装的未签名预览版；
- `pnpm desktop:stable --platform mac|win|linux|all`：构建未签名正式版；
- `pnpm dist:server`：用当前产品版本和 commit 生成同一 Release 身份的完整 Server 镜像；
- `NEKRO_MANAGEMENT_KEY='<至少 32 个字符>' docker compose up --build`：以自动 TLS、设备鉴权、单容器和单 `/data` 启动 Server。

macOS 产物固定为 Universal DMG，Windows 与 Linux 当前固定为 x64。版本只修改根 `package.json#version`：正式版为 `X.Y.Z`，预览版自动派生为可读 UTC 构建时间 `X.Y.Z-YYYYMMDD-HHmmutc`；Preview 只在产品名和安装包前缀出现一次，没有 beta 通道。当前实验不提供平台签名、公证、整包自动替换或完整数据根恢复。边界见 [`原子产品 Release 与双宿主分发`](docs/decisions/accepted/2026-08-21-原子产品Release与双宿主分发.md)与 [`Desktop 多实例与设备鉴权`](docs/decisions/implemented/2026-08-23-Desktop多实例与设备鉴权.md)。
