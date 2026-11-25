import { Context } from '@deepseek-ai/cordis'
import SessionStore, { pluginRecordOf, Session, SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { appendNxtRecord } from '../src/nxt-session-records.js'

describe('NXT records in the public JSONL provider', () => {
  it.each(['session', 'provider', 'close'] as const)(
    'retains live routed audit events after %s flush and a cold provider restart',
    async (flushBy) => {
      const root = await mkdtemp(path.join(tmpdir(), 'nxt-jsonl-live-audit-'))
      const first = new Context()
      const second = new Context()
      try {
        await first.plugin(SessionStore)
        await first.plugin(JsonlSessionPersistence, { root })
        const session = first.sessions.create(SessionId('synthetic-live-audit-session'))
        const handle = await first.sessionPersistence.create(session.header)
        const data = {
          admissionId: 'synthetic-live-admission',
          imageCount: 1,
          injectedCount: 1,
          duplicateCount: 0,
          skippedCount: 0,
        }
        appendNxtRecord(session, 'plugin:nekro-nxt/image-admission', data)
        if (flushBy === 'session') await first.sessions.flush(session)
        if (flushBy === 'provider') await first.sessionPersistence.flush()
        await handle.close()
        await first.fiber.dispose()
        await second.plugin(JsonlSessionPersistence, { root })
        const restored = await second.sessionPersistence.open(session.id, 'read')
        try {
          const events = (await restored.read()).events
          expect(events.map((event) => pluginRecordOf(event))).toEqual([
            expect.objectContaining({ type: 'plugin:nekro-nxt/image-admission', data }),
          ])
        } finally {
          await restored.close()
        }
      } finally {
        await first.fiber.dispose()
        await second.fiber.dispose()
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  it('retains owned audit events across a provider restart without editing private storage', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nxt-jsonl-audit-'))
    const first = new Context()
    const second = new Context()
    try {
      await first.plugin(JsonlSessionPersistence, { root })
      const session = Session.create(SessionId('synthetic-audit-session'))
      const handle = await first.sessionPersistence.create(session.header)
      const data = {
        admissionId: 'synthetic-admission',
        imageCount: 1,
        injectedCount: 1,
        duplicateCount: 0,
        skippedCount: 0,
      }
      appendNxtRecord(session, 'plugin:nekro-nxt/image-admission', data)
      await handle.append(session.snapshotEvents())
      await handle.flush()
      await handle.close()
      await first.fiber.dispose()
      await second.plugin(JsonlSessionPersistence, { root })
      const restored = await second.sessionPersistence.open(session.id, 'read')
      try {
        const events = (await restored.read()).events
        expect(events).toEqual([
          expect.objectContaining({ type: 'plugin:nekro-nxt/image-admission', ignorable: true, data }),
        ])
      } finally {
        await restored.close()
      }
    } finally {
      await first.fiber.dispose()
      await second.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
