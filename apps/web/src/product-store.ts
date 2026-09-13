import { createPlatformUserDirectoryLoader } from './platform-user-directory.js'
import { createOwnedHostQuery } from './owned-host-query.js'
import { StaleHostReadError } from './host-api-client.js'
import { parseJsonValue } from '@nekro-nxt/contracts'
import { create } from 'zustand'
import type { ProductHostPort } from './product-port.js'
import { createDynamicClientApprovalBridge } from './dynamic-client-bridge.js'
import {
  ProductActionError,
  emptyPlatformUserDirectory,
  defaultImageUnderstandingPolicy,
  CHANNEL_MESSAGE_INITIAL_PAGE_SIZE,
  CHANNEL_MESSAGE_PAGE_SIZE,
  type ProductState,
  type ProductActionErrorCode,
} from './product-model.js'
const requireValue = (value: string, message: string, code: ProductActionErrorCode = 'invalid-input'): string => {
  const normalized = value.trim()
  if (!normalized) throw new ProductActionError(code, message)
  return normalized
}

export function createProductStore(
  requireHost: () => ProductHostPort,
  approvals = createDynamicClientApprovalBridge(),
) {
  const useProductStore = create<ProductState>(() => ({
    llmProvidersQuery: { data: undefined, loading: false, error: '' },
    dshCatalogQuery: { data: undefined, loading: false, error: '' },
    loadLlmProviders: (invalidate) => providers.load(invalidate),
    replaceLlmProviders: (data) => providers.replace(data),
    loadDshCatalog: (invalidate) => catalog.load(invalidate),
    cancelSettingsQueries: () => {
      providers.cancel()
      catalog.cancel()
    },
    platformUserDirectory: emptyPlatformUserDirectory(),
    cancelPlatformUserDirectory: () => directory.cancel(),
    loadPlatformUserDirectory: (input, older = false) => directory.load(input, older),
    host: { status: 'initializing', error: null, lastSuccessfulAt: null },
    productMetadata: undefined,
    connectionAdapters: [],
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
    models: [],
    agents: [],
    channels: [],
    messagesByChannel: {},
    channelHistory: {},
    channelRuntimes: {},
    connections: [],
    archivedConnections: [],
    extensions: [],
    hostUi: { preferencesRevision: 0, pages: [] },
    platformUserFacets: { adapters: [], connections: [] },
    platformUsersRevision: 0,
    approvals: [],
    dynamic: [],
    authoringTasks: [],
    notificationSettings: {
      system: { enabled: true },
      bark: { enabled: false, serverUrl: 'https://api.day.app', deviceKeyConfigured: false },
      events: { 'dynamic-client-approval-requested': true },
    },
    diagnosticNote: '正在连接 NekroNXT Host…',
    workTreeOrder: { agentIds: [], channelIdsByAgent: {}, unboundChannelIds: [] },
    refreshHost: async () => {
      await requireHost().actions['host.refresh']()
    },
    createAgent: async ({ name, persona, personaDocument, model, capabilities, imagePolicy }) => {
      const result = await requireHost().actions['agents.create']({
        displayName: requireValue(name, '请输入智能体名称。'),
        persona,
        personaDocument,
        model: { provider: model.provider, model: model.id },
        capabilities,
        imagePolicy: imagePolicy ?? defaultImageUnderstandingPolicy(),
      })
      return { agentId: result['agentId'], channelId: result['channelId'] }
    },
    reviseAgent: async ({
      agentId,
      expectedCurrentRevisionId,
      displayName,
      persona,
      personaDocument,
      model,
      reasoningEffort,
      imagePolicy,
      dynamicClientApprovalPolicy,
    }) => {
      await requireHost().actions['agents.revise']({
        agentId: requireValue(agentId, '缺少智能体标识，请刷新页面后重试。'),
        expectedCurrentRevisionId: requireValue(
          expectedCurrentRevisionId ?? '',
          '缺少当前智能体配置版本，请刷新页面后重试。',
          'missing-prerequisite',
        ),
        displayName: requireValue(displayName, '请输入智能体名称。'),
        persona,
        personaDocument,
        model: { provider: model.provider, model: model.id, ...(reasoningEffort ? { reasoningEffort } : {}) },
        imagePolicy,
        dynamicClientApprovalPolicy,
      })
    },
    updateNotificationSettings: async (input) => {
      const result = await requireHost().actions['notifications.update'](input)
      return result
    },
    testBarkNotification: async (input) => {
      await requireHost().actions['notifications.testBark'](input)
    },
    testSystemNotification: async () => {
      await requireHost().actions['notifications.testSystem']()
    },
    deleteAgent: async (agentId, expectedCurrentRevisionId, confirmationName, deleteAutoCreatedBuiltInChannels) => {
      await requireHost().actions['agents.delete']({
        agentId: requireValue(agentId, '缺少智能体标识，请刷新页面后重试。'),
        expectedCurrentRevisionId: requireValue(
          expectedCurrentRevisionId,
          '缺少当前智能体配置版本，请刷新页面后重试。',
          'missing-prerequisite',
        ),
        confirmationName,
        deleteAutoCreatedBuiltInChannels,
      })
    },
    createConnection: async ({ adapterKey, alias, configuration, credentials }) => {
      await requireHost().actions['connections.create']({
        adapterKey: requireValue(adapterKey, '请选择连接平台。'),
        ...(alias === undefined ? {} : { alias: alias.trim() }),
        configuration,
        credentials,
      })
    },
    updateConnectionAlias: async (connectionId, alias) => {
      await requireHost().actions['connections.updateAlias']({
        connectionId: requireValue(connectionId, '缺少连接标识，请刷新页面后重试。'),
        alias: alias.trim(),
      })
    },
    updateConnectionActivityTriggerDefaults: async (connectionId, activityKeys) => {
      await requireHost().actions['connections.updateActivityTriggerDefaults']({
        connectionId: requireValue(connectionId, '缺少连接标识，请刷新页面后重试。'),
        activityKeys: [...activityKeys],
      })
    },
    deleteConnection: async (connectionId, deleteChannelData) => {
      await requireHost().actions['connections.delete']({
        connectionId: requireValue(connectionId, '缺少连接标识，请刷新页面后重试。'),
        deleteChannelData,
      })
    },
    restoreConnection: async (connectionId) => {
      await requireHost().actions['connections.restore']({
        connectionId: requireValue(connectionId, '缺少连接标识，请刷新页面后重试。'),
      })
    },
    createInternalChannel: async ({ displayName }) => {
      const result = await requireHost().actions['channels.createInternal']({
        displayName: requireValue(displayName, '请输入频道名称。'),
      })
      return { channelId: result['channelId'] }
    },
    createBinding: async ({ agentId, channelId, triggerPolicy, processingFeedback, activityTriggerOverrides }) => {
      await requireHost().actions['bindings.create']({
        agentId: requireValue(agentId, '缺少智能体标识，请刷新页面后重试。'),
        channelId: requireValue(channelId, '请选择要绑定的频道。'),
        triggerPolicy,
        ...(processingFeedback === undefined ? {} : { processingFeedback }),
        ...(activityTriggerOverrides === undefined ? {} : { activityTriggerOverrides }),
      })
    },
    clearBinding: async (channelId) => {
      await requireHost().actions['bindings.clear']({
        channelId: requireValue(channelId, '请选择要解除绑定的频道。'),
      })
    },
    deleteChannel: async (channelId, expectedBoundAgentId) => {
      await requireHost().actions['channels.delete']({
        channelId: requireValue(channelId, '缺少目标频道，请刷新页面后重试。'),
        expectedBoundAgentId,
      })
    },
    resetChannelContext: async (channelId, episodeId, mode) => {
      await requireHost().actions['channels.resetContext']({
        channelId: requireValue(channelId, '缺少目标频道，请刷新页面后重试。'),
        expectedEpisodeId: requireValue(episodeId, '频道当前没有可重置的上下文。', 'missing-prerequisite'),
        mode,
      })
    },
    putWorkTreeOrder: async (order) => {
      const previous = useProductStore.getState().workTreeOrder
      const next = {
        agentIds: [...order.agentIds],
        channelIdsByAgent: Object.fromEntries(
          Object.entries(order.channelIdsByAgent).map(([agentId, channelIds]) => [agentId, [...channelIds]]),
        ),
        unboundChannelIds: [...order.unboundChannelIds],
      }
      useProductStore.setState({ workTreeOrder: next })
      try {
        await requireHost().actions['workTreeOrder.put'](next)
      } catch (error) {
        if (error instanceof StaleHostReadError) return
        useProductStore.setState({ workTreeOrder: previous })
        throw error
      }
    },
    sendMessage: async (channelId, body) => {
      await requireHost().actions['channels.sendMessage']({
        channelId: requireValue(channelId, '缺少目标频道，请刷新页面后重试。'),
        body: requireValue(body, '消息内容不能为空。'),
      })
    },
    loadChannelMessages: async (channelId, mode = 'initial') => {
      const normalizedChannelId = requireValue(channelId, '缺少目标频道，请刷新页面后重试。')
      const currentState = useProductStore.getState()
      const history = currentState.channelHistory[normalizedChannelId]
      if (mode === 'initial' && (history?.loaded || history?.loading)) return
      if (mode === 'older' && (history?.loadingMore || history?.hasMore === false)) return
      const existing = currentState.messagesByChannel[normalizedChannelId] ?? []
      const oldest = existing[0]
      useProductStore.setState((state) => ({
        channelHistory: {
          ...state.channelHistory,
          [normalizedChannelId]: {
            loaded: history?.loaded ?? false,
            loading: mode === 'initial',
            loadingMore: mode === 'older',
            hasMore: history?.hasMore ?? true,
            error: '',
          },
        },
      }))
      try {
        const result = await requireHost().actions['channels.listMessages']({
          channelId: normalizedChannelId,
          mode,
          limit: mode === 'initial' ? CHANNEL_MESSAGE_INITIAL_PAGE_SIZE : CHANNEL_MESSAGE_PAGE_SIZE,
          ...(mode === 'older' && oldest?.occurredAt !== undefined
            ? { beforeOccurredAt: oldest.occurredAt, beforeSourceId: oldest.id }
            : {}),
        })
        const hasMore = result['hasMore']
        useProductStore.setState((state) => ({
          channelHistory: {
            ...state.channelHistory,
            [normalizedChannelId]: {
              loaded: true,
              loading: false,
              loadingMore: false,
              hasMore,
              error: '',
            },
          },
        }))
      } catch (error) {
        if (error instanceof StaleHostReadError) return
        useProductStore.setState((state) => ({
          channelHistory: {
            ...state.channelHistory,
            [normalizedChannelId]: {
              loaded: history?.loaded ?? false,
              loading: false,
              loadingMore: false,
              hasMore: history?.hasMore ?? true,
              error: error instanceof Error ? error.message : String(error),
            },
          },
        }))
        throw error
      }
    },
    loadChannelRuntime: async (channelId) => {
      const normalizedChannelId = requireValue(channelId, '缺少目标频道，请刷新页面后重试。')
      const result = await requireHost().actions['channels.getRuntime']({ channelId: normalizedChannelId })
      // The loader owns the runtime cache; do not write a second, potentially stale copy.
      return void result
    },
    renameChannel: async (channelId, displayName) => {
      await requireHost().actions['channels.rename']({
        channelId: requireValue(channelId, '缺少目标频道，请刷新页面后重试。'),
        displayName: requireValue(displayName, '请输入频道名称。'),
      })
    },
    setCapability: async (agentId, capability, enabled) => {
      await requireHost().actions['agents.updateCapabilities']({
        agentId: requireValue(agentId, '缺少智能体标识，请刷新页面后重试。'),
        [capability]: enabled,
      })
    },
    setCapabilities: async (agentId, capabilities) => {
      await requireHost().actions['agents.updateCapabilities']({
        agentId: requireValue(agentId, '缺少智能体标识，请刷新页面后重试。'),
        ...capabilities,
      })
    },
    runConnectionTest: async (id, direction, channelId) => {
      await requireHost().actions['connections.test']({
        connectionId: requireValue(id, '缺少连接标识，请刷新页面后重试。'),
        direction,
        ...(channelId === undefined ? {} : { channelId }),
      })
    },
    loadConnectionEvents: async (connectionId, older = false) => {
      const id = requireValue(connectionId, '缺少连接标识，请刷新页面后重试。')
      const current = useProductStore.getState().connections.find((connection) => connection.id === id)
      if (!current || current.eventsLoading || (older && !current.eventsHasMore)) return
      useProductStore.setState((state) => ({
        connections: state.connections.map((connection) =>
          connection.id === id ? { ...connection, eventsLoading: true } : connection,
        ),
      }))
      try {
        const oldest = older ? current.events.at(-1) : undefined
        const result = await requireHost().actions['connections.listEvents']({
          connectionId: id,
          limit: 30,
          ...(oldest === undefined ? {} : { beforeReceivedAt: oldest.occurredAt, beforeId: oldest.id }),
        })
        useProductStore.setState((state) => ({
          connections: state.connections.map((connection) => {
            if (connection.id !== id) return connection
            const combined = older ? [...connection.events, ...result.events] : result.events
            return {
              ...connection,
              events: [...new Map(combined.map((event) => [event.id, event])).values()],
              eventsLoaded: true,
              eventsLoading: false,
              eventsHasMore: result.hasMore,
            }
          }),
        }))
      } catch (error) {
        if (error instanceof StaleHostReadError) return
        useProductStore.setState((state) => ({
          connections: state.connections.map((connection) =>
            connection.id === id ? { ...connection, eventsLoading: false } : connection,
          ),
        }))
        throw error
      }
    },
    resolveApproval: async ({ requestId, agentId, approved }) => {
      const normalizedRequestId = requireValue(requestId, '缺少批准请求，请刷新页面后重试。')
      const normalizedAgentId = requireValue(agentId, '缺少智能体标识，请刷新页面后重试。')
      const dynamicItem = useProductStore
        .getState()
        .dynamic.find((item) => item.agentId === normalizedAgentId && item.approvalRequestId === normalizedRequestId)
      const task = dynamicItem
        ? useProductStore
            .getState()
            .authoringTasks.find(
              (candidate) =>
                candidate.agentId === normalizedAgentId &&
                candidate.episodeId === dynamicItem.episodeId &&
                candidate.candidateAttempt !== undefined,
            )
        : undefined
      if (task?.candidateAttempt) {
        const host = requireHost()
        await host.actions['authoring.decide']({
          taskId: task.id,
          attemptId: task.candidateAttempt.id,
          expectedRevision: task.revision,
          approved,
          approveRiskStable: true,
        })
      }
      const handled = approved
        ? await approvals.approve(normalizedAgentId, normalizedRequestId)
        : await approvals.decline(normalizedAgentId, normalizedRequestId)
      if (!handled) {
        const episodeId = useProductStore
          .getState()
          .dynamic.find(
            (item) => item.agentId === normalizedAgentId && item.approvalRequestId === normalizedRequestId,
          )?.episodeId
        await requireHost().actions[approved ? 'dynamic.approve' : 'dynamic.decline']({
          requestId: normalizedRequestId,
          agentId: normalizedAgentId,
          episodeId: requireValue(episodeId ?? '', '找不到批准请求所属的 Episode，请刷新页面后重试。'),
        })
      }
      void requireHost()
        .actions['host.refresh']()
        .catch(() => undefined)
    },
    stopAuthoringTask: async (taskId, expectedRevision) => {
      await requireHost().actions['authoring.stop']({
        taskId: requireValue(taskId, '缺少创造任务标识，请刷新页面后重试。'),
        expectedRevision,
      })
    },
    deleteAuthoringTask: async (taskId) => {
      await requireHost().actions['authoring.delete']({
        taskId: requireValue(taskId, '缺少创造任务标识，请刷新页面后重试。'),
      })
    },
    saveDynamicExtension: async ({
      taskId,
      attemptId,
      agentId,
      episodeId,
      pluginId,
      packageId,
      name,
      slug,
      description,
      targetExtensionId,
    }) => {
      const result = await requireHost().actions['extensions.saveFromDynamic']({
        ...(taskId !== undefined && attemptId !== undefined
          ? { taskId, attemptId }
          : {
              agentId: requireValue(agentId, '缺少智能体标识，请刷新页面后重试。'),
              episodeId: requireValue(episodeId, '缺少 Episode 标识，请刷新页面后重试。'),
              pluginId: requireValue(pluginId, '缺少 Plugin 标识，请刷新页面后重试。'),
              packageId: requireValue(packageId, '缺少 Package 标识，请刷新页面后重试。'),
            }),
        name: requireValue(name, '请输入本地扩展名称。'),
        slug: requireValue(slug, '请输入本地扩展标识。'),
        description,
        ...(targetExtensionId === undefined ? {} : { targetExtensionId }),
      })
      return { extensionId: result['extensionId'], revisionId: result['revisionId'] }
    },
    setExtensionActive: async (id, agentId, enabled, selectedRevisionId) => {
      const extensionId = requireValue(id, '缺少本地扩展标识，请刷新页面后重试。')
      const targetAgentId = requireValue(agentId, '缺少目标智能体，请刷新页面后重试。')
      const extension = useProductStore.getState().extensions.find((candidate) => candidate.id === extensionId)
      if (extension === undefined) {
        throw new ProductActionError('missing-prerequisite', '找不到要更新的本地扩展，请刷新页面后重试。')
      }

      if (enabled) {
        const revisionId = requireValue(
          selectedRevisionId ?? extension.revisionId ?? '',
          '此本地扩展缺少可启用版本，请重新保存后重试。',
          'missing-prerequisite',
        )
        await requireHost().actions['extensions.activate']({ extensionId, agentId: targetAgentId, revisionId })
        return
      }
      await requireHost().actions['extensions.deactivate']({
        extensionId,
        agentId: targetAgentId,
      })
    },
    setHostExtensionInstalled: async (id, revisionId, permissionDigest) => {
      const extensionId = requireValue(id, '缺少本地扩展标识，请刷新页面后重试。')
      if (revisionId === null) {
        await requireHost().actions['extensions.uninstall']({ extensionId })
        return
      }
      await requireHost().actions['extensions.install']({
        extensionId,
        revisionId: requireValue(revisionId, '缺少要安装的扩展版本。'),
        ...(permissionDigest === undefined ? {} : { permissionDigest }),
      })
    },
    reportHostExtensionClientDiagnostic: async ({ extensionId, revisionId, status, message }) => {
      await requireHost().actions['extensions.hostClientDiagnostic']({
        extensionId: requireValue(extensionId, '缺少扩展标识。'),
        revisionId: requireValue(revisionId, '缺少扩展版本。'),
        status,
        ...(message === undefined ? {} : { message }),
      })
    },
    callExtensionClient: async ({ agentId, extensionId, revisionId, method, value }) => {
      const result = await requireHost().actions['extensions.clientCall']({
        agentId: requireValue(agentId, '缺少智能体标识，请刷新页面后重试。'),
        extensionId: requireValue(extensionId, '缺少扩展标识，请刷新页面后重试。'),
        revisionId: requireValue(revisionId, '缺少扩展版本，请刷新页面后重试。'),
        method: requireValue(method, '缺少 RPC 方法，请刷新页面后重试。'),
        ...(value === undefined ? {} : { value: parseJsonValue(value) }),
      })
      return result.value
    },
    reportExtensionClientDiagnostic: async ({ agentId, extensionId, revisionId, status, message }) => {
      await requireHost().actions['extensions.clientDiagnostic']({
        agentId: requireValue(agentId, '缺少智能体标识，请刷新页面后重试。'),
        extensionId: requireValue(extensionId, '缺少扩展标识，请刷新页面后重试。'),
        revisionId: requireValue(revisionId, '缺少扩展版本，请刷新页面后重试。'),
        status,
        ...(message === undefined ? {} : { message }),
      })
    },
    listPlatformUsers: async (input = {}) => {
      const result = await requireHost().actions['platformUsers.list'](input)
      return result
    },
  }))

  const directory = createPlatformUserDirectoryLoader({
    read: (input, signal) => requireHost().actions['platformUsers.list'](input, signal),
    get: () => useProductStore.getState().platformUserDirectory,
    write: (value, facets) =>
      useProductStore.setState({ platformUserDirectory: value, ...(facets ? { platformUserFacets: facets } : {}) }),
  })
  useProductStore.subscribe((state, previous) => {
    if (state.platformUsersRevision !== previous.platformUsersRevision) directory.invalidate()
  })
  const providers = createOwnedHostQuery(
    (signal) => requireHost().actions['settings.providers'](signal),
    (patch) => useProductStore.setState((state) => ({ llmProvidersQuery: { ...state.llmProvidersQuery, ...patch } })),
  )
  const catalog = createOwnedHostQuery(
    (signal) => requireHost().actions['settings.catalog'](signal),
    (patch) => useProductStore.setState((state) => ({ dshCatalogQuery: { ...state.dshCatalogQuery, ...patch } })),
  )
  return useProductStore
}
