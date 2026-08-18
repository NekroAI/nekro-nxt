# Channel Runtime

该包拥有 Channel Event 提交后的触发、Episode、Admission 和 Outbox 状态机。Channel 事实仍由 Core Repository 拥有；DSH Session 通过 `AgentSessionDriver` 接入，聊天平台通过 Adapter SDK 接入，两边都不能直接改写 Runtime 状态。

M2 已交付按 `(channelId, agentId)` 串行的 lane、工具期间普通消息注入、恢复扫描、显式停止、必要 rollover 和 handoff。单纯上下文压力仍使用 DSH 原 Session 压缩；发送提交后结果不确定的物理投递恢复为 `unknown`，不盲目重发。未来积压策略继续扩展同一 Admission 状态机，不另建第二套消息队列。

Handoff 的摘要来源由 `listEpisodeHistory()` 限定为旧 Episode 已完成 Admission 和自身 Outbound；上一份 handoff 作为独立派生输入，最近频道原文窗口只用于新 Session 恢复。摘要驱动失败由 Runtime 生成确定性 fallback，不能阻断 rollover。显式 `stopEpisode(..., 'stopped')` 后下一条触发消息创建无 handoff 的干净 Episode，旧事实保持只读。
