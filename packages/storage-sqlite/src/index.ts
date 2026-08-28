import type { AdapterRuntimeStateStore } from '@nekro-nxt/adapter-sdk'
import type { ChannelReferenceRecord, CoreRepository } from '@nekro-nxt/core'
import type { ChannelId, JsonValue } from '@nekro-nxt/contracts'
import type { AssetAccessRepository } from '@nekro-nxt/core'
import type { ChannelHistoryRepository, RuntimeRepository } from '@nekro-nxt/channel-runtime'
import type { ExtensionRepository, HostUiRepository } from '@nekro-nxt/extension-runtime'
import { eq } from 'drizzle-orm'
import type { CoreDatabase } from './database.js'
import { systemSettings, workTreeOrder } from './schema.js'
import { createAgentsRepository } from './repositories/agents.js'
import { createChannelsRepository } from './repositories/channels.js'
import { createOutboxRepository } from './repositories/outbox.js'
import { createRuntimeRepository } from './repositories/runtime.js'
import { createExtensionsRepository } from './repositories/extensions.js'
import { createAssetsRepository } from './repositories/assets.js'
import { createDshPluginRepository, type DshPluginRepository } from './repositories/dsh-plugins.js'

export * from './backup.js'
export * from './database.js'
export * from './dsh-session-storage.js'
export * from './host-security.js'
export * from './schema.js'
export * from './row-schemas.js'
export type { DshPluginRepository } from './repositories/dsh-plugins.js'

type CurrentRepository = CoreRepository &
  RuntimeRepository &
  ChannelHistoryRepository &
  AdapterRuntimeStateStore &
  ExtensionRepository &
  HostUiRepository &
  AssetAccessRepository

/** Typed Drizzle façade. Domain implementations stay separate and share one immediate-transaction database. */
export type WorkTreeOrderRecord = {
  readonly agentIds: readonly string[]
  readonly channelIdsByAgent: Readonly<Record<string, readonly string[]>>
  readonly unboundChannelIds: readonly string[]
}

export type SystemSettingRecord = {
  readonly key: string
  readonly value: JsonValue
  readonly revision: number
  readonly updatedAt: number
}

const emptyWorkTreeOrder = (): WorkTreeOrderRecord => ({
  agentIds: [],
  channelIdsByAgent: {},
  unboundChannelIds: [],
})

export class SqliteCoreRepository implements CurrentRepository {
  readonly #db
  readonly #agents
  readonly #channels
  readonly #runtime
  readonly #outbox
  readonly #extensions
  readonly #assets
  readonly #dshPlugins

  constructor(database: CoreDatabase) {
    this.#db = database.db
    this.#agents = createAgentsRepository(database.db)
    this.#channels = createChannelsRepository(database.db)
    this.#runtime = createRuntimeRepository(database.db)
    this.#outbox = createOutboxRepository(database.db)
    this.#extensions = createExtensionsRepository(database.db)
    this.#assets = createAssetsRepository(database.db)
    this.#dshPlugins = createDshPluginRepository(database.db)
  }

  getWorkTreeOrder(): WorkTreeOrderRecord {
    const row = this.#db.select().from(workTreeOrder).where(eq(workTreeOrder.id, 1)).get()
    if (!row) return emptyWorkTreeOrder()
    return {
      agentIds: row.agentIds,
      channelIdsByAgent: row.channelIdsByAgent,
      unboundChannelIds: row.unboundChannelIds,
    }
  }

  putWorkTreeOrder(order: WorkTreeOrderRecord): WorkTreeOrderRecord {
    this.#db
      .insert(workTreeOrder)
      .values({
        id: 1,
        agentIds: order.agentIds,
        channelIdsByAgent: order.channelIdsByAgent,
        unboundChannelIds: order.unboundChannelIds,
      })
      .onConflictDoUpdate({
        target: workTreeOrder.id,
        set: {
          agentIds: order.agentIds,
          channelIdsByAgent: order.channelIdsByAgent,
          unboundChannelIds: order.unboundChannelIds,
        },
      })
      .run()
    return order
  }

  getSystemSetting(key: string): SystemSettingRecord | undefined {
    const normalizedKey = key.trim()
    if (!normalizedKey) throw new TypeError('System setting key must not be empty.')
    return this.#db.select().from(systemSettings).where(eq(systemSettings.key, normalizedKey)).get()
  }

  putSystemSetting(
    key: string,
    value: JsonValue,
    expectedRevision: number | undefined,
    updatedAt: number,
  ): SystemSettingRecord {
    const normalizedKey = key.trim()
    if (!normalizedKey) throw new TypeError('System setting key must not be empty.')
    if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) {
      throw new TypeError('System setting updatedAt must be a non-negative integer.')
    }
    return this.#db.transaction((transaction) => {
      const current = transaction.select().from(systemSettings).where(eq(systemSettings.key, normalizedKey)).get()
      if (current?.revision !== expectedRevision || (current === undefined && expectedRevision !== undefined)) {
        throw new Error('System setting revision conflict.')
      }
      const record: SystemSettingRecord = {
        key: normalizedKey,
        value,
        revision: (current?.revision ?? 0) + 1,
        updatedAt,
      }
      transaction
        .insert(systemSettings)
        .values(record)
        .onConflictDoUpdate({
          target: systemSettings.key,
          set: { value: record.value, revision: record.revision, updatedAt: record.updatedAt },
        })
        .run()
      return record
    })
  }

  readonly createAgent = (...args: Parameters<CoreRepository['createAgent']>) => this.#agents.createAgent(...args)
  readonly createAgentWithChannel = (...args: Parameters<CoreRepository['createAgentWithChannel']>) =>
    this.#agents.createAgentWithChannel(...args)
  readonly tombstoneAgent = (...args: Parameters<CoreRepository['tombstoneAgent']>) =>
    this.#agents.tombstoneAgent(...args)
  readonly getAgent = (...args: Parameters<CoreRepository['getAgent']>) => this.#agents.getAgent(...args)
  readonly listAgents = (...args: Parameters<CoreRepository['listAgents']>) => this.#agents.listAgents(...args)
  readonly getAgentRevision = (...args: Parameters<CoreRepository['getAgentRevision']>) =>
    this.#agents.getAgentRevision(...args)
  readonly getAgentRevisionByDigest = (...args: Parameters<CoreRepository['getAgentRevisionByDigest']>) =>
    this.#agents.getAgentRevisionByDigest(...args)
  readonly listAgentRevisions = (...args: Parameters<CoreRepository['listAgentRevisions']>) =>
    this.#agents.listAgentRevisions(...args)
  readonly getNextAgentRevisionNumber = (...args: Parameters<CoreRepository['getNextAgentRevisionNumber']>) =>
    this.#agents.getNextAgentRevisionNumber(...args)
  readonly appendAgentRevision = (...args: Parameters<CoreRepository['appendAgentRevision']>) =>
    this.#agents.appendAgentRevision(...args)
  readonly activateAgentRevision = (...args: Parameters<CoreRepository['activateAgentRevision']>) =>
    this.#agents.activateAgentRevision(...args)

  readonly createConnection = (...args: Parameters<CoreRepository['createConnection']>) =>
    this.#channels.createConnection(...args)
  readonly updateConnectionAlias = (...args: Parameters<CoreRepository['updateConnectionAlias']>) =>
    this.#channels.updateConnectionAlias(...args)
  readonly getConnection = (...args: Parameters<CoreRepository['getConnection']>) =>
    this.#channels.getConnection(...args)
  readonly listConnectionIdsByAdapter = (...args: Parameters<CoreRepository['listConnectionIdsByAdapter']>) =>
    this.#channels.listConnectionIdsByAdapter(...args)
  readonly createChannel = (...args: Parameters<CoreRepository['createChannel']>) =>
    this.#channels.createChannel(...args)
  readonly ensureChannel = (...args: Parameters<CoreRepository['ensureChannel']>) =>
    this.#channels.ensureChannel(...args)
  readonly tombstoneChannel = (...args: Parameters<CoreRepository['tombstoneChannel']>) =>
    this.#channels.tombstoneChannel(...args)
  readonly updateChannelDisplayName = (...args: Parameters<CoreRepository['updateChannelDisplayName']>) =>
    this.#channels.updateChannelDisplayName(...args)
  readonly getChannel = (...args: Parameters<CoreRepository['getChannel']>) => this.#channels.getChannel(...args)
  readonly getChannelReference = (id: ChannelId): ChannelReferenceRecord | undefined =>
    this.#channels.getChannelReference(id)
  readonly getChannelByPlatformId = (...args: Parameters<CoreRepository['getChannelByPlatformId']>) =>
    this.#channels.getChannelByPlatformId(...args)
  readonly listChannelIdsByConnection = (...args: Parameters<CoreRepository['listChannelIdsByConnection']>) =>
    this.#channels.listChannelIdsByConnection(...args)
  readonly ensurePlatformIdentity = (...args: Parameters<CoreRepository['ensurePlatformIdentity']>) =>
    this.#channels.ensurePlatformIdentity(...args)
  readonly getPlatformIdentity = (...args: Parameters<CoreRepository['getPlatformIdentity']>) =>
    this.#channels.getPlatformIdentity(...args)
  readonly listPlatformUsers = (...args: Parameters<CoreRepository['listPlatformUsers']>) =>
    this.#channels.listPlatformUsers(...args)
  readonly ensureChannelMember = (...args: Parameters<CoreRepository['ensureChannelMember']>) =>
    this.#channels.ensureChannelMember(...args)
  readonly getChannelMember = (...args: Parameters<CoreRepository['getChannelMember']>) =>
    this.#channels.getChannelMember(...args)
  readonly getChannelMemberByIdentity = (...args: Parameters<CoreRepository['getChannelMemberByIdentity']>) =>
    this.#channels.getChannelMemberByIdentity(...args)
  readonly replaceBinding = (...args: Parameters<CoreRepository['replaceBinding']>) =>
    this.#channels.replaceBinding(...args)
  readonly clearBinding = (...args: Parameters<CoreRepository['clearBinding']>) => this.#channels.clearBinding(...args)
  readonly getBinding = (...args: Parameters<CoreRepository['getBinding']>) => this.#channels.getBinding(...args)
  readonly listBindings = (...args: Parameters<CoreRepository['listBindings']>) => this.#channels.listBindings(...args)
  readonly appendChannelEvent = (...args: Parameters<CoreRepository['appendChannelEvent']>) =>
    this.#channels.appendChannelEvent(...args)
  readonly getChannelEvent = (...args: Parameters<CoreRepository['getChannelEvent']>) =>
    this.#channels.getChannelEvent(...args)
  readonly listChannelEvents = (...args: Parameters<CoreRepository['listChannelEvents']>) =>
    this.#channels.listChannelEvents(...args)
  readonly resolvePlatformMessage = (...args: Parameters<CoreRepository['resolvePlatformMessage']>) =>
    this.#channels.resolvePlatformMessage(...args)
  readonly resolveLogicalMessage = (...args: Parameters<CoreRepository['resolveLogicalMessage']>) =>
    this.#channels.resolveLogicalMessage(...args)
  readonly resolveLogicalMessagePlatformId = (...args: Parameters<CoreRepository['resolveLogicalMessagePlatformId']>) =>
    this.#channels.resolveLogicalMessagePlatformId(...args)

  readonly getEpisode = (...args: Parameters<RuntimeRepository['getEpisode']>) => this.#runtime.getEpisode(...args)
  readonly getActiveEpisode = (...args: Parameters<RuntimeRepository['getActiveEpisode']>) =>
    this.#runtime.getActiveEpisode(...args)
  readonly listRecoverableEpisodes = (...args: Parameters<RuntimeRepository['listRecoverableEpisodes']>) =>
    this.#runtime.listRecoverableEpisodes(...args)
  readonly listActiveEpisodesForAgent = (...args: Parameters<RuntimeRepository['listActiveEpisodesForAgent']>) =>
    this.#runtime.listActiveEpisodesForAgent(...args)
  readonly retireDshSessionEpisodes = (closedAt: number) => this.#runtime.retireDshSessionEpisodes(closedAt)
  readonly getEpisodeHandoffTo = (...args: Parameters<RuntimeRepository['getEpisodeHandoffTo']>) =>
    this.#runtime.getEpisodeHandoffTo(...args)
  readonly createEpisode = (...args: Parameters<RuntimeRepository['createEpisode']>) =>
    this.#runtime.createEpisode(...args)
  readonly activateEpisode = (...args: Parameters<RuntimeRepository['activateEpisode']>) =>
    this.#runtime.activateEpisode(...args)
  readonly updateEpisodeRevision = (...args: Parameters<RuntimeRepository['updateEpisodeRevision']>) =>
    this.#runtime.updateEpisodeRevision(...args)
  readonly closeEpisode = (...args: Parameters<RuntimeRepository['closeEpisode']>) =>
    this.#runtime.closeEpisode(...args)
  readonly commitEpisodeRollover = (...args: Parameters<RuntimeRepository['commitEpisodeRollover']>) =>
    this.#runtime.commitEpisodeRollover(...args)
  readonly failEpisode = (...args: Parameters<RuntimeRepository['failEpisode']>) => this.#runtime.failEpisode(...args)
  readonly createAdmission = (...args: Parameters<RuntimeRepository['createAdmission']>) =>
    this.#runtime.createAdmission(...args)
  readonly listRecoverableAdmissions = (...args: Parameters<RuntimeRepository['listRecoverableAdmissions']>) =>
    this.#runtime.listRecoverableAdmissions(...args)
  readonly listAdmittedEvents = (...args: Parameters<RuntimeRepository['listAdmittedEvents']>) =>
    this.#runtime.listAdmittedEvents(...args)
  readonly listUnadmittedEvents = (...args: Parameters<RuntimeRepository['listUnadmittedEvents']>) =>
    this.#runtime.listUnadmittedEvents(...args)
  readonly claimAdmission = (...args: Parameters<RuntimeRepository['claimAdmission']>) =>
    this.#runtime.claimAdmission(...args)
  readonly completeAdmission = (...args: Parameters<RuntimeRepository['completeAdmission']>) =>
    this.#runtime.completeAdmission(...args)

  readonly findOutboundByClientRequest = (...args: Parameters<RuntimeRepository['findOutboundByClientRequest']>) =>
    this.#outbox.findOutboundByClientRequest(...args)
  readonly findOutboundByLogicalMessageId = (
    ...args: Parameters<RuntimeRepository['findOutboundByLogicalMessageId']>
  ) => this.#outbox.findOutboundByLogicalMessageId(...args)
  readonly createOutboundPlan = (...args: Parameters<RuntimeRepository['createOutboundPlan']>) =>
    this.#outbox.createOutboundPlan(...args)
  readonly markIntentSending = (...args: Parameters<RuntimeRepository['markIntentSending']>) =>
    this.#outbox.markIntentSending(...args)
  readonly markDeliverySending = (...args: Parameters<RuntimeRepository['markDeliverySending']>) =>
    this.#outbox.markDeliverySending(...args)
  readonly recordDeliveryReceipt = (...args: Parameters<RuntimeRepository['recordDeliveryReceipt']>) =>
    this.#outbox.recordDeliveryReceipt(...args)
  readonly completeOutboundIntent = (...args: Parameters<RuntimeRepository['completeOutboundIntent']>) =>
    this.#outbox.completeOutboundIntent(...args)
  readonly getOutbound = (...args: Parameters<RuntimeRepository['getOutbound']>) => this.#outbox.getOutbound(...args)
  readonly listUnsettledOutboundIds = (...args: Parameters<RuntimeRepository['listUnsettledOutboundIds']>) =>
    this.#outbox.listUnsettledOutboundIds(...args)
  readonly listChannelHistory = (...args: Parameters<ChannelHistoryRepository['listChannelHistory']>) =>
    this.#outbox.listChannelHistory(...args)
  readonly getChannelHistoryEntryByLogicalMessageId = (
    ...args: Parameters<ChannelHistoryRepository['getChannelHistoryEntryByLogicalMessageId']>
  ) => this.#outbox.getChannelHistoryEntryByLogicalMessageId(...args)
  readonly listEpisodeHistory = (...args: Parameters<ChannelHistoryRepository['listEpisodeHistory']>) =>
    this.#outbox.listEpisodeHistory(...args)
  readonly searchChannelHistory = (...args: Parameters<ChannelHistoryRepository['searchChannelHistory']>) =>
    this.#outbox.searchChannelHistory(...args)

  readonly load = (...args: Parameters<AdapterRuntimeStateStore['load']>) => this.#runtime.load(...args)
  readonly save = (...args: Parameters<AdapterRuntimeStateStore['save']>) => this.#runtime.save(...args)
  readonly clear = (...args: Parameters<AdapterRuntimeStateStore['clear']>) => this.#runtime.clear(...args)

  readonly listExtensions = (...args: Parameters<ExtensionRepository['listExtensions']>) =>
    this.#extensions.listExtensions(...args)
  readonly getExtension = (...args: Parameters<ExtensionRepository['getExtension']>) =>
    this.#extensions.getExtension(...args)
  readonly getExtensionBySlug = (...args: Parameters<ExtensionRepository['getExtensionBySlug']>) =>
    this.#extensions.getExtensionBySlug(...args)
  readonly listExtensionRevisions = (...args: Parameters<ExtensionRepository['listExtensionRevisions']>) =>
    this.#extensions.listExtensionRevisions(...args)
  readonly getExtensionRevision = (...args: Parameters<ExtensionRepository['getExtensionRevision']>) =>
    this.#extensions.getExtensionRevision(...args)
  readonly getExtensionRevisionByPayloadDigest = (
    ...args: Parameters<ExtensionRepository['getExtensionRevisionByPayloadDigest']>
  ) => this.#extensions.getExtensionRevisionByPayloadDigest(...args)
  readonly nextExtensionRevisionNumber = (...args: Parameters<ExtensionRepository['nextExtensionRevisionNumber']>) =>
    this.#extensions.nextExtensionRevisionNumber(...args)
  readonly saveExtensionRevision = (...args: Parameters<ExtensionRepository['saveExtensionRevision']>) =>
    this.#extensions.saveExtensionRevision(...args)
  readonly deleteExtension = (...args: Parameters<ExtensionRepository['deleteExtension']>) =>
    this.#extensions.deleteExtension(...args)
  readonly getExtensionRevisionVerification = (
    ...args: Parameters<ExtensionRepository['getExtensionRevisionVerification']>
  ) => this.#extensions.getExtensionRevisionVerification(...args)
  readonly getExtensionClientDiagnostic = (...args: Parameters<ExtensionRepository['getExtensionClientDiagnostic']>) =>
    this.#extensions.getExtensionClientDiagnostic(...args)
  readonly upsertExtensionClientDiagnostic = (
    ...args: Parameters<ExtensionRepository['upsertExtensionClientDiagnostic']>
  ) => this.#extensions.upsertExtensionClientDiagnostic(...args)
  readonly getActivation = (...args: Parameters<ExtensionRepository['getActivation']>) =>
    this.#extensions.getActivation(...args)
  readonly listActivations = (...args: Parameters<ExtensionRepository['listActivations']>) =>
    this.#extensions.listActivations(...args)
  readonly upsertActivation = (...args: Parameters<ExtensionRepository['upsertActivation']>) =>
    this.#extensions.upsertActivation(...args)
  readonly deleteActivation = (...args: Parameters<ExtensionRepository['deleteActivation']>) =>
    this.#extensions.deleteActivation(...args)
  readonly getHostInstallation = (...args: Parameters<ExtensionRepository['getHostInstallation']>) =>
    this.#extensions.getHostInstallation(...args)
  readonly listHostInstallations = (...args: Parameters<ExtensionRepository['listHostInstallations']>) =>
    this.#extensions.listHostInstallations(...args)
  readonly upsertHostInstallation = (...args: Parameters<ExtensionRepository['upsertHostInstallation']>) =>
    this.#extensions.upsertHostInstallation(...args)
  readonly deleteHostInstallation = (...args: Parameters<ExtensionRepository['deleteHostInstallation']>) =>
    this.#extensions.deleteHostInstallation(...args)
  readonly commitHostInstallationState = (...args: Parameters<HostUiRepository['commitHostInstallationState']>) =>
    this.#extensions.commitHostInstallationState(...args)
  readonly deleteHostInstallationState = (...args: Parameters<HostUiRepository['deleteHostInstallationState']>) =>
    this.#extensions.deleteHostInstallationState(...args)
  readonly listHostUiPageEntries = (...args: Parameters<HostUiRepository['listHostUiPageEntries']>) =>
    this.#extensions.listHostUiPageEntries(...args)
  readonly replaceHostUiExtensionPages = (...args: Parameters<HostUiRepository['replaceHostUiExtensionPages']>) =>
    this.#extensions.replaceHostUiExtensionPages(...args)
  readonly deleteHostUiExtensionPages = (...args: Parameters<HostUiRepository['deleteHostUiExtensionPages']>) =>
    this.#extensions.deleteHostUiExtensionPages(...args)
  readonly replaceHostUiDshPages = (...args: Parameters<HostUiRepository['replaceHostUiDshPages']>) =>
    this.#extensions.replaceHostUiDshPages(...args)
  readonly deleteHostUiDshPages = (...args: Parameters<HostUiRepository['deleteHostUiDshPages']>) =>
    this.#extensions.deleteHostUiDshPages(...args)
  readonly getHostUiPreferencesRevision = (...args: Parameters<HostUiRepository['getHostUiPreferencesRevision']>) =>
    this.#extensions.getHostUiPreferencesRevision(...args)
  readonly updateHostUiPagePreferences = (...args: Parameters<HostUiRepository['updateHostUiPagePreferences']>) =>
    this.#extensions.updateHostUiPagePreferences(...args)
  readonly getHostUiPermissionGrant = (...args: Parameters<HostUiRepository['getHostUiPermissionGrant']>) =>
    this.#extensions.getHostUiPermissionGrant(...args)
  readonly upsertHostUiPermissionGrant = (...args: Parameters<HostUiRepository['upsertHostUiPermissionGrant']>) =>
    this.#extensions.upsertHostUiPermissionGrant(...args)
  readonly deleteHostUiPermissionGrant = (...args: Parameters<HostUiRepository['deleteHostUiPermissionGrant']>) =>
    this.#extensions.deleteHostUiPermissionGrant(...args)
  readonly getHostUiDiagnostic = (...args: Parameters<HostUiRepository['getHostUiDiagnostic']>) =>
    this.#extensions.getHostUiDiagnostic(...args)
  readonly upsertHostUiDiagnostic = (...args: Parameters<HostUiRepository['upsertHostUiDiagnostic']>) =>
    this.#extensions.upsertHostUiDiagnostic(...args)
  readonly deleteHostUiDiagnosticsForExtension = (
    ...args: Parameters<HostUiRepository['deleteHostUiDiagnosticsForExtension']>
  ) => this.#extensions.deleteHostUiDiagnosticsForExtension(...args)

  readonly listDshPluginPackages = (...args: Parameters<DshPluginRepository['listDshPluginPackages']>) =>
    this.#dshPlugins.listDshPluginPackages(...args)
  readonly getDshPluginPackage = (...args: Parameters<DshPluginRepository['getDshPluginPackage']>) =>
    this.#dshPlugins.getDshPluginPackage(...args)
  readonly getDshPluginPackageByIdentity = (
    ...args: Parameters<DshPluginRepository['getDshPluginPackageByIdentity']>
  ) => this.#dshPlugins.getDshPluginPackageByIdentity(...args)
  readonly saveDshPluginPackage = (...args: Parameters<DshPluginRepository['saveDshPluginPackage']>) =>
    this.#dshPlugins.saveDshPluginPackage(...args)
  readonly deleteDshPluginPackage = (...args: Parameters<DshPluginRepository['deleteDshPluginPackage']>) =>
    this.#dshPlugins.deleteDshPluginPackage(...args)
  readonly listDshPluginEntries = (...args: Parameters<DshPluginRepository['listDshPluginEntries']>) =>
    this.#dshPlugins.listDshPluginEntries(...args)
  readonly getDshPluginEntry = (...args: Parameters<DshPluginRepository['getDshPluginEntry']>) =>
    this.#dshPlugins.getDshPluginEntry(...args)
  readonly updateDshPluginEntry = (...args: Parameters<DshPluginRepository['updateDshPluginEntry']>) =>
    this.#dshPlugins.updateDshPluginEntry(...args)
  readonly listDshPluginActivations = (...args: Parameters<DshPluginRepository['listDshPluginActivations']>) =>
    this.#dshPlugins.listDshPluginActivations(...args)
  readonly upsertDshPluginActivation = (...args: Parameters<DshPluginRepository['upsertDshPluginActivation']>) =>
    this.#dshPlugins.upsertDshPluginActivation(...args)
  readonly deleteDshPluginActivation = (...args: Parameters<DshPluginRepository['deleteDshPluginActivation']>) =>
    this.#dshPlugins.deleteDshPluginActivation(...args)
  readonly commitDshPluginActivationState = (
    ...args: Parameters<DshPluginRepository['commitDshPluginActivationState']>
  ) => this.#dshPlugins.commitDshPluginActivationState(...args)
  readonly deleteDshPluginActivationState = (
    ...args: Parameters<DshPluginRepository['deleteDshPluginActivationState']>
  ) => this.#dshPlugins.deleteDshPluginActivationState(...args)
  readonly getDshPluginDiagnostic = (...args: Parameters<DshPluginRepository['getDshPluginDiagnostic']>) =>
    this.#dshPlugins.getDshPluginDiagnostic(...args)
  readonly upsertDshPluginDiagnostic = (...args: Parameters<DshPluginRepository['upsertDshPluginDiagnostic']>) =>
    this.#dshPlugins.upsertDshPluginDiagnostic(...args)

  readonly ensureAsset = (...args: Parameters<AssetAccessRepository['ensureAsset']>) =>
    this.#assets.ensureAsset(...args)
  readonly grantAssetAccess = (...args: Parameters<AssetAccessRepository['grantAssetAccess']>) =>
    this.#assets.grantAssetAccess(...args)
  readonly getAssetById = (...args: Parameters<ReturnType<typeof createAssetsRepository>['getAssetById']>) =>
    this.#assets.getAssetById(...args)
  readonly canAccessAsset = (...args: Parameters<ReturnType<typeof createAssetsRepository>['canAccessAsset']>) =>
    this.#assets.canAccessAsset(...args)
}
