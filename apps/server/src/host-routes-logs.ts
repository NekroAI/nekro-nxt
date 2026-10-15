import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import {
  HostApiContracts,
  hostLogQuerySchema,
  type HostLogQuery,
  type HostLogSource,
  type HostLogStreamEvent,
} from '@nekro-nxt/contracts'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readJsonBody, writeContractJson, writeError, writeJson } from './host-route-support.js'
import type { HostLogService } from './logs/service.js'

export function readLogQuery(url: URL): HostLogQuery {
  const query = url.searchParams.get('query')
  if (query !== null && query.length > 32_768) throw new Error('日志查询条件过长。')
  return hostLogQuerySchema.parse(query === null ? {} : JSON.parse(query))
}

/** Independent stream: a slow log reader cannot consume the chat SSE replay buffer. */
function streamLogs(logs: HostLogService, query: HostLogQuery, req: IncomingMessage, res: ServerResponse): () => void {
  let closed = false
  let busy = false
  let dirty = true
  let blocked = false
  let cursor = typeof req.headers['last-event-id'] === 'string' ? req.headers['last-event-id'] : query.afterCursor
  let timer: ReturnType<typeof setTimeout> | undefined
  const filters = { ...query }
  delete filters.afterCursor
  delete filters.olderCursor
  delete filters.headCursor
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  const emit = (event: HostLogStreamEvent, id?: string): boolean => {
    if (closed) return false
    try {
      const writable = res.write(
        `${id === undefined ? '' : `id: ${id}\n`}event: logs\ndata: ${JSON.stringify(event)}\n\n`,
      )
      blocked = !writable
      return writable
    } catch {
      stop()
      return false
    }
  }
  const pump = async (): Promise<void> => {
    if (closed || busy || blocked) return
    busy = true
    try {
      if (cursor === undefined) cursor = (await logs.status()).headCursor
      do {
        dirty = false
        const page = await logs.query({ ...filters, ...(cursor ? { afterCursor: cursor } : {}), limit: 100 })
        if (closed) break
        if (page.gap && !emit({ type: 'gap', reason: page.gap, cursor: page.headCursor })) {
          dirty = true
          break
        }
        for (const entry of page.entries) {
          cursor = entry.id
          if (!emit({ type: 'entries', entries: [entry], cursor }, cursor)) {
            dirty = true
            break
          }
        }
        if (blocked) break
        if (!page.hasMore) {
          cursor = page.headCursor
          emit({ type: 'entries', entries: [], cursor }, cursor)
        } else dirty = true
      } while (dirty && !closed && !blocked)
    } catch {
      if (!closed) emit({ type: 'status', status: await logs.status() })
    } finally {
      busy = false
    }
  }
  const schedule = (): void => {
    dirty = true
    if (closed || timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      void pump()
    }, 100)
  }
  const unsubscribe = logs.subscribe(schedule)
  const heartbeat = setInterval(() => {
    if (closed || blocked) return
    res.write('event: heartbeat\ndata: {}\n\n')
    void logs.status().then((status) => {
      if (!closed && !blocked) emit({ type: 'status', status })
    })
    schedule()
  }, 15_000)
  const stop = (): void => {
    if (closed) return
    closed = true
    clearTimeout(timer)
    clearInterval(heartbeat)
    unsubscribe()
    res.end()
  }
  res.on('drain', () => {
    blocked = false
    schedule()
  })
  res.once('close', stop)
  res.once('error', stop)
  void logs.status().then((status) => {
    if (!closed) emit({ type: 'status', status })
    schedule()
  })
  return stop
}

export function registerLogRoutes(
  registerRoute: (route: WebRoute) => void,
  logs: HostLogService | undefined,
  catalogue: () => readonly HostLogSource[] = () => [],
): () => void {
  const streams = new Set<() => void>()
  const exports = new Set<AbortController>()
  registerRoute({
    kind: 'prefix',
    path: '/api/logs',
    handler: async (req, res) => {
      if (res.destroyed) return
      const url = new URL(req.url ?? '/', 'http://localhost')
      const suffix = url.pathname.slice('/api/logs'.length)
      if (suffix !== '' && !suffix.startsWith('/')) {
        writeError(res, 404, 'not-found', '日志接口不存在。')
        return
      }
      if (!logs) {
        writeError(res, 503, 'logs-unavailable', '这个宿主未启用日志保存。')
        return
      }
      const method = req.method ?? 'GET'
      const expected =
        suffix === '/settings'
          ? ['GET', 'PUT']
          : suffix === '/debug'
            ? ['POST']
            : suffix.startsWith('/debug/')
              ? ['DELETE']
              : ['GET']
      if (!expected.includes(method)) {
        res.setHeader('allow', expected.join(', '))
        writeError(res, 405, 'method-not-allowed', '此日志操作不支持这个请求方法。')
        return
      }
      try {
        if (suffix === '') {
          writeContractJson(res, 200, HostApiContracts.queryLogs, await logs.query(readLogQuery(url)))
          return
        }
        if (suffix === '/sources') {
          const history = await logs.sources()
          let current: readonly HostLogSource[] = []
          try {
            current = catalogue()
          } catch {
            /* An unavailable live catalog must not hide retained evidence. */
          }
          const sources = new Map([...history, ...current].map((source) => [`${source.kind}:${source.id}`, source]))
          writeContractJson(res, 200, HostApiContracts.logSources, { sources: [...sources.values()] })
          return
        }
        if (suffix === '/status') {
          writeContractJson(res, 200, HostApiContracts.logStatus, await logs.status())
          return
        }
        if (suffix === '/settings') {
          if (method === 'GET') writeContractJson(res, 200, HostApiContracts.logSettings, logs.settings())
          else
            writeContractJson(
              res,
              200,
              HostApiContracts.updateLogSettings,
              await logs.updateSettings(HostApiContracts.updateLogSettings.parseRequest(await readJsonBody(req))),
            )
          return
        }
        if (suffix === '/debug') {
          writeContractJson(res, 200, HostApiContracts.startLogDebug, {
            lease: logs.startDebug(await readJsonBody(req)),
          })
          return
        }
        if (suffix.startsWith('/debug/')) {
          logs.stopDebug(decodeURIComponent(suffix.slice(7)))
          writeContractJson(res, 200, HostApiContracts.stopLogDebug, { stopped: true })
          return
        }
        if (suffix === '/events') {
          const stop = streamLogs(logs, readLogQuery(url), req, res)
          streams.add(stop)
          res.once('close', () => streams.delete(stop))
          return
        }
        if (suffix === '/export') {
          const format = url.searchParams.get('format') ?? 'text'
          if (format !== 'text' && format !== 'jsonl') {
            writeError(res, 400, 'invalid-format', '请选择文本或 JSONL 格式。')
            return
          }
          const controller = new AbortController()
          exports.add(controller)
          res.once('close', () => controller.abort())
          try {
            const bytes = await logs.export(readLogQuery(url), format, controller.signal)
            if (controller.signal.aborted) return
            res.writeHead(200, {
              'content-type': format === 'text' ? 'text/plain; charset=utf-8' : 'application/x-ndjson; charset=utf-8',
              'cache-control': 'no-store',
              'content-disposition': `attachment; filename="NekroNXT-logs-${new Date().toISOString().replaceAll(':', '-')}.${format === 'text' ? 'txt' : 'jsonl'}"`,
              'content-length': bytes.byteLength,
            })
            res.end(bytes)
          } finally {
            exports.delete(controller)
          }
          return
        }
        const match = /^\/([^/]+)$/u.exec(suffix)
        if (match) {
          const entry = await logs.get(decodeURIComponent(match[1]!))
          if (!entry) writeError(res, 404, 'log-not-found', '这条日志不存在或已经过期。')
          else writeContractJson(res, 200, HostApiContracts.getLog, { entry })
          return
        }
        writeError(res, 404, 'not-found', '日志接口不存在。')
      } catch (error) {
        if (res.headersSent || res.destroyed) {
          res.end()
          return
        }
        const message = error instanceof Error ? error.message : ''
        const status =
          message.includes('已被修改') || message.includes('已有日志')
            ? 409
            : message.includes('50 MiB')
              ? 413
              : message.includes('暂时不可用')
                ? 503
                : 400
        writeJson(res, status, {
          error: {
            code: 'logs-failed',
            message: /\p{Script=Han}/u.test(message) ? message : '日志操作失败，请检查查询条件后重试。',
          },
        })
      }
    },
  })
  return () => {
    for (const stop of streams) stop()
    streams.clear()
    for (const controller of exports) controller.abort()
    exports.clear()
  }
}
