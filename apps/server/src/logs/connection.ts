import type { AdapterConnectionDiagnostic } from '@nekro-nxt/adapter-sdk'
import type { HostLogInput, HostLogScope } from '@nekro-nxt/contracts'

/** Connection state belongs to the adapter; this observer only summarizes outages. */
export class ConnectionLogObserver {
  readonly #outages = new Map<
    string,
    { since: number; reportedAt: number; updates: number; reason?: string | undefined }
  >()

  observe(
    id: string,
    name: string,
    scope: HostLogScope,
    diagnostic: AdapterConnectionDiagnostic,
    previous: AdapterConnectionDiagnostic | undefined,
    now: number,
  ): HostLogInput | undefined {
    const status = diagnostic.status
    const outage = this.#outages.get(id)
    const base = { source: { kind: 'connection' as const, id, name }, scope }
    const details = { status, previousStatus: previous?.status, ...diagnostic.details }
    const reason = diagnostic.message
    const suffix = reason ? `：${reason}` : ''
    if (status === 'reconnecting' || status === 'failed') {
      const current = outage ?? { since: now, reportedAt: now, updates: 0 }
      current.updates++
      this.#outages.set(id, current)
      const changed = reason !== current.reason || (status === 'failed' && previous?.status !== 'failed')
      current.reason = reason
      if (outage && !changed && now - current.reportedAt < 300_000) return undefined
      current.reportedAt = now
      const durationMs = Math.max(0, now - current.since)
      return {
        ...base,
        level: status === 'failed' ? 'error' : 'warn',
        message: `${outage ? `连接仍未恢复，已中断 ${Math.round(durationMs / 1000)} 秒` : status === 'failed' ? '连接失败' : '连接中断，正在重连'}${suffix}`,
        details: { ...details, durationMs, diagnosticUpdates: current.updates },
      }
    }
    if (status === 'connected' && outage) {
      this.#outages.delete(id)
      const durationMs = Math.max(0, now - outage.since)
      return {
        ...base,
        level: 'info',
        message: `连接已恢复，中断 ${Math.round(durationMs / 1000)} 秒`,
        details: { ...details, durationMs, diagnosticUpdates: outage.updates },
      }
    }
    if (status === 'stopped') this.#outages.delete(id)
    if (previous?.status === status && previous.message === reason) return undefined
    if (status === 'connecting') return undefined
    // A connected adapter may report a capability or event-handling problem without disconnecting.
    if (status === 'connected' && previous?.status === 'connected') {
      return reason ? { ...base, level: 'warn', message: reason, details } : undefined
    }
    return { ...base, level: 'info', message: status === 'connected' ? '连接已建立' : `连接已停止${suffix}`, details }
  }
}
