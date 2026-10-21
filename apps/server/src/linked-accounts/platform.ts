import type {
  AgentId,
  CommandAccountUsage,
  LinkedAccountMethod,
  LinkedAccountPlatformId,
  LinkedAccountTokenSource,
} from '@nekro-nxt/contracts'
import type { GithubCliStatus } from '../github-cli.js'

/** A message safe to show the user: what failed, without the token. */
export class LinkedAccountError extends Error {}

/** Who a token belongs to, as the platform reports it. */
export interface LinkedAccountIdentity {
  readonly login: string
  /** Token scopes where the platform reports them. */
  readonly scopes?: readonly string[]
}

/** A platform's own program that accounts work through, managed by the runtime download routes. */
export interface LinkedAccountPlatformTool {
  readonly id: 'github-cli'
  readonly name: string
  readonly availability: GithubCliStatus
}

/**
 * One platform accounts can be linked on (设置 → 关联账号). The library stores accounts and their tokens; a platform
 * knows how to obtain and verify a token, what a command needs to act as the account, and what to tell the agent.
 * Adding a platform means implementing this interface and registering it; grants already name the platform.
 */
export interface LinkedAccountPlatform {
  readonly id: LinkedAccountPlatformId
  readonly name: string
  readonly addMethods: readonly LinkedAccountMethod[]
  /** The token a request names: typed, or read once from the platform's local CLI. */
  tokenOf(source: LinkedAccountTokenSource): Promise<string>
  /** Asks the platform whose token this is; rejects with {@link LinkedAccountError} when it is not accepted. */
  verify(token: string): Promise<LinkedAccountIdentity>
  /** Whether a newly verified token belongs to the account already linked; replacing a token keeps the account. */
  sameAccount(current: { readonly login: string }, next: LinkedAccountIdentity): boolean
  /**
   * Variables an agent's commands receive to act as the account. Read when each command starts, so they must not
   * write the token into any file.
   */
  commandEnvironment(input: {
    readonly agentId: AgentId
    readonly token: string
    readonly basePath?: string | undefined
  }): Record<string, string>
  /** What the agent is told about the account and how to use it; never the token. */
  promptLines(input: { readonly login: string; readonly usage: readonly CommandAccountUsage[] }): string[]
  /** The platform's program, when it has one the user can download or remove. */
  tool?(): LinkedAccountPlatformTool
  /** Logins the platform's local CLI holds, offered when adding an account. */
  localLogins?(): Promise<Array<{ login: string; active: boolean }>>
}

/** The platforms this host supports, in display order. */
export class LinkedAccountPlatforms {
  readonly #platforms: readonly LinkedAccountPlatform[]

  constructor(platforms: readonly LinkedAccountPlatform[]) {
    if (new Set(platforms.map((platform) => platform.id)).size !== platforms.length) {
      throw new Error('Linked account platforms must have distinct ids.')
    }
    this.#platforms = platforms
  }

  list(): readonly LinkedAccountPlatform[] {
    return this.#platforms
  }

  get(id: string): LinkedAccountPlatform | undefined {
    return this.#platforms.find((platform) => platform.id === id)
  }

  require(id: string): LinkedAccountPlatform {
    const platform = this.get(id)
    if (platform === undefined) throw new LinkedAccountError('这台设备不支持这个平台的账号。')
    return platform
  }
}
