import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { SessionEvent, SessionHeader, SessionLogOffset } from '@deepseek-ai/dsh-session'

/** These facts are informational; omitting them never changes model-visible history. */
const IGNORABLE_NXT_EVENTS = new Set([
  'nekro-nxt/image-inspection',
  'nekro-nxt/image-admission',
  'nekro-nxt/image-restoration',
  'nekro-nxt/memory',
])

/**
 * Candidate verification runs the Agent's `run_code` from host code, outside any turn, and DSH logs each sub-call
 * as `tool/ptc-dispatch*`. The format only accepts those inside an open turn, so a cold read of such a log fails
 * and the whole Session cannot resume. Until verification runs in its own conversation, its sub-calls are kept as
 * NXT's own ignorable record (same seq and time) instead.
 */
const VERIFICATION_CALL_PREFIX = 'verify-'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** A candidate-verification sub-call, kept as it was logged (`type` is the original DSH event type). */
    'nekro-nxt/verification-dispatch': {
      readonly type: 'tool/ptc-dispatch-start' | 'tool/ptc-dispatch'
      readonly data: SessionEventMap['tool/ptc-dispatch-start'] | SessionEventMap['tool/ptc-dispatch']
    }
  }
}

const persistedForm = (event: SessionEvent): SessionEvent => {
  if (
    (event.type === 'tool/ptc-dispatch-start' || event.type === 'tool/ptc-dispatch') &&
    String(event.data.rootCallId).startsWith(VERIFICATION_CALL_PREFIX)
  ) {
    // An event type outside DSH's own map is only accepted when ignorable.
    return {
      type: 'nekro-nxt/verification-dispatch',
      seq: event.seq,
      time: event.time,
      data: { type: event.type, data: event.data },
      ignorable: true,
    }
  }
  return IGNORABLE_NXT_EVENTS.has(event.type) ? { ...event, ignorable: true as const } : event
}

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
    return super.persistBatch(header, events.map(persistedForm), isMaterialized, inheritedEventCount)
  }
}
