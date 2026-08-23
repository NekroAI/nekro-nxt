import type { AdapterConnectionContext, AdapterInboundEvent } from '@nekro-nxt/adapter-sdk'
import {
  AgentIdSchema,
  AssetIdSchema,
  ChannelEventIdSchema,
  ChannelIdSchema,
  ChannelMemberIdSchema,
  EpisodeIdSchema,
  LogicalMessageIdSchema,
} from '@nekro-nxt/contracts'
import type {
  AdmissionId,
  AgentId,
  AgentRevisionId,
  ChannelEventId,
  ChannelId,
  ChannelMemberId,
  ConnectionId,
  EpisodeId,
  OutboundIntentId,
  PhysicalDeliveryId,
  PlatformIdentityId,
} from '@nekro-nxt/contracts'
import type {
  AgentDefinitionRecord,
  AgentRevisionRecord,
  AppendChannelEventCommit,
  BindingRecord,
  ChannelEventRecord,
  ChannelRecord,
  ChannelMemberRecord,
  ConnectionRecord,
  CoreRepository,
  CreateAgentCommit,
  CreateAgentWithChannelCommit,
  PlatformIdentityRecord,
} from '@nekro-nxt/core'
import { CoreService } from '@nekro-nxt/core'
import { FakeAdapterConnection, FAKE_ADAPTER_CAPABILITIES } from '@nekro-nxt/test-harness'
import { describe, expect, it } from 'vitest'
import type {
  AdmissionRecord,
  AgentSessionDriver,
  DeliveryReceiptRecord,
  EpisodeCloseReason,
  EpisodeHandoffRecord,
  EpisodeRecord,
  OutboundIntentRecord,
  OutboundSnapshot,
  OutboundState,
  PhysicalDeliveryRecord,
  RuntimeRepository,
} from '../src/index.ts'
import { ChannelRuntime, isTriggered } from '../src/index.ts'

class MemoryCoreRepository implements CoreRepository {
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
  tombstoneAgent(id: AgentId): void {
    if (!this.agents.delete(id)) throw new Error(`Unknown or deleted agent: ${id}`)
    for (let index = this.bindings.length - 1; index >= 0; index -= 1) {
      if (this.bindings[index]?.agentId === id) this.bindings.splice(index, 1)
    }
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
    const existing = this.getChannelByPlatformId(record.connectionId, record.platformChannelId)
    if (existing) return existing
    this.channels.set(record.id, record)
    return record
  }
  tombstoneChannel(id: ChannelId): void {
    if (!this.channels.delete(id)) throw new Error(`Unknown or deleted channel: ${id}`)
    for (let index = this.bindings.length - 1; index >= 0; index -= 1) {
      if (this.bindings[index]?.channelId === id) this.bindings.splice(index, 1)
    }
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
    if (existing) return existing
    this.identities.set(record.id, record)
    return record
  }
  getPlatformIdentity(id: PlatformIdentityId) {
    return this.identities.get(id)
  }
  listPlatformUsers() {
    return []
  }
  ensureChannelMember(record: ChannelMemberRecord): ChannelMemberRecord {
    const existing = this.getChannelMemberByIdentity(record.channelId, record.platformIdentityId)
    if (existing) return existing
    this.members.set(record.id, record)
    return record
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
  getChannelEvent(id: ChannelEventId) {
    return [...this.events.values()].find((event) => event.id === id)
  }
  listChannelEvents(
    channelId: ChannelId,
    options: {
      readonly before?: { readonly receivedAt: number; readonly id: ChannelEventId }
      readonly limit?: number
    } = {},
  ) {
    return [...this.events.values()]
      .filter(
        (event) =>
          event.channelId === channelId &&
          (options.before === undefined ||
            event.receivedAt < options.before.receivedAt ||
            (event.receivedAt === options.before.receivedAt && event.id < options.before.id)),
      )
      .sort((left, right) => left.receivedAt - right.receivedAt || left.id.localeCompare(right.id))
      .slice(-(options.limit ?? 12))
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

class MemoryRuntimeRepository implements RuntimeRepository {
  readonly episodes = new Map<EpisodeId, EpisodeRecord>()
  readonly admissions = new Map<AdmissionId, AdmissionRecord>()
  readonly outbounds = new Map<OutboundIntentId, OutboundSnapshot>()
  readonly handoffs: EpisodeHandoffRecord[] = []

  constructor(readonly core: MemoryCoreRepository) {}

  getEpisode(id: EpisodeId) {
    return this.episodes.get(id)
  }
  getActiveEpisode(channelId: ChannelId, agentId: AgentId) {
    return [...this.episodes.values()].find(
      (episode) => episode.channelId === channelId && episode.agentId === agentId && episode.status === 'active',
    )
  }
  listRecoverableEpisodes() {
    return [...this.episodes.values()].filter(({ status }) => status === 'opening' || status === 'active')
  }

  listActiveEpisodesForAgent(agentId: AgentId) {
    return [...this.episodes.values()].filter((episode) => episode.agentId === agentId && episode.status === 'active')
  }
  getEpisodeHandoffTo(episodeId: EpisodeId) {
    return this.handoffs.find(({ toEpisodeId }) => toEpisodeId === episodeId)
  }
  createEpisode(record: EpisodeRecord): void {
    this.episodes.set(record.id, record)
  }
  activateEpisode(id: EpisodeId, dshSessionId: string): EpisodeRecord {
    const current = this.requiredEpisode(id)
    const active = { ...current, status: 'active' as const, dshSessionId }
    this.episodes.set(id, active)
    return active
  }
  updateEpisodeRevision(
    id: EpisodeId,
    expectedRevisionId: AgentRevisionId,
    targetRevisionId: AgentRevisionId,
  ): EpisodeRecord {
    const current = this.requiredEpisode(id)
    if (current.agentRevisionId !== expectedRevisionId) throw new Error('episode revision conflict')
    const updated = { ...current, agentRevisionId: targetRevisionId }
    this.episodes.set(id, updated)
    return updated
  }
  closeEpisode(
    id: EpisodeId,
    reason: EpisodeCloseReason,
    closedAtEventId: ChannelEventId,
    closedAt: number,
  ): EpisodeRecord {
    const updated = {
      ...this.requiredEpisode(id),
      status: 'closed' as const,
      closeReason: reason,
      closedAtEventId,
      closedAt,
    }
    this.episodes.set(id, updated)
    return updated
  }
  commitEpisodeRollover(input: {
    readonly fromEpisodeId: EpisodeId
    readonly reason: EpisodeCloseReason
    readonly closedAtEventId: ChannelEventId
    readonly closedAt: number
    readonly nextEpisode: EpisodeRecord
    readonly handoff: EpisodeHandoffRecord
  }): void {
    this.closeEpisode(input.fromEpisodeId, input.reason, input.closedAtEventId, input.closedAt)
    this.episodes.set(input.nextEpisode.id, input.nextEpisode)
    this.handoffs.push(input.handoff)
  }
  failEpisode(id: EpisodeId): void {
    this.episodes.set(id, { ...this.requiredEpisode(id), status: 'failed' })
  }
  createAdmission(record: AdmissionRecord): void {
    this.admissions.set(record.id, record)
  }
  listRecoverableAdmissions(episodeId: EpisodeId) {
    return [...this.admissions.values()].filter(
      (admission) =>
        admission.episodeId === episodeId && (admission.state === 'pending' || admission.state === 'claimed'),
    )
  }
  listAdmittedEvents(episodeId: EpisodeId, limit: number) {
    const eventIds = new Set(
      [...this.admissions.values()]
        .filter((admission) => admission.episodeId === episodeId)
        .flatMap((admission) => admission.eventIds),
    )
    return [...this.core.events.values()]
      .filter((event) => eventIds.has(event.id))
      .sort((left, right) => left.receivedAt - right.receivedAt || left.id.localeCompare(right.id))
      .slice(-limit)
  }
  listUnadmittedEvents(channelId: ChannelId, agentId: AgentId, boundAt: number) {
    const episodeIds = new Set(
      [...this.episodes.values()]
        .filter((episode) => episode.channelId === channelId && episode.agentId === agentId)
        .map(({ id }) => id),
    )
    const admitted = new Set(
      [...this.admissions.values()]
        .filter((admission) => episodeIds.has(admission.episodeId))
        .flatMap(({ eventIds }) => [...eventIds]),
    )
    return [...this.core.events.values()]
      .filter((event) => event.channelId === channelId && event.receivedAt >= boundAt && !admitted.has(event.id))
      .sort((left, right) => left.receivedAt - right.receivedAt || left.id.localeCompare(right.id))
  }
  claimAdmission(id: AdmissionId): void {
    const record = this.requiredAdmission(id)
    this.admissions.set(id, { ...record, state: 'claimed' })
  }
  completeAdmission(id: AdmissionId, dshMessageId: string, eventId: ChannelEventId): void {
    const record = this.requiredAdmission(id)
    this.admissions.set(id, { ...record, state: 'logged-to-session', dshMessageId })
    const episode = this.requiredEpisode(record.episodeId)
    this.episodes.set(episode.id, { ...episode, lastAdmittedEventId: eventId })
  }
  findOutboundByClientRequest(agentId: AgentId, channelId: ChannelId, clientRequestId: string) {
    return [...this.outbounds.values()].find(({ intent }) => {
      const episode = this.episodes.get(intent.episodeId)
      return (
        episode?.agentId === agentId && episode.channelId === channelId && intent.clientRequestId === clientRequestId
      )
    })
  }
  createOutboundPlan(intent: OutboundIntentRecord, deliveries: readonly PhysicalDeliveryRecord[]): void {
    this.outbounds.set(intent.id, { intent, deliveries, receipts: [] })
  }
  markIntentSending(id: OutboundIntentId): void {
    this.updateIntent(id, 'sending')
  }
  markDeliverySending(id: PhysicalDeliveryId): void {
    this.updateDelivery(id, (delivery) => ({ ...delivery, state: 'sending' }))
  }
  recordDeliveryReceipt(id: PhysicalDeliveryId, receipt: DeliveryReceiptRecord['receipt'], completedAt: number): void {
    const outbound = this.outboundForDelivery(id)
    const state = receipt.status
    const record = { physicalDeliveryId: id, receipt, completedAt }
    this.outbounds.set(outbound.intent.id, {
      ...outbound,
      deliveries: outbound.deliveries.map((delivery) =>
        delivery.id === id ? { ...delivery, state, receipt, completedAt } : delivery,
      ),
      receipts: [...outbound.receipts, record],
    })
  }
  completeOutboundIntent(id: OutboundIntentId, state: OutboundState): void {
    this.updateIntent(id, state)
  }
  getOutbound(id: OutboundIntentId): OutboundSnapshot {
    const snapshot = this.outbounds.get(id)
    if (!snapshot) throw new Error(`unknown outbound ${id}`)
    return snapshot
  }
  listUnsettledOutboundIds() {
    return [...this.outbounds.values()]
      .filter(({ intent }) => intent.state === 'planned' || intent.state === 'sending')
      .map(({ intent }) => intent.id)
  }

  private requiredEpisode(id: EpisodeId): EpisodeRecord {
    const episode = this.episodes.get(id)
    if (!episode) throw new Error(`unknown episode ${id}`)
    return episode
  }
  private requiredAdmission(id: AdmissionId): AdmissionRecord {
    const admission = this.admissions.get(id)
    if (!admission) throw new Error(`unknown admission ${id}`)
    return admission
  }
  private updateIntent(id: OutboundIntentId, state: OutboundState): void {
    const snapshot = this.getOutbound(id)
    this.outbounds.set(id, { ...snapshot, intent: { ...snapshot.intent, state } })
  }
  private updateDelivery(
    id: PhysicalDeliveryId,
    update: (delivery: PhysicalDeliveryRecord) => PhysicalDeliveryRecord,
  ): void {
    const snapshot = this.outboundForDelivery(id)
    this.outbounds.set(snapshot.intent.id, {
      ...snapshot,
      deliveries: snapshot.deliveries.map((delivery) => (delivery.id === id ? update(delivery) : delivery)),
    })
  }
  private outboundForDelivery(id: PhysicalDeliveryId): OutboundSnapshot {
    const snapshot = [...this.outbounds.values()].find(({ deliveries }) =>
      deliveries.some((delivery) => delivery.id === id),
    )
    if (!snapshot) throw new Error(`unknown delivery ${id}`)
    return snapshot
  }
}

const setup = async (
  mixedContent = true,
  idleRolloverMs?: number | false,
  handoffSummary?: AgentSessionDriver['createHandoffSummary'],
) => {
  const coreRepository = new MemoryCoreRepository()
  const runtimeRepository = new MemoryRuntimeRepository(coreRepository)
  let coreId = 0
  let runtimeId = 0
  const core = new CoreService(coreRepository, { now: () => 100, nextUlid: () => `C${++coreId}` })
  const agent = core.createAgent({
    displayName: '小奈',
    persona: '',
    model: { provider: 'deepseek', model: 'v4' },
  })
  const connection = core.createConnection({ adapterKey: 'fake', config: {} })
  const channel = core.createChannel({ connectionId: connection.id, platformChannelId: 'main', kind: 'group' })
  core.createBinding({ channelId: channel.id, agentId: agent.definition.id, triggerPolicy: 'always' })

  const sessionCalls: string[] = []
  let sessionStatus: 'idle' | 'running' = 'idle'
  let activeAdmissions = 0
  let maxActiveAdmissions = 0
  const persistedAdmissionMessages = new Map<AdmissionId, string>()
  const handoffInputs: Parameters<AgentSessionDriver['createHandoffSummary']>[0][] = []
  const sessionDriver: AgentSessionDriver = {
    createSession: ({ episodeId }) => {
      sessionCalls.push(`create:${episodeId}`)
      return Promise.resolve(`dsh-${episodeId}`)
    },
    applyCompatibleRevision: ({ previousRevision, targetRevision }) => {
      sessionCalls.push(`revise:${previousRevision.id}:${targetRevision.id}`)
      return Promise.resolve()
    },
    sessionStatus: () => sessionStatus,
    findAdmissionMessage: (_sessionId, admissionId) => persistedAdmissionMessages.get(admissionId),
    createHandoffSummary: (input) => {
      handoffInputs.push(input)
      return handoffSummary
        ? handoffSummary(input)
        : Promise.resolve({
            summary: '既有对话交接摘要',
            provider: input.revision.model.provider,
            model: input.revision.model.model,
          })
    },
    cancelSession: () => Promise.resolve(),
    notifyConsoleOutbound: ({ logicalMessageId }) => {
      sessionCalls.push(`console-outbound:${logicalMessageId}`)
      return Promise.resolve()
    },
    admit: async ({ admissionId, events, mode }) => {
      activeAdmissions += 1
      maxActiveAdmissions = Math.max(maxActiveAdmissions, activeAdmissions)
      await Promise.resolve()
      sessionCalls.push(`admit:${mode}:${admissionId}:${events.map(({ id }) => id).join(',')}`)
      activeAdmissions -= 1
      return { dshMessageId: `dsh-message-${admissionId}` }
    },
  }
  const context: AdapterConnectionContext = {
    connectionId: connection.id,
    now: () => 100,
    acceptInbound: () => Promise.reject(new Error('test calls runtime directly')),
  }
  const adapter = new FakeAdapterConnection(context, { ...FAKE_ADAPTER_CAPABILITIES, mixedContent })
  await adapter.start()
  const runtime = new ChannelRuntime(core, coreRepository, runtimeRepository, sessionDriver, {
    now: () => 100,
    nextUlid: () => `R${++runtimeId}`,
    resolveAdapter: (id) => (id === connection.id ? adapter : undefined),
    ...(idleRolloverMs === undefined ? {} : { idleRolloverMs }),
  })
  return {
    runtime,
    runtimeRepository,
    coreRepository,
    sessionDriver,
    adapter,
    connection,
    channel,
    sessionCalls,
    handoffInputs,
    core,
    agent,
    setSessionStatus: (status: 'idle' | 'running') => {
      sessionStatus = status
    },
    maxActiveAdmissions: () => maxActiveAdmissions,
    markAdmissionPersisted: (admissionId: AdmissionId, dshMessageId: string) => {
      persistedAdmissionMessages.set(admissionId, dshMessageId)
    },
  }
}

const inbound = (
  connectionId: ConnectionId,
  channelId: ChannelId,
  eventId = 'event-1',
  receivedAt = 102,
): AdapterInboundEvent => ({
  connectionId,
  channelId,
  adapterKey: 'fake',
  platformEventId: eventId,
  kind: 'message-created',
  parts: [{ type: 'text', text: '你好' }],
  platformTimestamp: receivedAt - 1,
  receivedAt,
  dedupeKey: `event:${eventId}`,
})

describe('ChannelRuntime M1 lane', () => {
  it('creates a binding through the runtime after the channel becomes unbound', async () => {
    const context = await setup()
    await context.runtime.clearBinding(context.channel.id)
    expect(context.coreRepository.getBinding(context.channel.id)).toBeUndefined()

    await expect(
      context.runtime.replaceBinding({
        channelId: context.channel.id,
        agentId: context.agent.definition.id,
        triggerPolicy: 'always',
      }),
    ).resolves.toMatchObject({ channelId: context.channel.id, agentId: context.agent.definition.id })
  })

  it('creates one Episode and Admission for a replayed inbound event', async () => {
    const context = await setup()
    expect((await context.runtime.acceptInbound(inbound(context.connection.id, context.channel.id))).inserted).toBe(
      true,
    )
    expect((await context.runtime.acceptInbound(inbound(context.connection.id, context.channel.id))).inserted).toBe(
      false,
    )
    expect(context.runtimeRepository.episodes).toHaveLength(1)
    expect(context.runtimeRepository.admissions).toHaveLength(1)
    expect(context.sessionCalls.filter((call) => call.startsWith('create:'))).toHaveLength(1)
    expect([...context.runtimeRepository.admissions.values()][0]).toMatchObject({ state: 'logged-to-session' })
  })

  it('sends admin console outbound as the robot account and notifies the session without a model turn', async () => {
    const context = await setup()
    context.adapter.queueReceipt({ status: 'sent', platformMessageId: 'console-1' })
    const signal = new AbortController().signal
    const result = await context.runtime.sendAdminConsoleMessage({
      channelId: context.channel.id,
      parts: [{ type: 'text', text: '今晚维护' }],
      clientRequestId: 'console-request-1',
      signal,
    })
    expect(result).toMatchObject({ status: 'sent' })
    expect(context.adapter.deliveries).toHaveLength(1)
    expect(context.adapter.deliveries[0]?.parts).toEqual([{ type: 'text', text: '今晚维护' }])
    const outbound = [...context.runtimeRepository.outbounds.values()][0]
    expect(outbound?.intent.sourceTurnId).toBe('admin-console')
    expect(outbound?.intent.clientRequestId).toBe('console-request-1')
    expect(context.sessionCalls.some((call) => call.startsWith('create:'))).toBe(true)
    expect(context.sessionCalls.some((call) => call.startsWith('console-outbound:'))).toBe(true)
    expect(context.sessionCalls.some((call) => call.startsWith('admit:'))).toBe(false)
  })

  it('validates admin console targets before proactive delivery', async () => {
    const context = await setup()
    const message = { parts: [{ type: 'text' as const, text: '维护通知' }] }

    await expect(
      context.runtime.sendAdminConsoleMessage({
        channelId: ChannelIdSchema.parse('chn_missing'),
        ...message,
      }),
    ).rejects.toThrow('Unknown channel')

    const webChannel = context.core.createChannel({
      connectionId: context.connection.id,
      platformChannelId: 'web-console',
      kind: 'web',
    })
    await expect(context.runtime.sendAdminConsoleMessage({ channelId: webChannel.id, ...message })).rejects.toThrow(
      'Web channels accept inbound conversation',
    )

    const unboundChannel = context.core.createChannel({
      connectionId: context.connection.id,
      platformChannelId: 'unbound-console',
      kind: 'group',
    })
    await expect(context.runtime.sendAdminConsoleMessage({ channelId: unboundChannel.id, ...message })).rejects.toThrow(
      'Channel has no Binding',
    )

    const unavailableRuntime = new ChannelRuntime(
      context.core,
      context.coreRepository,
      context.runtimeRepository,
      context.sessionDriver,
      { resolveAdapter: () => undefined },
    )
    await expect(
      unavailableRuntime.sendAdminConsoleMessage({ channelId: context.channel.id, ...message }),
    ).rejects.toThrow('Connection adapter is not running')

    Object.assign(context.adapter.capabilities, { proactiveSend: false })
    await expect(
      context.runtime.sendAdminConsoleMessage({ channelId: context.channel.id, ...message }),
    ).rejects.toThrow('Adapter does not allow proactive send')
  })

  it('notifies the session for partially sent and unknown admin console delivery', async () => {
    const context = await setup(false)
    context.adapter.queueReceipt({ status: 'sent', platformMessageId: 'console-partial-1' })
    context.adapter.queueReceipt({
      status: 'failed',
      failure: { kind: 'permanent', message: 'attachment rejected' },
    })
    await expect(
      context.runtime.sendAdminConsoleMessage({
        channelId: context.channel.id,
        parts: [
          { type: 'text', text: '维护说明' },
          { type: 'file', assetId: AssetIdSchema.parse('ast_console'), name: 'notice.txt' },
        ],
      }),
    ).resolves.toMatchObject({ status: 'partially-sent' })

    context.adapter.queueReceipt({ status: 'unknown', message: 'response lost after submit' })
    await expect(
      context.runtime.sendAdminConsoleMessage({
        channelId: context.channel.id,
        parts: [{ type: 'text', text: '补充说明' }],
      }),
    ).resolves.toMatchObject({ status: 'unknown' })
    expect(context.sessionCalls.filter((call) => call.startsWith('console-outbound:'))).toHaveLength(2)
  })

  it('splits non-mixed delivery, preserves partial success and deduplicates clientRequestId', async () => {
    const context = await setup(false)
    await context.runtime.acceptInbound(inbound(context.connection.id, context.channel.id))
    const episode = [...context.runtimeRepository.episodes.values()][0]!
    context.adapter.queueReceipt({ status: 'sent', platformMessageId: 'platform-1' })
    context.adapter.queueReceipt({
      status: 'failed',
      failure: { kind: 'permanent', message: 'media rejected' },
    })
    context.adapter.queueReceipt({ status: 'sent', platformMessageId: 'platform-3' })
    const input = {
      episodeId: episode.id,
      parts: [
        { type: 'text' as const, text: '结果' },
        { type: 'file' as const, assetId: AssetIdSchema.parse('ast_ASSET1'), name: 'result.txt' },
        { type: 'text' as const, text: '补充说明' },
      ],
      clientRequestId: 'request-1',
    }
    const first = await context.runtime.sendMessage(input)
    const replay = await context.runtime.sendMessage(input)
    expect(first.status).toBe('partially-sent')
    expect(replay).toEqual(first)
    expect(context.adapter.deliveries).toHaveLength(3)
  })

  it('batches triggered Channel Events that were persisted before a runtime failure', async () => {
    const context = await setup()
    await context.runtime.acceptInbound(inbound(context.connection.id, context.channel.id, 'event-1', 101))
    context.core.appendInbound(inbound(context.connection.id, context.channel.id, 'event-2', 102))
    await context.runtime.acceptInbound(inbound(context.connection.id, context.channel.id, 'event-3', 103))
    const admissions = [...context.runtimeRepository.admissions.values()]
    expect(admissions).toHaveLength(2)
    expect(admissions[1]?.eventIds).toHaveLength(2)
  })

  it('applies display-only revisions in place and rolls incompatible revisions into a handoff Session', async () => {
    const context = await setup()
    await context.runtime.acceptInbound(inbound(context.connection.id, context.channel.id))
    const episode = [...context.runtimeRepository.episodes.values()][0]!
    const displayRevision = context.core.reviseAgent(context.agent.definition.id, context.agent.revision.id, {
      displayName: '小奈·新名称',
      persona: '',
      model: { provider: 'deepseek', model: 'v4' },
    })
    await context.runtime.acceptInbound(inbound(context.connection.id, context.channel.id, 'event-2'))
    expect(context.runtimeRepository.getEpisode(episode.id)).toMatchObject({
      id: episode.id,
      dshSessionId: episode.dshSessionId,
      agentRevisionId: displayRevision.revision.id,
    })
    expect(context.sessionCalls.some((call) => call.startsWith(`revise:${episode.agentRevisionId}:`))).toBe(true)

    const incompatibleRevision = context.core.reviseAgent(context.agent.definition.id, displayRevision.revision.id, {
      displayName: '小奈·新名称',
      persona: '这一修改会改变模型输入。',
      model: { provider: 'deepseek', model: 'v4' },
    })
    await context.runtime.acceptInbound(inbound(context.connection.id, context.channel.id, 'event-3', 103))
    expect(context.runtimeRepository.getEpisode(episode.id)).toMatchObject({
      status: 'closed',
      closeReason: 'incompatible-revision',
      agentRevisionId: displayRevision.revision.id,
    })
    const active = [...context.runtimeRepository.episodes.values()].find(({ status }) => status === 'active')
    expect(active).toMatchObject({ agentRevisionId: incompatibleRevision.revision.id })
    expect(active?.id).not.toBe(episode.id)
    expect(active?.dshSessionId).not.toBe(episode.dshSessionId)
    expect(context.runtimeRepository.handoffs).toHaveLength(1)
    expect(context.runtimeRepository.handoffs[0]?.sourceEventIds).toHaveLength(2)
    expect(context.runtimeRepository.handoffs[0]?.recentEventIds).toHaveLength(2)
    expect(context.runtimeRepository.admissions).toHaveLength(3)

    context.core.reviseAgent(context.agent.definition.id, incompatibleRevision.revision.id, {
      displayName: '小奈·新名称',
      persona: '这是第二次不兼容修改。',
      model: { provider: 'deepseek', model: 'v4' },
    })
    await context.runtime.acceptInbound(inbound(context.connection.id, context.channel.id, 'event-4', 104))
    expect(context.handoffInputs).toHaveLength(2)
    expect(context.handoffInputs[1]?.previousHandoff?.id).toBe(context.runtimeRepository.handoffs[0]?.id)
  })

  it('continues rollover with a deterministic fallback when handoff generation throws', async () => {
    const context = await setup(true, undefined, () => Promise.reject(new Error('summary unavailable')))
    await context.runtime.acceptInbound(inbound(context.connection.id, context.channel.id))
    const first = [...context.runtimeRepository.episodes.values()][0]!
    context.core.reviseAgent(context.agent.definition.id, context.agent.revision.id, {
      displayName: '小奈',
      persona: '触发不兼容切换。',
      model: { provider: 'deepseek', model: 'v4' },
    })

    await expect(
      context.runtime.acceptInbound(inbound(context.connection.id, context.channel.id, 'event-2', 103)),
    ).resolves.toMatchObject({ inserted: true })
    expect(context.runtimeRepository.getEpisode(first.id)).toMatchObject({ status: 'closed' })
    expect([...context.runtimeRepository.episodes.values()].filter(({ status }) => status === 'active')).toHaveLength(1)
    expect(context.runtimeRepository.handoffs[0]?.summary).toContain('模型交接摘要不可用')
    expect(context.runtimeRepository.handoffs[0]?.sourceEventIds).toHaveLength(1)
  })

  it('serializes one lane and injects ordinary messages that arrive while DSH is running', async () => {
    const context = await setup()
    await context.runtime.acceptInbound(inbound(context.connection.id, context.channel.id))
    context.setSessionStatus('running')
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        context.runtime.acceptInbound(inbound(context.connection.id, context.channel.id, `running-${index}`)),
      ),
    )

    expect(context.maxActiveAdmissions()).toBe(1)
    expect([...context.runtimeRepository.admissions.values()].slice(1)).toHaveLength(20)
    expect([...context.runtimeRepository.admissions.values()].slice(1).every(({ mode }) => mode === 'inject')).toBe(
      true,
    )
    expect(context.sessionCalls.filter((call) => call.startsWith('admit:inject:'))).toHaveLength(20)
  })

  it('recovers a DSH-committed Admission and marks an in-flight delivery unknown without resending', async () => {
    const context = await setup()
    await context.runtime.acceptInbound(inbound(context.connection.id, context.channel.id))
    const episode = [...context.runtimeRepository.episodes.values()][0]!
    const admission = [...context.runtimeRepository.admissions.values()][0]!
    context.runtimeRepository.admissions.set(admission.id, {
      id: admission.id,
      episodeId: admission.episodeId,
      eventIds: admission.eventIds,
      mode: admission.mode,
      state: 'claimed',
      createdAt: admission.createdAt,
    })
    context.markAdmissionPersisted(admission.id, 'dsh-existing-message')

    context.adapter.queueReceipt({ status: 'sent', platformMessageId: 'already-submitted' })
    await context.runtime.sendMessage({
      episodeId: episode.id,
      parts: [{ type: 'text', text: '可能已经送达' }],
      clientRequestId: 'recovery-outbound',
    })
    const outbound = [...context.runtimeRepository.outbounds.values()][0]!
    context.runtimeRepository.outbounds.set(outbound.intent.id, {
      intent: { ...outbound.intent, state: 'sending' },
      deliveries: outbound.deliveries.map((delivery) => ({ ...delivery, state: 'sending' as const })),
      receipts: [],
    })
    const deliveriesBeforeRecovery = context.adapter.deliveries.length

    expect(await context.runtime.recover()).toEqual({
      resumedEpisodes: 1,
      recoveredAdmissions: 1,
      recoveredOutbounds: 1,
      unknownDeliveries: 1,
    })
    expect(context.runtimeRepository.admissions.get(admission.id)).toMatchObject({
      state: 'logged-to-session',
      dshMessageId: 'dsh-existing-message',
    })
    expect(context.runtimeRepository.getOutbound(outbound.intent.id).intent.state).toBe('unknown')
    expect(context.adapter.deliveries).toHaveLength(deliveriesBeforeRecovery)
  })

  it('stops a live Episode only after the owned DSH Session reaches its cancellation boundary', async () => {
    const context = await setup()
    await context.runtime.acceptInbound(inbound(context.connection.id, context.channel.id))
    const episode = [...context.runtimeRepository.episodes.values()][0]!
    expect(await context.runtime.stopEpisode(episode.id, 'permission-revoked')).toMatchObject({
      status: 'closed',
      closeReason: 'permission-revoked',
      closedAtEventId: episode.lastAdmittedEventId,
    })
    await expect(
      context.runtime.sendMessage({ episodeId: episode.id, parts: [{ type: 'text', text: '不能再发送' }] }),
    ).rejects.toThrow('inactive Episode')
    await context.runtime.acceptInbound(inbound(context.connection.id, context.channel.id, 'fresh-event', 103))
    const fresh = [...context.runtimeRepository.episodes.values()].find(({ status }) => status === 'active')
    expect(fresh?.id).not.toBe(episode.id)
    expect(context.runtimeRepository.handoffs).toHaveLength(0)
  })

  it('rolls over after the configured idle gap but never because Session context merely grew', async () => {
    const context = await setup(true, 1000)
    await context.runtime.acceptInbound(inbound(context.connection.id, context.channel.id, 'idle-1', 100))
    const first = [...context.runtimeRepository.episodes.values()][0]!
    await context.runtime.acceptInbound(inbound(context.connection.id, context.channel.id, 'idle-2', 1099))
    expect(context.runtimeRepository.getEpisode(first.id)?.status).toBe('active')
    await context.runtime.acceptInbound(inbound(context.connection.id, context.channel.id, 'idle-3', 2100))
    expect(context.runtimeRepository.getEpisode(first.id)).toMatchObject({
      status: 'closed',
      closeReason: 'idle-timeout',
    })
    expect([...context.runtimeRepository.episodes.values()].filter(({ status }) => status === 'active')).toHaveLength(1)
  })

  it('supports an explicit new Session without fabricating a new Channel Event', async () => {
    const context = await setup()
    await context.runtime.acceptInbound(inbound(context.connection.id, context.channel.id))
    const first = [...context.runtimeRepository.episodes.values()][0]!
    const eventCount = context.runtimeRepository.admissions.size
    const next = await context.runtime.rolloverEpisode(first.id)
    expect(context.runtimeRepository.getEpisode(first.id)).toMatchObject({ status: 'closed', closeReason: 'manual' })
    expect(next).toMatchObject({ status: 'active', openedAtEventId: first.lastAdmittedEventId })
    expect(next.dshSessionId).not.toBe(first.dshSessionId)
    expect(context.runtimeRepository.admissions).toHaveLength(eventCount)
  })

  it('rolls every active lane for an incompatible Extension Activation at a safe boundary', async () => {
    const context = await setup()
    await context.runtime.acceptInbound(inbound(context.connection.id, context.channel.id))
    const first = [...context.runtimeRepository.episodes.values()][0]!
    const [next] = await context.runtime.rolloverAgentActivations(context.agent.definition.id)
    expect(context.runtimeRepository.getEpisode(first.id)).toMatchObject({
      status: 'closed',
      closeReason: 'incompatible-activation',
    })
    expect(next).toMatchObject({ status: 'active', agentId: context.agent.definition.id })
    expect(next?.dshSessionId).not.toBe(first.dshSessionId)
  })

  it('covers every trigger policy and admits a non-triggering event while the Session is running', async () => {
    const event = (facts?: ChannelEventRecord['facts']): ChannelEventRecord => ({
      id: ChannelEventIdSchema.parse('evt_trigger'),
      logicalMessageId: LogicalMessageIdSchema.parse('msg_trigger'),
      channelId: ChannelIdSchema.parse('chn_trigger'),
      kind: 'message-created',
      parts: [{ type: 'text', text: 'trigger' }],
      sourceTimestamp: 1,
      receivedAt: 1,
      dedupeKey: 'trigger',
      searchText: 'trigger',
      ...(facts === undefined ? {} : { facts }),
    })
    const binding = (triggerPolicy: BindingRecord['triggerPolicy']): BindingRecord => ({
      channelId: ChannelIdSchema.parse('chn_trigger'),
      agentId: AgentIdSchema.parse('agt_trigger'),
      triggerPolicy,
      boundAt: 1,
    })

    expect(isTriggered(binding('always'), event())).toBe(true)
    expect(isTriggered(binding('observe-only'), event())).toBe(false)
    expect(isTriggered(binding('mentioned-or-replied'), event())).toBe(false)
    expect(isTriggered(binding('mentioned-or-replied'), event({ mentionedBot: true }))).toBe(true)
    expect(isTriggered(binding('mentioned-or-replied'), event({ replyToBot: true }))).toBe(true)
    expect(isTriggered(binding('command'), event({ command: '' }))).toBe(false)
    expect(isTriggered(binding('command'), event({ command: 123 }))).toBe(false)
    expect(isTriggered(binding('command'), event({ command: '/help' }))).toBe(true)
    expect(isTriggered(binding('always'), event({ consoleAnchor: true }))).toBe(false)

    const context = await setup()
    await context.runtime.acceptInbound(inbound(context.connection.id, context.channel.id, 'initial'))
    context.core.replaceBinding({
      channelId: context.channel.id,
      agentId: context.agent.definition.id,
      triggerPolicy: 'observe-only',
    })
    context.setSessionStatus('running')
    await context.runtime.acceptInbound(inbound(context.connection.id, context.channel.id, 'running-observe-only'))
    expect([...context.runtimeRepository.admissions.values()]).toHaveLength(2)
    expect([...context.runtimeRepository.admissions.values()][1]).toMatchObject({ mode: 'inject' })
  })

  it('publishes inbound and outbound facts while isolating and removing listeners', async () => {
    const context = await setup()
    const observed: string[] = []
    const throwingUnsubscribe = context.runtime.subscribeFacts((fact) => {
      observed.push(`${fact.kind}:${fact.sourceId}`)
      throw new Error('projection failed')
    })
    const unsubscribe = context.runtime.subscribeFacts((fact) => {
      observed.push(`${fact.kind}:${fact.sourceId}`)
    })

    await context.runtime.acceptInbound(inbound(context.connection.id, context.channel.id, 'facts-inbound'))
    const episode = [...context.runtimeRepository.episodes.values()][0]!
    await context.runtime.sendMessage({ episodeId: episode.id, parts: [{ type: 'text', text: 'facts-outbound' }] })
    expect(observed.filter((fact) => fact.startsWith('inbound:'))).toHaveLength(2)
    expect(observed.filter((fact) => fact.startsWith('outbound:'))).toHaveLength(4)

    unsubscribe()
    throwingUnsubscribe()
    const before = observed.length
    await context.runtime.sendMessage({ episodeId: episode.id, parts: [{ type: 'text', text: 'after-unsubscribe' }] })
    expect(observed).toHaveLength(before)
  })

  it('rejects an invalid rollover option and allows rollover with idle detection disabled', async () => {
    await expect(setup(true, 0)).rejects.toThrow('idleRolloverMs must be a positive integer or false')
    const context = await setup(true, false)
    await context.runtime.acceptInbound(inbound(context.connection.id, context.channel.id, 'no-idle-1', 100))
    const first = [...context.runtimeRepository.episodes.values()][0]!
    await context.runtime.acceptInbound(inbound(context.connection.id, context.channel.id, 'no-idle-2', 100_000))
    expect(context.runtimeRepository.getEpisode(first.id)?.status).toBe('active')
  })

  it('recovers pending and claimed Admissions by checking the Session before re-admitting', async () => {
    const pendingContext = await setup()
    await pendingContext.runtime.acceptInbound(
      inbound(pendingContext.connection.id, pendingContext.channel.id, 'pending'),
    )
    const pendingEpisode = [...pendingContext.runtimeRepository.episodes.values()][0]!
    const pendingAdmission = [...pendingContext.runtimeRepository.admissions.values()][0]!
    pendingContext.runtimeRepository.admissions.set(pendingAdmission.id, {
      id: pendingAdmission.id,
      episodeId: pendingAdmission.episodeId,
      eventIds: pendingAdmission.eventIds,
      mode: pendingAdmission.mode,
      state: 'pending',
      createdAt: pendingAdmission.createdAt,
    })

    await expect(pendingContext.runtime.recover()).resolves.toMatchObject({
      resumedEpisodes: 1,
      recoveredAdmissions: 1,
    })
    expect(pendingContext.runtimeRepository.getEpisode(pendingEpisode.id)).toMatchObject({
      status: 'active',
      lastAdmittedEventId: pendingAdmission.eventIds.at(-1),
    })
    expect(pendingContext.runtimeRepository.admissions.get(pendingAdmission.id)).toMatchObject({
      state: 'logged-to-session',
      dshMessageId: `dsh-message-${pendingAdmission.id}`,
    })

    const claimedContext = await setup()
    await claimedContext.runtime.acceptInbound(
      inbound(claimedContext.connection.id, claimedContext.channel.id, 'claimed'),
    )
    const claimedAdmission = [...claimedContext.runtimeRepository.admissions.values()][0]!
    claimedContext.runtimeRepository.admissions.set(claimedAdmission.id, { ...claimedAdmission, state: 'claimed' })
    await expect(claimedContext.runtime.recover()).resolves.toMatchObject({ recoveredAdmissions: 1 })
    expect(claimedContext.runtimeRepository.admissions.get(claimedAdmission.id)).toMatchObject({
      state: 'logged-to-session',
    })
  })

  it('fails an opening Episode cleanly when Session creation fails, then permits a fresh retry', async () => {
    const context = await setup()
    context.sessionDriver.createSession = () => Promise.reject(new Error('Session unavailable'))

    await expect(
      context.runtime.acceptInbound(inbound(context.connection.id, context.channel.id, 'session-failure')),
    ).rejects.toThrow('Session unavailable')
    const failed = [...context.runtimeRepository.episodes.values()][0]!
    expect(failed).toMatchObject({ status: 'failed' })
    expect(context.runtimeRepository.admissions).toHaveLength(0)

    context.sessionDriver.createSession = ({ episodeId }) => Promise.resolve(`dsh-${episodeId}`)
    await expect(
      context.runtime.acceptInbound(inbound(context.connection.id, context.channel.id, 'session-retry')),
    ).resolves.toMatchObject({
      inserted: true,
    })
    expect([...context.runtimeRepository.episodes.values()].filter(({ status }) => status === 'active')).toHaveLength(1)
  })

  it('leaves a claimed Admission recoverable after admission failure', async () => {
    const context = await setup()
    context.sessionDriver.admit = () => Promise.reject(new Error('DSH admission failed'))

    await expect(
      context.runtime.acceptInbound(inbound(context.connection.id, context.channel.id, 'admit-failure')),
    ).rejects.toThrow('DSH admission failed')
    const admission = [...context.runtimeRepository.admissions.values()][0]!
    expect(admission).toMatchObject({ state: 'claimed' })

    context.sessionDriver.admit = ({ admissionId }) => Promise.resolve({ dshMessageId: `dsh-message-${admissionId}` })
    await expect(context.runtime.recover()).resolves.toMatchObject({ recoveredAdmissions: 1 })
    expect(context.runtimeRepository.admissions.get(admission.id)).toMatchObject({ state: 'logged-to-session' })
  })

  it('closes the old Episode on binding replacement and creates a clean Episode for the new binding', async () => {
    const context = await setup()
    await context.runtime.acceptInbound(inbound(context.connection.id, context.channel.id, 'before-replace'))
    const oldEpisode = [...context.runtimeRepository.episodes.values()][0]!
    const replacement = context.core.createAgent({
      displayName: '小新',
      persona: '',
      model: { provider: 'deepseek', model: 'v4' },
    })

    await expect(
      context.runtime.replaceBinding({
        channelId: context.channel.id,
        agentId: replacement.definition.id,
        triggerPolicy: 'always',
      }),
    ).resolves.toMatchObject({ agentId: replacement.definition.id })
    expect(context.runtimeRepository.getEpisode(oldEpisode.id)).toMatchObject({
      status: 'closed',
      closeReason: 'binding-replaced',
    })

    await context.runtime.acceptInbound(inbound(context.connection.id, context.channel.id, 'after-replace'))
    const active = [...context.runtimeRepository.episodes.values()].find(({ status }) => status === 'active')
    expect(active).toMatchObject({ agentId: replacement.definition.id })
    expect(context.runtimeRepository.handoffs).toHaveLength(0)
  })

  it('stops an active Episode before clearing a Binding', async () => {
    const context = await setup()
    await context.runtime.acceptInbound(inbound(context.connection.id, context.channel.id, 'before-clear'))
    const oldEpisode = [...context.runtimeRepository.episodes.values()][0]!
    await expect(context.runtime.clearBinding(context.channel.id)).resolves.toBeUndefined()
    expect(context.runtimeRepository.getEpisode(oldEpisode.id)).toMatchObject({
      status: 'closed',
      closeReason: 'stopped',
    })
    expect(context.coreRepository.getBinding(context.channel.id)).toBeUndefined()
  })

  it('cancels without handoff before tombstoning a channel', async () => {
    const context = await setup()
    await context.runtime.acceptInbound(inbound(context.connection.id, context.channel.id, 'before-channel-delete'))
    const episode = [...context.runtimeRepository.episodes.values()][0]!
    const event = context.coreRepository.listChannelEvents(context.channel.id, { limit: 1 })[0]!
    const cancellations: string[] = []
    context.sessionDriver.cancelSession = (sessionId, reason) => {
      cancellations.push(`${sessionId}:${reason}`)
      return Promise.resolve()
    }

    await expect(context.runtime.deleteChannel(context.channel.id)).resolves.toBeUndefined()

    expect(cancellations).toEqual([`dsh-${episode.id}:channel-deleted`])
    expect(context.runtimeRepository.getEpisode(episode.id)).toMatchObject({
      status: 'closed',
      closeReason: 'channel-deleted',
    })
    expect(context.coreRepository.getChannel(context.channel.id)).toBeUndefined()
    expect(context.coreRepository.getBinding(context.channel.id)).toBeUndefined()
    expect(context.coreRepository.getChannelEvent(event.id)).toEqual(event)
    expect(context.runtimeRepository.handoffs).toHaveLength(0)
  })

  it('clears an active context immediately without a handoff and starts clean on the next message', async () => {
    const context = await setup()
    await context.runtime.acceptInbound(inbound(context.connection.id, context.channel.id, 'before-context-clear'))
    const episode = [...context.runtimeRepository.episodes.values()][0]!
    const cancellations: string[] = []
    context.sessionDriver.cancelSession = (sessionId, reason) => {
      cancellations.push(`${sessionId}:${reason}`)
      return Promise.resolve()
    }

    await expect(context.runtime.resetEpisode(episode.id, 'clear')).resolves.toMatchObject({ mode: 'clear' })
    expect(cancellations).toEqual([`dsh-${episode.id}:context-cleared`])
    expect(context.runtimeRepository.getEpisode(episode.id)).toMatchObject({
      status: 'closed',
      closeReason: 'context-cleared',
    })
    expect(context.runtimeRepository.handoffs).toHaveLength(0)
    expect([...context.runtimeRepository.episodes.values()]).toHaveLength(1)

    await context.runtime.acceptInbound(inbound(context.connection.id, context.channel.id, 'after-context-clear'))
    const active = [...context.runtimeRepository.episodes.values()].find(({ status }) => status === 'active')
    expect(active?.id).not.toBe(episode.id)
    expect(context.runtimeRepository.handoffs).toHaveLength(0)
    if (!active) throw new Error('Expected a post-clear active Episode.')
    await context.runtime.resetEpisode(active.id, 'compact')
    const postClearEvent = [...context.coreRepository.events.values()].find(
      ({ dedupeKey }) => dedupeKey === 'event:after-context-clear',
    )
    expect(context.runtimeRepository.handoffs[0]?.recentEventIds).toEqual([postClearEvent?.id])
  })

  it('compacts an active context after cancellation and falls back deterministically when summary generation fails', async () => {
    const context = await setup(true, undefined, () => Promise.reject(new Error('summary unavailable')))
    await context.runtime.acceptInbound(inbound(context.connection.id, context.channel.id, 'before-context-compact'))
    const episode = [...context.runtimeRepository.episodes.values()][0]!
    const cancellations: string[] = []
    context.sessionDriver.cancelSession = (sessionId, reason) => {
      cancellations.push(`${sessionId}:${reason}`)
      return Promise.resolve()
    }

    const result = await context.runtime.resetEpisode(episode.id, 'compact')
    expect(cancellations).toEqual([`dsh-${episode.id}:context-compacted`])
    expect(result).toMatchObject({
      mode: 'compact',
      closedEpisode: { id: episode.id, status: 'closed', closeReason: 'context-compacted' },
      nextEpisode: { status: 'active' },
    })
    expect(context.runtimeRepository.handoffs).toHaveLength(1)
    expect(context.runtimeRepository.handoffs[0]?.summary).toContain('模型交接摘要不可用')
    expect(context.handoffInputs).toHaveLength(1)
  })

  it('validates outbound targets and sends every structured part with reply metadata', async () => {
    const context = await setup()
    await context.runtime.acceptInbound(inbound(context.connection.id, context.channel.id, 'outbound-validation'))
    const episode = [...context.runtimeRepository.episodes.values()][0]!

    await expect(
      context.runtime.sendMessage({
        episodeId: EpisodeIdSchema.parse('eps_missing'),
        parts: [{ type: 'text', text: 'x' }],
      }),
    ).rejects.toThrow('Unknown or inactive Episode')
    await expect(context.runtime.sendMessage({ episodeId: episode.id, parts: [] })).rejects.toThrow(
      'at least one content part',
    )

    const parts = [
      { type: 'text' as const, text: 'text' },
      { type: 'mention' as const, memberId: ChannelMemberIdSchema.parse('mbr_member') },
      { type: 'image' as const, assetId: AssetIdSchema.parse('ast_image') },
      { type: 'file' as const, assetId: AssetIdSchema.parse('ast_file'), name: 'file.txt' },
      { type: 'audio' as const, assetId: AssetIdSchema.parse('ast_audio') },
      { type: 'quote' as const, messageId: LogicalMessageIdSchema.parse('msg_previous') },
    ]
    const result = await context.runtime.sendMessage({
      episodeId: episode.id,
      parts,
      replyTo: 'platform-parent',
      sourceTurnId: 'turn-1',
    })
    expect(result.status).toBe('sent')
    expect(context.adapter.deliveries.at(-1)).toMatchObject({
      parts,
      replyTo: 'platform-parent',
    })

    const aborted = new AbortController()
    aborted.abort()
    await expect(
      context.runtime.sendMessage({
        episodeId: episode.id,
        parts: [{ type: 'text', text: 'cancelled' }],
        signal: aborted.signal,
      }),
    ).resolves.toMatchObject({ status: 'failed' })
  })

  it('rejects unsupported parts and missing runtime resources before sending', async () => {
    const limited = await setup()
    await limited.runtime.acceptInbound(inbound(limited.connection.id, limited.channel.id, 'unsupported'))
    const episode = [...limited.runtimeRepository.episodes.values()][0]!
    Object.assign(limited.adapter.capabilities, { images: false })
    await expect(
      limited.runtime.sendMessage({
        episodeId: episode.id,
        parts: [{ type: 'image', assetId: AssetIdSchema.parse('ast_noimage') }],
      }),
    ).rejects.toThrow('does not support message part: image')
    await expect(
      limited.runtime.sendMessage({
        episodeId: episode.id,
        parts: [{ type: 'rich', adapterKey: 'sample', kind: 'card', summary: '卡片摘要' }],
      }),
    ).rejects.toThrow('does not support message part: rich')

    const noAdapter = new ChannelRuntime(
      limited.core,
      limited.coreRepository,
      limited.runtimeRepository,
      limited.sessionDriver,
      {
        resolveAdapter: () => undefined,
      },
    )
    await expect(
      noAdapter.sendMessage({ episodeId: episode.id, parts: [{ type: 'text', text: 'no adapter' }] }),
    ).rejects.toThrow('Connection adapter is not running')

    limited.coreRepository.channels.delete(limited.channel.id)
    await expect(
      limited.runtime.sendMessage({ episodeId: episode.id, parts: [{ type: 'text', text: 'no channel' }] }),
    ).rejects.toThrow('Episode channel no longer exists')
  })

  it('checks planner output, adapter context, and over-limit planner results', async () => {
    const context = await setup()
    await context.runtime.acceptInbound(inbound(context.connection.id, context.channel.id, 'planner'))
    const episode = [...context.runtimeRepository.episodes.values()][0]!
    const setPlan = (plans: readonly { readonly parts: readonly object[]; readonly adapterContext?: object }[]) => {
      Object.defineProperty(context.adapter, 'planOutbound', {
        configurable: true,
        writable: true,
        value: () => Promise.resolve(plans),
      })
    }

    setPlan([])
    await expect(
      context.runtime.sendMessage({ episodeId: episode.id, parts: [{ type: 'text', text: 'empty plans' }] }),
    ).rejects.toThrow('empty PhysicalDelivery')

    setPlan([{ parts: [] }])
    await expect(
      context.runtime.sendMessage({ episodeId: episode.id, parts: [{ type: 'text', text: 'empty delivery' }] }),
    ).rejects.toThrow('empty PhysicalDelivery')

    setPlan([{ parts: [{ type: 'text', text: 'planned' }], adapterContext: { route: 'special' } }])
    const planned = await context.runtime.sendMessage({
      episodeId: episode.id,
      parts: [{ type: 'text', text: 'original' }],
      replyTo: 'parent',
    })
    expect(planned.status).toBe('sent')
    expect(context.adapter.deliveries.at(-1)).toMatchObject({ adapterContext: { route: 'special' }, replyTo: 'parent' })

    Object.assign(context.adapter.capabilities, { images: false })
    setPlan([{ parts: [{ type: 'image', assetId: AssetIdSchema.parse('ast_planned') }] }])
    await expect(
      context.runtime.sendMessage({ episodeId: episode.id, parts: [{ type: 'text', text: 'unsupported plan' }] }),
    ).rejects.toThrow('planner produced an unsupported part')

    Object.assign(context.adapter.capabilities, { images: true, maxTextLength: 2 })
    setPlan([{ parts: [{ type: 'text', text: 'too long' }] }])
    await expect(
      context.runtime.sendMessage({ episodeId: episode.id, parts: [{ type: 'text', text: 'short' }] }),
    ).rejects.toThrow('over-limit text')
  })

  it('records a failed delivery and turns a thrown adapter error into unknown', async () => {
    const failedContext = await setup()
    await failedContext.runtime.acceptInbound(
      inbound(failedContext.connection.id, failedContext.channel.id, 'failed-delivery'),
    )
    const failedEpisode = [...failedContext.runtimeRepository.episodes.values()][0]!
    failedContext.adapter.queueReceipt({ status: 'failed', failure: { kind: 'permanent', message: 'rejected' } })
    await expect(
      failedContext.runtime.sendMessage({ episodeId: failedEpisode.id, parts: [{ type: 'text', text: 'failed' }] }),
    ).resolves.toMatchObject({ status: 'failed' })

    const thrownContext = await setup()
    await thrownContext.runtime.acceptInbound(
      inbound(thrownContext.connection.id, thrownContext.channel.id, 'thrown-delivery'),
    )
    const thrownEpisode = [...thrownContext.runtimeRepository.episodes.values()][0]!
    thrownContext.adapter.deliver = () => Promise.reject(new Error('transport broke'))
    await expect(
      thrownContext.runtime.sendMessage({ episodeId: thrownEpisode.id, parts: [{ type: 'text', text: 'unknown' }] }),
    ).resolves.toMatchObject({ status: 'unknown' })
    const outbound = [...thrownContext.runtimeRepository.outbounds.values()][0]!
    const receipt = outbound.receipts[0]?.receipt
    expect(receipt?.status).toBe('unknown')
    if (receipt?.status === 'unknown') expect(receipt.message).toContain('transport broke')
  })

  it('recovers an Episode left opening when rollover Session creation crashes after commit', async () => {
    const context = await setup()
    await context.runtime.acceptInbound(inbound(context.connection.id, context.channel.id, 'rollover-before-crash'))
    const first = [...context.runtimeRepository.episodes.values()][0]!
    let failHandoffCreation = true
    context.sessionDriver.createSession = (input) => {
      if (input.handoff !== undefined && failHandoffCreation) {
        failHandoffCreation = false
        return Promise.reject(new Error('new Session crashed'))
      }
      return Promise.resolve(`dsh-${input.episodeId}`)
    }
    context.core.reviseAgent(context.agent.definition.id, context.agent.revision.id, {
      displayName: '小奈',
      persona: '需要新 Session。',
      model: { provider: 'deepseek', model: 'v4' },
    })

    await expect(
      context.runtime.acceptInbound(inbound(context.connection.id, context.channel.id, 'rollover-crash', 103)),
    ).rejects.toThrow('new Session crashed')
    const opening = [...context.runtimeRepository.episodes.values()].find(({ status }) => status === 'opening')
    expect(context.runtimeRepository.getEpisode(first.id)).toMatchObject({
      status: 'closed',
      closeReason: 'incompatible-revision',
    })
    expect(opening).toBeDefined()
    expect(context.runtimeRepository.handoffs).toHaveLength(1)

    await expect(context.runtime.recover()).resolves.toMatchObject({ resumedEpisodes: 1 })
    expect(context.runtimeRepository.getEpisode(opening!.id)).toMatchObject({ status: 'active' })
    expect([...context.runtimeRepository.admissions.values()]).toHaveLength(2)
  })

  it('reports missing rollover anchors instead of fabricating a new Episode', async () => {
    const missingAgent = await setup()
    await missingAgent.runtime.acceptInbound(
      inbound(missingAgent.connection.id, missingAgent.channel.id, 'missing-agent'),
    )
    const missingAgentEpisode = [...missingAgent.runtimeRepository.episodes.values()][0]!
    missingAgent.coreRepository.agents.delete(missingAgent.agent.definition.id)
    await expect(missingAgent.runtime.rolloverEpisode(missingAgentEpisode.id)).rejects.toThrow('agent no longer exists')

    const missingRevision = await setup()
    await missingRevision.runtime.acceptInbound(
      inbound(missingRevision.connection.id, missingRevision.channel.id, 'missing-revision'),
    )
    const missingRevisionEpisode = [...missingRevision.runtimeRepository.episodes.values()][0]!
    missingRevision.coreRepository.revisions.delete(missingRevisionEpisode.agentRevisionId)
    await expect(missingRevision.runtime.rolloverEpisode(missingRevisionEpisode.id)).rejects.toThrow(
      'Revision no longer exists',
    )

    const missingBinding = await setup()
    await missingBinding.runtime.acceptInbound(
      inbound(missingBinding.connection.id, missingBinding.channel.id, 'missing-binding'),
    )
    const missingBindingEpisode = [...missingBinding.runtimeRepository.episodes.values()][0]!
    missingBinding.coreRepository.bindings.splice(0, 1)
    await expect(missingBinding.runtime.rolloverEpisode(missingBindingEpisode.id)).rejects.toThrow(
      'Binding no longer exists',
    )
  })

  it('replays a triggered Channel Event that was persisted before recovery scanning', async () => {
    const context = await setup()
    await context.runtime.acceptInbound(inbound(context.connection.id, context.channel.id, 'backlog-first'))
    context.core.appendInbound(inbound(context.connection.id, context.channel.id, 'backlog-persisted'))
    expect(context.runtimeRepository.admissions).toHaveLength(1)

    await expect(context.runtime.recover()).resolves.toMatchObject({ resumedEpisodes: 1 })
    expect(context.runtimeRepository.admissions).toHaveLength(2)
    expect([...context.runtimeRepository.admissions.values()][1]).toMatchObject({ state: 'logged-to-session' })
  })
})
