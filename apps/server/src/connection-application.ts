import {
  parseAdapterCapabilities,
  type AdapterConnectionDiagnostic,
  type AdapterConnectionHostContext,
  type AdapterConnectionRuntime,
  type AdapterHostContributionV2,
  type AdapterTransportService,
  type RegisteredAdapterHandle,
} from '@nekro-nxt/adapter-sdk'
import {
  LogicalMessageIdSchema,
  PhysicalDeliveryIdSchema,
  type AdapterActivityKey,
  type ChannelId,
  type ConnectionId,
  type JsonValue,
} from '@nekro-nxt/contracts'
import type { ConnectionEventRecord, ConnectionRecord } from '@nekro-nxt/core'
import { readFile } from 'node:fs/promises'
import { fetchAdapterRemoteBytes } from './adapter-remote-assets.js'
import type { NekroRuntime } from './bootstrap.js'
const parseStoredAdapterConfiguration = (value: JsonValue): Readonly<Record<string, string | number | boolean>> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('连接配置必须是对象。')
  }
  const configuration: Record<string, string | number | boolean> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string' && typeof entry !== 'number' && typeof entry !== 'boolean') {
      throw new TypeError(`连接配置字段 ${key} 的持久格式无效。`)
    }
    configuration[key] = entry
  }
  return configuration
}
export type ConnectionTestResult =
  | { readonly status: 'received'; readonly channelId: ChannelId; readonly platformMessageId: string }
  | { readonly status: 'sent'; readonly channelId: ChannelId; readonly platformMessageId?: string }
  | {
      readonly status: 'waiting-for-message' | 'needs-channel' | 'needs-target' | 'not-connected'
      readonly message: string
    }
  | { readonly status: 'failed'; readonly kind: string; readonly message: string; readonly retryAfterMs?: number }

export class ConnectionApplicationService {
  readonly #adapterHandles: RegisteredAdapterHandle[] = []
  readonly #adapterRuntimes: Map<ConnectionId, AdapterConnectionRuntime>
  readonly #quiescingAdapterKeys = new Set<string>()
  readonly #adapterTransport: AdapterTransportService
  readonly #adapterDiagnostics = new Map<ConnectionId, AdapterConnectionDiagnostic>()
  readonly #connectionTests = new Map<
    ConnectionId,
    { readonly receive?: ConnectionTestResult; readonly send?: ConnectionTestResult }
  >()
  readonly #lastInboundByConnection = new Map<
    ConnectionId,
    { readonly channelId: ChannelId; readonly platformMessageId?: string; readonly receivedAt: number }
  >()
  readonly #connectionListeners = new Set<(event?: ConnectionEventRecord) => void>()
  constructor(
    private readonly ports: Pick<
      NekroRuntime,
      'adapters' | 'core' | 'repository' | 'credentials' | 'channels' | 'assetService' | 'internalConnectionId'
    >,
    readonly now: () => number,
    runtimes: Map<ConnectionId, AdapterConnectionRuntime>,
    transport: AdapterTransportService,
    handles: readonly RegisteredAdapterHandle[],
    private readonly lifecycle: () => { started: boolean; disposed: boolean },
  ) {
    this.#adapterRuntimes = runtimes
    this.#adapterTransport = transport
    this.#adapterHandles.push(...handles)
    this.#adapterDiagnostics.set(ports.internalConnectionId, {
      status: 'connected',
      credentialConfigured: true,
      proactiveSend: true,
    })
  }
  localChannel(id: ConnectionId) {
    return this.#adapterRuntimes.get(id)?.localChannel
  }
  clearObservers() {
    this.#connectionListeners.clear()
  }
  stopAll() {
    return Promise.allSettled([...this.#adapterRuntimes.values()].map((runtime) => runtime.stop()))
  }
  async disposeRegistrations() {
    const outcomes = await Promise.allSettled(this.#adapterHandles.map((handle) => handle.dispose()))
    this.#adapterHandles.length = 0
    this.#adapterDiagnostics.clear()
    this.#connectionTests.clear()
    this.#lastInboundByConnection.clear()
    this.#adapterRuntimes.clear()
    return outcomes
  }
  async waitUntilSafe(adapterKey: string) {
    this.#quiescingAdapterKeys.add(adapterKey)
    try {
      await this.ports.channels.waitUntilConnectionsSafe(this.ports.repository.listConnectionIdsByAdapter(adapterKey))
    } catch (error) {
      this.#quiescingAdapterKeys.delete(adapterKey)
      throw error
    }
  }
  subscribeConnectionChanges(listener: (event?: ConnectionEventRecord) => void): () => void {
    this.#connectionListeners.add(listener)
    return () => this.#connectionListeners.delete(listener)
  }
  adapterConnectionDiagnostic(connectionId: ConnectionId): AdapterConnectionDiagnostic | undefined {
    return this.#adapterDiagnostics.get(connectionId)
  }
  lastInbound(connectionId: ConnectionId) {
    return this.#lastInboundByConnection.get(connectionId)
  }
  connectionTests(connectionId: ConnectionId) {
    return this.#connectionTests.get(connectionId)
  }
  listConnectionAdapters() {
    return this.ports.adapters.list().map(({ descriptor }) => descriptor)
  }
  async createConnection(input: {
    readonly adapterKey: string
    readonly alias?: string | undefined
    readonly configuration?: Readonly<Record<string, unknown>>
    readonly credentials?: Readonly<Record<string, unknown>>
  }) {
    if (!this.lifecycle().started || this.lifecycle().disposed)
      throw new Error('NekroRuntime is not accepting new Connections.')
    const contribution = this.ports.adapters.get(input.adapterKey)
    if (contribution?.descriptor.provisioning !== 'user-created') throw new Error('该连接平台不可由用户创建。')
    const descriptor = contribution.descriptor
    const configurationInput = input.configuration ?? {}
    const credentialsInput = input.credentials ?? {}
    const configuration: Record<string, string | number | boolean> = {}
    const rawCredentials: Array<{ readonly key: string; readonly value: string }> = []
    for (const key of Object.keys(configurationInput)) {
      const property = descriptor.configSchema.properties[key]
      if (!property || property.type === 'credential-reference') throw new TypeError(`连接配置包含未知字段：${key}`)
    }
    for (const key of Object.keys(credentialsInput)) {
      const property = descriptor.configSchema.properties[key]
      if (!property || property.type !== 'credential-reference') throw new TypeError(`连接凭据包含未知字段：${key}`)
    }
    for (const [key, property] of Object.entries(descriptor.configSchema.properties)) {
      if (property.type === 'credential-reference') {
        const raw = credentialsInput[key]
        if (raw === undefined && descriptor.configSchema.required.includes(key))
          throw new TypeError(`请填写${property.title}。`)
        if (raw !== undefined) {
          if (typeof raw !== 'string' || !raw.trim()) throw new TypeError(`请填写${property.title}。`)
          rawCredentials.push({ key: property.credentialKey?.trim() || key, value: raw })
        }
        continue
      }
      const value = configurationInput[key] ?? property.default
      if (value === undefined) {
        if (descriptor.configSchema.required.includes(key)) throw new TypeError(`请填写${property.title}。`)
        continue
      }
      if (property.type === 'string' && typeof value === 'string') configuration[key] = value
      else if (property.type === 'number' && typeof value === 'number') configuration[key] = value
      else if (property.type === 'boolean' && typeof value === 'boolean') configuration[key] = value
      else throw new TypeError(`${property.title}的类型无效。`)
    }
    const credentialRefs: Record<string, string> = {}
    try {
      for (const credential of rawCredentials)
        credentialRefs[credential.key] = await this.ports.credentials.save(credential.value)
      const connection = this.ports.core.createConnection({
        adapterKey: descriptor.key,
        ...(input.alias === undefined ? {} : { alias: input.alias }),
        config: configuration,
        credentialRefs,
      })
      await this.mountAdapter(connection.id)
      return connection
    } catch (error) {
      await Promise.allSettled(
        Object.values(credentialRefs).map((reference) => this.ports.credentials.delete(reference)),
      )
      throw error
    }
  }
  updateConnectionAlias(connectionId: ConnectionId, alias?: string): ConnectionRecord {
    if (this.lifecycle().disposed) throw new Error('NekroRuntime is disposed.')
    const connection = this.ports.core.getConnection(connectionId)
    if (!connection) throw new Error('连接不存在。')
    const descriptor = this.ports.adapters.get(connection.adapterKey)?.descriptor
    if (!descriptor?.aliasEditable) throw new Error('系统托管连接不需要编辑别名。')
    const updated = this.ports.core.updateConnectionAlias(connectionId, alias)
    this.#notifyConnectionChanges()
    return updated
  }
  updateConnectionActivityTriggerDefaults(
    connectionId: ConnectionId,
    activityKeys: readonly AdapterActivityKey[],
  ): ConnectionRecord {
    if (this.lifecycle().disposed) throw new Error('NekroRuntime is disposed.')
    const connection = this.ports.core.getConnection(connectionId)
    if (!connection) throw new Error('连接不存在。')
    const descriptor = this.ports.adapters.get(connection.adapterKey)?.descriptor
    if (!descriptor) throw new Error('这个连接的适配器未安装，无法修改活动默认值。')
    if (new Set(activityKeys).size !== activityKeys.length) throw new Error('连接活动默认值不能包含重复项。')
    for (const activityKey of activityKeys) {
      const definition = descriptor.activities.find((activity) => activity.key === activityKey)
      const capability = this.connectionCapabilities(connectionId)?.activities[activityKey]
      if (
        definition?.scope !== 'channel' ||
        !definition.triggerable ||
        capability?.state === 'disabled' ||
        capability?.state === 'unsupported'
      ) {
        throw new Error(`当前连接不支持活动触发：${activityKey}`)
      }
    }
    const updated = this.ports.core.updateConnectionActivityTriggerDefaults(connectionId, activityKeys)
    this.#notifyConnectionChanges()
    return updated
  }
  async deleteConnection(
    connectionId: ConnectionId,
    options: { readonly deleteChannelData: boolean },
  ): Promise<{ readonly archived: boolean }> {
    if (this.lifecycle().disposed) throw new Error('NekroRuntime is disposed.')
    if (connectionId === this.ports.internalConnectionId) throw new Error('系统托管连接不能删除。')
    const connection =
      this.ports.core.getConnection(connectionId) ?? this.ports.repository.getArchivedConnection(connectionId)
    if (!connection) throw new Error('连接不存在。')
    const active = this.ports.core.getConnection(connectionId)
    if (active) {
      for (const channel of this.ports.core.listChannelsByConnection(connectionId))
        await this.ports.channels.suspendChannel(channel.id)
      await this.ports.channels.waitUntilConnectionsSafe([connectionId])
      const runtime = this.#adapterRuntimes.get(connectionId)
      await runtime?.stop()
      this.#adapterRuntimes.delete(connectionId)
    }
    this.#adapterDiagnostics.delete(connectionId)
    this.#connectionTests.delete(connectionId)
    if (options.deleteChannelData) {
      this.ports.core.purgeConnection(connectionId)
      await Promise.allSettled(
        Object.values(connection.credentialRefs).map((reference) => this.ports.credentials.delete(reference)),
      )
      this.#notifyConnectionChanges()
      return { archived: false }
    }
    if (active) this.ports.core.archiveConnection(connectionId)
    this.#notifyConnectionChanges()
    return { archived: true }
  }
  async restoreConnection(connectionId: ConnectionId): Promise<ConnectionRecord> {
    if (!this.lifecycle().started || this.lifecycle().disposed)
      throw new Error('NekroRuntime is not accepting restored Connections.')
    const archived = this.ports.repository.getArchivedConnection(connectionId)
    if (!archived) throw new Error('可恢复的连接不存在。')
    if (this.ports.adapters.get(archived.adapterKey)?.descriptor.provisioning !== 'user-created') {
      throw new Error('这个连接当前无法恢复。')
    }
    const connection = this.ports.core.restoreConnection(connectionId)
    await this.mountAdapter(connectionId)
    this.#notifyConnectionChanges()
    return connection
  }
  async testConnection(
    connectionId: ConnectionId,
    direction: 'send' | 'receive',
    targetChannelId?: ChannelId,
  ): Promise<ConnectionTestResult> {
    const connection = this.ports.core.listConnections().find((candidate) => candidate.id === connectionId)
    if (!connection) throw new Error('Connection does not exist.')
    const descriptor = this.ports.adapters.get(connection.adapterKey)?.descriptor
    if (!descriptor?.diagnostics[direction]) throw new Error('该连接平台不提供这个测试流程。')
    const runtime = this.#adapterRuntimes.get(connectionId)
    const diagnostic = this.#adapterDiagnostics.get(connectionId)
    if (!runtime || diagnostic?.status !== 'connected') {
      return { status: 'not-connected', message: diagnostic?.message ?? '尚未连接到该平台。' }
    }
    if (direction === 'receive') {
      const inbound = this.#lastInboundByConnection.get(connectionId)
      const result: ConnectionTestResult = inbound?.platformMessageId
        ? {
            status: 'received',
            channelId: inbound.channelId,
            platformMessageId: inbound.platformMessageId,
          }
        : { status: 'waiting-for-message', message: '请先从平台发送一条消息，再重新测试接收。' }
      this.#recordConnectionTest(connectionId, direction, result)
      return result
    }
    const channels = this.ports.core.listChannelsByConnection(connectionId)
    if (targetChannelId !== undefined && !channels.some(({ id }) => id === targetChannelId)) {
      throw new Error('测试目标不属于这个连接。')
    }
    const channelId = targetChannelId ?? (channels.length === 1 ? channels[0]?.id : undefined)
    if (!channelId) {
      return channels.length === 0
        ? { status: 'needs-channel', message: '尚未发现频道；请先从平台发送一条消息。' }
        : { status: 'needs-target', message: '该连接发现了多个频道，请选择发送测试的目标频道。' }
    }
    try {
      const parts = [{ type: 'text' as const, text: 'NekroNXT 连接诊断测试消息。' }]
      const plans = runtime.planOutbound ? await runtime.planOutbound({ connectionId, channelId, parts }) : [{ parts }]
      let platformMessageId: string | undefined
      for (const [index, plan] of plans.entries()) {
        const receipt = await runtime.deliver(
          {
            deliveryId: PhysicalDeliveryIdSchema.parse(`phy_TEST${this.now()}${index}`),
            logicalMessageId: LogicalMessageIdSchema.parse(`msg_TEST${this.now()}${index}`),
            connectionId,
            channelId,
            parts: plan.parts,
            ...(plan.adapterContext === undefined ? {} : { adapterContext: plan.adapterContext }),
          },
          AbortSignal.timeout(15_000),
        )
        if (receipt.status === 'failed') {
          return { status: 'failed', kind: receipt.failure.kind, message: receipt.failure.message }
        }
        if (receipt.status === 'unknown') return { status: 'failed', kind: 'transient', message: receipt.message }
        platformMessageId = receipt.platformMessageId ?? platformMessageId
      }
      const result: ConnectionTestResult = {
        status: 'sent',
        channelId,
        ...(platformMessageId === undefined ? {} : { platformMessageId }),
      }
      this.#recordConnectionTest(connectionId, direction, result)
      return result
    } catch (error) {
      return { status: 'failed', kind: 'transient', message: error instanceof Error ? error.message : String(error) }
    }
  }
  connectionCapabilities(connectionId: ConnectionId) {
    return this.#adapterRuntimes.get(connectionId)?.capabilities
  }
  #recordConnectionTest(connectionId: ConnectionId, direction: 'send' | 'receive', result: ConnectionTestResult): void {
    this.#connectionTests.set(connectionId, { ...this.#connectionTests.get(connectionId), [direction]: result })
    this.#notifyConnectionChanges()
  }
  registerAdapter(owner: string, contribution: AdapterHostContributionV2): Promise<RegisteredAdapterHandle> {
    const registered = this.ports.adapters.register(owner, contribution)
    this.#cleanAdapterBindings(contribution.descriptor.key)
    this.#notifyConnectionChanges()
    return Promise.resolve({
      ...registered,
      dispose: async () => {
        await this.stopAdapterConnections(contribution.descriptor.key)
        await registered.dispose()
        this.#notifyConnectionChanges()
      },
    })
  }
  async mountAdapterConnections(adapterKey: string): Promise<void> {
    this.#quiescingAdapterKeys.delete(adapterKey)
    for (const connectionId of this.ports.repository.listConnectionIdsByAdapter(adapterKey))
      await this.mountAdapter(connectionId)
  }
  async stopAdapterConnections(adapterKey: string): Promise<void> {
    const connectionIds = this.ports.repository.listConnectionIdsByAdapter(adapterKey)
    const outcomes = await Promise.allSettled(
      connectionIds.map(async (connectionId) => {
        const runtime = this.#adapterRuntimes.get(connectionId)
        await runtime?.stop()
        this.#adapterRuntimes.delete(connectionId)
        this.#adapterDiagnostics.set(connectionId, { status: 'stopped', message: '这个连接的适配器未安装。' })
      }),
    )
    this.#notifyConnectionChanges()
    const failures = outcomes
      .map((outcome, index) => ({ outcome, connectionId: connectionIds[index]! }))
      .filter(
        (item): item is { outcome: PromiseRejectedResult; connectionId: ConnectionId } =>
          item.outcome.status === 'rejected',
      )
    if (failures.length) {
      this.#quiescingAdapterKeys.delete(adapterKey)
      for (const { connectionId, outcome } of failures) {
        this.#adapterDiagnostics.set(connectionId, {
          status: 'failed',
          message: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
        })
      }
      const remounts = await Promise.allSettled(
        outcomes.flatMap((outcome, index) =>
          outcome.status === 'fulfilled' ? [this.mountAdapter(connectionIds[index]!)] : [],
        ),
      )
      const remountFailures = remounts
        .filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
        .map((outcome): unknown => outcome.reason)
      this.#notifyConnectionChanges()
      throw new AggregateError(
        [
          ...failures.map(({ outcome }) =>
            outcome.reason instanceof Error ? outcome.reason : new Error(String(outcome.reason)),
          ),
          ...remountFailures,
        ],
        '适配器连接未能全部静止；安装状态保持不变。',
      )
    }
  }
  async mountAdapter(connectionId: ConnectionId): Promise<void> {
    if (this.#adapterRuntimes.has(connectionId)) return
    const connection = this.ports.core.getConnection(connectionId)
    if (!connection) throw new Error('Connection does not exist.')
    const contribution = this.ports.adapters.get(connection.adapterKey)
    if (!contribution) {
      this.#adapterDiagnostics.set(connectionId, { status: 'stopped', message: '这个连接的适配器未安装。' })
      this.#notifyConnectionChanges()
      return
    }
    this.#cleanConnectionBindings(connectionId, contribution)
    let credentialsAvailable = true
    try {
      for (const reference of Object.values(connection.credentialRefs)) {
        let available = false
        try {
          available = await this.ports.credentials.has(reference)
        } catch {
          available = false
        }
        if (!available) {
          credentialsAvailable = false
          throw new Error('这个连接的凭据不可用。')
        }
      }
      const configuration = parseStoredAdapterConfiguration(connection.config)
      const runtime = await contribution.create(this.#adapterContext(connectionId), {
        configuration,
        credentialRefs: connection.credentialRefs,
      })
      const capabilities = parseAdapterCapabilities(runtime.capabilities)
      const declaredActivityKeys = new Set(contribution.descriptor.activities.map((activity) => activity.key))
      const capabilityKeys = Object.keys(capabilities.activities)
      if (
        capabilityKeys.some((key) => !declaredActivityKeys.has(key)) ||
        contribution.descriptor.activities.some((activity) => capabilities.activities[activity.key] === undefined)
      ) {
        throw new Error('Adapter runtime activity capabilities do not match its Descriptor.')
      }
      if (
        (contribution.descriptor.features.processingFeedback === undefined) !==
        (capabilities.processingFeedback === undefined)
      ) {
        throw new Error('Adapter runtime processing-feedback capability does not match its Descriptor.')
      }
      this.#adapterRuntimes.set(connectionId, runtime)
      this.#adapterDiagnostics.set(connectionId, {
        status: 'connecting',
        credentialConfigured: Object.keys(connection.credentialRefs).length > 0,
        proactiveSend: runtime.capabilities.outbound.proactiveSend,
      })
      await runtime.start()
      if (this.#adapterDiagnostics.get(connectionId)?.status === 'connecting') {
        this.#adapterDiagnostics.set(connectionId, {
          status: 'connected',
          credentialConfigured: Object.keys(connection.credentialRefs).length > 0,
          proactiveSend: runtime.capabilities.outbound.proactiveSend,
        })
      }
    } catch (error) {
      const runtime = this.#adapterRuntimes.get(connectionId)
      this.#adapterRuntimes.delete(connectionId)
      await runtime?.stop().catch(() => undefined)
      this.#adapterDiagnostics.set(connectionId, {
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
        credentialConfigured: credentialsAvailable && Object.keys(connection.credentialRefs).length > 0,
      })
    }
    this.#notifyConnectionChanges()
  }
  #cleanAdapterBindings(adapterKey: string): void {
    const contribution = this.ports.adapters.get(adapterKey)
    if (!contribution) return
    for (const connectionId of this.ports.repository.listConnectionIdsByAdapter(adapterKey)) {
      this.#cleanConnectionBindings(connectionId, contribution)
    }
  }
  #cleanConnectionBindings(connectionId: ConnectionId, contribution: AdapterHostContributionV2): void {
    const connection = this.ports.core.getConnection(connectionId)
    if (connection) {
      const activityTriggerDefaults = connection.activityTriggerDefaults.filter((key) => {
        const definition = contribution.descriptor.activities.find((activity) => activity.key === key)
        return definition?.scope === 'channel' && definition.triggerable
      })
      if (activityTriggerDefaults.length !== connection.activityTriggerDefaults.length) {
        this.ports.repository.updateConnectionActivityTriggerDefaults(connectionId, activityTriggerDefaults)
      }
    }
    for (const channel of this.ports.core.listChannelsByConnection(connectionId)) {
      const binding = this.ports.repository.getBinding(channel.id)
      if (!binding) continue
      const activityTriggerOverrides = Object.fromEntries(
        Object.entries(binding.activityTriggerOverrides).filter(([key]) => {
          const definition = contribution.descriptor.activities.find((activity) => activity.key === key)
          return (
            definition?.scope === 'channel' &&
            definition.triggerable &&
            definition.channelKinds?.includes(channel.kind) === true
          )
        }),
      )
      if (Object.keys(activityTriggerOverrides).length !== Object.keys(binding.activityTriggerOverrides).length) {
        this.ports.repository.replaceBinding({ ...binding, activityTriggerOverrides })
      }
    }
  }
  #adapterContext(connectionId: ConnectionId): AdapterConnectionHostContext {
    const rejectEvent = (message: string): never => {
      const current = this.#adapterDiagnostics.get(connectionId)
      this.#adapterDiagnostics.set(connectionId, {
        status: current?.status ?? 'connected',
        message,
        credentialConfigured: current?.credentialConfigured ?? false,
        proactiveSend: current?.proactiveSend ?? false,
        details: { eventRejected: true },
      })
      this.#notifyConnectionChanges()
      throw new Error(message)
    }
    const resolveOwnedDescriptor = (adapterKey: string) => {
      const connection = this.ports.core.getConnection(connectionId)
      if (!connection || connection.adapterKey !== adapterKey) {
        return rejectEvent('适配器提交的事件不属于当前连接。')
      }
      const descriptor = this.ports.adapters.get(connection.adapterKey)?.descriptor
      if (!descriptor) return rejectEvent('提交事件的适配器当前未注册。')
      return descriptor
    }
    return {
      connectionId,
      now: this.now,
      acceptChannelInbound: async (event) => {
        if (event.connectionId !== connectionId) return rejectEvent('适配器提交了其他连接的频道事件。')
        const adapterKey = this.ports.core.getConnection(connectionId)?.adapterKey
        if (adapterKey && this.#quiescingAdapterKeys.has(adapterKey)) {
          throw new Error('适配器正在进入安全间隙，暂不接收新的频道事件。')
        }
        const descriptor = resolveOwnedDescriptor(event.adapterKey)
        const channel = this.ports.core.getChannel(event.channelId)
        if (!channel || channel.connectionId !== connectionId) {
          return rejectEvent('适配器提交的频道事件不属于当前连接。')
        }
        if (event.activityKey !== undefined) {
          const activity = descriptor.activities.find((candidate) => candidate.key === event.activityKey)
          if (activity?.scope !== 'channel') return rejectEvent(`适配器提交了未声明的频道活动：${event.activityKey}`)
          if (activity.channelKinds?.includes(channel.kind) !== true) {
            return rejectEvent(`频道活动 ${event.activityKey} 不适用于当前频道类型。`)
          }
        }
        this.#lastInboundByConnection.set(connectionId, {
          channelId: event.channelId,
          ...(event.platformMessageId === undefined ? {} : { platformMessageId: event.platformMessageId }),
          receivedAt: event.receivedAt,
        })
        return this.ports.channels.acceptChannelInbound(event)
      },
      acceptConnectionInbound: (event) => {
        if (event.connectionId !== connectionId) return rejectEvent('适配器提交了其他连接的连接活动。')
        const descriptor = resolveOwnedDescriptor(event.adapterKey)
        const activity = descriptor.activities.find((candidate) => candidate.key === event.activityKey)
        if (activity?.scope !== 'connection') {
          return rejectEvent(`适配器提交了未声明的连接活动：${event.activityKey}`)
        }
        const commit = this.ports.core.appendConnectionInbound(event)
        if (commit.inserted) this.#notifyConnectionChanges(commit.event)
        return Promise.resolve({ connectionEventId: commit.event.id, inserted: commit.inserted })
      },
      channels: {
        ensure: (input) =>
          Promise.resolve(
            this.ports.core.ensureChannel({
              connectionId,
              platformChannelId: input.platformChannelId,
              kind: input.kind,
              ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
              observedAt: input.observedAt,
            }).id,
          ),
        updateDisplayName: (channelId, displayName) => {
          const channel = this.ports.core.getChannel(channelId)
          if (channel?.connectionId !== connectionId)
            throw new Error('Adapter cannot update another Connection channel.')
          this.ports.core.updateChannelDisplayName(channelId, displayName)
          return Promise.resolve()
        },
        resolvePlatformChannelId: (channelId) => {
          const channel = this.ports.core.getChannel(channelId)
          return Promise.resolve(channel?.connectionId === connectionId ? channel.platformChannelId : undefined)
        },
        resolveKind: (channelId) => {
          const channel = this.ports.core.getChannel(channelId)
          return Promise.resolve(
            channel?.connectionId !== connectionId || channel.kind === 'internal' ? undefined : channel.kind,
          )
        },
      },
      identities: {
        ensure: (input) =>
          Promise.resolve(
            this.ports.core.ensurePlatformIdentity({
              connectionId,
              platformUserId: input.platformUserId,
              ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
              observedAt: input.observedAt,
            }).id,
          ),
      },
      members: {
        ensure: (input) =>
          Promise.resolve(
            this.ports.core.observeChannelMember({
              connectionId,
              channelId: input.channelId,
              platformUserId: input.platformUserId,
              ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
              observedAt: input.observedAt,
            }).member.id,
          ),
        resolvePlatformUserId: (channelId, memberId) =>
          Promise.resolve(
            this.ports.core.resolveChannelMemberIdentity(connectionId, channelId, memberId)?.platformUserId,
          ),
      },
      messages: {
        resolvePlatformMessage: (channelId, platformMessageId) =>
          Promise.resolve(this.ports.core.resolvePlatformMessage(connectionId, channelId, platformMessageId)),
        resolvePlatformMessageId: (channelId, logicalMessageId) =>
          Promise.resolve(this.ports.core.resolveLogicalMessagePlatformId(connectionId, channelId, logicalMessageId)),
        resolveLogicalMessage: (channelId, logicalMessageId) =>
          Promise.resolve(this.ports.repository.resolveLogicalMessage(connectionId, channelId, logicalMessageId)),
      },
      assets: {
        importBytes: async (input) => {
          const prepared = await this.ports.assetService.prepare(input)
          return {
            assetId: prepared.asset.id,
            mediaType: prepared.asset.mediaType,
            byteSize: prepared.asset.byteSize,
          }
        },
        read: async ({ assetId, channelId }) => {
          if (!this.ports.repository.canAccessAsset(assetId, channelId)) {
            throw new Error('Adapter Asset is not authorized for this Channel.')
          }
          const asset = this.ports.repository.getAssetById(assetId)
          if (!asset) throw new Error('Adapter Asset is unavailable.')
          return {
            bytes: new Uint8Array(await readFile(this.ports.assetService.blobPath(asset))),
            mediaType: asset.mediaType,
            byteSize: asset.byteSize,
          }
        },
        fetchRemoteBytes: fetchAdapterRemoteBytes,
      },
      credentials: { resolve: (reference) => this.ports.credentials.resolve(reference) },
      state: {
        load: (key) => this.ports.repository.load(connectionId, key),
        save: (key, value) => this.ports.repository.save(connectionId, key, value, this.now()),
        clear: (key) => this.ports.repository.clear(connectionId, key),
      },
      diagnostics: {
        publish: (diagnostic) => {
          this.#adapterDiagnostics.set(connectionId, {
            ...diagnostic,
            credentialConfigured:
              Object.keys(this.ports.core.getConnection(connectionId)?.credentialRefs ?? {}).length > 0,
            proactiveSend: this.#adapterRuntimes.get(connectionId)?.capabilities.outbound.proactiveSend ?? false,
          })
          this.#notifyConnectionChanges()
        },
      },
      transport: this.#adapterTransport,
    }
  }
  #notifyConnectionChanges(event?: ConnectionEventRecord): void {
    for (const listener of this.#connectionListeners) {
      try {
        listener(event)
      } catch {
        // A diagnostic observer cannot interrupt the owned Connection lifecycle.
      }
    }
  }
}
