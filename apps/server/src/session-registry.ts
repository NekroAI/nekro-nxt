import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { AgentRevisionRecord } from '@nekro-nxt/core'
import type { ChannelId, EpisodeId } from '@nekro-nxt/contracts'

export interface OwnedSession<Dynamic> {
  readonly sessionId: string
  readonly revision: AgentRevisionRecord
  readonly channelId: ChannelId
  readonly episodeId: EpisodeId
  handle?: AgentHandle
  dynamic?: Dynamic
  imageInput: boolean
}

/** One lifetime record owns all product identity and optional resources of a DSH Session. */
export class SessionRegistry<Dynamic> {
  readonly #sessions = new Map<string, OwnedSession<Dynamic>>()

  register(
    identity: Pick<OwnedSession<Dynamic>, 'sessionId' | 'revision' | 'channelId' | 'episodeId'>,
  ): OwnedSession<Dynamic> {
    if (this.#sessions.has(identity.sessionId))
      throw new Error(`DSH Session is already registered: ${identity.sessionId}`)
    const record: OwnedSession<Dynamic> = { ...identity, imageInput: false }
    this.#sessions.set(identity.sessionId, record)
    return record
  }

  get(sessionId: string): OwnedSession<Dynamic> | undefined {
    return this.#sessions.get(sessionId)
  }

  require(sessionId: string): OwnedSession<Dynamic> {
    const record = this.get(sessionId)
    if (!record) throw new Error(`DSH Session is no longer registered: ${sessionId}`)
    return record
  }

  remove(sessionId: string, expected?: OwnedSession<Dynamic>): void {
    if (expected !== undefined && this.get(sessionId) !== expected) return
    this.#sessions.delete(sessionId)
  }

  records(): IterableIterator<OwnedSession<Dynamic>> {
    return this.#sessions.values()
  }

  *handles(): IterableIterator<[string, AgentHandle]> {
    for (const record of this.records()) if (record.handle !== undefined) yield [record.sessionId, record.handle]
  }

  clear(): void {
    this.#sessions.clear()
  }
}
