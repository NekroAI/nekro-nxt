import { describe, expect, it } from 'vitest'
import {
  UNBOUND_DROP_ID,
  agentSortId,
  applyWorkTreeDragResolution,
  buildWorkTree,
  channelSortId,
  orderByIds,
  pickWorkTreeCollision,
  resolveWorkTreeDragEnd,
} from '../src/shell/work-tree-order.js'

describe('orderByIds', () => {
  it('applies preferred ids then appends newcomers', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    expect(orderByIds(items, ['c', 'missing', 'a']).map((item) => item.id)).toEqual(['c', 'a', 'b'])
  })
})

describe('buildWorkTree', () => {
  it('keeps idle agents in the saved order instead of moving them to the end', () => {
    const tree = buildWorkTree(
      [{ id: 'agt_a' }, { id: 'agt_idle' }, { id: 'agt_c' }],
      [
        { id: 'chn_a', agentId: 'agt_a' },
        { id: 'chn_c', agentId: 'agt_c' },
        { id: 'chn_free', agentId: '' },
      ],
      {
        agentIds: ['agt_a', 'agt_idle', 'agt_c'],
        channelIdsByAgent: { agt_a: ['chn_a'], agt_c: ['chn_c'] },
        unboundChannelIds: ['chn_free'],
      },
    )
    expect(tree.agents.map((group) => group.agent.id)).toEqual(['agt_a', 'agt_idle', 'agt_c'])
    expect(tree.agents[1]?.channels).toEqual([])
    expect(tree.unbound.map((item) => item.id)).toEqual(['chn_free'])
  })
})

const lists = {
  agentIds: ['agt_a', 'agt_idle', 'agt_b'],
  channelIdsByAgent: {
    agt_a: ['chn_a1', 'chn_a2'],
    agt_b: ['chn_b1'],
  },
  unboundChannelIds: ['chn_free1', 'chn_free2'],
  channelAgentId: {
    chn_a1: 'agt_a',
    chn_a2: 'agt_a',
    chn_b1: 'agt_b',
    chn_free1: '',
    chn_free2: '',
  },
}

describe('resolveWorkTreeDragEnd', () => {
  it('reorders channels in the same agent and ignores a drop on the owning header', () => {
    expect(
      resolveWorkTreeDragEnd({
        activeId: channelSortId('chn_a1'),
        overId: channelSortId('chn_a2'),
        lists,
      }),
    ).toEqual({
      kind: 'reorder-agent-channels',
      agentId: 'agt_a',
      channelIds: ['chn_a2', 'chn_a1'],
    })
    expect(
      resolveWorkTreeDragEnd({
        activeId: channelSortId('chn_a1'),
        overId: agentSortId('agt_a'),
        lists,
      }),
    ).toEqual({ kind: 'none' })
  })

  it('reorders unbound channels and agents without opening a bind change', () => {
    expect(
      resolveWorkTreeDragEnd({
        activeId: channelSortId('chn_free2'),
        overId: channelSortId('chn_free1'),
        lists,
      }),
    ).toEqual({ kind: 'reorder-unbound', channelIds: ['chn_free2', 'chn_free1'] })
    expect(
      resolveWorkTreeDragEnd({
        activeId: agentSortId('agt_a'),
        overId: agentSortId('agt_b'),
        lists,
      }),
    ).toEqual({ kind: 'reorder-agents', agentIds: ['agt_idle', 'agt_b', 'agt_a'] })
  })

  it('proposes bind, replace and unbind only when the drop leaves the current group', () => {
    expect(
      resolveWorkTreeDragEnd({
        activeId: channelSortId('chn_free1'),
        overId: agentSortId('agt_b'),
        lists,
      }),
    ).toEqual({ kind: 'bind', channelId: 'chn_free1', agentId: 'agt_b' })
    expect(
      resolveWorkTreeDragEnd({
        activeId: channelSortId('chn_a1'),
        overId: channelSortId('chn_b1'),
        lists,
      }),
    ).toEqual({ kind: 'replace', channelId: 'chn_a1', agentId: 'agt_b' })
    expect(
      resolveWorkTreeDragEnd({
        activeId: channelSortId('chn_a1'),
        overId: UNBOUND_DROP_ID,
        lists,
      }),
    ).toEqual({ kind: 'unbind', channelId: 'chn_a1' })
  })
})

describe('pickWorkTreeCollision', () => {
  const owners = lists.channelAgentId

  it('prefers the same-list channel and maps a foreign channel to that agent instead of shuffling it', () => {
    expect(
      pickWorkTreeCollision({
        activeId: channelSortId('chn_a1'),
        pointerHits: [channelSortId('chn_a2'), agentSortId('agt_a')],
        channelOwnerById: owners,
      }),
    ).toBe(channelSortId('chn_a2'))
    expect(
      pickWorkTreeCollision({
        activeId: channelSortId('chn_a1'),
        pointerHits: [channelSortId('chn_b1'), agentSortId('agt_b')],
        channelOwnerById: owners,
      }),
    ).toBe(agentSortId('agt_b'))
  })

  it('does not let an agent drag collide with nested channels', () => {
    expect(
      pickWorkTreeCollision({
        activeId: agentSortId('agt_a'),
        pointerHits: [channelSortId('chn_b1'), agentSortId('agt_b')],
        channelOwnerById: owners,
      }),
    ).toBe(agentSortId('agt_b'))
  })
})

describe('applyWorkTreeDragResolution', () => {
  it('writes only the changed order slice', () => {
    const order = {
      agentIds: ['agt_a', 'agt_b'],
      channelIdsByAgent: { agt_a: ['chn_a1', 'chn_a2'] },
      unboundChannelIds: ['chn_free1'],
    }
    expect(
      applyWorkTreeDragResolution(order, {
        kind: 'reorder-agent-channels',
        agentId: 'agt_a',
        channelIds: ['chn_a2', 'chn_a1'],
      })?.channelIdsByAgent,
    ).toEqual({ agt_a: ['chn_a2', 'chn_a1'] })
    expect(applyWorkTreeDragResolution(order, { kind: 'none' })).toBeUndefined()
  })
})
