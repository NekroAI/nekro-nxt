import BetterSqlite3 from 'better-sqlite3'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { ChannelMemberIdSchema } from '@nekro-nxt/contracts'
import { CoreService } from '@nekro-nxt/core'
import { openMigratedCoreDatabase, SqliteCoreRepository } from '../src/index.js'
import { ChannelEventRowSchema } from '../src/row-schemas.js'

describe('database history pagination', () => {
  it.each([10_000, 100_000])(
    'bounds decoded rows with %i historical facts and searches literal text once',
    async (size) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'nxt-history-'))
      const filename = path.join(directory, 'core.sqlite')
      const database = await openMigratedCoreDatabase(filename)
      const repository = new SqliteCoreRepository(database)
      const core = new CoreService(repository)
      const connection = core.createConnection({ adapterKey: 'fixture-history', config: {} })
      const channel = core.createChannel({
        connectionId: connection.id,
        platformChannelId: 'fixture',
        kind: 'internal',
      })
      const native = new BetterSqlite3(filename)
      try {
        const insert = native.prepare(`INSERT INTO channel_events
        (id, logical_message_id, channel_id, kind, parts, source_timestamp, received_at, dedupe_key, facts, search_text)
        VALUES (?, ?, ?, 'message-created', ?, 1, 1, ?, ?, ?)`)
        native.transaction(() => {
          for (let i = 0; i < size; i += 1) {
            const id = String(i).padStart(8, '0')
            insert.run(
              `evt_${id}`,
              `msg_${id}`,
              channel.id,
              '[{"type":"text","text":"fixture"}]',
              id,
              i === size - 1 ? '{"consoleAnchor":true}' : null,
              i === 0 ? '100%_完成 NEEDLE' : 'fixture',
            )
          }
        })()
        const parse = vi.spyOn(ChannelEventRowSchema, 'parse')
        try {
          const started = performance.now()
          const first = repository.listChannelHistory(channel.id, { limit: 16 })
          expect(first).toHaveLength(16)
          expect(parse).toHaveBeenCalledTimes(16)
          expect(
            first.every((entry) => entry.source !== 'channel-event' || entry.facts?.['consoleAnchor'] !== true),
          ).toBe(true)
          const last = first.at(-1)!
          const second = repository.listChannelHistory(channel.id, {
            limit: 16,
            before: { occurredAt: last.occurredAt, sourceId: last.sourceId },
          })
          expect(new Set([...first, ...second].map(({ sourceId }) => sourceId)).size).toBe(32)
          const readMs = performance.now() - started
          parse.mockClear()
          const searchStarted = performance.now()
          expect(repository.searchChannelHistory(channel.id, '100%_完成 needle')).toHaveLength(1)
          expect(repository.searchChannelHistory(channel.id, 'not-present')).toHaveLength(0)
          expect(parse).toHaveBeenCalledTimes(1)
          const searchMs = performance.now() - searchStarted
          const tickStarted = performance.now()
          const tick = new Promise<number>((resolve) => setTimeout(() => resolve(performance.now() - tickStarted), 0))
          repository.searchChannelHistory(channel.id, 'not-present')
          console.info(JSON.stringify({ rows: size, readMs, searchMs, eventLoopDelayMs: await tick }))
        } finally {
          parse.mockRestore()
        }
      } finally {
        native.close()
        database.close()
        await rm(directory, { recursive: true, force: true })
      }
    },
  )
})

describe('database history filters', () => {
  it('narrows reads and searches by time, sender and every search term', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nxt-history-filter-'))
    const filename = path.join(directory, 'core.sqlite')
    const database = await openMigratedCoreDatabase(filename)
    const repository = new SqliteCoreRepository(database)
    const core = new CoreService(repository)
    const connection = core.createConnection({ adapterKey: 'fixture-history', config: {} })
    const channel = core.createChannel({ connectionId: connection.id, platformChannelId: 'fixture', kind: 'group' })
    const member = (suffix: string, displayName: string) => {
      const identity = core.ensurePlatformIdentity({
        connectionId: connection.id,
        platformUserId: suffix,
        displayName,
        observedAt: 1,
      })
      return repository.ensureChannelMember({
        id: ChannelMemberIdSchema.parse(`mbr_${suffix}`),
        channelId: channel.id,
        platformIdentityId: identity.id,
        displayName,
      })
    }
    const acheng = member('acheng', '阿澄')
    const xiaolu = member('xiaolu', '小鹿')
    const native = new BetterSqlite3(filename)
    try {
      const insert = native.prepare(`INSERT INTO channel_events
        (id, logical_message_id, channel_id, kind, parts, source_timestamp, received_at, dedupe_key, sender_member_id, search_text)
        VALUES (?, ?, ?, 'message-created', '[{"type":"text","text":"fixture"}]', ?, ?, ?, ?, ?)`)
      const rows = [
        [100, acheng.id, '我下周三生日 请大家喝奶茶'],
        [200, xiaolu.id, '我家猫叫年糕'],
        [300, xiaolu.id, '奶茶店换了新菜单'],
        [400, acheng.id, '生日蛋糕订好了'],
      ] as const
      for (const [at, sender, text] of rows) {
        insert.run(`evt_${at}`, `msg_${at}`, channel.id, at, at, `key_${at}`, sender, text)
      }
      const ids = (entries: readonly { readonly sourceId: string }[]) => entries.map(({ sourceId }) => sourceId)
      const hits = (query: string, options: Parameters<typeof repository.searchChannelHistory>[2] = {}) =>
        ids(repository.searchChannelHistory(channel.id, query, options).map(({ entry }) => entry))

      expect(hits('生日 奶茶')).toEqual(['evt_100'])
      expect(hits('奶茶')).toEqual(['evt_300', 'evt_100'])
      expect(hits('奶茶', { sender: '小鹿' })).toEqual(['evt_300'])
      expect(hits('生日', { since: 200 })).toEqual(['evt_400'])
      expect(hits('生日', { until: 400 })).toEqual(['evt_100'])
      expect(ids(repository.listChannelHistory(channel.id, { sender: 'mbr_ACHENG' }))).toEqual(['evt_400', 'evt_100'])
      expect(ids(repository.listChannelHistory(channel.id, { since: 200, until: 400 }))).toEqual(['evt_300', 'evt_200'])
      expect(repository.listChannelHistory(channel.id, { ownOnly: true })).toEqual([])
      expect(repository.listChannelHistory(channel.id, { sender: '没有这个人' })).toEqual([])
    } finally {
      native.close()
      database.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
