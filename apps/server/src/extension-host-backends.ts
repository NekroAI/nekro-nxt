import type { ChannelHistoryEntry, ChannelHistoryRepository } from '@nekro-nxt/channel-runtime'
import {
  AgentIdSchema,
  ChannelIdSchema,
  ChannelMemberIdSchema,
  ExtensionIdSchema,
  type AgentId,
  type ChannelId,
  type CredentialId,
  type CredentialUsage,
  type ExtensionId,
  type JsonValue,
  type MessagePart,
} from '@nekro-nxt/contracts'
import type { CoreRepository } from '@nekro-nxt/core'
import type { ChannelMemberRelations } from './session-image-context.js'
import { z } from 'zod'
import type {
  NxtAssetCreateInput,
  NxtAssetRecord,
  NxtCallContext,
  NxtHistoryMessage,
  NxtJobRecord,
  NxtMemberSummary,
  NxtPlatformResult,
} from '@nekro-nxt/extension-sdk'
import { ExtensionStorageQuotaError } from '@nekro-nxt/storage-sqlite'
import {
  bindingSecretReference,
  type NxtRequestSecret,
  type NxtServiceBackends,
  type NxtServiceBinding,
  type NxtStorageBackend,
  type NxtStoragePartition,
} from './extension-host-service.js'
import { namedCredentialId } from './credentials-library.js'

/** Matches the opaque references `LocalCredentialStore` issues; anything else in a secret field is not resolved. */
const CREDENTIAL_REFERENCE_PATTERN = /^credential:local:[a-f0-9]{32}$/u

/** One use of a named credential an extension's secret field is bound to. */
export interface NamedCredentialUse {
  readonly id: CredentialId
  /** Absent for the host instance of an installed extension, which serves every agent. */
  readonly agentId: AgentId | undefined
  /** `program`: code reads the value; `request`: the host fills it into a request. */
  readonly purpose: CredentialUsage
  readonly extensionId: string
  readonly channelId: ChannelId | undefined
  readonly targetHost: string | undefined
  /** What uses it: extension code, or an MCP server the extension declares. */
  readonly consumerKind: 'extension' | 'mcp'
}

/** Named credentials as extensions may use them; denied uses resolve to `undefined`. */
export type NamedCredentialResolver = (
  use: NamedCredentialUse,
) => { readonly value: string; readonly usage: CredentialUsage; readonly domains: readonly string[] } | undefined

export interface NxtProductFacts {
  readonly history: ChannelHistoryRepository & Pick<CoreRepository, 'getChannel' | 'getChannelMember'>
  readonly getConnectionName: (connectionId: string) => string | undefined
  readonly getAgentName: (agentId: string) => string
  readonly createAsset: (channelId: ChannelId, input: NxtAssetCreateInput) => Promise<NxtAssetRecord>
  readonly resolveCredential: (reference: string) => Promise<string>
  /** Named credentials; absent hosts treat bound fields as unset. */
  readonly namedCredential?: NamedCredentialResolver
  /** The credential a name or id refers to, for MCP values that name one directly. */
  readonly findCredential?: (reference: string) => CredentialId | undefined
  /** Who members are relative to the agent; absent hosts describe every member plainly. */
  readonly members?: ChannelMemberRelations
  /** The platform user id a connection reported as its own account. */
  readonly accountPlatformUserId?: (connectionId: string) => string | undefined
}

const member = (facts: NxtProductFacts, memberId: string | undefined): NxtMemberSummary | undefined => {
  if (memberId === undefined) return undefined
  const parsed = ChannelMemberIdSchema.safeParse(memberId)
  const displayName = parsed.success ? facts.history.getChannelMember(parsed.data)?.displayName : undefined
  const relation = parsed.success ? facts.members?.describe(parsed.data) : undefined
  return {
    memberId,
    ...(displayName === undefined ? {} : { displayName }),
    ...(relation?.kind === 'self' ? { self: true as const } : {}),
    ...(relation?.kind === 'local-agent'
      ? { localAgent: relation.agentName === undefined ? {} : { name: relation.agentName } }
      : {}),
  }
}

/** Plain-text projection of message parts for extensions; structure stays available to the agent itself. */
export const messagePartsText = (facts: NxtProductFacts, parts: readonly MessagePart[]): string =>
  parts
    .map((part) => {
      switch (part.type) {
        case 'text':
          return part.text
        case 'mention':
          return `@${member(facts, part.memberId)?.displayName ?? part.memberId}`
        case 'image':
          return `[${part.sticker ? '表情包' : '图片'}${part.alt === undefined ? '' : `：${part.alt}`}]`
        case 'file':
          return part.name === undefined ? '[文件]' : `[文件：${part.name}]`
        case 'audio':
          return '[语音]'
        case 'quote':
          return '[引用]'
        case 'rich':
          return `[${part.summary}]`
      }
    })
    .join('')

const encodeCursor = (entry: ChannelHistoryEntry): string =>
  Buffer.from(JSON.stringify([entry.occurredAt, entry.sourceId]), 'utf8').toString('base64url')

const HistoryCursorSchema = z.tuple([z.number().int().nonnegative(), z.string().min(1)])

const decodeCursor = (cursor: string): { readonly occurredAt: number; readonly sourceId: string } => {
  try {
    const parsed = HistoryCursorSchema.safeParse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')))
    if (parsed.success) return { occurredAt: parsed.data[0], sourceId: parsed.data[1] }
  } catch {
    // fall through to the readable error below
  }
  throw new TypeError('history.list 的 before 必须是上一页返回的 cursor。')
}

const historyMessage = (facts: NxtProductFacts, entry: ChannelHistoryEntry): NxtHistoryMessage => {
  const sender = entry.source === 'channel-event' ? member(facts, entry.senderMemberId) : undefined
  return {
    logicalMessageId: entry.logicalMessageId,
    direction: entry.source === 'channel-event' ? 'inbound' : 'outbound',
    ...(sender === undefined ? {} : { sender }),
    text: messagePartsText(facts, entry.parts),
    occurredAt: entry.occurredAt,
    cursor: encodeCursor(entry),
  }
}

/** Hidden or system facts (console anchors, scheduled-job controls) are not conversation messages. */
const isConversationEntry = (entry: ChannelHistoryEntry): boolean =>
  entry.source === 'outbound-intent' ||
  (entry.facts?.['consoleAnchor'] !== true && entry.facts?.['extensionJob'] === undefined)

/**
 * Resolves one secret field of a binding (智能体扩展配置与凭据 C5). The field must be declared `meta.role: 'secret'`
 * in the layer it is read from. A store reference (`credential:local:`) is the field's own value; a named credential
 * (`credential:named:`) resolves only for an agent in its scope, and `program` reads need a credential that allows
 * program use. Anything else is treated as unset. `targetHost` is recorded with a request use.
 */
export const resolveExtensionSecret = async (
  facts: Pick<NxtProductFacts, 'resolveCredential' | 'namedCredential'>,
  binding: NxtServiceBinding,
  key: string,
  purpose: CredentialUsage,
  targetHost?: string,
): Promise<NxtRequestSecret | undefined> => {
  const reference = bindingSecretReference(binding, key)
  if (typeof reference !== 'string') return undefined
  if (CREDENTIAL_REFERENCE_PATTERN.test(reference)) return { value: await facts.resolveCredential(reference) }
  const id = namedCredentialId(reference)
  if (id === undefined || facts.namedCredential === undefined) return undefined
  const agent = AgentIdSchema.safeParse(binding.agentId)
  const channel = ChannelIdSchema.safeParse(binding.channelId)
  const resolved = facts.namedCredential({
    id,
    // The host instance of an installed extension serves every agent; its dynamic stand-in acts for the author.
    agentId: binding.mode === 'host' && binding.agentId === '' ? undefined : agent.success ? agent.data : undefined,
    purpose,
    extensionId: binding.ownerKey,
    channelId: channel.success ? channel.data : undefined,
    targetHost,
    consumerKind: 'extension',
  })
  if (resolved === undefined) return undefined
  // Program-use credentials without domains go wherever the extension's own network policy reaches.
  return resolved.usage === 'program' && resolved.domains.length === 0
    ? { value: resolved.value }
    : { value: resolved.value, domains: resolved.domains }
}

/**
 * Product-fact half of the `nxt` backends. Network and storage are passed in so the same facts serve the live Host
 * and tests with fakes.
 */
export const createNxtProductBackends = (
  facts: NxtProductFacts,
  infrastructure: Pick<
    NxtServiceBackends,
    'fetch' | 'storage' | 'diagnostic' | 'complete' | 'jobs' | 'library' | 'index' | 'models' | 'logger'
  > & {
    readonly platform: Omit<NxtServiceBackends['platform'], 'selfPlatformUserId'>
  },
): NxtServiceBackends => ({
  ...infrastructure,
  platform: {
    ...infrastructure.platform,
    selfPlatformUserId: (channelId) => {
      const channel = facts.history.getChannel(ChannelIdSchema.parse(channelId))
      return Promise.resolve(channel === undefined ? undefined : facts.accountPlatformUserId?.(channel.connectionId))
    },
  },
  members: {
    describe: (channelId, memberId) => {
      const parsed = ChannelMemberIdSchema.safeParse(memberId)
      if (!parsed.success || facts.history.getChannelMember(parsed.data)?.channelId !== channelId)
        return Promise.resolve(undefined)
      return Promise.resolve(member(facts, parsed.data))
    },
  },
  secret: async (binding: NxtServiceBinding, key: string) =>
    (await resolveExtensionSecret(facts, binding, key, 'program'))?.value,
  requestSecret: (binding: NxtServiceBinding, key: string, targetHost: string) =>
    resolveExtensionSecret(facts, binding, key, 'request', targetHost),
  mcpCredential: (binding, reference, use) => {
    const id = facts.findCredential?.(reference)
    if (id === undefined || facts.namedCredential === undefined) return Promise.resolve(undefined)
    const agent = AgentIdSchema.safeParse(binding.agentId)
    const channel = ChannelIdSchema.safeParse(binding.channelId)
    const resolved = facts.namedCredential({
      id,
      agentId: agent.success ? agent.data : undefined,
      purpose: use.purpose,
      extensionId: binding.ownerKey,
      channelId: channel.success ? channel.data : undefined,
      targetHost: use.targetHost,
      consumerKind: 'mcp',
    })
    if (resolved === undefined) return Promise.resolve(undefined)
    return Promise.resolve(
      resolved.usage === 'program' && resolved.domains.length === 0
        ? { value: resolved.value }
        : { value: resolved.value, domains: resolved.domains },
    )
  },
  createAsset: (channelId, input) => facts.createAsset(ChannelIdSchema.parse(channelId), input),
  callContext(binding): Promise<NxtCallContext> {
    const channelId = ChannelIdSchema.parse(binding.channelId)
    const channel = facts.history.getChannel(channelId)
    if (!channel) throw new Error(`频道已不存在：${binding.channelId}`)
    const latest = facts.history
      .listChannelHistory(channelId, { limit: 20 })
      .find((entry) => entry.source === 'channel-event' && isConversationEntry(entry))
    const connectionName = facts.getConnectionName(channel.connectionId)
    const sender = latest?.source === 'channel-event' ? member(facts, latest.senderMemberId) : undefined
    return Promise.resolve({
      agent: { id: binding.agentId, name: facts.getAgentName(binding.agentId) },
      channel: {
        id: channel.id,
        kind: channel.kind,
        ...(channel.displayName === undefined ? {} : { displayName: channel.displayName }),
        ...(connectionName === undefined ? {} : { connectionName }),
        ...(facts.members === undefined || channel.kind === 'internal'
          ? {}
          : { selfMemberId: facts.members.self(channel.id).memberId }),
      },
      ...(latest === undefined
        ? {}
        : {
            latestInbound: {
              logicalMessageId: latest.logicalMessageId,
              ...(sender === undefined ? {} : { sender }),
              text: messagePartsText(facts, latest.parts),
              receivedAt: latest.occurredAt,
            },
          }),
    })
  },
  history: {
    list(channelId, options) {
      const entries = facts.history.listChannelHistory(ChannelIdSchema.parse(channelId), {
        limit: options.limit,
        ...(options.before === undefined ? {} : { before: decodeCursor(options.before) }),
      })
      const messages = entries.filter(isConversationEntry).map((entry) => historyMessage(facts, entry))
      const last = entries.at(-1)
      return Promise.resolve({
        messages,
        ...(last === undefined || entries.length < options.limit ? {} : { next: encodeCursor(last) }),
      })
    },
    search(channelId, query, limit) {
      const hits = facts.history
        .searchChannelHistory(ChannelIdSchema.parse(channelId), query, { limit })
        .map((hit) => hit.entry)
        .filter(isConversationEntry)
        .map((entry) => historyMessage(facts, entry))
      return Promise.resolve(hits)
    },
  },
})

interface StorageRepository {
  getExtensionStorageEntry(input: {
    readonly extensionId: ExtensionId
    readonly owner: 'shared' | AgentId
    readonly partition: string
    readonly key: string
  }): JsonValue | undefined
  setExtensionStorageEntry(input: {
    readonly extensionId: ExtensionId
    readonly owner: 'shared' | AgentId
    readonly partition: string
    readonly key: string
    readonly value: JsonValue
    readonly updatedAt: number
    readonly quotaBytes: number
  }): void
  deleteExtensionStorageEntry(input: {
    readonly extensionId: ExtensionId
    readonly owner: 'shared' | AgentId
    readonly partition: string
    readonly key: string
  }): boolean
  listExtensionStorageEntries(input: {
    readonly extensionId: ExtensionId
    readonly owner: 'shared' | AgentId
    readonly partition: string
    readonly prefix?: string
    readonly limit?: number
    readonly after?: string
  }): { readonly entries: readonly { key: string; value: JsonValue; updatedAt: number }[]; readonly next?: string }
}

const storageOwner = (owner: string): 'shared' | AgentId => (owner === 'shared' ? 'shared' : AgentIdSchema.parse(owner))

/** Persistent `nxt.storage` backed by the Core SQLite table; quota errors surface with a readable message. */
export const sqliteNxtStorage = (repository: StorageRepository, now: () => number = Date.now): NxtStorageBackend => ({
  get: (ownerKey, location, key) =>
    Promise.resolve(
      repository.getExtensionStorageEntry({
        extensionId: ExtensionIdSchema.parse(ownerKey),
        owner: storageOwner(location.owner),
        partition: location.partition,
        key,
      }),
    ),
  set: (ownerKey, location, key, value, quotaBytes) => {
    try {
      repository.setExtensionStorageEntry({
        extensionId: ExtensionIdSchema.parse(ownerKey),
        owner: storageOwner(location.owner),
        partition: location.partition,
        key,
        value,
        updatedAt: now(),
        quotaBytes,
      })
      return Promise.resolve()
    } catch (error) {
      if (error instanceof ExtensionStorageQuotaError) {
        return Promise.reject(
          new Error(
            `扩展存储已满：写入后共 ${error.usedBytes} 字节，上限 ${error.quotaBytes} 字节。请删除不再需要的数据。`,
          ),
        )
      }
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
  },
  delete: (ownerKey, location, key) =>
    Promise.resolve(
      repository.deleteExtensionStorageEntry({
        extensionId: ExtensionIdSchema.parse(ownerKey),
        owner: storageOwner(location.owner),
        partition: location.partition,
        key,
      }),
    ),
  list: (ownerKey, location, options) =>
    Promise.resolve(
      repository.listExtensionStorageEntries({
        extensionId: ExtensionIdSchema.parse(ownerKey),
        owner: storageOwner(location.owner),
        partition: location.partition,
        limit: options.limit,
        ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
        ...(options.after === undefined ? {} : { after: options.after }),
      }),
    ),
})

/**
 * Throwaway storage for dynamic runs and verification: a candidate exercises the same API without touching the
 * saved data of any Activation. The quota is still enforced so a candidate fails here, not after it is enabled.
 */
export const memoryNxtStorage = (now: () => number = Date.now): NxtStorageBackend => {
  const entries = new Map<string, { readonly value: JsonValue; readonly updatedAt: number; readonly bytes: number }>()
  const scope = (ownerKey: string, location: NxtStoragePartition) =>
    `${ownerKey}\0${location.owner}\0${location.partition}\0`
  const usage = (ownerKey: string): number =>
    [...entries].reduce((total, [key, entry]) => (key.startsWith(`${ownerKey}\0`) ? total + entry.bytes : total), 0)
  return {
    get: (ownerKey, location, key) => Promise.resolve(entries.get(scope(ownerKey, location) + key)?.value),
    set: (ownerKey, location, key, value, quotaBytes) => {
      const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8')
      if (bytes > 256 * 1024) return Promise.reject(new Error('单个存储值不能超过 256 KiB。'))
      const id = scope(ownerKey, location) + key
      const total = usage(ownerKey) - (entries.get(id)?.bytes ?? 0) + bytes
      if (total > quotaBytes) {
        return Promise.reject(new Error(`扩展存储已满：写入后共 ${total} 字节，上限 ${quotaBytes} 字节。`))
      }
      entries.set(id, { value, updatedAt: now(), bytes })
      return Promise.resolve()
    },
    delete: (ownerKey, location, key) => Promise.resolve(entries.delete(scope(ownerKey, location) + key)),
    list: (ownerKey, location, options) => {
      const prefix = scope(ownerKey, location)
      const keys = [...entries.keys()]
        .filter((id) => id.startsWith(prefix))
        .map((id) => id.slice(prefix.length))
        .filter(
          (key) =>
            (options.prefix === undefined || key.startsWith(options.prefix)) &&
            (options.after === undefined || key > options.after),
        )
        .sort()
      const page = keys.slice(0, options.limit)
      const last = page.at(-1)
      return Promise.resolve({
        entries: page.map((key) => {
          const entry = entries.get(prefix + key)
          if (entry === undefined) throw new Error('Storage entry vanished during listing.')
          return { key, value: entry.value, updatedAt: entry.updatedAt }
        }),
        ...(keys.length > options.limit && last !== undefined ? { next: last } : {}),
      })
    },
  }
}

/**
 * Jobs of dynamic runs and verification: recorded so a candidate can schedule, list and cancel, but never fired,
 * because an unsaved candidate must not wake the agent later.
 */
export const memoryNxtJobs = (): NxtServiceBackends['jobs'] => {
  const jobs = new Map<
    string,
    { readonly ownerKey: string; readonly channelId: string; readonly record: NxtJobRecord }
  >()
  let sequence = 0
  const owned = (binding: NxtServiceBinding) =>
    [...jobs.values()].filter((job) => job.ownerKey === binding.ownerKey && job.channelId === binding.channelId)
  return {
    schedule: (binding, job, maxActive) => {
      if (owned(binding).length >= maxActive) {
        return Promise.reject(new Error(`这个扩展同时最多保留 ${maxActive} 个定时任务，请先取消不需要的任务。`))
      }
      sequence += 1
      const record: NxtJobRecord = {
        jobId: `job_PREVIEW${sequence}`,
        label: job.label,
        nextRunAt: job.nextRunAt,
        ...(job.schedule.kind === 'cron' ? { cron: job.schedule.cron } : { at: job.schedule.at }),
      }
      jobs.set(record.jobId, { ownerKey: binding.ownerKey, channelId: binding.channelId, record })
      return Promise.resolve(record)
    },
    list: (binding) => Promise.resolve(owned(binding).map(({ record }) => record)),
    cancel: (binding, jobId) => {
      const job = jobs.get(jobId)
      if (job === undefined || job.ownerKey !== binding.ownerKey) return Promise.resolve(false)
      return Promise.resolve(jobs.delete(jobId))
    },
  }
}

/** Dynamic runs and verification never touch real people: the call path runs, the platform does not. */
export const previewPlatformResult = (kind: string, name: string): NxtPlatformResult => ({
  status: 'succeeded',
  message: `预览模式：${kind} ${name} 未实际执行，启用后才会真正调用平台。`,
})
