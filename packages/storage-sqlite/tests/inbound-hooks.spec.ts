import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { createInboundHooksRepository } from '../src/repositories/inbound-hooks.js'
import { AgentIdSchema, ChannelEventIdSchema, ExtensionIdSchema } from '@nekro-nxt/contracts'
import type { DrizzleCoreDatabase } from '../src/database.js'
import { coreSchema } from '../src/schema.js'
import path from 'path'

describe('Inbound Hooks Repository', () => {
  let db: DrizzleCoreDatabase
  let sqlite: Database.Database
  let repo: ReturnType<typeof createInboundHooksRepository>

  const agentId = AgentIdSchema.parse('agt_HOOKSTEST')
  const eventId = ChannelEventIdSchema.parse('evt_HOOKSTEST1')
  const eventId2 = ChannelEventIdSchema.parse('evt_HOOKSTEST2')
  const extensionId = ExtensionIdSchema.parse('ext_HOOKSTEST1')
  const extensionId2 = ExtensionIdSchema.parse('ext_HOOKSTEST2')

  function insertChannelEvent(eventId: string, channelId: string, logicalMessageId: string, dedupeKey: string) {
    sqlite
      .prepare(
        'INSERT INTO channel_events (id, logical_message_id, channel_id, kind, parts, source_timestamp, received_at, dedupe_key, search_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(eventId, logicalMessageId, channelId, 'message-created', '[]', 1000, 1000, dedupeKey, '')
  }

  beforeAll(() => {
    sqlite = new Database(':memory:')
    db = drizzle(sqlite, { schema: coreSchema })

    const migrationsFolder = path.join(path.dirname(import.meta.url.replace('file://', '')), '../migrations')
    migrate(db, { migrationsFolder })

    // Create test data
    sqlite.exec(`
      INSERT INTO agent_definitions (id, created_at) VALUES ('${agentId}', 1000);
      INSERT INTO connections (id, adapter_key, config, credential_refs, created_at) VALUES ('con_HOOKSTEST', 'test', '{}', '{}', 1000);
      INSERT INTO channels (id, connection_id, platform_channel_id, kind, display_name, created_at) VALUES ('chn_HOOKSTEST', 'con_HOOKSTEST', 'platform_chn_1', 'internal', 'Test Channel', 1000);
      INSERT INTO channel_bindings (channel_id, agent_id, trigger_policy, processing_feedback, bound_at) VALUES ('chn_HOOKSTEST', '${agentId}', 'always', 'auto', 1000);
    `)

    insertChannelEvent(eventId, 'chn_HOOKSTEST', 'msg_HOOKSTEST1', 'dedupe1')
    insertChannelEvent(eventId2, 'chn_HOOKSTEST', 'msg_HOOKSTEST2', 'dedupe2')

    repo = createInboundHooksRepository(db)
  })

  afterAll(() => {
    sqlite.close()
  })

  describe('Basic CRUD operations', () => {
    it('should save and retrieve an inbound hook decision', () => {
      const record = {
        channelEventId: eventId,
        agentId,
        trigger: 'default' as const,
        hidden: false,
        annotation: 'This is a test annotation',
        decidedBy: [extensionId],
        diagnostics: null,
        decidedAt: 2000,
      }

      const saved = repo.saveInboundHookDecision(record)
      expect(saved).toBeDefined()
      expect(saved.trigger).toBe('default')
      expect(saved.annotation).toBe('This is a test annotation')

      const retrieved = repo.getInboundHookDecision(eventId, agentId)
      expect(retrieved).toBeDefined()
      expect(retrieved?.trigger).toBe('default')
      expect(retrieved?.decidedBy).toEqual([extensionId])
    })

    it('should retrieve undefined for non-existent decision', () => {
      const nonExistentEventId = ChannelEventIdSchema.parse('evt_NONEXISTENT')
      const decision = repo.getInboundHookDecision(nonExistentEventId, agentId)
      expect(decision).toBeUndefined()
    })
  })

  describe('Immutability (insert or ignore)', () => {
    it('should not overwrite existing decision', () => {
      const record1 = {
        channelEventId: eventId,
        agentId,
        trigger: 'suppress' as const,
        hidden: true,
        annotation: 'Original annotation',
        decidedBy: [extensionId],
        diagnostics: null,
        decidedAt: 2000,
      }

      const saved1 = repo.saveInboundHookDecision(record1)
      expect(saved1.trigger).toBe('default') // First save was different

      const record2 = {
        channelEventId: eventId,
        agentId,
        trigger: 'force' as const,
        hidden: false,
        annotation: 'Trying to overwrite',
        decidedBy: [extensionId2],
        diagnostics: null,
        decidedAt: 3000,
      }

      const saved2 = repo.saveInboundHookDecision(record2)
      expect(saved2.trigger).toBe('default') // Should still be original
      expect(saved2.annotation).toBe('This is a test annotation')
      expect(saved2.decidedAt).toBe(2000)
    })
  })

  describe('Trigger states', () => {
    it('should save decision with suppress trigger', () => {
      const eventId3 = ChannelEventIdSchema.parse('evt_SUPPRESS')
      const agentId2 = AgentIdSchema.parse('agt_SUPPRESS')

      sqlite.exec(`INSERT INTO agent_definitions (id, created_at) VALUES ('${agentId2}', 1000);`)
      insertChannelEvent(eventId3, 'chn_HOOKSTEST', 'msg_SUPPRESS', 'dedupe_suppress')

      const record = {
        channelEventId: eventId3,
        agentId: agentId2,
        trigger: 'suppress' as const,
        hidden: false,
        annotation: null,
        decidedBy: [extensionId],
        diagnostics: null,
        decidedAt: 2000,
      }

      const saved = repo.saveInboundHookDecision(record)
      expect(saved.trigger).toBe('suppress')
    })

    it('should save decision with force trigger', () => {
      const eventId4 = ChannelEventIdSchema.parse('evt_FORCE')
      const agentId3 = AgentIdSchema.parse('agt_FORCE')

      sqlite.exec(`INSERT INTO agent_definitions (id, created_at) VALUES ('${agentId3}', 1000);`)
      insertChannelEvent(eventId4, 'chn_HOOKSTEST', 'msg_FORCE', 'dedupe_force')

      const record = {
        channelEventId: eventId4,
        agentId: agentId3,
        trigger: 'force' as const,
        hidden: false,
        annotation: 'Forced trigger',
        decidedBy: [extensionId, extensionId2],
        diagnostics: null,
        decidedAt: 2000,
      }

      const saved = repo.saveInboundHookDecision(record)
      expect(saved.trigger).toBe('force')
    })
  })

  describe('Hidden and annotation', () => {
    it('should save decision with hidden flag', () => {
      const eventId5 = ChannelEventIdSchema.parse('evt_HIDDEN')
      const agentId4 = AgentIdSchema.parse('agt_HIDDEN')

      sqlite.exec(`INSERT INTO agent_definitions (id, created_at) VALUES ('${agentId4}', 1000);`)
      insertChannelEvent(eventId5, 'chn_HOOKSTEST', 'msg_HIDDEN', 'dedupe_hidden')

      const record = {
        channelEventId: eventId5,
        agentId: agentId4,
        trigger: 'default' as const,
        hidden: true,
        annotation: 'Hidden from agent',
        decidedBy: [extensionId],
        diagnostics: null,
        decidedAt: 2000,
      }

      const saved = repo.saveInboundHookDecision(record)
      expect(saved.hidden).toBe(true)
      expect(saved.annotation).toBe('Hidden from agent')
    })

    it('should handle null annotation', () => {
      const eventId6 = ChannelEventIdSchema.parse('evt_NOANNOT')
      const agentId5 = AgentIdSchema.parse('agt_NOANNOT')

      sqlite.exec(`INSERT INTO agent_definitions (id, created_at) VALUES ('${agentId5}', 1000);`)
      insertChannelEvent(eventId6, 'chn_HOOKSTEST', 'msg_NOANNOT', 'dedupe_noannot')

      const record = {
        channelEventId: eventId6,
        agentId: agentId5,
        trigger: 'default' as const,
        hidden: false,
        annotation: null,
        decidedBy: [extensionId],
        diagnostics: null,
        decidedAt: 2000,
      }

      const saved = repo.saveInboundHookDecision(record)
      expect(saved.annotation).toBeNull()
    })
  })

  describe('Decided by extensions list', () => {
    it('should store multiple extensions in decidedBy', () => {
      const eventId7 = ChannelEventIdSchema.parse('evt_MULTIEXT')
      const agentId6 = AgentIdSchema.parse('agt_MULTIEXT')

      sqlite.exec(`INSERT INTO agent_definitions (id, created_at) VALUES ('${agentId6}', 1000);`)
      insertChannelEvent(eventId7, 'chn_HOOKSTEST', 'msg_MULTIEXT', 'dedupe_multiext')

      const ext1 = ExtensionIdSchema.parse('ext_MULTIEXT1')
      const ext2 = ExtensionIdSchema.parse('ext_MULTIEXT2')
      const ext3 = ExtensionIdSchema.parse('ext_MULTIEXT3')

      const record = {
        channelEventId: eventId7,
        agentId: agentId6,
        trigger: 'default' as const,
        hidden: false,
        annotation: null,
        decidedBy: [ext1, ext2, ext3],
        diagnostics: null,
        decidedAt: 2000,
      }

      const saved = repo.saveInboundHookDecision(record)
      expect(saved.decidedBy).toHaveLength(3)
      expect(saved.decidedBy).toContain(ext1)
      expect(saved.decidedBy).toContain(ext2)
      expect(saved.decidedBy).toContain(ext3)
    })
  })

  describe('Diagnostics', () => {
    it('should store diagnostics JSON', () => {
      const eventId8 = ChannelEventIdSchema.parse('evt_DIAG')
      const agentId7 = AgentIdSchema.parse('agt_DIAG')

      sqlite.exec(`INSERT INTO agent_definitions (id, created_at) VALUES ('${agentId7}', 1000);`)
      insertChannelEvent(eventId8, 'chn_HOOKSTEST', 'msg_DIAG', 'dedupe_diag')

      const diagnostics = {
        timeout: true,
        extensions: [{ id: extensionId, error: 'timeout after 5000ms' }],
      }

      const record = {
        channelEventId: eventId8,
        agentId: agentId7,
        trigger: 'default' as const,
        hidden: false,
        annotation: 'Some extensions timed out',
        decidedBy: [extensionId],
        diagnostics,
        decidedAt: 2000,
      }

      const saved = repo.saveInboundHookDecision(record)
      expect(saved.diagnostics).toEqual(diagnostics)
    })
  })

  describe('Listing decisions', () => {
    it('should list decisions for agent and event ids', () => {
      const agentId8 = AgentIdSchema.parse('agt_LIST')
      sqlite.exec(`INSERT INTO agent_definitions (id, created_at) VALUES ('${agentId8}', 1000);`)

      const eventIdA = ChannelEventIdSchema.parse('evt_LISTA')
      const eventIdB = ChannelEventIdSchema.parse('evt_LISTB')

      insertChannelEvent(eventIdA, 'chn_HOOKSTEST', 'msg_LISTA', 'dedupe_lista')
      insertChannelEvent(eventIdB, 'chn_HOOKSTEST', 'msg_LISTB', 'dedupe_listb')

      const record1 = {
        channelEventId: eventIdA,
        agentId: agentId8,
        trigger: 'default' as const,
        hidden: false,
        annotation: null,
        decidedBy: [extensionId],
        diagnostics: null,
        decidedAt: 2000,
      }

      const record2 = {
        channelEventId: eventIdB,
        agentId: agentId8,
        trigger: 'suppress' as const,
        hidden: true,
        annotation: null,
        decidedBy: [extensionId2],
        diagnostics: null,
        decidedAt: 2000,
      }

      repo.saveInboundHookDecision(record1)
      repo.saveInboundHookDecision(record2)

      const decisions = repo.listInboundHookDecisions(agentId8, [eventIdA, eventIdB])
      expect(decisions.length).toBe(2)
      expect(decisions.some((d) => d.channelEventId === eventIdA)).toBe(true)
      expect(decisions.some((d) => d.channelEventId === eventIdB)).toBe(true)
    })

    it('should handle empty event ids list', () => {
      const decisions = repo.listInboundHookDecisions(agentId, [])
      expect(decisions).toEqual([])
    })

    it('should return only matching decisions', () => {
      const agentId9 = AgentIdSchema.parse('agt_PARTIAL')
      sqlite.exec(`INSERT INTO agent_definitions (id, created_at) VALUES ('${agentId9}', 1000);`)

      const eventIdC = ChannelEventIdSchema.parse('evt_LISTC')
      const eventIdD = ChannelEventIdSchema.parse('evt_LISTD')
      const eventIdE = ChannelEventIdSchema.parse('evt_LISTE')

      insertChannelEvent(eventIdC, 'chn_HOOKSTEST', 'msg_LISTC', 'dedupe_listc')
      insertChannelEvent(eventIdD, 'chn_HOOKSTEST', 'msg_LISTD', 'dedupe_listd')
      insertChannelEvent(eventIdE, 'chn_HOOKSTEST', 'msg_LISTE', 'dedupe_liste')

      repo.saveInboundHookDecision({
        channelEventId: eventIdC,
        agentId: agentId9,
        trigger: 'default' as const,
        hidden: false,
        annotation: null,
        decidedBy: [extensionId],
        diagnostics: null,
        decidedAt: 2000,
      })

      repo.saveInboundHookDecision({
        channelEventId: eventIdD,
        agentId: agentId9,
        trigger: 'default' as const,
        hidden: false,
        annotation: null,
        decidedBy: [extensionId],
        diagnostics: null,
        decidedAt: 2000,
      })

      // Don't save eventIdE

      const decisions = repo.listInboundHookDecisions(agentId9, [eventIdC, eventIdD, eventIdE])
      expect(decisions.length).toBe(2)
      expect(decisions.every((d) => d.agentId === agentId9)).toBe(true)
    })
  })
})
