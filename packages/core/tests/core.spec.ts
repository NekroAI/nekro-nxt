import type { AdapterInboundEvent } from '@nekro-nxt/adapter-sdk'
import type {
  AgentId,
  AgentRevisionId,
  ChannelId,
  ChannelMemberId,
  ConnectionId,
  PlatformIdentityId,
} from '@nekro-nxt/contracts'
import { describe, expect, it } from 'vitest'
import type {
  AgentDefinitionRecord,
  AgentRevisionRecord,
  AppendChannelEventCommit,
  BindingRecord,
  ChannelEventRecord,
  ChannelMemberRecord,
  ChannelRecord,
  ConnectionRecord,
  CoreRepository,
  CreateAgentCommit,
  PlatformIdentityRecord,
} from '../src/index.ts'
import { CoreService, digestRevision } from '../src/index.ts'

class MemoryRepository implements CoreRepository {
  readonly agents = new Map<AgentId, CreateAgentCommit>()
  readonly revisions = new Map<AgentRevisionId, AgentRevisionRecord>()
  readonly connections = new Map<ConnectionId, ConnectionRecord>()
  readonly channels = new Map<ChannelId, ChannelRecord>()
  readonly bindings: BindingRecord[] = []
  readonly events = new Map<string, ChannelEventRecord>()
  readonly identities = new Map<PlatformIdentityId, PlatformIdentityRecord>()
  readonly members = new Map<ChannelMemberId, ChannelMemberRecord>()

  createAgent(commit: CreateAgentCommit): void {
    this.agents.set(commit.definition.id, commit)
    this.revisions.set(commit.revision.id, commit.revision)
  }

  getAgent(id: AgentId) {
    return this.agents.get(id)
  }

  getAgentRevision(id: AgentRevisionId) {
    return this.revisions.get(id)
  }

  appendAgentRevision(
    definition: AgentDefinitionRecord,
    revision: AgentRevisionRecord,
    expectedCurrentRevisionId: AgentRevisionId,
  ): void {
    const current = this.agents.get(definition.id)
    if (current?.definition.currentRevisionId !== expectedCurrentRevisionId) throw new Error('revision conflict')
    this.agents.set(definition.id, { definition, revision })
    this.revisions.set(revision.id, revision)
  }

  createConnection(record: ConnectionRecord): void {
    this.connections.set(record.id, record)
  }

  getConnection(id: ConnectionId) {
    return this.connections.get(id)
  }

  createChannel(record: ChannelRecord): void {
    this.channels.set(record.id, record)
  }

  ensureChannel(record: ChannelRecord): ChannelRecord {
    const existing = [...this.channels.values()].find(
      (channel) =>
        channel.connectionId === record.connectionId && channel.platformChannelId === record.platformChannelId,
    )
    if (existing) {
      const updated = { ...existing, ...(record.displayName === undefined ? {} : { displayName: record.displayName }) }
      this.channels.set(existing.id, updated)
      return updated
    }
    this.channels.set(record.id, record)
    return record
  }

  getChannel(id: ChannelId) {
    return this.channels.get(id)
  }

  getChannelByPlatformId(connectionId: ConnectionId, platformChannelId: string) {
    return [...this.channels.values()].find(
      (channel) => channel.connectionId === connectionId && channel.platformChannelId === platformChannelId,
    )
  }

  listChannelIdsByConnection(connectionId: ConnectionId): readonly ChannelId[] {
    return [...this.channels.values()]
      .filter((channel) => channel.connectionId === connectionId)
      .map((channel) => channel.id)
  }

  ensurePlatformIdentity(record: PlatformIdentityRecord): PlatformIdentityRecord {
    const existing = [...this.identities.values()].find(
      (identity) => identity.connectionId === record.connectionId && identity.platformUserId === record.platformUserId,
    )
    const stored = existing
      ? {
          ...existing,
          ...(record.displayName === undefined ? {} : { displayName: record.displayName }),
          lastSeenAt: Math.max(existing.lastSeenAt, record.lastSeenAt),
          seenCount: existing.seenCount + 1,
        }
      : record
    this.identities.set(stored.id, stored)
    return stored
  }

  getPlatformIdentity(id: PlatformIdentityId) {
    return this.identities.get(id)
  }

  ensureChannelMember(record: ChannelMemberRecord): ChannelMemberRecord {
    const existing = this.getChannelMemberByIdentity(record.channelId, record.platformIdentityId)
    const stored = existing
      ? {
          ...existing,
          ...(record.displayName === undefined ? {} : { displayName: record.displayName }),
          lastSeenAt: Math.max(existing.lastSeenAt, record.lastSeenAt),
          seenCount: existing.seenCount + 1,
        }
      : record
    this.members.set(stored.id, stored)
    return stored
  }

  getChannelMember(id: ChannelMemberId) {
    return this.members.get(id)
  }

  getChannelMemberByIdentity(channelId: ChannelId, platformIdentityId: PlatformIdentityId) {
    return [...this.members.values()].find(
      (member) => member.channelId === channelId && member.platformIdentityId === platformIdentityId,
    )
  }

  createBinding(record: BindingRecord): void {
    this.bindings.push(record)
  }

  getBinding(channelId: ChannelId, agentId: AgentId) {
    return this.bindings.find((binding) => binding.channelId === channelId && binding.agentId === agentId)
  }

  listBindings(channelId: ChannelId) {
    return this.bindings.filter((binding) => binding.channelId === channelId)
  }

  appendChannelEvent(candidate: ChannelEventRecord): AppendChannelEventCommit {
    const key = `${candidate.connectionId}:${candidate.dedupeKey}`
    const existing = this.events.get(key)
    if (existing) return { event: existing, inserted: false, checkpointCommitted: true }
    this.events.set(key, candidate)
    return { event: candidate, inserted: true, checkpointCommitted: true }
  }

  getChannelEvent(id: ChannelEventRecord['id']) {
    return [...this.events.values()].find((event) => event.id === id)
  }

  resolvePlatformMessage(connectionId: ConnectionId, channelId: ChannelId, platformMessageId: string) {
    const event = [...this.events.values()].find(
      (candidate) =>
        candidate.connectionId === connectionId &&
        candidate.channelId === channelId &&
        candidate.platformMessageId === platformMessageId,
    )
    return event ? { logicalMessageId: event.logicalMessageId, authoredByAgent: false } : undefined
  }

  resolveLogicalMessagePlatformId(
    connectionId: ConnectionId,
    channelId: ChannelId,
    logicalMessageId: ChannelEventRecord['logicalMessageId'],
  ) {
    return [...this.events.values()].find(
      (event) =>
        event.connectionId === connectionId &&
        event.channelId === channelId &&
        event.logicalMessageId === logicalMessageId,
    )?.platformMessageId
  }
}

describe('CoreService', () => {
  it('creates immutable agent revisions and rejects stale updates', () => {
    const repository = new MemoryRepository()
    let id = 0
    const core = new CoreService(repository, { now: () => 100, nextUlid: () => `ID${++id}` })
    const first = core.createAgent({
      displayName: '小奈',
      persona: '保持简洁。',
      model: { provider: 'deepseek', model: 'v4' },
    })
    const unchanged = core.reviseAgent(first.definition.id, first.revision.id, {
      displayName: '小奈',
      persona: '保持简洁。',
      model: { provider: 'deepseek', model: 'v4' },
    })
    expect(unchanged.revision.id).toBe(first.revision.id)

    const second = core.reviseAgent(first.definition.id, first.revision.id, {
      displayName: '小奈',
      persona: '保持简洁并说明来源。',
      model: { provider: 'deepseek', model: 'v4' },
    })
    expect(second.revision).toMatchObject({ revision: 2, agentId: first.definition.id })
    expect(() =>
      core.reviseAgent(first.definition.id, first.revision.id, {
        displayName: '过期修改',
        persona: '',
        model: { provider: 'deepseek', model: 'v4' },
      }),
    ).toThrow('revision conflict')
  })

  it('uses canonical content digests independent of object key order', () => {
    expect(
      digestRevision({
        displayName: '小奈',
        persona: '',
        model: { provider: 'deepseek', model: 'v4' },
        settings: { b: 2, a: 1 },
        capabilities: { dynamicCreation: false, developmentShell: false, fullFileAccess: false },
      }),
    ).toBe(
      digestRevision({
        persona: '',
        displayName: '小奈',
        model: { model: 'v4', provider: 'deepseek' },
        settings: { a: 1, b: 2 },
        capabilities: { fullFileAccess: false, developmentShell: false, dynamicCreation: false },
      }),
    )
  })

  it('commits connection/channel/binding and idempotent inbound facts', () => {
    const repository = new MemoryRepository()
    let id = 0
    const core = new CoreService(repository, { now: () => 100, nextUlid: () => `ID${++id}` })
    const agent = core.createAgent({
      displayName: '小奈',
      persona: '',
      model: { provider: 'deepseek', model: 'v4' },
    })
    const connection = core.createConnection({ adapterKey: 'web', config: {}, credentialRefs: {} })
    const channel = core.createChannel({
      connectionId: connection.id,
      platformChannelId: 'local-main',
      kind: 'web',
      displayName: '默认频道',
    })
    expect(
      core.createBinding({ channelId: channel.id, agentId: agent.definition.id, triggerPolicy: 'always' }),
    ).toMatchObject({ revision: 1, triggerPolicy: 'always' })

    const event: AdapterInboundEvent = {
      connectionId: connection.id,
      channelId: channel.id,
      adapterKey: 'web',
      platformEventId: 'web-event-1',
      kind: 'message-created',
      parts: [{ type: 'text', text: '你好' }],
      platformTimestamp: 101,
      receivedAt: 102,
      dedupeKey: 'event:web-event-1',
    }
    expect(core.appendInbound(event).inserted).toBe(true)
    const replay = core.appendInbound(event)
    expect(replay.inserted).toBe(false)
    expect(repository.events).toHaveLength(1)
  })

  it('scopes platform identities to a Connection and keeps stable Channel members', () => {
    const repository = new MemoryRepository()
    let id = 0
    const core = new CoreService(repository, { now: () => 100, nextUlid: () => `ID${++id}` })
    const firstConnection = core.createConnection({ adapterKey: 'qq-openclaw', config: {} })
    const secondConnection = core.createConnection({ adapterKey: 'qq-openclaw', config: {} })
    const firstChannel = core.ensureChannel({
      connectionId: firstConnection.id,
      platformChannelId: 'group:shared-openid',
      kind: 'group',
      displayName: '旧群名',
      observedAt: 101,
    })
    const sameChannel = core.ensureChannel({
      connectionId: firstConnection.id,
      platformChannelId: 'group:shared-openid',
      kind: 'group',
      displayName: '新群名',
      observedAt: 102,
    })
    expect(sameChannel).toMatchObject({ id: firstChannel.id, displayName: '新群名' })

    const first = core.observeChannelMember({
      connectionId: firstConnection.id,
      channelId: firstChannel.id,
      platformUserId: 'member-openid',
      displayName: '成员甲',
      observedAt: 103,
    })
    const repeated = core.observeChannelMember({
      connectionId: firstConnection.id,
      channelId: firstChannel.id,
      platformUserId: 'member-openid',
      displayName: '成员乙',
      observedAt: 104,
    })
    expect(repeated.identity).toMatchObject({
      id: first.identity.id,
      displayName: '成员乙',
      firstSeenAt: 103,
      lastSeenAt: 104,
      seenCount: 2,
    })
    expect(repeated.member).toMatchObject({
      id: first.member.id,
      displayName: '成员乙',
      firstSeenAt: 103,
      lastSeenAt: 104,
      seenCount: 2,
    })
    expect(core.resolveChannelMemberIdentity(firstConnection.id, firstChannel.id, repeated.member.id)).toMatchObject({
      platformUserId: 'member-openid',
    })
    expect(core.resolveChannelMemberIdentity(secondConnection.id, firstChannel.id, repeated.member.id)).toBeUndefined()
  })
})
