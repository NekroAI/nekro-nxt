# NekroNxt 项目共识

> 用途：创始人、产品、设计和开发团队快速确认“我们正在做什么”。  
> 产品名：NekroNxt；根包名：`nekro-nxt`  
> 完整依据：`NekroNxt完整设计方案.md`  
> 产品界面：`NekroNxt产品形态与用户旅程.md`  
> 当前首要里程碑：Local Creator Alpha

> 术语约束：产品面对用户只使用“智能体”。英文 Agent 仅允许出现在 DSH 上游专有名词或内部代码类型中。

## 0. 一句话共识

我们要做一个以 DSH 为智能体内核、以智能体为产品中心、支持网页和多平台群聊，并能让用户授权的智能体在界面中动态创造、运行、修改和保存本地扩展的全新聊天系统。

它不是 Nekro Agent 的升级兼容版，不迁移旧数据，不兼容旧插件；Nekro Agent 只作为经验参考。

## 1. 我们到底要做什么？

### 产品核心

用户显式创建一个智能体，并为它配置：

- 人设；
- 模型；
- DSH Preset；
- 能力权限；
- 本地扩展；
- 一个或多个消息频道。

频道可以来自网页、QQ、Discord、Telegram 等不同 Adapter。网页聊天本身也是一个 Channel。

智能体对任何 Channel 的用户可见发言都通过统一通信工具发送。模型原始文字或供应商实际提供的 reasoning 只作为后台运行轨迹，不自动进入真实对话；文字、Mention、图片和文件使用同一结构化消息协议。

用户可以决定某个智能体是否具备动态创造、Bash、文件访问等能力。获得授权的智能体可以检查系统接口、创建 Tool 和 UI、立即运行调试，并保存为重启后仍可使用的本地 TypeScript 插件。

### 产品形态

- Windows/macOS Electron Desktop：安装即用；
- Linux 单容器 Server：少配置、一个主要 `/data` 挂载、长期在线；
- 两者共用同一个 Runtime 和插件体系。

### 第一阶段真正要证明的事

```text
用户在 UI 创建智能体
→ 与它对话
→ 授予创造能力
→智能体动态创建真实可运行的扩展
→ 用户看到结果并继续修改
→ 保存为本地扩展
→ 重启后仍然可用
→ 只分配给用户指定的智能体
```

## 2. 应该怎么做？

### 技术路线

1. 直接复用 DSH/Cordis 的智能体运行时、Session、Agent Loop、Tool、Preset、Bundle/Profile、Scope、Skill、动态插件和 Client Slot；
2. NekroNxt 以 DSH Bundle 和普通 Cordis Plugin 组成产品，不完整 Fork DSH；
3. 用纯 TypeScript Monorepo 实现智能体、Channel、Adapter、本地扩展、Desktop 和 Server；
4. 把 DSH Preset 作为 `AgentRevision` 的运行时组装，不把 Preset 当成整个智能体；
5. Web 与外部聊天平台进入同一 Channel Runtime；
6. Tool、Adapter、Skill、MCP、模型和 UI 使用同一个 Extension/Contribution 体系；
7. 为同一智能体按授权组合 DSH 动态创造工具与 NekroNxt Inspect、本地保存、构建和智能体启用能力；创造只是该智能体当前启用这些能力后的状态，不创建另一个智能体；
8. 首版先完成本地扩展闭环，再加入外部 Adapter、Desktop/Server 完整交付，最后才考虑社区。

### 最小领域模型

```text
Space
├─ `AgentDefinition`
│  ├─ `AgentRevision`
│  ├─ Persona / Model / Preset / Capabilities
│  └─ Extension Activations
├─ Connection
│  └─ Channel
│     └─ Binding →智能体
└─ Local Extension
   ├─ Contributions
   ├─ Revisions
   └─ Activations →智能体
```

普通用户默认只有一个隐藏的 Space。

### 创造流程

```text
创建 → 运行 → 验证 → 保存
```

- 创建：复用 DSH Inspect/Define；
- 运行：复用 run/update/stop/undefine 和 Host/Client 双半；
- 验证：能加载、能调用、能渲染、能卸载、目标场景能运行；
- 保存：物化为不可变的本地 TypeScript Extension 源码 Revision；构建验证与为目标智能体启用是后续独立动作。

## 3. 我们的需求边界是什么？

### Local Creator Alpha

必须完成：

- DSH + NekroNxt Bundle 启动；
-智能体创建、编辑和 Revision；
- 人设、模型、Preset、能力管理；
- Web Channel；
- 本地 Extension/Contribution/Revision/Activation；
- 动态 Tool 和动态 Client UI；
- NekroNxt Inspect Provider；
- 本地 TypeScript 插件保存、重载、停止和恢复；
-智能体-centric 管理页面；
- 整个普通流程不要求 CLI。

### Product MVP

在 Alpha 后补齐：

- 一个外部 Adapter；
- 一个智能体同一时间只绑定一个 Channel；换绑保留旧 Binding 作为历史事实；
- 群消息安全 Step 注入；
- 基础触发策略和可靠收发；
- Electron 安装包；
- Linux 单容器；
- 基础更新、备份、日志和恢复模式。

### 未来阶段

- 更多 Adapter；
- 多智能体协作；
- Extension Process / Remote Runtime；
- 社区市场、发布和云构建；
- 多设备同步；
- 更强隔离和第三方插件治理。

## 4. 哪些质量约束一定要达成？

### 用户体验

- 新用户通过短向导即可创建智能体并开始 Web 对话；
- Desktop 不要求安装 Node、Python、pnpm 或 Docker；
- Server 不要求多个容器和外部数据库；
- 普通用户创建插件不需要终端。

### 消息与群聊

- 普通新消息不取消当前模型生成和 Tool；
- 新消息在下一个安全 Step 尽快交给智能体；
- 所有用户可见消息都由通信工具产生，Web Channel 不设自动发送模型最终文字的特殊路径；
- 原始模型输出与已发送消息在运行详情中明确区分；
- 文本、Mention、图片、文件和混合内容由统一消息协议表达；
- 媒体使用内容寻址存储，相同内容只保存一个物理对象，每次频道来源和接收统计仍可追溯；
- 视频首期作为普通文件；图片按模型能力原生读取或复用版本化摘要/OCR，不支持时明确失败；
- 消息可追溯到 Channel、用户、Binding 和智能体；
- 重复事件不造成重复执行；
- 断线和发送失败可见、可恢复。

### 插件生命周期

- 动态插件可以创建、运行、更新、停止和删除；
- 本地扩展可以加载、卸载和重启恢复；
- 停止后 Tool、Slot、Listener 和 Timer 必须清理；
- 插件不得无意作用到未选择的智能体；
- 坏插件不能阻止系统进入恢复模式。

### 数据与更新

- 关键消息和配置先持久化再确认；
- 数据格式版本化；
- 更新前备份，迁移失败不带病启动；
- Desktop 和 Server 使用同一领域实现；
- 不让用户靠手改容器文件完成升级。

### 模型与工程

- Prompt 精简且稳定，知识按需 Inspect；
- 不因群消息反复取消浪费 Token；
- DSH 精确锁版本并有升级兼容测试；
- CI 至少包含 format、typecheck、lint、相关测试和 build；
- 核心智能体/Web Channel/Plugin 生命周期有端到端验证。

### 必要安全

- Bash、创造和完整文件访问由用户给智能体显式开启；
- 插件目标范围始终可见；
- Secret 默认不进入 Prompt、日志和源码；
- 管理服务默认只监听本机；
- Core 数据库不作为普通插件 API；
- 用户始终可以停止插件并恢复启动。

## 5. 哪些需要预留将来扩展？

只预留稳定接缝，不提前实现未来系统：

1. 一个 Extension 可以声明多种 Contribution；
2. Revision 与 Activation 分开；
3. Activation 明确指向智能体；
4. Adapter Definition、Connection、Channel 分开；
5. RuntimeKind 未来可以增加 Process 和 Remote；
6.智能体使用不可变 Revision；
7. DSH 通过 Bundle 和兼容层接入；
8. Client UI 通过 Slot 扩展；
9. 本地扩展清单未来可增加签名、发布者和社区字段；
10. Desktop 与 Server 始终共用 Runtime。

预留的含义是“未来可以加”，不是今天创建空服务、空表和复杂状态机。

各方向的用户价值、稳定接缝、禁止锁死方案和启动条件统一记录在 `02-未来扩展方向.md`。开发新功能时必须核对，但不把未来规划误当作当前版本需求。

## 6. 哪些我们明确不会做？

### 不做历史兼容

- 不迁移 Nekro Agent 数据；
- 不兼容 Nekro Agent 插件；
- 不导入旧数据库、旧工作区和旧 Docker 部署；
- 不保留旧领域概念。

### 不在首版做

- 社区市场；
- 公开插件发布；
- 云端构建和签名；
- Publisher 信任等级、SBOM 和复杂证据体系；
- 第三方插件强隔离执行器；
- 所有聊天平台同时支持；
- 多节点自动故障转移；
- 企业多租户、计费和复杂 RBAC；
- 智能体自动修改和发布 NekroNxt Core；
- 每个动态 Package 的重复人工审批。

### 永远避免

- 完整 Fork DSH；
- 插件直接依赖核心数据库；
- 本地智能体运行强依赖 NekroNxt 云端；
- 把所有 Adapter 编进 Core；
- 把 Cordis Realm 或 `node:vm` 宣称为强安全沙箱；
- 为未来可能出现的问题提前堆积大量框架和门禁。

## 7. 我们要做的功能从哪里参考？

### DSH

参考：

-智能体Runtime 和 Loop；
- Session Event Log；
- DSH Preset 和 Scope；
- Bundle/Profile；
- Tool、Skill、MCP；
- Code/PTC；
- 动态 Plugin/Package/Run；
- Inspect Provider；
- Client Cordis 和 Slot；
-智能体自创造与调试。

定位：核心技术基础，优先直接复用和扩展。

具体任务必须核对 DSH 当前公开包、公开源码和测试，不能只依赖立项时的认识。消息 ID、Content Block、`inject()`、Cordis 动态创造和知识路由尤其值得复用。

### Nekro Agent

参考：

- 群聊产品体验；
- 多 Adapter 的平台差异；
- 人设、娱乐性和社区需求；
- 用户对部署与升级门槛的真实反馈；
- 插件直连主进程、复杂 Docker、重 Prompt 等失败教训。

定位：经验和行为参考，不迁移、不兼容、不机械复制。

### Nekro Edge Template

参考：

- 未来社区 API 的 Hono/OpenAPI/Zod；
- 边缘资源分发和轻量服务形态。

定位：未来社区阶段参考，不进入首版主路径。

参考只用于验证公开机制；所有最终决定都必须按 NekroNxt 当前领域重新论证，不复制旧接口或依赖未公开背景。

## 8. 整个项目必须遵循的铁律

1.智能体是中心，Channel 是入口，Preset 是组装。
2. DSH 是内核；扩展它，不完整 Fork 它。
3. Web 和外部平台走同一 Channel Runtime。
4. 用户可见消息只由通信工具发送，模型原始输出只在后台观察。
5. 普通新消息不打断当前工作，只在安全 Step 注入。
6. 一个插件体系，多种 Contribution；Adapter 不是第二套系统。
7. 保存插件与激活给智能体分开，影响范围必须清楚。
8. 创造能力由用户授权，不用过度安全设计扼杀核心能力。
9. 先打通本地创造闭环，再做社区和重型治理。
10. 不迁移、不兼容 Nekro Agent，只吸收经验。
11. 单仓、纯 TS、中文知识、一个 Runtime、两个 Host。
12. 先参考已验证机制，再重设计；不盲目重造，也不机械复制。
13. 规则只解决真实问题，质量约束必须能自动验证。
14. 只预留稳定接缝，不提前实现未来系统。

## 9. 最终确认

如果团队对本项目只有一分钟理解时间，应记住：

> 我们正在用 DSH 做一个全新的智能体优先群聊系统。用户先创建智能体，再给它绑定人设、模型、能力和一个当前频道。获得授权的智能体可以直接在界面中创造、运行、修改并保存自己的本地扩展。首版先把这条本地创造闭环和 Web 对话做透，再做外部群聊、Desktop/Server 完整交付，最后才考虑社区生态。
