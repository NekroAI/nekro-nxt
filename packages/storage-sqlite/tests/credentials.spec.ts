import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { AgentIdSchema, CredentialIdSchema } from '@nekro-nxt/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CREDENTIAL_USES_KEEP,
  CREDENTIAL_USES_MAX_AGE_MS,
  createCredentialsRepository,
  type CredentialRecord,
} from '../src/repositories/credentials.js'
import { coreSchema, systemSettings } from '../src/schema.js'

const id = CredentialIdSchema.parse('crd_FIXTURE1')
const agentId = AgentIdSchema.parse('agt_FIXTURE')

const credential = (overrides: Partial<CredentialRecord> = {}): CredentialRecord => ({
  id,
  name: '示例天气服务',
  description: '天气查询接口',
  kind: 'generic',
  usage: 'request',
  domains: ['api.weather.test'],
  agentScope: { agentIds: [agentId] },
  autoUse: true,
  credentialRef: 'credential:local:0123456789abcdef0123456789abcdef',
  metadata: {},
  createdAt: 1_000,
  updatedAt: 1_000,
  ...overrides,
})

describe('credentials repository', () => {
  let sqlite: Database.Database
  let repository: ReturnType<typeof createCredentialsRepository>
  let db: ReturnType<typeof drizzle<typeof coreSchema>>

  beforeEach(() => {
    sqlite = new Database(':memory:')
    sqlite.pragma('foreign_keys = ON')
    db = drizzle(sqlite, { schema: coreSchema })
    migrate(db, { migrationsFolder: path.join(import.meta.dirname, '../migrations') })
    repository = createCredentialsRepository(db)
  })

  afterEach(() => sqlite.close())

  it('stores, updates and deletes a credential with its uses', () => {
    repository.insertCredential(credential())
    expect(repository.getCredential(id)).toEqual(credential())
    expect(() => repository.insertCredential(credential({ id: CredentialIdSchema.parse('crd_FIXTURE2') }))).toThrow()

    expect(repository.updateCredential(credential({ name: '天气', autoUse: false, updatedAt: 2_000 }))).toBe(true)
    expect(repository.getCredential(id)).toMatchObject({ name: '天气', autoUse: false, createdAt: 1_000 })

    repository.recordCredentialUse({ credentialId: id, at: 3_000, consumerKind: 'extension', consumerId: 'ext_A' })
    expect(repository.getCredential(id)?.lastUsedAt).toBe(3_000)
    expect(repository.deleteCredential(id)).toBe(true)
    expect(repository.listCredentialUses(id, 10)).toEqual([])
    expect(repository.updateCredential(credential())).toBe(false)
  })

  it('keeps the newest uses and drops ones older than the retention window', () => {
    repository.insertCredential(credential())
    repository.recordCredentialUse({ credentialId: id, at: 10, consumerKind: 'command', consumerId: 'shell' })
    const start = 10 + CREDENTIAL_USES_MAX_AGE_MS + 1
    for (let index = 0; index < CREDENTIAL_USES_KEEP + 5; index += 1) {
      repository.recordCredentialUse({
        credentialId: id,
        at: start + index,
        agentId,
        consumerKind: 'extension',
        consumerId: 'ext_A',
        targetHost: 'api.weather.test',
      })
    }
    const uses = repository.listCredentialUses(id, 1_000)
    expect(uses).toHaveLength(CREDENTIAL_USES_KEEP)
    expect(uses[0]).toEqual({
      credentialId: id,
      at: start + CREDENTIAL_USES_KEEP + 4,
      agentId,
      consumerKind: 'extension',
      consumerId: 'ext_A',
      targetHost: 'api.weather.test',
    })
    expect(uses.some((use) => use.consumerKind === 'command')).toBe(false)
    // An older use recorded late does not move the last use back.
    repository.recordCredentialUse({ credentialId: id, at: start, consumerKind: 'mcp', consumerId: 'search' })
    expect(repository.getCredential(id)?.lastUsedAt).toBe(start + CREDENTIAL_USES_KEEP + 4)
  })

  it('imports credentials and their marker together, skipping ones that exist', () => {
    repository.insertCredential(credential())
    const other = credential({ id: CredentialIdSchema.parse('crd_FIXTURE2'), name: 'GitHub octo-fixture' })
    repository.importCredentials([credential({ name: '不会覆盖' }), other], {
      key: 'credentials-import',
      value: { done: true },
      updatedAt: 5_000,
    })
    expect(repository.listCredentials().map((entry) => entry.name)).toEqual(['示例天气服务', 'GitHub octo-fixture'])
    expect(db.select().from(systemSettings).all()).toEqual([
      { key: 'credentials-import', value: { done: true }, revision: 1, updatedAt: 5_000 },
    ])

    // A clash on the unique name rolls the marker back with the rows.
    expect(() =>
      repository.importCredentials([credential({ id: CredentialIdSchema.parse('crd_FIXTURE3') })], {
        key: 'credentials-import',
        value: { done: 'again' },
        updatedAt: 6_000,
      }),
    ).toThrow()
    expect(db.select().from(systemSettings).all()[0]?.value).toEqual({ done: true })
  })
})
