# 已实施：M1 最小领域与 Web Channel

> 归档日期：2026-08-19。过程日记，已冻结，不是现行规范。

状态：implemented

> 后续命名说明：本记录保留 M1 实施当时的 `send_message` 历史名称。为避免与 DSH 子智能体控制工具冲突，当前频道通信工具已更名为 `send_channel_message`。

## 结论

一期 M1 已形成可离线重复验证的真实垂直闭环：网页消息通过 Internal Web Adapter 进入 Channel Event Log，Channel Runtime 创建 Episode 与 Admission，生产 Host roster 启动 DSH Agent Loop；只有智能体调用 `send_message` 产生的 Outbox、PhysicalDelivery 和成功回执会成为频道消息，模型原始文字只保留在 DSH Session 日志。

## 已落实边界

- 智能体配置使用 `AgentDefinition` 和不可变 `AgentRevision`；Connection、Channel 与 Binding 分离；
- 单个 `(channelId, agentId)` 使用一个活动 Episode 和 DSH Session；连续上下文压力由已装配的 `dsh-compaction-basic` 在原 Session 内处理；
- DSH Host 使用独立、精确版本断言的最小生产 roster，不把开发期 Base/Web Bundle 或 Client 空入口当成生产 Runtime；
- Admission 的 DSH `UserMessage` 保存 `admissionId` 与 `channelEventIds` 来源；
- `send_message` 默认以 Episode ID 与 DSH Tool Call ID 共同构造 `clientRequestId`，同一 Session 重放不会重复发送，rollover 后的新 Session 也不会与旧 call ID 冲突；
- SQLite 保存 Outbox、物理投递和结构化回执，失败、部分成功与未知结果保持独立状态；
- 当前频道历史为入站和出站生成规范化 `search_text`，按 Channel 分页后在 TypeScript 中做字面子串匹配，并用稳定来源 ID 精确回读；
- 仅展示名变化被判定为 M1 的 Session 兼容 Revision，并在 DSH Agent 空闲后切换 Episode Revision；人设、模型、推理强度或设置变化明确等待 M2 rollover；
- Asset Service 使用流式 SHA-256、私有 staging 和同文件系统原子发布；文件先发布，Channel Event 与 AssetOccurrence 再在一个数据库事务提交，不再维护 operation journal；
- 视频首期仍是普通文件；平台声明 MIME 不覆盖从字节检测得到的 Asset MIME。

## 验证证据

- 真实 DSH Agent Loop 组装测试使用可控 LLM Adapter：同一模型响应同时包含原始文字和通信工具调用时，Web 只观察到工具消息；Session 日志保留内部文字和工具轨迹；
- 相同文件并发导入只发布一个内容寻址 blob；每条 Channel Event 通过 `(channel_event_id, part_index)` 保留独立 Occurrence，未引用文件不会进入恢复视图；
- Channel Event 重放、Session/Admission、混合消息拆分、部分成功、unknown、`clientRequestId` 幂等、Revision 兼容切换和跨频道历史隔离均有自动测试；
- `pnpm check`、`pnpm test` 与 `pnpm build` 通过；当前无密钥测试为 12 个测试文件、44 个测试。

## M2 接缝与明确未做

本实现保留 Admission claimed 状态、Episode rollover 状态、结构化来源、Outbox attempt 和 DSH `inject()` 接缝。M1 没有提前实现 lane 串行化、工具期间注入、崩溃补偿、unknown 重试、handoff rollover、图片原生投影与增强队列；这些继续由 M2 扩展同一状态机，不建立第二套队列或会话内压缩引擎。

## 参考取舍

关联方向：更多 Adapter、智能体多频道、长期历史、多媒体与持续升级。

参考 DSH 的 Agent Factory、Scope、Session Persistence、Tool Runtime、原 Session compaction 和 checkpoint；拒绝深 Fork、私有 inbox、自动投递模型文字和把 DSH Session 数据库当 Core 数据库。参考 Nekro Agent 与 QQ OpenClaw 的群聊经验只用于后续 Adapter 机制，不导入旧数据、旧文本 Mention 协议或平台特例。
