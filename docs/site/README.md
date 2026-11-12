# NekroNXT 使用文档

这里是使用文档的原文，发布在 [https://nxt.nekro.ai/docs](https://nxt.nekro.ai/docs)。栏目、页面头部和发布方式见[文档包格式](BUNDLE.md)。

<!-- 本文件由 node scripts/docs-bundle.mjs readme 生成，不要手改。 -->

## 开始使用

- [快速开始](start/quickstart.md)：从安装到在内置频道里和智能体说上第一句话。

## 安装与部署

- [桌面版安装](install/desktop.md)：在 macOS、Windows、Linux 上安装桌面版，选择稳定版或预览版。
- [Docker 部署](install/docker.md)：用 Docker 在服务器上长期运行 NekroNXT，以及数据目录、升级和重启。
- [通过公网和 HTTPS 访问](install/https.md)：让其他设备或公网通过 HTTPS 访问实例：反向代理与信任代理设置。
- [不用 Docker 部署服务端（非官方）](install/node.md)：不用 Docker、直接用 Node.js 运行服务端的社区做法，不在官方支持范围内。
- [在手机上使用](install/mobile.md)：在安卓应用或手机主屏幕上使用 NekroNXT，并接收后台通知。

## 模型

- [配置模型](models/providers.md)：接入模型供应商、填写 API Key 并测试连接。

## 智能体

- [创建和管理智能体](agents/create.md)：创建智能体，设置人设、模型和能力，以及她怎么记事。

## 频道与平台

- [连接频道](channels/wiring.md)：添加平台账号、发现频道，把频道连到智能体。
- [接入 QQ 官方机器人](channels/qq-official.md)：用 QQ 开放平台的官方机器人接入 QQ 群和私聊。
- [接入 OneBot V11](channels/onebot-11.md)：通过 OneBot V11 协议端接入 QQ。
- [接入企业微信智能机器人](channels/wecom.md)：接入企业微信智能机器人。
- [接入微信 iLink](channels/wechat-ilink.md)：通过微信 iLink 接入微信。

## 扩展

- [使用扩展](extensions/overview.md)：安装、创造、启用和管理扩展，以及版本、数据与安全。

## 运维

- [升级、备份与恢复](ops/upgrade-backup.md)：升级时自动生成的恢复点，以及出问题时怎么恢复。
- [登录与访问](ops/access.md)：实例的登录方式、设备管理和通行密钥。
- [查看运行日志](ops/logs.md)：查看、筛选和导出系统与插件日志。

## 排障

- [安装与启动](troubleshooting/install.md)：安装包被系统拦截、桌面版连不上服务时怎么办。
- [模型与回复](troubleshooting/models.md)：模型列表为空、智能体不回复时怎么排查。
- [平台接入](troubleshooting/platforms.md)：平台频道没有出现时怎么排查。
- [扩展](troubleshooting/extensions.md)：扩展保存后没有生效时怎么排查。
- [反馈问题](troubleshooting/report.md)：在社区或 GitHub 反馈问题，以及让智能体帮你起草。
