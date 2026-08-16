# NekroNxt 完整设计方案

> 产品名：NekroNxt  
> 根包名：`nekro-nxt`  
> 文档性质：当前有效的产品与技术共识  
> 状态：立项基线，后续以实现反馈持续修订  
> 日期：2026-08-15  
> 语言：项目知识默认使用中文，代码标识符和外部协议名保留英文  

> 术语约束：面向用户只使用“智能体”。本文中的 `AgentDefinition`、`AgentRevision` 等仅为内部代码对象；DSH Agent Loop 等为上游开发概念，不得直接成为产品文案。

## 0. 文档目的与权威范围

本文汇总当前产品要求、DSH 公开能力和已确认的专题设计。它记录当前已经达成的共识，而不是把所有曾经讨论过的可能性都变成首版需求。

本文是完整设计依据；同目录的《NekroNxt项目共识.md》用于快速认知对齐。如果两者冲突，以最新修改日期和明确决策为准，并同步修正另一份文档。

未来方向和消息协议分别由 `02-未来扩展方向.md`、`03-消息内容与投递协议.md` 维护，公开边界由 `00-文档公开边界.md` 维护。本文只保留整体关系，不重复维护专题契约。

历史项目和调查材料不直接约束实现。NekroNxt 只依赖明确采用的公开契约，不兼容旧系统。

## 1. 我们要做什么

### 1.1 一句话定义

NekroNxt 是一个以 DeepSeek Harness（DSH）为智能体引擎、以智能体为核心产品实体、支持网页与多聊天平台群聊、兼具娱乐性和生产力，并能在用户授权后动态创造和扩展自身能力的本地优先聊天机器人平台。

### 1.2 核心价值

产品要同时解决四件事：

1. 普通用户能够低门槛创建和使用自己的智能体；
2. 一个智能体可以加入多个网页、群聊和私聊频道，并持续感知实时场景变化；
3.智能体的人设、模型、频道和插件能力能够用符合用户心智的方式管理；
4. 获得授权的智能体可以检查系统能力、动态创建插件、立即运行调试，并保存为可复用的本地扩展。

### 1.3 目标用户

- Windows/macOS 普通用户：下载安装后快速创建智能体，通过网页频道立即对话；
- 群聊机器人用户：将智能体连接到外部聊天平台并长期运行；
- NAS/VPS/服务器用户：用单容器获得 7×24 小时在线机器人；
- 轻度创造者：主要通过图形界面和对话完成插件创建、测试与保存；
- 高级开发者：通过 TypeScript、DSH/Cordis 与 CLI 深入扩展系统。

### 1.4 产品形态

目标交付两个 Host，共用一个 Runtime：

- Electron Desktop：Windows/macOS 安装即用；
- Linux Server：单容器、一个主要 `/data` 挂载、少量配置。

Electron 和 Server 只是不同宿主，不拥有两套领域逻辑、插件体系或数据模型。

### 1.5 首个验证目标

首个里程碑不是社区市场，而是 `Local Creator Alpha`：

```text
创建智能体
→ 配置人设、模型、Preset 与能力
→ 创建 Web Channel
→ 与智能体对话
→ 授予创造能力
→智能体动态创建 Tool 或 UI
→ 立即运行、观察和修改
→ 停止或回滚
→ 保存为本地 TypeScript 插件
→ 重启后重新加载
→ 分配给指定智能体
```

这条链路成立，项目的核心差异才成立。

## 2. 立项原则

### 2.1 DSH 是内核，不是被包裹的黑盒

新项目直接建立在 DSH/Cordis 的公开能力上，使用它的智能体运行时、Session、Agent Loop、Tool Pipeline、Preset、Skill、Bundle/Profile、Scope、Client Slot 和动态 Cordis 能力。

NekroNxt 以 DSH Bundle 和普通 Cordis Plugin 组成产品，不在 DSH 外面重新实现一套平行智能体框架。

### 2.2 不完整 Fork DSH

- 精确锁定已经验证的 DSH 版本；
- 通过 NekroNxt Bundle、Plugin 和小型兼容层扩展；
- 通用缺口优先向 DSH 上游贡献；
- 不依赖 DSH 内部源码路径；
- 升级通过代表性组合与行为测试验证。

### 2.3智能体是产品中心

用户不是“接入一个平台后得到全局机器人”，而是显式创建智能体，再给智能体绑定人设、模型、能力和频道。没有绑定到智能体的频道不会自动触发任何机器人。

### 2.4 网页聊天也是 Channel

Web 对话不走特殊旁路。它由 Internal Web Adapter 提供，与 QQ、Discord、Telegram 等外部频道进入同一 Channel Runtime。

### 2.5 统一扩展体系

Tool、Adapter、Skill、MCP、Model Provider、Job 和 Client UI 不是不同插件物种，而是同一个 Extension 可以声明的不同 Contribution。

首版只做本地扩展管理，不做平行市场和社区供应链。

### 2.6 创造能力由用户分配

动态创造、Bash、文件访问等高能力不在系统层面一刀切禁止。用户在智能体管理中决定哪些智能体获得哪些能力。系统要把权限和影响范围说清楚，并提供停止与恢复能力。

### 2.7 先做闭环，再做治理

首版不提前建设社区签名、发布者认证、云端清洁构建、复杂证据等级和跨平台强沙箱。未来真实引入陌生第三方代码时，再补与风险相称的治理。

### 2.8 新项目不背历史兼容

不迁移 Nekro Agent 的数据、插件、人设、配置或数据库；不兼容旧插件 API；不保留旧概念。历史项目只提供产品经验、失败教训和行为参考。

## 3. 参考项目与取舍

| 项目 | 重点借鉴 | 明确不照搬 |
|---|---|---|
| DSH | 一切皆插件、Cordis 生命周期、DSH Preset、Scope、Bundle/Profile、Session Log、Agent Loop、Tool Pipeline、Skill/MCP、动态 Plugin/Package/Run、Inspect Provider、Client Slot、Code/PTC | 完整 Fork、把开发者文件结构直接暴露给普通用户、把 `node:vm` 描述成强安全沙箱、盲目复制全部包粒度 |
| Nekro Agent | 群聊与多 Adapter 产品经验、人设与娱乐性、用户对部署门槛高度敏感、社区扩展需求、历史架构缺陷 | 旧数据与插件兼容、复杂 Docker 编排、Python 主栈、主进程插件直连数据库、复杂挂载与宿主 Docker Socket、重提示词体系 |
| Nekro Edge Template | Hono/OpenAPI/Zod、轻量云端 API 和资源分发思路 | 首版社区后端、宽 CORS、明文凭据或其他不适合直接复用的实现细节 |

参考意味着理解原理后重新设计，不意味着复制旧代码或保留旧接口。

## 4. 用户心智与领域模型

### 4.1 普通用户首先看到的概念

普通路径优先展示：

-智能体；
- 频道；
- 人设；
- 模型；
- 能力；
- 本地扩展；
- 创造工作台。

Node、Space、Preset Revision、Cordis Realm、Bundle、MCP Transport 等概念只在需要时进入高级界面。

### 4.2 核心实体

#### Node

一个运行实例。Desktop 和 Server 都是 Node。

#### Space

资源与信息隔离边界，拥有智能体、Connection、Channel Binding、本地扩展授权和 Secret。普通用户默认只有一个 Space，产品可以隐藏该概念；多团队、多身份或远程管理时再显式展示。

#### `AgentDefinition`

用户管理的长期智能体实体，包含名称、人设、模型策略、基础 Preset、能力设置、记忆策略和扩展激活关系。

#### `AgentRevision`

`AgentDefinition` 的不可变配置版本。修改会产生新 Revision，便于已有 Session 保持可回放，避免在进行中的对话里直接替换工具集合。

####智能体Runtime / DSH智能体

某个 `AgentRevision` 在某个对话上下文中的运行实例。一个长期智能体可以拥有多个 Channel Session。

#### Persona

智能体的身份和行为设定。核心 Persona 属于智能体；频道只允许少量场景覆盖，例如称呼、语言、触发规则，不复制整套 Prompt。

#### DSH Preset

DSH 的智能体运行域 Cordis Composition，决定一个运行实例拥有的 Tool、Prompt、Skill、Compaction 和其他插件能力。它是运行时组装，不等于整个 NekroNxt 智能体产品实体。

#### Connection

某个平台的一个登录账号或连接实例，例如一个 Discord 机器人账号、QQ 机器人账号或 Telegram 机器人账号。

#### Channel

具体群聊、私聊或 Web 对话入口。

#### Channel Binding

将 Channel 绑定到智能体，并配置触发方式、回复策略和少量频道覆盖项。

#### Extension

本地安装或动态创建的一项扩展身份。

#### Contribution

Extension 提供的具体能力，例如 Tool、Adapter、Skill、MCP、Model Provider、Job、Settings 或 Client UI。

#### Revision

Extension 的一个不可变源码/构建版本。

#### Activation

将某个 Extension Revision 分配给指定智能体或运行范围。

### 4.3 关系图

```text
Node
└─ Space
   ├─ `AgentDefinition`
   │  ├─ `AgentRevision`
   │  │  └─ Compiled DSH Preset
   │  └─ Extension Activations
   ├─ Connection
   │  └─ Channel
   │     └─ Channel Binding → `AgentDefinition`
   └─ Local Extensions
      ├─ Contributions
      ├─ Revisions
      └─ Activations → `AgentDefinition`
```

### 4.4 必须冻结的关系

- 一个智能体可以绑定多个、来自不同 Adapter 的 Channel；
- MVP 中一个 Channel 只有一个 Primary智能体，避免抢答和互相触发；
- 每个 Channel 保留独立短期会话上下文；
-智能体可以共享经过明确设计的长期记忆，但默认不合并不同平台身份；
- 插件安装/保存和给智能体激活是两件事；
- 谁创建插件、插件当前运行在哪里、影响哪些智能体必须始终可见。

## 5. DSH 集成设计

### 5.1 运行时组合

```text
DSH Base Packages
→ NekroNxt Core Bundle
→ NekroNxt Channel Bundle
→ NekroNxt Client Bundle
→ Host-specific Bundle（Desktop / Server）
→ 本地扩展与普通 DSH 插件
```

NekroNxt 业务包只通过公开 Service、Event、Tool、Slot 与兼容层使用 DSH，不直接 import DSH 内部路径。

### 5.2 Preset 的直接复用

DSH Preset 使用 standing scope：同一 Preset 的插件组装只挂载一次，多个智能体Scope 通过父链读取其 Tool、Prompt 和 Skill，而会话状态仍按智能体/Session 分键。

NekroNxt 复用这一机制，但产品映射为：

```text
智能体Template
→ `AgentDefinition`
→ `AgentRevision`
→ Compiled DSH Preset
→ 一个或多个 Channel Session
```

首版官方 Preset 建议只有：

- 通用方式；
- 极简模式；
- PTC/Code 模式。

娱乐性和生产力主要由智能体Persona、已激活扩展和频道策略组合，不需要制造大量模式名称。动态创造不是另一个基础 Preset 或另一个智能体；它是同一智能体在当前配置版本中获得 DSH 动态工具、NekroNxt Inspect 和保存工具后表现出的创造状态。

### 5.3 Preset 与权限分离

DSH Preset 决定“它会什么”；智能体Capability 设置决定“用户允许它做什么”。Preset 不能自行突破 Space/智能体的能力设置。创造相关工具可以通过 Preset 组合层实现，但是否可见和可执行始终由同一智能体的能力授权决定，不能靠切换“模式”绕过授权。

DSH Permission Preset 的 sandbox/approval 机制可以复用，但 NekroNxt 不把全部权限塞回 Prompt，也不要求首版建立复杂 capability token 系统。

### 5.4 运行中智能体的配置更新

已有历史的 DSH Session 不直接切换 Preset。`AgentDefinition` 修改产生新 Revision：

- 新会话直接使用新 Revision；
- 正在执行的会话继续当前 Step；
- 兼容变化可以在安全间隙更新对应运行配置；只有明确不兼容的变化需要结束当前 Episode、创建新 Session、注入必要摘要并切换 Binding；
- 旧 Session 保持只读可回放。

### 5.5 DSH 插件兼容

普通 DSH/Cordis Plugin 保持可安装和运行，不强迫作者改写为 NekroNxt 专属格式。带可选 NekroNxt 元数据的插件可以获得更好的界面展示、智能体启用和 Contribution 分类。

DSH 插件是运行方式和开发接口，不是与 Adapter、Tool 并列的产品物种。一个 DSH 插件也可以贡献 Adapter、Tool 或 UI。

### 5.6 DSH 升级策略

- 精确锁定版本，不跟随 `latest`；
- 正式实现前验证一组完整精确的 DSH npm package set 并在 lockfile 中冻结，不依赖浮动 dist-tag 或本机相邻仓库；
- 保持一个很薄的 `dsh-compat` 包；
- 每次升级验证核心 Bundle、Preset、动态创造、Slot、Session resume/fork 和代表性社区插件；
- 只在真实遇到不兼容时增加适配，不提前建立庞大兼容框架。

## 6.智能体与 Channel Runtime

### 6.1 Web Channel

Internal Web Adapter 是系统组件，为每个智能体创建一个或多个 Web Channel。它进入与外部 Adapter 相同的事件、身份、调度、Session 和 Delivery 流程。

### 6.2 外部 Channel

```text
Adapter Extension
→ Adapter Contribution
→ Connection
→ Channel
→ Channel Binding
→智能体
```

平台实现不编进 NekroNxt Core；Core 只提供 Adapter Registry、Adapter Host、SDK、凭据接入和统一收发接口。

### 6.3 入站消息

Channel Event Log 与 DSH Session Log 分开：

- Channel Event Log 保存平台事实；
- Session Log 保存实际进入智能体的模型可见事实和执行结果；
- 消息先持久化，再准入智能体；
- 去重、顺序和平台 checkpoint 由 Adapter/Channel Runtime 负责。

### 6.4 群聊中的实时新消息

普通新增群消息默认不取消当前模型生成或正在执行的 Tool。它们作为参考信息进入智能体Inbox，在下一个安全 Step 通过 DSH `inject()` 或等价机制投递。

```text
当前模型/Tool 正在运行
→ 新群消息持续进入 Channel Log
→ 标记为待注入
→ 当前工作到达安全间隙
→ 聚合重要新消息
→智能体下一步获得最新场景
```

只有明确的控制事件，例如 Owner 停止、权限撤销、Node 关闭，才可以取消当前工作。

### 6.5 触发策略

Channel Binding 至少支持：

- 总是响应；
- 被提及时响应；
- 回复智能体时响应；
- 命令触发；
- 仅观察不主动响应。

### 6.6 出站消息

所有用户可见消息必须由智能体调用统一通信工具产生。DSH 模型原始 `text/reasoning` 内容块只进入 Session Log 与后台运行观察，不自动成为 Web 或外部平台消息。Web Channel 不设例外。

通信工具接受有序 `MessagePart[]`，首版统一表达文字、Mention、图片、文件、音频和引用。Mention 使用成员 ID，媒体使用受控 `assetId`，不暴露宿主路径。Adapter 显式声明媒体、回复、混合内容和大小限制；不支持混合内容的平台可将一个逻辑消息按顺序拆成多个物理消息。

媒体原件由内容寻址 Asset Service 统一拥有：相同字节只保存一个 blob，每次接收保留独立 Occurrence 并更新最后接收时间与次数。视频首期作为普通文件，不做专用理解。图片按模型能力原生投影或使用版本化摘要/OCR，多模态模型还可以通过授权工具主动重读历史图片。完整契约见 `decisions/accepted/2026-08-16-内容寻址资源与图片理解.md`。

```text
send_message Tool
→ 校验目标、能力与内容
→ 持久化 OutboundMessageIntent
→ Channel Runtime 规划 Delivery
→ Adapter 发送
→ 持久化回执与平台 message ID
→ Tool 返回 sent / partially-sent / failed
```

Adapter 只负责平台发送，不自行无限重试。Channel Runtime 统一记录逻辑发送意图、物理发送、幂等 ID、结果和平台消息 ID。失败、部分成功和未知结果必须可见，不能伪装成已发送。完整契约见 `03-消息内容与投递协议.md`，已实施决定见对应 Decision Note。

## 7. 统一插件与 Adapter 体系

### 7.1 一个 Extension，多种 Contribution

```text
Extension
├─ tool
├─ adapter
├─ skill
├─ mcp
├─ model-provider
├─ job
├─ settings
└─ client-ui
```

扩展中心、本地扩展列表和智能体管理只管理 Extension、Revision 和 Activation。不同子系统消费各自理解的 Contribution。

### 7.2 Adapter 不是第二套插件

NekroNxt Core 包含：

- Adapter Registry；
- Adapter Host；
- Adapter SDK；
- Connection/Channel 管理；
- 基础凭据接入；
- 收发接口和测试工具。

QQ、Discord、Telegram、微信等平台实现是独立 Extension。Internal Web Adapter 可以作为最小 System Contribution 内置。

### 7.3 首版运行方式

首版实现：

- DSH Dynamic Plugin；
- Cordis In-process Plugin；
- 本地 TypeScript Extension。

Extension Process 和 Remote Gateway 只作为未来可加的运行方式，不在首版实现完整代理、令牌和隔离体系。

### 7.4 本地扩展最小模型

```text
LocalExtension
├─ id
├─ name
├─ contributions
├─ revisions
└─ activations
```

首版清单只要求稳定 ID、名称、API 版本、Contribution、入口和基本配置 Schema。Publisher、签名、SBOM、社区审核等字段以后按需增加。

### 7.5 激活范围

动态或本地扩展默认只激活给明确选择的智能体。系统级激活属于高级能力，必须在界面上明确显示，但首版不要求每次运行重复审批。

实现上可以先为每个智能体Runtime 挂载对应插件实例，之后再优化为共享智能体Scope；产品契约先冻结“Activation 属于智能体”，不提前把优化方式暴露给用户。

### 7.6智能体自管理

智能体只能通过公开管理 Service 修改自己的人设、能力设置、扩展和频道策略，不能直接写核心数据库。是否允许修改、允许修改到什么程度，由智能体管理页配置。

## 8. 创造状态与本地扩展生产

### 8.1 定位

创造状态是同一个智能体在当前配置版本中启用一组高能力后的运行状态，不是另一个智能体，也不是独立产品实体。实现可以通过 DSH Preset 组合层和智能体作用域挂载相关工具，但界面、消息归属、Session 和审计主体始终是原智能体。

创造能力组合包括 DSH 动态 Cordis 工具，以及 NekroNxt Runtime 知识、智能体/Channel/Extension Inspect Provider、本地扩展保存和启用工具。动态创造、开发 Shell、完整文件访问仍是三项独立授权。

### 8.2智能体级能力设置

建议至少提供：

- 检查当前运行时；
- 创建动态插件；
- 修改自己创建的插件；
- 运行、更新、停止插件；
- 使用开发 Shell；
- 保存为本地扩展；
- 给其他智能体激活插件；
- 访问完整宿主文件系统。

用户开启后，系统可以按该授权直接运行，不必为每个动态 Package 重复建立复杂审批。

### 8.3 复用 DSH 动态能力

直接复用或薄封装：

- `cordis_inspect_list`；
- `cordis_inspect_query`；
- `cordis_inspect_self`；
- `cordis_define`；
- `cordis_run`；
- `cordis_stop`；
- `cordis_undefine`；
- PluginId / PackageId / PluginRunId；
- Host/Client 双半；
- current/next revision；
- Client Slot 和运行诊断。

### 8.4 NekroNxt 增加的 Inspect 与工具

首版重点增加：

- `AgentDefinition` 和当前 Revision；
- 已激活扩展；
- Adapter/Channel 接口；
- NekroNxt Slot；
- Contribution Schema；
- 本地扩展目录和构建状态；
- Fake Channel 场景；
- 保存、构建和激活本地扩展。

这些知识通过查询工具按需提供，不塞入超长系统 Prompt。

### 8.5 四阶段本地闭环

```text
创建 → 运行 → 验证 → 保存
```

#### 创建

用户用自然语言描述目标，智能体检查当前接口并定义动态 Package。

#### 运行

在用户给该智能体的能力范围内运行、更新、停止和观察。默认作用目标是当前智能体。

#### 验证

首版只要求：语法/类型可处理、插件能加载、核心功能可调用、UI 能渲染、更新和卸载能完成、至少一个目标场景可重放。

#### 保存

把动态源码物化为不可变的本地 TypeScript Extension Revision。构建产物是按需生成、可删除重建的缓存；用户完成验证后再单独决定是否为智能体创建 Activation。重启后可以从源码 Revision 重建。

### 8.6 UI 优先

绝大多数用户通过页面完成：

- 描述需求；
- 查看智能体正在创建什么；
- 观察 Tool/UI 运行结果；
- 查看错误和修复过程；
- 保存、停止、回滚；
- 选择目标智能体；
- 查看源码和构建日志。

CLI 只服务少量高级开发者，不成为普通用户必经路径。

### 8.7 创造工作台页面

工作台建议包含：

- 中央对话区；
- 插件/Revision 列表；
- 当前运行状态；
- Tool 调用与日志；
- Client Slot 预览；
- 目标智能体；
- 保存、停止、继续修改和回滚动作。

它可以大量复用 DSH 当前 Cordis 动态插件卡片和 Slot 机制，但信息架构使用 NekroNxt 的智能体/Extension 心智。

### 8.8 Client Slot

沿用 DSH 的 Slot 思路，逐步提供稳定 NekroNxt Slot，例如：

- `agent.overview.cards`；
- `agent.header.actions`；
- `conversation.composer.actions`；
- `conversation.message.attachments`；
- `conversation.sidebar.panels`；
- `channel.inspector.panels`；
- `forge.preview`。

首版不需要建设复杂 UI 沙箱；应优先提供小而稳定的 Slot，避免插件只能替换整个页面。

## 9. 产品界面

产品概念图和真实用户旅程见 `NekroNxt产品形态与用户旅程.md`。

### 9.1 从 Workspace-centric 转向智能体-centric

DSH 当前界面以 Workspace、Session 和 Preset 为中心。NekroNxt 普通产品界面应以智能体为中心：

```text
首页

智能体
  小奈
    Web 控制台
    QQ 用户群
    Discord #general
  开发助手
    Web 开发对话

频道与连接
本地扩展
创造工作台
运行与诊断
设置
```

### 9.2 创建智能体

最短流程：

```text
名称与人设
→ 模型
→ 基础 Preset
→ 自动创建 Web Channel
→ 可选能力
→ 完成
```

外部 Adapter、复杂记忆和高级权限都可以后补，不阻塞第一次对话。

### 9.3智能体详情

建议分区：

- 对话；
- 频道；
- 人设；
- 模型；
- 能力；
- 记忆；
- 扩展；
- 创造；
- 运行记录；
- 高级设置。

### 9.4 Preset 选择

Preset 可以在创建智能体和新建空白会话时选择。运行中的有历史 Session 不直接更换 Preset。模式选择只能在智能体已授权能力内工作，不能靠一个下拉框突破智能体设置。

## 10. 部署与更新

### 10.1 一个 Runtime，两个 Host

Desktop 和 Server 共用：

-智能体/Channel/Extension 领域包；
- DSH 集成；
- SQLite 与 Session Provider；
- Adapter SDK；
- Client Web UI；
- 本地扩展构建和加载。

### 10.2 Desktop

- Electron 主进程启动 Runtime；
- Renderer 连接本地管理 API；
- 首次启动向导完成模型和第一个智能体；
- 默认只监听本机；
- 更新以完整应用包为主，不在用户机器上执行 Git 操作。

### 10.3 Server

- Linux 单容器；
- 一个主要 `/data` 挂载；
- 默认 SQLite；
- 不要求 PostgreSQL、Redis、Qdrant、Docker Socket 或 `--privileged`；
- Web 管理界面和 Runtime 同容器；
- 用户通过拉取新镜像升级。

### 10.4 更新原则

更新是核心体验，但首版只做必要能力：

- 明确显示当前版本和可用版本；
- 更新前停止 Runtime 并备份关键本地数据；
- 数据 Schema 使用单向版本迁移；
- 失败时可以回到上一应用版本和备份；
- 本地扩展版本与 Framework 版本分开；
- 不首版实现云端灰度、自动签名晋升和复杂跨组件协调。

## 11. 数据与文件布局

建议一个 `/data`：

```text
/data/
├─ db/
│  ├─ core.sqlite
│  └─ sessions.sqlite
├─ extensions/
├─ workspaces/
├─ attachments/
├─ logs/
├─ cache/
└─ backups/
```

- `core.sqlite` 由 NekroNxt 领域层拥有；
- DSH Session 数据由选定的 DSH Session Provider 拥有；
- 不跨两个数据库伪造原子事务，使用明确的恢复和幂等逻辑；
- 插件不能依赖直接读写核心数据库作为公开 API；
- 首版不引入多数据库方言和外部向量数据库。

核心表只围绕 Node、Space、智能体、AgentRevision、Connection、Channel、Binding、LocalExtension、ExtensionRevision、Activation、设置与运行状态建立。

## 12. 最小安全与恢复边界

首版只冻结以下必要措施：

1. Bash、动态创造、完整文件访问由用户在智能体管理中显式开启；
2. 动态插件的目标智能体和影响范围必须可见，默认只作用于当前智能体；
3. 用户可以停止、禁用和删除本地扩展；启动失败时可以进入不加载本地扩展的恢复模式；
4. Secret 默认通过引用和专用接口使用，不主动写入 Prompt、普通日志和插件源码；
5. 管理服务默认只绑定本机，开放远程时明确配置；
6. Core 数据库不作为普通插件 API 暴露；
7. 更新前有备份，数据迁移失败不继续启动新版本。

明确不在首版建设：

- 复杂 capability token；
- 第三方 Process 沙箱一致性认证；
- Publisher/Artifact 签名体系；
- SBOM 和云端清洁构建；
- 大规模恶意插件测试矩阵；
- 每个动态 Package 强制人工审批；
- 把 DSH `node:vm` 宣称为安全隔离。

## 13. Monorepo 与开发知识

### 13.1 技术栈

- 单仓库；
- TypeScript 为主要和默认语言；
- pnpm workspace；
- Electron + Web Client；
- Node Runtime；
- SQLite；
- Zod/OpenAPI 等契约工具按实际需要使用；
- 不引入第二主力后端语言。

### 13.2 建议目录

```text
apps/
  desktop/
  runtime/
  server/

packages/
  contracts/
  dsh-compat/
  bundle-core/
  bundle-desktop/
  bundle-server/
  plugin-agent-definition/
  plugin-channel-runtime/
  plugin-adapter-registry/
  plugin-extension-manager/
  plugin-local-creator/
  adapter-sdk/
  extension-sdk/
  storage-sqlite/
  client-*/
  ui-kit/
  test-harness/

docs/
  产品概览.md
  架构总览.md
  开发指南.md
  测试指南.md
  术语表.md
  decisions/
  guides/
```

首版不要为了理论纯度拆成数百个包；一个包代表真实的替换、测试或所有权边界。

### 13.3 中文知识沉淀

- `AGENTS.md` 是所有 AI 开发工具的统一入口；
- `CLAUDE.md` 可以指向 `AGENTS.md`；
- 根 AGENTS 只做项目说明、必读路由、必要禁令和验证入口；
- 规则按任务类型或包边界下沉，不把所有事实塞进根文件；
- Package README 使用中文说明职责、依赖方向、运行方式和已知限制；
- 架构决定使用中文 Decision Note；
- 能从 TypeScript 生成的 Tool、Slot、RPC 和配置目录不重复手写；
- 本地敏感资料放 Git 忽略目录，不进入公开文档。

当前事实、未来方向、Decision Note、package 说明、操作指南和历史研究必须分层保存；一个事实只在一个位置完整描述，其他文档用链接引用。具体路由见 `README.md`、`00-文档公开边界.md` 和 `06-开发与测试规范.md`。

### 13.4 Decision Note

只在跨包契约、领域模型、持久格式、DSH 集成和重要架构选择变化时记录：

```markdown
# 决策：标题

## 背景
## 决定
## 考虑过的方案
## 影响
```

使用 `proposed/accepted/implemented/rejected` 状态目录即可。首版不强制每个非平凡修改都写 Note，不做中英文双份、sidecar 哈希和复杂文档门禁。

### 13.5 AI 开发闭环

每个任务遵循：

```text
读取根 AGENTS、任务路由和相关包文档
→ 搜索当前实现、测试和既有决策
→ 核对相关公开上游契约和当前项目约束
→ 核对未来方向、稳定接缝和本次非目标
→ 修改最小范围
→ 执行相关测试
→ 更新唯一事实源和必要 Decision Note
→ 汇报验证、参考取舍与剩余风险
```

新功能、公共契约、持久格式、DSH、Extension、Adapter、消息、Runtime、部署与社区任务必须按条件查阅未来规划；局部修复无需机械通读。外部机制只以公开契约和可复现测试为依据，本地私有资料不得成为公开构建或设计的前置条件。

## 14. 必须达到的质量约束

### 14.1 产品可用性

- 新用户可以在短流程内创建智能体并开始 Web 对话；
- Desktop 不要求用户安装 Node、pnpm、Python 或 Docker；
- Server 不要求复杂 Compose 和多个外部服务；
- 普通插件创建流程不要求终端命令。

### 14.2 领域正确性

- 所有消息都能追溯到 Channel、发送者、Binding 和智能体；
- 一个插件的 Activation 不得无意扩散到其他智能体；
- Web Channel 与外部 Channel 使用同一运行语义；
- Persona、Preset、权限、插件和频道不混成一个不可解释配置对象。

### 14.3 群聊正确性

- 普通新消息不取消当前模型生成和 Tool；
- 新消息在下一个安全 Step 尽快送达智能体；
- 用户可见发言只由通信工具产生，原始模型输出不会自动进入频道；
- 文本、Mention、图片和文件共用同一出站、回执和幂等链路；
- 重复消息不会造成重复业务执行；
- Adapter 断线重连不静默丢失已确认消息；
- 发送失败可见且可重试。

### 14.4 插件生命周期

- 动态插件可以 define/run/update/stop/undefine；
- 本地扩展可以加载、卸载和重启恢复；
- 插件停止后 listener、timer、Tool 和 Slot 必须清理；
- 坏插件不能永久阻止系统以恢复模式启动；
- Revision 和 Activation 状态可解释。

### 14.5 数据与更新

- 消息和关键配置先持久化再对外确认；
- 迁移是版本化且可测试的；
- 更新前有备份；
- 应用和数据目录关系清晰；
- 不依赖用户手工修改容器内文件完成升级。

### 14.6 DSH 兼容

- 锁定版本下核心 Bundle 和 Preset 可重复启动；
- DSH 升级有自动化兼容测试；
- 不把 NekroNxt 业务建立在 DSH 私有源码结构上；
- 普通 DSH 插件至少能在高级模式安装和运行。

### 14.7 模型效率

- 系统 Prompt 保持精简稳定；
- 运行知识通过 Inspect/Skill 按需读取；
- Tool Schema 顺序和稳定前缀不无故漂移；
- 群消息不会通过反复取消造成明显 Token 浪费；
- 记录基础 Token、缓存和延迟指标用于真实优化，不在首版设想大量硬阈值。

### 14.8 工程质量

首版 CI 至少执行：

- format；
- typecheck；
- lint；
- 受影响测试；
- build；
- 核心 Plugin load/unload smoke；
-智能体+ Web Channel 主路径测试。

不追求 100% 覆盖率和与当前风险不相称的全量门禁。

## 15. 需求边界

### 15.1 Local Creator Alpha 必须有

- DSH Runtime 与 NekroNxt Bundle 启动；
-智能体创建、编辑和 Revision；
- Persona、Model、Preset、能力管理；
- Internal Web Adapter 与 Web Channel；
- 本地 Extension/Contribution/Revision/Activation；
- DSH 动态 Cordis 创造能力；
- NekroNxt Inspect Provider；
- Tool 和 Client Slot 动态运行；
- 保存为本地 TypeScript 插件；
- 本地扩展重新加载、停止和恢复；
-智能体-centric 基础 UI。

### 15.2 产品 MVP 必须补齐

- 一个外部聊天平台 Adapter；
- 一个智能体绑定多个 Channel；
- 群消息安全 Step 注入；
- 基础触发策略；
- Desktop 安装包；
- Server 单容器；
- 基础应用更新和数据备份；
- 日志、诊断和恢复模式。

### 15.3 可以后续迭代

- 更多 Adapter；
- 更丰富记忆 Provider；
- MCP/Model Provider 管理体验；
- 多智能体同频道协作；
- Extension Process / Remote Runtime；
- 更强 UI 插件隔离；
- 多设备管理；
- 自动化长期 Job；
- 更完整场景测试和插件质量报告。

### 15.4 未来社区阶段

- 扩展目录和搜索；
- 发布者身份；
- 云端源码构建；
- 签名、摘要和撤销；
- 插件审核与举报；
- 自动更新策略；
- 资源分发 CDN；
- 社区账号和同步。

未来能力必须围绕现有 Extension/Revision/Activation 增量生长，不能要求首版本地扩展重写。

## 16. 明确不会做

### 16.1 永久非目标或独立立项

- Nekro Agent 数据迁移；
- Nekro Agent 插件兼容层；
- 旧数据库、旧工作区和旧 Docker 部署导入；
- 为兼容历史概念牺牲新领域模型；
- 默认依赖云端才能运行本地智能体；
- 让插件直接依赖核心数据库作为公开扩展接口；
- 在首版建立企业多租户、计费、复杂 RBAC；
- 自动分布式故障转移和多节点一致性；
- 把所有平台 Adapter 编入 Core；
- 完整 Fork DSH 并长期自行维护；
- 宣称 Cordis Realm 或 `node:vm` 是强安全沙箱。

### 16.2 首版明确不做

- 社区市场与公开发布；
- 云端插件构建和签名；
- Publisher 信任等级；
- SBOM 和复杂证据等级；
- 第三方插件强隔离执行器；
- 所有聊天平台同时支持；
- 全自动智能体自我更新 Framework；
- 无人值守公共插件发布；
- 复杂设备迁移、同步和云托管 Runtime。

## 17. 未来扩展预留

详细方向、禁止锁死方案和启动条件见 `02-未来扩展方向.md`。本节只列当前架构必须冻结的最小接缝。

预留不等于提前实现。首版只冻结以下稳定接缝：

1. Extension 可以声明多种 Contribution；
2. Revision 与 Activation 分离；
3. Activation 有明确目标智能体；
4. Adapter 实现与 Connection/Channel 实例分离；
5. RuntimeKind 将来可以增加 Process 和 Remote；
6. `AgentDefinition` 使用 Revision，支持未来同步和发布；
7. DSH 通过兼容层和 Bundle 集成；
8. Client UI 通过 Slot 扩展；
9. 本地扩展清单允许以后增量增加社区字段；
10. Desktop 和 Server 共享 Runtime。

不为尚未实现的未来功能创建空服务、复杂状态机和占位数据库表。

## 18. 实施阶段

### Phase 0：核心 Runtime Spike

- 外部 NekroNxt Bundle 无 Fork 启动 DSH；
- Node、pnpm、DSH 精确版本和 `dsh-compat`；
- `AgentRevision` 编译/选择 Preset；
- Web Channel、Channel Event Log、Episode、Admission 和 Outbox；
- 安全间隙注入、去重、重放与恢复；
- DSH 升级兼容测试骨架。

### Phase 1：一期双垂直闭环

-智能体-centric 管理页面；
- 同一智能体的创造能力组合与 NekroNxt Inspect；
- 动态 Tool 和 Client Slot 创建、运行、修改、停止及目标智能体作用域验证；
- 保存为本地 TypeScript Extension；
- Revision、Activation 和重启恢复；
- 最小诊断与恢复模式；
- QQ OpenClaw Adapter：C2C、群聊、Mention、引用、媒体、幂等、回执与断线恢复。

### Phase 2：群聊 Product MVP 收口

- Connection、Channel、Binding 完整管理体验；
- 多 Channel智能体；
- 更多触发策略和长期运行验证；
- 按真实需求增量增加 Adapter，不要求同时支持所有平台。

### Phase 3：交付完善

- Electron Desktop 安装更新；
- Linux 单容器；
- 备份、迁移和更新体验；
- 性能、缓存和长期运行优化；
- 更多 Adapter。

### Future：社区生态

在本地扩展模型稳定、真实用户有分享需求后单独立项。

一期更细的里程碑、包边界与待决策矩阵见 `04-一期开发计划与决策清单.md`。

## 19. 已冻结决定与 M0 验证项

项目名、纯 TypeScript 主栈、连续 Channel Session、本地源码 Revision、QQ OpenClaw Adapter、React 18 与 UI 基础、双 SQLite、Adapter 配置层级和客户端 migration 所有权已经冻结，统一记录在 `04-一期开发计划与决策清单.md` 与 `decisions/accepted/`。

M0 不重新选择这些方向，而是验证完整 DSH npm package set、Client Slot 复用边界、动态 Package 的目标智能体作用域、双 SQLite 恢复、动态构建器和 migration 崩溃恢复。Spike 失败时记录实际证据并修订对应 Decision，不能用兼容垫片掩盖基础方案不成立。

## 20. 首个版本完成标准

满足以下演示，Local Creator Alpha 才算成立：

1. 新用户在 UI 中创建智能体并开始 Web 对话；
2. 用户为该智能体打开创造能力；
3. 智能体检查当前 NekroNxt Tool/Slot 契约；
4.智能体动态创建一个有真实业务作用的 Tool；
5.智能体动态创建一个可见 Client Slot UI；
6. 用户能看到运行、错误、更新和停止状态；
7.智能体修复一次故意制造的错误并产生新 Package；
8. 用户将结果保存为本地 TypeScript Extension；
9. 应用重启后插件仍可加载；
10. 插件只出现在指定智能体上；
11. 坏插件可以禁用，系统可以恢复启动；
12. 整个流程普通用户不需要打开终端。

## 21. 项目铁律

1.智能体是产品中心，Channel 只是入口，Preset 是运行组装。
2. DSH 是内核；通过 Bundle 和 Plugin 扩展，不完整 Fork。
3. Web、群聊和私聊进入同一 Channel Runtime。
4. 用户可见消息只由通信工具发送，模型原始输出只在后台观察。
5. 普通新消息不打断当前模型和 Tool，只在安全 Step 注入。
6. 一个扩展体系，多种 Contribution；Adapter 不是第二套插件。
7. 插件保存与给智能体激活分离，影响范围必须清楚。
8. 创造能力由用户给智能体授权，不用想象中的风险扼杀核心能力。
9. 先打通本地创造闭环，再建设社区和重型治理。
10. 不迁移、不兼容 Nekro Agent，只吸收经验。
11. 先参考已验证机制，再按当前领域重设计。
12. 单仓、纯 TS、中文知识、一个 Runtime、两个 Host。
13. 文档服务实现，规则只解决真实问题，不提前制造流程负担。
14. 预留稳定接缝，不提前实现未来系统。

## 22. 最终结论

新项目的核心不是“重写 Nekro Agent”，也不是“给 DSH 加一个聊天平台外壳”。它是一个以 DSH 为可组合智能体内核、以智能体/Channel/Extension 为产品领域、以本地动态创造为首要差异的全新平台。

我们首先验证：普通用户能否在 UI 中创建智能体，并让它创造、运行、修复和保存自己的本地扩展。群聊、多平台、桌面和服务器围绕这条核心能力逐步补齐；社区供应链、安全分级和云端生态在真实需求出现后再建设。
