/** Host RPC a dynamic candidate with an inbound hook exposes only to the Host verifier; never saved or shown. */
export const INBOUND_DYNAMIC_PROBE_METHOD = '__nekro_nxt_inbound_probe_v1'

/**
 * The DSH dynamic sandbox has no `harness.onInbound`. For candidates that declare an inbound hook, the Host wraps the
 * source: `onInbound` records the handler at factory time, the plugin's `apply` captures `ctx.nxt`, and a private RPC
 * lets the verifier call the handler with a synthetic message. The saved Revision keeps the original source.
 */
export const wrapInboundDynamicHostSource = (source: string): string => `
const __nxtInbound = { handler: undefined, nxt: undefined }
harness.onInbound = (handler) => {
  if (typeof handler !== 'function') throw new TypeError('harness.onInbound 需要一个处理函数。')
  if (__nxtInbound.handler !== undefined) throw new Error('一个扩展只能注册一个入站处理函数。')
  __nxtInbound.handler = handler
  return () => { __nxtInbound.handler = undefined }
}
harness.handle('${INBOUND_DYNAMIC_PROBE_METHOD}', async (message) => {
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
})
const __nxtPlugin = (() => {
${source}
})()
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
