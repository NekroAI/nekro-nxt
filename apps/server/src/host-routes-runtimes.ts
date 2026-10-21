import { HostApiContracts } from '@nekro-nxt/contracts'
import { writeContractJson, writeError, type HostRouteContext } from './host-route-support.js'

/** The programs NekroNXT can download for agents' commands and checks: the GitHub CLI and the verification browser. */
export function registerRuntimeRoutes({ runtime, registerRoute, broadcast }: HostRouteContext): () => void {
  const changed = () => broadcast({ event: 'snapshot-changed', data: { changed: true } })
  const unsubscribeCli = runtime.githubCli.subscribe(changed)
  const unsubscribeBrowser = runtime.verificationBrowser.subscribe(changed)
  registerRoute({
    kind: 'exact',
    path: '/api/runtimes/github-cli/download',
    handler: (req, res) => {
      if (req.method !== 'POST') {
        writeError(res, 405, 'method-not-allowed', 'Method not allowed.')
        return
      }
      try {
        writeContractJson(res, 200, HostApiContracts.downloadGithubCli, runtime.githubCli.startDownload())
      } catch (error) {
        writeError(res, 400, 'github-cli-unavailable', error instanceof Error ? error.message : String(error))
      }
    },
  })
  registerRoute({
    kind: 'exact',
    path: '/api/runtimes/verification-browser/download',
    handler: (req, res) => {
      if (req.method !== 'POST') {
        writeError(res, 405, 'method-not-allowed', 'Method not allowed.')
        return
      }
      writeContractJson(
        res,
        200,
        HostApiContracts.downloadVerificationBrowser,
        runtime.verificationBrowser.startDownload(),
      )
    },
  })
  registerRoute({
    kind: 'exact',
    path: '/api/runtimes/verification-browser',
    handler: async (req, res) => {
      if (req.method !== 'DELETE') {
        writeError(res, 405, 'method-not-allowed', 'Method not allowed.')
        return
      }
      try {
        writeContractJson(
          res,
          200,
          HostApiContracts.removeVerificationBrowser,
          await runtime.verificationBrowser.removeDownloaded(),
        )
      } catch (error) {
        writeError(res, 400, 'verification-browser-busy', error instanceof Error ? error.message : String(error))
      }
    },
  })
  registerRoute({
    kind: 'exact',
    path: '/api/runtimes/github-cli',
    handler: async (req, res) => {
      if (req.method !== 'DELETE') {
        writeError(res, 405, 'method-not-allowed', 'Method not allowed.')
        return
      }
      try {
        writeContractJson(res, 200, HostApiContracts.removeGithubCli, await runtime.githubCli.removeDownloaded())
      } catch (error) {
        writeError(res, 400, 'github-cli-busy', error instanceof Error ? error.message : String(error))
      }
    },
  })
  return () => {
    unsubscribeCli()
    unsubscribeBrowser()
  }
}
