import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import {
  AgentIdSchema,
  ChannelIdSchema,
  CredentialUsageSchema,
  credentialRequestRoute,
  type AgentId,
  type ChannelId,
  type CredentialRequestView,
  type CredentialUsage,
  type JsonValue,
} from '@nekro-nxt/contracts'
import type { SystemSettingRecord } from '@nekro-nxt/storage-sqlite'

const SETTING_KEY = 'credential-requests'
/** A request waits a week; after that the agent has to ask again. */
export const CREDENTIAL_REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000
const MAX_PENDING = 50

const StoredRequestSchema = z
  .object({
    id: z.string().min(1).max(64),
    name: z.string().min(1),
    purpose: z.string(),
    domains: z.array(z.string()),
    usage: CredentialUsageSchema,
    agentId: AgentIdSchema,
    channelId: ChannelIdSchema.nullable(),
    createdAt: z.number().int().nonnegative(),
  })
  .strict()
const StoredSchema = z.object({ version: z.literal(1), requests: z.array(StoredRequestSchema) }).strict()
type StoredRequest = z.output<typeof StoredRequestSchema>

interface SettingsRepository {
  getSystemSetting(key: string): SystemSettingRecord | undefined
  putSystemSetting(
    key: string,
    value: JsonValue,
    expectedRevision: number | undefined,
    updatedAt: number,
  ): SystemSettingRecord
}

export interface CredentialRequestHooks {
  /** Tells the administrator: a client notification and push channels, with the pre-filled add form as the link. */
  readonly notify: (request: CredentialRequestView) => void
  /** Wakes the agent that asked, in the channel it asked from. */
  readonly wake: (request: CredentialRequestView, credentialName: string) => void
}

const sameName = (left: string, right: string): boolean => left.trim().toLowerCase() === right.trim().toLowerCase()

/**
 * Credentials agents asked for and nobody has added yet (智能体扩展配置与凭据 C15). Saving a credential with the
 * requested name fulfils every request for that name and wakes the agents that asked.
 */
export class CredentialRequests {
  readonly #repository: SettingsRepository
  readonly #hooks: CredentialRequestHooks
  readonly #now: () => number

  constructor(repository: SettingsRepository, hooks: CredentialRequestHooks, now: () => number = Date.now) {
    this.#repository = repository
    this.#hooks = hooks
    this.#now = now
  }

  list(): readonly CredentialRequestView[] {
    return this.#read().requests.map(view)
  }

  /** Files a request; asking again for the same name from the same agent keeps the first one. */
  create(input: {
    readonly agentId: AgentId
    readonly channelId: ChannelId | undefined
    readonly name: string
    readonly purpose: string
    readonly domains: readonly string[]
    readonly usage: CredentialUsage
  }): { readonly request: CredentialRequestView; readonly repeated: boolean } {
    const current = this.#read()
    const existing = current.requests.find(
      (request) => request.agentId === input.agentId && sameName(request.name, input.name),
    )
    if (existing !== undefined) return { request: view(existing), repeated: true }
    const stored: StoredRequest = {
      id: `crq_${randomBytes(8).toString('hex')}`,
      name: input.name.trim(),
      purpose: input.purpose.trim(),
      domains: [...new Set(input.domains)],
      usage: input.usage,
      agentId: input.agentId,
      channelId: input.channelId ?? null,
      createdAt: this.#now(),
    }
    this.#write([...current.requests, stored].slice(-MAX_PENDING), current.revision)
    const request = view(stored)
    this.#hooks.notify(request)
    return { request, repeated: false }
  }

  dismiss(id: string): void {
    const current = this.#read()
    if (!current.requests.some((request) => request.id === id)) return
    this.#write(
      current.requests.filter((request) => request.id !== id),
      current.revision,
    )
  }

  /** A credential named `name` now exists: wakes every agent that asked for it and closes their requests. */
  fulfil(name: string): void {
    const current = this.#read()
    const matched = current.requests.filter((request) => sameName(request.name, name))
    if (matched.length === 0) return
    this.#write(
      current.requests.filter((request) => !matched.includes(request)),
      current.revision,
    )
    for (const request of matched) this.#hooks.wake(view(request), name.trim())
  }

  #read(): { readonly requests: readonly StoredRequest[]; readonly revision: number | undefined } {
    const record = this.#repository.getSystemSetting(SETTING_KEY)
    const parsed = record === undefined ? undefined : StoredSchema.safeParse(record.value)
    const since = this.#now() - CREDENTIAL_REQUEST_TTL_MS
    return {
      requests: parsed?.success ? parsed.data.requests.filter((request) => request.createdAt >= since) : [],
      revision: record?.revision,
    }
  }

  #write(requests: readonly StoredRequest[], revision: number | undefined): void {
    this.#repository.putSystemSetting(SETTING_KEY, { version: 1, requests: [...requests] }, revision, this.#now())
  }
}

const view = (request: StoredRequest): CredentialRequestView => ({
  ...request,
  domains: [...request.domains],
  route: credentialRequestRoute(request),
})
