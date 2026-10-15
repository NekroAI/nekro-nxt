import { randomInt } from 'node:crypto'
import type { ConnectionId, PlatformIdentityId } from '@nekro-nxt/contracts'
import type { SqliteCoreRepository } from '@nekro-nxt/storage-sqlite'

const CLAIM_TTL_MS = 10 * 60_000
const CLAIM_MAX_FAILURES = 5

export interface AdministratorView {
  readonly connectionId: ConnectionId
  readonly connectionName: string
  readonly platformUserId: string
  readonly identityId?: PlatformIdentityId
  readonly displayName: string
  readonly addedVia: 'console' | 'claim'
  readonly addedAt: number
}

/**
 * Instance administrators (系统级管理员): whoever signed in to the console, plus the platform accounts listed here.
 * Platform accounts are told apart per connection, the same way the user directory does; nicknames and group roles
 * never make anyone an administrator.
 */
export class AdministratorService {
  readonly #repository: SqliteCoreRepository
  readonly #now: () => number
  readonly #connectionName: (connectionId: ConnectionId) => string
  #claim: { readonly code: string; readonly expiresAt: number; failures: number } | undefined

  constructor(input: {
    readonly repository: SqliteCoreRepository
    readonly connectionName: (connectionId: ConnectionId) => string
    readonly now?: () => number
  }) {
    this.#repository = input.repository
    this.#connectionName = input.connectionName
    this.#now = input.now ?? Date.now
  }

  list(): readonly AdministratorView[] {
    const identities = new Map(
      this.#repository
        .listPlatformUsers()
        .flatMap((user) => {
          const identity = this.#repository.getPlatformIdentity(user.identityId)
          return identity === undefined ? [] : [[`${identity.connectionId}\u0000${identity.platformUserId}`, identity] as const]
        }),
    )
    return this.#repository.listInstanceAdministrators().map((record) => {
      const identity = identities.get(`${record.connectionId}\u0000${record.platformUserId}`)
      return {
        connectionId: record.connectionId,
        connectionName: this.#connectionName(record.connectionId),
        platformUserId: record.platformUserId,
        ...(identity === undefined ? {} : { identityId: identity.id }),
        displayName: identity?.displayName ?? record.label,
        addedVia: record.addedVia,
        addedAt: record.addedAt,
      }
    })
  }

  isAdministrator(connectionId: ConnectionId | undefined, platformUserId: string | undefined): boolean {
    if (connectionId === undefined || platformUserId === undefined) return false
    return this.#repository.isInstanceAdministrator(connectionId, platformUserId)
  }

  /** Adds an account from the user directory. The connection's own account and local agents cannot be one. */
  add(identityId: PlatformIdentityId): AdministratorView {
    const identity = this.#repository.getPlatformIdentity(identityId)
    if (!identity) throw new Error('找不到这个用户。')
    if (identity.self !== undefined) throw new Error('机器人自己的账号不能设为管理员。')
    this.#repository.addInstanceAdministrator({
      connectionId: identity.connectionId,
      platformUserId: identity.platformUserId,
      label: identity.displayName ?? identity.platformUserId,
      addedVia: 'console',
      addedAt: this.#now(),
    })
    return this.#require(identity.connectionId, identity.platformUserId)
  }

  remove(connectionId: ConnectionId, platformUserId: string): void {
    if (!this.#repository.removeInstanceAdministrator(connectionId, platformUserId)) throw new Error('这个账号不是管理员。')
  }

  /** A six-digit code shown only in the console; whoever sends it in chat within ten minutes becomes administrator. */
  createClaimCode(): { readonly code: string; readonly expiresAt: number } {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    const expiresAt = this.#now() + CLAIM_TTL_MS
    this.#claim = { code, expiresAt, failures: 0 }
    return { code, expiresAt }
  }

  /** Redeems the current code for the sender's account; wrong guesses use the code up after five tries. */
  claim(input: {
    readonly code: string
    readonly connectionId: ConnectionId
    readonly platformUserId: string
    readonly displayName: string
    readonly self: boolean
  }): AdministratorView {
    const claim = this.#claim
    if (!claim || claim.expiresAt <= this.#now()) {
      this.#claim = undefined
      throw new Error('认领码已失效，请在 NekroNXT 设置的「管理员」里重新生成。')
    }
    if (input.self) throw new Error('机器人自己的账号不能设为管理员。')
    if (input.code.trim() !== claim.code) {
      claim.failures += 1
      if (claim.failures >= CLAIM_MAX_FAILURES) this.#claim = undefined
      throw new Error('认领码不正确。')
    }
    this.#claim = undefined
    this.#repository.addInstanceAdministrator({
      connectionId: input.connectionId,
      platformUserId: input.platformUserId,
      label: input.displayName,
      addedVia: 'claim',
      addedAt: this.#now(),
    })
    return this.#require(input.connectionId, input.platformUserId)
  }

  #require(connectionId: ConnectionId, platformUserId: string): AdministratorView {
    const view = this.list().find((entry) => entry.connectionId === connectionId && entry.platformUserId === platformUserId)
    if (!view) throw new Error('管理员记录写入失败。')
    return view
  }
}
