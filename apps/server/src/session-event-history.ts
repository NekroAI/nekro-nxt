import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import '@deepseek-ai/dsh-session-persistence'

interface History {
  readonly events: Map<number, SessionEvent>
  snapshot?: readonly SessionEvent[]
}
const histories = new WeakMap<Session, History>()
const historyFor = (session: Session): History => {
  let history = histories.get(session)
  if (!history) {
    history = { events: new Map() }
    histories.set(session, history)
  }
  return history
}

/** A disposable read projection, never a second durable Session source. */
export const sessionEvents = (session: Session): readonly SessionEvent[] => {
  const history = historyFor(session)
  history.snapshot ??= Object.freeze([...history.events.values()].sort((left, right) => left.seq - right.seq))
  return history.snapshot
}

/** Restore once through the public async storage handle, then follow committed events. */
export function mountSessionEventHistory(context: Context): void {
  context.on('session/event', (session, event) => {
    const history = historyFor(session)
    history.events.set(event.seq, event)
    delete history.snapshot
  })
  context.on('agent/created', async ({ agent }) => {
    await context.sessions.flush(agent.session)
    const handle = await context.sessionPersistence.open(agent.id, 'read')
    try {
      const history = historyFor(agent.session)
      for (const event of (await handle.read()).events) history.events.set(event.seq, event)
      delete history.snapshot
    } finally {
      await handle.close()
    }
    return undefined
  })
  context.on('session/disposed', (session) => {
    histories.delete(session)
  })
}
