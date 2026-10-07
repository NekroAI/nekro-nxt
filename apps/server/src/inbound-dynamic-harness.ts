/** Host RPC a dynamic candidate with an inbound hook exposes only to the Host verifier; never saved or shown. */
export const INBOUND_DYNAMIC_PROBE_METHOD = '__nekro_nxt_inbound_probe_v1'

/**
 * The DSH dynamic sandbox has no `harness.onInbound` or `harness.onJob`. For candidates that declare an inbound hook
 * or jobs, the Host wraps the source: both record their handler at factory time and the plugin's `apply` captures
 * `ctx.nxt`. With an inbound hook, a private RPC lets the verifier call that handler with a synthetic message; jobs
 * never fire in dynamic runs, so the job handler is only recorded. The saved Revision keeps the original source.
 */
export const wrapInboundDynamicHostSource = (source: string, options: { readonly inbound: boolean }): string => `
const __nxtInbound = { handler: undefined, job: undefined, nxt: undefined, factoryOpen: true }
harness.onInbound = (handler) => {
  if (!__nxtInbound.factoryOpen) {
    throw new Error('harness.onInbound 必须在 factory 阶段（Host 源码顶层、return 之前）注册，不能在 apply 或工具里注册。')
  }
  if (typeof handler !== 'function') throw new TypeError('harness.onInbound 需要一个处理函数。')
  if (__nxtInbound.handler !== undefined) throw new Error('一个扩展只能注册一个入站处理函数。')
  __nxtInbound.handler = handler
  return () => { __nxtInbound.handler = undefined }
}
harness.onJob = (handler) => {
  if (!__nxtInbound.factoryOpen) {
    throw new Error('harness.onJob 必须在 factory 阶段（Host 源码顶层、return 之前）注册，不能在 apply 或工具里注册。')
  }
  if (typeof handler !== 'function') throw new TypeError('harness.onJob 需要一个处理函数。')
  if (__nxtInbound.job !== undefined) throw new Error('一个扩展只能注册一个定时任务处理函数。')
  __nxtInbound.job = handler
  return () => { __nxtInbound.job = undefined }
}
${
  !options.inbound
    ? ''
    : `harness.handle('${INBOUND_DYNAMIC_PROBE_METHOD}', async (message) => {
  if (__nxtInbound.handler === undefined) throw new Error('声明了 inboundHook，但 Host 没有调用 harness.onInbound 注册处理函数。')
  const probe = message ?? {
    logicalMessageId: 'msg_PREVIEW',
    channel: { id: 'chn_PREVIEW', kind: 'group', displayName: '预览频道' },
    sender: { memberId: 'mbr_PREVIEW', displayName: '预览成员' },
    text: '预览消息',
    mentionsAgent: true,
    wouldTrigger: true,
    receivedAt: 1,
  }
  const decision = await __nxtInbound.handler(probe, __nxtInbound.nxt)
  return decision === undefined ? null : JSON.parse(JSON.stringify(decision))
})`
}
const __nxtPlugin = (() => {
${source}
})()
__nxtInbound.factoryOpen = false
const __nxtApply = typeof __nxtPlugin === 'function' ? __nxtPlugin : __nxtPlugin.apply
return {
  ...(typeof __nxtPlugin === 'function' ? {} : __nxtPlugin),
  inject: [...new Set([...((typeof __nxtPlugin === 'function' ? undefined : __nxtPlugin.inject) ?? []), 'nxt'])],
  apply(ctx, config) {
    __nxtInbound.nxt = ctx.nxt
    return __nxtApply.call(__nxtPlugin, ctx, config)
  },
}
`
