import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type {
  SessionAccess,
  SessionHandle,
  SessionPersistenceCreateOptions,
  SessionPersistenceOpenOptions,
} from '@deepseek-ai/dsh-session-persistence'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'

/** These facts are informational; omitting them never changes model-visible history. */
const IGNORABLE_NXT_EVENTS = new Set([
  'nekro-nxt/image-inspection',
  'nekro-nxt/image-admission',
  'nekro-nxt/image-restoration',
])

const markOwnedAuditEvents = (handle: SessionHandle): SessionHandle => ({
  id: handle.id,
  header: handle.header,
  inheritedEventCount: handle.inheritedEventCount,
  access: handle.access,
  read: (offset, length, options) => handle.read(offset, length, options),
  append: (events, options) =>
    handle.append(
      events.map((event) => (IGNORABLE_NXT_EVENTS.has(event.type) ? { ...event, ignorable: true as const } : event)),
      options,
    ),
  flush: (options) => handle.flush(options),
  close: () => handle.close(),
  [Symbol.asyncDispose]: () => handle.close(),
})

/** A public Provider adapter; JSONL encoding, validation, locks and recovery remain upstream-owned. */
export class NekroJsonlSessionPersistence extends JsonlSessionPersistence {
  override async create(header: SessionHeader, options?: SessionPersistenceCreateOptions): Promise<SessionHandle> {
    return markOwnedAuditEvents(await super.create(header, options))
  }

  override async open(
    id: SessionId,
    access: SessionAccess,
    options?: SessionPersistenceOpenOptions,
  ): Promise<SessionHandle> {
    const handle = await super.open(id, access, options)
    return access === 'write' ? markOwnedAuditEvents(handle) : handle
  }
}
