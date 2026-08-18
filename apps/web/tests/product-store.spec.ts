import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentIdSchema, ExtensionIdSchema, ExtensionRevisionIdSchema } from '@nekro-nxt/contracts'
import { ProductHostCoordinator } from '../src/product-port.ts'
import { ProductActionError, setActiveProductHost, useProductStore } from '../src/product-store.ts'

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
    connections: [],
    extensions: [],
    approvals: [],
    dynamic: [],
    diagnosticNote: '正在连接 NekroNxt Host…',
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
        },
      ],
      extensions: [
        {
          id: extensionId,
          name: '测试扩展',
          description: '',
          revision: 1,
          activation: '未激活',
          targetAgent: '测试智能体',
          contributions: [],
          revisionId: extensionRevisionId,
          agentId,
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
    })

    await expect(useProductStore.getState().setCapability(agentId, 'dynamicCreation', true)).rejects.toBe(failure)
    await expect(
      useProductStore.getState().resolveApproval({ requestId: 'request-1', agentId, approved: true }),
    ).rejects.toBe(failure)
    await expect(useProductStore.getState().setExtensionActive(extensionId, true)).rejects.toBe(failure)
    expect(execute).toHaveBeenCalledTimes(3)
    expect(useProductStore.getState().agents[0]?.capabilities.dynamicCreation).toBe(false)
    expect(useProductStore.getState().approvals[0]?.state).toBe('等待批准')
    expect(useProductStore.getState().extensions[0]?.activation).toBe('未激活')
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
          activation: '未激活',
          targetAgent: '',
          contributions: [],
        },
      ],
    })

    const missingPrerequisite = await captureRejection(useProductStore.getState().setExtensionActive(extensionId, true))
    expect(missingPrerequisite).toBeInstanceOf(ProductActionError)
    if (!(missingPrerequisite instanceof ProductActionError)) throw new Error('Expected ProductActionError')
    expect(missingPrerequisite.code).toBe('missing-prerequisite')
    expect(missingPrerequisite.message).toContain('缺少目标智能体')
    await expect(
      useProductStore.getState().resolveApproval({ requestId: '', agentId, approved: true }),
    ).rejects.toThrow('缺少批准请求')
    expect(execute).not.toHaveBeenCalled()
  })
})
