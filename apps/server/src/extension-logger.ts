import type { HostLogScope, HostLogSource, NxtLogger } from '@nekro-nxt/contracts'
import type { HostLogSink } from './logs/service.js'

/** Old factories may destructure the new field; only using the capability needs SDK 9. */
export function extensionLogger(
  sink: HostLogSink | undefined,
  source: HostLogSource,
  scope: HostLogScope,
  sdk: number,
): NxtLogger {
  const method = (level: 'debug' | 'info' | 'warn' | 'error') => (message: string, details?: unknown) => {
    if (sdk < 9) throw new Error('使用日志接口的扩展需要声明 requires.sdk 为 9 或更高。')
    sink?.write({ level, message, source, scope, ...(details === undefined ? {} : { details }) })
  }
  return { debug: method('debug'), info: method('info'), warn: method('warn'), error: method('error') }
}
