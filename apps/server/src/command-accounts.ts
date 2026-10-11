import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { promisify } from 'node:util'
import { z } from 'zod'
import { JsonValueSchema, type AddCommandAccountRequest, type AgentId, type CommandAccount } from '@nekro-nxt/contracts'
import type { SystemSettingRecord } from '@nekro-nxt/storage-sqlite'
import type { LocalCredentialStore } from './credentials.js'

const run = promisify(execFile)

const COMMAND_ACCOUNTS_SETTING_KEY = 'command-accounts'
const GITHUB_API_USER_URL = 'https://api.github.com/user'
const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u

const StoredAccountSchema = z
  .object({
    id: z.string().min(1).max(64),
    service: z.literal('github'),
    login: z.string().min(1),
    source: z.enum(['token', 'gh-login']),
    scopes: z.array(z.string()).optional(),
    credentialRef: z.string().min(1),
    createdAt: z.number().int().nonnegative(),
  })
  .strict()

const StoredAccountsSchema = z.object({ version: z.literal(1), accounts: z.array(StoredAccountSchema) }).strict()

type StoredAccount = z.infer<typeof StoredAccountSchema>

interface CommandAccountsRepository {
  getSystemSetting(key: string): SystemSettingRecord | undefined
  putSystemSetting(
    key: string,
    value: z.infer<typeof JsonValueSchema>,
    expectedRevision: number | undefined,
    updatedAt: number,
  ): SystemSettingRecord
}

export interface CommandAccountsOptions {
  readonly fetch?: typeof fetch
  readonly now?: () => number
  /** The GitHub CLI program, when there is one; reads the logins the local `gh` holds. */
  readonly githubCli?: () => string | undefined
}

/** A message safe to show the user: what failed, without the token. */
export class CommandAccountError extends Error {}

interface GithubIdentity {
  readonly login: string
  readonly scopes?: string[]
}

/**
 * The host's account library. It keeps accounts and their tokens; an account reaches an agent's commands only
 * through that agent's grant. Tokens are held in memory as well, because a command's environment is built
 * synchronously and a removed account must stop working at the next command.
 */
export class CommandAccountService {
  readonly #repository: CommandAccountsRepository
  readonly #credentials: LocalCredentialStore
  readonly #fetch: typeof fetch
  readonly #now: () => number
  readonly #githubCli: () => string | undefined
  readonly #tokens = new Map<string, string>()
  readonly #listeners = new Set<() => void>()
  #accounts: readonly StoredAccount[] = []
  #queue: Promise<unknown> = Promise.resolve()

  constructor(
    repository: CommandAccountsRepository,
    credentials: LocalCredentialStore,
    options: CommandAccountsOptions = {},
  ) {
    this.#repository = repository
    this.#credentials = credentials
    this.#fetch = options.fetch ?? fetch
    this.#now = options.now ?? Date.now
    this.#githubCli = options.githubCli ?? (() => undefined)
  }

  /** Reads the library and loads every token; an account whose token is gone stays listed but unusable. */
  async prepare(): Promise<void> {
    const record = this.#repository.getSystemSetting(COMMAND_ACCOUNTS_SETTING_KEY)
    const parsed = record === undefined ? undefined : StoredAccountsSchema.safeParse(record.value)
    this.#accounts = parsed?.success ? parsed.data.accounts : []
    this.#tokens.clear()
    for (const account of this.#accounts) {
      try {
        this.#tokens.set(account.id, await this.#credentials.resolve(account.credentialRef))
      } catch {
        // The account stays in the library; commands simply get no token for it.
      }
    }
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** The token to give commands for one account, or `undefined` when it was removed or cannot be read. */
  tokenFor(accountId: string): string | undefined {
    return this.#tokens.get(accountId)
  }

  loginOf(accountId: string): string | undefined {
    return this.#accounts.find((account) => account.id === accountId)?.login
  }

  has(accountId: string): boolean {
    return this.#accounts.some((account) => account.id === accountId)
  }

  list(usedBy: ReadonlyMap<string, readonly AgentId[]> = new Map()): CommandAccount[] {
    return this.#accounts.map((account) => ({
      id: account.id,
      service: account.service,
      login: account.login,
      source: account.source,
      ...(account.scopes === undefined ? {} : { scopes: account.scopes }),
      createdAt: account.createdAt,
      usedBy: [...(usedBy.get(account.id) ?? [])],
    }))
  }

  /** Logins the local GitHub CLI holds; empty when it is missing, logged out or too old to say. */
  async localLogins(): Promise<Array<{ login: string; active: boolean }>> {
    const executable = this.#githubCli()
    if (executable === undefined) return []
    try {
      const { stdout } = await run(executable, ['auth', 'status', '--hostname', 'github.com', '--json', 'hosts'], {
        timeout: 15_000,
      })
      const parsed = z
        .object({
          hosts: z.record(
            z.string(),
            z.array(z.object({ login: z.string(), active: z.boolean(), state: z.string() }).passthrough()),
          ),
        })
        .safeParse(JSON.parse(stdout))
      if (!parsed.success) return []
      return (parsed.data.hosts['github.com'] ?? [])
        .filter((entry) => entry.state === 'success' && LOGIN_PATTERN.test(entry.login))
        .map((entry) => ({ login: entry.login, active: entry.active }))
    } catch {
      return []
    }
  }

  add(request: AddCommandAccountRequest): Promise<void> {
    return this.#serialized(async () => {
      const token = await this.#tokenOf(request)
      const identity = await this.#verify(token)
      const reference = await this.#credentials.save(token)
      const account: StoredAccount = {
        id: randomBytes(8).toString('hex'),
        service: request.service,
        login: identity.login,
        source: request.source,
        ...(identity.scopes === undefined ? {} : { scopes: identity.scopes }),
        credentialRef: reference,
        createdAt: this.#now(),
      }
      try {
        this.#write([...this.#accounts, account])
      } catch (error) {
        await this.#credentials.delete(reference)
        throw error
      }
      this.#tokens.set(account.id, token)
      this.#notify()
    })
  }

  /** Swaps the token of an account for a new one of the same GitHub account; grants keep pointing at it. */
  replaceToken(accountId: string, request: AddCommandAccountRequest): Promise<void> {
    return this.#serialized(async () => {
      const current = this.#accounts.find((account) => account.id === accountId)
      if (current === undefined) throw new CommandAccountError('没有找到这个账号。')
      const token = await this.#tokenOf(request)
      const identity = await this.#verify(token)
      if (identity.login !== current.login) {
        throw new CommandAccountError(`新的 token 属于 ${identity.login}，请添加为新账号。`)
      }
      const reference = await this.#credentials.save(token)
      const next: StoredAccount = {
        id: current.id,
        service: current.service,
        login: current.login,
        source: request.source,
        ...(identity.scopes === undefined ? {} : { scopes: identity.scopes }),
        credentialRef: reference,
        createdAt: current.createdAt,
      }
      try {
        this.#write(this.#accounts.map((account) => (account.id === accountId ? next : account)))
      } catch (error) {
        await this.#credentials.delete(reference)
        throw error
      }
      this.#tokens.set(accountId, token)
      await this.#credentials.delete(current.credentialRef).catch(() => undefined)
      this.#notify()
    })
  }

  remove(accountId: string): Promise<void> {
    return this.#serialized(async () => {
      const current = this.#accounts.find((account) => account.id === accountId)
      if (current === undefined) return
      this.#write(this.#accounts.filter((account) => account.id !== accountId))
      this.#tokens.delete(accountId)
      await this.#credentials.delete(current.credentialRef).catch(() => undefined)
      this.#notify()
    })
  }

  async #tokenOf(request: AddCommandAccountRequest): Promise<string> {
    if (request.source === 'token') return request.token.trim()
    if (!LOGIN_PATTERN.test(request.login)) throw new CommandAccountError('账号名不合法。')
    const executable = this.#githubCli()
    if (executable === undefined) throw new CommandAccountError('这台设备上没有 GitHub CLI。')
    try {
      const { stdout } = await run(executable, ['auth', 'token', '--hostname', 'github.com', '--user', request.login], {
        timeout: 15_000,
      })
      const token = stdout.trim()
      if (token === '') throw new Error('empty')
      return token
    } catch {
      throw new CommandAccountError(`没有取到 ${request.login} 的登录，请先在终端里用 gh auth login 登录。`)
    }
  }

  async #verify(token: string): Promise<GithubIdentity> {
    let response: Response
    try {
      response = await this.#fetch(GITHUB_API_USER_URL, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'user-agent': 'NekroNXT',
          'x-github-api-version': '2022-11-28',
        },
        signal: AbortSignal.timeout(15_000),
      })
    } catch {
      throw new CommandAccountError('连不上 GitHub，检查网络后再试。')
    }
    if (response.status === 401) throw new CommandAccountError('GitHub 不接受这个 token，可能已过期或被撤销。')
    if (!response.ok) throw new CommandAccountError(`GitHub 返回了 ${response.status}，稍后再试。`)
    const body = z.object({ login: z.string() }).safeParse(await response.json())
    if (!body.success || !LOGIN_PATTERN.test(body.data.login)) {
      throw new CommandAccountError('GitHub 没有返回账号名。')
    }
    const login = body.data.login
    const header = response.headers.get('x-oauth-scopes')
    return {
      login,
      ...(header === null
        ? {}
        : {
            scopes: header
              .split(',')
              .map((scope) => scope.trim())
              .filter((scope) => scope !== ''),
          }),
    }
  }

  #write(accounts: readonly StoredAccount[]): void {
    const current = this.#repository.getSystemSetting(COMMAND_ACCOUNTS_SETTING_KEY)
    this.#repository.putSystemSetting(
      COMMAND_ACCOUNTS_SETTING_KEY,
      JsonValueSchema.parse({ version: 1, accounts }),
      current?.revision,
      this.#now(),
    )
    this.#accounts = accounts
  }

  #serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work, work)
    this.#queue = next.catch(() => undefined)
    return next
  }

  #notify(): void {
    for (const listener of this.#listeners) listener()
  }
}
