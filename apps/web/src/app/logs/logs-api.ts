import { HostApiContracts, type HostLogQuery, type HostLogSettings } from '@nekro-nxt/contracts'
import { callHostApi } from '../../host-api-client.js'

export const logUrl = (path: string, query: HostLogQuery) =>
  `${path}?${new URLSearchParams({ query: JSON.stringify(query) })}`
export const logHref = (query: HostLogQuery) => logUrl('/logs', query)
export const logsApi = {
  query: (query: HostLogQuery, signal?: AbortSignal) =>
    callHostApi(
      HostApiContracts.queryLogs,
      { query: JSON.stringify(query) },
      undefined,
      signal === undefined ? {} : { signal },
    ),
  get: (id: string, signal?: AbortSignal) =>
    callHostApi(HostApiContracts.getLog, { id }, undefined, signal === undefined ? {} : { signal }),
  sources: (signal?: AbortSignal) =>
    callHostApi(HostApiContracts.logSources, {}, undefined, signal === undefined ? {} : { signal }),
  status: (signal?: AbortSignal) =>
    callHostApi(HostApiContracts.logStatus, {}, undefined, signal === undefined ? {} : { signal }),
  settings: (signal?: AbortSignal) =>
    callHostApi(HostApiContracts.logSettings, {}, undefined, signal === undefined ? {} : { signal }),
  saveSettings: (input: HostLogSettings) => callHostApi(HostApiContracts.updateLogSettings, {}, input),
  debug: (
    source?: { kind: 'system' | 'dsh-plugin' | 'extension' | 'connection' | 'unknown'; id: string },
    durationMinutes: 5 | 15 | 30 = 15,
  ) =>
    callHostApi(HostApiContracts.startLogDebug, {}, { ...(source === undefined ? {} : { source }), durationMinutes }),
  stopDebug: (id: string) => callHostApi(HostApiContracts.stopLogDebug, { id }, undefined),
}

export async function exportLogs(query: HostLogQuery, format: 'text' | 'jsonl', signal: AbortSignal): Promise<void> {
  const response = await fetch(
    `${logUrl('/api/logs/export', query)}&format=${format}`,
    signal === undefined ? {} : { signal },
  )
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined)
    const error = typeof body === 'object' && body !== null && 'error' in body ? body.error : undefined
    throw new Error(
      typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
        ? error.message
        : '日志导出失败。',
    )
  }
  const url = URL.createObjectURL(await response.blob())
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `NekroNXT-logs.${format === 'text' ? 'txt' : 'jsonl'}`
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
