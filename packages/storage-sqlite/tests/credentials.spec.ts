import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { AgentIdSchema, CredentialIdSchema, LinkedAccountIdSchema } from '@nekro-nxt/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CREDENTIAL_USES_KEEP,
  CREDENTIAL_USES_MAX_AGE_MS,
  createCredentialsRepository,
  type CredentialRecord,
} from '../src/repositories/credentials.js'
import { createLinkedAccountsRepository } from '../src/repositories/linked-accounts.js'
import { coreSchema, credentials, credentialUses, systemSettings } from '../src/schema.js'

const id = CredentialIdSchema.parse('crd_FIXTURE1')
const agentId = AgentIdSchema.parse('agt_FIXTURE')
const legacyId = CredentialIdSchema.parse('crd_LEGACY1')
const accountId = LinkedAccountIdSchema.parse('acc_LEGACY1')

const credential = (overrides: Partial<CredentialRecord> = {}): CredentialRecord => ({
  id,
  name: '示例天气服务',
  description: '天气查询接口',
  usage: 'request',
  domains: ['api.weather.test'],
  agentScope: { agentIds: [agentId] },
  autoUse: true,
  approvedAgentIds: [],
  credentialRef: 'credential:local:0123456789abcdef0123456789abcdef',
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

    expect(
      repository.updateCredential(
        credential({
          name: '天气',
          autoUse: false,
          envName: 'WEATHER_KEY',
          approvedAgentIds: [agentId],
          updatedAt: 2_000,
        }),
      ),
    ).toBe(true)
    expect(repository.getCredential(id)).toMatchObject({
      name: '天气',
      autoUse: false,
      envName: 'WEATHER_KEY',
      approvedAgentIds: [agentId],
      createdAt: 1_000,
    })

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

  it('keeps rows of older GitHub credentials out of the library until they move to linked accounts', () => {
    repository.insertCredential(credential())
    db.insert(credentials)
      .values({
        ...credential({ id: legacyId, name: 'GitHub octo-fixture', usage: 'program' }),
        kind: 'github',
        domains: [],
        agentScope: { agentIds: [agentId] },
        envName: null,
        metadata: { login: 'octo-fixture', source: 'gh-login', scopes: ['repo'] },
        lastUsedAt: 4_000,
      })
      .run()
    db.insert(credentialUses)
      .values([
        { credentialId: legacyId, at: 3_000, agentId, consumerKind: 'command', consumerId: 'shell' },
        { credentialId: legacyId, at: 3_500, consumerKind: 'extension', consumerId: 'ext_A' },
      ])
      .run()
    expect(repository.listCredentials().map((entry) => entry.id)).toEqual([id])
    expect(repository.getCredential(legacyId)).toBeUndefined()
    expect(repository.deleteCredential(legacyId)).toBe(false)

    const accounts = createLinkedAccountsRepository(db)
    expect(accounts.listLegacyGithubCredentials()).toEqual([
      {
        id: legacyId,
        credentialRef: credential().credentialRef,
        login: 'octo-fixture',
        scopes: ['repo'],
        source: 'gh-login',
        createdAt: 1_000,
        updatedAt: 1_000,
        lastUsedAt: 4_000,
      },
    ])
    const account = {
      id: accountId,
      platform: 'github',
      login: 'octo-fixture',
      scopes: ['repo'],
      source: 'gh-login',
      credentialRef: credential().credentialRef,
      createdAt: 1_000,
      updatedAt: 1_000,
      lastUsedAt: 4_000,
    }
    accounts.importAccounts({
      accounts: [account],
      fromCredentials: [{ credentialId: legacyId, accountId }],
      marker: { key: 'linked-accounts-import', value: { done: true }, updatedAt: 5_000 },
    })
    expect(accounts.listAccounts()).toEqual([account])
    // Only command uses move; the credential row and its uses are gone.
    expect(accounts.listAccountUses(accountId, 10)).toEqual([
      { accountId, at: 3_000, agentId, consumerKind: 'command', consumerId: 'shell' },
    ])
    expect(accounts.listLegacyGithubCredentials()).toEqual([])
    expect(db.select().from(credentialUses).all()).toEqual([])
    expect(db.select().from(systemSettings).all()).toEqual([
      { key: 'linked-accounts-import', value: { done: true }, revision: 1, updatedAt: 5_000 },
    ])

    // Accounts keep uses like credentials do, and lose them with the account.
    const start = 10 + CREDENTIAL_USES_MAX_AGE_MS + 1
    for (let index = 0; index < CREDENTIAL_USES_KEEP + 2; index += 1) {
      accounts.recordAccountUse({ accountId, at: start + index, agentId, consumerKind: 'command', consumerId: 'shell' })
    }
    expect(accounts.listAccountUses(accountId, 1_000)).toHaveLength(CREDENTIAL_USES_KEEP)
    expect(accounts.getAccount(accountId)?.lastUsedAt).toBe(start + CREDENTIAL_USES_KEEP + 1)
    expect(accounts.updateAccount({ ...account, login: 'Octo-Fixture', updatedAt: 6_000 })).toBe(true)
    expect(accounts.getAccount(accountId)).toMatchObject({ login: 'Octo-Fixture', createdAt: 1_000 })
    expect(accounts.deleteAccount(accountId)).toBe(true)
    expect(accounts.listAccountUses(accountId, 10)).toEqual([])
  })
})
