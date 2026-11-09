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
const internalConnectionId = ConnectionIdSchema.parse('con_internal')

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
  internalConnectionId,
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
    expect(turnTriggerOf(sources(trigger), episodeId, { kind: 'channel-event', eventId: trigger.id })).toEqual({
      event: trigger,
      senderMemberId: alice,
      requester: { kind: 'member', memberId: alice },
    })
  })

  it('recognises an administrator by the platform account behind the member', () => {
    const trigger = event({ senderMemberId: admin })
    expect(
      turnTriggerOf(sources(trigger), episodeId, { kind: 'channel-event', eventId: trigger.id }).requester,
    ).toEqual({
      kind: 'admin',
    })
  })

  it('answers the member a finished wait was for', () => {
    const trigger = event({ kind: 'control', parts: [], facts: { responseWait: { memberId: alice } } })
    expect(turnTriggerOf(sources(trigger), episodeId, { kind: 'channel-event', eventId: trigger.id })).toMatchObject({
      senderMemberId: alice,
      requester: { kind: 'member', memberId: alice },
    })
  })

  it('treats a turn with nobody behind it as the agent waking up on its own', () => {
    const trigger = event({ kind: 'control', parts: [], facts: { scheduledTask: { id: 'tsk_daily' } } })
    expect(turnTriggerOf(sources(trigger), episodeId, { kind: 'self' })).toEqual({ requester: { kind: 'self' } })
  })

  it('continues an admitted extension job as self work and rejects other senderless events', () => {
    const jobFacts = { extensionJob: { jobId: 'job_fixture' } }
    const job = event({ kind: 'control', parts: [], facts: jobFacts })
    const origin = { kind: 'channel-event', eventId: job.id } as const
    expect(turnTriggerOf(sources(job), episodeId, origin)).toEqual({ requester: { kind: 'self' } })
    const ordinary = event({ facts: jobFacts })
    expect(turnTriggerOf(sources(ordinary), episodeId, origin)).toEqual({ requester: { kind: 'unknown' } })
    const control = event({ kind: 'control', parts: [] })
    expect(turnTriggerOf(sources(control), episodeId, origin)).toEqual({ requester: { kind: 'unknown' } })
  })

  it('keeps the original sender when a later admission advances the episode cursor', () => {
    const trigger = event({ senderMemberId: alice })
    const injected = event({ id: ChannelEventIdSchema.parse('evt_injected'), senderMemberId: admin })
    const facts = sources(trigger)
    let cursor = trigger.id
    facts.repository.getEpisode = () => partial<EpisodeRecord>({ channelId, lastAdmittedEventId: cursor })
    facts.repository.getChannelEvent = (id) => (id === trigger.id ? trigger : id === injected.id ? injected : undefined)
    const origin = { kind: 'channel-event', eventId: trigger.id } as const
    expect(turnTriggerOf(facts, episodeId, origin).requester).toEqual({ kind: 'member', memberId: alice })
    cursor = injected.id
    expect(turnTriggerOf(facts, episodeId, origin)).toEqual({
      event: trigger,
      senderMemberId: alice,
      requester: { kind: 'member', memberId: alice },
    })
  })

  it('grants no authority from an internal channel when the turn origin is unknown', () => {
    const trigger = event({ senderMemberId: admin })
    const facts = sources(trigger)
    facts.repository.getChannel = () =>
      partial<ChannelRecord>({ id: channelId, connectionId: internalConnectionId, kind: 'internal' })
    expect(turnTriggerOf(facts, episodeId, { kind: 'unknown' })).toEqual({ requester: { kind: 'unknown' } })
    expect(turnTriggerOf(facts, episodeId, { kind: 'self' })).toEqual({ requester: { kind: 'self' } })
  })

  it('recognises only the host-owned internal connection as an administrator channel', () => {
    const trigger = event({ senderMemberId: alice })
    const facts = sources(trigger)
    facts.repository.getChannel = () =>
      partial<ChannelRecord>({ id: channelId, connectionId: ConnectionIdSchema.parse('con_other'), kind: 'internal' })
    const origin = { kind: 'channel-event', eventId: trigger.id } as const
    expect(turnTriggerOf(facts, episodeId, origin).requester).toEqual({ kind: 'member', memberId: alice })
    facts.repository.getChannel = () =>
      partial<ChannelRecord>({ id: channelId, connectionId: internalConnectionId, kind: 'internal' })
    expect(turnTriggerOf(facts, episodeId, origin).requester).toEqual({ kind: 'admin' })
  })

  it('does not project an event from another channel or an unresolved platform identity', () => {
    const trigger = event({ senderMemberId: alice })
    const facts = sources(trigger)
    const origin = { kind: 'channel-event', eventId: trigger.id } as const
    expect(turnTriggerOf({ ...facts, platformUserId: () => undefined }, episodeId, origin)).toEqual({
      requester: { kind: 'unknown' },
    })
    const crossed = sources(event({ channelId: ChannelIdSchema.parse('chn_other'), senderMemberId: admin }))
    expect(turnTriggerOf(crossed, episodeId, origin)).toEqual({ requester: { kind: 'unknown' } })
  })
})
