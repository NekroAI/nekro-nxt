import { HostApiContracts, ExtensionIdSchema, AuthoringTaskIdSchema, type ExtensionId } from '@nekro-nxt/contracts'
import { FULL_DATA_SCOPE } from '@nekro-nxt/extension-runtime'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { NekroRuntime } from './bootstrap.js'
import { lineageGraph } from './extension-governance/versions.js'
import { ExtensionConfigMigration } from './extension-governance/config-migration.js'
import { maskExtensionSecrets } from './extension-secret-config.js'
import { activationManifest, projectExtensionRequests } from './host-queries.js'
import {
  readBinaryBody,
  readJsonBody,
  writeContractJson,
  writeError,
  type HostRouteContext,
} from './host-route-support.js'

const DATA_PACKAGE_MAX_BYTES = 512 * 1024 * 1024

const failure = (res: ServerResponse, code: string, error: unknown): void =>
  writeError(res, 400, code, error instanceof Error ? error.message : String(error))

/**
 * `/api/extensions/:id/(lineage|branch|revert|data…)`. The extensions prefix route hands these over first; the
 * return value says whether this function answered.
 */
export async function handleGovernanceExtensionRoute(
  context: Pick<HostRouteContext, 'runtime' | 'broadcastExtensionsChanged'>,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const { runtime, broadcastExtensionsChanged } = context
  const versions = /^\/api\/extensions\/([^/]+)\/config-versions(?:\/([^/]+)\/revert)?$/u.exec(url.pathname)
  if (versions) {
    try {
      if (versions[2] === undefined) {
        if (req.method !== 'GET') {
          writeError(res, 405, 'method-not-allowed', 'Method not allowed.')
          return true
        }
        const params = HostApiContracts.getExtensionConfigVersions.parseParams({
          extensionId: decodeURIComponent(versions[1] ?? ''),
        })
        writeContractJson(res, 200, HostApiContracts.getExtensionConfigVersions, {
          versions: runtime.extensionConfig
            .versions({ extensionId: params.extensionId })
            .map((record) => runtime.extensionConfig.view(record)),
        })
        return true
      }
      if (req.method !== 'POST') {
        writeError(res, 405, 'method-not-allowed', 'Method not allowed.')
        return true
      }
      const params = HostApiContracts.revertExtensionConfig.parseParams({
        extensionId: decodeURIComponent(versions[1] ?? ''),
        versionId: decodeURIComponent(versions[2]),
      })
      const input = HostApiContracts.revertExtensionConfig.parseRequest(await readJsonBody(req))
      const versionId = Number(params.versionId)
      if (runtime.extensionConfig.version(versionId).extensionId !== params.extensionId) {
        throw new Error('没有这个配置版本。')
      }
      const version = await runtime.extensionConfig.revert(versionId, {
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      })
      writeContractJson(res, 200, HostApiContracts.revertExtensionConfig, { version })
      broadcastExtensionsChanged()
    } catch (error) {
      failure(res, 'extension-config-version-failed', error)
    }
    return true
  }
  const match =
    /^\/api\/extensions\/([^/]+)\/(lineage|branch|revert|data|data\/preview|data\/migrate|data\/snapshots|data\/export|data\/export-config)$/u.exec(
      url.pathname,
    )
  if (!match) return false
  let extensionId: ExtensionId
  try {
    extensionId = ExtensionIdSchema.parse(decodeURIComponent(match[1] ?? ''))
    if (!runtime.repository.getExtension(extensionId)) throw new Error('扩展不存在。')
  } catch (error) {
    failure(res, 'invalid-extension', error)
    return true
  }
  const route = match[2]
  try {
    if (route === 'lineage' && req.method === 'GET') {
      writeContractJson(res, 200, HostApiContracts.getExtensionLineage, {
        lines: lineageGraph(runtime.repository, runtime.extensionService, extensionId).map((line) => ({
          ...line,
          nodes: [...line.nodes],
        })),
      })
      return true
    }
    if (route === 'branch' && req.method === 'POST') {
      const input = HostApiContracts.branchExtension.parseRequest(await readJsonBody(req))
      const result = await runtime.extensionActions.perform(
        {
          kind: 'branch',
          revisionId: input.revisionId,
          name: input.name,
          ...(input.slug === undefined ? {} : { slug: input.slug }),
          copyData: input.copyData,
        },
        { kind: 'console' },
      )
      writeContractJson(res, 200, HostApiContracts.branchExtension, {
        extensionId: result.extensionId!,
        revisionId: result.revisionId!,
      })
      broadcastExtensionsChanged()
      return true
    }
    if (route === 'revert' && req.method === 'POST') {
      const result = await runtime.extensionActions.perform({ kind: 'revert', extensionId }, { kind: 'console' })
      writeContractJson(res, 200, HostApiContracts.rollbackExtension, { message: result.message })
      broadcastExtensionsChanged()
      return true
    }
    if (route === 'data' && req.method === 'GET') {
      const dataset = runtime.repository.readExtensionDataset(extensionId, FULL_DATA_SCOPE)
      writeContractJson(res, 200, HostApiContracts.getExtensionData, {
        dataVersion: runtime.extensionData.dataVersion(extensionId),
        counts: { storage: dataset.storage.length, index: dataset.index.length, library: dataset.library.length },
        snapshots: runtime.extensionData.listSnapshots(extensionId).map((snapshot) => ({
          id: snapshot.id,
          reason: snapshot.reason,
          label: snapshot.label,
          dataVersion: snapshot.dataVersion,
          byteSize: snapshot.byteSize,
          createdAt: snapshot.createdAt,
        })),
      })
      return true
    }
    if ((route === 'data/preview' || route === 'data/migrate') && req.method === 'POST') {
      const input = HostApiContracts.migrateExtensionData.parseRequest(await readJsonBody(req))
      const plan = {
        source: input.source,
        targetExtensionId: extensionId,
        mode: input.mode,
        scope: FULL_DATA_SCOPE,
        ...(input.agentMap === undefined ? {} : { agentMap: input.agentMap }),
      }
      const configPlan = {
        source: input.source,
        targetExtensionId: extensionId,
        mode: input.mode,
        ...(input.agentMap === undefined ? {} : { agentMap: input.agentMap }),
      }
      const configMigration = new ExtensionConfigMigration(runtime)
      if (route === 'data/preview') {
        writeContractJson(res, 200, HostApiContracts.previewExtensionDataMigration, {
          ...runtime.extensionData.preview(plan),
          ...(input.includeConfig === true ? { config: configMigration.preview(configPlan) } : {}),
        })
        return true
      }
      const result = await runtime.extensions.withStopped(extensionId, () => runtime.extensionData.migrate(plan))
      const config = input.includeConfig === true ? await configMigration.apply(configPlan) : undefined
      if (input.source.kind === 'package') runtime.extensionData.discardPackage(input.source.token)
      writeContractJson(res, 200, HostApiContracts.migrateExtensionData, {
        ...result,
        preview: { ...result.preview, ...(config === undefined ? {} : { config }) },
      })
      broadcastExtensionsChanged()
      return true
    }
    if (route === 'data/snapshots' && req.method === 'POST') {
      const input = HostApiContracts.createExtensionDataSnapshot.parseRequest(await readJsonBody(req))
      writeContractJson(res, 200, HostApiContracts.createExtensionDataSnapshot, {
        snapshotId: runtime.extensionData.takeSnapshot(extensionId, 'manual', input.label),
      })
      return true
    }
    if ((route === 'data/export' || route === 'data/export-config') && req.method === 'GET') {
      const extension = runtime.repository.getExtension(extensionId)!
      const withConfig = route === 'data/export-config'
      const installation = runtime.repository.getHostInstallation(extensionId)
      const body = await runtime.extensionData.exportPackage({
        extensionId,
        displayName: extension.displayName,
        scope: FULL_DATA_SCOPE,
        ...(withConfig
          ? {
              config: {
                ...(installation === undefined
                  ? {}
                  : {
                      host: maskExtensionSecrets(
                        activationManifest(runtime, installation.extensionRevisionId),
                        'host',
                        installation.config,
                      ).config,
                    }),
                agents: Object.fromEntries(
                  runtime.repository
                    .listActivations()
                    .filter((activation) => activation.extensionId === extensionId)
                    .map((activation) => [
                      activation.agentId,
                      maskExtensionSecrets(
                        activationManifest(runtime, activation.extensionRevisionId),
                        'agent',
                        activation.config,
                      ).config,
                    ]),
                ),
              },
            }
          : {}),
      })
      res.writeHead(200, {
        'content-type': 'application/vnd.nekro-nxt.extension-data+zip',
        'content-disposition': `attachment; filename="${extension.slug}-data.nxt-extension-data"`,
        'cache-control': 'no-store',
      })
      res.end(Buffer.from(body))
      return true
    }
    writeError(res, 405, 'method-not-allowed', 'Method not allowed.')
  } catch (error) {
    failure(res, 'extension-governance-failed', error)
  }
  return true
}

/** `/api/authoring/tasks/:id/archive`; the authoring prefix route hands it over first. */
export function handleGovernanceAuthoringRoute(
  runtime: NekroRuntime,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): boolean {
  const match = /^\/api\/authoring\/tasks\/([^/]+)\/archive$/u.exec(url.pathname)
  if (!match) return false
  try {
    if (req.method !== 'POST') throw new Error('Method not allowed.')
    const taskId = AuthoringTaskIdSchema.parse(decodeURIComponent(match[1] ?? ''))
    const task = runtime.repository.getAuthoringTask(taskId)
    if (!task) throw new Error('创造任务不存在。')
    if (!['paused', 'interrupted', 'failed'].includes(task.status)) {
      throw new Error('只有暂停、中断或失败的任务可以归档；进行中的任务请先停止。')
    }
    runtime.host.authoringService()?.archiveTask(task, '已归档。')
    writeContractJson(res, 200, HostApiContracts.archiveAuthoringTask, { ok: true })
  } catch (error) {
    failure(res, 'authoring-task-archive-failed', error)
  }
  return true
}

/** Requests, administrators, data packages and community sync actions. */
export function registerGovernanceRoutes(context: HostRouteContext): () => void {
  const { runtime, registerRoute, broadcast, broadcastExtensionsChanged } = context
  runtime.publishExtensionRequestChange = () => broadcast({ event: 'snapshot-changed', data: { changed: true } })
  runtime.publishExtensionsChange = broadcastExtensionsChanged
  const expiry = setInterval(() => runtime.extensionRequests.expire(), 60_000)
  expiry.unref()

  registerRoute({
    kind: 'prefix',
    path: '/api/extension-requests',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      try {
        if (url.pathname === '/api/extension-requests' && req.method === 'GET') {
          writeContractJson(res, 200, HostApiContracts.listExtensionRequests, {
            requests: projectExtensionRequests(runtime),
          })
          return
        }
        const match = /^\/api\/extension-requests\/(\d+)\/(approve|reject)$/u.exec(url.pathname)
        if (!match || req.method !== 'POST') {
          writeError(res, 404, 'not-found', 'Unknown route.')
          return
        }
        const number = Number(match[1])
        if (match[2] === 'approve') {
          const result = await runtime.extensionRequests.approve(number, { kind: 'console' })
          writeContractJson(res, 200, HostApiContracts.approveExtensionRequest, { message: result.message })
          broadcastExtensionsChanged()
          return
        }
        const input = HostApiContracts.rejectExtensionRequest.parseRequest(await readJsonBody(req))
        runtime.extensionRequests.reject(number, { kind: 'console' }, input.reason)
        writeContractJson(res, 200, HostApiContracts.rejectExtensionRequest, { ok: true })
      } catch (error) {
        failure(res, 'extension-request-failed', error)
      }
    },
  })

  registerRoute({
    kind: 'prefix',
    path: '/api/administrators',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      try {
        if (url.pathname === '/api/administrators' && req.method === 'GET') {
          writeContractJson(res, 200, HostApiContracts.listAdministrators, {
            administrators: [...runtime.administrators.list()],
          })
          return
        }
        if (url.pathname === '/api/administrators' && req.method === 'POST') {
          const input = HostApiContracts.addAdministrator.parseRequest(await readJsonBody(req))
          writeContractJson(res, 200, HostApiContracts.addAdministrator, runtime.administrators.add(input.identityId))
          broadcast({ event: 'snapshot-changed', data: { changed: true } })
          return
        }
        if (url.pathname === '/api/administrators/remove' && req.method === 'POST') {
          const input = HostApiContracts.removeAdministrator.parseRequest(await readJsonBody(req))
          runtime.administrators.remove(input.connectionId, input.platformUserId)
          writeContractJson(res, 200, HostApiContracts.removeAdministrator, { ok: true })
          broadcast({ event: 'snapshot-changed', data: { changed: true } })
          return
        }
        if (url.pathname === '/api/administrators/claim-code' && req.method === 'POST') {
          writeContractJson(
            res,
            200,
            HostApiContracts.createAdministratorClaimCode,
            runtime.administrators.createClaimCode(),
          )
          return
        }
        writeError(res, 404, 'not-found', 'Unknown route.')
      } catch (error) {
        failure(res, 'administrators-failed', error)
      }
    },
  })

  registerRoute({
    kind: 'exact',
    path: '/api/extensions/data/inspect',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        writeError(res, 405, 'method-not-allowed', 'Method not allowed.')
        return
      }
      try {
        const inspected = await runtime.extensionData.inspectPackage(await readBinaryBody(req, DATA_PACKAGE_MAX_BYTES))
        writeContractJson(res, 200, HostApiContracts.inspectExtensionDataPackage, {
          token: inspected.token,
          extensionId: inspected.manifest.extensionId,
          displayName: inspected.manifest.displayName,
          dataVersion: inspected.manifest.dataVersion,
          exportedAt: inspected.manifest.exportedAt,
          agents: inspected.manifest.agents,
          counts: inspected.counts,
        })
      } catch (error) {
        failure(res, 'extension-data-inspect-failed', error)
      }
    },
  })

  registerRoute({
    kind: 'prefix',
    path: '/api/community/sync',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const match = /^\/api\/community\/sync\/([^/]+)\/(dismiss|update)$/u.exec(url.pathname)
      if (!match || req.method !== 'POST') {
        writeError(res, 404, 'not-found', 'Unknown route.')
        return
      }
      try {
        const extensionId = ExtensionIdSchema.parse(decodeURIComponent(match[1] ?? ''))
        if (match[2] === 'dismiss') {
          const input = HostApiContracts.dismissCommunityRelease.parseRequest(await readJsonBody(req))
          runtime.communitySync.dismiss(extensionId, input.releaseId)
          writeContractJson(res, 200, HostApiContracts.dismissCommunityRelease, { ok: true })
          return
        }
        const result = await runtime.extensionActions.perform(
          { kind: 'community-update', extensionId },
          { kind: 'console' },
        )
        writeContractJson(res, 200, HostApiContracts.updateFromCommunity, { message: result.message })
        broadcastExtensionsChanged()
      } catch (error) {
        failure(res, 'community-sync-failed', error)
      }
    },
  })

  return () => {
    clearInterval(expiry)
    runtime.publishExtensionRequestChange = undefined
    runtime.publishExtensionsChange = undefined
  }
}
