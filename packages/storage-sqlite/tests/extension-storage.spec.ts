import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { createExtensionStorageRepository, ExtensionStorageQuotaError } from '../src/repositories/extension-storage.js'
import { AgentIdSchema, ExtensionIdSchema } from '@nekro-nxt/contracts'
import { coreSchema } from '../src/schema.js'
import path from 'path'

describe('Extension Storage Repository', () => {
  let db: ReturnType<typeof drizzle>
  let sqlite: Database.Database
  let repo: ReturnType<typeof createExtensionStorageRepository>

  const extensionId = ExtensionIdSchema.parse('ext_STORAGETEST')
  const agentId = AgentIdSchema.parse('agt_STORAGETEST')
  const sharedOwner = 'shared' as const

  beforeAll(() => {
    sqlite = new Database(':memory:')
    db = drizzle(sqlite, { schema: coreSchema })

    // Run migrations
    const migrationsFolder = path.join(path.dirname(import.meta.url.replace('file://', '')), '../migrations')
    migrate(db, { migrationsFolder })

    // Create test data
    sqlite.exec(`
      INSERT INTO agent_definitions (id, created_at) VALUES ('agt_STORAGETEST', 1000);
      INSERT INTO local_extensions (id, scope, slug, display_name, description, created_at)
        VALUES ('ext_STORAGETEST', 'agent', 'test-ext', 'Test Extension', 'A test extension', 1000);
    `)

    repo = createExtensionStorageRepository(db)
  })

  afterAll(() => {
    sqlite.close()
  })

  describe('Basic CRUD operations', () => {
    it('should set and get a value', () => {
      const value = { text: 'hello', number: 42 }
      repo.setExtensionStorageEntry({
        extensionId,
        owner: sharedOwner,
        partition: '',
        key: 'test-key',
        value,
        updatedAt: 2000,
        quotaBytes: 1024 * 1024,
      })

      const result = repo.getExtensionStorageEntry({
        extensionId,
        owner: sharedOwner,
        partition: '',
        key: 'test-key',
      })

      expect(result).toEqual(value)
    })

    it('should return undefined for non-existent key', () => {
      const result = repo.getExtensionStorageEntry({
        extensionId,
        owner: sharedOwner,
        partition: '',
        key: 'non-existent-key',
      })

      expect(result).toBeUndefined()
    })

    it('should override existing value', () => {
      const value1 = { data: 'value1' }
      const value2 = { data: 'value2' }

      repo.setExtensionStorageEntry({
        extensionId,
        owner: sharedOwner,
        partition: '',
        key: 'override-key',
        value: value1,
        updatedAt: 2000,
        quotaBytes: 1024 * 1024,
      })

      repo.setExtensionStorageEntry({
        extensionId,
        owner: sharedOwner,
        partition: '',
        key: 'override-key',
        value: value2,
        updatedAt: 2001,
        quotaBytes: 1024 * 1024,
      })

      const result = repo.getExtensionStorageEntry({
        extensionId,
        owner: sharedOwner,
        partition: '',
        key: 'override-key',
      })

      expect(result).toEqual(value2)
    })

    it('should delete a value', () => {
      repo.setExtensionStorageEntry({
        extensionId,
        owner: sharedOwner,
        partition: '',
        key: 'delete-key',
        value: { data: 'to delete' },
        updatedAt: 2000,
        quotaBytes: 1024 * 1024,
      })

      const deleted = repo.deleteExtensionStorageEntry({
        extensionId,
        owner: sharedOwner,
        partition: '',
        key: 'delete-key',
      })

      expect(deleted).toBe(true)

      const result = repo.getExtensionStorageEntry({
        extensionId,
        owner: sharedOwner,
        partition: '',
        key: 'delete-key',
      })

      expect(result).toBeUndefined()
    })

    it('should return false when deleting non-existent key', () => {
      const deleted = repo.deleteExtensionStorageEntry({
        extensionId,
        owner: sharedOwner,
        partition: '',
        key: 'does-not-exist',
      })

      expect(deleted).toBe(false)
    })
  })

  describe('Agent-specific storage', () => {
    it('should isolate data by agent ID', () => {
      const sharedValue = { type: 'shared' }
      const agentValue = { type: 'agent-specific' }

      repo.setExtensionStorageEntry({
        extensionId,
        owner: sharedOwner,
        partition: '',
        key: 'isolation-key',
        value: sharedValue,
        updatedAt: 2000,
        quotaBytes: 1024 * 1024,
      })

      repo.setExtensionStorageEntry({
        extensionId,
        owner: agentId,
        partition: '',
        key: 'isolation-key',
        value: agentValue,
        updatedAt: 2001,
        quotaBytes: 1024 * 1024,
      })

      const sharedResult = repo.getExtensionStorageEntry({
        extensionId,
        owner: sharedOwner,
        partition: '',
        key: 'isolation-key',
      })

      const agentResult = repo.getExtensionStorageEntry({
        extensionId,
        owner: agentId,
        partition: '',
        key: 'isolation-key',
      })

      expect(sharedResult).toEqual(sharedValue)
      expect(agentResult).toEqual(agentValue)
    })
  })

  describe('Quota management', () => {
    it('should enforce single value size limit', () => {
      const largeValue = 'x'.repeat(256 * 1024 + 1)

      expect(() => {
        repo.setExtensionStorageEntry({
          extensionId,
          owner: sharedOwner,
          partition: 'quota-test',
          key: 'large-key',
          value: largeValue,
          updatedAt: 2000,
          quotaBytes: 1024 * 1024,
        })
      }).toThrow('Single value exceeds 256 KiB limit.')
    })

    it('should enforce total quota', () => {
      const quotaBytes = 1000 // 1000 bytes

      expect(() => {
        repo.setExtensionStorageEntry({
          extensionId,
          owner: sharedOwner,
          partition: 'quota-test-total',
          key: 'key1',
          value: 'x'.repeat(600),
          updatedAt: 2000,
          quotaBytes,
        })

        repo.setExtensionStorageEntry({
          extensionId,
          owner: sharedOwner,
          partition: 'quota-test-total',
          key: 'key2',
          value: 'y'.repeat(600),
          updatedAt: 2001,
          quotaBytes,
        })
      }).toThrow(ExtensionStorageQuotaError)
    })

    it('should report correct quota error details', () => {
      const quotaBytes = 500

      try {
        repo.setExtensionStorageEntry({
          extensionId,
          owner: sharedOwner,
          partition: 'quota-error-test',
          key: 'key1',
          value: 'x'.repeat(300),
          updatedAt: 2000,
          quotaBytes,
        })

        repo.setExtensionStorageEntry({
          extensionId,
          owner: sharedOwner,
          partition: 'quota-error-test',
          key: 'key2',
          value: 'y'.repeat(300),
          updatedAt: 2001,
          quotaBytes,
        })
      } catch (e) {
        expect(e).toBeInstanceOf(ExtensionStorageQuotaError)
        if (!(e instanceof ExtensionStorageQuotaError)) throw e
        expect(e.quotaBytes).toBe(quotaBytes)
        expect(e.usedBytes).toBeGreaterThan(quotaBytes)
      }
    })

    it('should not double-count bytes when replacing key', () => {
      const quotaBytes = 2000
      const partition = 'quota-replace-test'

      // Set initial value (approximately 200 bytes)
      repo.setExtensionStorageEntry({
        extensionId,
        owner: sharedOwner,
        partition,
        key: 'replace-key',
        value: { data: 'x'.repeat(100) },
        updatedAt: 2000,
        quotaBytes,
      })

      // Replace with smaller value - should not exceed quota
      repo.setExtensionStorageEntry({
        extensionId,
        owner: sharedOwner,
        partition,
        key: 'replace-key',
        value: { data: 'y'.repeat(50) },
        updatedAt: 2001,
        quotaBytes,
      })

      // Add another key with remaining quota
      repo.setExtensionStorageEntry({
        extensionId,
        owner: sharedOwner,
        partition,
        key: 'another-key',
        value: { data: 'z'.repeat(400) },
        updatedAt: 2002,
        quotaBytes,
      })

      const usage = repo.extensionStorageUsage(extensionId)
      expect(usage.bytes).toBeLessThanOrEqual(quotaBytes)
    })
  })

  describe('List operations', () => {
    it('should list entries in key order', () => {
      const partition = 'list-test'
      repo.setExtensionStorageEntry({
        extensionId,
        owner: sharedOwner,
        partition,
        key: 'b',
        value: { order: 2 },
        updatedAt: 2000,
        quotaBytes: 1024 * 1024,
      })

      repo.setExtensionStorageEntry({
        extensionId,
        owner: sharedOwner,
        partition,
        key: 'a',
        value: { order: 1 },
        updatedAt: 2001,
        quotaBytes: 1024 * 1024,
      })

      repo.setExtensionStorageEntry({
        extensionId,
        owner: sharedOwner,
        partition,
        key: 'c',
        value: { order: 3 },
        updatedAt: 2002,
        quotaBytes: 1024 * 1024,
      })

      const result = repo.listExtensionStorageEntries({
        extensionId,
        owner: sharedOwner,
        partition,
        limit: 10,
      })

      const keys = result.entries.map((e) => e.key)
      expect(keys).toEqual(['a', 'b', 'c'])
    })

    it('should support prefix matching', () => {
      const partition = 'prefix-test'
      repo.setExtensionStorageEntry({
        extensionId,
        owner: sharedOwner,
        partition,
        key: 'config:timeout',
        value: { timeout: 5000 },
        updatedAt: 2000,
        quotaBytes: 1024 * 1024,
      })

      repo.setExtensionStorageEntry({
        extensionId,
        owner: sharedOwner,
        partition,
        key: 'config:retries',
        value: { retries: 3 },
        updatedAt: 2001,
        quotaBytes: 1024 * 1024,
      })

      repo.setExtensionStorageEntry({
        extensionId,
        owner: sharedOwner,
        partition,
        key: 'data:cache',
        value: { cache: true },
        updatedAt: 2002,
        quotaBytes: 1024 * 1024,
      })

      const result = repo.listExtensionStorageEntries({
        extensionId,
        owner: sharedOwner,
        partition,
        prefix: 'config:',
        limit: 10,
      })

      expect(result.entries).toHaveLength(2)
      expect(result.entries.map((e) => e.key)).toEqual(['config:retries', 'config:timeout'])
    })

    it('should handle prefix with special characters literally', () => {
      const partition = 'special-prefix-test'
      repo.setExtensionStorageEntry({
        extensionId,
        owner: sharedOwner,
        partition,
        key: 'key%with_wildcard',
        value: { special: true },
        updatedAt: 2000,
        quotaBytes: 1024 * 1024,
      })

      repo.setExtensionStorageEntry({
        extensionId,
        owner: sharedOwner,
        partition,
        key: 'keyXwith_wildcard',
        value: { other: true },
        updatedAt: 2001,
        quotaBytes: 1024 * 1024,
      })

      const result = repo.listExtensionStorageEntries({
        extensionId,
        owner: sharedOwner,
        partition,
        prefix: 'key%with',
        limit: 10,
      })

      expect(result.entries).toHaveLength(1)
      expect(result.entries[0].key).toBe('key%with_wildcard')
    })

    it('should support pagination', () => {
      const partition = 'pagination-test'
      for (let i = 0; i < 5; i++) {
        repo.setExtensionStorageEntry({
          extensionId,
          owner: sharedOwner,
          partition,
          key: `key${i}`,
          value: { index: i },
          updatedAt: 2000 + i,
          quotaBytes: 1024 * 1024,
        })
      }

      const page1 = repo.listExtensionStorageEntries({
        extensionId,
        owner: sharedOwner,
        partition,
        limit: 2,
      })

      expect(page1.entries).toHaveLength(2)
      expect(page1.next).toBeDefined()

      const page2 = repo.listExtensionStorageEntries({
        extensionId,
        owner: sharedOwner,
        partition,
        limit: 2,
        after: page1.next,
      })

      expect(page2.entries).toHaveLength(2)
      expect(page1.entries[1].key < page2.entries[0].key).toBe(true)
    })
  })

  describe('Usage tracking', () => {
    it('should report correct usage', () => {
      const partition = 'usage-test'
      const usageExtensionId = ExtensionIdSchema.parse('ext_STORAGEUSAGE')

      // Create test extension
      sqlite.exec(`
        INSERT INTO local_extensions (id, scope, slug, display_name, description, created_at)
          VALUES ('ext_STORAGEUSAGE', 'agent', 'usage-test-ext', 'Usage Test', 'Test extension', 1000);
      `)

      repo.setExtensionStorageEntry({
        extensionId: usageExtensionId,
        owner: sharedOwner,
        partition,
        key: 'key1',
        value: { data: 'value1' },
        updatedAt: 2000,
        quotaBytes: 1024 * 1024,
      })

      repo.setExtensionStorageEntry({
        extensionId: usageExtensionId,
        owner: sharedOwner,
        partition,
        key: 'key2',
        value: { data: 'value2' },
        updatedAt: 2001,
        quotaBytes: 1024 * 1024,
      })

      const usage = repo.extensionStorageUsage(usageExtensionId)

      expect(usage.bytes).toBeGreaterThan(0)
      expect(usage.entries).toBe(2)
    })
  })
})
