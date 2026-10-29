import { describe, expect, it } from 'vitest'
import {
  UNBOUND_GROUP_ID,
  keepHiddenSlots,
  movePinnedChannel,
  pinChannel,
  toggleGroupCollapsed,
  unpinChannel,
} from '../src/app/model/channel-list-view.js'

const empty = { pinnedChannelIds: [], collapsedGroupIds: [] }

describe('channel list view', () => {
  it('pins to the end once and unpins', () => {
    const pinned = pinChannel(pinChannel(empty, 'chn_a'), 'chn_b')
    expect(pinned.pinnedChannelIds).toEqual(['chn_a', 'chn_b'])
    expect(pinChannel(pinned, 'chn_a')).toBe(pinned)
    expect(unpinChannel(pinned, 'chn_a').pinnedChannelIds).toEqual(['chn_b'])
  })

  it('moves a pinned channel and ignores moves past either end', () => {
    const view = { ...empty, pinnedChannelIds: ['chn_a', 'chn_b', 'chn_c'] }
    expect(movePinnedChannel(view, 'chn_c', 0).pinnedChannelIds).toEqual(['chn_c', 'chn_a', 'chn_b'])
    expect(movePinnedChannel(view, 'chn_a', 1).pinnedChannelIds).toEqual(['chn_b', 'chn_a', 'chn_c'])
    expect(movePinnedChannel(view, 'chn_a', -1)).toBe(view)
    expect(movePinnedChannel(view, 'chn_c', 3)).toBe(view)
    expect(movePinnedChannel(view, 'chn_missing', 0)).toBe(view)
  })

  it('toggles a collapsed group', () => {
    const collapsed = toggleGroupCollapsed(empty, UNBOUND_GROUP_ID)
    expect(collapsed.collapsedGroupIds).toEqual(['unbound'])
    expect(toggleGroupCollapsed(collapsed, UNBOUND_GROUP_ID).collapsedGroupIds).toEqual([])
  })

  it('keeps hidden rows in their slots when the visible rows are reordered', () => {
    expect(keepHiddenSlots(['a', 'pin', 'b', 'c'], ['c', 'a', 'b'], new Set(['pin']))).toEqual(['c', 'pin', 'a', 'b'])
    expect(keepHiddenSlots(['a', 'b'], ['b', 'a', 'new'], new Set())).toEqual(['b', 'a', 'new'])
  })
})
