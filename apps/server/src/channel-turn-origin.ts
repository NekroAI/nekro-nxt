import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { ChannelEventIdSchema, type ChannelEventId } from '@nekro-nxt/contracts'
import { z } from 'zod'

/** The provenance of a model turn; an unknown origin cannot confer requester authority. */
export type ChannelTurnTrigger =
  | { readonly kind: 'channel-event'; readonly eventId: ChannelEventId }
  | { readonly kind: 'self' }
  | { readonly kind: 'unknown' }

const SourceSchema = z.object({
  kind: z.string(),
  admissionMode: z.enum(['followup', 'inject']).optional(),
  triggerEventId: ChannelEventIdSchema.optional(),
})

const wakeSource = (source: unknown): ChannelTurnTrigger | undefined => {
  const parsed = SourceSchema.safeParse(source)
  if (!parsed.success) return { kind: 'unknown' }
  if (parsed.data.kind === 'nekro-nxt-channel') {
    if (parsed.data.admissionMode === 'inject') return undefined
    return parsed.data.admissionMode === 'followup' && parsed.data.triggerEventId !== undefined
      ? { kind: 'channel-event', eventId: parsed.data.triggerEventId }
      : { kind: 'unknown' }
  }
  if (['nekro-nxt-authoring-event', 'nekro-nxt-host-event', 'nekro-nxt-memory-review'].includes(parsed.data.kind)) {
    return { kind: 'self' }
  }
  return parsed.data.kind === 'user' ? { kind: 'unknown' } : undefined
}

/** Public DSH logs the claimed first-step inputs after turn/start, before the first step/end. */
const sourcesForTurn = (events: readonly SessionEvent[], turn: number): readonly unknown[] => {
  const start = events.findLastIndex((event) => event.type === 'turn/start' && event.data.turn === turn)
  if (start < 0) return []
  const sources: unknown[] = []
  for (let index = start; index < events.length; index += 1) {
    const event = events[index]!
    if (index > start && (event.type === 'turn/start' || event.type === 'turn/end' || event.type === 'step/end')) break
    if (event.type === 'user/message') sources.push(event.data.source)
  }
  return sources
}

/** Host-owned wake provenance shared by requester checks and extension context. */
export class ChannelTurnOrigin {
  #turn: number | undefined
  #trigger: ChannelTurnTrigger = { kind: 'unknown' }

  begin(turn: number, messages: readonly { readonly source?: unknown }[], events: readonly SessionEvent[] = []): void {
    if (turn === this.#turn) return
    this.#turn = turn
    const incoming = messages.flatMap(({ source }) => {
      const wake = wakeSource(source)
      return wake === undefined ? [] : [wake]
    })
    const logged = sourcesForTurn(events, turn).flatMap((source) => {
      const wake = wakeSource(source)
      return wake === undefined ? [] : [wake]
    })
    const wakes = logged.length > 0 ? logged : incoming
    // Host notifications accompany an external followup; they cannot replace or grant its requester identity.
    const requesters = wakes.filter((wake) => wake.kind !== 'self')
    const origins = requesters.length === 0 ? wakes : requesters
    const unique = new Map(origins.map((wake) => [wake.kind === 'channel-event' ? wake.eventId : wake.kind, wake]))
    this.#trigger = unique.size === 1 ? [...unique.values()][0]! : { kind: 'unknown' }
  }

  restore(turn: number, events: readonly SessionEvent[]): void {
    if (sourcesForTurn(events, turn).length > 0) this.begin(turn, [], events)
  }

  current(turn?: number): ChannelTurnTrigger {
    if (turn !== undefined && this.#turn !== turn) return { kind: 'unknown' }
    return { ...this.#trigger }
  }
}
