import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import type { EpisodeCloseReason } from '@nekro-nxt/channel-runtime'
import type { JsonValue } from '@nekro-nxt/contracts'
import type { SystemSettingRecord } from '@nekro-nxt/storage-sqlite'
import { z } from 'zod'

/**
 * Written by the Desktop data-directory move into the new data root. DSH session directories are keyed by the old
 * workspace path, so instead of resuming them every channel's next message hands off to a new session with a summary.
 */
export const DATA_ROOT_MOVED_MARKER = path.join('host', 'data-root-moved.json')
export const DataRootMovedMarkerSchema = z
  .object({ format: z.literal('nxt.data-root-moved'), version: z.literal(1), movedAt: z.number().int().nonnegative() })
  .strict()

const SETTING_KEY = 'host.data-root-move.pending-rollover'
const PendingSchema = z.object({ version: z.literal(1), episodeIds: z.array(z.string()) }).strict()
/** The old episode closes as "session storage changed", the same fact an archived legacy store records. */
const ROLLOVER_REASON: EpisodeCloseReason = 'incompatible-session-storage'

export interface PendingRolloverStore {
  getSystemSetting(key: string): SystemSettingRecord | undefined
  putSystemSetting(key: string, value: JsonValue, expectedRevision: number | undefined, updatedAt: number): unknown
  listRecoverableEpisodes(): readonly { readonly id: string }[]
}

export interface DataRootMoveRollover {
  readonly reasonFor: (episode: { readonly id: string }) => EpisodeCloseReason | undefined
  readonly settle: (episodeId: string) => void
  /** Episodes still waiting for their next message; for tests and diagnostics. */
  readonly pending: () => readonly string[]
}

const readPending = (store: PendingRolloverStore): Set<string> => {
  const value = store.getSystemSetting(SETTING_KEY)?.value
  const parsed = PendingSchema.safeParse(value)
  return new Set(parsed.success ? parsed.data.episodeIds : [])
}

const writePending = (store: PendingRolloverStore, ids: ReadonlySet<string>, now: number): void => {
  const current = store.getSystemSetting(SETTING_KEY)
  store.putSystemSetting(SETTING_KEY, { version: 1, episodeIds: [...ids].sort() }, current?.revision, now)
}

/**
 * Turns a move marker into a durable list of the episodes that were live at the move, then removes the marker. The
 * list survives restarts until each channel has rolled over; ids of episodes that ended some other way are dropped.
 */
export const prepareDataRootMoveRollover = async (input: {
  readonly dataRoot: string
  readonly store: PendingRolloverStore
  readonly now: () => number
}): Promise<DataRootMoveRollover> => {
  const { store, now } = input
  const markerPath = path.join(input.dataRoot, DATA_ROOT_MOVED_MARKER)
  const live = new Set<string>(store.listRecoverableEpisodes().map((episode) => episode.id))
  const pending = readPending(store)
  let marker: z.output<typeof DataRootMovedMarkerSchema> | undefined
  try {
    marker = DataRootMovedMarkerSchema.parse(JSON.parse(await readFile(markerPath, 'utf8')))
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      console.error('[nekro-nxt] 数据目录迁移标记无法读取，按已迁移处理：', error)
      marker = { format: 'nxt.data-root-moved', version: 1, movedAt: now() }
    }
  }
  if (marker !== undefined) for (const id of live) pending.add(id)
  for (const id of [...pending]) if (!live.has(id)) pending.delete(id)
  const stored = readPending(store)
  if (stored.size !== pending.size || [...pending].some((id) => !stored.has(id))) writePending(store, pending, now())
  if (marker !== undefined) {
    await rm(markerPath, { force: true })
    console.info(`[nekro-nxt] 数据目录已迁移，${pending.size} 个对话将在下一条消息时整理摘要并开新会话。`)
  }
  return {
    reasonFor: (episode) => (pending.has(episode.id) ? ROLLOVER_REASON : undefined),
    settle: (episodeId) => {
      if (!pending.delete(episodeId)) return
      writePending(store, pending, now())
    },
    pending: () => [...pending],
  }
}
