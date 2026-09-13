import {
  AgentIdSchema,
  ChannelIdSchema,
  EpisodeIdSchema,
  ExtensionIdSchema,
  ExtensionRevisionIdSchema,
  HostUiPageEntrySchema,
} from '@nekro-nxt/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hostPresentation, NekroNxtApp, nextVisibleHostUiPage } from '../src/app.js'
import { runHostRefresh } from '../src/components/product-feedback.js'
import { dynamicClientInventoryVersion } from '../src/dynamic-client-coordinator.js'
import { type DynamicPackageSummary, type ProductSnapshot } from '../src/product-port.js'
import { ProductHostCoordinator, setActiveProductHost, useProductStore, useUiStateStore } from './product-fixture.js'
const renderRoute = (route: string): string =>
  renderToStaticMarkup(
    <MemoryRouter initialEntries={[route]}>
      <NekroNxtApp />
    </MemoryRouter>,
  )
const browserAgentId = AgentIdSchema.parse('agt_verylongtechnicalid')
const browserChannelId = ChannelIdSchema.parse('chn_webmain')
const browserExtensionId = ExtensionIdSchema.parse('ext_internal')
const browserExtensionRevisionId = ExtensionRevisionIdSchema.parse('xrv_internal')
const browserEpisodeId = EpisodeIdSchema.parse('eps_browser')
const hostUiPage = (id: string, visible = true) =>
  HostUiPageEntrySchema.parse({
    pageInstanceId: `hup_${id}`,
    owner: { kind: 'extension', extensionId: browserExtensionId, revisionId: browserExtensionRevisionId },
    entryId: id,
    title: id,
    icon: { kind: 'host-icon', name: 'puzzle' },
    objectPane: 'hidden',
    startPath: '',
    visible,
    sortOrder: 0,
    routeBase: `/apps/hup_${id}`,
    client: { moduleUrl: `/host-ui/${id}.mjs`, buildKey: 'a'.repeat(64) },
    createdAt: 1,
    updatedAt: 1,
  })
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
describe('NekroNxt product shell', () => {
  it.each([
    ['initializing', '正在连接', 'info'],
    ['ready', '运行正常', 'success'],
    ['stale', '连接不稳定', 'warning'],
    ['error', '无法连接', 'error'],
  ] as const)('maps Host %s state to an explicit product status', (status, label, tone) => {
    expect(hostPresentation(status)).toEqual({ label, tone })
  })

  it('selects the next visible Host UI page after a hidden or removed current entry', () => {
    const first = hostUiPage('first')
    const second = hostUiPage('second')
    const third = hostUiPage('third')
    const previousOrder = [first, second, third]
    expect(nextVisibleHostUiPage(second, previousOrder, [first, hostUiPage('second', false), third])).toBe(third)
    expect(nextVisibleHostUiPage(second, previousOrder, [first, third])).toBe(third)
    expect(nextVisibleHostUiPage(third, previousOrder, [first, hostUiPage('second', false)])).toBe(first)
  })

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

  it('uses the product navigation order and keeps creator and runtime out of primary navigation', () => {
    const markup = renderRoute('/work/agents/new')
    const navigation = markup.slice(markup.indexOf('<nav'), markup.indexOf('</nav>'))
    expect(navigation.indexOf('工作')).toBeLessThan(navigation.indexOf('连接'))
    expect(navigation.indexOf('连接')).toBeLessThan(navigation.indexOf('扩展'))
    expect(navigation.indexOf('扩展')).toBeLessThan(navigation.indexOf('设置'))
    expect(navigation).not.toContain('Collection')
    expect(navigation).not.toContain('Workbench')
    expect(navigation).not.toContain('Conversation')
    expect(navigation).not.toContain('Configuration')
    expect(navigation).not.toContain('href="/creator"')
    expect(navigation).not.toContain('href="/runtime"')
  })

  it('keeps the local service-instance control out of an ordinary browser shell', () => {
    const markup = renderRoute('/work/agents/new')
    expect(markup).toContain('主题：浅色；切换为深色')
    expect(markup).not.toContain('管理并添加远程服务实例：')
  })

  it('renders the initial intelligent-agent loading state without demo identities or hard-coded health', () => {
    const markup = renderRoute('/work/agents/new')
    expect(markup).toContain('创建智能体')
    expect(markup).toContain('新智能体草稿')
    expect(markup).toContain('正在连接')
    expect(markup).not.toContain('小奈')
    expect(markup).not.toContain('Local Node')
    expect(markup).not.toContain('v0.1')
  })

  it('distinguishes loading across the priority product routes', () => {
    expect(renderRoute('/work/channels/chn_loading')).toContain('正在读取频道')
    expect(renderRoute('/connections')).toContain('正在读取连接')
    expect(renderRoute('/extensions')).toContain('正在读取扩展')
    expect(renderRoute('/settings')).toContain('正在读取模型供应商')
  })

  it('keeps domain-page chrome stable around local content regions', () => {
    const users = renderRoute('/users')
    const userMarkers = [
      'data-page-header=""',
      'data-page-toolbar=""',
      'data-table-header=""',
      'data-table-scroll-region=""',
      'data-table-pagination=""',
    ]
    for (const marker of userMarkers) expect(users).toContain(marker)
    for (let index = 1; index < userMarkers.length; index += 1) {
      expect(users.indexOf(userMarkers[index - 1] ?? '')).toBeLessThan(users.indexOf(userMarkers[index] ?? ''))
    }
    expect(users).toContain('data-empty-state=""')

    for (const [route, page] of [
      ['/extensions', 'extensions'],
      ['/settings', 'settings'],
    ] as const) {
      const markup = renderRoute(route)
      expect(markup).toContain(`data-product-page="${page}"`)
      expect(markup).toContain('data-page-header=""')
      expect(markup).toContain('data-route-transition=""')
      expect(markup.indexOf('data-page-header=""')).toBeLessThan(markup.indexOf('data-route-transition=""'))
    }
    expect(renderRoute('/extensions')).toContain('data-empty-state=""')
  })

  it('keeps direct creator and runtime routes honest when no snapshot data is available', () => {
    const creator = renderRoute('/work/creator')
    const runtime = renderRoute('/runtime')
    expect(creator).toContain('正在读取动态状态')
    expect(runtime).toContain('正在读取')
    expect(runtime).not.toContain('12:45:08')
    expect(runtime).not.toContain('最近备份')
    expect(runtime).not.toContain('SQLite')
  })

  it('keeps model settings product-facing while exposing the separate DSH extension surface', () => {
    const markup = renderRoute('/settings')
    expect(markup).toContain('模型供应商')
    expect(markup).toContain('DSH 扩展')
    expect(markup).not.toContain('Provider ID')
    expect(markup).not.toContain('Revision')
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
