import type { AdapterInboundEvent } from '@nekro-nxt/adapter-sdk'
import type {
  AgentId,
  AgentRevisionId,
  AssetId,
  ChannelEventId,
  ChannelActivityType,
  ChannelId,
  ChannelMemberId,
  ConnectionId,
  JsonValue,
  LogicalMessageId,
  MessagePart,
  PlatformIdentityId,
  PromptDocumentV1,
} from '@nekro-nxt/contracts'
import {
  AgentIdSchema,
  AgentRevisionIdSchema,
  ChannelEventIdSchema,
  ChannelActivityTypeSchema,
  ChannelIdSchema,
  ChannelMemberIdSchema,
  ConnectionIdSchema,
  LogicalMessageIdSchema,
  messagePartAssetIds,
  messagePartsSearchText,
  PlatformIdentityIdSchema,
  normalizePromptDocument,
  promptDocumentFromText,
  promptDocumentPlainText,
  PromptDocumentV1Schema,
} from '@nekro-nxt/contracts'
import { createHash } from 'node:crypto'
import { monotonicFactory } from 'ulid'
import { z } from 'zod'

export * from './assets.js'

export interface AgentModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string | undefined
}

export type ImageDetail = 'low' | 'auto' | 'high'

export interface ImageUnderstandingPolicy {
  readonly history: {
    readonly mode: 'persistent-distinct'
    readonly detail: ImageDetail
    readonly restoreAfterCompaction: {
      readonly recentMessages: number
      readonly maxImages: number
    }
  }
  readonly textModel:
    | { readonly mode: 'disabled' }
    | {
        readonly mode: 'auxiliary'
        readonly model: AgentModelSelection
        readonly maxTokens: number
      }
}

export type DynamicClientApprovalPolicy = 'manual' | 'automatic'

export interface AgentRevisionContent {
  readonly displayName: string
  readonly persona: string
  readonly personaDocument?: PromptDocumentV1
  readonly model: AgentModelSelection
  readonly capabilities?: Partial<AgentCapabilityGrants>
  readonly imagePolicy?: ImageUnderstandingPolicy
  readonly dynamicClientApprovalPolicy?: DynamicClientApprovalPolicy
}

export interface AgentDefinitionRecord {
  readonly id: AgentId
  readonly currentRevisionId: AgentRevisionId
  readonly createdAt: number
}

export interface AgentRevisionRecord extends Omit<
  AgentRevisionContent,
  'capabilities' | 'imagePolicy' | 'personaDocument'
> {
  readonly id: AgentRevisionId
  readonly agentId: AgentId
  readonly revision: number
  readonly capabilities: AgentCapabilityGrants
  readonly imagePolicy: ImageUnderstandingPolicy
  readonly dynamicClientApprovalPolicy: DynamicClientApprovalPolicy
  readonly personaDocument: PromptDocumentV1
  readonly contentDigest: string
  readonly createdAt: number
}

export interface ConnectionRecord {
  readonly id: ConnectionId
  readonly adapterKey: string
  /** Optional user-facing identifier; the Adapter still owns platform identity. */
  readonly alias?: string
  readonly config: JsonValue
  readonly credentialRefs: Readonly<Record<string, string>>
  readonly createdAt: number
}

export interface ChannelRecord {
  readonly id: ChannelId
  readonly connectionId: ConnectionId
  readonly platformChannelId: string
  readonly kind: 'web' | 'direct' | 'group'
  readonly displayName?: string
  /** Set only for the built-in Channel atomically created with this intelligent-agent. */
  readonly autoCreatedForAgentId?: AgentId
  readonly createdAt: number
}

/** A channel lookup used by stable references, including tombstoned rows. */
export interface ChannelReferenceRecord {
  readonly channel: ChannelRecord
  readonly removed: boolean
}

export interface PlatformIdentityRecord {
  readonly id: PlatformIdentityId
  readonly connectionId: ConnectionId
  readonly platformUserId: string
  readonly displayName?: string
}

export interface ChannelMemberRecord {
  readonly id: ChannelMemberId
  readonly channelId: ChannelId
  readonly platformIdentityId: PlatformIdentityId
  readonly displayName?: string
}

export interface PlatformUserDirectoryRecord {
  readonly identityId: PlatformIdentityId
  readonly displayName?: string
  readonly connection: {
    readonly id: ConnectionId
    readonly adapterKey: string
    readonly alias?: string
    readonly createdAt: number
  }
  readonly activeChannels: readonly {
    readonly id: ChannelId
    readonly kind: ChannelRecord['kind']
    readonly displayName?: string
  }[]
  readonly historicalOnly: boolean
}

export type BindingTriggerPolicy = 'always' | 'mentioned-or-replied' | 'command' | 'observe-only'

export interface BindingRecord {
  readonly channelId: ChannelId
  readonly agentId: AgentId
  readonly triggerPolicy: BindingTriggerPolicy
  readonly processingFeedback: 'auto' | 'off'
  readonly eventTriggers: readonly ChannelActivityType[]
  readonly boundAt: number
}

export interface ChannelEventRecord {
  readonly id: ChannelEventId
  readonly logicalMessageId: LogicalMessageId
  readonly channelId: ChannelId
  readonly platformMessageId?: string
  readonly kind: AdapterInboundEvent['kind']
  readonly activityType?: ChannelActivityType
  readonly targetPlatformMessageId?: string
  readonly targetLogicalMessageId?: LogicalMessageId
  readonly senderMemberId?: AdapterInboundEvent['senderMemberId']
  readonly parts: readonly MessagePart[]
  readonly sourceTimestamp: number
  readonly receivedAt: number
  readonly dedupeKey: string
  readonly facts?: Readonly<Record<string, JsonValue>>
  readonly searchText: string
}

export interface PlatformMessageReferenceRecord {
  readonly logicalMessageId: LogicalMessageId
  readonly authoredByAgent: boolean
}

export interface CreateAgentCommit {
  readonly definition: AgentDefinitionRecord
  readonly revision: AgentRevisionRecord
}

export interface CreateAgentWithChannelCommit extends CreateAgentCommit {
  readonly channel: ChannelRecord
  readonly binding: BindingRecord
}

export interface AppendChannelEventCommit {
  readonly event: ChannelEventRecord
  readonly inserted: boolean
}

export interface CoreRepository {
  createAgent(commit: CreateAgentCommit): void
  createAgentWithChannel(commit: CreateAgentWithChannelCommit): void
  tombstoneAgent(id: AgentId, deletedAt: number): void
  getAgent(id: AgentId): CreateAgentCommit | undefined
  listAgents(): readonly CreateAgentCommit[]
  getAgentRevision(id: AgentRevisionId): AgentRevisionRecord | undefined
  getAgentRevisionByDigest(agentId: AgentId, contentDigest: string): AgentRevisionRecord | undefined
  listAgentRevisions(agentId: AgentId): readonly AgentRevisionRecord[]
  getNextAgentRevisionNumber(agentId: AgentId): number
  appendAgentRevision(
    definition: AgentDefinitionRecord,
    revision: AgentRevisionRecord,
    expectedCurrentRevisionId: AgentRevisionId,
  ): void
  activateAgentRevision(
    definition: AgentDefinitionRecord,
    revision: AgentRevisionRecord,
    expectedCurrentRevisionId: AgentRevisionId,
  ): void
  createConnection(record: ConnectionRecord): void
  updateConnectionAlias(id: ConnectionId, alias?: string): void
  getConnection(id: ConnectionId): ConnectionRecord | undefined
  listConnectionIdsByAdapter(adapterKey?: string): readonly ConnectionId[]
  createChannel(record: ChannelRecord): void
  ensureChannel(record: ChannelRecord): ChannelRecord
  tombstoneChannel(id: ChannelId, deletedAt: number): void
  updateChannelDisplayName(id: ChannelId, displayName: string): void
  getChannel(id: ChannelId): ChannelRecord | undefined
  getChannelByPlatformId(connectionId: ConnectionId, platformChannelId: string): ChannelRecord | undefined
  listChannelIdsByConnection(connectionId: ConnectionId): readonly ChannelId[]
  ensurePlatformIdentity(record: PlatformIdentityRecord): PlatformIdentityRecord
  getPlatformIdentity(id: PlatformIdentityId): PlatformIdentityRecord | undefined
  listPlatformUsers(): readonly PlatformUserDirectoryRecord[]
  ensureChannelMember(record: ChannelMemberRecord): ChannelMemberRecord
  getChannelMember(id: ChannelMemberId): ChannelMemberRecord | undefined
  getChannelMemberByIdentity(
    channelId: ChannelId,
    platformIdentityId: PlatformIdentityId,
  ): ChannelMemberRecord | undefined
  replaceBinding(record: BindingRecord): BindingRecord
  clearBinding(channelId: ChannelId): void
  getBinding(channelId: ChannelId): BindingRecord | undefined
  listBindings(channelId: ChannelId): readonly BindingRecord[]
  appendChannelEvent(
    candidate: ChannelEventRecord,
    assetOccurrences?: readonly { readonly partIndex: number; readonly assetId: AssetId }[],
  ): AppendChannelEventCommit
  getChannelEvent(id: ChannelEventId): ChannelEventRecord | undefined
  listChannelEvents(
    channelId: ChannelId,
    options?: {
      readonly before?: { readonly receivedAt: number; readonly id: ChannelEventId }
      readonly limit?: number
    },
  ): readonly ChannelEventRecord[]
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

export const AgentCapabilityGrantsSchema = z
  .object({
    subagents: z.boolean().default(false),
    fileTools: z.boolean().default(false),
    webSearch: z.boolean().default(false),
    dynamicCreation: z.boolean().default(false),
    developmentShell: z.boolean().default(false),
    unrestrictedFileAccess: z.boolean().default(false),
  })
  .strict()
  .default({
    subagents: false,
    fileTools: false,
    webSearch: false,
    dynamicCreation: false,
    developmentShell: false,
    unrestrictedFileAccess: false,
  })

export type AgentCapabilityGrants = z.infer<typeof AgentCapabilityGrantsSchema>

const AgentModelSelectionSchema = z
  .object({
    provider: z.string().trim().min(1),
    model: z.string().trim().min(1),
    reasoningEffort: z.string().trim().min(1).optional(),
  })
  .strict()

export const ImageUnderstandingPolicySchema = z
  .object({
    history: z
      .object({
        mode: z.literal('persistent-distinct').default('persistent-distinct'),
        detail: z.enum(['low', 'auto', 'high']).default('auto'),
        restoreAfterCompaction: z
          .object({
            recentMessages: z.number().int().min(1).max(100).default(32),
            maxImages: z.number().int().min(1).max(50).default(20),
          })
          .strict()
          .default({ recentMessages: 32, maxImages: 20 }),
      })
      .strict()
      .default({
        mode: 'persistent-distinct',
        detail: 'auto',
        restoreAfterCompaction: { recentMessages: 32, maxImages: 20 },
      }),
    textModel: z
      .discriminatedUnion('mode', [
        z.object({ mode: z.literal('disabled') }).strict(),
        z
          .object({
            mode: z.literal('auxiliary'),
            model: AgentModelSelectionSchema,
            maxTokens: z.number().int().min(256).max(8192).default(2048),
          })
          .strict(),
      ])
      .default({ mode: 'disabled' }),
  })
  .strict()
  .default({
    history: {
      mode: 'persistent-distinct',
      detail: 'auto',
      restoreAfterCompaction: { recentMessages: 32, maxImages: 20 },
    },
    textModel: { mode: 'disabled' },
  })

export const DEFAULT_IMAGE_UNDERSTANDING_POLICY: ImageUnderstandingPolicy =
  ImageUnderstandingPolicySchema.parse(undefined)

export const DynamicClientApprovalPolicySchema = z.enum(['manual', 'automatic']).default('manual')

export function parseImageUnderstandingPolicy(input: unknown): ImageUnderstandingPolicy {
  return ImageUnderstandingPolicySchema.parse(input)
}

export const ConnectionAliasSchema = z
  .string()
  .trim()
  .max(80)
  .transform((value) => value || undefined)

export function normalizeConnectionAlias(alias: string | undefined): string | undefined {
  return alias === undefined ? undefined : ConnectionAliasSchema.parse(alias)
}

const agentRevisionContentSchema = z
  .object({
    displayName: z.string().trim().min(1).max(80),
    persona: z.string().max(64 * 1024),
    personaDocument: PromptDocumentV1Schema.optional(),
    model: AgentModelSelectionSchema,
    capabilities: AgentCapabilityGrantsSchema,
    imagePolicy: ImageUnderstandingPolicySchema,
    dynamicClientApprovalPolicy: DynamicClientApprovalPolicySchema,
  })
  .strict()

export function parseAgentCapabilityGrants(input: unknown): AgentCapabilityGrants {
  return AgentCapabilityGrantsSchema.parse(input)
}

export function parseStoredAgentCapabilityGrants(input: unknown): AgentCapabilityGrants {
  return AgentCapabilityGrantsSchema.parse(input)
}

const connectionInputSchema = z
  .object({
    adapterKey: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9-]*$/),
    config: z.json(),
    credentialRefs: z.record(z.string().min(1), z.string().trim().min(1)).default({}),
    alias: ConnectionAliasSchema.optional(),
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
    processingFeedback: z.enum(['auto', 'off']).default('auto'),
    eventTriggers: z.array(ChannelActivityTypeSchema).default([]),
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

type NormalizedAgentRevisionContent = Omit<
  AgentRevisionContent,
  'capabilities' | 'imagePolicy' | 'personaDocument' | 'dynamicClientApprovalPolicy'
> & {
  readonly capabilities: AgentCapabilityGrants
  readonly imagePolicy: ImageUnderstandingPolicy
  readonly personaDocument: PromptDocumentV1
  readonly dynamicClientApprovalPolicy: DynamicClientApprovalPolicy
}

const parseAgentRevisionContent = (input: AgentRevisionContent): NormalizedAgentRevisionContent => {
  const parsed = agentRevisionContentSchema.parse(input)
  const personaDocument = normalizePromptDocument(parsed.personaDocument ?? promptDocumentFromText(parsed.persona))
  const persona = promptDocumentPlainText(personaDocument)
  if (parsed.personaDocument !== undefined && persona !== parsed.persona) {
    throw new Error('Agent persona must match the plain-text projection of personaDocument.')
  }
  return {
    displayName: parsed.displayName,
    persona,
    personaDocument,
    model: {
      provider: parsed.model.provider,
      model: parsed.model.model,
      ...(parsed.model.reasoningEffort === undefined ? {} : { reasoningEffort: parsed.model.reasoningEffort }),
    },
    capabilities: parsed.capabilities,
    imagePolicy: parsed.imagePolicy,
    dynamicClientApprovalPolicy: parsed.dynamicClientApprovalPolicy,
  }
}

const normalizedRevisionPayload = (content: NormalizedAgentRevisionContent): JsonValue => ({
  displayName: content.displayName,
  personaDocument: content.personaDocument,
  model: {
    provider: content.model.provider,
    model: content.model.model,
    reasoningEffort: content.model.reasoningEffort ?? null,
  },
  capabilities: {
    subagents: content.capabilities.subagents,
    fileTools: content.capabilities.fileTools,
    webSearch: content.capabilities.webSearch,
    dynamicCreation: content.capabilities.dynamicCreation,
    developmentShell: content.capabilities.developmentShell,
    unrestrictedFileAccess: content.capabilities.unrestrictedFileAccess,
  },
  imagePolicy: {
    history: {
      mode: content.imagePolicy.history.mode,
      detail: content.imagePolicy.history.detail,
      restoreAfterCompaction: {
        recentMessages: content.imagePolicy.history.restoreAfterCompaction.recentMessages,
        maxImages: content.imagePolicy.history.restoreAfterCompaction.maxImages,
      },
    },
    textModel:
      content.imagePolicy.textModel.mode === 'disabled'
        ? { mode: 'disabled' }
        : {
            mode: 'auxiliary',
            model: {
              provider: content.imagePolicy.textModel.model.provider,
              model: content.imagePolicy.textModel.model.model,
              reasoningEffort: content.imagePolicy.textModel.model.reasoningEffort ?? null,
            },
            maxTokens: content.imagePolicy.textModel.maxTokens,
          },
  },
  dynamicClientApprovalPolicy: content.dynamicClientApprovalPolicy,
})

const digestRevision = (input: AgentRevisionContent): string => {
  const content = parseAgentRevisionContent(input)
  return `v5:sha256:${createHash('sha256')
    .update('nekro-nxt.agent-revision.v5\0')
    .update(canonicalJson(normalizedRevisionPayload(content)))
    .digest('hex')}`
}

const revisionContent = (revision: AgentRevisionRecord): NormalizedAgentRevisionContent => ({
  displayName: revision.displayName,
  persona: revision.persona,
  personaDocument: revision.personaDocument,
  model: revision.model,
  capabilities: revision.capabilities,
  imagePolicy: revision.imagePolicy,
  dynamicClientApprovalPolicy: revision.dynamicClientApprovalPolicy,
})

const equivalentRevisionContent = (
  left: NormalizedAgentRevisionContent,
  right: NormalizedAgentRevisionContent,
): boolean => canonicalJson(normalizedRevisionPayload(left)) === canonicalJson(normalizedRevisionPayload(right))

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

  listAgents(): readonly CreateAgentCommit[] {
    return this.#repository.listAgents()
  }

  createAgent(input: AgentRevisionContent): CreateAgentCommit {
    const content = parseAgentRevisionContent(input)
    const createdAt = this.#timestamp()
    const agentId = AgentIdSchema.parse(`agt_${this.#nextUlid()}`)
    const revisionId = AgentRevisionIdSchema.parse(`arev_${this.#nextUlid()}`)
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

  createAgentWithChannel(
    input: AgentRevisionContent,
    channelInput: {
      readonly connectionId: ConnectionId
      readonly kind: ChannelRecord['kind']
      readonly platformChannelId?: string
      readonly displayName?: string
      readonly triggerPolicy: BindingTriggerPolicy
    },
  ): CreateAgentWithChannelCommit {
    if (!this.#repository.getConnection(channelInput.connectionId)) {
      throw new Error(`Unknown connection: ${channelInput.connectionId}`)
    }
    const content = parseAgentRevisionContent(input)
    const createdAt = this.#timestamp()
    const agentId = AgentIdSchema.parse(`agt_${this.#nextUlid()}`)
    const revisionId = AgentRevisionIdSchema.parse(`arev_${this.#nextUlid()}`)
    const channelId = ChannelIdSchema.parse(`chn_${this.#nextUlid()}`)
    const revision: AgentRevisionRecord = {
      ...content,
      id: revisionId,
      agentId,
      revision: 1,
      contentDigest: digestRevision(content),
      createdAt,
    }
    const definition: AgentDefinitionRecord = { id: agentId, currentRevisionId: revisionId, createdAt }
    const channel: ChannelRecord = {
      id: channelId,
      connectionId: channelInput.connectionId,
      platformChannelId: channelInput.platformChannelId ?? `web-${agentId}`,
      kind: channelInput.kind,
      ...(channelInput.displayName === undefined ? {} : { displayName: channelInput.displayName }),
      autoCreatedForAgentId: agentId,
      createdAt,
    }
    const binding: BindingRecord = {
      channelId,
      agentId,
      triggerPolicy: channelInput.triggerPolicy,
      processingFeedback: 'auto',
      eventTriggers: [],
      boundAt: createdAt,
    }
    const commit = { definition, revision, channel, binding }
    this.#repository.createAgentWithChannel(commit)
    return commit
  }

  reviseAgent(agentId: AgentId, expectedCurrentRevisionId: AgentRevisionId, input: AgentRevisionContent) {
    const current = this.#repository.getAgent(agentId)
    if (!current) throw new Error(`Unknown agent: ${agentId}`)
    if (current.definition.currentRevisionId !== expectedCurrentRevisionId) {
      throw new Error(`Agent revision conflict: expected ${expectedCurrentRevisionId}.`)
    }
    const content = parseAgentRevisionContent(input)
    if (equivalentRevisionContent(content, revisionContent(current.revision))) return current
    const digest = digestRevision(content)
    const existing =
      this.#repository.getAgentRevisionByDigest(agentId, digest) ??
      this.#repository
        .listAgentRevisions(agentId)
        .find((candidate) => equivalentRevisionContent(content, revisionContent(candidate)))
    if (existing) {
      const definition = { ...current.definition, currentRevisionId: existing.id }
      this.#repository.activateAgentRevision(definition, existing, expectedCurrentRevisionId)
      return { definition, revision: existing }
    }
    const revision: AgentRevisionRecord = {
      ...content,
      id: AgentRevisionIdSchema.parse(`arev_${this.#nextUlid()}`),
      agentId,
      revision: this.#repository.getNextAgentRevisionNumber(agentId),
      contentDigest: digest,
      createdAt: this.#timestamp(),
    }
    const definition = { ...current.definition, currentRevisionId: revision.id }
    this.#repository.appendAgentRevision(definition, revision, expectedCurrentRevisionId)
    return { definition, revision }
  }

  /** Removes an intelligent-agent from active product state while preserving immutable history. */
  deleteAgent(agentId: AgentId): void {
    if (!this.#repository.getAgent(agentId)) throw new Error(`Unknown agent: ${agentId}`)
    this.#repository.tombstoneAgent(agentId, this.#timestamp())
  }

  createConnection(input: {
    readonly adapterKey: string
    readonly config: JsonValue
    readonly credentialRefs?: Readonly<Record<string, string>>
    readonly alias?: string
  }): ConnectionRecord {
    const parsed = connectionInputSchema.parse(input)
    const record: ConnectionRecord = {
      id: ConnectionIdSchema.parse(`con_${this.#nextUlid()}`),
      adapterKey: parsed.adapterKey,
      config: parsed.config,
      credentialRefs: parsed.credentialRefs,
      createdAt: this.#timestamp(),
      ...(parsed.alias === undefined ? {} : { alias: parsed.alias }),
    }
    this.#repository.createConnection(record)
    return record
  }

  updateConnectionAlias(connectionId: ConnectionId, alias?: string): ConnectionRecord {
    const current = this.#repository.getConnection(connectionId)
    if (!current) throw new Error(`Unknown connection: ${connectionId}`)
    const normalizedAlias = normalizeConnectionAlias(alias)
    this.#repository.updateConnectionAlias(connectionId, normalizedAlias)
    if (normalizedAlias === undefined) {
      return {
        id: current.id,
        adapterKey: current.adapterKey,
        config: current.config,
        credentialRefs: current.credentialRefs,
        createdAt: current.createdAt,
      }
    }
    return { ...current, alias: normalizedAlias }
  }

  listConnections(): readonly ConnectionRecord[] {
    return this.#repository.listConnectionIdsByAdapter().flatMap((id) => {
      const connection = this.#repository.getConnection(id)
      return connection ? [connection] : []
    })
  }

  getConnection(connectionId: ConnectionId): ConnectionRecord | undefined {
    return this.#repository.getConnection(connectionId)
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
      id: ChannelIdSchema.parse(`chn_${this.#nextUlid()}`),
      connectionId: input.connectionId,
      platformChannelId: parsed.platformChannelId,
      kind: parsed.kind,
      ...(parsed.displayName === undefined ? {} : { displayName: parsed.displayName }),
      createdAt: this.#timestamp(),
    }
    this.#repository.createChannel(record)
    return record
  }

  /** Removes a Channel from active product state while preserving its immutable facts. */
  deleteChannel(channelId: ChannelId): void {
    if (!this.#repository.getChannel(channelId)) throw new Error(`Unknown channel: ${channelId}`)
    this.#repository.tombstoneChannel(channelId, this.#timestamp())
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
      id: ChannelIdSchema.parse(`chn_${this.#nextUlid()}`),
      connectionId: input.connectionId,
      platformChannelId: parsed.platformChannelId,
      kind: parsed.kind,
      ...(parsed.displayName === undefined ? {} : { displayName: parsed.displayName }),
      createdAt: parsed.observedAt,
    })
  }

  updateChannelDisplayName(channelId: ChannelId, displayName: string): ChannelRecord {
    const parsed = z.string().trim().min(1).max(120).parse(displayName)
    const current = this.#repository.getChannel(channelId)
    if (!current) throw new Error(`Unknown channel: ${channelId}`)
    this.#repository.updateChannelDisplayName(channelId, parsed)
    return { ...current, displayName: parsed }
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
      id: PlatformIdentityIdSchema.parse(`pid_${this.#nextUlid()}`),
      connectionId: input.connectionId,
      platformUserId: parsed.platformUserId,
      ...(parsed.displayName === undefined ? {} : { displayName: parsed.displayName }),
    })
    const member = this.#repository.ensureChannelMember({
      id: ChannelMemberIdSchema.parse(`mbr_${this.#nextUlid()}`),
      channelId: input.channelId,
      platformIdentityId: identity.id,
      ...(parsed.displayName === undefined ? {} : { displayName: parsed.displayName }),
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

  listPlatformUsers(): readonly PlatformUserDirectoryRecord[] {
    return this.#repository.listPlatformUsers()
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
    readonly processingFeedback?: 'auto' | 'off'
    readonly eventTriggers?: readonly ChannelActivityType[]
  }): BindingRecord {
    const parsed = bindingInputSchema.parse(input)
    if (!this.#repository.getChannel(input.channelId)) throw new Error(`Unknown channel: ${input.channelId}`)
    if (!this.#repository.getAgent(input.agentId)) throw new Error(`Unknown agent: ${input.agentId}`)
    const existing = this.#repository.getBinding(input.channelId)
    if (existing) throw new Error(`Channel is already bound to ${existing.agentId}.`)
    const record: BindingRecord = {
      channelId: input.channelId,
      agentId: input.agentId,
      triggerPolicy: parsed.triggerPolicy,
      processingFeedback: parsed.processingFeedback,
      eventTriggers: parsed.eventTriggers,
      boundAt: this.#timestamp(),
    }
    return this.#repository.replaceBinding(record)
  }

  replaceBinding(input: {
    readonly channelId: ChannelId
    readonly agentId: AgentId
    readonly triggerPolicy: BindingTriggerPolicy
    readonly processingFeedback?: 'auto' | 'off'
    readonly eventTriggers?: readonly ChannelActivityType[]
  }): BindingRecord {
    const parsed = bindingInputSchema.parse(input)
    if (!this.#repository.getChannel(input.channelId)) throw new Error(`Unknown channel: ${input.channelId}`)
    if (!this.#repository.getAgent(input.agentId)) throw new Error(`Unknown agent: ${input.agentId}`)
    return this.#repository.replaceBinding({
      channelId: input.channelId,
      agentId: input.agentId,
      triggerPolicy: parsed.triggerPolicy,
      processingFeedback: parsed.processingFeedback,
      eventTriggers: parsed.eventTriggers,
      boundAt: this.#timestamp(),
    })
  }

  clearBinding(channelId: ChannelId): void {
    if (!this.#repository.getChannel(channelId)) throw new Error(`Unknown channel: ${channelId}`)
    this.#repository.clearBinding(channelId)
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
    const searchText = messagePartsSearchText(event.parts)
    const target =
      event.targetPlatformMessageId === undefined
        ? undefined
        : this.#repository.resolvePlatformMessage(event.connectionId, event.channelId, event.targetPlatformMessageId)
    const record: ChannelEventRecord = {
      id: ChannelEventIdSchema.parse(`evt_${this.#nextUlid()}`),
      logicalMessageId: LogicalMessageIdSchema.parse(`msg_${this.#nextUlid()}`),
      channelId: event.channelId,
      ...(event.platformMessageId === undefined ? {} : { platformMessageId: event.platformMessageId }),
      kind: event.kind,
      ...(event.activityType === undefined ? {} : { activityType: event.activityType }),
      ...(event.targetPlatformMessageId === undefined
        ? {}
        : { targetPlatformMessageId: event.targetPlatformMessageId }),
      ...(target === undefined ? {} : { targetLogicalMessageId: target.logicalMessageId }),
      ...(event.senderMemberId === undefined ? {} : { senderMemberId: event.senderMemberId }),
      parts: event.parts,
      sourceTimestamp: event.platformTimestamp,
      receivedAt: event.receivedAt,
      dedupeKey: event.dedupeKey,
      ...(event.facts === undefined ? {} : { facts: event.facts }),
      searchText,
    }
    const occurrences = event.assetOccurrences ?? []
    for (const occurrence of occurrences) {
      const part = record.parts[occurrence.partIndex]
      if (part === undefined || !messagePartAssetIds(part).includes(occurrence.assetId)) {
        throw new Error(`Asset occurrence does not match message part ${occurrence.partIndex}.`)
      }
    }
    return this.#repository.appendChannelEvent(record, occurrences)
  }

  #timestamp(): number {
    const value = this.#now()
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Clock must return a non-negative integer.')
    return value
  }
}

export { canonicalJson, digestRevision }
