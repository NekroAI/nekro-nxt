import BetterSqlite3 from 'better-sqlite3'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AdmissionIdSchema,
  AssetIdSchema,
  ChannelIdSchema,
  EpisodeHandoffIdSchema,
  EpisodeIdSchema,
  LogicalMessageIdSchema,
  OutboundIntentIdSchema,
  PhysicalDeliveryIdSchema,
  SubConversationIdSchema,
  type AssetId,
} from '@nekro-nxt/contracts'
import { CoreService } from '@nekro-nxt/core'
import { ChannelHistoryPurgeBlockedError, openMigratedCoreDatabase, SqliteCoreRepository } from '../src/index.ts'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const fixture = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-history-purge-'))
  directories.push(directory)
  const filename = path.join(directory, 'core.sqlite')
  const database = await openMigratedCoreDatabase(filename)
  const repository = new SqliteCoreRepository(database)
  let sequence = 0
  const core = new CoreService(repository, { now: () => 1_000 + sequence, nextUlid: () => `P${++sequence}` })
  const connection = core.createConnection({ adapterKey: 'fixture-alpha', config: {} })
  const purged = core.createChannel({ connectionId: connection.id, platformChannelId: 'purged', kind: 'group' })
  const other = core.createChannel({ connectionId: connection.id, platformChannelId: 'other', kind: 'group' })
  const agent = core.createAgent({
    displayName: '清除样例',
    persona: '',
    model: { provider: 'fixture', model: 'fixture' },
  })
  core.createBinding({ channelId: purged.id, agentId: agent.definition.id, triggerPolicy: 'always' })
  const asset = (name: string, digit: string): AssetId => {
    const id = AssetIdSchema.parse(`ast_${name}`)
    repository.ensureAsset({
      id,
      contentDigest: `sha256:${digit.repeat(64)}`,
      byteSize: 4,
      mediaType: 'image/png',
      createdAt: 1,
    })
    return id
  }
  let received = 10
  const append = (channelId: typeof purged.id, text: string, assetId?: AssetId) =>
    core.appendInbound({
      connectionId: connection.id,
      channelId,
      adapterKey: 'fixture-alpha',
      kind: 'message-created',
      parts: assetId === undefined ? [{ type: 'text', text }] : [{ type: 'image', assetId }],
      platformTimestamp: received,
      receivedAt: received++,
      dedupeKey: `${channelId}-${text}`,
      ...(assetId === undefined ? {} : { assetOccurrences: [{ partIndex: 0, assetId }] }),
    }).event
  return { filename, database, repository, core, connection, purged, other, agent, asset, append }
}

describe('channel history purge', () => {
  it('removes history and derived records, keeps configuration and attachments still used elsewhere', async () => {
    const { filename, database, repository, core, purged, other, agent, asset, append } = await fixture()
    try {
      const onlyHere = asset('ONLYHERE', 'a')
      const shared = asset('SHARED', 'b')
      const avatar = asset('AVATAR', 'c')
      const held = asset('HELD', 'd')
      const sent = asset('SENT', 'e')
      const first = append(purged.id, '旧消息 NEEDLE')
      append(purged.id, 'only-here', onlyHere)
      append(purged.id, 'shared', shared)
      append(purged.id, 'avatar', avatar)
      append(purged.id, 'held', held)
      append(other.id, 'shared-elsewhere', shared)
      core.updateAgentAppearance(agent.definition.id, { hue: 120, avatarAssetId: avatar })
      repository.grantAssetAccess({ assetId: sent, channelId: purged.id, source: 'agent-tool', grantedAt: 20 })

      const episodeId = EpisodeIdSchema.parse('eps_PURGEOLD')
      repository.createEpisode({
        id: episodeId,
        channelId: purged.id,
        agentId: agent.definition.id,
        agentRevisionId: agent.revision.id,
        status: 'opening',
        openedAtEventId: first.id,
        createdAt: 21,
      })
      repository.activateEpisode(episodeId, 'dsh-purge-old')
      repository.createAdmission({
        id: AdmissionIdSchema.parse('adm_PURGE1'),
        episodeId,
        eventIds: [first.id],
        mode: 'followup',
        state: 'pending',
        createdAt: 22,
      })
      const nextEpisodeId = EpisodeIdSchema.parse('eps_PURGENEXT')
      repository.commitEpisodeRollover({
        fromEpisodeId: episodeId,
        reason: 'context-compacted',
        closedAtEventId: first.id,
        closedAt: 23,
        nextEpisode: {
          id: nextEpisodeId,
          channelId: purged.id,
          agentId: agent.definition.id,
          agentRevisionId: agent.revision.id,
          status: 'opening',
          openedAtEventId: first.id,
          createdAt: 24,
        },
        handoff: {
          id: EpisodeHandoffIdSchema.parse('hof_PURGE1'),
          fromEpisodeId: episodeId,
          toEpisodeId: nextEpisodeId,
          sourceEventIds: [first.id],
          recentEventIds: [first.id],
          summary: '旧摘要',
          provider: 'fixture',
          model: 'fixture',
          createdAt: 24,
        },
      })
      repository.activateEpisode(nextEpisodeId, 'dsh-purge-next')
      const intentId = OutboundIntentIdSchema.parse('out_PURGE1')
      repository.createOutboundPlan(
        {
          id: intentId,
          logicalMessageId: LogicalMessageIdSchema.parse('msg_PURGEOUT1'),
          agentRevisionId: agent.revision.id,
          episodeId: nextEpisodeId,
          parts: [{ type: 'image', assetId: sent }],
          state: 'planned',
          createdAt: 25,
        },
        [
          {
            id: PhysicalDeliveryIdSchema.parse('phy_PURGE1'),
            intentId,
            sequence: 0,
            parts: [{ type: 'image', assetId: sent }],
            state: 'planned',
          },
        ],
      )
      repository.insertSubConversation({
        id: SubConversationIdSchema.parse('cnv_PURGE1'),
        channelId: purged.id,
        episodeId: nextEpisodeId,
        agentId: agent.definition.id,
        dshSessionId: 'dsh-purge-sub',
        parentDshSessionId: 'dsh-purge-next',
        title: '子对话',
        openedBy: 'agent',
        driver: 'model',
        status: 'open',
        createdAt: 26,
      })
      const member = core.ensureSelfChannelMember(purged.id)
      repository.saveChannelMemberNote({
        channelId: purged.id,
        memberId: member.id,
        text: '喜欢简短的回答',
        updatedBy: 'agent',
        updatedAt: 27,
      })
      repository.saveChannelPrompt({
        channelId: purged.id,
        kind: 'instructions',
        document: { version: 1, segments: [{ type: 'text', text: '频道说明' }] },
        locked: false,
        updatedBy: 'admin',
        updatedAt: 28,
        expectedRevision: 0,
      })

      expect(repository.channelHistory.previewChannelHistoryPurge(purged.id)).toEqual({
        messages: 6,
        conversations: 2,
        attachments: 5,
        blockers: { liveAuthoringTasks: 0, sendingMessages: 1, runningCommands: 0 },
      })
      expect(() => repository.channelHistory.purgeChannelHistory(purged.id)).toThrow(ChannelHistoryPurgeBlockedError)
      expect(repository.listChannelEvents(purged.id)).toHaveLength(5)

      repository.markIntentSending(intentId)
      repository.completeOutboundIntent(intentId, 'failed')
      const result = repository.channelHistory.purgeChannelHistory(purged.id, {
        isAssetHeld: (candidate) => candidate.id === held,
      })
      expect(result.messages).toBe(6)
      expect(result.conversations).toBe(2)
      expect([...result.dshSessionIds].sort()).toEqual(['dsh-purge-next', 'dsh-purge-old', 'dsh-purge-sub'])
      expect(result.removedAssets.map(({ id }) => id).sort()).toEqual([onlyHere, sent].sort())

      expect(repository.listChannelEvents(purged.id)).toEqual([])
      expect(repository.listChannelHistory(purged.id, { limit: 50 })).toEqual([])
      expect(repository.searchChannelHistory(purged.id, 'needle')).toEqual([])
      expect(repository.getActiveEpisode(purged.id, agent.definition.id)).toBeUndefined()
      expect(repository.getAssetById(onlyHere)).toBeUndefined()
      expect(repository.getAssetById(sent)).toBeUndefined()
      for (const kept of [shared, avatar, held]) expect(repository.getAssetById(kept)).toBeDefined()
      expect(repository.canAccessAsset(shared, other.id)).toBe(true)
      expect(repository.listChannelEvents(other.id)).toHaveLength(1)

      expect(repository.getChannel(purged.id)?.id).toBe(purged.id)
      expect(repository.getBinding(purged.id)?.agentId).toBe(agent.definition.id)
      expect(repository.getChannelMemberNote(purged.id, member.id)?.text).toBe('喜欢简短的回答')
      expect(repository.getChannelPrompt(purged.id, 'instructions')?.revision).toBe(1)
      expect(repository.channelHistory.previewChannelHistoryPurge(purged.id)).toEqual({
        messages: 0,
        conversations: 0,
        attachments: 0,
        blockers: { liveAuthoringTasks: 0, sendingMessages: 0, runningCommands: 0 },
      })

      const fresh = append(purged.id, '新的开始')
      repository.createEpisode({
        id: EpisodeIdSchema.parse('eps_PURGEFRESH'),
        channelId: purged.id,
        agentId: agent.definition.id,
        agentRevisionId: agent.revision.id,
        status: 'opening',
        openedAtEventId: fresh.id,
        createdAt: 40,
      })
      expect(repository.listChannelEvents(purged.id).map(({ id }) => id)).toEqual([fresh.id])
    } finally {
      database.close()
    }
    const native = new BetterSqlite3(filename)
    try {
      expect(native.pragma('foreign_key_check')).toEqual([])
    } finally {
      native.close()
    }
  })

  it('reports an unknown channel', async () => {
    const { database, repository } = await fixture()
    try {
      expect(() => repository.channelHistory.previewChannelHistoryPurge(ChannelIdSchema.parse('chn_MISSING'))).toThrow(
        /Unknown channel/u,
      )
    } finally {
      database.close()
    }
  })
})
