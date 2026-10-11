import { homedir } from 'node:os'
import {
  agentPermissionDeclaration,
  hostPermissionDeclaration,
  summarizeExtensionCapabilities,
  type CommunityFeedbackDiagnostics,
} from '@nekro-nxt/contracts'
import type { AgentCapabilityGrants } from '@nekro-nxt/core'
import type { NekroRuntime } from './bootstrap.js'
import type { FeedbackSources } from './community-feedback.js'
import { DEEPSEEK_HARNESS_VERSION } from './dsh-version.js'
import { PRODUCT_VERSION } from './product-version.js'
import { releaseIdentity } from './product-updates.js'

const accessLevel = (capabilities: AgentCapabilityGrants): string => {
  const { fileTools, developmentShell, unrestrictedFileAccess } = capabilities
  if (!fileTools && !developmentShell && !unrestrictedFileAccess) return '基础权限'
  if (fileTools && !developmentShell && !unrestrictedFileAccess) return '工作区读写'
  if (fileTools && developmentShell && !unrestrictedFileAccess) return '运行命令'
  if (fileTools && developmentShell && unrestrictedFileAccess) return '完整访问'
  return '自定义'
}

export interface FeedbackEnvironment {
  readonly hostKind: 'desktop' | 'server'
  readonly releaseId: string
}

export const runtimeFeedbackSources = (runtime: NekroRuntime, environment: FeedbackEnvironment): FeedbackSources => ({
  redaction: (channelId) => {
    const connections = runtime.core.listConnections()
    return {
      homeDirectory: homedir(),
      dataDirectory: runtime.dataRoot,
      members: runtime.repository.listPlatformUsers().map((user) => {
        const identity = runtime.repository.getPlatformIdentity(user.identityId)
        const member = channelId ? runtime.repository.getChannelMemberByIdentity(channelId, user.identityId) : undefined
        return {
          key: user.identityId,
          aliases: [
            user.displayName,
            identity?.platformUserId,
            identity?.displayName,
            member?.id,
            member?.displayName,
          ].filter((value): value is string => Boolean(value)),
        }
      }),
      channels: connections.flatMap((connection) =>
        runtime.core.listChannelsByConnection(connection.id).map((channel) => ({
          key: channel.id,
          aliases: [channel.platformChannelId, channel.displayName].filter((value): value is string => Boolean(value)),
        })),
      ),
      accounts: connections.map((connection) => ({
        key: connection.id,
        aliases: [
          connection.alias,
          connection.accountKey,
          runtime.repository.getAccountIdentity(connection.id)?.platformUserId,
        ].filter((value): value is string => Boolean(value)),
      })),
    }
  },
  diagnostics: (agentId) => {
    const agent = agentId ? runtime.repository.getAgent(agentId) : undefined
    const grants = agent?.revision.capabilities
    const mounts = [
      ...runtime.repository
        .listHostInstallations()
        .map((installation) => ({ ...installation, activation: 'host' as const })),
      ...runtime.repository
        .listActivations(agentId ?? undefined)
        .map((activation) => ({ ...activation, activation: 'agent' as const })),
    ]
    const extensions = mounts.flatMap((mount) => {
      const revision = runtime.repository.getExtensionRevision(mount.extensionRevisionId)
      if (!revision) return []
      const manifest = runtime.extensionService.revisionManifest(revision)
      const declaration = manifest
        ? mount.activation === 'host'
          ? hostPermissionDeclaration(manifest.permissions)
          : agentPermissionDeclaration(manifest.permissions)
        : undefined
      const risks = summarizeExtensionCapabilities(declaration?.capabilities, { layer: mount.activation }).map(
        (item) => item.risk,
      )
      return [
        {
          extensionId: mount.extensionId,
          version: String(revision.revisionNumber),
          activation: mount.activation,
          accessLevel: risks.includes('high')
            ? 'high'
            : risks.includes('sensitive') || declaration?.permissions.length
              ? 'sensitive'
              : 'normal',
        },
      ]
    })
    const entries: NonNullable<CommunityFeedbackDiagnostics['entries']> = [
      ...[...runtime.host.compatibilityDiagnostics(), ...runtime.compatibility.listCurrent()].flatMap((diagnostic) =>
        diagnostic.reason
          ? [
              {
                kind: 'compatibility' as const,
                summary: diagnostic.reason,
                ...(diagnostic.objectKind === 'extension' ? { extensionId: diagnostic.objectId } : {}),
              },
            ]
          : [],
      ),
      ...runtime.core.listConnections().flatMap((connection) => {
        const diagnostic = runtime.adapterConnectionDiagnostic(connection.id)
        return diagnostic?.message && ['failed', 'reconnecting'].includes(diagnostic.status)
          ? [{ kind: 'connection' as const, summary: diagnostic.message }]
          : []
      }),
      ...runtime.repository.listExtensions().flatMap((extension) => {
        const host = runtime.hostClientDiagnostic(extension.id)
        const client = agentId ? runtime.repository.getExtensionClientDiagnostic(agentId, extension.id) : undefined
        return [host, client].flatMap((diagnostic) =>
          diagnostic?.status === 'failed' && diagnostic.message
            ? [{ kind: 'extension' as const, extensionId: extension.id, summary: diagnostic.message }]
            : [],
        )
      }),
    ].slice(-32)
    return {
      nxtVersion: PRODUCT_VERSION,
      releaseChannel: releaseIdentity(environment.releaseId).channel,
      hostKind: environment.hostKind,
      platform: process.platform,
      arch: process.arch,
      dshVersion: DEEPSEEK_HARNESS_VERSION,
      adapters: [...new Set(runtime.core.listConnections().map((connection) => connection.adapterKey))],
      extensions: [
        ...new Map(
          extensions.map((extension) => [
            JSON.stringify([extension.extensionId, extension.version, extension.activation]),
            extension,
          ]),
        ).values(),
      ],
      entries,
      ...(grants
        ? {
            agent: {
              accessLevel: accessLevel(grants),
              subagents: grants.subagents,
              fileTools: grants.fileTools,
              webSearch: grants.webSearch,
              dynamicCreation: grants.dynamicCreation,
              developmentShell: grants.developmentShell,
              unrestrictedFileAccess: grants.unrestrictedFileAccess,
              scheduledTasks: grants.scheduledTasks,
              codeRun: grants.codeRun,
              commandNetwork: grants.commandNetwork,
              communityFeedbackAuto: false,
            },
          }
        : {}),
    }
  },
})
