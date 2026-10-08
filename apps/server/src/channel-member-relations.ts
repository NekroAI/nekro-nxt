import type { AgentId, ChannelId } from '@nekro-nxt/contracts'
import type { BindingRecord, CoreRepository, CoreService } from '@nekro-nxt/core'
import type { ChannelMemberRelations } from './session-image-context.js'

/**
 * Who channel members are for the agent answering a channel: its own account, and the accounts of other agents on
 * this host that answer the same platform channel through another connection.
 */
export const channelMemberRelations = (
  core: Pick<CoreService, 'describeChannelMember' | 'ensureSelfChannelMember' | 'localAccountMembers'>,
  repository: Pick<CoreRepository, 'getChannelMember' | 'getBinding'> & {
    getAgent(agentId: AgentId): { readonly revision: { readonly displayName: string } } | undefined
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
      if (relation?.kind !== 'local-account') return { kind: 'member' }
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
