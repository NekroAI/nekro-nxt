import {
  AgentIdSchema,
  AgentRevisionIdSchema,
  AssetIdSchema,
  AuthoringAttemptIdSchema,
  AuthoringTaskIdSchema,
  ChannelEventIdSchema,
  ChannelIdSchema,
  ChannelMemberIdSchema,
  ConnectionIdSchema,
  ConnectionEventIdSchema,
  EpisodeIdSchema,
  ExtensionIdSchema,
  ExtensionRevisionIdSchema,
  HostApiContracts,
  HostUiPageInstanceIdSchema,
  OutboundIntentIdSchema,
  PlatformIdentityIdSchema,
} from '@nekro-nxt/contracts'

export const targetAgentId = AgentIdSchema.parse('agt_targetinternalid')
export const sourceAgentId = AgentIdSchema.parse('agt_sourceinternalid')
export const targetRevisionId = AgentRevisionIdSchema.parse('arev_targetinternal')
export const sourceRevisionId = AgentRevisionIdSchema.parse('arev_sourceinternal')
export const targetChannelId = ChannelIdSchema.parse('chn_target')
export const sourceChannelId = ChannelIdSchema.parse('chn_source')
export const externalChannelId = ChannelIdSchema.parse('chn_external')
export const internalConnectionId = ConnectionIdSchema.parse('con_internal')
export const externalConnectionId = ConnectionIdSchema.parse('con_external')
export const summaryExtensionId = ExtensionIdSchema.parse('ext_summary')
export const summaryRevisionId = ExtensionRevisionIdSchema.parse('xrv_summary')
export const dashboardExtensionId = ExtensionIdSchema.parse('ext_dashboard')
export const dashboardRevisionId = ExtensionRevisionIdSchema.parse('xrv_dashboard')
export const overviewPageId = HostUiPageInstanceIdSchema.parse('hup_DASHBOARD')
export const reportsPageId = HostUiPageInstanceIdSchema.parse('hup_REPORTS')
export const targetEpisodeId = EpisodeIdSchema.parse('eps_target')
export const previewAuthoringTaskId = AuthoringTaskIdSchema.parse('aut_PREVIEWPROBE')
export const previewAuthoringAttemptId = AuthoringAttemptIdSchema.parse('aua_PREVIEWPROBE')
export const saveAuthoringTaskId = AuthoringTaskIdSchema.parse('aut_SAVEPROBE')
export const saveAuthoringAttemptId = AuthoringAttemptIdSchema.parse('aua_SAVEPROBE')
export const visibleEventId = ChannelEventIdSchema.parse('evt_visible')
export const externalEventId = ChannelEventIdSchema.parse('evt_externalvisible')
export const externalSystemEventId = ChannelEventIdSchema.parse('evt_externalsystem')
export const externalCardEventId = ChannelEventIdSchema.parse('evt_externalcard')
export const externalImageEventId = ChannelEventIdSchema.parse('evt_externalimage')
export const sentEventId = ChannelEventIdSchema.parse('evt_sent')
export const resourceIntentId = OutboundIntentIdSchema.parse('out_resources')
export const senderMemberId = ChannelMemberIdSchema.parse('mbr_sender')
export const targetMemberId = ChannelMemberIdSchema.parse('mbr_target')
export const imageAssetId = AssetIdSchema.parse('ast_image')
export const imagePolicy = {
  history: {
    mode: 'persistent-distinct' as const,
    detail: 'auto' as const,
    restoreAfterCompaction: { recentMessages: 32, maxImages: 20 },
  },
  textModel: { mode: 'disabled' as const },
}
export const imageDiagnostics = {
  route: { mode: 'direct' as const, provider: 'deepseek', model: 'deepseek-v4-flash' },
  activeSessions: 1,
  residentImages: 6,
  duplicateImagesSkipped: 4,
  lastInspection: {
    mode: 'direct' as const,
    imageCount: 3,
    cacheHit: false,
    usage: { inputTokens: 1280, outputTokens: 220 },
  },
  lastRestoration: {
    compactionId: 'cmp_visual_demo',
    candidateCount: 9,
    restoredCount: 6,
    skippedCount: 3,
  },
  blockers: [],
}
export const fileAssetId = AssetIdSchema.parse('ast_file')
export const connectionActorId = PlatformIdentityIdSchema.parse('pid_VISUALACTOR')
export const connectionSubjectId = PlatformIdentityIdSchema.parse('pid_VISUALSUBJECT')
export const connectionEvents = Array.from({ length: 35 }, (_, index) => ({
  id: ConnectionEventIdSchema.parse(`cev_VISUAL${String(index + 1).padStart(2, '0')}`),
  connectionId: externalConnectionId,
  activityKey: 'account-signal',
  summary:
    index === 0 ? '账号资料收到一条较长的连接活动摘要，用于确认较多事实仍保持紧凑可读。' : `连接活动 ${index + 1}`,
  actor: { identityId: connectionActorId, displayName: '参与者甲' },
  ...(index % 2 === 0 ? { subject: { identityId: connectionSubjectId, displayName: '相关对象乙' } } : {}),
  occurredAt: 1_725_000_100_000 - index * 1_000,
}))

export const productSnapshot = HostApiContracts.snapshot.response.parse({
  cursor: { epoch: 'fixture', sequence: 0 },
  diagnosticsSampledAt: 0,
  productMetadata: {
    displayName: 'NekroNXT Preview',
    organizationName: 'NekroAI',
    version: '0.1.0',
    releaseId: '0.1.0-visual-review',
    repositoryUrl: 'https://github.com/NekroAI/nekro-nxt',
    licenseSpdx: 'AGPL-3.0-only',
    dshVersion: '0.1.1-rc.2',
  },
  capabilityAvailability: {
    subagents: { available: true },
    webSearch: {
      provider: 'deepseek-official',
      available: false,
      credentialConfigured: false,
      credentialReference: 'DEEPSEEK_API_KEY',
      maxUsesPerCall: 2,
      maxResultsPerCall: 5,
      timeoutMs: 60_000,
    },
  },
  notificationSettings: {
    system: { enabled: true },
    bark: { enabled: false, serverUrl: 'https://api.day.app', deviceKeyConfigured: false },
    events: { 'dynamic-client-approval-requested': true },
  },
  connectionAdapters: [
    {
      key: 'fixture-alpha',
      displayName: '内置频道',
      description: '内置频道',
      provisioning: 'system-singleton',
      channelKinds: ['internal'],
      activities: [],
      features: {},
      aliasEditable: false,
      channelDiscovery: 'host-created',
      diagnostics: { receive: false, send: false },
      configSchema: { schemaVersion: 1, type: 'object', required: [], properties: {} },
    },
    {
      key: 'fixture-beta',
      displayName: '示例群聊平台',
      description: '连接示例平台账号',
      provisioning: 'user-created',
      channelKinds: ['direct', 'group'],
      activities: [],
      features: {},
      aliasEditable: true,
      channelDiscovery: 'adapter-observed',
      diagnostics: { receive: true, send: true },
      configSchema: {
        schemaVersion: 1,
        type: 'object',
        required: ['accountCode', 'secret'],
        properties: {
          accountCode: { type: 'string', title: '账号代码' },
          secret: { type: 'credential-reference', title: '访问密钥' },
          markdown: { type: 'boolean', title: '使用 Markdown', description: '允许发送 Markdown 消息。', default: true },
        },
      },
    },
  ],
  models: [
    {
      provider: 'deepseek',
      providerName: 'deepseek',
      id: 'deepseek-v4-flash',
      name: 'DeepSeek V4 Flash',
      inputModalities: ['text', 'image'],
    },
    {
      provider: 'test-provider',
      providerName: '测试供应商',
      id: 'text-model',
      name: '纯文本模型',
      inputModalities: ['text'],
    },
    {
      provider: 'unknown-provider',
      providerName: '能力未声明供应商',
      id: 'unknown-model',
      name: '能力未声明模型',
    },
  ],
  agents: [
    {
      id: targetAgentId,
      displayName: '资料员',
      persona: '严谨、简洁',
      personaDocument: { version: 1, segments: [{ type: 'text', text: '严谨、简洁' }] },
      currentRevisionId: targetRevisionId,
      createdAt: 1_725_000_000_000,
      runtimeStatus: 'running',
      runtimePhase: 'thinking',
      model: { provider: 'deepseek', model: 'deepseek-v4-flash' },
      dynamicClientApprovalPolicy: 'manual',
      imagePolicy,
      imageDiagnostics,
      capabilities: {
        subagents: false,
        fileTools: false,
        webSearch: false,
        dynamicCreation: true,
        developmentShell: false,
        unrestrictedFileAccess: false,
      },
      channels: [targetChannelId],
    },
    {
      id: sourceAgentId,
      displayName: '记录员',
      persona: '',
      personaDocument: { version: 1, segments: [] },
      currentRevisionId: sourceRevisionId,
      createdAt: 1_725_000_000_100,
      runtimeStatus: 'idle',
      model: { provider: 'deepseek', model: 'deepseek-v4-flash' },
      dynamicClientApprovalPolicy: 'manual',
      imagePolicy,
      imageDiagnostics,
      capabilities: {
        subagents: false,
        fileTools: false,
        webSearch: false,
        dynamicCreation: false,
        developmentShell: false,
        unrestrictedFileAccess: false,
      },
      channels: [sourceChannelId],
    },
  ],
  channels: [
    {
      id: targetChannelId,
      connectionId: internalConnectionId,
      platformChannelId: 'platform-target',
      kind: 'internal',
      displayName: '资料员的内置频道',
      boundAgentId: targetAgentId,
      bindings: [
        { channelId: targetChannelId, agentId: targetAgentId, triggerPolicy: 'always', boundAt: 1_725_000_000_000 },
      ],
    },
    {
      id: sourceChannelId,
      connectionId: internalConnectionId,
      platformChannelId: 'platform-source',
      kind: 'internal',
      displayName: '记录员的内置频道',
      boundAgentId: sourceAgentId,
      bindings: [
        { channelId: sourceChannelId, agentId: sourceAgentId, triggerPolicy: 'always', boundAt: 1_725_000_000_100 },
      ],
    },
    {
      id: externalChannelId,
      connectionId: externalConnectionId,
      platformChannelId: 'opaque-group-alpha',
      kind: 'group',
      displayName: '产品讨论群',
      bindings: [],
    },
  ],
  messages: [],
  connections: [
    {
      id: internalConnectionId,
      adapterKey: 'fixture-alpha',
      status: { state: 'connected', proactiveSend: false, credentialConfigured: true, activities: {} },
      channelCount: 2,
      knownChannels: [],
    },
    {
      id: externalConnectionId,
      adapterKey: 'fixture-beta',
      status: {
        state: 'connected',
        proactiveSend: false,
        credentialConfigured: true,
        accountReference: '示例账号',
        activities: {},
      },
      channelCount: 1,
      knownChannels: [{ id: externalChannelId, name: '产品讨论群', kind: 'group' }],
      lastInbound: {
        channelId: externalChannelId,
        platformMessageId: 'fixture-inbound',
        receivedAt: 1_725_000_010_000,
      },
      receiveTest: { status: 'received', channelId: externalChannelId, platformMessageId: 'fixture-inbound' },
      sendTest: { status: 'sent', channelId: externalChannelId, platformMessageId: 'fixture-outbound' },
    },
  ],
  extensions: [
    {
      id: summaryExtensionId,
      slug: 'group-summary',
      displayName: '群聊摘要',
      description: '把群聊讨论整理为可继续跟进的摘要。',
      createdByAgentId: targetAgentId,
      scope: 'agent',
      revisions: [
        {
          id: summaryRevisionId,
          revisionNumber: 2,
          createdAt: 1_725_000_000_000,
          scope: 'agent',
          contributions: [],
        },
      ],
      activations: [
        {
          agentId: targetAgentId,
          extensionRevisionId: summaryRevisionId,
          config: {},
          activatedAt: 1_725_000_000_000,
        },
      ],
      clientDiagnostics: [],
    },
  ],
  dynamic: [
    {
      agentId: targetAgentId,
      episodeId: targetEpisodeId,
      pluginId: 'dynamic-plugin-internal-id',
      packageId: 'dynamic-package-internal-id',
      status: 'running',
      packages: [
        {
          packageId: 'dynamic-package-internal-id',
          name: '动态摘要',
          purpose: '整理当前频道摘要。',
          hasHostHalf: true,
          hasClientHalf: false,
        },
      ],
      policy: { turn: 1, consecutiveFailures: 0, repeatedFingerprintCount: 0 },
    },
  ],
})

export const channelMessages = HostApiContracts.listChannelMessages.response.parse({
  cursor: { epoch: 'fixture', sequence: 0 },
  messages: [
    {
      id: visibleEventId,
      channelId: targetChannelId,
      role: 'member',
      parts: [{ type: 'text', text: '请复核今天的记录。' }],
      occurredAt: 1_725_000_000_000,
    },
    {
      id: externalEventId,
      channelId: externalChannelId,
      role: 'member',
      sender: { memberId: senderMemberId, displayName: '成员甲' },
      mentionedConnectionAccount: true,
      parts: [
        { type: 'mention', memberId: ChannelMemberIdSchema.parse('mbr_bot'), displayName: '机器人账号' },
        { type: 'text', text: '请和' },
        { type: 'mention', memberId: targetMemberId, displayName: '成员乙' },
        { type: 'text', text: '一起复核。' },
      ],
      occurredAt: 1_725_000_010_000,
    },
    {
      id: externalSystemEventId,
      channelId: externalChannelId,
      role: 'system',
      sender: { memberId: senderMemberId, displayName: '成员甲' },
      activityKey: 'member-joined',
      parts: [
        { type: 'mention', memberId: senderMemberId, displayName: '新成员' },
        { type: 'text', text: ' 受 ' },
        { type: 'mention', memberId: targetMemberId, displayName: '邀请人' },
        { type: 'text', text: ' 邀请加入了频道。' },
      ],
      occurredAt: 1_725_000_012_000,
    },
    {
      id: externalCardEventId,
      channelId: externalChannelId,
      role: 'member',
      sender: { memberId: senderMemberId, displayName: '成员甲' },
      parts: [
        {
          type: 'rich',
          adapterKey: 'fixture-beta',
          kind: 'miniapp',
          summary: '示例来源 · 示例分享',
          title: '示例分享',
          source: '示例来源',
          targetUrl: 'https://example.test/share/fixture-card',
          previewAssetId: imageAssetId,
        },
      ],
      occurredAt: 1_725_000_015_000,
    },
    {
      id: externalImageEventId,
      channelId: externalChannelId,
      role: 'member',
      sender: { memberId: senderMemberId, displayName: '成员甲' },
      parts: [{ type: 'image', assetId: imageAssetId, alt: '讨论截图' }],
      occurredAt: 1_725_000_016_000,
    },
    {
      id: resourceIntentId,
      channelId: targetChannelId,
      role: 'agent',
      parts: [
        { type: 'text', text: '这是本次交付的资源。' },
        { type: 'image', assetId: imageAssetId, alt: '界面预览图' },
        { type: 'file', assetId: fileAssetId, name: '验收记录.txt' },
      ],
      occurredAt: 1_725_000_020_000,
      deliveryState: 'sent',
    },
  ],
  hasMore: false,
}).messages
