import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'
import { type ChannelFact } from '@nekro-nxt/channel-runtime'
import {
  DshCredentialsChangedSseDataSchema,
  DshSettingsChangedSseDataSchema,
  HostApiContracts,
  type ChannelId,
  type HostSnapshotMessage,
  type HostSseEvent,
} from '@nekro-nxt/contracts'
import type { NekroRuntime } from './bootstrap.js'
import { DEEPSEEK_HARNESS_VERSION } from './dsh-version.js'
import { ExtensionImportStaging } from './extension-import-staging.js'
import { assembleChannelRuntime, HostQueries } from './host-queries.js'
import {
  projectChannelFact,
  projectConnectionEvent,
  readJsonBody,
  writeContractJson,
  writeError,
  writeJson,
} from './host-route-support.js'
import { ProductUpdates } from './product-updates.js'
import { readMessagePacing, writeMessagePacing, type MessagePacingSettingsStore } from './message-pacing.js'
import { registerAuthoringRoutes } from './host-routes-authoring.js'
import { registerScheduledTaskRoutes } from './host-routes-scheduled-tasks.js'
import { registerMcpRoutes } from './host-routes-mcp.js'
import { registerCommunityRoutes } from './host-routes-community.js'
import { registerConnectionsRoutes } from './host-routes-connections.js'
import { installedLibraryQuota, registerExtensionLibraryRoutes } from './host-routes-extension-library.js'
import { registerExtensionsRoutes } from './host-routes-extensions.js'
import { registerSettingsRoutes } from './host-routes-settings.js'
import { registerWorkspaceRoutes } from './host-routes-workspace.js'
import { PRODUCT_VERSION } from './product-version.js'
import { viewerKeyFromRequest } from './viewer.js'
import { WorkspaceProjections } from './workspace-projections.js'
import {
  HostSseHub,
  parseLastEventId,
  renderSse,
  SSE_FACT_COALESCE_MS,
  SSE_FACT_FRAME_BUDGET,
  SSE_RUNTIME_FRAME_BUDGET,
} from './sse-hub.js'
export {
  buildSnapshotMessage,
  parseMessagePartsRequestBody,
  projectChannelFact,
  projectHistoryEntry,
} from './host-route-support.js'

/**
 * The NekroNxt domain API, wired directly onto the DSH WebServer seam. It is
 * the REST/SSE surface the Web product consumes — no database handle and no
 * DSH Context ever crosses the wire: every endpoint goes through the assembled
 * CoreService/ChannelRuntime services (design docs/08). Request/response shapes
 * are locked here with zod; docs/08 reproduces the exact JSON as the Web-side
 * contract.
 */

export interface NekroHostApi {
  /** The actual listening port (OS-assigned when configured as 0). */
  readonly port: number
  dispose(): void
}

export const createNekroHostApi = (
  webServer: WebServer,
  runtime: NekroRuntime,
  productMetadata: {
    readonly displayName: string
    readonly organizationName: string
    readonly version: string
    readonly releaseId: string
    readonly repositoryUrl: string
    readonly licenseSpdx: string | null
    readonly dshVersion: string
  } = {
    displayName: 'NekroNXT',
    organizationName: 'NekroAI',
    version: PRODUCT_VERSION,
    releaseId: `@nekro-nxt/server@${PRODUCT_VERSION}`,
    repositoryUrl: 'https://github.com/NekroAI/nekro-nxt',
    licenseSpdx: 'AGPL-3.0-only',
    dshVersion: DEEPSEEK_HARNESS_VERSION,
  },
  isReady: () => boolean = () => true,
): NekroHostApi => {
  const disposers: Array<() => void> = []

  const snapshotMutations = Object.values(HostApiContracts)
    .filter((contract) => contract.invalidatesSnapshot)
    .map((contract) => ({
      method: contract.method,
      segments: contract.path.split('/'),
    }))
  const registerRoute = (route: WebRoute): void => {
    disposers.push(
      webServer.register({
        ...route,
        handler: (req, res) => {
          if (!isReady()) {
            writeError(res, 503, 'host-upgrading', 'NekroNXT 正在完成升级，请稍后再试。')
            return
          }
          const clientRelease = req.headers['x-nekro-client-release']
          if (
            req.method !== 'GET' &&
            req.method !== 'HEAD' &&
            typeof clientRelease === 'string' &&
            clientRelease !== productMetadata.releaseId
          ) {
            writeError(res, 409, 'release-mismatch', '服务已升级，请刷新页面。')
            return
          }
          const segments = new URL(req.url ?? '/', 'http://localhost').pathname.split('/')
          if (
            snapshotMutations.some(
              (contract) =>
                contract.method === req.method &&
                contract.segments.length === segments.length &&
                contract.segments.every((segment, index) => segment.startsWith(':') || segment === segments[index]),
            )
          ) {
            res.once('finish', () => {
              if (res.statusCode >= 200 && res.statusCode < 300) {
                broadcast({ event: 'snapshot-changed', data: { changed: true } })
              }
            })
          }
          return Promise.resolve()
            .then(() => route.handler(req, res))
            .catch((error: unknown) => {
              // An uncaught domain error would otherwise reach the WebServer seam as a bodiless 400, hiding the
              // reason from the client. Keep the status, add the contract error body.
              if (res.headersSent) throw error
              writeError(res, 400, 'request-failed', error instanceof Error ? error.message : String(error))
            })
        },
      }),
    )
  }

  // One global SSE hub: live clients plus a short in-memory replay window
  // keyed by Last-Event-ID. Domain facts stay in Channel / Session stores.
  const hub = new HostSseHub()
  const messageRevision = new Map<ChannelId, number>()
  const runtimeRevision = new Map<ChannelId, number>()
  const pendingFacts = new Map<ChannelId, ChannelFact[]>()
  let factTimer: ReturnType<typeof setTimeout> | undefined
  const nextRevision = (store: Map<ChannelId, number>, channelId: ChannelId): number => {
    const value = (store.get(channelId) ?? 0) + 1
    store.set(channelId, value)
    return value
  }
  const broadcast = (event: HostSseEvent): void => {
    hub.publish(event)
    if (event.event === 'snapshot-changed' || event.event === 'dynamic-changed') projections.scheduleAttentionCheck()
  }
  const projections = new WorkspaceProjections(runtime, (event) => hub.publish(event))
  const extensionImports = new ExtensionImportStaging()
  disposers.push(() => projections.dispose())
  const broadcastExtensionsChanged = (): void => {
    broadcast({ event: 'extensions-changed', data: { changed: true } })
  }
  disposers.push(
    runtime.host.subscribeDynamicApprovalRequests((event) => {
      broadcast({ event: 'dynamic-changed', data: { agentId: event.agentId } })
    }),
    runtime.host.subscribeAuthoringChanges((change) => {
      broadcast({ event: 'dynamic-changed', data: { agentId: change.agentId } })
    }),
  )
  const publishChannelFacts = (channelId: ChannelId, facts: readonly ChannelFact[]): void => {
    const itemsBySource = new Map<
      string,
      { kind: ChannelFact['kind']; sourceId: ChannelFact['sourceId']; message: HostSnapshotMessage }
    >()
    for (const fact of facts) {
      const message = projectChannelFact(runtime, fact)
      if (message === undefined) continue
      itemsBySource.set(fact.sourceId, { kind: fact.kind, sourceId: fact.sourceId, message })
    }
    const items = [...itemsBySource.values()]
    if (items.length === 0) return
    const chunks: (typeof items)[] = []
    let chunk: typeof items = []
    for (const item of items) {
      const candidate = [...chunk, item]
      const candidateBytes = Buffer.byteLength(
        JSON.stringify({ channelId, revision: Number.MAX_SAFE_INTEGER, items: candidate }),
        'utf8',
      )
      if (chunk.length > 0 && candidateBytes > SSE_FACT_FRAME_BUDGET) {
        chunks.push(chunk)
        chunk = [item]
      } else {
        chunk = candidate
      }
    }
    if (chunk.length > 0) chunks.push(chunk)
    for (const batch of chunks) {
      broadcast({
        event: 'channel-fact',
        data: { channelId, revision: nextRevision(messageRevision, channelId), items: batch },
      })
    }
  }
  const flushPendingFacts = (): void => {
    factTimer = undefined
    const batches = [...pendingFacts.entries()]
    pendingFacts.clear()
    for (const [channelId, facts] of batches) {
      // Isolate channels: one failing projection must not crash the timer or drop sibling batches.
      try {
        publishChannelFacts(channelId, facts)
      } catch (error) {
        console.error(`[nekro-nxt] 频道消息推送失败（${channelId}）：`, error)
      }
    }
  }
  disposers.push(
    runtime.channels.subscribeFacts((fact) => {
      const queued = pendingFacts.get(fact.channelId) ?? []
      queued.push(fact)
      pendingFacts.set(fact.channelId, queued)
      factTimer ??= setTimeout(flushPendingFacts, SSE_FACT_COALESCE_MS)
    }),
  )
  const queries = new HostQueries(runtime, () => hub.cursor, productMetadata, projections)

  const productUpdates = new ProductUpdates({
    releaseId: productMetadata.releaseId,
    repository: productMetadata.repositoryUrl.replace(/^https:\/\/github\.com\//u, '').replace(/\/$/u, ''),
    settings: {
      get: (key) => runtime.repository.getSystemSetting(key),
      put: (key, value, expectedRevision) => {
        runtime.repository.putSystemSetting(key, value, expectedRevision, Date.now())
      },
    },
  })
  productUpdates.start()
  disposers.push(() => productUpdates.dispose())
  registerRoute({
    kind: 'exact',
    path: '/api/product/updates',
    handler: (req, res) => {
      if (req.method !== 'GET') {
        writeError(res, 405, 'method-not-allowed', 'Method not allowed.')
        return
      }
      writeContractJson(res, 200, HostApiContracts.getProductUpdates, productUpdates.status())
    },
  })
  registerRoute({
    kind: 'exact',
    path: '/api/product/updates/check',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        writeError(res, 405, 'method-not-allowed', 'Method not allowed.')
        return
      }
      writeContractJson(res, 200, HostApiContracts.checkProductUpdates, await productUpdates.check())
    },
  })
  registerRoute({
    kind: 'exact',
    path: '/api/product/updates/settings',
    handler: async (req, res) => {
      if (req.method !== 'PUT') {
        writeError(res, 405, 'method-not-allowed', 'Method not allowed.')
        return
      }
      const parsed = HostApiContracts.updateProductUpdateSettings.parseRequest(await readJsonBody(req))
      writeContractJson(
        res,
        200,
        HostApiContracts.updateProductUpdateSettings,
        productUpdates.setAutoCheck(parsed.autoCheck),
      )
    },
  })
  const pacingSettings: MessagePacingSettingsStore = {
    get: (key) => runtime.repository.getSystemSetting(key),
    put: (key, value, expectedRevision) => {
      runtime.repository.putSystemSetting(key, value, expectedRevision, Date.now())
    },
  }
  registerRoute({
    kind: 'exact',
    path: '/api/settings/message-pacing',
    handler: async (req, res) => {
      if (req.method === 'GET') {
        writeContractJson(res, 200, HostApiContracts.getMessagePacingSettings, {
          pacing: readMessagePacing(pacingSettings),
        })
        return
      }
      if (req.method !== 'PUT') {
        writeError(res, 405, 'method-not-allowed', 'Method not allowed.')
        return
      }
      const parsed = HostApiContracts.updateMessagePacingSettings.parseRequest(await readJsonBody(req))
      writeContractJson(res, 200, HostApiContracts.updateMessagePacingSettings, {
        pacing: writeMessagePacing(pacingSettings, parsed.pacing),
      })
    },
  })
  registerRoute({
    kind: 'exact',
    path: '/api/settings/retrieval',
    handler: async (req, res) => {
      try {
        if (req.method === 'GET') {
          writeContractJson(res, 200, HostApiContracts.getRetrievalStatus, runtime.retrieval.status())
          return
        }
        if (req.method === 'PUT') {
          const parsed = HostApiContracts.updateRetrievalMode.parseRequest(await readJsonBody(req))
          writeContractJson(res, 200, HostApiContracts.updateRetrievalMode, runtime.retrieval.setMode(parsed.mode))
          return
        }
        writeError(res, 405, 'method-not-allowed', 'Method not allowed.')
      } catch (error) {
        writeError(res, 400, 'retrieval-settings-failed', error instanceof Error ? error.message : String(error))
      }
    },
  })
  registerRoute({
    kind: 'exact',
    path: '/api/settings/retrieval/model/download',
    handler: (req, res) => {
      if (req.method !== 'POST') {
        writeError(res, 405, 'method-not-allowed', 'Method not allowed.')
        return
      }
      try {
        writeContractJson(res, 200, HostApiContracts.downloadRetrievalModel, runtime.retrieval.startDownload())
      } catch (error) {
        writeError(res, 400, 'retrieval-model-unavailable', error instanceof Error ? error.message : String(error))
      }
    },
  })
  registerRoute({
    kind: 'exact',
    path: '/api/settings/retrieval/model',
    handler: async (req, res) => {
      if (req.method !== 'DELETE') {
        writeError(res, 405, 'method-not-allowed', 'Method not allowed.')
        return
      }
      try {
        writeContractJson(res, 200, HostApiContracts.removeRetrievalModel, await runtime.retrieval.remove())
      } catch (error) {
        writeError(res, 400, 'retrieval-model-busy', error instanceof Error ? error.message : String(error))
      }
    },
  })
  registerRoute({
    kind: 'exact',
    path: '/api/runtimes/code-run-node/download',
    handler: (req, res) => {
      if (req.method !== 'POST') {
        writeError(res, 405, 'method-not-allowed', 'Method not allowed.')
        return
      }
      try {
        writeContractJson(res, 200, HostApiContracts.downloadCodeRunNode, runtime.codeRunNode.startDownload())
      } catch (error) {
        writeError(res, 400, 'code-run-node-unavailable', error instanceof Error ? error.message : String(error))
      }
    },
  })
  registerRoute({
    kind: 'exact',
    path: '/api/runtimes/code-run-node',
    handler: async (req, res) => {
      if (req.method !== 'DELETE') {
        writeError(res, 405, 'method-not-allowed', 'Method not allowed.')
        return
      }
      try {
        writeContractJson(res, 200, HostApiContracts.removeCodeRunNode, await runtime.codeRunNode.removeDownloaded())
      } catch (error) {
        writeError(res, 400, 'code-run-node-busy', error instanceof Error ? error.message : String(error))
      }
    },
  })
  const buildSnapshot = (viewerKey: string) => queries.snapshot(viewerKey)

  // GET /api/snapshot
  registerRoute({
    kind: 'exact',
    path: '/api/snapshot',
    handler: async (req, res) => {
      try {
        writeJson(res, 200, await buildSnapshot(viewerKeyFromRequest(req)))
      } catch (error) {
        writeError(res, 500, 'snapshot-failed', error instanceof Error ? error.message : String(error))
      }
    },
  })

  // GET /api/events (SSE) — live data plane for messages and work trajectory.
  registerRoute({
    kind: 'exact',
    path: '/api/events',
    handler: (req, res) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      hub.add(res)
      const replay = hub.replaySince(parseLastEventId(req.headers['last-event-id']))
      for (const frame of replay.frames) hub.write(res, frame)
      hub.write(res, renderSse({ event: 'status', data: { ok: true, message: '已连接', replay: replay.status } }))

      // A named event, unlike an SSE comment, reaches the page, so clients can tell a silently stalled connection.
      const heartbeat = setInterval(() => hub.write(res, 'event: heartbeat\ndata: {}\n\n'), 15_000)
      const onClose = (): void => {
        hub.remove(res)
        clearInterval(heartbeat)
        res.end()
      }
      res.on('close', onClose)
      res.on('error', onClose)
    },
  })

  const unsubscribeConnectionChanges = runtime.subscribeConnectionChanges((event) => {
    if (event) broadcast({ event: 'connection-fact', data: projectConnectionEvent(runtime, event) })
    broadcast({ event: 'snapshot-changed', data: { changed: true } })
  })
  const unsubscribeRuntimeStatus = runtime.host.subscribeRuntimeStatus(() => {
    broadcast({ event: 'snapshot-changed', data: { changed: true } })
  })
  const unsubscribeCodeRunNode = runtime.codeRunNode.subscribe(() => {
    broadcast({ event: 'snapshot-changed', data: { changed: true } })
  })
  const unsubscribeChannelRuntime = runtime.host.subscribeChannelRuntime((channelId) => {
    if (!runtime.repository.getChannel(channelId)) return
    const projection = assembleChannelRuntime(runtime, channelId)
    const revision = nextRevision(runtimeRevision, channelId)
    const data = { ...projection, revision }
    broadcast({
      event: 'runtime',
      data:
        Buffer.byteLength(JSON.stringify(data), 'utf8') > SSE_RUNTIME_FRAME_BUDGET
          ? { ...projection, turns: [], revision, truncated: true }
          : data,
    })
  })
  const unsubscribeDshSettings = runtime.host.onDshSettingsChanged((namespace, revision) => {
    broadcast({
      event: 'dsh-settings-changed',
      data: DshSettingsChangedSseDataSchema.parse({ namespace, revision }),
    })
  })
  const unsubscribeDshCredentials = runtime.host.onDshCredentialChanged((ref) => {
    broadcast({
      event: 'dsh-credentials-changed',
      data: DshCredentialsChangedSseDataSchema.parse({ ref }),
    })
  })
  disposers.push(
    registerAuthoringRoutes({
      runtime,
      registerRoute,
      broadcast,
      broadcastExtensionsChanged,
      readCursor: () => hub.cursor,
      projections,
      extensionImports,
    }),
  )
  disposers.push(
    registerSettingsRoutes({
      runtime,
      registerRoute,
      broadcast,
      broadcastExtensionsChanged,
      readCursor: () => hub.cursor,
      projections,
      extensionImports,
    }),
  )
  disposers.push(
    registerWorkspaceRoutes({
      runtime,
      registerRoute,
      broadcast,
      broadcastExtensionsChanged,
      readCursor: () => hub.cursor,
      projections,
      extensionImports,
    }),
  )
  disposers.push(
    registerConnectionsRoutes({
      runtime,
      registerRoute,
      broadcast,
      broadcastExtensionsChanged,
      readCursor: () => hub.cursor,
      projections,
      extensionImports,
    }),
  )
  disposers.push(
    registerExtensionLibraryRoutes({
      registerRoute,
      repository: runtime.repository,
      assetService: runtime.assetService,
      libraryQuota: installedLibraryQuota(runtime.repository),
    }),
  )
  disposers.push(
    registerExtensionsRoutes({
      runtime,
      registerRoute,
      broadcast,
      broadcastExtensionsChanged,
      readCursor: () => hub.cursor,
      projections,
      extensionImports,
    }),
  )

  disposers.push(
    registerMcpRoutes({
      runtime,
      registerRoute,
      broadcast,
      broadcastExtensionsChanged,
      readCursor: () => hub.cursor,
      projections,
      extensionImports,
    }),
  )
  disposers.push(
    registerCommunityRoutes({
      runtime,
      registerRoute,
      broadcast,
      broadcastExtensionsChanged,
      readCursor: () => hub.cursor,
      projections,
      extensionImports,
    }),
  )
  disposers.push(
    registerScheduledTaskRoutes({
      runtime,
      registerRoute,
      broadcast,
      broadcastExtensionsChanged,
      readCursor: () => hub.cursor,
      projections,
      extensionImports,
    }),
  )

  projections.registerRoutes({ registerRoute })
  disposers.push(
    runtime.channels.subscribeFacts((fact) => {
      if (fact.kind === 'outbound') projections.scheduleAttentionCheck()
    }),
  )
  projections.scheduleAttentionCheck()

  // Catch-all for unknown API endpoints.
  registerRoute({
    kind: 'prefix',
    path: '/api',
    handler: (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      writeError(res, 501, 'not-implemented', `Not implemented: ${req.method} ${url.pathname}`)
    },
  })

  return {
    get port() {
      return webServer.port
    },
    dispose() {
      if (factTimer !== undefined) clearTimeout(factTimer)
      pendingFacts.clear()
      unsubscribeConnectionChanges()
      unsubscribeRuntimeStatus()
      unsubscribeCodeRunNode()
      unsubscribeChannelRuntime()
      unsubscribeDshSettings()
      unsubscribeDshCredentials()
      for (const disposer of disposers.splice(0)) disposer()
    },
  }
}
