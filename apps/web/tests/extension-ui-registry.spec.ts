import { EMPTY_EXTENSION_UI_CONTRIBUTIONS, type ExtensionUiContributions } from '@nekro-nxt/contracts'
import { describe, expect, it } from 'vitest'
import { ContributionRegistry, type ContributionOwner } from '../src/extension-ui/registry.ts'
import { panelsForAnchor } from '../src/extension-ui/slots.tsx'

const Component = () => null

const extensionOwner = (extensionId = 'ext_synthetic'): Extract<ContributionOwner, { kind: 'extension' }> => ({
  kind: 'extension',
  key: `extension:${extensionId}`,
  label: '合成扩展',
  extensionId,
  revisionId: 'xrv_synthetic',
  styleScope: 'a'.repeat(64),
})

const adapterOwner: ContributionOwner = {
  ...extensionOwner('ext_chat'),
  label: '合成适配器',
  adapterKey: 'synthetic-chat',
  revisionId: 'xrv_chat',
  styleScope: 'b'.repeat(64),
}

const dynamicOwner: ContributionOwner = {
  kind: 'dynamic',
  key: 'dynamic:agt_preview:plugin_synthetic',
  label: '合成预览',
  agentId: 'agt_preview',
  pluginId: 'plugin_synthetic',
  styleScope: 'c'.repeat(64),
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
      messageRenderers: ['synthetic.card'],
    })
    const owner = extensionOwner()
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
    registry.addMessageRenderer(owner, 'synthetic.card', Component, manifest)
    expect(() => registry.addMessageRenderer(owner, 'synthetic.other', Component, manifest)).toThrow(
      '未在扩展声明中出现',
    )
    expect(() => registry.addMessageRenderer(owner, 'synthetic.card', Component, manifest)).toThrow('重复注册')
    expect(registry.registeredBy(owner.key)).toEqual({
      panels: ['summary'],
      toolViews: ['project_status'],
      messageRenderers: ['synthetic.card'],
    })
  })

  it('allows one extension to combine agent, connection and message contributions', () => {
    const registry = new ContributionRegistry()
    const manifest = declared({
      panels: [
        { kind: 'panel', id: 'status', anchor: 'connection', title: '状态', densities: ['full'], role: 'status' },
        { kind: 'panel', id: 'card', anchor: 'agent', title: '卡片', densities: ['full'] },
      ],
      toolViews: ['project_status'],
      messageRenderers: ['synthetic.card'],
    })
    for (const panel of manifest.panels) {
      const declaration = Object.fromEntries(Object.entries(panel).filter(([key]) => key !== 'kind'))
      registry.addPanel(adapterOwner, declaration, Component, manifest)
    }
    registry.addToolView(adapterOwner, 'project_status', Component, manifest)
    registry.addMessageRenderer(adapterOwner, 'synthetic.card', Component, manifest)
    expect(registry.registeredBy(adapterOwner.key)).toEqual({
      panels: ['status', 'card'],
      toolViews: ['project_status'],
      messageRenderers: ['synthetic.card'],
    })
  })

  it('removes everything one owner registered and notifies subscribers', () => {
    const registry = new ContributionRegistry()
    let notified = 0
    registry.subscribe(() => (notified += 1))
    const owner = extensionOwner()
    const dispose = registry.addPanel(
      owner,
      { id: 'summary', anchor: 'agent', title: '摘要', densities: ['full'] },
      Component,
    )
    registry.addToolView(owner, 'project_status', Component)
    registry.addMessageRenderer(owner, 'synthetic.card', Component)
    registry.removeOwner(owner.key)
    expect(registry.panels()).toEqual([])
    expect(registry.toolViews()).toEqual([])
    expect(registry.messageRenderers()).toEqual([])
    dispose()
    expect(notified).toBe(4)
  })
})

describe('panel placement', () => {
  const registry = new ContributionRegistry()
  const owner = extensionOwner()
  registry.addPanel(owner, { id: 'summary', anchor: 'agent', title: '摘要', densities: ['full', 'compact'] }, Component)
  registry.addPanel(
    owner,
    { id: 'inspector', anchor: 'channel', title: '检查', densities: ['compact'], when: { channelKinds: ['group'] } },
    Component,
  )
  registry.addPanel(owner, { id: 'info', anchor: 'extension', title: '扩展信息', densities: ['full'] }, Component)
  registry.addPanel(dynamicOwner, { id: 'preview', anchor: 'agent', title: '预览', densities: ['full'] }, Component)
  registry.addPanel(
    dynamicOwner,
    { id: 'preview-channel', anchor: 'channel', title: '预览频道', densities: ['compact'] },
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
  const attached = (extensionId: string, agentId: string) =>
    extensionId === 'ext_synthetic' && ['agt_alpha', 'agt_gamma'].includes(agentId)
  const context = { attached }
  const ids = (entries: ReturnType<typeof panelsForAnchor>) => entries.map((entry) => entry.key)

  it('shows a single registered agent panel on each attached agent in the declared density', () => {
    for (const agentId of ['agt_alpha', 'agt_gamma']) {
      expect(ids(panelsForAnchor(panels, { kind: 'agent', id: agentId }, 'full', context))).toEqual([
        'extension:ext_synthetic\0summary',
      ])
    }
    expect(panelsForAnchor(panels, { kind: 'agent', id: 'agt_beta' }, 'full', context)).toEqual([])
    expect(panelsForAnchor(panels, { kind: 'agent', id: 'agt_preview' }, 'compact', context)).toEqual([])
  })

  it('follows live attachments without registering the Client again', () => {
    const enabledAgents = new Set<string>()
    const live = {
      attached: (extensionId: string, agentId: string) => extensionId === 'ext_synthetic' && enabledAgents.has(agentId),
    }
    const anchor = { kind: 'agent' as const, id: 'agt_beta' }
    const version = registry.version()
    expect(panelsForAnchor(panels, anchor, 'full', live)).toEqual([])
    enabledAgents.add('agt_beta')
    expect(ids(panelsForAnchor(panels, anchor, 'full', live))).toEqual(['extension:ext_synthetic\0summary'])
    enabledAgents.delete('agt_beta')
    expect(panelsForAnchor(panels, anchor, 'full', live)).toEqual([])
    expect(registry.version()).toBe(version)
  })

  it('places channel panels by responding agent, adapter and channel kind', () => {
    const group = panelsForAnchor(panels, { kind: 'channel', id: 'chn_1' }, 'compact', {
      ...context,
      channelAgentId: 'agt_alpha',
      channelKind: 'group',
      adapterKey: 'synthetic-chat',
    })
    expect(ids(group)).toEqual(['extension:ext_synthetic\0inspector', 'extension:ext_chat\0channel'])
    const direct = panelsForAnchor(panels, { kind: 'channel', id: 'chn_2' }, 'compact', {
      ...context,
      channelAgentId: 'agt_alpha',
      channelKind: 'direct',
    })
    expect(direct).toEqual([])
    expect(
      ids(
        panelsForAnchor(panels, { kind: 'channel', id: 'chn_3' }, 'compact', {
          ...context,
          channelAgentId: 'agt_beta',
          adapterKey: 'synthetic-chat',
        }),
      ),
    ).toEqual(['extension:ext_chat\0channel'])
  })

  it('shows one extension panel and optionally filters it by an attached agent', () => {
    const anchor = { kind: 'extension' as const, id: 'ext_synthetic' }
    expect(ids(panelsForAnchor(panels, anchor, 'full', context))).toEqual(['extension:ext_synthetic\0info'])
    expect(ids(panelsForAnchor(panels, anchor, 'full', context, { agentId: 'agt_gamma' }))).toEqual([
      'extension:ext_synthetic\0info',
    ])
    expect(panelsForAnchor(panels, anchor, 'full', context, { agentId: 'agt_beta' })).toEqual([])
    expect(panelsForAnchor(panels, { kind: 'extension', id: 'ext_other' }, 'full', context)).toEqual([])
  })

  it('keeps dynamic previews on their creating agent and channel without installation', () => {
    const detached = { attached: () => false }
    expect(ids(panelsForAnchor(panels, { kind: 'agent', id: 'agt_preview' }, 'full', detached))).toEqual([
      'dynamic:agt_preview:plugin_synthetic\0preview',
    ])
    expect(
      ids(
        panelsForAnchor(panels, { kind: 'channel', id: 'chn_preview' }, 'compact', {
          ...detached,
          channelAgentId: 'agt_preview',
        }),
      ),
    ).toEqual(['dynamic:agt_preview:plugin_synthetic\0preview-channel'])
    expect(panelsForAnchor(panels, { kind: 'agent', id: 'agt_other' }, 'full', detached)).toEqual([])
  })

  it('filters connection panels by Adapter and role', () => {
    const connectionContext = { ...context, adapterKey: 'synthetic-chat' }
    expect(
      ids(
        panelsForAnchor(panels, { kind: 'connection', id: 'synthetic-chat' }, 'full', connectionContext, {
          role: 'setup',
        }),
      ),
    ).toEqual(['extension:ext_chat\0setup'])
    expect(
      panelsForAnchor(panels, { kind: 'connection', id: 'con_1' }, 'full', connectionContext, { role: 'status' }),
    ).toEqual([])
    expect(
      panelsForAnchor(panels, { kind: 'connection', id: 'con_other' }, 'full', {
        ...context,
        adapterKey: 'other-chat',
      }),
    ).toEqual([])
  })
})
