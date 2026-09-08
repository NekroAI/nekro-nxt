import { ConnectionIdSchema, HostApiContracts } from '@nekro-nxt/contracts'
import {
  projectConnectionEvent,
  readJsonBody,
  writeContractJson,
  writeError,
  writeJson,
  type HostRouteContext,
} from './host-route-support.js'
export function registerConnectionsRoutes({ runtime, registerRoute }: HostRouteContext): () => void {
  registerRoute({
    kind: 'exact',
    path: '/api/platform-users',
    handler: (req, res) => {
      if (req.method !== 'GET') {
        writeError(res, 405, 'method-not-allowed', '平台用户目录只支持 GET。')
        return
      }
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const rawLimit = url.searchParams.get('limit')
        const params = HostApiContracts.listPlatformUsers.parseParams({
          ...(url.searchParams.has('query') ? { query: url.searchParams.get('query') } : {}),
          ...(url.searchParams.has('adapterKey') ? { adapterKey: url.searchParams.get('adapterKey') } : {}),
          ...(url.searchParams.has('connectionId') ? { connectionId: url.searchParams.get('connectionId') } : {}),
          ...(url.searchParams.has('cursor') ? { cursor: url.searchParams.get('cursor') } : {}),
          ...(rawLimit === null ? {} : { limit: Number(rawLimit) }),
        })
        const adapters = new Map(runtime.listConnectionAdapters().map((adapter) => [adapter.key, adapter.displayName]))
        const adapterDisplayName = (adapterKey: string): string => adapters.get(adapterKey) ?? '已移除的适配器'
        const directoryLabel = (value: string | undefined): string | undefined => {
          const normalized = value?.trim()
          return normalized ? normalized.slice(0, 120) : undefined
        }
        const records = [...runtime.core.listPlatformUsers()].sort((left, right) =>
          left.identityId.localeCompare(right.identityId),
        )
        const adapterCounts = new Map<string, number>()
        const connectionCounts = new Map<
          string,
          {
            id: (typeof records)[number]['connection']['id']
            adapterKey: string
            displayName: string
            userCount: number
          }
        >()
        for (const record of records) {
          adapterCounts.set(record.connection.adapterKey, (adapterCounts.get(record.connection.adapterKey) ?? 0) + 1)
          const connectionDisplayName = record.connection.alias ?? adapterDisplayName(record.connection.adapterKey)
          const facet = connectionCounts.get(record.connection.id)
          connectionCounts.set(record.connection.id, {
            id: record.connection.id,
            adapterKey: record.connection.adapterKey,
            displayName: connectionDisplayName,
            userCount: (facet?.userCount ?? 0) + 1,
          })
        }
        const normalizedQuery = params.query?.toLocaleLowerCase()
        const matching = records.filter((record) => {
          if (params.adapterKey !== undefined && record.connection.adapterKey !== params.adapterKey) return false
          if (params.connectionId !== undefined && record.connection.id !== params.connectionId) return false
          if (normalizedQuery && !(record.displayName ?? '').toLocaleLowerCase().includes(normalizedQuery)) return false
          return true
        })
        const filtered = matching.filter(
          (record) => params.cursor === undefined || record.identityId.localeCompare(params.cursor) > 0,
        )
        const page = filtered.slice(0, params.limit)
        const items = page.map((record) => ({
          identityId: record.identityId,
          ...(directoryLabel(record.displayName) === undefined
            ? {}
            : { displayName: directoryLabel(record.displayName) }),
          adapter: {
            key: record.connection.adapterKey,
            displayName: adapterDisplayName(record.connection.adapterKey),
          },
          connection: {
            id: record.connection.id,
            displayName: record.connection.alias ?? adapterDisplayName(record.connection.adapterKey),
          },
          activeChannelCount: record.activeChannels.length,
          channelPreview: record.activeChannels.slice(0, 3).map((channel) => ({
            id: channel.id,
            ...(directoryLabel(channel.displayName) === undefined
              ? {}
              : { displayName: directoryLabel(channel.displayName) }),
            kind: channel.kind,
          })),
          historicalOnly: record.historicalOnly,
        }))
        writeContractJson(res, 200, HostApiContracts.listPlatformUsers, {
          total: matching.length,
          items,
          facets: {
            adapters: [...adapterCounts.entries()]
              .map(([key, userCount]) => ({ key, displayName: adapterDisplayName(key), userCount }))
              .sort((left, right) => left.displayName.localeCompare(right.displayName, 'zh-CN')),
            connections: [...connectionCounts.values()].sort((left, right) =>
              left.displayName.localeCompare(right.displayName, 'zh-CN'),
            ),
          },
          ...(filtered.length > params.limit && page.at(-1) !== undefined
            ? { nextCursor: page.at(-1)?.identityId }
            : {}),
        })
      } catch (error) {
        writeError(res, 400, 'invalid-platform-user-query', error instanceof Error ? error.message : String(error))
      }
    },
  })

  registerRoute({
    kind: 'exact',
    path: '/api/connections',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        writeError(res, 405, 'method-not-allowed', '只支持 POST。')
        return
      }
      let parsed: ReturnType<typeof HostApiContracts.createConnection.parseRequest>
      try {
        parsed = HostApiContracts.createConnection.parseRequest(await readJsonBody(req))
      } catch (error) {
        writeError(res, 400, 'invalid-request', error instanceof Error ? error.message : String(error))
        return
      }
      try {
        // Secret 由 Host 按 Adapter schema 写入凭据存储；Core 只接收不可猜测引用。
        const connection = await runtime.createConnection(parsed)
        writeJson(
          res,
          201,
          HostApiContracts.createConnection.parseResponse({
            connectionId: connection.id,
            adapterKey: connection.adapterKey,
          }),
        )
      } catch (error) {
        writeError(res, 400, 'connection-failed', error instanceof Error ? error.message : String(error))
      }
    },
  })

  registerRoute({
    kind: 'prefix',
    path: '/api/connections',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const eventsMatch = /^\/api\/connections\/([^/]+)\/events$/.exec(url.pathname)
      if (eventsMatch) {
        if (req.method !== 'GET') {
          writeError(res, 405, 'method-not-allowed', '连接活动只支持 GET。')
          return
        }
        try {
          const connectionId = ConnectionIdSchema.parse(decodeURIComponent(eventsMatch[1] ?? ''))
          const beforeReceivedAt = url.searchParams.get('beforeReceivedAt')
          const beforeId = url.searchParams.get('beforeId')
          const limit = url.searchParams.get('limit')
          const params = HostApiContracts.listConnectionEvents.parseParams({
            connectionId,
            ...(beforeReceivedAt === null ? {} : { beforeReceivedAt: Number(beforeReceivedAt) }),
            ...(beforeId === null ? {} : { beforeId }),
            ...(limit === null ? {} : { limit: Number(limit) }),
          })
          if ((params.beforeReceivedAt === undefined) !== (params.beforeId === undefined)) {
            throw new Error('连接活动游标必须同时包含时间和 ID。')
          }
          const records = runtime.core.listConnectionEvents(params.connectionId, {
            limit: params.limit + 1,
            ...(params.beforeReceivedAt === undefined || params.beforeId === undefined
              ? {}
              : { before: { receivedAt: params.beforeReceivedAt, id: params.beforeId } }),
          })
          writeContractJson(res, 200, HostApiContracts.listConnectionEvents, {
            events: records.slice(0, params.limit).map((event) => projectConnectionEvent(runtime, event)),
            hasMore: records.length > params.limit,
          })
        } catch (error) {
          writeError(res, 400, 'connection-events-failed', error instanceof Error ? error.message : String(error))
        }
        return
      }
      const aliasMatch = /^\/api\/connections\/([^/]+)\/alias$/.exec(url.pathname)
      if (aliasMatch) {
        if (req.method !== 'POST') {
          writeError(res, 405, 'method-not-allowed', '只支持 POST。')
          return
        }
        const encodedConnectionId = aliasMatch[1]
        if (encodedConnectionId === undefined) {
          writeError(res, 404, 'not-found', `未定义路由：${req.method} ${url.pathname}。`)
          return
        }
        let connectionId: ReturnType<typeof ConnectionIdSchema.parse>
        try {
          connectionId = ConnectionIdSchema.parse(decodeURIComponent(encodedConnectionId))
        } catch {
          writeError(res, 400, 'invalid-connection', '无效的连接 ID。')
          return
        }
        try {
          const params = HostApiContracts.updateConnectionAlias.parseParams({ connectionId })
          const body = HostApiContracts.updateConnectionAlias.parseRequest(await readJsonBody(req))
          const updated = runtime.updateConnectionAlias(params.connectionId, body.alias)
          writeContractJson(res, 200, HostApiContracts.updateConnectionAlias, {
            connectionId: updated.id,
            ...(updated.alias === undefined ? {} : { alias: updated.alias }),
          })
        } catch (error) {
          writeError(res, 400, 'connection-alias-failed', error instanceof Error ? error.message : String(error))
        }
        return
      }
      const defaultsMatch = /^\/api\/connections\/([^/]+)\/activity-trigger-defaults$/.exec(url.pathname)
      if (defaultsMatch) {
        if (req.method !== 'POST') {
          writeError(res, 405, 'method-not-allowed', '只支持 POST。')
          return
        }
        try {
          const connectionId = ConnectionIdSchema.parse(decodeURIComponent(defaultsMatch[1] ?? ''))
          const params = HostApiContracts.updateConnectionActivityTriggerDefaults.parseParams({ connectionId })
          const body = HostApiContracts.updateConnectionActivityTriggerDefaults.parseRequest(await readJsonBody(req))
          const updated = runtime.updateConnectionActivityTriggerDefaults(params.connectionId, body.activityKeys)
          writeContractJson(res, 200, HostApiContracts.updateConnectionActivityTriggerDefaults, {
            connectionId: updated.id,
            activityKeys: updated.activityTriggerDefaults,
          })
        } catch (error) {
          writeError(
            res,
            400,
            'connection-activity-defaults-failed',
            error instanceof Error ? error.message : String(error),
          )
        }
        return
      }
      const restoreMatch = /^\/api\/connections\/([^/]+)\/restore$/.exec(url.pathname)
      if (restoreMatch) {
        if (req.method !== 'POST') {
          writeError(res, 405, 'method-not-allowed', '只支持 POST。')
          return
        }
        try {
          const connectionId = ConnectionIdSchema.parse(decodeURIComponent(restoreMatch[1] ?? ''))
          const params = HostApiContracts.restoreConnection.parseParams({ connectionId })
          HostApiContracts.restoreConnection.parseRequest(undefined)
          const restored = await runtime.restoreConnection(params.connectionId)
          writeContractJson(res, 200, HostApiContracts.restoreConnection, {
            connectionId: restored.id,
            restored: true,
          })
        } catch (error) {
          writeError(res, 400, 'connection-restore-failed', error instanceof Error ? error.message : String(error))
        }
        return
      }
      const deleteMatch = /^\/api\/connections\/([^/]+)$/.exec(url.pathname)
      if (deleteMatch) {
        if (req.method !== 'DELETE') {
          writeError(res, 405, 'method-not-allowed', '只支持 DELETE。')
          return
        }
        try {
          const connectionId = ConnectionIdSchema.parse(decodeURIComponent(deleteMatch[1] ?? ''))
          const params = HostApiContracts.deleteConnection.parseParams({ connectionId })
          const body = HostApiContracts.deleteConnection.parseRequest(await readJsonBody(req))
          const result = await runtime.deleteConnection(params.connectionId, body)
          writeContractJson(res, 200, HostApiContracts.deleteConnection, {
            connectionId: params.connectionId,
            archived: result.archived,
          })
        } catch (error) {
          writeError(res, 400, 'connection-delete-failed', error instanceof Error ? error.message : String(error))
        }
        return
      }
      const match = /^\/api\/connections\/([^/]+)\/test$/.exec(url.pathname)
      if (!match) {
        writeError(res, 404, 'not-found', `未定义路由：${req.method} ${url.pathname}。`)
        return
      }
      if (req.method !== 'POST') {
        writeError(res, 405, 'method-not-allowed', '只支持 POST。')
        return
      }
      const encodedConnectionId = match[1]
      if (encodedConnectionId === undefined) {
        writeError(res, 404, 'not-found', `未定义路由：${req.method} ${url.pathname}。`)
        return
      }
      let connectionId: ReturnType<typeof ConnectionIdSchema.parse>
      try {
        connectionId = ConnectionIdSchema.parse(decodeURIComponent(encodedConnectionId))
      } catch {
        writeError(res, 400, 'invalid-connection', '无效的连接 ID。')
        return
      }
      let parsed: ReturnType<typeof HostApiContracts.testConnection.parseRequest>
      try {
        parsed = HostApiContracts.testConnection.parseRequest(await readJsonBody(req))
      } catch (error) {
        writeError(res, 400, 'invalid-request', error instanceof Error ? error.message : String(error))
        return
      }
      const connection = runtime.core.listConnections().find((candidate) => candidate.id === connectionId)
      if (!connection) {
        writeError(res, 404, 'not-found', '连接不存在。')
        return
      }
      writeContractJson(
        res,
        200,
        HostApiContracts.testConnection,
        await runtime.testConnection(connection.id, parsed.direction, parsed.channelId),
      )
    },
  })
  return () => undefined
}
