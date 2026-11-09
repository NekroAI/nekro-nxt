import {
  ChannelEventIdSchema,
  ChannelIdSchema,
  ChannelMemberIdSchema,
  ConnectionIdSchema,
  EpisodeIdSchema,
  LogicalMessageIdSchema,
} from '@nekro-nxt/contracts'
import type { EpisodeRecord } from '@nekro-nxt/channel-runtime'
import type { ChannelEventRecord, ChannelRecord } from '@nekro-nxt/core'
import { describe, expect, it } from 'vitest'
import { turnTriggerOf, type TurnTriggerSources } from '../src/turn-trigger.js'

// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- turnTriggerOf reads only the fields given.
const partial = <T>(value: Partial<T>): T => value as T

const channelId = ChannelIdSchema.parse('chn_group')
const alice = ChannelMemberIdSchema.parse('mbr_alice')
const admin = ChannelMemberIdSchema.parse('mbr_admin')
const episodeId = EpisodeIdSchema.parse('eps_turn')

const event = (overrides: Partial<ChannelEventRecord>): ChannelEventRecord => ({
  id: ChannelEventIdSchema.parse('evt_trigger'),
  logicalMessageId: LogicalMessageIdSchema.parse('msg_trigger'),
  channelId,
  kind: 'message-created',
  parts: [{ type: 'text', text: '绑定我的账号' }],
  sourceTimestamp: 1,
  receivedAt: 1,
  dedupeKey: 'trigger',
  searchText: '绑定我的账号',
  ...overrides,
})

const sources = (trigger: ChannelEventRecord): TurnTriggerSources => ({
  repository: {
    getEpisode: () => partial<EpisodeRecord>({ channelId, lastAdmittedEventId: trigger.id }),
    getChannelEvent: (id) => (id === trigger.id ? trigger : undefined),
    getChannel: () =>
      partial<ChannelRecord>({ id: channelId, connectionId: ConnectionIdSchema.parse('con_qq'), kind: 'group' }),
  },
  isAdministrator: (_connectionId, platformUserId) => platformUserId === 'qq-mbr_admin',
  platformUserId: (_connectionId, _channelId, memberId) => `qq-${memberId}`,
})

describe('turnTriggerOf', () => {
  it('names the sender of the message admitted into the turn', () => {
    const trigger = event({ senderMemberId: alice })
    expect(turnTriggerOf(sources(trigger), episodeId)).toEqual({
      event: trigger,
      senderMemberId: alice,
      requester: { kind: 'member', memberId: alice },
    })
  })

  it('recognises an administrator by the platform account behind the member', () => {
    expect(turnTriggerOf(sources(event({ senderMemberId: admin })), episodeId).requester).toEqual({ kind: 'admin' })
  })

  it('answers the member a finished wait was for', () => {
    const trigger = event({ kind: 'control', parts: [], facts: { responseWait: { memberId: alice } } })
    expect(turnTriggerOf(sources(trigger), episodeId)).toMatchObject({
      senderMemberId: alice,
      requester: { kind: 'member', memberId: alice },
    })
  })

  it('treats a turn with nobody behind it as the agent waking up on its own', () => {
    const trigger = event({ kind: 'control', parts: [], facts: { scheduledTask: { id: 'tsk_daily' } } })
    expect(turnTriggerOf(sources(trigger), episodeId).requester).toEqual({ kind: 'self' })
  })
})
