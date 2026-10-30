import { ExtensionIdSchema, HostApiContracts } from '@nekro-nxt/contracts'
import type { ServerResponse } from 'node:http'
import { registerCommunityPersonaRoutes } from './host-routes-community-personas.js'
import { registerCommunityFeedbackRoutes } from './host-routes-feedback.js'
import {
  COMMUNITY_CALLBACK_PATH,
  CommunityError,
  FIRST_UPDATE_CHECK_DELAY_MS,
  UPDATE_CHECK_INTERVAL_MS,
} from './community.js'
import { readJsonBody, writeContractJson, writeError, type HostRouteContext } from './host-route-support.js'

const escapeHtml = (value: string): string => value.replace(/[&<>"']/gu, (char) => `&#${char.charCodeAt(0)};`)

/** 社区回跳后显示的自包含页面：无脚本、无外部资源。 */
const callbackPage = (ok: boolean, message: string): string => `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${ok ? '已登录社区' : '登录社区未完成'} · NekroNXT</title>
<style>
:root { color-scheme: light dark; --bg: #f3f1ec; --surface: #fffefb; --fg: #14243d; --muted: #566275; --line: rgb(23 42 69 / 0.09); --accent: ${ok ? '#1b6843' : '#b03a30'}; }
@media (prefers-color-scheme: dark) { :root { --bg: #0b1524; --surface: #12223a; --fg: #eef2f8; --muted: #8e9bb0; --line: rgb(190 210 240 / 0.09); --accent: ${ok ? '#6dcf98' : '#f08f83'}; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--fg);
  font: 14px/1.6 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', system-ui, sans-serif; }
main { width: 100%; max-width: 380px; background: var(--surface); border: 1px solid var(--line); border-radius: 16px; padding: 28px; text-align: center; }
.mark { width: 44px; height: 44px; border-radius: 50%; margin: 0 auto 14px; display: grid; place-items: center; background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); font-size: 22px; font-weight: 600; }
h1 { margin: 0 0 6px; font-size: 18px; }
p { margin: 0; color: var(--muted); }
</style>
</head>
<body>
<main>
<div class="mark" aria-hidden="true">${ok ? '✓' : '!'}</div>
<h1>${ok ? '已登录社区' : '登录社区未完成'}</h1>
<p>${escapeHtml(message)}</p>
</main>
</body>
</html>`

const writeCallbackPage = (res: ServerResponse, status: number, ok: boolean, message: string): void => {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy':
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  })
  res.end(callbackPage(ok, message))
}

const communityFailure = (res: ServerResponse, error: unknown, fallbackCode: string): void => {
  if (error instanceof CommunityError) {
    writeError(res, error.status, error.code, error.message)
    return
  }
  writeError(res, 400, fallbackCode, error instanceof Error ? error.message : String(error))
}

/**
 * 社区账号、目录浏览、安装与发布。安装复用本地文件导入的检查与确认；发布导出所选版本后上传。
 * `/community/callback` 是社区授权后的回跳页，在安全入口中免登录，凭一次性 state 完成登录。
 */
export function registerCommunityRoutes(context: HostRouteContext): () => void {
  const { runtime, registerRoute, extensionImports, broadcastExtensionsChanged } = context
  const community = runtime.community
  registerCommunityPersonaRoutes(context)
  const disposeFeedback = registerCommunityFeedbackRoutes(context)
  const checkSync = () => runtime.communitySync.check()
  // 每天检查一次社区更新；失败静默，下次打开社区时会再检查。
  const timer = setInterval(() => {
    void checkSync().catch(() => undefined)
    void runtime.feedback.sync().catch(() => undefined)
  }, UPDATE_CHECK_INTERVAL_MS)
  timer.unref()
  // 启动后先查一次，不必等满一天；稍等片刻，不和启动时的其他工作抢网络。没有和社区关联的扩展时不查。
  const first = setTimeout(() => {
    if (runtime.repository.listExtensionCommunityLinks().length === 0) return
    void checkSync().catch(() => undefined)
  }, FIRST_UPDATE_CHECK_DELAY_MS)
  first.unref()

  registerRoute({
    kind: 'exact',
    path: '/api/community/endpoint',
    handler: async (req, res) => {
      try {
        if (req.method === 'GET') {
          writeContractJson(res, 200, HostApiContracts.getCommunityEndpoint, community.endpoint())
          return
        }
        if (req.method === 'PUT') {
          const input = HostApiContracts.updateCommunityEndpoint.parseRequest(await readJsonBody(req))
          writeContractJson(
            res,
            200,
            HostApiContracts.updateCommunityEndpoint,
            community.setEndpoint(input.url, input.acknowledgeInsecure),
          )
          return
        }
        writeError(res, 405, 'method-not-allowed', 'Method not allowed.')
      } catch (error) {
        communityFailure(res, error, 'community-endpoint-invalid')
      }
    },
  })

  registerRoute({
    kind: 'exact',
    path: '/api/community/endpoint/test',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        writeError(res, 405, 'method-not-allowed', 'Method not allowed.')
        return
      }
      try {
        const input = HostApiContracts.testCommunityEndpoint.parseRequest(await readJsonBody(req))
        writeContractJson(
          res,
          200,
          HostApiContracts.testCommunityEndpoint,
          await community.testEndpoint(input.url, input.acknowledgeInsecure),
        )
      } catch (error) {
        communityFailure(res, error, 'community-endpoint-invalid')
      }
    },
  })

  registerRoute({
    kind: 'exact',
    path: '/api/community/sync',
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        writeError(res, 405, 'method-not-allowed', 'Method not allowed.')
        return
      }
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const cached = url.searchParams.get('refresh') === '1' ? undefined : runtime.communitySync.cached()
        writeContractJson(res, 200, HostApiContracts.listCommunitySync, cached ?? (await checkSync()))
      } catch (error) {
        communityFailure(res, error, 'community-request-failed')
      }
    },
  })

  registerRoute({
    kind: 'exact',
    path: '/api/community/mine',
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        writeError(res, 405, 'method-not-allowed', 'Method not allowed.')
        return
      }
      try {
        writeContractJson(res, 200, HostApiContracts.listCommunityMine, { items: await community.mine() })
      } catch (error) {
        communityFailure(res, error, 'community-request-failed')
      }
    },
  })

  registerRoute({
    kind: 'exact',
    path: COMMUNITY_CALLBACK_PATH,
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        writeError(res, 405, 'method-not-allowed', 'Method not allowed.')
        return
      }
      try {
        const account = await community.completeLogin(new URL(req.url ?? '/', 'http://localhost').searchParams)
        writeCallbackPage(res, 200, true, `已用 @${account.handle} 登录社区。可以关闭这个页面，回到 NekroNXT。`)
      } catch (error) {
        writeCallbackPage(
          res,
          400,
          false,
          error instanceof CommunityError ? error.message : '登录失败，请回到 NekroNXT 重新登录社区。',
        )
      }
    },
  })

  registerRoute({
    kind: 'exact',
    path: '/api/community/status',
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        writeError(res, 405, 'method-not-allowed', 'Method not allowed.')
        return
      }
      writeContractJson(res, 200, HostApiContracts.getCommunityStatus, await community.status())
    },
  })

  registerRoute({
    kind: 'exact',
    path: '/api/community/login',
    handler: async (req, res) => {
      try {
        if (req.method === 'POST') {
          const input = HostApiContracts.startCommunityLogin.parseRequest(await readJsonBody(req))
          writeContractJson(res, 200, HostApiContracts.startCommunityLogin, {
            authorizeUrl: community.startLogin(input.returnOrigin),
          })
          return
        }
        if (req.method === 'DELETE') {
          writeContractJson(res, 200, HostApiContracts.communityLogout, await community.logout())
          return
        }
        writeError(res, 405, 'method-not-allowed', 'Method not allowed.')
      } catch (error) {
        communityFailure(res, error, 'community-login-failed')
      }
    },
  })

  registerRoute({
    kind: 'exact',
    path: '/api/community/publish',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        writeError(res, 405, 'method-not-allowed', 'Method not allowed.')
        return
      }
      try {
        const input = HostApiContracts.publishToCommunity.parseRequest(await readJsonBody(req))
        const { revision: _revision, ...published } = await runtime.extensionActions.publishRevision({
          extensionId: input.extensionId,
          revisionId: input.revisionId,
          notes: input.notes,
          ...(input.listing === undefined ? {} : { listing: input.listing }),
        })
        void _revision
        writeContractJson(res, 200, HostApiContracts.publishToCommunity, published)
        broadcastExtensionsChanged()
      } catch (error) {
        communityFailure(res, error, 'community-publish-failed')
      }
    },
  })

  registerRoute({
    kind: 'prefix',
    path: '/api/community',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      try {
        if (url.pathname === '/api/community/extensions') {
          if (req.method !== 'GET') {
            writeError(res, 405, 'method-not-allowed', 'Method not allowed.')
            return
          }
          const params = HostApiContracts.listCommunityExtensions.parseParams({
            ...(url.searchParams.get('query') ? { query: url.searchParams.get('query') } : {}),
            ...(url.searchParams.get('provides') ? { provides: url.searchParams.get('provides') } : {}),
            ...(url.searchParams.get('official') ? { official: url.searchParams.get('official') } : {}),
            ...(url.searchParams.get('sort') ? { sort: url.searchParams.get('sort') } : {}),
            ...(url.searchParams.get('cursor') ? { cursor: url.searchParams.get('cursor') } : {}),
            ...(url.searchParams.get('refresh') ? { refresh: url.searchParams.get('refresh') } : {}),
          })
          const { refresh, ...query } = params
          writeContractJson(
            res,
            200,
            HostApiContracts.listCommunityExtensions,
            await community.cachedRead('extensions', query, refresh === '1', () => community.listExtensions(query)),
          )
          return
        }
        const extensionMatch = /^\/api\/community\/extensions\/([^/]+)$/u.exec(url.pathname)
        if (extensionMatch) {
          if (req.method !== 'GET') {
            writeError(res, 405, 'method-not-allowed', 'Method not allowed.')
            return
          }
          const extensionId = ExtensionIdSchema.parse(decodeURIComponent(extensionMatch[1] ?? ''))
          writeContractJson(
            res,
            200,
            HostApiContracts.getCommunityExtension,
            await community.cachedRead('extension', { extensionId }, url.searchParams.get('refresh') === '1', () =>
              community.getExtension(extensionId),
            ),
          )
          return
        }
        const reviewMatch = /^\/api\/community\/releases\/([^/]+)\/review$/u.exec(url.pathname)
        if (reviewMatch) {
          const releaseId = HostApiContracts.getCommunityReleaseReview.parseParams({
            releaseId: decodeURIComponent(reviewMatch[1] ?? ''),
          }).releaseId
          if (req.method === 'GET') {
            writeContractJson(res, 200, HostApiContracts.getCommunityReleaseReview, await community.review(releaseId))
            return
          }
          if (req.method === 'POST') {
            await community.requestReview(releaseId)
            writeContractJson(res, 200, HostApiContracts.requestCommunityReview, { ok: true })
            return
          }
          writeError(res, 405, 'method-not-allowed', 'Method not allowed.')
          return
        }
        const withdrawMatch = /^\/api\/community\/releases\/([^/]+)\/withdraw$/u.exec(url.pathname)
        if (withdrawMatch) {
          if (req.method !== 'POST') {
            writeError(res, 405, 'method-not-allowed', 'Method not allowed.')
            return
          }
          const releaseId = HostApiContracts.withdrawCommunityRelease.parseParams({
            releaseId: decodeURIComponent(withdrawMatch[1] ?? ''),
          }).releaseId
          await community.withdraw(releaseId)
          writeContractJson(res, 200, HostApiContracts.withdrawCommunityRelease, { ok: true })
          return
        }
        const importMatch = /^\/api\/community\/releases\/([^/]+)\/import$/u.exec(url.pathname)
        if (importMatch) {
          if (req.method !== 'POST') {
            writeError(res, 405, 'method-not-allowed', 'Method not allowed.')
            return
          }
          const params = HostApiContracts.importCommunityRelease.parseParams({
            releaseId: decodeURIComponent(importMatch[1] ?? ''),
          })
          const bytes = await community.downloadRelease(params.releaseId)
          const inspection = extensionImports.inspect(runtime, bytes)
          const detail = await community.getExtension(inspection.extensionId)
          const release = detail.latest?.id === params.releaseId ? detail.latest : undefined
          extensionImports.attachSource(inspection.token, {
            communityUrl: community.communityUrl,
            releaseId: params.releaseId,
            ...(release?.number === undefined ? {} : { number: release.number }),
            publisherHandle: detail.publisher.handle,
          })
          writeContractJson(res, 200, HostApiContracts.importCommunityRelease, inspection)
          return
        }
        writeError(res, 404, 'not-found', 'Unknown route.')
      } catch (error) {
        communityFailure(res, error, 'community-request-failed')
      }
    },
  })

  return () => {
    clearInterval(timer)
    clearTimeout(first)
    disposeFeedback()
  }
}
