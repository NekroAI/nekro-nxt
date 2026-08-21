import type { AdapterInboundEvent } from '@nekro-nxt/adapter-sdk'
import type {
  AgentId,
  AgentRevisionId,
  ChannelId,
  ChannelMemberId,
  ConnectionId,
  PlatformIdentityId,
} from '@nekro-nxt/contracts'
import {
  AgentIdSchema,
  AssetIdSchema,
  ChannelIdSchema,
  ChannelMemberIdSchema,
  ConnectionIdSchema,
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
  CreateAgentWithChannelCommit,
  PlatformIdentityRecord,
} from '../src/index.ts'
import {
  CoreService,
  canonicalJson,
  digestRevision,
  parseAgentCapabilityGrants,
  parseStoredAgentCapabilityGrants,
} from '../src/index.ts'

const deniedCapabilities = {
  subagents: false,
  fileTools: false,
  webSearch: false,
  dynamicCreation: false,
  developmentShell: false,
  unrestrictedFileAccess: false,
} as const

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

  createAgentWithChannel(commit: CreateAgentWithChannelCommit): void {
    this.createAgent(commit)
    this.createChannel(commit.channel)
    this.replaceBinding(commit.binding)
  }

  getAgent(id: AgentId) {
    return this.agents.get(id)
  }

  listAgents() {
    return [...this.agents.values()].sort(
      (left, right) =>
        left.definition.createdAt - right.definition.createdAt || left.definition.id.localeCompare(right.definition.id),
    )
  }

  getAgentRevision(id: AgentRevisionId) {
    return this.revisions.get(id)
  }
  getAgentRevisionByDigest(agentId: AgentId, contentDigest: string) {
    return [...this.revisions.values()].find(
      (revision) => revision.agentId === agentId && revision.contentDigest === contentDigest,
    )
  }
  listAgentRevisions(agentId: AgentId) {
    return [...this.revisions.values()]
      .filter((revision) => revision.agentId === agentId)
      .sort((left, right) => left.revision - right.revision || left.id.localeCompare(right.id))
  }
  getNextAgentRevisionNumber(agentId: AgentId): number {
    return (
      Math.max(
        0,
        ...[...this.revisions.values()]
          .filter((revision) => revision.agentId === agentId)
          .map((revision) => revision.revision),
      ) + 1
    )
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

  activateAgentRevision(
    definition: AgentDefinitionRecord,
    revision: AgentRevisionRecord,
    expectedCurrentRevisionId: AgentRevisionId,
  ): void {
    const current = this.agents.get(definition.id)
    if (current?.definition.currentRevisionId !== expectedCurrentRevisionId) throw new Error('revision conflict')
    this.agents.set(definition.id, { definition, revision })
  }

  createConnection(record: ConnectionRecord): void {
    this.connections.set(record.id, record)
  }

  updateConnectionAlias(id: ConnectionId, alias?: string): void {
    const current = this.connections.get(id)
    if (!current) throw new Error(`Unknown connection: ${id}`)
    if (alias === undefined) {
      this.connections.set(id, {
        id: current.id,
        adapterKey: current.adapterKey,
        config: current.config,
        credentialRefs: current.credentialRefs,
        createdAt: current.createdAt,
      })
    } else {
      this.connections.set(id, { ...current, alias })
    }
  }

  getConnection(id: ConnectionId) {
    return this.connections.get(id)
  }

  listConnectionIdsByAdapter(adapterKey?: string): readonly ConnectionId[] {
    return [...this.connections.values()]
      .filter((connection) => adapterKey === undefined || connection.adapterKey === adapterKey)
      .map((connection) => connection.id)
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

  updateChannelDisplayName(id: ChannelId, displayName: string): void {
    const current = this.channels.get(id)
    if (!current) throw new Error(`Unknown channel: ${id}`)
    this.channels.set(id, { ...current, displayName })
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

  replaceBinding(record: BindingRecord): BindingRecord {
    const currentIndex = this.bindings.findIndex((binding) => binding.channelId === record.channelId)
    if (currentIndex >= 0) this.bindings.splice(currentIndex, 1)
    const existingIndex = this.bindings.findIndex(
      (binding) => binding.channelId === record.channelId && binding.agentId === record.agentId,
    )
    if (existingIndex >= 0) this.bindings.splice(existingIndex, 1)
    this.bindings.push(record)
    return record
  }

  clearBinding(channelId: ChannelId): void {
    for (let index = this.bindings.length - 1; index >= 0; index -= 1) {
      if (this.bindings[index]?.channelId === channelId) this.bindings.splice(index, 1)
    }
  }

  getBinding(channelId: ChannelId) {
    return this.bindings.find((binding) => binding.channelId === channelId)
  }

  listBindings(channelId: ChannelId) {
    return this.bindings.filter((binding) => binding.channelId === channelId)
  }

  appendChannelEvent(candidate: ChannelEventRecord): AppendChannelEventCommit {
    const key = `${candidate.channelId}:${candidate.dedupeKey}`
    const existing = this.events.get(key)
    if (existing) return { event: existing, inserted: false }
    this.events.set(key, candidate)
    return { event: candidate, inserted: true }
  }

  getChannelEvent(id: ChannelEventRecord['id']) {
    return [...this.events.values()].find((event) => event.id === id)
  }

  listChannelEvents(
    channelId: ChannelId,
    options: {
      readonly before?: { readonly receivedAt: number; readonly id: ChannelEventRecord['id'] }
      readonly limit?: number
    } = {},
  ) {
    const rows = [...this.events.values()]
      .filter((event) => event.channelId === channelId)
      .filter(
        (event) =>
          options.before === undefined ||
          event.receivedAt < options.before.receivedAt ||
          (event.receivedAt === options.before.receivedAt && event.id < options.before.id),
      )
      .sort((left, right) => right.receivedAt - left.receivedAt || right.id.localeCompare(left.id))
    return rows.slice(0, options.limit ?? 12).toReversed()
  }

  resolvePlatformMessage(connectionId: ConnectionId, channelId: ChannelId, platformMessageId: string) {
    const event = [...this.events.values()].find(
      (candidate) =>
        this.channels.get(candidate.channelId)?.connectionId === connectionId &&
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
        this.channels.get(event.channelId)?.connectionId === connectionId &&
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
    expect(core.listAgents()).toEqual([first])
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
    const restored = core.reviseAgent(first.definition.id, second.revision.id, {
      displayName: '小奈',
      persona: '保持简洁。',
      model: { provider: 'deepseek', model: 'v4' },
    })
    expect(restored.revision.id).toBe(first.revision.id)
    const third = core.reviseAgent(first.definition.id, restored.revision.id, {
      displayName: '小奈',
      persona: '第三种配置。',
      model: { provider: 'deepseek', model: 'v4' },
    })
    expect(third.revision.revision).toBe(3)
    expect(() =>
      core.reviseAgent(first.definition.id, first.revision.id, {
        displayName: '过期修改',
        persona: '',
        model: { provider: 'deepseek', model: 'v4' },
      }),
    ).toThrow('revision conflict')
  })

  it('uses canonical content digests independent of object key order', () => {
    const first = digestRevision({
      displayName: '小奈',
      persona: '',
      model: { provider: 'deepseek', model: 'v4' },
      capabilities: deniedCapabilities,
    })
    const second = digestRevision({
      persona: '',
      displayName: '小奈',
      model: { model: 'v4', provider: 'deepseek' },
      capabilities: { ...deniedCapabilities },
    })
    expect(first).toBe(second)
    expect(first).toMatch(/^v2:sha256:[a-f0-9]{64}$/u)
  })

  it('accepts only the current strict capability object', () => {
    const current = { ...deniedCapabilities, subagents: true, webSearch: true }
    expect(parseStoredAgentCapabilityGrants(current)).toEqual(current)
    expect(() => parseStoredAgentCapabilityGrants({ version: 2, grants: current })).toThrow()
    expect(() => parseStoredAgentCapabilityGrants({ ...current, fullFileAccess: false })).toThrow()
  })

  it('reuses a semantically equivalent historical Revision even when it has a legacy digest', () => {
    const repository = new MemoryRepository()
    let id = 0
    const core = new CoreService(repository, { now: () => 100, nextUlid: () => `ID${++id}` })
    const first = core.createAgent({
      displayName: '小奈',
      persona: '第一版',
      model: { provider: 'deepseek', model: 'v4' },
    })
    repository.revisions.set(first.revision.id, { ...first.revision, contentDigest: 'legacy-v1-digest' })
    const second = core.reviseAgent(first.definition.id, first.revision.id, {
      displayName: '小奈',
      persona: '第二版',
      model: { provider: 'deepseek', model: 'v4' },
    })
    const restored = core.reviseAgent(first.definition.id, second.revision.id, {
      displayName: '小奈',
      persona: '第一版',
      model: { provider: 'deepseek', model: 'v4' },
    })
    expect(restored.revision.id).toBe(first.revision.id)
    expect(repository.revisions).toHaveLength(2)
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
    ).toMatchObject({ triggerPolicy: 'always' })

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

  it('normalizes Connection aliases on create, update, and clear', () => {
    const repository = new MemoryRepository()
    let id = 0
    const core = new CoreService(repository, { now: () => 100, nextUlid: () => `ID${++id}` })

    const created = core.createConnection({ adapterKey: 'qq-openclaw', config: {}, alias: '  工作群账号  ' })
    expect(created.alias).toBe('工作群账号')
    expect(core.getConnection(created.id)?.alias).toBe('工作群账号')

    const updated = core.updateConnectionAlias(created.id, '  备用账号  ')
    expect(updated.alias).toBe('备用账号')
    expect(core.getConnection(created.id)?.alias).toBe('备用账号')

    expect(core.updateConnectionAlias(created.id, '   ')).not.toHaveProperty('alias')
    expect(core.getConnection(created.id)).not.toHaveProperty('alias')
    expect(() => core.createConnection({ adapterKey: 'qq-openclaw', config: {}, alias: 'a'.repeat(81) })).toThrow()
    expect(() => core.updateConnectionAlias(created.id, 'a'.repeat(81))).toThrow()
  })

  it('allows one agent to bind multiple channels while each channel keeps one agent', () => {
    const repository = new MemoryRepository()
    let id = 0
    const core = new CoreService(repository, { now: () => 100, nextUlid: () => `ID${++id}` })
    const agent = core.createAgent({
      displayName: '小奈',
      persona: '',
      model: { provider: 'deepseek', model: 'v4' },
    })
    const connection = core.createConnection({ adapterKey: 'web', config: {} })
    const first = core.createChannel({ connectionId: connection.id, platformChannelId: 'first', kind: 'web' })
    const second = core.createChannel({ connectionId: connection.id, platformChannelId: 'second', kind: 'web' })
    core.createBinding({ channelId: first.id, agentId: agent.definition.id, triggerPolicy: 'always' })
    core.createBinding({ channelId: second.id, agentId: agent.definition.id, triggerPolicy: 'command' })
    expect(core.listBindings(first.id)).toEqual([
      expect.objectContaining({ agentId: agent.definition.id, triggerPolicy: 'always' }),
    ])
    expect(core.listBindings(second.id)).toEqual([
      expect.objectContaining({ agentId: agent.definition.id, triggerPolicy: 'command' }),
    ])

    const replacement = core.createAgent({
      displayName: '小新',
      persona: '',
      model: { provider: 'deepseek', model: 'v4' },
    })
    core.replaceBinding({ channelId: first.id, agentId: replacement.definition.id, triggerPolicy: 'observe-only' })
    expect(core.listBindings(first.id)).toEqual([
      expect.objectContaining({ agentId: replacement.definition.id, triggerPolicy: 'observe-only' }),
    ])
    expect(core.listBindings(second.id)).toEqual([
      expect.objectContaining({ agentId: agent.definition.id, triggerPolicy: 'command' }),
    ])

    core.clearBinding(first.id)
    expect(core.listBindings(first.id)).toEqual([])
    expect(core.listBindings(second.id)).toHaveLength(1)
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
    })
    expect(repeated.member).toMatchObject({
      id: first.member.id,
      displayName: '成员乙',
    })
    expect(core.resolveChannelMemberIdentity(firstConnection.id, firstChannel.id, repeated.member.id)).toMatchObject({
      platformUserId: 'member-openid',
    })
    expect(core.resolveChannelMemberIdentity(secondConnection.id, firstChannel.id, repeated.member.id)).toBeUndefined()
  })

  it('creates an agent with a default Web Channel and lists only existing matching connections', () => {
    const repository = new MemoryRepository()
    let id = 0
    const core = new CoreService(repository, { now: () => 100, nextUlid: () => `ID${++id}` })
    const connection = core.createConnection({ adapterKey: 'web', config: {} })
    const otherConnection = core.createConnection({ adapterKey: 'qq-openclaw', config: { account: 'two' } })

    expect(core.listConnections()).toEqual([connection, otherConnection])
    expect(core.listConnectionsByAdapter('web')).toEqual([connection])

    const commit = core.createAgentWithChannel(
      { displayName: '小奈', persona: '', model: { provider: 'deepseek', model: 'v4' } },
      { connectionId: connection.id, kind: 'web', triggerPolicy: 'always' },
    )

    expect(commit.channel).toMatchObject({
      connectionId: connection.id,
      platformChannelId: `web-${commit.definition.id}`,
      kind: 'web',
    })
    expect(core.getChannel(commit.channel.id)).toEqual(commit.channel)
    expect(core.getChannelByPlatformId(connection.id, commit.channel.platformChannelId)).toEqual(commit.channel)
    expect(core.listChannelsByConnection(connection.id)).toEqual([commit.channel])
    expect(core.listBindings(commit.channel.id)).toEqual([commit.binding])
  })

  it('rejects invalid inputs and unknown domain references before committing', () => {
    const repository = new MemoryRepository()
    let id = 0
    const core = new CoreService(repository, { now: () => 100, nextUlid: () => `ID${++id}` })

    expect(() =>
      core.createAgent({ displayName: ' ', persona: '', model: { provider: 'deepseek', model: 'v4' } }),
    ).toThrow()
    expect(() => core.createConnection({ adapterKey: 'Not valid', config: {} })).toThrow()
    expect(() => core.createConnection({ adapterKey: 'web', config: {}, credentialRefs: { token: ' ' } })).toThrow()
    expect(() =>
      core.createAgentWithChannel(
        { displayName: '小奈', persona: '', model: { provider: 'deepseek', model: 'v4' } },
        { connectionId: ConnectionIdSchema.parse('con_missing'), kind: 'web', triggerPolicy: 'always' },
      ),
    ).toThrow('Unknown connection')
    expect(() =>
      core.createChannel({
        connectionId: ConnectionIdSchema.parse('con_missing'),
        platformChannelId: 'main',
        kind: 'group',
      }),
    ).toThrow('Unknown connection')
    expect(() =>
      core.ensureChannel({
        connectionId: ConnectionIdSchema.parse('con_missing'),
        platformChannelId: 'main',
        kind: 'group',
        observedAt: 100,
      }),
    ).toThrow('Unknown connection')
    expect(() => core.updateChannelDisplayName(ChannelIdSchema.parse('chn_missing'), '新名称')).toThrow(
      'Unknown channel',
    )
    expect(() => core.updateChannelDisplayName(ChannelIdSchema.parse('chn_missing'), ' ')).toThrow()

    const agent = core.createAgent({ displayName: '小奈', persona: '', model: { provider: 'deepseek', model: 'v4' } })
    expect(() => core.reviseAgent(AgentIdSchema.parse('agt_missing'), agent.revision.id, agent.revision)).toThrow(
      'Unknown agent',
    )
    expect(() =>
      core.createBinding({
        channelId: ChannelIdSchema.parse('chn_missing'),
        agentId: agent.definition.id,
        triggerPolicy: 'always',
      }),
    ).toThrow('Unknown channel')
    expect(() =>
      core.replaceBinding({
        channelId: ChannelIdSchema.parse('chn_missing'),
        agentId: agent.definition.id,
        triggerPolicy: 'always',
      }),
    ).toThrow('Unknown channel')
    expect(() =>
      core.createBinding({
        channelId: ChannelIdSchema.parse('chn_missing'),
        agentId: AgentIdSchema.parse('agt_missing'),
        triggerPolicy: 'always',
      }),
    ).toThrow('Unknown channel')
  })

  it('validates binding replacement, member ownership, and inbound asset occurrences', () => {
    const repository = new MemoryRepository()
    let id = 0
    const core = new CoreService(repository, { now: () => 100, nextUlid: () => `ID${++id}` })
    const connection = core.createConnection({ adapterKey: 'web', config: {} })
    const otherConnection = core.createConnection({ adapterKey: 'web', config: {} })
    const channel = core.createChannel({ connectionId: connection.id, platformChannelId: 'main', kind: 'group' })
    const otherChannel = core.createChannel({
      connectionId: otherConnection.id,
      platformChannelId: 'other',
      kind: 'group',
    })
    const agent = core.createAgent({ displayName: '小奈', persona: '', model: { provider: 'deepseek', model: 'v4' } })
    const replacement = core.createAgent({
      displayName: '小新',
      persona: '',
      model: { provider: 'deepseek', model: 'v4' },
    })
    const member = core.observeChannelMember({
      connectionId: connection.id,
      channelId: channel.id,
      platformUserId: 'member-1',
      displayName: '成员',
      observedAt: 100,
    })

    core.createBinding({ channelId: channel.id, agentId: agent.definition.id, triggerPolicy: 'always' })
    expect(() =>
      core.createBinding({ channelId: channel.id, agentId: replacement.definition.id, triggerPolicy: 'always' }),
    ).toThrow('already bound')
    expect(() =>
      core.replaceBinding({
        channelId: otherChannel.id,
        agentId: AgentIdSchema.parse('agt_missing'),
        triggerPolicy: 'always',
      }),
    ).toThrow('Unknown agent')
    expect(
      core.replaceBinding({ channelId: channel.id, agentId: replacement.definition.id, triggerPolicy: 'command' }),
    ).toMatchObject({
      agentId: replacement.definition.id,
      triggerPolicy: 'command',
    })
    expect(core.resolveChannelMemberIdentity(connection.id, otherChannel.id, member.member.id)).toBeUndefined()
    expect(
      core.resolveChannelMemberIdentity(connection.id, channel.id, ChannelMemberIdSchema.parse('mbr_missing')),
    ).toBeUndefined()

    const assetId = AssetIdSchema.parse('ast_image1')
    const event: AdapterInboundEvent = {
      connectionId: connection.id,
      channelId: channel.id,
      adapterKey: 'web',
      platformMessageId: 'platform-asset',
      kind: 'message-created',
      senderMemberId: member.member.id,
      parts: [
        { type: 'text', text: '图片' },
        { type: 'image', assetId },
      ],
      platformTimestamp: 100,
      receivedAt: 101,
      dedupeKey: 'asset-event',
      assetOccurrences: [{ partIndex: 1, assetId }],
    }
    expect(core.appendInbound(event)).toMatchObject({ inserted: true })
    const previewId = AssetIdSchema.parse('ast_preview1')
    expect(
      core.appendInbound({
        connectionId: connection.id,
        channelId: channel.id,
        adapterKey: 'web',
        kind: 'message-created',
        senderMemberId: member.member.id,
        parts: [
          {
            type: 'rich',
            adapterKey: 'web',
            kind: 'card',
            summary: '分享摘要',
            title: '分享标题',
            previewAssetId: previewId,
          },
        ],
        platformTimestamp: 100,
        receivedAt: 102,
        dedupeKey: 'rich-event',
        assetOccurrences: [{ partIndex: 0, assetId: previewId }],
      }),
    ).toMatchObject({ inserted: true })
    expect([...repository.events.values()].at(-1)).toMatchObject({
      searchText: '分享摘要\n分享标题',
    })
    expect(core.resolvePlatformMessage(connection.id, channel.id, 'platform-asset')).toMatchObject({
      authoredByAgent: false,
    })
    expect(
      core.resolveLogicalMessagePlatformId(
        connection.id,
        channel.id,
        [...repository.events.values()][0]!.logicalMessageId,
      ),
    ).toBe('platform-asset')
    expect(() =>
      core.appendInbound({ ...event, dedupeKey: 'bad-occurrence', assetOccurrences: [{ partIndex: 0, assetId }] }),
    ).toThrow('does not match message part')
    expect(() =>
      core.appendInbound({
        ...event,
        dedupeKey: 'wrong-sender',
        senderMemberId: ChannelMemberIdSchema.parse('mbr_other'),
      }),
    ).toThrow('does not belong to channel')
    expect(() => core.appendInbound({ ...event, dedupeKey: 'wrong-adapter', adapterKey: 'qq-openclaw' })).toThrow(
      'does not own connection',
    )
    expect(() => core.appendInbound({ ...event, dedupeKey: 'wrong-channel', channelId: otherChannel.id })).toThrow(
      'does not belong to connection',
    )
  })

  it('covers canonical JSON arrays and validates clock and capability boundaries', () => {
    expect(canonicalJson({ z: [true, null, 2], a: 'x' })).toBe('{"a":"x","z":[true,null,2]}')
    expect(parseAgentCapabilityGrants({ subagents: true })).toEqual({ ...deniedCapabilities, subagents: true })

    const repository = new MemoryRepository()
    const invalidClock = new CoreService(repository, { now: () => -1, nextUlid: () => 'ID' })
    expect(() =>
      invalidClock.createAgent({ displayName: '小奈', persona: '', model: { provider: 'p', model: 'm' } }),
    ).toThrow('Clock must return')
    const invalidId = new CoreService(repository, { now: () => 100, nextUlid: () => '' })
    expect(() =>
      invalidId.createAgent({ displayName: '小奈', persona: '', model: { provider: 'p', model: 'm' } }),
    ).toThrow()
  })
})
