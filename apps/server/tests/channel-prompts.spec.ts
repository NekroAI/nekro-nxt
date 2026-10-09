import { PromptDocumentV1Schema, promptDocumentFromText } from '@nekro-nxt/contracts'
import { CoreService } from '@nekro-nxt/core'
import { ChannelPromptConflictError, openMigratedCoreDatabase, SqliteCoreRepository } from '@nekro-nxt/storage-sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CHANNEL_PROMPT_MAX_CHARS, ChannelPromptError, ChannelPrompts } from '../src/channel-prompts.ts'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const fixture = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-channel-prompts-'))
  directories.push(directory)
  const database = await openMigratedCoreDatabase(path.join(directory, 'core.sqlite'))
  const repository = new SqliteCoreRepository(database)
  let id = 0
  const core = new CoreService(repository, { now: () => 1000, nextUlid: () => `PROMPT${++id}` })
  const connection = core.createConnection({ adapterKey: 'fixture-alpha', config: {} })
  const channel = core.createChannel({ connectionId: connection.id, platformChannelId: 'group-1', kind: 'group' })
  let now = 2000
  const prompts = new ChannelPrompts(repository, () => ++now)
  return { database, channel, prompts }
}

const withReference = PromptDocumentV1Schema.parse({
  version: 1,
  segments: [
    { type: 'text', text: '有问题先找' },
    { type: 'reference', kind: 'platform-user', targetId: 'pid_FIXTURE', labelSnapshot: '值班成员' },
  ],
})

describe('channel prompts', () => {
  it('keeps the admin instructions for the admin and lets the agent keep its own notes unless locked', async () => {
    const { database, channel, prompts } = await fixture()
    try {
      expect(prompts.view(channel.id)).toMatchObject({
        instructions: { revision: 0, maxChars: CHANNEL_PROMPT_MAX_CHARS.instructions },
        notes: { revision: 0, locked: false, maxChars: CHANNEL_PROMPT_MAX_CHARS.notes },
      })

      // Instructions: references allowed, never locked, not touched by the agent.
      const admin = prompts.saveByAdmin({
        channelId: channel.id,
        kind: 'instructions',
        document: withReference,
        locked: true,
        expectedRevision: 0,
      })
      expect(admin.instructions).toMatchObject({ revision: 1, locked: false, updatedBy: 'admin' })

      expect(prompts.updateNotesByAgent(channel.id, '  本群讨论开源项目，回答附代码示例。  ')).toMatchObject({
        kind: 'notes',
        revision: 1,
        updatedBy: 'agent',
        document: promptDocumentFromText('本群讨论开源项目，回答附代码示例。'),
      })
      // Writing the same notes again is not a new version.
      expect(prompts.updateNotesByAgent(channel.id, '本群讨论开源项目，回答附代码示例。').revision).toBe(1)
      expect(prompts.current(channel.id, 'instructions')?.document).toEqual(withReference)

      expect(() =>
        prompts.saveByAdmin({
          channelId: channel.id,
          kind: 'notes',
          document: withReference,
          locked: false,
          expectedRevision: 1,
        }),
      ).toThrow(ChannelPromptError)
      const locked = prompts.saveByAdmin({
        channelId: channel.id,
        kind: 'notes',
        document: promptDocumentFromText('本群讨论开源项目。'),
        locked: true,
        expectedRevision: 1,
      })
      expect(locked.notes).toMatchObject({ revision: 2, locked: true, updatedBy: 'admin' })
      expect(locked.notes.revisions).toEqual([expect.objectContaining({ revision: 1, updatedBy: 'agent' })])
      expect(() => prompts.updateNotesByAgent(channel.id, '改成活泼风格')).toThrow(/锁定/u)

      // A stale editor does not overwrite a newer save.
      expect(() =>
        prompts.saveByAdmin({
          channelId: channel.id,
          kind: 'instructions',
          document: promptDocumentFromText('过期的编辑'),
          locked: false,
          expectedRevision: 0,
        }),
      ).toThrow(ChannelPromptConflictError)
      expect(() =>
        prompts.saveByAdmin({
          channelId: channel.id,
          kind: 'notes',
          document: promptDocumentFromText('长'.repeat(CHANNEL_PROMPT_MAX_CHARS.notes + 1)),
          locked: true,
          expectedRevision: 2,
        }),
      ).toThrow(/最多/u)

      // Clearing leaves nothing in the agent's context but keeps the history.
      prompts.saveByAdmin({
        channelId: channel.id,
        kind: 'instructions',
        document: { version: 1, segments: [] },
        locked: false,
        expectedRevision: 1,
      })
      expect(prompts.current(channel.id, 'instructions')).toBeUndefined()
      expect(prompts.view(channel.id).instructions.revisions.map(({ revision }) => revision)).toEqual([1])
    } finally {
      database.close()
    }
  })

  it('keeps the latest twenty earlier versions of each part', async () => {
    const { database, channel, prompts } = await fixture()
    try {
      for (let revision = 0; revision < 25; revision += 1)
        prompts.updateNotesByAgent(channel.id, `第 ${revision + 1} 版`)
      const revisions = prompts.view(channel.id).notes.revisions.map(({ revision }) => revision)
      expect(revisions).toHaveLength(20)
      expect(revisions[0]).toBe(24)
      expect(revisions.at(-1)).toBe(5)
      expect(prompts.view(channel.id).instructions.revisions).toEqual([])
    } finally {
      database.close()
    }
  })
})
