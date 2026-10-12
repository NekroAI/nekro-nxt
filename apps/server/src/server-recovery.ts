import { startHttpListener } from './http-listener.js'
import { loadOrCreateCertificate } from './management-edge.js'

export const recoveryPage = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>启动恢复 · NekroNXT</title><style>
:root{color-scheme:light dark;font-family:system-ui,sans-serif;background:#f4f5f7;color:#25344b}body{margin:0;min-height:100vh;display:grid;place-items:center}main{box-sizing:border-box;width:min(560px,calc(100% - 40px));padding:32px;border:1px solid #cbd3df;border-radius:16px;background:#fff}h1{font-size:24px;margin:12px 0 24px}p,li{line-height:1.8}li+li{margin-top:8px}ol{padding-left:24px}a{color:#345da0}small{color:#68758a}@media(prefers-color-scheme:dark){:root{background:#0c1728;color:#dce5f3}main{background:#15243a;border-color:#35465f}small{color:#a0afc5}a{color:#9abbf2}}@media(max-width:480px){main{padding:24px}}
</style></head><body><main><small>NekroNXT · 启动恢复</small><h1>启动未完成</h1><p>服务已停止处理消息，数据和已有备份已保留。</p><ol><li>请管理员查看服务端启动日志，确认失败原因。</li><li>修复原因后，停止服务，在原启动命令后加 <code>--retry-upgrade</code> 重试一次。</li><li>需要恢复备份时，先停止服务，再按恢复指南操作。恢复会回到备份时的数据。</li></ol><p><a href="https://github.com/NekroAI/nekro-nxt/blob/main/docs/guide/upgrade-backup.md" rel="noreferrer">查看备份与恢复指南</a></p><small>此页面只显示启动状态，不能读取实例数据或执行恢复。</small></main></body></html>`

/** No Core repository, authentication bypass, data routes or writes are exposed by the recovery listener. */
export async function startRecoveryServer(options: {
  readonly host: '127.0.0.1' | '0.0.0.0'
  readonly port: number
  readonly dataRoot: string
  readonly releaseId: string
  readonly secure: boolean
}) {
  const certificate = options.secure ? await loadOrCreateCertificate(options.dataRoot, 'recovery') : undefined
  const server = await startHttpListener({
    host: options.host,
    port: options.port,
    ...(certificate === undefined ? {} : { tls: certificate }),
    handler: (request, response) => {
      const headers = {
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'content-security-policy':
          "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { ...headers, allow: 'GET, HEAD' })
        response.end()
        return
      }
      let pathname: string
      try {
        pathname = new URL(request.url ?? '/', 'http://localhost').pathname
      } catch {
        response.writeHead(400, headers)
        response.end()
        return
      }
      const live = pathname === '/health/live'
      const isPage =
        pathname === '/' ||
        pathname === '/recovery' ||
        (!pathname.startsWith('/api/') &&
          !pathname.startsWith('/health/') &&
          (request.headers.accept ?? '').includes('text/html'))
      const body = isPage
        ? recoveryPage
        : JSON.stringify({
            status: live ? 'live' : 'recovery',
            releaseId: options.releaseId,
            reason: 'startup-failed',
          })
      response.writeHead(live ? 200 : 503, {
        ...headers,
        'content-type': isPage ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
      })
      response.end(request.method === 'HEAD' ? undefined : body)
    },
  })
  return { ...server, secure: options.secure, recovery: true as const }
}
