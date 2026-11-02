import { AddonIdSchema, HostApiContracts } from '@nekro-nxt/contracts'
import { AddonRequestError } from './addons.js'
import type { NekroRuntime } from './bootstrap.js'
import { readJsonBody, writeContractJson, writeError, type HostRouteContext } from './host-route-support.js'

/**
 * 设置 → 附加功能 (附加功能 F2): list the add-ons, install or remove one of their providers, choose the one in use,
 * and the settings of speech recognition's cloud provider. Every change also reaches pages as a snapshot change.
 */
export function registerAddonRoutes({
  runtime,
  registerRoute,
  broadcast,
}: Pick<HostRouteContext, 'registerRoute' | 'broadcast'> & {
  readonly runtime: Pick<NekroRuntime, 'addons' | 'speechCloud'>
}): () => void {
  const unsubscribe = runtime.addons.subscribe(() => broadcast({ event: 'snapshot-changed', data: { changed: true } }))
  registerRoute({
    kind: 'prefix',
    path: '/api/addons',
    handler: async (req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
      if (pathname === '/api/addons') {
        if (req.method !== 'GET') {
          writeError(res, 405, 'method-not-allowed', 'Method not allowed.')
          return
        }
        writeContractJson(res, 200, HostApiContracts.listAddons, { addons: runtime.addons.list() })
        return
      }
      const match = /^\/api\/addons\/([^/]+)\/(?:selection|providers\/([^/]+)(\/install)?)$/u.exec(pathname)
      const id = AddonIdSchema.safeParse(decodeURIComponent(match?.[1] ?? ''))
      if (match === null || !id.success) {
        writeError(res, 404, 'addon-not-found', '没有这项附加功能。')
        return
      }
      const provider = match[2] === undefined ? undefined : decodeURIComponent(match[2])
      const expected = provider === undefined ? 'PUT' : match[3] === undefined ? 'DELETE' : 'POST'
      if (req.method !== expected) {
        writeError(res, 405, 'method-not-allowed', 'Method not allowed.')
        return
      }
      try {
        if (provider === undefined) {
          const request = HostApiContracts.selectAddonProvider.parseRequest(await readJsonBody(req))
          writeContractJson(
            res,
            200,
            HostApiContracts.selectAddonProvider,
            runtime.addons.select(id.data, request.provider),
          )
        } else if (expected === 'POST') {
          writeContractJson(res, 200, HostApiContracts.installAddonProvider, runtime.addons.install(id.data, provider))
        } else {
          writeContractJson(
            res,
            200,
            HostApiContracts.removeAddonProvider,
            await runtime.addons.remove(id.data, provider),
          )
        }
      } catch (error) {
        if (error instanceof AddonRequestError) {
          writeError(res, error.code === 'addon-not-found' ? 404 : 400, error.code, error.message)
        } else writeError(res, 400, 'addon-failed', error instanceof Error ? error.message : String(error))
      }
    },
  })
  registerRoute({
    kind: 'exact',
    path: '/api/settings/speech',
    handler: async (req, res) => {
      try {
        if (req.method === 'GET') {
          writeContractJson(res, 200, HostApiContracts.getSpeechSettings, await runtime.speechCloud.view())
          return
        }
        if (req.method === 'PUT') {
          const { cloud } = HostApiContracts.updateSpeechSettings.parseRequest(await readJsonBody(req))
          const view = await runtime.speechCloud.update(cloud)
          // Whoever sets up the cloud means to use it, as with installing a provider.
          if (cloud !== null) runtime.addons.select('speech', 'cloud')
          writeContractJson(res, 200, HostApiContracts.updateSpeechSettings, view)
          return
        }
        writeError(res, 405, 'method-not-allowed', 'Method not allowed.')
      } catch (error) {
        writeError(res, 400, 'speech-settings-failed', error instanceof Error ? error.message : String(error))
      }
    },
  })
  return unsubscribe
}
