import { EpisodeIdSchema } from '@nekro-nxt/contracts'
import { CoreService } from '@nekro-nxt/core'
import { openMigratedCoreDatabase, SqliteCoreRepository } from '@nekro-nxt/storage-sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { channelMemberRelations } from '../src/channel-member-relations.ts'
import { channelContextPrompt } from '../src/index.ts'
import { memberLabel, memberSummary } from '../src/session-image-context.ts'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const fixture = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-member-relations-'))
  directories.push(directory)
  const database = await openMigratedCoreDatabase(path.join(directory, 'core.sqlite'))
  const repository = new SqliteCoreRepository(database)
  let id = 0
  const core = new CoreService(repository, { now: () => 1000, nextUlid: () => `REL${++id}` })
  const model = { provider: 'test-provider', model: 'chat-model' }
  const helper = core.createAgent({ displayName: '小助手', persona: '', model })
  const recorder = core.createAgent({ displayName: '记录员', persona: '', model })
  const alpha = core.createConnection({ adapterKey: 'fixture-alpha', config: {} })
  const beta = core.createConnection({ adapterKey: 'fixture-alpha', config: {} })
  const group = (connectionId: typeof alpha.id) =>
    core.ensureChannel({ connectionId, platformChannelId: 'group-1', kind: 'group', observedAt: 1000 })
  const alphaGroup = group(alpha.id)
  const betaGroup = group(beta.id)
  core.createBinding({ channelId: alphaGroup.id, agentId: helper.definition.id, triggerPolicy: 'always' })
  core.createBinding({ channelId: betaGroup.id, agentId: recorder.definition.id, triggerPolicy: 'always' })
  return { database, repository, core, alpha, beta, alphaGroup, betaGroup }
}

describe('channel member relations', () => {
  it('names the channel account as the agent itself and other local accounts by their agent', async () => {
    const { database, repository, core, alpha, beta, alphaGroup } = await fixture()
    try {
      const relations = channelMemberRelations(core, repository, () => 1000)
      const placeholder = relations.self(alphaGroup.id)
      expect(relations.describe(placeholder.memberId)).toEqual({ kind: 'self' })
      expect(relations.localAgents(alphaGroup.id)).toEqual([])

      core.reportConnectionAccount({
        connectionId: alpha.id,
        platformUserId: '10001',
        displayName: '小助手号',
        observedAt: 1,
      })
      core.reportConnectionAccount({
        connectionId: beta.id,
        platformUserId: '20002',
        displayName: '记录号',
        observedAt: 1,
      })
      const self = relations.self(alphaGroup.id)
      expect(self).toMatchObject({ displayName: '小助手号' })
      const [recorder] = relations.localAgents(alphaGroup.id)
      expect(recorder).toMatchObject({ displayName: '记录号', agentName: '记录员' })
      expect(relations.describe(recorder!.memberId)).toEqual({ kind: 'local-agent', agentName: '记录员' })

      const stranger = core.observeChannelMember({
        connectionId: alpha.id,
        channelId: alphaGroup.id,
        platformUserId: '30003',
        displayName: '成员甲',
        observedAt: 1000,
      }).member
      expect(relations.describe(stranger.id)).toEqual({ kind: 'member' })

      const label = (memberId: typeof stranger.id) => memberLabel(memberSummary(repository, memberId, relations))
      expect(label(self.memberId)).toBe(`你（${self.memberId}）`)
      expect(label(recorder!.memberId)).toBe(`记录号（智能体「记录员」的账号，${recorder!.memberId}）`)
      expect(label(stranger.id)).toBe(`成员甲（${stranger.id}）`)

      const prompt = channelContextPrompt(
        {
          channelId: alphaGroup.id,
          connectionId: alpha.id,
          kind: 'group',
          episodeId: EpisodeIdSchema.parse('eps_REL'),
        },
        relations,
      )
      expect(prompt).toContain(`你在这个群里的账号是「小助手号」，成员 ID ${self.memberId}`)
      expect(prompt).toContain(`群里还有别的智能体：记录员（${recorder!.memberId}）`)
      // The built-in channel has no platform account to describe.
      expect(
        channelContextPrompt(
          {
            channelId: alphaGroup.id,
            connectionId: alpha.id,
            kind: 'internal',
            episodeId: EpisodeIdSchema.parse('eps_REL'),
          },
          relations,
        ),
      ).not.toContain('你在这个群里的账号')
    } finally {
      database.close()
    }
  })
})
