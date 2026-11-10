import { HostApiContracts, ManagementDeviceIdSchema, type ManagementDeviceId } from '@nekro-nxt/contracts'
import { readJsonBody, writeContractJson, writeError, type HostRouteContext } from './host-route-support.js'
import { LOCAL_VIEWER, viewerKeyFromRequest } from './viewer.js'

const deviceOf = (viewer: string): ManagementDeviceId | undefined =>
  viewer === LOCAL_VIEWER ? undefined : ManagementDeviceIdSchema.parse(viewer.slice('device:'.length))

/**
 * Browser push subscriptions. Mount ONLY on the management Host: a subscription belongs to the login device the edge
 * names in the viewer header, so the local console, which has no device, can list but not subscribe.
 */
export function registerPushRoutes({ runtime, registerRoute }: HostRouteContext): void {
  registerRoute({
    kind: 'prefix',
    path: '/api/push',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const deviceId = deviceOf(viewerKeyFromRequest(req))
      try {
        if (req.method === 'GET' && url.pathname === '/api/push/key') {
          writeContractJson(res, 200, HostApiContracts.getWebPushKey, {
            publicKey: await runtime.notifications.webPushPublicKey(),
          })
          return
        }
        if (req.method === 'GET' && url.pathname === '/api/push/subscriptions') {
          writeContractJson(res, 200, HostApiContracts.listPushSubscriptions, {
            subscriptions: [...runtime.notifications.listPushSubscriptions()],
            ...(deviceId === undefined ? {} : { currentDeviceId: deviceId }),
          })
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/push/subscriptions') {
          if (deviceId === undefined) {
            writeError(res, 403, 'push-needs-device', '本机控制台没有登录设备，不能开启浏览器推送。')
            return
          }
          const body = HostApiContracts.registerPushSubscription.parseRequest(await readJsonBody(req))
          writeContractJson(
            res,
            200,
            HostApiContracts.registerPushSubscription,
            runtime.notifications.registerPushSubscription(deviceId, body),
          )
          return
        }
        const match = /^\/api\/push\/subscriptions\/([^/]+)(\/test)?$/u.exec(url.pathname)
        if (match !== null) {
          const subscriptionId = decodeURIComponent(match[1]!)
          if (req.method === 'DELETE' && match[2] === undefined) {
            HostApiContracts.deletePushSubscription.parseParams({ subscriptionId })
            if (!runtime.notifications.removePushSubscription(subscriptionId)) {
              writeError(res, 404, 'not-found', '这个订阅已经不存在。')
              return
            }
            writeContractJson(res, 200, HostApiContracts.deletePushSubscription, { deleted: true })
            return
          }
          if (req.method === 'POST' && match[2] !== undefined) {
            HostApiContracts.testPushSubscription.parseParams({ subscriptionId })
            await runtime.notifications.testPushSubscription(subscriptionId)
            writeContractJson(res, 200, HostApiContracts.testPushSubscription, { sent: true })
            return
          }
        }
        writeError(res, 404, 'not-found', '未定义的推送接口。')
      } catch (error) {
        writeError(res, 400, 'push-request-failed', error instanceof Error ? error.message : '推送请求失败。')
      }
    },
  })
}
