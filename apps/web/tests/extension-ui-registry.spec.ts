import { EMPTY_EXTENSION_UI_CONTRIBUTIONS, type ExtensionUiContributions } from '@nekro-nxt/contracts'
import { describe, expect, it } from 'vitest'
import { ContributionRegistry, type ContributionOwner } from '../src/extension-ui/registry.ts'
import { panelsForAnchor } from '../src/extension-ui/slots.tsx'

const Component = () => null

const agentOwner = (agentId: string, extensionId = 'ext_synthetic'): ContributionOwner => ({
  kind: 'agent',
  key: `agent:${agentId}:${extensionId}`,
  label: '合成扩展',
  agentId,
  extensionId,
  revisionId: 'xrv_synthetic',
  styleScope: 'a'.repeat(64),
})

const adapterOwner: ContributionOwner = {
  kind: 'adapter',
  key: 'adapter:ext_chat',
  label: '合成适配器',
  adapterKey: 'synthetic-chat',
  extensionId: 'ext_chat',
  revisionId: 'xrv_chat',
  styleScope: 'b'.repeat(64),
}

const declared = (patch: Partial<ExtensionUiContributions>): ExtensionUiContributions => ({
  ...EMPTY_EXTENSION_UI_CONTRIBUTIONS,
  ...patch,
})

describe('ContributionRegistry', () => {
  it('accepts only what the Manifest declares and rejects duplicates', () => {
    const registry = new ContributionRegistry()
    const manifest = declared({
      panels: [{ kind: 'panel', id: 'summary', anchor: 'agent', title: '摘要', densities: ['full'] }],
      toolViews: ['project_status'],
    })
    const owner = agentOwner('agt_alpha')
    registry.addPanel(
      owner,
      { id: 'summary', anchor: 'agent', title: '摘要', densities: ['full'] },
      Component,
      manifest,
    )
    expect(() =>
      registry.addPanel(
        owner,
        { id: 'other', anchor: 'agent', title: '其他', densities: ['full'] },
        Component,
        manifest,
      ),
    ).toThrow('未在扩展声明中出现')
    expect(() =>
      registry.addPanel(
        owner,
        { id: 'summary', anchor: 'agent', title: '摘要', densities: ['full'] },
        Component,
        manifest,
      ),
    ).toThrow('重复注册')
    registry.addToolView(owner, 'project_status', Component, manifest)
    expect(() => registry.addToolView(owner, 'unknown_tool', Component, manifest)).toThrow('未在扩展声明中出现')
    expect(registry.registeredBy(owner.key)).toEqual({
      panels: ['summary'],
      toolViews: ['project_status'],
      messageRenderers: [],
    })
  })

  it('enforces scope rules per owner', () => {
    const registry = new ContributionRegistry()
    expect(() =>
      registry.addPanel(
        agentOwner('agt_alpha'),
        { id: 'status', anchor: 'connection', title: '状态', densities: ['full'], role: 'status' },
        Component,
      ),
    ).toThrow('智能体扩展不能贡献连接面板')
    expect(() =>
      registry.addPanel(adapterOwner, { id: 'card', anchor: 'agent', title: '卡片', densities: ['full'] }, Component),
    ).toThrow('适配器扩展只能贡献连接或频道面板')
    expect(() => registry.addToolView(adapterOwner, 'tool', Component)).toThrow('适配器扩展不能贡献工具视图')
    expect(() => registry.addMessageRenderer(agentOwner('agt_alpha'), 'card', Component)).toThrow(
      '智能体扩展不能贡献富消息渲染器',
    )
  })

  it('removes everything one owner registered and notifies subscribers', () => {
    const registry = new ContributionRegistry()
    let notified = 0
    registry.subscribe(() => (notified += 1))
    const owner = agentOwner('agt_alpha')
    const dispose = registry.addPanel(
      owner,
      { id: 'summary', anchor: 'agent', title: '摘要', densities: ['full'] },
      Component,
    )
    registry.addToolView(owner, 'project_status', Component)
    registry.removeOwner(owner.key)
    expect(registry.panels()).toEqual([])
    expect(registry.toolViews()).toEqual([])
    dispose()
    expect(notified).toBe(3)
  })
})

describe('panel placement', () => {
  const registry = new ContributionRegistry()
  registry.addPanel(
    agentOwner('agt_alpha'),
    { id: 'summary', anchor: 'agent', title: '摘要', densities: ['full', 'compact'] },
    Component,
  )
  registry.addPanel(
    agentOwner('agt_alpha'),
    { id: 'inspector', anchor: 'channel', title: '检查', densities: ['compact'], when: { channelKinds: ['group'] } },
    Component,
  )
  registry.addPanel(
    agentOwner('agt_beta'),
    { id: 'summary', anchor: 'extension', title: '扩展信息', densities: ['full'] },
    Component,
  )
  registry.addPanel(
    agentOwner('agt_gamma'),
    { id: 'summary', anchor: 'extension', title: '扩展信息', densities: ['full'] },
    Component,
  )
  registry.addPanel(
    adapterOwner,
    { id: 'setup', anchor: 'connection', title: '准备', densities: ['full'], role: 'setup' },
    Component,
  )
  registry.addPanel(
    adapterOwner,
    { id: 'channel', anchor: 'channel', title: '平台', densities: ['compact'] },
    Component,
  )
  const panels = registry.panels()
  const ids = (entries: ReturnType<typeof panelsForAnchor>) => entries.map((entry) => entry.key)

  it('shows agent panels only on their agent and in the declared density', () => {
    expect(ids(panelsForAnchor(panels, { kind: 'agent', id: 'agt_alpha' }, 'full', {}))).toEqual([
      'agent:agt_alpha:ext_synthetic\0summary',
    ])
    expect(panelsForAnchor(panels, { kind: 'agent', id: 'agt_beta' }, 'full', {})).toEqual([])
  })

  it('places channel panels by responding agent, adapter and channel kind', () => {
    const group = panelsForAnchor(panels, { kind: 'channel', id: 'chn_1' }, 'compact', {
      channelAgentId: 'agt_alpha',
      channelKind: 'group',
      adapterKey: 'synthetic-chat',
    })
    expect(ids(group)).toEqual(['agent:agt_alpha:ext_synthetic\0inspector', 'adapter:ext_chat\0channel'])
    const direct = panelsForAnchor(panels, { kind: 'channel', id: 'chn_2' }, 'compact', {
      channelAgentId: 'agt_alpha',
      channelKind: 'direct',
    })
    expect(direct).toEqual([])
  })

  it('shows an extension panel once, for the requested agent when given', () => {
    expect(panelsForAnchor(panels, { kind: 'extension', id: 'ext_synthetic' }, 'full', {})).toHaveLength(1)
    expect(
      ids(panelsForAnchor(panels, { kind: 'extension', id: 'ext_synthetic' }, 'full', {}, { agentId: 'agt_gamma' })),
    ).toEqual(['agent:agt_gamma:ext_synthetic\0summary'])
  })

  it('filters connection panels by Adapter and role', () => {
    const context = { adapterKey: 'synthetic-chat' }
    expect(
      panelsForAnchor(panels, { kind: 'connection', id: 'synthetic-chat' }, 'full', context, { role: 'setup' }),
    ).toHaveLength(1)
    expect(panelsForAnchor(panels, { kind: 'connection', id: 'con_1' }, 'full', context, { role: 'status' })).toEqual(
      [],
    )
  })
})
