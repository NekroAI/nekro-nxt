import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EpisodeIdSchema,
  LogicalMessageIdSchema,
  OutboundIntentIdSchema,
  PhysicalDeliveryIdSchema,
  type JsonValue,
} from '@nekro-nxt/contracts'
import { CoreService } from '@nekro-nxt/core'
import { openMigratedCoreDatabase, OutboundResolutionError, SqliteCoreRepository } from '../src/index.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const fixture = async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nxt-projections-'))
  directories.push(directory)
  const database = await openMigratedCoreDatabase(path.join(directory, 'core.sqlite'))
  const repository = new SqliteCoreRepository(database)
  let sequence = 0
  const core = new CoreService(repository, {
    now: () => 10,
    nextUlid: () => `PRJ${String(++sequence).padStart(8, '0')}`,
  })
  const agent = core.createAgent({ displayName: '投影样本', persona: '', model: { provider: 'fake', model: 'fake' } })
  const connection = core.createConnection({ adapterKey: 'fixture-alpha', config: {} })
  const channel = core.createChannel({ connectionId: connection.id, platformChannelId: 'group-a', kind: 'group' })
  const other = core.createChannel({ connectionId: connection.id, platformChannelId: 'group-b', kind: 'group' })
  const member = core.observeChannelMember({
    connectionId: connection.id,
    channelId: channel.id,
    platformUserId: 'member-a',
    displayName: '阿青',
    observedAt: 10,
  }).member
  const append = (
    key: string,
    receivedAt: number,
    options: { readonly facts?: Readonly<Record<string, JsonValue>>; readonly anonymous?: boolean } = {},
  ) =>
    core.appendInbound({
      connectionId: connection.id,
      channelId: channel.id,
      adapterKey: 'fixture-alpha',
      kind: 'message-created',
      parts: [{ type: 'text', text: key }],
      platformTimestamp: receivedAt,
      receivedAt,
      dedupeKey: key,
      ...(options.anonymous === true ? {} : { senderMemberId: member.id }),
      ...(options.facts === undefined ? {} : { facts: options.facts }),
    }).event
  const opening = append('opening', 100)
  const episodeId = EpisodeIdSchema.parse('eps_PROJECTION')
  repository.createEpisode({
    id: episodeId,
    channelId: channel.id,
    agentId: agent.definition.id,
    agentRevisionId: agent.revision.id,
    status: 'opening',
    openedAtEventId: opening.id,
    createdAt: 100,
  })
  repository.activateEpisode(episodeId, 'projection-session')
  let outboundSequence = 0
  const outbound = (createdAt: number, deliveryStates: readonly ('sent' | 'failed' | 'unknown')[]) => {
    const suffix = String(++outboundSequence).padStart(4, '0')
    const intentId = OutboundIntentIdSchema.parse(`out_PRJ${suffix}`)
    repository.createOutboundPlan(
      {
        id: intentId,
        logicalMessageId: LogicalMessageIdSchema.parse(`msg_PRJ${suffix}`),
        agentRevisionId: agent.revision.id,
        episodeId,
        parts: [{ type: 'text', text: `回复 ${suffix}` }],
        state: 'planned',
        createdAt,
      },
      deliveryStates.map((_, index) => ({
        id: PhysicalDeliveryIdSchema.parse(`phy_PRJ${suffix}${index}`),
        intentId,
        sequence: index,
        parts: [{ type: 'text', text: `回复 ${suffix}` }],
        state: 'planned',
      })),
    )
    repository.markIntentSending(intentId)
    deliveryStates.forEach((state, index) => {
      const deliveryId = PhysicalDeliveryIdSchema.parse(`phy_PRJ${suffix}${index}`)
      repository.markDeliverySending(deliveryId)
      repository.recordDeliveryReceipt(
        deliveryId,
        state === 'sent'
          ? { status: 'sent', platformMessageId: `platform-${suffix}-${index}` }
          : state === 'failed'
            ? { status: 'failed', failure: { kind: 'transient', message: '平台暂时不可用' } }
            : { status: 'unknown', message: '没有收到回执' },
        createdAt + 1,
      )
    })
    const sent = deliveryStates.filter((state) => state === 'sent').length
    repository.completeOutboundIntent(
      intentId,
      sent === deliveryStates.length
        ? 'sent'
        : sent > 0
          ? 'partially-sent'
          : deliveryStates.includes('unknown')
            ? 'unknown'
            : 'failed',
    )
    return intentId
  }
  return { database, repository, core, agent, channel, other, append, outbound, episodeId }
}

describe('client workspace projections', () => {
  it('counts unread member messages after the viewer baseline and only moves cursors forward', async () => {
    const { database, repository, channel, append } = await fixture()
    try {
      const projections = repository.projections
      const createdAt = projections.ensureReadViewer('local', 150)
      expect(projections.ensureReadViewer('local', 999)).toBe(150)
      append('before-viewer', 140)
      const first = append('first-unread', 160)
      append('console-anchor', 161, { facts: { consoleAnchor: true } })
      append('self-echo', 162, { facts: { selfInteraction: true } })
      append('system-notice', 163, { anonymous: true })
      const second = append('second-unread', 170)
      const baseline = { readAt: createdAt, readSourceId: '' }
      expect(projections.countUnreadMemberMessages(channel.id, baseline, 99)).toEqual({ count: 2, capped: false })
      expect(projections.countUnreadMemberMessages(channel.id, baseline, 1)).toEqual({ count: 1, capped: true })

      projections.advanceChannelReadPosition(
        'local',
        channel.id,
        { readAt: second.receivedAt, readSourceId: second.id },
        200,
      )
      const stale = projections.advanceChannelReadPosition(
        'local',
        channel.id,
        { readAt: first.receivedAt, readSourceId: first.id },
        201,
      )
      expect(stale).toEqual({ readAt: second.receivedAt, readSourceId: second.id })
      expect(projections.listChannelReadPositions('local').get(channel.id)).toEqual(stale)
      expect(projections.countUnreadMemberMessages(channel.id, stale, 99)).toEqual({ count: 0, capped: false })
      expect(projections.listChannelReadPositions('device:other').size).toBe(0)
      expect(projections.getLatestMemberMessage(channel.id)?.id).toBe(second.id)
    } finally {
      database.close()
    }
  })

  it('buckets member and outbound activity per channel inside the window', async () => {
    const { database, repository, channel, other, append, outbound } = await fixture()
    try {
      append('in-window-a', 1_000)
      append('in-window-b', 1_400)
      append('outside', 2_100)
      append('hidden', 1_100, { facts: { consoleAnchor: true } })
      outbound(1_900, ['sent'])
      const counts = repository.projections.countChannelActivity(1_000, 2_000, 500)
      expect(counts.get(channel.id)).toEqual(
        new Map([
          [0, 2],
          [1, 1],
        ]),
      )
      expect(counts.get(other.id)).toBeUndefined()
      expect(repository.projections.getLatestOutbound(channel.id)?.createdAt).toBe(1_900)
    } finally {
      database.close()
    }
  })

  it('stores agent appearance outside immutable revisions and clears it', async () => {
    const { database, repository, core, agent } = await fixture()
    try {
      expect(core.updateAgentAppearance(agent.definition.id, { hue: 271 })).toEqual({ hue: 271 })
      expect(repository.getAgent(agent.definition.id)?.definition.appearance).toEqual({ hue: 271 })
      expect(repository.getAgent(agent.definition.id)?.revision.id).toBe(agent.revision.id)
      expect(() => core.updateAgentAppearance(agent.definition.id, { hue: 360 })).toThrow('0 and 359')
      expect(core.updateAgentAppearance(agent.definition.id, { hue: null })).toEqual({})
      expect(repository.getAgent(agent.definition.id)?.definition.appearance).toBeUndefined()
    } finally {
      database.close()
    }
  })

  it('persists and prunes attention dismissals', async () => {
    const { database, repository } = await fixture()
    try {
      repository.projections.dismissAttention('old', 10, 0)
      repository.projections.dismissAttention('new', 500, 100)
      expect([...repository.projections.listAttentionDismissals()]).toEqual(['new'])
      repository.projections.dismissAttention('new', 600, 100)
      expect(repository.projections.listAttentionDismissals().size).toBe(1)
    } finally {
      database.close()
    }
  })

  it('records administrator resolutions without losing the original receipts', async () => {
    const { database, repository, outbound } = await fixture()
    try {
      const sent = outbound(300, ['sent'])
      const unknown = outbound(310, ['sent', 'unknown'])
      const failed = outbound(320, ['failed'])
      expect(
        repository.projections
          .listUnsettledAttentionOutbounds(0, 10)
          .map(({ intent, resolutionCount }) => [intent.id, intent.state, resolutionCount]),
      ).toEqual([
        [failed, 'failed', 0],
        [unknown, 'partially-sent', 0],
      ])
      expect(() =>
        repository.projections.resolveOutbound({
          id: 'ores_SENT',
          intentId: sent,
          action: 'retry',
          viewerKey: 'local',
          now: 400,
        }),
      ).toThrow(OutboundResolutionError)

      const retry = repository.projections.resolveOutbound({
        id: 'ores_RETRY',
        intentId: unknown,
        action: 'retry',
        viewerKey: 'local',
        now: 401,
      })
      expect(retry.previousState).toBe('partially-sent')
      expect(retry.previousDeliveries).toMatchObject([
        { sequence: 0, state: 'sent' },
        { sequence: 1, state: 'unknown', resultMessage: '没有收到回执' },
      ])
      const retried = repository.getOutbound(unknown)
      expect(retried.intent.state).toBe('planned')
      expect(retried.deliveries.map(({ state }) => state)).toEqual(['sent', 'planned'])
      expect(repository.listUnsettledOutboundIds()).toContain(unknown)
      expect(() =>
        repository.projections.resolveOutbound({
          id: 'ores_RETRY_AGAIN',
          intentId: unknown,
          action: 'retry',
          viewerKey: 'local',
          now: 402,
        }),
      ).toThrow('这条消息当前不需要处理。')

      repository.projections.resolveOutbound({
        id: 'ores_CONFIRM',
        intentId: failed,
        action: 'confirm-delivered',
        viewerKey: 'device:nxt_device_A',
        now: 403,
      })
      expect(repository.getOutbound(failed).intent.state).toBe('failed')
      expect(repository.projections.getLatestOutboundResolution(failed)?.action).toBe('confirm-delivered')
      expect(() =>
        repository.projections.resolveOutbound({
          id: 'ores_CONFIRM_AGAIN',
          intentId: failed,
          action: 'retry',
          viewerKey: 'local',
          now: 404,
        }),
      ).toThrow('这条消息已确认送达。')
      expect(repository.projections.listUnsettledAttentionOutbounds(0, 10)).toEqual([])
    } finally {
      database.close()
    }
  })
})
