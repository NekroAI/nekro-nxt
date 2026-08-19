# 决策：Channel Runtime 与会话组织

> 归档日期：2026-08-19。设计长文，已冻结，不是现行规范。现行契约见 `docs/decisions/implemented/2026-08-15-Channel-Runtime与会话组织.md`。

状态：accepted

## 问题

Channel 是持续存在的外部消息事实流，DSH Session 是智能体连续运行历史。正常聊天中，一个 `(channelId, agentId)` 只对应一个活动 DSH Session；Channel Event Log 与 DSH Session 仍是不同事实层。NekroNxt 需要同时解决消息去重、顺序、触发、工具执行期间的新消息、安全间隙注入、会话内压缩、必要时的 Session 交接、配置版本切换、出站回执和崩溃恢复。

## 必须满足的产品契约

1. 一个 Channel 只保存自己的消息事实，不混入其他 Channel 的短期上下文；
2. 每条准入模型的消息都能追溯到原始 Channel Event；
3. 普通消息不取消当前模型请求或 Tool；
4. 停止、权限撤销和系统关停可以显式取消；
5. 用户可见消息只能由通信工具产生；
6. `AgentRevision` 和 Extension Activation 的切换只发生在安全间隙；
7. 重放同一平台事件不重复触发业务执行；
8. 发送失败、部分成功和未知结果不能显示成已发送。

## 已确认策略：连续 Session + 必要时 Episode 交接

Channel 持续记录平台事实；一个智能体在一个 Channel 上通常只有一个活动 Episode 和一个 DSH Session。连续对话即使触及上下文压力，也优先在原 Session 内使用 DSH 自带压缩，不因“上下文满”本身切换 Session。

只有对话连续性已经自然断开、运行契约发生不兼容变化、用户明确新建会话，或原 Session 无法可靠恢复时，才在安全间隙结束旧 Episode，并以紧凑交接记录创建新 Session。每次触发新建 Session 只适合无上下文 Job，不作为普通 Channel 路径。

## 推荐模型

### 1. 核心对象

```text
Connection
└─ Channel
   ├─ ChannelEvent[]
   ├─ ChannelBinding[]
   ├─ AdmissionBatch[]
   └─ AgentChannelEpisode[]
      └─ dshSessionId

OutboundMessageIntent
└─ PhysicalDelivery[]
   └─ 当前最终回执
```

建议最小字段：

#### `ChannelEvent`

- `id`：NekroNxt 稳定 ID；
- `channelId`、`logicalMessageId`、`platformMessageId?`；
- `kind`：`message-created`、`message-edited`、`message-deleted`、`member-updated`、`reaction`、`control` 等可扩展联合；
- `senderMemberId`；
- `parts: MessagePart[]`；
- `sourceTimestamp`、`receivedAt`；
- `dedupeKey`；
- `facts?` 与派生 `searchText`；不把不稳定原始对象当领域事实。

#### `AgentChannelEpisode`

- `id`、`channelId`、`agentId`；
- `agentRevisionId`；
- `dshSessionId`；
- `status`：`opening`、`active`、`closed`、`failed`；摘要阶段不持久化 `rolling-over`；
- `openedAtEventId`、`lastAdmittedEventId`、`closedAtEventId?`；
- `closeReason?`：人工新会话、配置切换、长期空闲、恢复、错误等。

#### `AdmissionBatch`

- `id`、`episodeId`；
- 有序来源由 `admission_events` 关系表保存；
- `mode`：`followup` 或 `inject`；
- `state`：`pending`、`claimed`、`logged-to-session`；
- 对应 DSH Message ID、Turn/Step 坐标；
- `createdAt`、`claimedAt?`。

Admission 是连接 Channel Log 和 DSH Session Log 的证据，不复制整份平台消息作为第三个事实源。

### 2. 入站链路

```text
Adapter 事件
→ 规范化并验证
→ 按 dedupeKey 持久化 ChannelEvent
→ Binding Trigger Policy
→ 创建 AdmissionBatch
→ 空闲时 followup，运行中普通消息 inject
→ agent/pre-step 投影完整批次
→ DSH Session Event 记录来源 ChannelEvent ID
```

#### 去重

Adapter 使用稳定字段构造 `dedupeKey`；平台没有稳定事件 ID 时可组合平台消息 ID、事件类型和稳定载荷字段。哈希只能作为降级，不应用接收时间参与业务幂等键。

#### 顺序

按 `sourceTimestamp + receivedAt + ChannelEventId` 建立确定性本地顺序。平台 sequence 只在 Adapter/Gateway 推进时使用，不作为重复的 Core Event 字段。

#### 并发

首期每个 Channel 只有一个当前智能体 Binding，对应一个 `(channelId, agentId)` Turn lane。一个智能体可以同时拥有多个频道 lane；多个事件可以并发入库，但每条 lane 的 Trigger、Admission claim 和 Episode rollover 串行化。频道换绑只替换当前 Binding，旧 Episode、消息事实和 `binding-replaced` 关闭原因继续保留。

### 3. 工具执行期间的新消息

- 新消息立即写入 Channel Log；
- 创建或追加到待处理 AdmissionBatch；
- 普通消息调用 DSH `inject()`，不唤醒、不取消；
- 下一安全 Step 由 `agent/pre-step` 投影所有尚未准入的有序事件；
- 合并只发生在模型投影层，ChannelEvent 仍逐条保存；
- Owner 停止、权限撤销、Node 关停使用显式 control event 和 `cancel()`。

首期不自动用模型摘要丢弃积压消息。达到积压限制时进入可见背压状态，由确定性批次和分页投影处理；摘要策略在真实压力数据出现后另行设计。

### 4. DSH 原 Session 压缩

DSH 已有可直接使用的压缩能力，不需要 NekroNxt 重新实现第二套会话内压缩引擎：

- `@deepseek-ai/dsh-compaction-basic` 默认在路由模型上下文容量约 80% 时压缩，并保留约 16% 的近期尾部；
- 压缩把较早的平衡事件区间总结成模型侧 checkpoint，但原始 Session Event Log 仍保持追加式记录；
- `@deepseek-ai/dsh-compaction-tool-result-pruner` 可先移除过大的 Tool Result 负载；
- `@deepseek-ai/dsh-command-compact` 提供人工压缩入口；
- 图片会被带入总结请求，若总结模型不支持图片则明确失败，不静默丢弃。

因此，连续对话中的上下文压力、上下文满和常规多次压缩都不触发 Session rollover。NekroNxt 首期只负责选择并配置 DSH 压缩插件、观察压缩结果和处理显式失败，不自己改写 DSH 的 surface 压缩算法。

当前限制是：压缩后的旧细节虽然仍在原始日志中，但智能体没有现成的模型侧检索工具。DSH 的 recallable compaction Agent Note 仍是 `proposed`，跨 Session recall 也尚未实现。NekroNxt 需要补上受 Channel 权限约束的只读历史访问：

- `conversation_history_search`：在当前 Channel、当前智能体获授权的 Episode lineage 内搜索历史；
- `conversation_history_read`：按消息、事件或时间范围读取原始对话和既有摘要；
- 搜索结果必须返回稳定来源 ID，摘要不能伪装成原始消息；
- 首期接口语义尽量与 DSH 提案对齐，未来上游能力成熟后可替换后端，不改变智能体工具契约。

### 5. Episode rollover

发生以下任一条件时安排切换：

- 用户选择“新建会话”；
- 数小时无交互，新的输入已经不再属于自然连续对话；
- `AgentRevision`、模型、工具集合、权限或 Extension Activation 的变化与原 Session 运行契约不兼容；
- 当前 Episode 无法可靠恢复。

“上下文达到阈值”“发生过压缩”或“Session 历史很长”不能单独触发 rollover。兼容的配置变化也不应机械切换；是否不兼容由明确的 Revision/Capability diff 规则判断。

切换步骤：

```text
保持旧 Episode active，在 lane 内生成摘要与新 Session
→ 等待当前 Tool/Step 到安全间隙
→ flush DSH Session 与 Channel admission
→ 生成并持久化来源明确的 handoff summary/checkpoint
→ 关闭旧 Episode 并保留只读 lineage
→ 以目标 Revision 创建 DSH Session
→ 将紧凑 handoff 作为 seed 注入，不复制整份旧 Session
→ 原子切换 Binding 的 activeEpisodeId
```

handoff 至少包含：未完成目标、用户近期明确约束、关键决定、仍有效的外部资源引用、旧 Episode ID 和摘要来源边界。它是可核验的派生记录，不替代旧 ChannelEvent 和 Session Event。

首期实现人工新建、明确不兼容的 Revision/Activation 切换、错误恢复和一个可配置的长时间空闲阈值。默认阈值确定为 6 小时，允许 Binding 覆盖或关闭；它只在下一次消息到来时安排切换，不需要后台定时关闭。暂不根据 Token 数或压缩次数设计自动 rollover。

handoff summary 首期确定使用当前对话模型生成，以保持对当前人设、语言和任务语义的理解；摘要请求使用独立的确定性模板并记录模型、输入边界和来源 ID。未来出现明确成本或质量需求时，可以配置独立 summarizer，不改变 handoff 数据格式。

历史检索按当前 Channel 分页读取规范化 `search_text`，在 TypeScript 中做字面子串匹配，再精确回读来源消息。不引入 embedding 或向量数据库。

### 6. 出站 Outbox

通信工具首先创建 `OutboundMessageIntent`：

- `logicalMessageId`；
- `agentId`、`agentRevisionId`、`episodeId`、`sourceTurnId`；
- `channelId`、`parts`、`replyTo?`；
- `clientRequestId`，在智能体与目标范围内唯一；
- `state`：`planned`、`sending`、`sent`、`partially-sent`、`failed`、`unknown`。

Channel Runtime 根据 Adapter capability 生成一个或多个 `PhysicalDelivery`，每个物理发送拥有独立 attempt 和 receipt。Adapter 不自行无限重试；Runtime 只自动重试明确的发送前失败或平台声明幂等的操作。网络中断发生在请求提交后时，标记 `unknown`，先查询或等待平台重放，不盲目重复发送。

### 7. 持久化边界

推荐：NekroNxt Core SQLite 保存 Channel、Binding、Event、Admission、Episode、Outbox 和 Receipt；DSH Session 使用自己的 SQLite Provider。两个数据库不伪造跨库事务。

一致性通过可恢复状态机保证：

- ChannelEvent 先持久化，再创建 Admission；
- Admission 进入 DSH 后记录对应 Session Event；
- 崩溃恢复扫描 `claimed` 但未 `logged-to-session` 的批次，根据 DSH 日志中的来源 ID 判定补偿；
- Outbound Intent 先持久化，再调用 Adapter；
- Adapter 结果再持久化 Receipt。

不推荐把 NekroNxt 表直接写入 DSH Session 数据库，也不让 Adapter 访问 Core 数据库。

### 8. Adapter 接口

Adapter 只负责：

- 声明 capability；
- 将平台事件规范化为入站事件；
- 管理 Connection 生命周期和 checkpoint；
- 执行 PhysicalDelivery；
- 返回结构化 receipt 或可分类错误。

Adapter 不负责：

- 选择智能体；
- 拼模型上下文；
- 无限重试；
- 直接写 DSH Session；
- 绕过通信工具发业务消息。

## 已确认范围与延后项

- Core 使用 `better-sqlite3 + Drizzle`，只支持 SQLite；WAL 与在线备份由存储测试覆盖；
- Channel Event 联合类型保留 reaction/member，QQ 首期只实现消息、引用和触发所需的成员更新；
- `unknown` 不自动重试；手工重试 UI 延后到出站诊断页面实现，重试必须创建新 attempt 并提示可能重复。

## 验证

- Fake Adapter 重放同一事件 100 次，只产生一个 ChannelEvent 和一次业务触发；
- Tool 运行期间写入 20 条消息，Tool 不被取消，下一 Step 按序看到全部 20 条；
- 上下文达到压力阈值后在同一 Session 完成 DSH 压缩，activeEpisodeId 和 dshSessionId 不变；
- 长时间空闲或不兼容 Revision 切换只在安全间隙产生新 Episode，新 Session 能读取 handoff，旧 Session 可回放和检索；
- 一个逻辑混合消息拆成多条物理消息时能表达部分成功；
- 请求提交后模拟断线，状态为 unknown，不自动重复；
- 不同 Channel 的 Event、Admission 和 DSH Session 不交叉；
- 重启后能从 Channel cursor、Admission 和 DSH 日志恢复。

## 未来方向检查

关联方向：更多 Adapter、频道解绑与批量管理、长期记忆、长期 Job、多媒体消息。

保留接缝：稳定 ID、Binding 与 Channel 分离、显式 `agentId`、Episode、Admission、MessagePart、Adapter capability、逻辑消息与物理发送分离。

避免锁死：不把 Channel 的事实存储等同于 DSH Session，不把智能体永久锁定到一个频道，不在换绑时删除历史，不把平台差异写进 Core，也不自建与 DSH 重叠的压缩内核。

本次不做：跨频道短期上下文混合、自动长期记忆、分布式队列、基于压缩次数的 rollover、向量记忆系统、跨节点调度。

## 参考证据

- DSH Agent `followup/steer/inject`、Session Event Log、Persistence、`dsh-compaction-basic`、Tool Result Pruner 与 proposed recallable-compaction note；
- Nekro Agent QQ OpenClaw 的真实群触发、引用和 Gateway 实现；
- 腾讯 OpenClaw QQBot 的回复额度、群策略、多账号和连接恢复机制。

借鉴机制：双日志、安全 Step、稳定平台 ID、被动回复约束和结构化回执。

明确拒绝：不复制 DSH 私有 inbox，不复制 Nekro Agent 的全局聊天历史拼接，不用同步 JSON 文件承担 Channel 事实源，也不因上下文满而机械创建新 Session。
