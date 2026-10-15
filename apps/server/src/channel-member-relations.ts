import type { AgentId, ChannelId, ConnectionId } from '@nekro-nxt/contracts'
import type { BindingRecord, CoreRepository, CoreService } from '@nekro-nxt/core'
import type { ChannelMemberRelations } from './session-image-context.js'

/**
 * Who channel members are for the agent answering a channel: its own account, and the accounts of other agents on
 * this host that answer the same platform channel through another connection.
 */
export const channelMemberRelations = (
  core: Pick<
    CoreService,
    'describeChannelMember' | 'ensureSelfChannelMember' | 'localAccountMembers' | 'resolveChannelMemberIdentity'
  >,
  repository: Pick<CoreRepository, 'getChannelMember' | 'getBinding' | 'getChannel'> & {
    getAgent(agentId: AgentId): { readonly revision: { readonly displayName: string } } | undefined
    isInstanceAdministrator?(connectionId: ConnectionId, platformUserId: string): boolean
  },
  now: () => number = Date.now,
): ChannelMemberRelations => {
  const agentName = (binding: BindingRecord | undefined): string | undefined =>
    binding === undefined ? undefined : repository.getAgent(binding.agentId)?.revision.displayName
  return {
    describe: (memberId) => {
      const member = repository.getChannelMember(memberId)
      const relation = member === undefined ? undefined : core.describeChannelMember(member.channelId, memberId)
      if (relation?.kind === 'self') return { kind: 'self' }
      if (relation?.kind !== 'local-account') {
        const channel = member === undefined ? undefined : repository.getChannel(member.channelId)
        const identity =
          channel === undefined ? undefined : core.resolveChannelMemberIdentity(channel.connectionId, channel.id, memberId)
        return channel !== undefined &&
          identity !== undefined &&
          repository.isInstanceAdministrator?.(channel.connectionId, identity.platformUserId) === true
          ? { kind: 'administrator' }
          : { kind: 'member' }
      }
      const name = relation.channelId === undefined ? undefined : agentName(repository.getBinding(relation.channelId))
      return { kind: 'local-agent', ...(name === undefined ? {} : { agentName: name }) }
    },
    self: (channelId: ChannelId) => {
      const member = core.ensureSelfChannelMember(channelId)
      return { memberId: member.id, ...(member.displayName === undefined ? {} : { displayName: member.displayName }) }
    },
    localAgents: (channelId) =>
      core.localAccountMembers(channelId, now()).flatMap(({ channelId: otherChannelId, member }) => {
        const name = agentName(repository.getBinding(otherChannelId))
        return name === undefined
          ? []
          : [
              {
                memberId: member.id,
                ...(member.displayName === undefined ? {} : { displayName: member.displayName }),
                agentName: name,
              },
            ]
      }),
  }
}
