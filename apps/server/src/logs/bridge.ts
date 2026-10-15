import { AsyncLocalStorage } from 'node:async_hooks'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { HostLogSource, HostLogScope } from '@nekro-nxt/contracts'
import type { HostLogSink } from './service.js'

interface Owner {
  sink: HostLogSink
  source: HostLogSource
  scope?: HostLogScope
}
const owners = new WeakMap<Fiber, Owner>()
const modules = new WeakMap<object, HostLogSource>()
/** Associate explicitly imported entrypoints, never infer a package from a log prefix. */
export function registerLogModule(plugin: object, source: HostLogSource): void {
  const callback: unknown = typeof plugin === 'function' ? plugin : Reflect.get(plugin, 'apply')
  if (typeof callback === 'function') modules.set(callback, source)
}
const active = new AsyncLocalStorage<Owner>()
const consoles = new Set<HostLogSink>()
let restoreConsole: (() => void) | undefined
export const withLogOwner = <T>(owner: Owner, callback: () => T): T => active.run(owner, callback)
export function bindLogOwner(context: Context, sink: HostLogSink, source: HostLogSource, scope?: HostLogScope): void {
  owners.set(context.fiber, { sink, source, ...(scope === undefined ? {} : { scope }) })
}
function ownerOf(fiber: Fiber | undefined, sink: HostLogSink): Owner | undefined {
  const seen = new Set<Fiber>()
  let source: HostLogSource | undefined
  let scope: HostLogScope | undefined
  while (fiber && !seen.has(fiber)) {
    const owner = owners.get(fiber)
    source ??= owner?.source ?? (fiber.runtime ? modules.get(fiber.runtime.callback) : undefined)
    if (owner?.scope) scope = { ...owner.scope, ...scope }
    seen.add(fiber)
    fiber = fiber.parent.fiber
  }
  return source === undefined ? undefined : { sink, source, ...(scope === undefined ? {} : { scope }) }
}
export function attachCordisLogs(context: Context, sink: HostLogSink): () => void {
  const dispose = context.logger.exporter({
    levels: { default: 3 },
    colors: false,
    export(message) {
      try {
        const owner = ownerOf(message.fiber?.deref(), sink)
        const first: unknown = message.args[0]
        sink.write({
          level: message.type,
          message: typeof first === 'string' ? first : first instanceof Error ? first.message : '组件输出了一条日志。',
          source: owner?.source ?? {
            kind: 'system',
            id: `dsh:${message.name}`,
            name: `引擎 · ${message.name}`,
            component: message.name,
          },
          ...(owner?.scope === undefined ? {} : { scope: owner.scope }),
          formatArgs: typeof first === 'string' ? message.args.slice(1) : message.args,
        })
      } catch {
        /* Exporters must never throw into Cordis's caller. */
      }
    },
  })
  return () => {
    void dispose()
  }
}
export function attachConsoleLogs(sink: HostLogSink): () => void {
  consoles.add(sink)
  if (!restoreConsole) {
    const original = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
      debug: console.debug,
    }
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      console[method] = (...args: unknown[]) => {
        original[method](...args)
        try {
          const owner = active.getStore()
          const target = owner?.sink ?? (consoles.size === 1 ? consoles.values().next().value : undefined)
          if (!target) return
          const first = args[0]
          target.write({
            level: method === 'log' ? 'info' : method,
            source: owner?.source ?? { kind: 'unknown', id: 'console', name: '未识别来源' },
            ...(owner?.scope === undefined ? {} : { scope: owner.scope }),
            message: typeof first === 'string' ? first : first instanceof Error ? first.message : '控制台输出。',
            formatArgs: typeof first === 'string' ? args.slice(1) : args,
          })
        } catch {
          /* Console compatibility must preserve the original call. */
        }
      }
    }
    restoreConsole = () => {
      Object.assign(console, original)
      restoreConsole = undefined
    }
  }
  return () => {
    consoles.delete(sink)
    if (!consoles.size) restoreConsole?.()
  }
}
