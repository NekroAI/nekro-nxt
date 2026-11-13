import {
  ChannelMemberIdSchema,
  type ChannelId,
  type ChannelMemberId,
  type ConnectionId,
  type EpisodeId,
  type JsonValue,
} from '@nekro-nxt/contracts'
import type { ChannelEventRecord, CoreRepository } from '@nekro-nxt/core'
import type { RuntimeRepository } from '@nekro-nxt/channel-runtime'
import type { ChannelTurnTrigger } from './channel-turn-origin.js'

export type TurnRequester =
  | { readonly kind: 'admin' }
  | { readonly kind: 'member'; readonly memberId: string }
  | { readonly kind: 'self' }
  | { readonly kind: 'unknown' }

export interface TurnTrigger {
  /** The exact event that opened the turn, if its source is known. */
  readonly event?: ChannelEventRecord
  /** Who the turn answers: the event's sender, or the member a finished wait was for. */
  readonly senderMemberId?: ChannelMemberId
  readonly requester: TurnRequester
}

export interface TurnTriggerSources {
  readonly repository: Pick<RuntimeRepository, 'getEpisode'> & Pick<CoreRepository, 'getChannelEvent' | 'getChannel'>
  readonly internalConnectionId: ConnectionId
  readonly isAdministrator: (connectionId: ConnectionId, platformUserId: string) => boolean
  readonly platformUserId: (
    connectionId: ConnectionId,
    channelId: ChannelId,
    memberId: ChannelMemberId,
  ) => string | undefined
}

const responseWaitMember = (facts: Readonly<Record<string, JsonValue>> | undefined): ChannelMemberId | undefined => {
  const wait = facts?.['responseWait']
  if (wait === null || wait === undefined || typeof wait !== 'object' || Array.isArray(wait)) return undefined
  const memberId = ChannelMemberIdSchema.safeParse(wait['memberId'])
  return memberId.success ? memberId.data : undefined
}

/**
 * What started one turn and who asked for it. Extension governance decides from it whether a request came from an
 * administrator, and extensions read it as `context.current().trigger`, so both judge the same sender.
 */
export const turnTriggerOf = (
  sources: TurnTriggerSources,
  episodeId: EpisodeId,
  origin: ChannelTurnTrigger,
): TurnTrigger => {
  if (origin.kind !== 'channel-event') return { requester: { kind: origin.kind } }
  const { repository } = sources
  const episode = repository.getEpisode(episodeId)
  const event = repository.getChannelEvent(origin.eventId)
  const channel = episode === undefined ? undefined : repository.getChannel(episode.channelId)
  if (episode === undefined || channel === undefined || event?.channelId !== episode.channelId) {
    return { requester: { kind: 'unknown' } }
  }
  // A finished wait has no sender of its own; the turn answers the member the agent was waiting for.
  const senderMemberId = event?.senderMemberId ?? responseWaitMember(event?.facts)
  const found = {
    ...(event === undefined ? {} : { event }),
    ...(senderMemberId === undefined ? {} : { senderMemberId }),
  }
  // The built-in channel and the console speak for an administrator.
  if (
    (channel.kind === 'internal' &&
      channel.connectionId === sources.internalConnectionId &&
      event.kind === 'message-created') ||
    event.facts?.['consoleAnchor'] === true
  ) {
    return { ...found, requester: { kind: 'admin' } }
  }
  if (senderMemberId === undefined) {
    return {
      requester: {
        kind: event.kind === 'control' && event.facts?.['extensionJob'] !== undefined ? 'self' : 'unknown',
      },
    }
  }
  const platformUserId = sources.platformUserId(channel.connectionId, channel.id, senderMemberId)
  if (platformUserId === undefined) return { requester: { kind: 'unknown' } }
  const administrator = sources.isAdministrator(channel.connectionId, platformUserId)
  return { ...found, requester: administrator ? { kind: 'admin' } : { kind: 'member', memberId: senderMemberId } }
}
