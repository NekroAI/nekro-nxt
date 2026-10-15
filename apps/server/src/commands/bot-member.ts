import type { ChannelId, ChannelMemberId, ConnectionId } from '@nekro-nxt/contracts'
import type { ChannelEventRecord, CoreService } from '@nekro-nxt/core'

/**
 * The leading mention of a message when it names this connection's own account, so `@bot /help` counts as addressed
 * to this bot. The Adapter may mark the bot's platform user directly (QQ official bots are mentioned by an OpenID
 * that differs from the app id the connection reports), so either that marker or the reported account matches.
 */
export function commandBotMember(
  event: Pick<ChannelEventRecord, 'channelId' | 'parts'>,
  deps: {
    readonly core: Pick<CoreService, 'resolveChannelMemberIdentity'>
    readonly channel: (channelId: ChannelId) => { readonly connectionId: ConnectionId } | undefined
    readonly account: (connectionId: ConnectionId) => string | undefined
  },
): ChannelMemberId | undefined {
  const channel = deps.channel(event.channelId)
  if (!channel) return undefined
  const part = event.parts.find((candidate) => candidate.type !== 'text' || candidate.text.trim() !== '')
  if (part?.type !== 'mention') return undefined
  const identity = deps.core.resolveChannelMemberIdentity(channel.connectionId, event.channelId, part.memberId)
  if (identity === undefined) return undefined
  return identity.self !== undefined || identity.platformUserId === deps.account(channel.connectionId)
    ? part.memberId
    : undefined
}
