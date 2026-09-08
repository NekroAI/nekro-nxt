import type { HostApiResponse } from '@nekro-nxt/contracts'
import {
  HostApiContracts,
  type AgentId,
  type ChannelId,
  type ChannelRuntimeProjection,
  type HostSnapshotMessage,
} from '@nekro-nxt/contracts'
import { type DynamicAuthoringAttempt, type DynamicAuthoringTask } from '@nekro-nxt/extension-runtime'
import type { NekroRuntime } from './bootstrap.js'
import {
  emptyChannelRuntimeProjection,
  projectChannelRuntime,
  worstChannelRuntimePhase,
} from './channel-runtime-projection.js'
const groupBy = <T, Key>(values: readonly T[], keyOf: (value: T) => Key): Map<Key, T[]> => {
  const groups = new Map<Key, T[]>()
  for (const value of values) {
    const key = keyOf(value)
    const group = groups.get(key) ?? []
    group.push(value)
    groups.set(key, group)
  }
  return groups
}

export const assembleChannelRuntime = (
  runtime: NekroRuntime,
  channelId: ChannelId,
  facts?: { binding: ReturnType<NekroRuntime['core']['listBindings']>[number] | undefined },
): ChannelRuntimeProjection => {
  if (!facts && !runtime.repository.getChannel(channelId)) {
    throw new Error(`Unknown Channel: ${channelId}`)
  }
  const binding = facts ? facts.binding : runtime.core.listBindings(channelId)[0]
  if (!binding) return emptyChannelRuntimeProjection(channelId)
  const episode = runtime.repository.getActiveEpisode(channelId, binding.agentId)
  const pendingInjectCount = episode === undefined ? 0 : runtime.repository.listRecoverableAdmissions(episode.id).length
  const live = episode?.dshSessionId === undefined ? undefined : runtime.host.tryLiveSession(episode.dshSessionId)
  const metrics =
    episode?.dshSessionId === undefined ? undefined : runtime.host.sessionRuntimeMetrics(episode.dshSessionId)
  return projectChannelRuntime({
    channelId,
    agentId: binding.agentId,
    ...(episode === undefined ? {} : { episodeId: episode.id }),
    sessionStatus: live?.status ?? 'missing',
    pendingInjectCount,
    ...(metrics?.occupancy === undefined ? {} : { occupancy: metrics.occupancy }),
    ...(metrics?.performanceTotals === undefined ? {} : { performanceTotals: metrics.performanceTotals }),
    events:
      live === undefined || episode?.dshSessionId === undefined
        ? []
        : runtime.host.normalizedSessionEvents(episode.dshSessionId),
  })
}

export const projectExtensions = (runtime: NekroRuntime) => {
  const activationsByExtension = groupBy(runtime.repository.listActivations(), (item) => item.extensionId)
  const revisionsByExtension = groupBy(runtime.repository.listExtensionRevisions(), (item) => item.extensionId)
  const installations = new Map(runtime.repository.listHostInstallations().map((item) => [item.extensionId, item]))
  return runtime.repository.listExtensions().map((extension) => {
    const installation = installations.get(extension.id)
    const revisions = revisionsByExtension.get(extension.id) ?? []
    const activations = activationsByExtension.get(extension.id) ?? []
    const permissions = new Map(
      revisions.map((revision) => [
        revision.id,
        runtime.installation.getHostUiPermissionRequirement(extension.id, revision.id),
      ]),
    )
    const hostClientDiagnostic = runtime.hostClientDiagnostic(extension.id)
    const latestRevision = revisions.at(-1)
    const hostUiPermission = latestRevision === undefined ? undefined : permissions.get(latestRevision.id)
    return {
      id: extension.id,
      scope: extension.scope,
      slug: extension.slug,
      displayName: extension.displayName,
      description: extension.description,
      ...(extension.createdByAgentId === undefined ? {} : { createdByAgentId: extension.createdByAgentId }),
      revisions: revisions.map((revision) => {
        const verification = runtime.repository.getExtensionRevisionVerification(revision.id)
        const permissionRequirement = permissions.get(revision.id)
        return {
          id: revision.id,
          revisionNumber: revision.revisionNumber,
          format: runtime.extensionService.revisionFormat(revision),
          createdAt: revision.createdAt,
          scope: extension.scope,
          contributions:
            verification === undefined
              ? []
              : [
                  ...verification.toolInvocations.map(({ name }) => `工具：${name}`),
                  ...verification.rpcMethods.map((method) => `RPC：${method}`),
                  ...verification.renderedSlots.map((slot) => `界面：${slot}`),
                  ...(verification.adapter === undefined ? [] : [`适配器：${verification.adapter.key}`]),
                  ...(verification.renderedHostSlots ?? []).map(({ key }) => `界面：${key}`),
                  ...(verification.renderedPages ?? []).map(({ title }) => `页面：${title}`),
                ],
          ...(verification === undefined
            ? {}
            : {
                verification: {
                  verifiedAt: verification.verifiedAt,
                  dshVersion: verification.dshVersion,
                  contractVersion: verification.contractVersion,
                  hostBuilt: verification.hostBuild.built,
                  clientBuilt: verification.clientBuild.built,
                  buildKey: runtime.extensionService.currentBuildKey(revision),
                  toolInvocationCount: verification.toolInvocations.length,
                  rpcMethods: verification.rpcMethods,
                  renderedSlots: verification.renderedSlots,
                  ...(verification.renderedHostSlots === undefined
                    ? {}
                    : { renderedHostSlots: verification.renderedHostSlots }),
                  ...(verification.renderedPages === undefined ? {} : { renderedPages: verification.renderedPages }),
                  ...(verification.usedUiComponents === undefined
                    ? {}
                    : { usedUiComponents: verification.usedUiComponents }),
                  ...(verification.pageGeometry === undefined ? {} : { pageGeometry: verification.pageGeometry }),
                  ...(verification.permissions === undefined ? {} : { permissions: verification.permissions }),
                  ...(permissionRequirement === undefined
                    ? {}
                    : {
                        permissionDigest: permissionRequirement.permissionDigest,
                        permissionApprovalRequired: permissionRequirement.approvalRequired,
                      }),
                  ...(verification.adapter === undefined ? {} : { adapter: verification.adapter }),
                },
              }),
        }
      }),
      activations: activations.map((activation) => ({
        agentId: activation.agentId,
        extensionRevisionId: activation.extensionRevisionId,
        config: activation.config,
        activatedAt: activation.activatedAt,
        ...(runtime.activation.getDiagnostic(activation.agentId, extension.id) === undefined
          ? {}
          : { runtime: runtime.activation.getDiagnostic(activation.agentId, extension.id) }),
      })),
      ...(installation === undefined
        ? {}
        : {
            installation: {
              extensionRevisionId: installation.extensionRevisionId,
              installedAt: installation.installedAt,
              ...(runtime.installation.getDiagnostic(extension.id) === undefined
                ? {}
                : { runtime: runtime.installation.getDiagnostic(extension.id) }),
            },
          }),
      ...(hostUiPermission === undefined ? {} : { hostUiPermission }),
      ...(hostClientDiagnostic === undefined ? {} : { hostClientDiagnostic }),
      clientDiagnostics: activations.flatMap((activation) => {
        const diagnostic = runtime.repository.getExtensionClientDiagnostic(activation.agentId, extension.id)
        if (!diagnostic) return []
        return [
          {
            agentId: diagnostic.agentId,
            revisionId: diagnostic.revisionId,
            status: diagnostic.status,
            ...(diagnostic.message === undefined ? {} : { message: diagnostic.message }),
            observedAt: diagnostic.observedAt,
          },
        ]
      }),
    }
  })
}

export const projectDynamicInventory = (runtime: NekroRuntime, agentId: AgentId) =>
  runtime.repository.listActiveEpisodesForAgent(agentId).flatMap((episode) => {
    if (!episode.dshSessionId) return []
    try {
      const policy = runtime.host.dynamicAuthoringPolicy(episode.dshSessionId)
      return runtime.host.dynamicInventory(episode.dshSessionId).map((row) => ({
        agentId,
        episodeId: episode.id,
        pluginId: row.pluginId,
        ...(row.currentPackageId === undefined ? {} : { packageId: row.currentPackageId }),
        ...(row.currentPackageId === undefined ? {} : { currentPackageId: row.currentPackageId }),
        ...(row.nextPackageId === undefined ? {} : { nextPackageId: row.nextPackageId }),
        ...(row.latestRun?.approvalRequestId === undefined
          ? {}
          : { approvalRequestId: row.latestRun.approvalRequestId }),
        status: row.latestRun?.status ?? (row.activeRun ? 'running' : 'stopped'),
        ...(row.activeRun === undefined
          ? {}
          : {
              activeRun: {
                pluginRunId: row.activeRun.pluginRunId,
                packageId: row.activeRun.packageId,
              },
            }),
        ...(row.latestRun === undefined
          ? {}
          : {
              latestRun: {
                pluginRunId: row.latestRun.pluginRunId,
                packageId: row.latestRun.packageId,
                mode: row.latestRun.mode,
                status: row.latestRun.status,
                ...(row.latestRun.approvalRequestId === undefined
                  ? {}
                  : { approvalRequestId: row.latestRun.approvalRequestId }),
                ...(row.latestRun.requiresApproval === undefined
                  ? {}
                  : { requiresApproval: row.latestRun.requiresApproval }),
                host: row.latestRun.host,
                client: row.latestRun.client,
                ...(row.latestRun.error === undefined ? {} : { error: row.latestRun.error }),
              },
            }),
        packages: row.packages,
        policy: {
          turn: policy.turn,
          ...(policy.primaryPluginId === undefined ? {} : { primaryPluginId: policy.primaryPluginId }),
          consecutiveFailures: policy.consecutiveFailures,
          repeatedFingerprintCount: policy.repeatedFingerprintCount,
          ...(policy.lastErrorFingerprint === undefined ? {} : { lastErrorFingerprint: policy.lastErrorFingerprint }),
          ...(policy.blockedReason === undefined ? {} : { blockedReason: policy.blockedReason }),
        },
      }))
    } catch {
      return []
    }
  })

export const projectAuthoringAttempt = (attempt: DynamicAuthoringAttempt) => ({
  id: attempt.id,
  ordinal: attempt.ordinal,
  name: attempt.name,
  purpose: attempt.purpose,
  state: attempt.state,
  riskDigest: attempt.riskDigest,
  host: attempt.host,
  client: attempt.client,
  ...(attempt.error === undefined
    ? {}
    : {
        error: {
          phase: attempt.error.phase,
          message: attempt.error.message,
          repairable: attempt.error.repairable,
        },
      }),
  createdAt: attempt.createdAt,
  ...(attempt.settledAt === undefined ? {} : { settledAt: attempt.settledAt }),
})

export const projectAuthoringTask = (
  runtime: NekroRuntime,
  task: DynamicAuthoringTask,
  attempts: readonly DynamicAuthoringAttempt[] = runtime.repository.listAuthoringAttempts(task.id),
) => {
  const active = attempts.findLast((attempt) => attempt.state === 'active')
  const candidate = attempts.at(-1)
  return {
    id: task.id,
    agentId: task.agentId,
    channelId: task.channelId,
    episodeId: task.episodeId,
    title: task.title,
    requirementSummary: task.requirementSummary,
    status: task.status,
    approvalPolicy: task.approvalPolicy,
    ...(task.approvedRiskDigest === undefined ? {} : { approvedRiskDigest: task.approvedRiskDigest }),
    revision: task.revision,
    ...(active === undefined ? {} : { activeAttempt: projectAuthoringAttempt(active) }),
    ...(candidate === undefined ? {} : { candidateAttempt: projectAuthoringAttempt(candidate) }),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  }
}
export class HostQueries {
  readonly #runtime: NekroRuntime
  readonly #cursor: () => HostApiResponse<'snapshot'>['cursor']
  readonly #metadata: HostApiResponse<'snapshot'>['productMetadata']
  constructor(
    runtime: NekroRuntime,
    cursor: () => HostApiResponse<'snapshot'>['cursor'],
    metadata: HostApiResponse<'snapshot'>['productMetadata'],
  ) {
    this.#runtime = runtime
    this.#cursor = cursor
    this.#metadata = metadata
  }
  async snapshot(): Promise<HostApiResponse<'snapshot'>> {
    const runtime = this.#runtime,
      productMetadata = this.#metadata

    // Sample asynchronous auxiliary information before capturing synchronous facts.
    // Revision keys prevent diagnostics for an old revision attaching to a new one.
    const [diagnostics, webSearch, models, notificationSettings] = await Promise.all([
      Promise.all(
        runtime.core.listAgents().map(async (commit) => ({
          revisionId: commit.revision.id,
          value: await runtime.host.getAgentImageDiagnostics(commit.revision),
        })),
      ),
      runtime.host.getWebSearchCapabilityStatus(),
      runtime.host.listAvailableLlmModels(),
      runtime.notifications.getSettings(),
    ])
    const diagnosticsSampledAt = Date.now()
    const diagnosticsByRevision = new Map(diagnostics.map((item) => [item.revisionId, item.value]))
    // No await below: domain facts and the event cursor belong to one capture.
    // Enumerate channels durably from the Core repository so the snapshot
    // survives restart, then discover bound Agents via their Bindings.
    const connectionRecords = runtime.core.listConnections()
    const channelsByConnection = new Map(
      connectionRecords.map((connection) => [connection.id, runtime.core.listChannelsByConnection(connection.id)]),
    )
    const channels = [...channelsByConnection.values()].flat()
    const attemptsByTask = groupBy(runtime.repository.listAuthoringAttempts(), (attempt) => attempt.taskId)
    const bindingsByChannel = new Map(channels.map((channel) => [channel.id, runtime.core.listBindings(channel.id)]))
    const agentCommits = runtime.core.listAgents()
    const agentIds = new Set(agentCommits.map((commit) => commit.definition.id))
    const runtimeByChannel = new Map(
      channels.map(
        (channel) =>
          [
            channel.id,
            assembleChannelRuntime(runtime, channel.id, { binding: bindingsByChannel.get(channel.id)?.[0] }),
          ] as const,
      ),
    )
    const channelIdsByAgent = new Map<AgentId, ChannelId[]>()
    for (const [channelId, bindings] of bindingsByChannel)
      for (const binding of bindings) {
        const owned = channelIdsByAgent.get(binding.agentId) ?? []
        owned.push(channelId)
        channelIdsByAgent.set(binding.agentId, owned)
      }
    const agents = agentCommits.map((commit) => {
      const agentId = commit.definition.id
      const ownedChannels = channelIdsByAgent.get(agentId) ?? []
      const runtimePhase = worstChannelRuntimePhase(
        ownedChannels.map((channelId) => runtimeByChannel.get(channelId)?.phase ?? 'idle'),
      )
      return {
        id: agentId,
        displayName: commit.revision.displayName,
        persona: commit.revision.persona,
        personaDocument: commit.revision.personaDocument,
        model: commit.revision.model,
        capabilities: commit.revision.capabilities,
        imagePolicy: commit.revision.imagePolicy,
        dynamicClientApprovalPolicy: commit.revision.dynamicClientApprovalPolicy,
        ...(diagnosticsByRevision.has(commit.revision.id)
          ? { imageDiagnostics: diagnosticsByRevision.get(commit.revision.id) }
          : {}),
        currentRevisionId: commit.revision.id,
        runtimeStatus: runtimePhase === 'thinking' || runtimePhase === 'using-tool' ? 'running' : 'idle',
        runtimePhase,
        createdAt: commit.revision.createdAt,
        channels: ownedChannels,
      }
    })
    const channelProjection = channels.map((channel) => {
      const bindings = bindingsByChannel.get(channel.id) ?? []
      const boundAgentId = bindings[0]?.agentId
      return {
        id: channel.id,
        connectionId: channel.connectionId,
        platformChannelId: channel.platformChannelId,
        kind: channel.kind,
        ...(channel.displayName === undefined ? {} : { displayName: channel.displayName }),
        ...(boundAgentId === undefined ? {} : { boundAgentId }),
        runtimePhase: runtimeByChannel.get(channel.id)?.phase ?? 'idle',
        bindings: bindings.map((binding) => ({
          channelId: binding.channelId,
          agentId: binding.agentId,
          triggerPolicy: binding.triggerPolicy,
          processingFeedback: binding.processingFeedback,
          activityTriggerOverrides: binding.activityTriggerOverrides,
          boundAt: binding.boundAt,
        })),
      }
    })
    // Message history is loaded per Channel through its cursor endpoint. Keeping
    // it out of the global snapshot prevents every navigation from rereading
    // every Channel's history.
    const messages: HostSnapshotMessage[] = []
    const connections = connectionRecords.map((connection) => {
      const adapterDiagnostic = runtime.adapterConnectionDiagnostic(connection.id)
      const lastInbound = runtime.lastInbound(connection.id)
      const tests = runtime.connectionTests(connection.id)
      const capabilities = runtime.connectionCapabilities(connection.id)
      return {
        id: connection.id,
        adapterKey: connection.adapterKey,
        ...(connection.alias === undefined ? {} : { alias: connection.alias }),
        activityTriggerDefaults: connection.activityTriggerDefaults,
        status: {
          state: adapterDiagnostic?.status ?? 'stopped',
          credentialConfigured: adapterDiagnostic?.credentialConfigured ?? false,
          proactiveSend: adapterDiagnostic?.proactiveSend ?? false,
          activities: capabilities?.activities ?? {},
          ...(capabilities?.processingFeedback === undefined
            ? {}
            : { processingFeedback: capabilities.processingFeedback }),
          ...(adapterDiagnostic?.message === undefined ? {} : { message: adapterDiagnostic.message }),
          ...(adapterDiagnostic?.accountReference === undefined
            ? {}
            : { accountReference: adapterDiagnostic.accountReference }),
          ...(adapterDiagnostic?.implementation === undefined
            ? {}
            : { implementation: adapterDiagnostic.implementation }),
          ...(adapterDiagnostic?.optionalCapabilities === undefined
            ? {}
            : { optionalCapabilities: adapterDiagnostic.optionalCapabilities }),
        },
        channelCount: channelsByConnection.get(connection.id)?.length ?? 0,
        knownChannels: (channelsByConnection.get(connection.id) ?? []).map((channel) => ({
          id: channel.id,
          name:
            channel.displayName ??
            (channel.kind === 'group' ? '未命名群聊' : channel.kind === 'direct' ? '未命名私聊' : '未命名内置频道'),
          kind: channel.kind,
        })),
        ...(lastInbound?.platformMessageId === undefined
          ? {}
          : { lastInbound: { ...lastInbound, platformMessageId: lastInbound.platformMessageId } }),
        ...(tests?.receive === undefined ? {} : { receiveTest: tests.receive }),
        ...(tests?.send === undefined ? {} : { sendTest: tests.send }),
      }
    })
    const archivedConnections = runtime.core.listArchivedConnections().map((connection) => ({
      id: connection.id,
      adapterKey: connection.adapterKey,
      ...(connection.alias === undefined ? {} : { alias: connection.alias }),
      channelCount: runtime.repository.listChannelIdsByConnection(connection.id).length,
      archivedAt: connection.archivedAt,
    }))
    return HostApiContracts.snapshot.parseResponse({
      cursor: this.#cursor(),
      diagnosticsSampledAt,
      productMetadata,
      models,
      capabilityAvailability: {
        subagents: { available: true },
        webSearch,
      },
      connectionAdapters: runtime.listConnectionAdapters(),
      notificationSettings,
      agents,
      channels: channelProjection,
      messages,
      connections,
      archivedConnections,
      extensions: projectExtensions(runtime),
      hostUi: {
        preferencesRevision: runtime.repository.getHostUiPreferencesRevision(),
        pages: runtime.repository.listHostUiPageEntries().filter(({ owner }) => {
          if (owner.kind !== 'extension') return true
          const revision = runtime.repository.getExtensionRevision(owner.revisionId)
          return revision !== undefined && runtime.extensionService.revisionFormat(revision) === 'current'
        }),
      },
      workTreeOrder: runtime.repository.getWorkTreeOrder(),
      dynamic: [...agentIds].flatMap((agentId) => projectDynamicInventory(runtime, agentId)),
      authoringTasks: runtime.repository
        .listAuthoringTasks()
        .map((task) => projectAuthoringTask(runtime, task, attemptsByTask.get(task.id) ?? [])),
    })
  }
}
