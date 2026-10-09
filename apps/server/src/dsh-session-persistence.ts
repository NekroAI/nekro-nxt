import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { SessionEvent, SessionHeader, SessionLogOffset } from '@deepseek-ai/dsh-session'

/** These facts are informational; omitting them never changes model-visible history. */
const IGNORABLE_NXT_EVENTS = new Set([
  'nekro-nxt/image-inspection',
  'nekro-nxt/image-admission',
  'nekro-nxt/image-restoration',
  'nekro-nxt/memory',
])

/** A public Provider adapter; JSONL encoding, validation, locks and recovery remain upstream-owned. */
export class NekroJsonlSessionPersistence extends JsonlSessionPersistence {
  // Live session/event routing bypasses the handle returned by create/open.
  // Both explicit append and routed events use this public durable-write seam.
  override persistBatch(
    header: SessionHeader,
    events: readonly SessionEvent[],
    isMaterialized: boolean,
    inheritedEventCount: SessionLogOffset,
  ): Promise<void> {
    return super.persistBatch(
      header,
      events.map((event) => (IGNORABLE_NXT_EVENTS.has(event.type) ? { ...event, ignorable: true as const } : event)),
      isMaterialized,
      inheritedEventCount,
    )
  }
}
