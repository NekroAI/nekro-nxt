import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * Without a management key the Server has no sign-in, and everything arriving from this machine is the local console.
 * A reverse proxy on the same machine also arrives from here, so a proxied request would get the console's full
 * trust. Proxies add these headers; plain local clients (the console, Desktop, the Vite dev proxy) do not.
 */
const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'x-real-ip'] as const

export const arrivedThroughProxy = (request: IncomingMessage): boolean =>
  PROXY_HEADERS.some((name) => request.headers[name] !== undefined)

export const PROXY_WITHOUT_SIGN_IN_MESSAGE =
  '这个实例没有设置管理密钥，不需要登录，不能经过反向代理访问。设置 NEKRO_MANAGEMENT_KEY 和 NEKRO_TRUST_PROXY（反向代理的地址）后重新启动。'

export const refuseProxiedRequest = (response: ServerResponse): void => {
  response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  response.end(PROXY_WITHOUT_SIGN_IN_MESSAGE)
}
