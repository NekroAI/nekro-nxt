# Channel Runtime 与会话组织

状态：implemented

Channel Event Log 与 DSH Session 是不同事实层。一个 `(channelId, agentId)` 在正常聊天中只有一个活动 Episode 和一个 DSH Session。

## 运行规则

- 一个频道只保存自己的消息；普通消息不取消当前模型或 Tool；
- Adapter 事件按 `dedupeKey` 入库。每条 `(channelId, agentId)` lane 串行处理 Trigger、Admission 和 rollover；一个智能体可以同时拥有多条 lane；
- 空闲时 followup，运行中普通消息 `inject()`，在下一安全 Step 投影尚未准入的有序事件；
- 上下文压力使用 DSH 原 Session 压缩，不因此切换 Session；
- 只有人工新建、默认 6 小时空闲、不兼容 Revision/Activation 或不可恢复时，才在安全间隙交接 Episode；
- 历史检索按频道分页读取 `search_text`，做字面子串匹配后再精确回读；
- 通信工具先写 Outbound Intent，再产生 PhysicalDelivery 与回执；`unknown` 不自动重试。

消息内容与出站语义以 `docs/03-消息内容与投递协议.md` 为准。handoff 失败降级见 `docs/decisions/implemented/2026-08-18-Handoff失败降级与最近窗口恢复.md`。
