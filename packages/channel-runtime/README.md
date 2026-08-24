# Channel Runtime

该包拥有 Channel Event 提交后的触发、Episode、Admission 和 Outbox 状态机。Channel 事实仍由 Core Repository 拥有；DSH Session 通过 `AgentSessionDriver` 接入，聊天平台通过 Adapter SDK 接入，两边都不能直接改写 Runtime 状态。

M2 已交付按 `(channelId, agentId)` 串行的 lane、工具期间普通消息注入、恢复扫描、显式停止、上下文清空、主动交接、必要 rollover 和 handoff。单纯上下文压力仍使用 DSH 原 Session 压缩；发送提交后结果不确定的物理投递恢复为 `unknown`，不盲目重发。未来积压策略继续扩展同一 Admission 状态机，不另建第二套消息队列。

Handoff 的摘要来源由 `listEpisodeHistory()` 限定为旧 Episode 已完成 Admission 和自身 Outbound；上一份 handoff 作为独立派生输入，新 Session 的最近原文同样只取旧 Episode 已准入的频道事实，不能跨过更早的清空边界。摘要驱动失败由 Runtime 生成确定性 fallback，不能阻断 rollover。`resetEpisode(id, 'clear')` 先取消当前模型与工具，再以 `context-cleared` 关闭 Episode，不创建 handoff；下一条触发消息创建干净 Episode。`resetEpisode(id, 'compact')` 同样先取消当前运行，再从旧 Episode 的 durable history 生成 handoff，以 `context-compacted` 关闭旧 Episode 并立即激活新 Episode。两种操作都不删除频道事实，历史仍可由主动查询工具读取。

`ChannelHistoryEntry` 对入站和出站统一携带 `logicalMessageId`；精确查询始终要求 `channelId + logicalMessageId`，不提供跨频道回退。Channel Event ID 继续属于 Admission、恢复和审计来源，不作为模型引用消息的身份。

`deleteChannel(channelId)` 与该频道当前 Binding 共用 lane，先以 `channel-deleted` 取消 DSH Session、关闭 Episode，再清除 Binding 并写 Channel tombstone；不生成 handoff，也不删除频道事实、出站、资源引用或 DSH 历史。
