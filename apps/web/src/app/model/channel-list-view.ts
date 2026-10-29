import { UNBOUND_CHANNEL_GROUP_ID } from '@nekro-nxt/contracts'

/** Group key of 「未接线」 in the saved collapsed groups; agent groups use the agent id. */
export const UNBOUND_GROUP_ID: string = UNBOUND_CHANNEL_GROUP_ID

export type ChannelListView = {
  readonly pinnedChannelIds: readonly string[]
  readonly collapsedGroupIds: readonly string[]
}

export const pinChannel = (view: ChannelListView, channelId: string): ChannelListView =>
  view.pinnedChannelIds.includes(channelId)
    ? view
    : { ...view, pinnedChannelIds: [...view.pinnedChannelIds, channelId] }

export const unpinChannel = (view: ChannelListView, channelId: string): ChannelListView => ({
  ...view,
  pinnedChannelIds: view.pinnedChannelIds.filter((id) => id !== channelId),
})

/** Moves a pinned channel to `to` within the pinned order; out-of-range targets leave the view unchanged. */
export const movePinnedChannel = (view: ChannelListView, channelId: string, to: number): ChannelListView => {
  const from = view.pinnedChannelIds.indexOf(channelId)
  if (from < 0 || to < 0 || to >= view.pinnedChannelIds.length || from === to) return view
  const next = [...view.pinnedChannelIds]
  next.splice(from, 1)
  next.splice(to, 0, channelId)
  return { ...view, pinnedChannelIds: next }
}

export const toggleGroupCollapsed = (view: ChannelListView, groupId: string): ChannelListView => ({
  ...view,
  collapsedGroupIds: view.collapsedGroupIds.includes(groupId)
    ? view.collapsedGroupIds.filter((id) => id !== groupId)
    : [...view.collapsedGroupIds, groupId],
})

/**
 * Writes a reordered list of the visible rows back into the full order, leaving each hidden (pinned) row in the slot
 * it held, so unpinning returns a channel to where it was in its group.
 */
export const keepHiddenSlots = (
  full: readonly string[],
  visibleOrder: readonly string[],
  hidden: ReadonlySet<string>,
): string[] => {
  let next = 0
  const merged = full.map((id) => (hidden.has(id) ? id : (visibleOrder[next++] ?? id)))
  return [...merged, ...visibleOrder.slice(next)]
}
