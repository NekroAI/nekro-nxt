import {
  CREDENTIAL_REDACTABLE_MIN_CHARS,
  CredentialIdSchema,
  CreateCredentialRequestSchema,
  type AgentId,
  type ChannelId,
  type CredentialId,
  type CredentialUsage,
  type GithubCredentialSource,
  type JsonValue,
  type ReplaceCredentialValueRequest,
  type UpdateCredentialRequest,
} from '@nekro-nxt/contracts'
import type {
  CredentialConsumerKind,
  CredentialRecord,
  CredentialsRepository,
  SystemSettingRecord,
} from '@nekro-nxt/storage-sqlite'
import { z } from 'zod'
import type { SecretRegistry } from './secret-registry.js'
import { CredentialError, githubTokenOf, localGithubLogins, verifyGithubToken } from './github-account.js'

export { CredentialError }

/** Secret config fields bound to a named credential hold this reference instead of a store reference. */
export const NAMED_CREDENTIAL_PREFIX = 'credential:named:'

export const namedCredentialReference = (id: CredentialId): string => `${NAMED_CREDENTIAL_PREFIX}${id}`

/** The credential a config value names, or `undefined` for any other value. */
export const namedCredentialId = (value: unknown): CredentialId | undefined => {
  if (typeof value !== 'string' || !value.startsWith(NAMED_CREDENTIAL_PREFIX)) return undefined
  const parsed = CredentialIdSchema.safeParse(value.slice(NAMED_CREDENTIAL_PREFIX.length))
  return parsed.success ? parsed.data : undefined
}

/** The setting of the older command account library; its accounts become GitHub credentials once. */
const COMMAND_ACCOUNTS_SETTING_KEY = 'command-accounts'
const GITHUB_DOMAINS = ['github.com', 'api.github.com'] as const
/** Command use is recorded at most this often per agent and credential: every command reads the environment. */
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

/** A migrated command account keeps its id inside the credential id, so grants of `commandAccounts` still resolve. */
export const credentialIdOfAccount = (accountId: string): CredentialId | undefined => {
  const parsed = CredentialIdSchema.safeParse(`crd_${accountId}`)
  return parsed.success ? parsed.data : undefined
}
/** The command account id the older account routes show for a GitHub credential. */
export const accountIdOfCredential = (id: CredentialId): string => id.slice('crd_'.length)

export interface CredentialStore {
  save(secret: string): Promise<string>
  resolve(reference: string): Promise<string>
  delete(reference: string): Promise<void>
}

export interface CredentialLibraryRepository {
  readonly credentials: CredentialsRepository
  getSystemSetting(key: string): SystemSettingRecord | undefined
}

export interface CredentialLibraryOptions {
  readonly secrets: SecretRegistry
  readonly now?: () => number
  readonly nextId?: () => string
  readonly fetch?: typeof fetch
  /** The GitHub CLI program, when there is one; reads the logins the local `gh` holds. */
  readonly githubCli?: () => string | undefined
  /** Agents that hold a `commandAccounts` grant per account id; read once when the older library is migrated. */
  readonly accountGrants?: () => ReadonlyMap<string, readonly AgentId[]>
}

export interface CredentialUseInput {
  readonly credentialId: CredentialId
  readonly agentId?: AgentId | undefined
  readonly channelId?: ChannelId | undefined
  readonly requesterMemberId?: string | undefined
  readonly consumerKind: CredentialConsumerKind
  readonly consumerId: string
  readonly targetHost?: string | undefined
}

/** A credential cleared for one use, with its value. */
export interface UsableCredential {
  readonly record: CredentialRecord
  readonly value: string
}

const sameName = (left: string, right: string): boolean => left.trim().toLowerCase() === right.trim().toLowerCase()

/** A credential only filled into requests goes nowhere without a domain. */
const assertRequestDomains = (usage: CredentialUsage, domains: readonly string[]): void => {
  if (usage === 'request' && domains.length === 0) {
    throw new CredentialError('仅用于网络请求的凭据需要至少一个允许的域名。')
  }
}

/**
 * The named credential library (智能体扩展配置与凭据 C1–C5). It owns the metadata rows and their values in the local
 * credential store, keeps the values in memory (a command's environment is built synchronously, and a removed
 * credential must stop working at the next use), and registers each value for redaction under the credential's name.
 * Values never leave through any view.
 */
export class CredentialLibrary {
  readonly #repository: CredentialLibraryRepository
  readonly #store: CredentialStore
  readonly #secrets: SecretRegistry
  readonly #now: () => number
  readonly #nextId: () => string
  readonly #fetch: typeof fetch
  readonly #githubCli: () => string | undefined
  readonly #accountGrants: () => ReadonlyMap<string, readonly AgentId[]>
  readonly #values = new Map<CredentialId, string>()
  readonly #listeners = new Set<() => void>()
  readonly #commandUses = new Map<string, number>()
  #records: readonly CredentialRecord[] = []
  #queue: Promise<unknown> = Promise.resolve()

  constructor(repository: CredentialLibraryRepository, store: CredentialStore, options: CredentialLibraryOptions) {
    this.#repository = repository
    this.#store = store
    this.#secrets = options.secrets
    this.#now = options.now ?? Date.now
    this.#nextId = options.nextId ?? (() => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`)
    this.#fetch = options.fetch ?? fetch
    this.#githubCli = options.githubCli ?? (() => undefined)
    this.#accountGrants = options.accountGrants ?? (() => new Map())
  }

  /**
   * Moves accounts of the older command account library in (idempotent), then loads every value. A credential whose
   * value cannot be read stays listed but unusable.
   */
  async prepare(): Promise<void> {
    this.#migrateCommandAccounts()
    this.#records = this.#repository.credentials.listCredentials()
    this.#values.clear()
    for (const record of this.#records) {
      try {
        const value = await this.#store.resolve(record.credentialRef)
        this.#values.set(record.id, value)
        this.#secrets.register(value, { label: record.name })
      } catch {
        // Listed with `available: false`; it can be replaced or removed.
      }
    }
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  list(): readonly CredentialRecord[] {
    return this.#records
  }

  get(id: CredentialId): CredentialRecord | undefined {
    return this.#records.find((record) => record.id === id)
  }

  /** By id, or by name ignoring case. */
  find(reference: string): CredentialRecord | undefined {
    const query = reference.trim()
    return (
      this.#records.find((record) => record.id === query) ??
      this.#records.find((record) => sameName(record.name, query))
    )
  }

  available(id: CredentialId): boolean {
    return this.#values.has(id)
  }

  /** The stored value for an administrator's own action (testing a form); agents and extensions go through `usable`. */
  valueOf(id: CredentialId): string | undefined {
    return this.#values.get(id)
  }

  /** False when the value is too short to hide from tool results, or cannot be read. */
  redactable(id: CredentialId): boolean {
    return (this.#values.get(id)?.length ?? 0) >= CREDENTIAL_REDACTABLE_MIN_CHARS
  }

  /** Whether `agentId` is in the credential's scope; host-layer callers without an agent need a scope of all agents. */
  inScope(record: CredentialRecord, agentId: AgentId | undefined): boolean {
    if ('all' in record.agentScope) return true
    return agentId !== undefined && record.agentScope.agentIds.includes(agentId)
  }

  /**
   * The value for one use when the agent is in scope and the usage allows it: `program` reads need a credential that
   * allows program use; `request` (a placeholder filled by the host) takes either. Returns `undefined` otherwise, as
   * if nothing were set.
   */
  usable(
    id: CredentialId,
    agentId: AgentId | undefined,
    purpose: CredentialUsage,
  ): UsableCredential | { readonly denied: string } | undefined {
    const record = this.get(id)
    const value = this.#values.get(id)
    if (record === undefined || value === undefined) return undefined
    if (!this.inScope(record, agentId)) return { denied: `凭据「${record.name}」不对这个智能体开放。` }
    if (purpose === 'program' && record.usage !== 'program') {
      return { denied: `凭据「${record.name}」只用于网络请求，代码读不到它的值，请改用占位符。` }
    }
    return { record, value }
  }

  recordUse(input: CredentialUseInput): void {
    const at = this.#now()
    if (input.consumerKind === 'command') {
      const key = `${input.credentialId}\0${input.agentId ?? ''}`
      const last = this.#commandUses.get(key)
      if (last !== undefined && at - last < COMMAND_USE_RECORD_INTERVAL_MS) return
      this.#commandUses.set(key, at)
    }
    try {
      this.#repository.credentials.recordCredentialUse({
        credentialId: input.credentialId,
        at,
        ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
        ...(input.channelId === undefined ? {} : { channelId: input.channelId }),
        ...(input.requesterMemberId === undefined ? {} : { requesterMemberId: input.requesterMemberId }),
        consumerKind: input.consumerKind,
        consumerId: input.consumerId,
        ...(input.targetHost === undefined ? {} : { targetHost: input.targetHost }),
      })
    } catch (error) {
      // A use of a credential removed in the meantime has nothing to attach to; other failures surface in logs.
      if (this.get(input.credentialId) !== undefined) console.warn('[nekro-nxt] 凭据使用记录写入失败：', error)
    }
  }

  uses(id: CredentialId, limit = 200) {
    return this.#repository.credentials.listCredentialUses(id, limit)
  }

  localGithubLogins(): Promise<Array<{ login: string; active: boolean }>> {
    return localGithubLogins(this.#githubCli())
  }

  create(input: z.input<typeof CreateCredentialRequestSchema>): Promise<CredentialRecord> {
    const request = CreateCredentialRequestSchema.parse(input)
    return this.#serialized(async () => {
      let value: string
      let name: string
      let metadata: CredentialRecord['metadata'] = {}
      let usage: CredentialUsage
      let domains: readonly string[]
      if (request.kind === 'github') {
        value = await githubTokenOf(request.github, this.#githubCli())
        const identity = await verifyGithubToken(this.#fetch, value)
        metadata = {
          login: identity.login,
          source: request.github.source,
          ...(identity.scopes === undefined ? {} : { scopes: identity.scopes }),
        }
        name = request.name ?? this.#freeName(`GitHub ${identity.login}`)
        usage = 'program'
        domains = request.domains ?? GITHUB_DOMAINS
      } else {
        value = request.value
        name = request.name
        usage = request.usage
        domains = request.domains
      }
      if (value.trim() === '') throw new CredentialError('凭据的值不能为空。')
      assertRequestDomains(usage, domains)
      this.#assertFreeName(name)
      const reference = await this.#store.save(value)
      const now = this.#now()
      const record: CredentialRecord = {
        id: CredentialIdSchema.parse(`crd_${this.#nextId()}`),
        name,
        description: request.description,
        kind: request.kind,
        usage,
        domains: [...new Set(domains)],
        agentScope: request.agentScope,
        autoUse: request.autoUse,
        credentialRef: reference,
        metadata,
        createdAt: now,
        updatedAt: now,
      }
      try {
        this.#repository.credentials.insertCredential(record)
      } catch (error) {
        await this.#store.delete(reference).catch(() => undefined)
        throw error
      }
      this.#values.set(record.id, value)
      this.#secrets.register(value, { label: record.name })
      this.#reload()
      return record
    })
  }

  update(id: CredentialId, patch: UpdateCredentialRequest): Promise<CredentialRecord> {
    return this.#serialized(() => {
      const current = this.#require(id)
      if (current.kind === 'github' && patch.usage === 'request') {
        throw new CredentialError('GitHub 账号给命令使用，需要允许程序读取。')
      }
      if (patch.name !== undefined && !sameName(patch.name, current.name)) this.#assertFreeName(patch.name)
      assertRequestDomains(patch.usage ?? current.usage, patch.domains ?? current.domains)
      const next: CredentialRecord = {
        ...current,
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.description === undefined ? {} : { description: patch.description }),
        ...(patch.usage === undefined ? {} : { usage: patch.usage }),
        ...(patch.domains === undefined ? {} : { domains: [...new Set(patch.domains)] }),
        ...(patch.agentScope === undefined ? {} : { agentScope: patch.agentScope }),
        ...(patch.autoUse === undefined ? {} : { autoUse: patch.autoUse }),
        updatedAt: this.#now(),
      }
      if (!this.#repository.credentials.updateCredential(next)) throw new CredentialError('没有找到这个凭据。')
      const value = this.#values.get(id)
      if (value !== undefined && next.name !== current.name) this.#secrets.register(value, { label: next.name })
      this.#reload()
      return Promise.resolve(next)
    })
  }

  /** Stores a new value; a GitHub credential only takes a token of the same GitHub account. */
  replaceValue(id: CredentialId, request: ReplaceCredentialValueRequest): Promise<CredentialRecord> {
    return this.#serialized(async () => {
      const current = this.#require(id)
      let value: string
      let metadata = current.metadata
      if ('github' in request) {
        if (current.kind !== 'github') throw new CredentialError('这个凭据不是 GitHub 账号。')
        value = await this.#githubToken(request.github)
        const identity = await verifyGithubToken(this.#fetch, value)
        if (current.metadata.login !== undefined && identity.login !== current.metadata.login) {
          throw new CredentialError(`新的 token 属于 ${identity.login}，请添加为新的凭据。`)
        }
        metadata = {
          login: identity.login,
          source: request.github.source,
          ...(identity.scopes === undefined ? {} : { scopes: identity.scopes }),
        }
      } else {
        if (current.kind === 'github') throw new CredentialError('GitHub 账号要用 token 或本机登录更换。')
        value = request.value
      }
      if (value.trim() === '') throw new CredentialError('凭据的值不能为空。')
      const reference = await this.#store.save(value)
      const next: CredentialRecord = { ...current, credentialRef: reference, metadata, updatedAt: this.#now() }
      try {
        if (!this.#repository.credentials.updateCredential(next)) throw new CredentialError('没有找到这个凭据。')
      } catch (error) {
        await this.#store.delete(reference).catch(() => undefined)
        throw error
      }
      this.#values.set(id, value)
      this.#secrets.register(value, { label: next.name })
      await this.#store.delete(current.credentialRef).catch(() => undefined)
      this.#reload()
      return next
    })
  }

  /** Removes the credential at once: bindings that name it resolve to nothing from the next use. */
  remove(id: CredentialId): Promise<void> {
    return this.#serialized(async () => {
      const current = this.get(id)
      if (current === undefined) return
      this.#repository.credentials.deleteCredential(id)
      this.#values.delete(id)
      await this.#store.delete(current.credentialRef).catch(() => undefined)
      this.#reload()
    })
  }

  #githubToken(source: GithubCredentialSource): Promise<string> {
    return githubTokenOf(source, this.#githubCli())
  }

  #require(id: CredentialId): CredentialRecord {
    const record = this.get(id)
    if (record === undefined) throw new CredentialError('没有找到这个凭据。')
    return record
  }

  #assertFreeName(name: string): void {
    if (this.#records.some((record) => sameName(record.name, name))) {
      throw new CredentialError(`已经有名为「${name.trim()}」的凭据，请换一个名称。`)
    }
  }

  #freeName(base: string, taken: readonly string[] = this.#records.map((record) => record.name)): string {
    let name = base
    for (let index = 2; taken.some((existing) => sameName(existing, name)); index += 1) name = `${base} (${index})`
    return name
  }

  /**
   * The older library kept GitHub accounts in a system setting and granted them per agent. Each account becomes a
   * GitHub credential with the same id suffix and the same stored token, open to the agents that had a grant, and
   * the setting is emptied in the same transaction. Accounts found there later (an older build wrote them) are moved
   * the same way; ones already moved are skipped.
   */
  #migrateCommandAccounts(): void {
    const setting = this.#repository.getSystemSetting(COMMAND_ACCOUNTS_SETTING_KEY)
    const parsed = setting === undefined ? undefined : StoredAccountsSchema.safeParse(setting.value)
    const accounts = parsed?.success ? parsed.data.accounts : []
    if (accounts.length === 0) return
    const grants = this.#accountGrants()
    const existing = this.#repository.credentials.listCredentials()
    const taken = existing.map((record) => record.name)
    const now = this.#now()
    const records = accounts.flatMap((account): CredentialRecord[] => {
      const id = credentialIdOfAccount(account.id)
      if (id === undefined || existing.some((record) => record.id === id)) return []
      const name = this.#freeName(`GitHub ${account.login}`, taken)
      taken.push(name)
      return [
        {
          id,
          name,
          description: '',
          kind: 'github',
          usage: 'program',
          domains: [...GITHUB_DOMAINS],
          agentScope: { agentIds: [...new Set(grants.get(account.id) ?? [])] },
          autoUse: true,
          credentialRef: account.credentialRef,
          metadata: {
            login: account.login,
            source: account.source,
            ...(account.scopes === undefined ? {} : { scopes: account.scopes }),
          },
          createdAt: account.createdAt,
          updatedAt: now,
        },
      ]
    })
    const emptied: JsonValue = { version: 1, accounts: [] }
    this.#repository.credentials.importCredentials(records, {
      key: COMMAND_ACCOUNTS_SETTING_KEY,
      value: emptied,
      updatedAt: now,
    })
  }

  #reload(): void {
    this.#records = this.#repository.credentials.listCredentials()
    for (const listener of this.#listeners) listener()
  }

  #serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work, work)
    this.#queue = next.catch(() => undefined)
    return next
  }
}
