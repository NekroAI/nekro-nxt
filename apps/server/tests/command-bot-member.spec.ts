import { describe, expect, it } from 'vitest'
import { CoreService } from '@nekro-nxt/core'
import { openMigratedCoreDatabase, SqliteCoreRepository } from '@nekro-nxt/storage-sqlite'
import { commandBotMember } from '../src/commands/bot-member.js'

const setup = async () => {
  const repository = new SqliteCoreRepository(await openMigratedCoreDatabase(':memory:'))
  let sequence = 0
  const core = new CoreService(repository, { now: () => 1000, nextUlid: () => String(++sequence).padStart(8, '0') })
  const connection = core.createConnection({ adapterKey: 'fake', config: {} })
  const channel = core.createChannel({ connectionId: connection.id, platformChannelId: 'group-one', kind: 'group' })
  const observe = (platformUserId: string, self?: boolean) =>
    core.observeChannelMember({
      connectionId: connection.id,
      channelId: channel.id,
      observedAt: 1000,
      platformUserId,
      ...(self === undefined ? {} : { self }),
    }).member.id
  const deps = (account: string | undefined) => ({
    core,
    channel: (id: typeof channel.id) => repository.getChannel(id),
    account: () => account,
  })
  return { channel, observe, deps }
}

describe('commandBotMember', () => {
  it('recognizes the bot by the member the Adapter marked as itself, whatever the connection reports', async () => {
    const { channel, observe, deps } = await setup()
    // A QQ official bot: the connection reports its app id, while mentions carry its OpenID.
    const bot = observe('openid-of-bot', true)
    const event = {
      channelId: channel.id,
      parts: [
        { type: 'mention' as const, memberId: bot },
        { type: 'text' as const, text: ' /help' },
      ],
    }
    expect(commandBotMember(event, deps('app-id'))).toBe(bot)
  })

  it('recognizes the bot by the account the connection reports and ignores mentions of other members', async () => {
    const { channel, observe, deps } = await setup()
    const bot = observe('bot-account')
    const member = observe('member-one')
    const mention = (memberId: typeof bot) => ({
      channelId: channel.id,
      parts: [
        { type: 'mention' as const, memberId },
        { type: 'text' as const, text: ' /help' },
      ],
    })
    expect(commandBotMember(mention(bot), deps('bot-account'))).toBe(bot)
    expect(commandBotMember(mention(member), deps('bot-account'))).toBeUndefined()
    expect(
      commandBotMember({ channelId: channel.id, parts: [{ type: 'text', text: '/help' }] }, deps('bot-account')),
    ).toBeUndefined()
  })
})
