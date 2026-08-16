import type { AdapterInboundEvent } from '@nekro-nxt/adapter-sdk'
import type {
  AgentId,
  AgentRevisionId,
  BindingId,
  ChannelEventId,
  ChannelId,
  ChannelMemberId,
  ConnectionId,
  JsonValue,
  LogicalMessageId,
  MessagePart,
  PlatformIdentityId,
} from '@nekro-nxt/contracts'
import { createHash } from 'node:crypto'
import { monotonicFactory } from 'ulid'
import { z } from 'zod'

export * from './assets.js'

export interface AgentModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

export interface AgentCapabilityGrants {
  readonly dynamicCreation: boolean
  readonly developmentShell: boolean
  readonly fullFileAccess: boolean
}

export interface AgentRevisionContent {
  readonly displayName: string
  readonly persona: string
  readonly model: AgentModelSelection
  readonly capabilities?: Partial<AgentCapabilityGrants>
  readonly settings?: JsonValue
}

export interface AgentDefinitionRecord {
  readonly id: AgentId
  readonly currentRevisionId: AgentRevisionId
  readonly createdAt: number
}

export interface AgentRevisionRecord extends Omit<AgentRevisionContent, 'capabilities'> {
  readonly id: AgentRevisionId
  readonly agentId: AgentId
  readonly revision: number
  readonly capabilities: AgentCapabilityGrants
  readonly contentDigest: string
  readonly createdAt: number
}

export interface ConnectionRecord {
  readonly id: ConnectionId
  readonly adapterKey: string
  readonly config: JsonValue
  readonly credentialRefs: Readonly<Record<string, string>>
  readonly status: 'configured' | 'active' | 'stopped' | 'failed'
  readonly createdAt: number
}

export interface ChannelRecord {
  readonly id: ChannelId
  readonly connectionId: ConnectionId
  readonly platformChannelId: string
  readonly kind: 'web' | 'direct' | 'group'
  readonly displayName?: string
  readonly createdAt: number
}

export interface PlatformIdentityRecord {
  readonly id: PlatformIdentityId
  readonly connectionId: ConnectionId
  readonly platformUserId: string
  readonly displayName?: string
  readonly firstSeenAt: number
  readonly lastSeenAt: number
  readonly seenCount: number
}

export interface ChannelMemberRecord {
  readonly id: ChannelMemberId
  readonly channelId: ChannelId
  readonly platformIdentityId: PlatformIdentityId
  readonly displayName?: string
  readonly firstSeenAt: number
  readonly lastSeenAt: number
  readonly seenCount: number
}

export type BindingTriggerPolicy = 'always' | 'mentioned-or-replied' | 'command' | 'observe-only'

export interface BindingRecord {
  readonly id: BindingId
  readonly channelId: ChannelId
  readonly agentId: AgentId
  readonly triggerPolicy: BindingTriggerPolicy
  readonly revision: number
  readonly createdAt: number
}

export interface ChannelEventRecord {
  readonly id: ChannelEventId
  readonly logicalMessageId: LogicalMessageId
  readonly connectionId: ConnectionId
  readonly channelId: ChannelId
  readonly adapterKey: string
  readonly platformEventId?: string
  readonly platformMessageId?: string
  readonly kind: AdapterInboundEvent['kind']
  readonly senderMemberId?: AdapterInboundEvent['senderMemberId']
  readonly parts: readonly MessagePart[]
  readonly platformSequence?: number
  readonly platformTimestamp: number
  readonly receivedAt: number
  readonly dedupeKey: string
  readonly facts?: Readonly<Record<string, JsonValue>>
  readonly checkpoint?: JsonValue
}

export interface PlatformMessageReferenceRecord {
  readonly logicalMessageId: LogicalMessageId
  readonly authoredByAgent: boolean
}

export interface CreateAgentCommit {
  readonly definition: AgentDefinitionRecord
  readonly revision: AgentRevisionRecord
}

export interface AppendChannelEventCommit {
  readonly event: ChannelEventRecord
  readonly inserted: boolean
  readonly checkpointCommitted: boolean
}

export interface CoreRepository {
  createAgent(commit: CreateAgentCommit): void
  getAgent(id: AgentId): CreateAgentCommit | undefined
  getAgentRevision(id: AgentRevisionId): AgentRevisionRecord | undefined
  appendAgentRevision(
    definition: AgentDefinitionRecord,
    revision: AgentRevisionRecord,
    expectedCurrentRevisionId: AgentRevisionId,
  ): void
  createConnection(record: ConnectionRecord): void
  getConnection(id: ConnectionId): ConnectionRecord | undefined
  listConnectionIdsByAdapter(adapterKey?: string): readonly ConnectionId[]
  createChannel(record: ChannelRecord): void
  ensureChannel(record: ChannelRecord): ChannelRecord
  getChannel(id: ChannelId): ChannelRecord | undefined
  getChannelByPlatformId(connectionId: ConnectionId, platformChannelId: string): ChannelRecord | undefined
  listChannelIdsByConnection(connectionId: ConnectionId): readonly ChannelId[]
  ensurePlatformIdentity(record: PlatformIdentityRecord): PlatformIdentityRecord
  getPlatformIdentity(id: PlatformIdentityId): PlatformIdentityRecord | undefined
  ensureChannelMember(record: ChannelMemberRecord): ChannelMemberRecord
  getChannelMember(id: ChannelMemberId): ChannelMemberRecord | undefined
  getChannelMemberByIdentity(
    channelId: ChannelId,
    platformIdentityId: PlatformIdentityId,
  ): ChannelMemberRecord | undefined
  createBinding(record: BindingRecord): void
  getBinding(channelId: ChannelId, agentId: AgentId): BindingRecord | undefined
  listBindings(channelId: ChannelId): readonly BindingRecord[]
  appendChannelEvent(candidate: ChannelEventRecord): AppendChannelEventCommit
  getChannelEvent(id: ChannelEventId): ChannelEventRecord | undefined
  resolvePlatformMessage(
    connectionId: ConnectionId,
    channelId: ChannelId,
    platformMessageId: string,
  ): PlatformMessageReferenceRecord | undefined
  resolveLogicalMessagePlatformId(
    connectionId: ConnectionId,
    channelId: ChannelId,
    logicalMessageId: LogicalMessageId,
  ): string | undefined
}

export interface CoreServiceOptions {
  readonly now?: () => number
  readonly nextUlid?: () => string
}

const agentRevisionContentSchema = z
  .object({
    displayName: z.string().trim().min(1).max(80),
    persona: z.string().max(64 * 1024),
    model: z
      .object({
        provider: z.string().trim().min(1),
        model: z.string().trim().min(1),
        reasoningEffort: z.string().trim().min(1).optional(),
      })
      .strict(),
    capabilities: z
      .object({
        dynamicCreation: z.boolean().default(false),
        developmentShell: z.boolean().default(false),
        fullFileAccess: z.boolean().default(false),
      })
      .strict()
      .default({ dynamicCreation: false, developmentShell: false, fullFileAccess: false }),
    settings: z.json().optional(),
  })
  .strict()

const agentCapabilityGrantsSchema = agentRevisionContentSchema.shape.capabilities

export function parseAgentCapabilityGrants(input: unknown): AgentCapabilityGrants {
  return agentCapabilityGrantsSchema.parse(input)
}

const connectionInputSchema = z
  .object({
    adapterKey: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9-]*$/),
    config: z.json(),
    credentialRefs: z.record(z.string().min(1), z.string().trim().min(1)).default({}),
  })
  .strict()

const channelInputSchema = z
  .object({
    connectionId: z.string().trim().min(1),
    platformChannelId: z.string().trim().min(1),
    kind: z.enum(['web', 'direct', 'group']),
    displayName: z.string().trim().min(1).max(120).optional(),
  })
  .strict()

const observedIdentitySchema = z
  .object({
    connectionId: z.string().trim().min(1),
    channelId: z.string().trim().min(1),
    platformUserId: z.string().trim().min(1),
    displayName: z.string().trim().min(1).max(120).optional(),
    observedAt: z.number().int().safe().nonnegative(),
  })
  .strict()

const bindingInputSchema = z
  .object({
    channelId: z.string().trim().min(1),
    agentId: z.string().trim().min(1),
    triggerPolicy: z.enum(['always', 'mentioned-or-replied', 'command', 'observe-only']),
  })
  .strict()

const canonicalJson = (value: JsonValue): string => {
  const stack: Array<{ readonly value: JsonValue; readonly close?: string }> = [{ value }]
  let output = ''
  while (stack.length > 0) {
    const current = stack.pop()!
    if (current.close !== undefined) {
      output += current.close
      continue
    }
    const item = current.value
    if (item === null || typeof item === 'boolean' || typeof item === 'number' || typeof item === 'string') {
      output += JSON.stringify(item)
      continue
    }
    if (Array.isArray(item)) {
      output += '['
      stack.push({ value: null, close: ']' })
      for (let index = item.length - 1; index >= 0; index -= 1) {
        if (index < item.length - 1) stack.push({ value: null, close: ',' })
        stack.push({ value: item[index]! })
      }
      continue
    }
    output += '{'
    stack.push({ value: null, close: '}' })
    const entries = Object.entries(item).sort(([left], [right]) => left.localeCompare(right))
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [key, child] = entries[index]!
      if (index < entries.length - 1) stack.push({ value: null, close: ',' })
      stack.push({ value: child })
      stack.push({ value: null, close: ':' })
      stack.push({ value: null, close: JSON.stringify(key) })
    }
  }
  return output
}

type NormalizedAgentRevisionContent = Omit<AgentRevisionContent, 'capabilities'> & {
  readonly capabilities: AgentCapabilityGrants
}

const digestRevision = (content: NormalizedAgentRevisionContent): string =>
  createHash('sha256')
    .update(canonicalJson(content as unknown as JsonValue))
    .digest('hex')

/** Product-domain commit service. Every returned record has already crossed the Repository commit point. */
export class CoreService {
  readonly #repository: CoreRepository
  readonly #now: () => number
  readonly #nextUlid: () => string

  constructor(repository: CoreRepository, options: CoreServiceOptions = {}) {
    this.#repository = repository
    this.#now = options.now ?? Date.now
    this.#nextUlid = options.nextUlid ?? monotonicFactory()
  }

  createAgent(input: AgentRevisionContent): CreateAgentCommit {
    const content = agentRevisionContentSchema.parse(input) as NormalizedAgentRevisionContent
    const createdAt = this.#timestamp()
    const agentId = this.#id<AgentId>('agt')
    const revisionId = this.#id<AgentRevisionId>('arev')
    const revision: AgentRevisionRecord = {
      ...content,
      id: revisionId,
      agentId,
      revision: 1,
      contentDigest: digestRevision(content),
      createdAt,
    }
    const definition: AgentDefinitionRecord = { id: agentId, currentRevisionId: revisionId, createdAt }
    const commit = { definition, revision }
    this.#repository.createAgent(commit)
    return commit
  }

  reviseAgent(agentId: AgentId, expectedCurrentRevisionId: AgentRevisionId, input: AgentRevisionContent) {
    const current = this.#repository.getAgent(agentId)
    if (!current) throw new Error(`Unknown agent: ${agentId}`)
    if (current.definition.currentRevisionId !== expectedCurrentRevisionId) {
      throw new Error(`Agent revision conflict: expected ${expectedCurrentRevisionId}.`)
    }
    const content = agentRevisionContentSchema.parse(input) as NormalizedAgentRevisionContent
    const digest = digestRevision(content)
    if (digest === current.revision.contentDigest) return current
    const revision: AgentRevisionRecord = {
      ...content,
      id: this.#id<AgentRevisionId>('arev'),
      agentId,
      revision: current.revision.revision + 1,
      contentDigest: digest,
      createdAt: this.#timestamp(),
    }
    const definition = { ...current.definition, currentRevisionId: revision.id }
    this.#repository.appendAgentRevision(definition, revision, expectedCurrentRevisionId)
    return { definition, revision }
  }

  createConnection(input: {
    readonly adapterKey: string
    readonly config: JsonValue
    readonly credentialRefs?: Readonly<Record<string, string>>
  }): ConnectionRecord {
    const parsed = connectionInputSchema.parse(input)
    const record: ConnectionRecord = {
      id: this.#id<ConnectionId>('con'),
      adapterKey: parsed.adapterKey,
      config: parsed.config,
      credentialRefs: parsed.credentialRefs,
      status: 'configured',
      createdAt: this.#timestamp(),
    }
    this.#repository.createConnection(record)
    return record
  }

  listConnections(): readonly ConnectionRecord[] {
    return this.#repository.listConnectionIdsByAdapter().flatMap((id) => {
      const connection = this.#repository.getConnection(id)
      return connection ? [connection] : []
    })
  }

  listConnectionsByAdapter(adapterKey: string): readonly ConnectionRecord[] {
    return this.#repository.listConnectionIdsByAdapter(adapterKey).flatMap((id) => {
      const connection = this.#repository.getConnection(id)
      return connection ? [connection] : []
    })
  }

  createChannel(input: {
    readonly connectionId: ConnectionId
    readonly platformChannelId: string
    readonly kind: ChannelRecord['kind']
    readonly displayName?: string
  }): ChannelRecord {
    const parsed = channelInputSchema.parse(input)
    if (!this.#repository.getConnection(input.connectionId))
      throw new Error(`Unknown connection: ${input.connectionId}`)
    const record: ChannelRecord = {
      id: this.#id<ChannelId>('chn'),
      connectionId: input.connectionId,
      platformChannelId: parsed.platformChannelId,
      kind: parsed.kind,
      ...(parsed.displayName === undefined ? {} : { displayName: parsed.displayName }),
      createdAt: this.#timestamp(),
    }
    this.#repository.createChannel(record)
    return record
  }

  ensureChannel(input: {
    readonly connectionId: ConnectionId
    readonly platformChannelId: string
    readonly kind: ChannelRecord['kind']
    readonly displayName?: string
    readonly observedAt: number
  }): ChannelRecord {
    const parsed = channelInputSchema.extend({ observedAt: z.number().int().safe().nonnegative() }).parse(input)
    if (!this.#repository.getConnection(input.connectionId)) {
      throw new Error(`Unknown connection: ${input.connectionId}`)
    }
    return this.#repository.ensureChannel({
      id: this.#id<ChannelId>('chn'),
      connectionId: input.connectionId,
      platformChannelId: parsed.platformChannelId,
      kind: parsed.kind,
      ...(parsed.displayName === undefined ? {} : { displayName: parsed.displayName }),
      createdAt: parsed.observedAt,
    })
  }

  observeChannelMember(input: {
    readonly connectionId: ConnectionId
    readonly channelId: ChannelId
    readonly platformUserId: string
    readonly displayName?: string
    readonly observedAt: number
  }): { readonly identity: PlatformIdentityRecord; readonly member: ChannelMemberRecord } {
    const parsed = observedIdentitySchema.parse(input)
    const channel = this.#repository.getChannel(input.channelId)
    if (!channel || channel.connectionId !== input.connectionId) {
      throw new Error(`Channel ${input.channelId} does not belong to connection ${input.connectionId}.`)
    }
    const identity = this.#repository.ensurePlatformIdentity({
      id: this.#id<PlatformIdentityId>('pid'),
      connectionId: input.connectionId,
      platformUserId: parsed.platformUserId,
      ...(parsed.displayName === undefined ? {} : { displayName: parsed.displayName }),
      firstSeenAt: parsed.observedAt,
      lastSeenAt: parsed.observedAt,
      seenCount: 1,
    })
    const member = this.#repository.ensureChannelMember({
      id: this.#id<ChannelMemberId>('mbr'),
      channelId: input.channelId,
      platformIdentityId: identity.id,
      ...(parsed.displayName === undefined ? {} : { displayName: parsed.displayName }),
      firstSeenAt: parsed.observedAt,
      lastSeenAt: parsed.observedAt,
      seenCount: 1,
    })
    return { identity, member }
  }

  resolveChannelMemberIdentity(
    connectionId: ConnectionId,
    channelId: ChannelId,
    memberId: ChannelMemberId,
  ): PlatformIdentityRecord | undefined {
    const channel = this.#repository.getChannel(channelId)
    if (!channel || channel.connectionId !== connectionId) return undefined
    const member = this.#repository.getChannelMember(memberId)
    if (!member || member.channelId !== channelId) return undefined
    const identity = this.#repository.getPlatformIdentity(member.platformIdentityId)
    return identity?.connectionId === connectionId ? identity : undefined
  }

  getChannel(channelId: ChannelId): ChannelRecord | undefined {
    return this.#repository.getChannel(channelId)
  }

  getChannelByPlatformId(connectionId: ConnectionId, platformChannelId: string): ChannelRecord | undefined {
    return this.#repository.getChannelByPlatformId(connectionId, platformChannelId)
  }

  listChannelsByConnection(connectionId: ConnectionId): readonly ChannelRecord[] {
    return this.#repository.listChannelIdsByConnection(connectionId).flatMap((id) => {
      const channel = this.#repository.getChannel(id)
      return channel ? [channel] : []
    })
  }

  resolvePlatformMessage(
    connectionId: ConnectionId,
    channelId: ChannelId,
    platformMessageId: string,
  ): PlatformMessageReferenceRecord | undefined {
    return this.#repository.resolvePlatformMessage(connectionId, channelId, platformMessageId)
  }

  resolveLogicalMessagePlatformId(
    connectionId: ConnectionId,
    channelId: ChannelId,
    logicalMessageId: LogicalMessageId,
  ): string | undefined {
    return this.#repository.resolveLogicalMessagePlatformId(connectionId, channelId, logicalMessageId)
  }

  createBinding(input: {
    readonly channelId: ChannelId
    readonly agentId: AgentId
    readonly triggerPolicy: BindingTriggerPolicy
  }): BindingRecord {
    const parsed = bindingInputSchema.parse(input)
    if (!this.#repository.getChannel(input.channelId)) throw new Error(`Unknown channel: ${input.channelId}`)
    if (!this.#repository.getAgent(input.agentId)) throw new Error(`Unknown agent: ${input.agentId}`)
    const existing = this.#repository.getBinding(input.channelId, input.agentId)
    if (existing) throw new Error(`Binding already exists: ${existing.id}`)
    const record: BindingRecord = {
      id: this.#id<BindingId>('bnd'),
      channelId: input.channelId,
      agentId: input.agentId,
      triggerPolicy: parsed.triggerPolicy,
      revision: 1,
      createdAt: this.#timestamp(),
    }
    this.#repository.createBinding(record)
    return record
  }

  listBindings(channelId: ChannelId): readonly BindingRecord[] {
    return this.#repository.listBindings(channelId)
  }

  appendInbound(event: AdapterInboundEvent): AppendChannelEventCommit {
    const connection = this.#repository.getConnection(event.connectionId)
    if (!connection || connection.adapterKey !== event.adapterKey) {
      throw new Error(`Inbound adapter does not own connection ${event.connectionId}.`)
    }
    const channel = this.#repository.getChannel(event.channelId)
    if (!channel || channel.connectionId !== event.connectionId) {
      throw new Error(`Inbound channel ${event.channelId} does not belong to connection ${event.connectionId}.`)
    }
    if (event.senderMemberId !== undefined) {
      const member = this.#repository.getChannelMember(event.senderMemberId)
      if (!member || member.channelId !== event.channelId) {
        throw new Error(`Inbound sender ${event.senderMemberId} does not belong to channel ${event.channelId}.`)
      }
    }
    return this.#repository.appendChannelEvent({
      id: this.#id<ChannelEventId>('evt'),
      logicalMessageId: this.#id<LogicalMessageId>('msg'),
      ...event,
    })
  }

  #id<T extends string>(prefix: string): T {
    return `${prefix}_${this.#nextUlid()}` as T
  }

  #timestamp(): number {
    const value = this.#now()
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Clock must return a non-negative integer.')
    return value
  }
}

export { canonicalJson, digestRevision }
