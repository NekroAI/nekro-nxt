export const AGENT_SORT_PREFIX = 'agent:'
export const CHANNEL_SORT_PREFIX = 'channel:'
export const UNBOUND_DROP_ID = 'drop:unbound'

export const agentSortId = (id: string): string => `${AGENT_SORT_PREFIX}${id}`
export const channelSortId = (id: string): string => `${CHANNEL_SORT_PREFIX}${id}`

export const parsePrefixedId = (value: string, prefix: string): string | undefined =>
  value.startsWith(prefix) ? value.slice(prefix.length) : undefined

export const orderByIds = <T extends { readonly id: string }>(
  items: readonly T[],
  preferred: readonly string[],
): T[] => {
  const remaining = new Map(items.map((item) => [item.id, item]))
  const ordered: T[] = []
  for (const id of preferred) {
    const item = remaining.get(id)
    if (!item) continue
    ordered.push(item)
    remaining.delete(id)
  }
  for (const item of items) {
    if (remaining.has(item.id)) ordered.push(item)
  }
  return ordered
}

export const arrayMoveIds = (items: readonly string[], from: number, to: number): string[] => {
  if (from < 0 || to < 0 || from === to) return [...items]
  const next = [...items]
  const [moved] = next.splice(from, 1)
  if (moved === undefined) return [...items]
  next.splice(to, 0, moved)
  return next
}

export type WorkTreeOrderInput = {
  readonly agentIds: readonly string[]
  readonly channelIdsByAgent: Readonly<Record<string, readonly string[]>>
  readonly unboundChannelIds: readonly string[]
}

export type WorkTreeAgentGroup<A, C> = {
  readonly agent: A
  readonly channels: C[]
}

export const buildWorkTree = <
  A extends { readonly id: string },
  C extends { readonly id: string; readonly agentId: string },
>(
  agents: readonly A[],
  channels: readonly C[],
  order: WorkTreeOrderInput,
): { readonly agents: WorkTreeAgentGroup<A, C>[]; readonly unbound: C[] } => {
  const orderedAgents = orderByIds(agents, order.agentIds)
  const boundIds = new Set<string>()
  const groups = orderedAgents.map((agent) => {
    const items = orderByIds(
      channels.filter((item) => item.agentId === agent.id),
      order.channelIdsByAgent[agent.id] ?? [],
    )
    for (const item of items) boundIds.add(item.id)
    return { agent, channels: items }
  })
  return {
    agents: groups,
    unbound: orderByIds(
      channels.filter((item) => !boundIds.has(item.id)),
      order.unboundChannelIds,
    ),
  }
}

export type WorkTreeDragLists = {
  readonly agentIds: readonly string[]
  readonly channelIdsByAgent: Readonly<Record<string, readonly string[]>>
  readonly unboundChannelIds: readonly string[]
  readonly channelAgentId: Readonly<Record<string, string>>
}

export type WorkTreeDragResolution =
  | { readonly kind: 'none' }
  | { readonly kind: 'reorder-agents'; readonly agentIds: readonly string[] }
  | { readonly kind: 'reorder-agent-channels'; readonly agentId: string; readonly channelIds: readonly string[] }
  | { readonly kind: 'reorder-unbound'; readonly channelIds: readonly string[] }
  | { readonly kind: 'bind'; readonly channelId: string; readonly agentId: string }
  | { readonly kind: 'replace'; readonly channelId: string; readonly agentId: string }
  | { readonly kind: 'unbind'; readonly channelId: string }

const bindOrReplace = (channelId: string, sourceAgentId: string, targetAgentId: string): WorkTreeDragResolution => {
  if (!targetAgentId || targetAgentId === sourceAgentId) return { kind: 'none' }
  return sourceAgentId
    ? { kind: 'replace', channelId, agentId: targetAgentId }
    : { kind: 'bind', channelId, agentId: targetAgentId }
}

export const resolveWorkTreeDragEnd = (input: {
  readonly activeId: string
  readonly overId: string
  readonly lists: WorkTreeDragLists
}): WorkTreeDragResolution => {
  const { activeId, overId, lists } = input
  if (!overId || activeId === overId) return { kind: 'none' }

  const activeAgent = parsePrefixedId(activeId, AGENT_SORT_PREFIX)
  const overAgent = parsePrefixedId(overId, AGENT_SORT_PREFIX)
  if (activeAgent) {
    if (!overAgent) return { kind: 'none' }
    const agentIds = arrayMoveIds(
      lists.agentIds,
      lists.agentIds.indexOf(activeAgent),
      lists.agentIds.indexOf(overAgent),
    )
    return agentIds.join('\0') === lists.agentIds.join('\0') ? { kind: 'none' } : { kind: 'reorder-agents', agentIds }
  }

  const activeChannelId = parsePrefixedId(activeId, CHANNEL_SORT_PREFIX)
  if (!activeChannelId) return { kind: 'none' }
  const sourceAgentId = lists.channelAgentId[activeChannelId] ?? ''

  if (overId === UNBOUND_DROP_ID) {
    return sourceAgentId ? { kind: 'unbind', channelId: activeChannelId } : { kind: 'none' }
  }

  if (overAgent) return bindOrReplace(activeChannelId, sourceAgentId, overAgent)

  const overChannelId = parsePrefixedId(overId, CHANNEL_SORT_PREFIX)
  if (!overChannelId) return { kind: 'none' }
  const overAgentId = lists.channelAgentId[overChannelId] ?? ''

  if (sourceAgentId && overAgentId && sourceAgentId === overAgentId) {
    const ids = lists.channelIdsByAgent[sourceAgentId] ?? []
    const channelIds = arrayMoveIds(ids, ids.indexOf(activeChannelId), ids.indexOf(overChannelId))
    return channelIds.join('\0') === ids.join('\0')
      ? { kind: 'none' }
      : { kind: 'reorder-agent-channels', agentId: sourceAgentId, channelIds }
  }
  if (!sourceAgentId && !overAgentId) {
    const channelIds = arrayMoveIds(
      lists.unboundChannelIds,
      lists.unboundChannelIds.indexOf(activeChannelId),
      lists.unboundChannelIds.indexOf(overChannelId),
    )
    return channelIds.join('\0') === lists.unboundChannelIds.join('\0')
      ? { kind: 'none' }
      : { kind: 'reorder-unbound', channelIds }
  }
  if (overAgentId) return bindOrReplace(activeChannelId, sourceAgentId, overAgentId)
  return sourceAgentId ? { kind: 'unbind', channelId: activeChannelId } : { kind: 'none' }
}

export const pickWorkTreeCollision = (input: {
  readonly activeId: string
  readonly pointerHits: readonly string[]
  readonly channelOwnerById: Readonly<Record<string, string>>
}): string => {
  const { activeId, pointerHits, channelOwnerById } = input
  if (parsePrefixedId(activeId, AGENT_SORT_PREFIX)) {
    return pointerHits.find((id) => parsePrefixedId(id, AGENT_SORT_PREFIX) !== undefined) ?? ''
  }
  const activeChannelId = parsePrefixedId(activeId, CHANNEL_SORT_PREFIX)
  if (!activeChannelId) return ''
  const sourceOwner = channelOwnerById[activeChannelId] ?? ''

  const sameListChannel = pointerHits.find((id) => {
    const channelId = parsePrefixedId(id, CHANNEL_SORT_PREFIX)
    return channelId !== undefined && (channelOwnerById[channelId] ?? '') === sourceOwner
  })
  if (sameListChannel) return sameListChannel

  if (sourceOwner && pointerHits.includes(UNBOUND_DROP_ID)) return UNBOUND_DROP_ID

  for (const id of pointerHits) {
    const channelId = parsePrefixedId(id, CHANNEL_SORT_PREFIX)
    if (!channelId) continue
    const owner = channelOwnerById[channelId] ?? ''
    if (owner === sourceOwner) continue
    return owner ? agentSortId(owner) : UNBOUND_DROP_ID
  }

  const agentHit = pointerHits.find((id) => parsePrefixedId(id, AGENT_SORT_PREFIX) !== undefined)
  if (agentHit) return agentHit
  return pointerHits.includes(UNBOUND_DROP_ID) ? UNBOUND_DROP_ID : ''
}

export const applyWorkTreeDragResolution = (
  order: WorkTreeOrderInput,
  resolution: WorkTreeDragResolution,
): WorkTreeOrderInput | undefined => {
  if (resolution.kind === 'reorder-agents') return { ...order, agentIds: resolution.agentIds }
  if (resolution.kind === 'reorder-unbound') return { ...order, unboundChannelIds: resolution.channelIds }
  if (resolution.kind === 'reorder-agent-channels') {
    return {
      ...order,
      channelIdsByAgent: { ...order.channelIdsByAgent, [resolution.agentId]: resolution.channelIds },
    }
  }
  return undefined
}
