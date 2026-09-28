import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { NekroJsonlSessionPersistence } from '../src/dsh-session-persistence.js'

describe('NXT public JSONL persistence adapter', () => {
  it('retains owned audit events across a provider restart without editing private storage', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nxt-jsonl-audit-'))
    const first = new Context()
    const second = new Context()
    try {
      await first.plugin(NekroJsonlSessionPersistence, { root })
      const session = Session.create(SessionId('synthetic-audit-session'))
      const handle = await first.sessionPersistence.create(session.header)
      const event = session.append('nekro-nxt/image-admission', {
        admissionId: 'synthetic-admission',
        imageCount: 1,
        injectedCount: 1,
        duplicateCount: 0,
        skippedCount: 0,
      })
      await handle.append([event])
      await handle.flush()
      await handle.close()
      await first.fiber.dispose()
      await second.plugin(NekroJsonlSessionPersistence, { root })
      const restored = await second.sessionPersistence.open(session.id, 'read')
      try {
        const events = (await restored.read()).events
        expect(events).toEqual([
          expect.objectContaining({ type: 'nekro-nxt/image-admission', ignorable: true, data: event.data }),
        ])
        expect(event.ignorable).toBeUndefined()
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
