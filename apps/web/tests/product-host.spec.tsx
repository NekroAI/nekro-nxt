import { AgentIdSchema, ChannelIdSchema, EpisodeIdSchema } from '@nekro-nxt/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runHostRefresh } from '../src/components/product-feedback.js'
import { dynamicClientInventoryVersion } from '../src/dynamic-client-coordinator.js'
import { type DynamicPackageSummary, type ProductSnapshot } from '../src/product-port.js'
import { ProductHostCoordinator, setActiveProductHost, useProductStore, useUiStateStore } from './product-fixture.js'

const browserAgentId = AgentIdSchema.parse('agt_verylongtechnicalid')
const browserChannelId = ChannelIdSchema.parse('chn_webmain')
const browserEpisodeId = EpisodeIdSchema.parse('eps_browser')

beforeEach(() => {
  setActiveProductHost(null)
  useUiStateStore.setState({ theme: 'light', reducedMotion: false })
  useProductStore.setState({
    host: { status: 'initializing', error: null, lastSuccessfulAt: null },
    connectionAdapters: [],
    models: [],
    agents: [],
    channels: [],
    messagesByChannel: {},
    connections: [],
    extensions: [],
    approvals: [],
    dynamic: [],
    diagnosticNote: '',
  })
})
afterEach(() => setActiveProductHost(null))

describe('product host wiring', () => {
  it('reconciles a dynamic Client again when the active Package Run identity changes', () => {
    const current: DynamicPackageSummary = {
      agentId: browserAgentId,
      episodeId: browserEpisodeId,
      pluginId: 'plugin-client',
      packageId: 'package-client',
      status: 'running',
      activeRun: { pluginRunId: 'run-client', packageId: 'package-client' },
      latestRun: {
        pluginRunId: 'run-client',
        packageId: 'package-client',
        mode: 'run',
        status: 'running',
        host: { status: 'absent', waitingFor: [] },
        client: { status: 'running', waitingFor: [] },
      },
      packages: [],
      policy: { turn: 1, consecutiveFailures: 0, repeatedFingerprintCount: 0 },
    }
    const replacement = {
      ...current,
      activeRun: { ...current.activeRun!, pluginRunId: 'run-client-restarted' },
      latestRun: { ...current.latestRun!, pluginRunId: 'run-client-restarted' },
    }
    expect(dynamicClientInventoryVersion([current], current.agentId)).not.toBe(
      dynamicClientInventoryVersion([replacement], current.agentId),
    )
  })

  it('settles reconnect pending state and exposes a rejected refresh as local feedback', async () => {
    const pendingStates: boolean[] = []
    const errors: string[] = []

    await expect(
      runHostRefresh(
        vi.fn(() => Promise.reject(new Error('连接仍不可用'))),
        (pending) => pendingStates.push(pending),
        (message) => errors.push(message),
      ),
    ).resolves.toBeUndefined()

    expect(pendingStates).toEqual([true, false])
    expect(errors).toEqual(['', '连接仍不可用'])
  })

  it('settles reconnect pending state after a successful refresh', async () => {
    const pendingStates: boolean[] = []
    const errors: string[] = []

    await runHostRefresh(
      vi.fn(() => Promise.resolve()),
      (pending) => pendingStates.push(pending),
      (message) => errors.push(message),
    )

    expect(pendingStates).toEqual([true, false])
    expect(errors).toEqual([''])
  })

  it('subscribes the Shell to authoritative Host projections through a narrow Port', () => {
    const state = useProductStore.getState()
    let snapshot: ProductSnapshot = {
      host: state.host,
      connectionAdapters: state.connectionAdapters,
      capabilityAvailability: state.capabilityAvailability,
      models: state.models,
      agents: state.agents,
      channels: state.channels,
      messagesByChannel: state.messagesByChannel,
      channelRuntimes: state.channelRuntimes,
      connections: state.connections,
      archivedConnections: state.archivedConnections,
      extensions: state.extensions,
      platformUsersRevision: state.platformUsersRevision,
      approvals: state.approvals,
      dynamic: state.dynamic,
      notificationSettings: state.notificationSettings,
      diagnosticNote: 'projection-v1',
      workTreeOrder: state.workTreeOrder,
    }
    let listener: (() => void) | undefined
    const coordinator = new ProductHostCoordinator({
      getSnapshot: () => snapshot,
      subscribe: (next) => {
        listener = next
        return () => {
          listener = undefined
        }
      },
      execute: () => Promise.resolve(null),
    })
    coordinator.start()
    expect(useProductStore.getState().diagnosticNote).toBe('projection-v1')
    snapshot = { ...snapshot, diagnosticNote: 'projection-v2' }
    listener?.()
    expect(useProductStore.getState().diagnosticNote).toBe('projection-v2')
    coordinator.dispose()
    expect(listener).toBeUndefined()
  })

  it('propagates a Host send failure so the composer can preserve its draft', async () => {
    const failure = new Error('模型凭据不可用')
    setActiveProductHost({
      getSnapshot: () => {
        const state = useProductStore.getState()
        return {
          host: state.host,
          connectionAdapters: state.connectionAdapters,
          capabilityAvailability: state.capabilityAvailability,
          models: state.models,
          agents: state.agents,
          channels: state.channels,
          messagesByChannel: state.messagesByChannel,
          channelRuntimes: state.channelRuntimes,
          connections: state.connections,
          archivedConnections: state.archivedConnections,
          extensions: state.extensions,
          platformUsersRevision: state.platformUsersRevision,
          approvals: state.approvals,
          dynamic: state.dynamic,
          notificationSettings: state.notificationSettings,
          diagnosticNote: state.diagnosticNote,
          workTreeOrder: state.workTreeOrder,
        }
      },
      subscribe: () => () => undefined,
      execute: (command) => (command === 'channels.sendMessage' ? Promise.reject(failure) : Promise.resolve(null)),
    })

    await expect(useProductStore.getState().sendMessage(browserChannelId, '保留这段草稿')).rejects.toBe(failure)
  })
})
