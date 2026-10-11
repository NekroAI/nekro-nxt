import { HostApiContracts, type AgentId, type CommandAccountsView } from '@nekro-nxt/contracts'
import { CommandAccountError } from './command-accounts.js'
import { writeContractJson, writeError, readJsonBody, type HostRouteContext } from './host-route-support.js'
import type { NekroRuntime } from './bootstrap.js'

/** The agents whose capabilities currently grant each account. */
export const accountUsage = (
  commits: ReadonlyArray<{
    readonly definition: { readonly id: AgentId }
    readonly revision: {
      readonly capabilities: { readonly commandAccounts: ReadonlyArray<{ readonly accountId: string }> }
    }
  }>,
): Map<string, AgentId[]> => {
  const usage = new Map<string, AgentId[]>()
  for (const commit of commits) {
    for (const grant of commit.revision.capabilities.commandAccounts) {
      usage.set(grant.accountId, [...(usage.get(grant.accountId) ?? []), commit.definition.id])
    }
  }
  return usage
}

const view = async (runtime: NekroRuntime): Promise<CommandAccountsView> => ({
  accounts: runtime.commandAccounts.list(accountUsage(runtime.core.listAgents())),
  localLogins: await runtime.commandAccounts.localLogins(),
})

/** The account library and the GitHub CLI download; grants themselves are part of an agent's capabilities. */
export function registerCommandAccountRoutes({ runtime, registerRoute, broadcast }: HostRouteContext): () => void {
  const changed = () => broadcast({ event: 'snapshot-changed', data: { changed: true } })
  const unsubscribeAccounts = runtime.commandAccounts.subscribe(changed)
  const unsubscribeCli = runtime.githubCli.subscribe(changed)
  const reject = (res: Parameters<typeof writeError>[0], error: unknown) =>
    writeError(
      res,
      error instanceof CommandAccountError ? 400 : 500,
      'command-account-failed',
      error instanceof Error ? error.message : String(error),
    )

  registerRoute({
    kind: 'prefix',
    path: '/api/settings/command-accounts',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const match = /^\/api\/settings\/command-accounts(?:\/([^/]+))?$/u.exec(url.pathname)
      if (match === null) {
        writeError(res, 404, 'not-found', `Unknown route: ${req.method} ${url.pathname}`)
        return
      }
      const accountId = match[1] === undefined ? undefined : decodeURIComponent(match[1])
      try {
        if (accountId === undefined && req.method === 'GET') {
          writeContractJson(res, 200, HostApiContracts.getCommandAccounts, await view(runtime))
          return
        }
        if (accountId === undefined && req.method === 'POST') {
          await runtime.commandAccounts.add(HostApiContracts.addCommandAccount.parseRequest(await readJsonBody(req)))
          writeContractJson(res, 200, HostApiContracts.addCommandAccount, await view(runtime))
          return
        }
        if (accountId !== undefined && req.method === 'PUT') {
          await runtime.commandAccounts.replaceToken(
            accountId,
            HostApiContracts.replaceCommandAccountToken.parseRequest(await readJsonBody(req)),
          )
          writeContractJson(res, 200, HostApiContracts.replaceCommandAccountToken, await view(runtime))
          return
        }
        if (accountId !== undefined && req.method === 'DELETE') {
          await runtime.commandAccounts.remove(accountId)
          writeContractJson(res, 200, HostApiContracts.removeCommandAccount, await view(runtime))
          return
        }
        writeError(res, 405, 'method-not-allowed', 'Method not allowed.')
      } catch (error) {
        reject(res, error)
      }
    },
  })
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
    unsubscribeAccounts()
    unsubscribeCli()
  }
}

/** Grants may only name accounts the library holds, one per service. */
export const knownCommandAccounts = <Grant extends { readonly accountId: string }>(
  runtime: NekroRuntime,
  grants: readonly Grant[],
): Grant[] => {
  for (const grant of grants) {
    if (!runtime.commandAccounts.has(grant.accountId)) throw new Error('授权的账号已不存在，请刷新后重试。')
  }
  return [...grants]
}
