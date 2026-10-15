/** Host RPC a dynamic candidate with an inbound hook exposes only to the Host verifier; never saved or shown. */
export const INBOUND_DYNAMIC_PROBE_METHOD = '__nekro_nxt_inbound_probe_v1'
/** Verifier-only RPC that runs one registered chat command with sample arguments. */
export const COMMAND_DYNAMIC_PROBE_METHOD = '__nekro_nxt_command_probe_v1'
/** Verifier-only RPC that runs the registered data migration against empty storage. */
export const MIGRATION_DYNAMIC_PROBE_METHOD = '__nekro_nxt_migration_probe_v1'

/**
 * Wraps a dynamic candidate's Host half so it runs with the same factory contract as a saved Revision (扩展形态统一
 * §5). The DSH dynamic sandbox only provides `harness`; the wrapper adds:
 *
 * - `harness.onInbound` and `harness.onJob`, recorded at factory time. With an inbound hook, a private RPC lets the
 *   verifier call the handler with a synthetic message; jobs never fire in dynamic runs, so their handler is recorded.
 * - the factory's host-layer `nxt`, which resolves once the candidate is mounted (call it from RPC handlers or tools).
 * - `ctx.config()` inside the agent attachment, returning the agent configuration the candidate runs with.
 *
 * The saved Revision keeps the original source.
 */
export const wrapDynamicHostSource = (source: string, options: { readonly inbound: boolean }): string => `
const __nxtFactory = { handler: undefined, job: undefined, migration: undefined, nxt: undefined, host: undefined, factoryOpen: true }
const __nxtCommands = new Map()
const __nxtLogs = []
let __nxtLogger
const logger = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [level, (message, details) => {
  if (__nxtLogger) __nxtLogger[level](message, details)
  else if (__nxtLogs.length < 100) __nxtLogs.push([level, message, details])
}]))
harness.onInbound = (handler) => {
  if (!__nxtFactory.factoryOpen) {
    throw new Error('harness.onInbound 必须在 factory 阶段（Host 源码顶层、return 之前）注册，不能在 apply 或工具里注册。')
  }
  if (typeof handler !== 'function') throw new TypeError('harness.onInbound 需要一个处理函数。')
  if (__nxtFactory.handler !== undefined) throw new Error('一个扩展只能注册一个入站处理函数。')
  __nxtFactory.handler = handler
  return () => { __nxtFactory.handler = undefined }
}
harness.onJob = (handler) => {
  if (!__nxtFactory.factoryOpen) {
    throw new Error('harness.onJob 必须在 factory 阶段（Host 源码顶层、return 之前）注册，不能在 apply 或工具里注册。')
  }
  if (typeof handler !== 'function') throw new TypeError('harness.onJob 需要一个处理函数。')
  if (__nxtFactory.job !== undefined) throw new Error('一个扩展只能注册一个定时任务处理函数。')
  __nxtFactory.job = handler
  return () => { __nxtFactory.job = undefined }
}
harness.registerCommand = (definition, handler) => {
  if (!__nxtFactory.factoryOpen) {
    throw new Error('harness.registerCommand 必须在 factory 阶段（Host 源码顶层、return 之前）注册。')
  }
  const name = definition && typeof definition.name === 'string' ? definition.name : ''
  if (!name) throw new TypeError('harness.registerCommand 需要带 name 的命令定义。')
  if (typeof handler !== 'function') throw new TypeError('harness.registerCommand 需要一个处理函数。')
  if (__nxtCommands.has(name)) throw new Error('命令重复注册：' + name)
  __nxtCommands.set(name, handler)
  return () => { __nxtCommands.delete(name) }
}
harness.migrateData = (handler) => {
  if (!__nxtFactory.factoryOpen) {
    throw new Error('harness.migrateData 必须在 factory 阶段（Host 源码顶层、return 之前）注册。')
  }
  if (typeof handler !== 'function') throw new TypeError('harness.migrateData 需要一个处理函数。')
  if (__nxtFactory.migration !== undefined) throw new Error('一个扩展只能注册一个数据迁移。')
  __nxtFactory.migration = handler
  return () => { __nxtFactory.migration = undefined }
}
harness.handle('${COMMAND_DYNAMIC_PROBE_METHOD}', async (input) => {
  const handler = __nxtCommands.get(input && input.name)
  if (handler === undefined) throw new Error('声明了命令 /' + (input && input.name) + '，但 Host 没有用 harness.registerCommand 注册它。')
  const replies = []
  const signal = { aborted: false, reason: undefined, throwIfAborted() {}, addEventListener() {}, removeEventListener() {} }
  const result = await handler({
    channelId: 'chn_PREVIEW',
    identity: { source: 'web', displayName: '预览管理员' },
    arguments: (input && input.arguments) || {},
    signal,
    reply: (value) => { replies.push(value) },
    host: {
      status: () => ({ bound: true, responseMode: '预览', running: false }),
      stop: async () => ({ stopped: false }),
      reset: async () => undefined,
    },
  })
  return JSON.parse(JSON.stringify({ result: result === undefined ? null : result, replies, registered: [...__nxtCommands.keys()] }))
})
harness.handle('${MIGRATION_DYNAMIC_PROBE_METHOD}', async (input) => {
  if (__nxtFactory.migration === undefined) return { registered: false }
  await __nxtFactory.migration({
    from: (input && input.from) || 1,
    to: (input && input.to) || 1,
    storage: { list: async () => ({ entries: [] }), set: async () => undefined, delete: async () => false },
  })
  return { registered: true }
})
const nxt = new Proxy({}, {
  get(_target, key) {
    const host = __nxtFactory.host
    if (host === undefined) {
      throw new Error('本机层 nxt 在动态试运行中要等扩展挂载后才能使用；请在界面数据接口或工具里调用，不要在 factory 顶层调用。')
    }
    return host[key]
  },
})
${
  !options.inbound
    ? ''
    : `harness.handle('${INBOUND_DYNAMIC_PROBE_METHOD}', async (message) => {
  if (__nxtFactory.handler === undefined) throw new Error('声明了 inboundHook，但 Host 没有调用 harness.onInbound 注册处理函数。')
  const probe = message ?? {
    logicalMessageId: 'msg_PREVIEW',
    channel: { id: 'chn_PREVIEW', kind: 'group', displayName: '预览频道' },
    sender: { memberId: 'mbr_PREVIEW', displayName: '预览成员' },
    text: '预览消息',
    mentionsAgent: true,
    wouldTrigger: true,
    receivedAt: 1,
  }
  const decision = await __nxtFactory.handler(probe, __nxtFactory.nxt)
  return decision === undefined ? null : JSON.parse(JSON.stringify(decision))
})`
}
const __nxtPlugin = await (async () => {
${source}
})()
__nxtFactory.factoryOpen = false
const __nxtApply =
  __nxtPlugin === undefined || __nxtPlugin === null
    ? () => undefined
    : typeof __nxtPlugin === 'function'
      ? __nxtPlugin
      : __nxtPlugin.apply
return {
  ...(__nxtPlugin === undefined || __nxtPlugin === null || typeof __nxtPlugin === 'function' ? {} : __nxtPlugin),
  inject: [
    ...new Set([
      ...((__nxtPlugin === undefined || __nxtPlugin === null || typeof __nxtPlugin === 'function'
        ? undefined
        : __nxtPlugin.inject) ?? []),
      'nxt',
    ]),
  ],
  apply(ctx, config) {
    __nxtLogger = ctx.nxt.logger
    if (__nxtLogger) for (const [level, message, details] of __nxtLogs.splice(0)) __nxtLogger[level](message, details)
    __nxtFactory.nxt = ctx.nxt
    __nxtFactory.host = ctx.nxt.hostLayer
    const readConfig = () => ctx.nxt.config()
    const attachment = new Proxy(ctx, {
      get(target, key) {
        if (key === 'config') return readConfig
        if (key === 'logger') return logger
        return Reflect.get(target, key)
      },
    })
    return __nxtApply.call(__nxtPlugin, attachment, config)
  },
}
`
