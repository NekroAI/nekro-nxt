# NekroNXT 文档

这里是 NekroNXT 的公开文档入口。第一次使用从快速开始进入；需要修改代码、协议或产品行为时，再进入贡献者与架构文档。

## 开始使用

1. [快速开始](guide/getting-started.md)：从安装到第一次内置频道对话；
2. [桌面版安装](guide/desktop.md)：macOS、Windows、Linux 安装包与稳定版/预览版；
3. [服务端部署](guide/server.md)：一行启动容器，详细配置 Docker、Compose、远程访问与数据目录；
4. [配置模型](guide/models.md)：模型供应商、API Key、连接测试和模型选择；
5. [创建智能体](guide/agents.md)：人设、模型、授权能力和内置频道；
6. [连接频道](guide/connections.md)：添加平台账号、发现频道、绑定和触发方式；
7. [使用扩展](guide/extensions.md)：动态运行、验证、保存和为智能体启用；
8. [升级、备份与恢复](guide/upgrade-backup.md)：双通道、数据根和恢复原则；
9. [常见问题与排障](guide/troubleshooting.md)：安装、Host、模型、连接和扩展问题；
10. [贡献者入口](guide/contributors.md)：源码开发、架构、测试和文档维护。

## 产品与设计

- [项目首页](../README.md)与[英文摘要](../README.en.md)：公众定位、安装入口、真实截图和社区信息；
- [项目共识](NekroNxt项目共识.md)：产品定位、一期范围和核心对象；
- [产品形态与用户旅程](NekroNxt产品形态与用户旅程.md)：完整用户路径和页面关系；
- [界面交互模型](NekroNxt界面交互模型.md)：页面对象、操作前提和真实后果；
- [术语与文案规范](01-术语与文案规范.md)：用户可见实体名称和文案语气；
- [桌面 UI 与动效规范](05-桌面UI与动效规范.md)：主题、布局、组件、动效和品牌使用；
- [一期开发计划](04-一期开发计划与决策清单.md)：当前状态与完成标准；
- [未来扩展方向](02-未来扩展方向.md)：尚未启动的能力和兼容接缝。
- [交互原型说明](../prototype/README.md)：早期对象关系参考，不替代现行产品页面。

## 架构与协议

- [消息内容与投递协议](03-消息内容与投递协议.md)：消息块、通信工具、Asset 和投递边界；
- [接线与 Server 宿主设计](08-接线与Server宿主设计.md)：Server、Web、HTTP、SSE 和静态入口；
- [Decision 路由](decisions/README.md)：跨包契约和实现决定；
- [Apps 索引](../apps/README.md)与 [Packages 索引](../packages/README.md)：代码所有者、消费者和包级命令。

## 工程与公开边界

- [开发与测试规范](06-开发与测试规范.md)：提交、测试阶梯、产品旅程和视觉验收；
- [文档公开边界](00-文档公开边界.md)：敏感信息、真实样本和发布前检查；
- [参考项目复用指南](07-参考项目复用指南.md)：引入外部机制时的证据与边界；
- [品牌资产](../assets/brand/README.md)与[品牌使用规范](BRAND.md)：Logo、安装资源、角色和宣传素材；
- [贡献指南](CONTRIBUTING.md)、[支持说明](SUPPORT.md)、[安全策略](SECURITY.md)与[社区行为准则](CODE_OF_CONDUCT.md)：参与项目和反馈问题；
- [NekroAI 组织主页资料](guide/organization-profile.md)：组织 Profile README 文案和素材映射；
- [仓库公开检查清单](guide/publication-checklist.md)：许可证、历史审计、GitHub About、安全报告和 ruleset；
- [冻结历史](archive/README.md)：只用于追溯过程，不作为现行规范。

## 文档维护

现行文档描述当前事实。每份受维护文档必须从根 `AGENTS.md` 经本索引或专题索引自然可达；`pnpm check:docs` 检查链接、标题片段、术语和根可达性。
