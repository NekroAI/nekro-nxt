import {
  ChannelListViewSchema,
  UNBOUND_CHANNEL_GROUP_ID,
  type ChannelListView,
  type JsonValue,
} from '@nekro-nxt/contracts'

/**
 * The console's channel-list arrangement (pins and collapsed groups). The console has one administrator, so the
 * record is shared by every signed-in device instead of being kept per viewer like read positions.
 */
const SETTING_KEY = 'console.channelListView'

export interface ChannelListViewStore {
  get(key: string): { readonly value: JsonValue; readonly revision: number } | undefined
  put(key: string, value: JsonValue, expectedRevision: number | undefined): void
}

/** Channels and agents that still exist; ids of deleted ones fall out of the view. */
export type ChannelListKnownIds = {
  readonly channelIds: ReadonlySet<string>
  readonly agentIds: ReadonlySet<string>
}

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)]

const normalize = (view: ChannelListView, known: ChannelListKnownIds): ChannelListView => ({
  pinnedChannelIds: unique(view.pinnedChannelIds).filter((id) => known.channelIds.has(id)),
  collapsedGroupIds: unique(view.collapsedGroupIds).filter(
    (id) => id === UNBOUND_CHANNEL_GROUP_ID || known.agentIds.has(id),
  ),
})

export const readChannelListView = (
  settings: Pick<ChannelListViewStore, 'get'>,
  known: ChannelListKnownIds,
): ChannelListView => {
  const parsed = ChannelListViewSchema.safeParse(settings.get(SETTING_KEY)?.value)
  return normalize(parsed.success ? parsed.data : { pinnedChannelIds: [], collapsedGroupIds: [] }, known)
}

export const writeChannelListView = (
  settings: ChannelListViewStore,
  view: ChannelListView,
  known: ChannelListKnownIds,
): ChannelListView => {
  const next = normalize(view, known)
  settings.put(SETTING_KEY, next, settings.get(SETTING_KEY)?.revision)
  return next
}
