import type { AdapterConnectionContext, AdapterInboundEvent } from '@nekro-nxt/adapter-sdk'
import type {
  AdmissionId,
  AgentId,
  AgentRevisionId,
  AssetId,
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
import { ChannelRuntime } from '../src/index.ts'

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
  getAgent(id: AgentId) {
    return this.agents.get(id)
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
  getConnection(id: ConnectionId) {
    return this.connections.get(id)
  }
  listConnectionIdsByAdapter(adapterKey?: string): readonly ConnectionId[] {
    return [...this.connections.values()]
      .filter((connection) => adapterKey === undefined || connection.adapterKey === adapterKey)
      .map((connection) => connection.id)
  }
  updateConnectionStatus(id: ConnectionId, status: ConnectionRecord['status']): void {
    const current = this.connections.get(id)
    if (!current) throw new Error(`Unknown connection: ${id}`)
    this.connections.set(id, { ...current, status })
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
    const currentIndex = this.bindings.findIndex((binding) => binding.agentId === record.agentId)
    if (currentIndex >= 0) this.bindings.splice(currentIndex, 1)
    this.bindings.push(record)
    return record
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

class MemoryRuntimeRepository implements RuntimeRepository {
  readonly episodes = new Map<EpisodeId, EpisodeRecord>()
  readonly admissions = new Map<AdmissionId, AdmissionRecord>()
  readonly outbounds = new Map<OutboundIntentId, OutboundSnapshot>()
  readonly handoffs: EpisodeHandoffRecord[] = []

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
  beginEpisodeRollover(id: EpisodeId): EpisodeRecord {
    const updated = { ...this.requiredEpisode(id), status: 'rolling-over' as const }
    this.episodes.set(id, updated)
    return updated
  }
  cancelEpisodeRollover(id: EpisodeId): EpisodeRecord {
    const updated = { ...this.requiredEpisode(id), status: 'active' as const }
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
    for (const [id, admission] of this.admissions) {
      if (
        admission.episodeId === input.fromEpisodeId &&
        (admission.state === 'pending' || admission.state === 'claimed')
      ) {
        this.admissions.set(id, { ...admission, episodeId: input.nextEpisode.id })
      }
    }
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
  listAdmittedEventIds(channelId: ChannelId, agentId: AgentId) {
    const episodeIds = new Set(
      [...this.episodes.values()]
        .filter((episode) => episode.channelId === channelId && episode.agentId === agentId)
        .map(({ id }) => id),
    )
    return [...this.admissions.values()]
      .filter((admission) => episodeIds.has(admission.episodeId) && admission.state === 'logged-to-session')
      .flatMap(({ channelEventIds }) => [...channelEventIds])
  }
  claimAdmission(id: AdmissionId, claimedAt: number): void {
    const record = this.requiredAdmission(id)
    this.admissions.set(id, { ...record, state: 'claimed', claimedAt })
  }
  completeAdmission(id: AdmissionId, dshMessageId: string, eventId: ChannelEventId, loggedAt: number): void {
    const record = this.requiredAdmission(id)
    this.admissions.set(id, { ...record, state: 'logged-to-session', dshMessageId, loggedAt })
    const episode = this.requiredEpisode(record.episodeId)
    this.episodes.set(episode.id, { ...episode, lastAdmittedEventId: eventId })
  }
  findOutboundByClientRequest(agentId: AgentId, channelId: ChannelId, clientRequestId: string) {
    return [...this.outbounds.values()].find(
      ({ intent }) =>
        intent.agentId === agentId && intent.channelId === channelId && intent.clientRequestId === clientRequestId,
    )
  }
  createOutboundPlan(intent: OutboundIntentRecord, deliveries: readonly PhysicalDeliveryRecord[]): void {
    this.outbounds.set(intent.id, { intent, deliveries, receipts: [] })
  }
  markIntentSending(id: OutboundIntentId): void {
    this.updateIntent(id, 'sending')
  }
  markDeliverySending(id: PhysicalDeliveryId, attempt: number): void {
    this.updateDelivery(id, (delivery) => ({ ...delivery, state: 'sending', attemptCount: attempt }))
  }
  recordDeliveryReceipt(record: DeliveryReceiptRecord): void {
    const outbound = this.outboundForDelivery(record.physicalDeliveryId)
    const state = record.receipt.status
    this.outbounds.set(outbound.intent.id, {
      ...outbound,
      deliveries: outbound.deliveries.map((delivery) =>
        delivery.id === record.physicalDeliveryId ? { ...delivery, state } : delivery,
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

const setup = async (mixedContent = true, idleRolloverMs?: number | false) => {
  const coreRepository = new MemoryCoreRepository()
  const runtimeRepository = new MemoryRuntimeRepository()
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
    createHandoffSummary: ({ revision }) =>
      Promise.resolve({ summary: '既有对话交接摘要', provider: revision.model.provider, model: revision.model.model }),
    cancelSession: () => Promise.resolve(),
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
    adapter,
    connection,
    channel,
    sessionCalls,
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
        { type: 'file' as const, assetId: 'asset-1' as AssetId, name: 'result.txt' },
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
    expect(admissions[1]?.channelEventIds).toHaveLength(2)
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
    expect(context.runtimeRepository.handoffs[0]?.recentEventIds).toHaveLength(2)
    expect(context.runtimeRepository.admissions).toHaveLength(3)
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
    expect(
      [...context.runtimeRepository.admissions.values()].slice(1).every(({ reason }) => reason === 'running-injection'),
    ).toBe(true)
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
      channelEventIds: admission.channelEventIds,
      reason: admission.reason,
      state: 'claimed',
      createdAt: admission.createdAt,
      ...(admission.claimedAt === undefined ? {} : { claimedAt: admission.claimedAt }),
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
})
