import {
  LinkedAccountIdSchema,
  LinkedAccountMethodSchema,
  type AddLinkedAccountRequest,
  type AgentId,
  type CommandAccountUsage,
  type JsonValue,
  type LinkedAccountId,
  type LinkedAccountTokenSource,
} from '@nekro-nxt/contracts'
import type {
  LinkedAccountImport,
  LinkedAccountRecord,
  LinkedAccountsRepository,
  SystemSettingRecord,
} from '@nekro-nxt/storage-sqlite'
import { z } from 'zod'
import type { CommandCredentialSources } from '../command-account-env.js'
import type { CredentialStore } from '../credentials-library.js'
import type { SecretRegistry } from '../secret-registry.js'
import { LinkedAccountError, type LinkedAccountPlatform, type LinkedAccountPlatforms } from './platform.js'

/** The setting of the first command account library; its accounts become linked accounts once. */
const COMMAND_ACCOUNTS_SETTING_KEY = 'command-accounts'
/** Command use is recorded at most this often per agent and account: every command reads the environment. */
const COMMAND_USE_RECORD_INTERVAL_MS = 10 * 60 * 1000

const StoredAccountSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9]{1,64}$/u),
    service: z.literal('github'),
    login: z.string().min(1),
    source: z.enum(['token', 'gh-login']),
    scopes: z.array(z.string()).optional(),
    credentialRef: z.string().min(1),
    createdAt: z.number().int().nonnegative(),
  })
  .strict()
const StoredAccountsSchema = z.object({ version: z.literal(1), accounts: z.array(StoredAccountSchema) }).strict()

/**
 * The account a `commandAccounts` grant names. Grants saved by older builds name the account without its prefix: the
 * id of the first command account library, which the GitHub credential `crd_<id>` and now the account `acc_<id>` kept.
 */
export const linkedAccountIdOfGrant = (accountId: string): LinkedAccountId | undefined => {
  const parsed = LinkedAccountIdSchema.safeParse(accountId.startsWith('acc_') ? accountId : `acc_${accountId}`)
  return parsed.success ? parsed.data : undefined
}

/** A grant as revisions store it. */
export interface LinkedAccountGrant {
  readonly service: string
  readonly accountId: string
  readonly usage: readonly CommandAccountUsage[]
}

/** An agent's grants, for listing who an account is granted to. */
export interface AgentGrants {
  readonly agentId: AgentId
  readonly grants: readonly LinkedAccountGrant[]
}

/** A granted account cleared for one agent's commands, with its token. */
export interface GrantedAccount {
  readonly record: LinkedAccountRecord
  readonly platform: LinkedAccountPlatform
  readonly token: string
  readonly usage: readonly CommandAccountUsage[]
}

export interface LinkedAccountLibraryRepository {
  readonly linkedAccounts: LinkedAccountsRepository
  getSystemSetting(key: string): SystemSettingRecord | undefined
}

export interface LinkedAccountLibraryOptions {
  readonly secrets: SecretRegistry
  readonly platforms: LinkedAccountPlatforms
  readonly now?: () => number
  readonly nextId?: () => string
}

/**
 * The linked account library (设置 → 关联账号). It only keeps accounts: an agent's commands receive one through its
 * `commandAccounts` grant (命令账号授权 A1、A2). Tokens stay in the local credential store and in memory (a command's
 * environment is built synchronously, and a removed account must stop at the next command); each is registered for
 * redaction as `<platform> <login>`. Tokens never leave through any view.
 */
export class LinkedAccountLibrary {
  readonly #repository: LinkedAccountLibraryRepository
  readonly #store: CredentialStore
  readonly #secrets: SecretRegistry
  readonly #platforms: LinkedAccountPlatforms
  readonly #now: () => number
  readonly #nextId: () => string
  readonly #tokens = new Map<LinkedAccountId, string>()
  readonly #listeners = new Set<() => void>()
  readonly #commandUses = new Map<string, number>()
  #records: readonly LinkedAccountRecord[] = []
  #queue: Promise<unknown> = Promise.resolve()

  constructor(
    repository: LinkedAccountLibraryRepository,
    store: CredentialStore,
    options: LinkedAccountLibraryOptions,
  ) {
    this.#repository = repository
    this.#store = store
    this.#secrets = options.secrets
    this.#platforms = options.platforms
    this.#now = options.now ?? Date.now
    this.#nextId = options.nextId ?? (() => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`)
  }

  get platforms(): LinkedAccountPlatforms {
    return this.#platforms
  }

  /**
   * Moves accounts older builds kept elsewhere in (idempotent), then loads every token. An account whose token cannot
   * be read stays listed but unusable.
   */
  async prepare(): Promise<void> {
    this.#importCommandAccountSetting()
    this.#importGithubCredentials()
    this.#records = this.#repository.linkedAccounts.listAccounts()
    this.#tokens.clear()
    for (const record of this.#records) {
      try {
        const token = await this.#store.resolve(record.credentialRef)
        this.#tokens.set(record.id, token)
        this.#secrets.register(token, { label: this.#label(record) })
      } catch {
        // Listed with `available: false`; it can be replaced or removed.
      }
    }
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  list(): readonly LinkedAccountRecord[] {
    return this.#records
  }

  get(id: LinkedAccountId): LinkedAccountRecord | undefined {
    return this.#records.find((record) => record.id === id)
  }

  available(id: LinkedAccountId): boolean {
    return this.#tokens.has(id)
  }

  /** The account a grant names, when it still exists on the grant's platform. */
  resolveGrant(grant: Pick<LinkedAccountGrant, 'service' | 'accountId'>): LinkedAccountRecord | undefined {
    const id = linkedAccountIdOfGrant(grant.accountId)
    const record = id === undefined ? undefined : this.get(id)
    return record?.platform === grant.service ? record : undefined
  }

  /** Agents whose grants name the account. */
  grantedAgentIds(id: LinkedAccountId, agents: Iterable<AgentGrants>): AgentId[] {
    const granted: AgentId[] = []
    for (const agent of agents) {
      if (agent.grants.some((grant) => this.resolveGrant(grant)?.id === id)) granted.push(agent.agentId)
    }
    return granted
  }

  /**
   * Accounts one agent's commands receive now: each grant whose account still exists with a readable token, on a
   * platform this host supports, at most one per platform. Read for every command, so a removed account stops at the
   * next one.
   */
  grantedAccounts(grants: readonly LinkedAccountGrant[]): GrantedAccount[] {
    const platforms = new Set<string>()
    return grants.flatMap((grant): GrantedAccount[] => {
      const record = this.resolveGrant(grant)
      const token = record === undefined ? undefined : this.#tokens.get(record.id)
      const platform = record === undefined ? undefined : this.#platforms.get(record.platform)
      if (record === undefined || token === undefined || platform === undefined) return []
      if (platforms.has(platform.id)) return []
      platforms.add(platform.id)
      return [{ record, platform, token, usage: grant.usage }]
    })
  }

  recordUse(input: { readonly accountId: LinkedAccountId; readonly agentId: AgentId; readonly consumerId: string }) {
    const at = this.#now()
    const key = `${input.accountId}\0${input.agentId}`
    const last = this.#commandUses.get(key)
    if (last !== undefined && at - last < COMMAND_USE_RECORD_INTERVAL_MS) return
    this.#commandUses.set(key, at)
    try {
      this.#repository.linkedAccounts.recordAccountUse({
        accountId: input.accountId,
        at,
        agentId: input.agentId,
        consumerKind: 'command',
        consumerId: input.consumerId,
      })
      // Views read the cached records; keep their last use current without announcing a change for every command.
      this.#records = this.#records.map((record) =>
        record.id === input.accountId ? { ...record, lastUsedAt: Math.max(record.lastUsedAt ?? 0, at) } : record,
      )
    } catch (error) {
      // A use of an account removed in the meantime has nothing to attach to; other failures surface in logs.
      if (this.get(input.accountId) !== undefined) console.warn('[nekro-nxt] 关联账号使用记录写入失败：', error)
    }
  }

  uses(id: LinkedAccountId, limit = 200) {
    return this.#repository.linkedAccounts.listAccountUses(id, limit)
  }

  /** Logins the GitHub CLI on this machine holds; empty without one. */
  localGithubLogins(): Promise<Array<{ login: string; active: boolean }>> {
    return this.#platforms.get('github')?.localLogins?.() ?? Promise.resolve([])
  }

  /** Verifies the token with the platform and links the account it belongs to; one account is linked once. */
  add(request: AddLinkedAccountRequest): Promise<LinkedAccountRecord> {
    return this.#serialized(async () => {
      const platform = this.#platforms.require(request.platform)
      const source = tokenSourceOf(request)
      if (!platform.addMethods.includes(source.method)) {
        throw new LinkedAccountError(`${platform.name} 账号不能这样添加。`)
      }
      const token = await platform.tokenOf(source)
      const identity = await platform.verify(token)
      const existing = this.#records.find(
        (record) => record.platform === platform.id && platform.sameAccount(record, identity),
      )
      if (existing !== undefined) {
        throw new LinkedAccountError(
          `已经关联了 ${platform.name} 账号 ${existing.login}，需要换 token 时请更换它的 token。`,
        )
      }
      const reference = await this.#store.save(token)
      const now = this.#now()
      const record: LinkedAccountRecord = {
        id: LinkedAccountIdSchema.parse(`acc_${this.#nextId()}`),
        platform: platform.id,
        login: identity.login,
        ...(identity.scopes === undefined ? {} : { scopes: [...identity.scopes] }),
        source: source.method,
        credentialRef: reference,
        createdAt: now,
        updatedAt: now,
      }
      try {
        this.#repository.linkedAccounts.insertAccount(record)
      } catch (error) {
        await this.#store.delete(reference).catch(() => undefined)
        throw error
      }
      this.#tokens.set(record.id, token)
      this.#secrets.register(token, { label: this.#label(record) })
      this.#reload()
      return record
    })
  }

  /** Stores a new token; it must belong to the same account on the platform. */
  replaceToken(id: LinkedAccountId, source: LinkedAccountTokenSource): Promise<LinkedAccountRecord> {
    return this.#serialized(async () => {
      const current = this.#require(id)
      const platform = this.#platforms.require(current.platform)
      if (!platform.addMethods.includes(source.method)) {
        throw new LinkedAccountError(`${platform.name} 账号不能这样更换 token。`)
      }
      const token = await platform.tokenOf(source)
      const identity = await platform.verify(token)
      if (!platform.sameAccount(current, identity)) {
        throw new LinkedAccountError(`新的 token 属于 ${identity.login}，请把它添加为新的账号。`)
      }
      const reference = await this.#store.save(token)
      const { scopes: _scopes, ...rest } = current
      void _scopes
      const next: LinkedAccountRecord = {
        ...rest,
        login: identity.login,
        ...(identity.scopes === undefined ? {} : { scopes: [...identity.scopes] }),
        source: source.method,
        credentialRef: reference,
        updatedAt: this.#now(),
      }
      try {
        if (!this.#repository.linkedAccounts.updateAccount(next)) throw new LinkedAccountError('没有找到这个账号。')
      } catch (error) {
        await this.#store.delete(reference).catch(() => undefined)
        throw error
      }
      this.#tokens.set(id, token)
      this.#secrets.register(token, { label: this.#label(next) })
      await this.#store.delete(current.credentialRef).catch(() => undefined)
      this.#reload()
      return next
    })
  }

  /** Removes the account at once: grants that name it give commands nothing from the next command. */
  remove(id: LinkedAccountId): Promise<void> {
    return this.#serialized(async () => {
      const current = this.get(id)
      if (current === undefined) return
      this.#repository.linkedAccounts.deleteAccount(id)
      this.#tokens.delete(id)
      await this.#store.delete(current.credentialRef).catch(() => undefined)
      this.#reload()
    })
  }

  #label(record: LinkedAccountRecord): string {
    const platform = this.#platforms.get(record.platform)
    return platform === undefined ? record.login : `${platform.name} ${record.login}`
  }

  #require(id: LinkedAccountId): LinkedAccountRecord {
    const record = this.get(id)
    if (record === undefined) throw new LinkedAccountError('没有找到这个账号。')
    return record
  }

  /**
   * The first command account library kept GitHub accounts in a system setting. Each becomes the account
   * `acc_<id>` with the same stored token, and the setting is emptied in the same transaction. Grants keep naming
   * `<id>`, which {@link linkedAccountIdOfGrant} resolves.
   */
  #importCommandAccountSetting(): void {
    const setting = this.#repository.getSystemSetting(COMMAND_ACCOUNTS_SETTING_KEY)
    const parsed = setting === undefined ? undefined : StoredAccountsSchema.safeParse(setting.value)
    const accounts = parsed?.success ? parsed.data.accounts : []
    if (accounts.length === 0) return
    const existing = new Set(this.#repository.linkedAccounts.listAccounts().map((record) => record.id))
    const now = this.#now()
    const emptied: JsonValue = { version: 1, accounts: [] }
    this.#repository.linkedAccounts.importAccounts({
      accounts: accounts.flatMap((account): LinkedAccountRecord[] => {
        const id = linkedAccountIdOfGrant(account.id)
        if (id === undefined || existing.has(id)) return []
        return [
          {
            id,
            platform: 'github',
            login: account.login,
            ...(account.scopes === undefined ? {} : { scopes: account.scopes }),
            source: account.source,
            credentialRef: account.credentialRef,
            createdAt: account.createdAt,
            updatedAt: now,
          },
        ]
      }),
      marker: { key: COMMAND_ACCOUNTS_SETTING_KEY, value: emptied, updatedAt: now },
    })
  }

  /**
   * Builds between the credential library and linked accounts kept GitHub accounts as `github` credentials. Each
   * becomes the account `acc_<suffix>` of its id `crd_<suffix>`, keeping the stored token and its command uses; the
   * credential row goes in the same transaction, so this runs once. Access came from the credential's scope, which
   * older builds kept equal to the agents' grants; the grants stay in the revisions and resolve to the new account.
   */
  #importGithubCredentials(): void {
    const legacy = this.#repository.linkedAccounts.listLegacyGithubCredentials()
    if (legacy.length === 0) return
    const existing = new Set(this.#repository.linkedAccounts.listAccounts().map((record) => record.id))
    const moves: Array<NonNullable<LinkedAccountImport['fromCredentials']>[number]> = []
    const accounts: LinkedAccountRecord[] = []
    for (const credential of legacy) {
      const id = linkedAccountIdOfGrant(credential.id.slice('crd_'.length))
      if (id === undefined) continue
      moves.push({ credentialId: credential.id, accountId: id })
      if (existing.has(id)) continue
      const source = LinkedAccountMethodSchema.safeParse(credential.source)
      accounts.push({
        id,
        platform: 'github',
        login: credential.login ?? '未知账号',
        ...(credential.scopes === undefined ? {} : { scopes: credential.scopes }),
        source: source.success ? source.data : 'token',
        credentialRef: credential.credentialRef,
        createdAt: credential.createdAt,
        updatedAt: credential.updatedAt,
        ...(credential.lastUsedAt === undefined ? {} : { lastUsedAt: credential.lastUsedAt }),
      })
    }
    this.#repository.linkedAccounts.importAccounts({ accounts, fromCredentials: moves })
  }

  #reload(): void {
    this.#records = this.#repository.linkedAccounts.listAccounts()
    for (const listener of this.#listeners) listener()
  }

  #serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work, work)
    this.#queue = next.catch(() => undefined)
    return next
  }
}

const tokenSourceOf = (request: AddLinkedAccountRequest): LinkedAccountTokenSource =>
  request.method === 'token' ? { method: 'token', token: request.token } : { method: 'gh-login', login: request.login }

/** The accounts one agent's commands act as, in the shape the command environment takes. */
export const commandAccountsOf =
  (library: LinkedAccountLibrary): CommandCredentialSources['accounts'] =>
  (agentId, grants) =>
    library.grantedAccounts(grants).map(({ record, platform, token, usage }) => ({
      id: record.id,
      label: `${platform.name} ${record.login}`,
      environment: platform.commandEnvironment({ agentId, token }),
      prompt: platform.promptLines({ login: record.login, usage }),
    }))
