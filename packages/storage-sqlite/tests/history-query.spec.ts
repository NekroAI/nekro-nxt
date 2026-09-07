import BetterSqlite3 from 'better-sqlite3'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { describe, expect, it, vi } from 'vitest'
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
