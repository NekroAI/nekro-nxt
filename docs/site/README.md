# NekroNXT 使用文档

这里是使用文档的原文，发布在 [https://nxt.nekro.ai/docs](https://nxt.nekro.ai/docs)。栏目、页面头部和发布方式见[文档包格式](BUNDLE.md)。

<!-- 本文件由 node scripts/docs-bundle.mjs readme 生成，不要手改。 -->

## 开始使用

- [快速开始](start/quickstart.md)：从安装到在内置频道里和智能体说上第一句话，再把它接进群聊。
- [基本概念](start/concepts.md)：智能体、频道、平台账号、接线、扩展各是什么，彼此怎么连在一起。
- [把她拉进第一个群](start/first-group.md)：以 QQ 官方机器人为例，从添加平台账号到智能体在群里回复。

## 安装与部署

- [桌面版安装](install/desktop.md)：在 macOS、Windows、Linux 上安装桌面版，选择稳定版或预览版。
- [Docker 部署](install/docker.md)：用 Docker 在服务器上长期运行 NekroNXT，以及数据目录、升级和重启。
- [通过公网和 HTTPS 访问](install/https.md)：让其他设备或公网通过 HTTPS 访问实例：反向代理与信任代理设置。
- [不用 Docker 部署服务端（非官方）](install/node.md)：不用 Docker、直接用 Node.js 运行服务端的社区做法，不在官方支持范围内。
- [在手机上使用](install/mobile.md)：在安卓应用或手机主屏幕上使用 NekroNXT，并接收后台通知。

## 模型

- [配置模型](models/providers.md)：接入模型供应商：填写 API 密钥、管理模型列表、测试连接。
- [选模型与控制花费](models/choosing.md)：给智能体选主模型、思考强度、备用模型、压缩和子对话用的模型，控制速度和花费。

## 智能体

- [创建智能体](agents/create.md)：新建智能体：起名、选模型、写设定，创建后在资料页里管理。
- [设定与频道说明](agents/persona.md)：写智能体的设定和别名；用频道说明给某个群单独定规矩，和她自己记的笔记有什么区别。
- [能力与授权](agents/abilities.md)：智能体能读写文件、运行命令到什么程度，以及子对话、网页搜索、查阅社区文档、语音转文字等开关。
- [记忆与笔记](agents/memory.md)：智能体怎么记住群里的事和每个人：群笔记、成员笔记、翻聊天记录，以及怎么查看、修改、锁定和让她忘掉。
- [上下文与压缩](agents/context.md)：智能体眼下记得多少对话、看到了什么，怎么手动压缩、清空上下文，以及彻底删除聊天记录。
- [子对话](agents/sub-conversations.md)：子对话是什么、什么时候用、给子对话选模型，以及保留多久。
- [定时任务](agents/scheduled-tasks.md)：在聊天里请智能体设提醒和周期任务，在资料页查看、暂停、立即执行或删除。

## 频道与平台

- [连接频道](channels/wiring.md)：添加平台账号、发现频道，把频道连到智能体。
- [触发与回复节奏](channels/response.md)：智能体在群里什么时候开口：触发方式、智能响应、等对方说完、合并连发、处理中反馈、暂停回应和连发间隔。
- [管理员与聊天命令](channels/admins-commands.md)：谁是管理员、怎么用认领码把自己的平台账号设为管理员，以及群里能用的聊天命令和权限。
- [接入 QQ 官方机器人](channels/qq-official.md)：用 QQ 开放平台的官方机器人接入 QQ 群和私聊。
- [接入 OneBot V11](channels/onebot-11.md)：通过 OneBot V11 协议端接入 QQ。
- [接入企业微信智能机器人](channels/wecom.md)：接入企业微信智能机器人。
- [接入微信 iLink](channels/wechat-ilink.md)：通过微信 iLink 接入微信。

## 扩展

- [扩展是什么](extensions/overview.md)：扩展能给智能体和 NekroNXT 增加什么，装到本机和为智能体启用的区别，配置、数据和安全。
- [从社区安装](extensions/install.md)：在「社区」里找扩展、看权限和审查结论、安装并为智能体启用，以及更新。
- [让她自己做扩展](extensions/dynamic-creation.md)：打开动态创造，在聊天里让智能体做新工具和页面；扩展自主权三档、试运行、保存和启用。
- [版本、分支与发布](extensions/versions.md)：扩展的版本谱系、切换和回退、创建分支、导入导出，以及发布到社区和审查报告。
- [接入 MCP 服务](extensions/mcp.md)：把现成的 MCP 服务接进来，给智能体当工具用：远程服务或本机程序、请求头和凭据、测试、启用到智能体。
- [DSH 插件](extensions/dsh-plugins.md)：安装和启用 DSH 插件，给本机或某个智能体打开入口，以及“缺少服务”“等待服务”是什么意思。
- [附加功能](extensions/addons.md)：按需安装的程序和模型：语音识别、媒体处理、语义检索、后台浏览器，以及智能体命令用到的 Node、gh 和 Git。

## 运维

- [升级、备份与恢复](ops/upgrade-backup.md)：升级时自动生成的恢复点，以及出问题时怎么恢复。
- [登录与访问](ops/access.md)：实例的登录方式、设备管理和通行密钥。
- [凭据与关联账号](ops/credentials.md)：统一保存 API 密钥和 token，决定哪些智能体、扩展和命令能用；关联 GitHub 账号给智能体的命令用。
- [通知](ops/notifications.md)：智能体等你确认、凭据申请、扩展提醒时怎么通知到你：系统通知、浏览器推送、Bark、企业微信和 ntfy。
- [存储与清理](ops/storage.md)：数据存在哪、升级前备份放哪、扩展能下载多大的文件，以及怎么清理聊天记录和日志。
- [查看运行日志](ops/logs.md)：查看、筛选和导出系统与插件日志。

## 排障

- [安装与启动](troubleshooting/install.md)：打不开、一直在启动、连不上服务器、升级后起不来、Docker 容器反复重启时怎么办。
- [模型与回复](troubleshooting/models.md)：智能体不回复、回复很慢、模型报错、测试连接失败、额度用完时怎么排查。
- [平台接入](troubleshooting/platforms.md)：群没出现在接线里、收不到消息、发不出去、一直正在连接、图片语音收发异常时怎么排查。
- [扩展](troubleshooting/extensions.md)：扩展保存了没生效、试运行失败、保存按钮不能点、等待确认、版本冲突时怎么处理。
- [反馈问题](troubleshooting/report.md)：在社区或 GitHub 反馈问题，以及让智能体帮你起草。

## 扩展开发

- [写第一个扩展](develop/getting-started.md)：用 TypeScript 写一个给智能体用的工具扩展：目录结构、清单、源码、打包、导入和调试。
- [SDK 参考](develop/sdk.md)：扩展能用的宿主能力、每项需要声明的权限、配置和凭据、钩子、定时任务、聊天命令和数据迁移。
- [发布到社区](develop/publish.md)：把扩展发布到 NekroNXT 社区：发布方式、版本规则、自动审查的六项评分和权限判断、额度，以及发布前自查。
- [在 AI 工具里查文档](develop/docs-mcp.md)：把社区站的公开 MCP 服务加到 Claude、Cursor 等 AI 工具里，查 NekroNXT 的使用文档和社区扩展；也可以直接调用文档接口。
