import {
  CREDENTIAL_REDACTABLE_MIN_CHARS,
  CredentialIdSchema,
  CreateCredentialRequestSchema,
  type AgentId,
  type ChannelId,
  type CredentialId,
  type CredentialUsage,
  type ReplaceCredentialValueRequest,
  type UpdateCredentialRequest,
} from '@nekro-nxt/contracts'
import type { CredentialConsumerKind, CredentialRecord, CredentialsRepository } from '@nekro-nxt/storage-sqlite'
import type { z } from 'zod'
import type { SecretRegistry } from './secret-registry.js'

/** A message safe to show the user: what failed, without the value. */
export class CredentialError extends Error {}

/** Secret config fields bound to a named credential hold this reference instead of a store reference. */
export const NAMED_CREDENTIAL_PREFIX = 'credential:named:'

export const namedCredentialReference = (id: CredentialId): string => `${NAMED_CREDENTIAL_PREFIX}${id}`

/** The credential a config value names, or `undefined` for any other value. */
export const namedCredentialId = (value: unknown): CredentialId | undefined => {
  if (typeof value !== 'string' || !value.startsWith(NAMED_CREDENTIAL_PREFIX)) return undefined
  const parsed = CredentialIdSchema.safeParse(value.slice(NAMED_CREDENTIAL_PREFIX.length))
  return parsed.success ? parsed.data : undefined
}

/** Command use is recorded at most this often per agent and credential: every command reads the environment. */
const COMMAND_USE_RECORD_INTERVAL_MS = 10 * 60 * 1000

export interface CredentialStore {
  save(secret: string): Promise<string>
  resolve(reference: string): Promise<string>
  delete(reference: string): Promise<void>
}

export interface CredentialLibraryRepository {
  readonly credentials: CredentialsRepository
}

export interface CredentialLibraryOptions {
  readonly secrets: SecretRegistry
  readonly now?: () => number
  readonly nextId?: () => string
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

/** The variable commands receive a credential under: program credentials that have one. */
export const commandEnvName = (record: Pick<CredentialRecord, 'usage' | 'envName'>): string | undefined =>
  record.usage !== 'program' ? undefined : record.envName

const scopesOverlap = (left: CredentialRecord['agentScope'], right: CredentialRecord['agentScope']): boolean =>
  'all' in left || 'all' in right || left.agentIds.some((agentId) => right.agentIds.includes(agentId))

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
  }

  /** Loads every value. A credential whose value cannot be read stays listed but unusable. */
  async prepare(): Promise<void> {
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

  /**
   * Credentials this agent's commands receive (智能体扩展配置与凭据 C2、C3): program credentials in its scope that have
   * an environment variable, used automatically or approved for this agent. When two claim the same variable (possible
   * only for data written before the check), the older one wins. Linked accounts the agent is granted come on top.
   */
  commandCredentials(agentId: AgentId): Array<UsableCredential & { readonly env: string }> {
    const claimed = new Set<string>()
    return this.#records.flatMap((record) => {
      const env = commandEnvName(record)
      const value = this.#values.get(record.id)
      if (env === undefined || value === undefined) return []
      if (!this.inScope(record, agentId) || this.needsApproval(record, agentId)) return []
      if (claimed.has(env)) return []
      claimed.add(env)
      return [{ record, value, env }]
    })
  }

  /** Whether the agent may use it now, or has to ask an administrator first. */
  needsApproval(record: CredentialRecord, agentId: AgentId): boolean {
    return !record.autoUse && !record.approvedAgentIds.includes(agentId)
  }

  /** An administrator let the agent use a credential whose automatic use is off. */
  approve(id: CredentialId, agentId: AgentId): Promise<CredentialRecord> {
    return this.#serialized(() => {
      const current = this.#require(id)
      if (!this.inScope(current, agentId)) throw new CredentialError(`凭据「${current.name}」不对这个智能体开放。`)
      if (current.approvedAgentIds.includes(agentId)) return Promise.resolve(current)
      const next: CredentialRecord = {
        ...current,
        approvedAgentIds: [...current.approvedAgentIds, agentId],
        updatedAt: this.#now(),
      }
      if (!this.#repository.credentials.updateCredential(next)) throw new CredentialError('没有找到这个凭据。')
      this.#reload()
      return Promise.resolve(next)
    })
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

  create(input: z.input<typeof CreateCredentialRequestSchema>): Promise<CredentialRecord> {
    return this.#serialized(async () => {
      const request = CreateCredentialRequestSchema.parse(input)
      const { value, name, usage, domains, envName } = request
      if (value.trim() === '') throw new CredentialError('凭据的值不能为空。')
      assertRequestDomains(usage, domains)
      this.#assertFreeName(name)
      this.#assertFreeEnv(
        { usage, agentScope: request.agentScope, ...(envName === undefined ? {} : { envName }) },
        undefined,
      )
      const reference = await this.#store.save(value)
      const now = this.#now()
      const record: CredentialRecord = {
        id: CredentialIdSchema.parse(`crd_${this.#nextId()}`),
        name,
        description: request.description,
        usage,
        domains: [...new Set(domains)],
        agentScope: request.agentScope,
        autoUse: request.autoUse,
        ...(envName === undefined ? {} : { envName }),
        approvedAgentIds: [],
        credentialRef: reference,
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
      if (patch.name !== undefined && !sameName(patch.name, current.name)) this.#assertFreeName(patch.name)
      const usage = patch.usage ?? current.usage
      assertRequestDomains(usage, patch.domains ?? current.domains)
      // Only program credentials reach commands; turning one into request-only stops that.
      const envName =
        usage === 'program' ? (patch.envName === undefined ? current.envName : (patch.envName ?? undefined)) : undefined
      const { envName: _previousEnv, ...rest } = current
      void _previousEnv
      const next: CredentialRecord = {
        ...rest,
        ...(envName === undefined ? {} : { envName }),
        ...(patch.approvedAgentIds === undefined ? {} : { approvedAgentIds: [...new Set(patch.approvedAgentIds)] }),
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.description === undefined ? {} : { description: patch.description }),
        ...(patch.usage === undefined ? {} : { usage: patch.usage }),
        ...(patch.domains === undefined ? {} : { domains: [...new Set(patch.domains)] }),
        ...(patch.agentScope === undefined ? {} : { agentScope: patch.agentScope }),
        ...(patch.autoUse === undefined ? {} : { autoUse: patch.autoUse }),
        updatedAt: this.#now(),
      }
      this.#assertFreeEnv(next, id)
      if (!this.#repository.credentials.updateCredential(next)) throw new CredentialError('没有找到这个凭据。')
      const value = this.#values.get(id)
      if (value !== undefined && next.name !== current.name) this.#secrets.register(value, { label: next.name })
      this.#reload()
      return Promise.resolve(next)
    })
  }

  replaceValue(id: CredentialId, request: ReplaceCredentialValueRequest): Promise<CredentialRecord> {
    return this.#serialized(async () => {
      const current = this.#require(id)
      const value = request.value
      if (value.trim() === '') throw new CredentialError('凭据的值不能为空。')
      const reference = await this.#store.save(value)
      const next: CredentialRecord = { ...current, credentialRef: reference, updatedAt: this.#now() }
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

  /** Two credentials one agent's commands both receive cannot share a variable. */
  #assertFreeEnv(
    candidate: Pick<CredentialRecord, 'usage' | 'envName' | 'agentScope'>,
    self: CredentialId | undefined,
  ): void {
    const env = commandEnvName(candidate)
    if (env === undefined) return
    const other = this.#records.find(
      (record) =>
        record.id !== self && commandEnvName(record) === env && scopesOverlap(record.agentScope, candidate.agentScope),
    )
    if (other !== undefined) {
      throw new CredentialError(
        `凭据「${other.name}」已经以 ${env} 给同一批智能体的命令使用，请换一个环境变量名或调整可用范围。`,
      )
    }
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
