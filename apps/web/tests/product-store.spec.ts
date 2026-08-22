import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentIdSchema, ExtensionIdSchema, ExtensionRevisionIdSchema } from '@nekro-nxt/contracts'
import { ProductHostCoordinator } from '../src/product-port.ts'
import {
  defaultImageUnderstandingPolicy,
  ProductActionError,
  setActiveProductHost,
  useProductStore,
} from '../src/product-store.ts'

const resetBusinessFacts = (): void => {
  setActiveProductHost(null)
  useProductStore.setState({
    host: { status: 'initializing', error: null, lastSuccessfulAt: null },
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
    connectionAdapters: [],
    models: [],
    agents: [],
    channels: [],
    messages: [],
    channelRuntimes: {},
    connections: [],
    extensions: [],
    approvals: [],
    dynamic: [],
    diagnosticNote: '正在连接 NekroNxt Host…',
    workTreeOrder: { agentIds: [], channelIdsByAgent: {}, unboundChannelIds: [] },
  })
}

const captureRejection = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise
    return null
  } catch (cause: unknown) {
    return cause
  }
}

const agentId = AgentIdSchema.parse('agt_store')
const otherAgentId = AgentIdSchema.parse('agt_storeother')
const extensionId = ExtensionIdSchema.parse('ext_store')
const extensionRevisionId = ExtensionRevisionIdSchema.parse('xrv_store')

describe('product store Host mutations', () => {
  afterEach(resetBusinessFacts)

  it('starts without demo business facts', () => {
    const state = useProductStore.getState()
    expect(state.host).toEqual({ status: 'initializing', error: null, lastSuccessfulAt: null })
    expect(state.models).toEqual([])
    expect(state.agents).toEqual([])
    expect(state.channels).toEqual([])
    expect(state.messages).toEqual([])
    expect(state.connections).toEqual([])
    expect(state.extensions).toEqual([])
    expect(state.approvals).toEqual([])
    expect(state.dynamic).toEqual([])
    expect(state.diagnosticNote).not.toContain('正常')
  })

  it('applies Host health state together with the authoritative facts', () => {
    const coordinator = new ProductHostCoordinator({
      getSnapshot: () => ({
        ...useProductStore.getState(),
        host: {
          status: 'error' as const,
          error: { code: 'network' as const, message: 'Host 不可达。' },
          lastSuccessfulAt: null,
        },
        diagnosticNote: 'Host 初始化失败：Host 不可达。',
      }),
      subscribe: () => () => undefined,
      execute: () => Promise.resolve(null),
    })

    coordinator.start()
    expect(useProductStore.getState().host).toEqual({
      status: 'error',
      error: { code: 'network', message: 'Host 不可达。' },
      lastSuccessfulAt: null,
    })
    coordinator.dispose()
  })

  it('updates a system-access preset in one Host mutation', async () => {
    const execute = vi.fn(() => Promise.resolve(null))
    setActiveProductHost({
      getSnapshot: () => useProductStore.getState(),
      subscribe: () => () => undefined,
      execute,
    })

    await useProductStore.getState().setCapabilities(agentId, {
      fileTools: true,
      developmentShell: true,
      unrestrictedFileAccess: false,
    })

    expect(execute).toHaveBeenCalledOnce()
    expect(execute).toHaveBeenCalledWith('agents.updateCapabilities', {
      agentId,
      fileTools: true,
      developmentShell: true,
      unrestrictedFileAccess: false,
    })
  })

  it('returns rejected Promises from capability, approval and Extension mutations', async () => {
    const failure = new Error('Host 拒绝了本次修改。')
    const execute = vi.fn(() => Promise.reject(failure))
    setActiveProductHost({
      getSnapshot: () => useProductStore.getState(),
      subscribe: () => () => undefined,
      execute,
    })
    useProductStore.setState({
      agents: [
        {
          id: agentId,
          name: '测试智能体',
          description: '',
          state: '空闲',
          model: '测试模型',
          personaDocument: { version: 1, segments: [] },
          channels: [],
          extensionCount: 1,
          capabilities: {
            subagents: false,
            fileTools: false,
            webSearch: false,
            dynamicCreation: false,
            developmentShell: false,
            unrestrictedFileAccess: false,
          },
          imagePolicy: defaultImageUnderstandingPolicy(),
          imageDiagnostics: {
            route: { mode: 'unavailable' },
            activeSessions: 0,
            residentImages: 0,
            duplicateImagesSkipped: 0,
            blockers: ['主模型没有声明图片输入能力，且未配置辅助视觉模型。'],
          },
        },
      ],
      extensions: [
        {
          id: extensionId,
          name: '测试扩展',
          description: '',
          revision: 1,
          createdByAgentId: agentId,
          createdByAgent: '测试智能体',
          activations: [],
          contributions: [],
          clientActivations: [],
          clientDiagnostics: [],
          revisionId: extensionRevisionId,
        },
      ],
      approvals: [
        {
          id: 'request-1',
          title: '测试批准',
          purpose: '',
          packageName: 'test-package',
          state: '等待批准',
        },
      ],
      dynamic: [
        {
          agentId,
          episodeId: 'eps_productstore',
          pluginId: 'plugin-productstore',
          packageId: 'package-productstore',
          approvalRequestId: 'request-1',
          status: 'awaiting-approval',
          packages: [],
          policy: { turn: 1, consecutiveFailures: 0, repeatedFingerprintCount: 0 },
        },
      ],
    })

    await expect(useProductStore.getState().setCapability(agentId, 'dynamicCreation', true)).rejects.toBe(failure)
    await expect(
      useProductStore.getState().resolveApproval({ requestId: 'request-1', agentId, approved: true }),
    ).rejects.toBe(failure)
    await expect(useProductStore.getState().setExtensionActive(extensionId, agentId, true)).rejects.toBe(failure)
    expect(execute).toHaveBeenCalledTimes(3)
    expect(useProductStore.getState().agents[0]?.capabilities.dynamicCreation).toBe(false)
    expect(useProductStore.getState().approvals[0]?.state).toBe('等待批准')
    expect(useProductStore.getState().extensions[0]?.activations).toEqual([])
  })

  it('sends Extension activation changes to the explicitly selected intelligent-agent', async () => {
    const execute = vi.fn(() => Promise.resolve(null))
    setActiveProductHost({
      getSnapshot: () => useProductStore.getState(),
      subscribe: () => () => undefined,
      execute,
    })
    useProductStore.setState({
      extensions: [
        {
          id: extensionId,
          name: '共享扩展',
          description: '',
          revision: 2,
          createdByAgentId: agentId,
          createdByAgent: '创建者',
          activations: [],
          contributions: [],
          clientActivations: [],
          clientDiagnostics: [],
          revisionId: extensionRevisionId,
        },
      ],
    })

    await useProductStore.getState().setExtensionActive(extensionId, otherAgentId, true)
    await useProductStore.getState().setExtensionActive(extensionId, otherAgentId, false)

    expect(execute).toHaveBeenNthCalledWith(1, 'extensions.activate', {
      extensionId,
      agentId: otherAgentId,
      revisionId: extensionRevisionId,
    })
    expect(execute).toHaveBeenNthCalledWith(2, 'extensions.deactivate', {
      extensionId,
      agentId: otherAgentId,
    })
  })

  it('rejects missing Host and Extension activation prerequisites instead of mutating locally', async () => {
    const unavailable = await captureRejection(
      useProductStore.getState().setCapability(agentId, 'dynamicCreation', true),
    )
    expect(unavailable).toBeInstanceOf(ProductActionError)
    if (!(unavailable instanceof ProductActionError)) throw new Error('Expected ProductActionError')
    expect(unavailable.code).toBe('host-unavailable')
    expect(unavailable.message).toContain('未连接 NekroNxt Host')
    expect(useProductStore.getState().agents).toEqual([])

    const execute = vi.fn(() => Promise.resolve(null))
    setActiveProductHost({
      getSnapshot: () => useProductStore.getState(),
      subscribe: () => () => undefined,
      execute,
    })
    useProductStore.setState({
      extensions: [
        {
          id: extensionId,
          name: '缺少版本的扩展',
          description: '',
          revision: 1,
          createdByAgent: '',
          activations: [],
          contributions: [],
          clientActivations: [],
          clientDiagnostics: [],
        },
      ],
    })

    const missingTarget = await captureRejection(useProductStore.getState().setExtensionActive(extensionId, '', true))
    expect(missingTarget).toBeInstanceOf(ProductActionError)
    if (!(missingTarget instanceof ProductActionError)) throw new Error('Expected ProductActionError')
    expect(missingTarget.code).toBe('invalid-input')
    expect(missingTarget.message).toContain('缺少目标智能体')

    const missingPrerequisite = await captureRejection(
      useProductStore.getState().setExtensionActive(extensionId, agentId, true),
    )
    expect(missingPrerequisite).toBeInstanceOf(ProductActionError)
    if (!(missingPrerequisite instanceof ProductActionError)) throw new Error('Expected ProductActionError')
    expect(missingPrerequisite.code).toBe('missing-prerequisite')
    expect(missingPrerequisite.message).toContain('缺少可启用版本')
    await expect(
      useProductStore.getState().resolveApproval({ requestId: '', agentId, approved: true }),
    ).rejects.toThrow('缺少批准请求')
    expect(execute).not.toHaveBeenCalled()
  })

  it('applies work tree order immediately and restores it when Host rejects', async () => {
    let rejectHost: ((error: Error) => void) | undefined
    const execute = vi.fn(
      () =>
        new Promise((_resolve, reject) => {
          rejectHost = reject
        }),
    )
    setActiveProductHost({
      getSnapshot: () => useProductStore.getState(),
      subscribe: () => () => undefined,
      execute,
    })
    const next = {
      agentIds: [agentId],
      channelIdsByAgent: { [agentId]: ['chn_a'] },
      unboundChannelIds: ['chn_free'],
    }
    const pending = useProductStore.getState().putWorkTreeOrder(next)
    expect(useProductStore.getState().workTreeOrder).toEqual(next)
    rejectHost?.(new Error('保存工作树顺序失败'))
    await expect(pending).rejects.toThrow('保存工作树顺序失败')
    expect(useProductStore.getState().workTreeOrder).toEqual({
      agentIds: [],
      channelIdsByAgent: {},
      unboundChannelIds: [],
    })
  })

  it('forwards context reset and intelligent-agent deletion with concurrency guards', async () => {
    const execute = vi.fn(() => Promise.resolve(null))
    setActiveProductHost({
      getSnapshot: () => useProductStore.getState(),
      subscribe: () => () => undefined,
      execute,
    })

    await useProductStore.getState().resetChannelContext('chn_context', 'eps_context', 'compact')
    await useProductStore.getState().deleteAgent(agentId, 'arev_context', '测试智能体', true)

    expect(execute).toHaveBeenNthCalledWith(1, 'channels.resetContext', {
      channelId: 'chn_context',
      expectedEpisodeId: 'eps_context',
      mode: 'compact',
    })
    expect(execute).toHaveBeenNthCalledWith(2, 'agents.delete', {
      agentId,
      expectedCurrentRevisionId: 'arev_context',
      confirmationName: '测试智能体',
      deleteAutoCreatedBuiltInChannels: true,
    })
  })
})
