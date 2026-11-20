import {
  appendPluginRecord,
  pluginRecordOf,
  type PluginRecordMap,
  type Session,
  type SessionEvent,
  type SessionSeq,
} from '@deepseek-ai/dsh-session'

/**
 * NXT's informational Session records (image inspection, memory activity, request timing, …). They go into the log
 * through DSH's public plugin-record seam: each is written `ignorable` under a `plugin:nekro-nxt/…` type, so the
 * upstream JSONL reader keeps and skips them on resume and they never reach the model-visible surface. Each owning
 * module declares its record in {@link PluginRecordMap}.
 */
export type NxtRecordType = Extract<keyof PluginRecordMap, `plugin:nekro-nxt/${string}`>

/** One committed NXT record with its declared payload. */
export interface NxtRecord<K extends NxtRecordType> {
  readonly type: K
  readonly seq: SessionSeq
  readonly time: number
  readonly data: PluginRecordMap[K]
}

/** Append one NXT record; returns its sequence number. */
export const appendNxtRecord = <K extends NxtRecordType>(
  session: Session,
  type: K,
  data: NoInfer<PluginRecordMap[K]>,
): SessionSeq => appendPluginRecord(session, type, data)

/**
 * Read `event` as the NXT record `type`, or undefined when it is another event. NekroNXT is the only writer of its
 * `plugin:nekro-nxt/…` records and old Sessions are not carried over, so the payload is taken as declared.
 */
export const nxtRecordOf = <K extends NxtRecordType>(event: SessionEvent, type: K): NxtRecord<K> | undefined => {
  const record = pluginRecordOf(event)
  if (record?.type !== type) return undefined
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Only NekroNXT writes this record type.
  return { type, seq: record.seq, time: record.time, data: record.data as PluginRecordMap[K] }
}
