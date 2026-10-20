import {
  HostApiContracts,
  type AddCommandAccountRequest,
  type AgentId,
  type CommandAccount,
  type CommandAccountsView,
} from '@nekro-nxt/contracts'
import { CredentialError, accountIdOfCredential, credentialIdOfAccount } from './credentials-library.js'
import { writeContractJson, writeError, readJsonBody, type HostRouteContext } from './host-route-support.js'
import type { NekroRuntime } from './bootstrap.js'
import { fulfilCredentialRequests } from './host-routes-credentials.js'

/**
 * GitHub credentials in the shape of the older command account library. The routes below keep that library's
 * contract working on top of the credential library until every client manages credentials directly.
 */
export const commandAccounts = (runtime: NekroRuntime): CommandAccount[] =>
  runtime.credentialLibrary
    .list()
    .filter((record) => record.kind === 'github')
    .map((record) => ({
      id: accountIdOfCredential(record.id),
      service: 'github' as const,
      login: record.metadata.login ?? record.name,
      source: record.metadata.source ?? 'token',
      ...(record.metadata.scopes === undefined ? {} : { scopes: [...record.metadata.scopes] }),
      createdAt: record.createdAt,
      // The older page lists the agents an account is granted to: the credential's scope.
      usedBy:
        'all' in record.agentScope
          ? runtime.core.listAgents().map((commit) => commit.definition.id)
          : [...record.agentScope.agentIds],
    }))

const view = async (runtime: NekroRuntime): Promise<CommandAccountsView> => ({
  accounts: commandAccounts(runtime),
  localLogins: await runtime.credentialLibrary.localGithubLogins(),
})

const githubSource = (request: AddCommandAccountRequest) =>
  request.source === 'token'
    ? { source: 'token' as const, token: request.token }
    : { source: 'gh-login' as const, login: request.login }

const accountCredential = (accountId: string) => {
  const id = credentialIdOfAccount(accountId)
  if (id === undefined) throw new CredentialError('没有找到这个账号。')
  return id
}

/** The account library and the downloadable programs (GitHub CLI, the verification browser); grants are part of an agent's capabilities. */
export function registerCommandAccountRoutes({ runtime, registerRoute, broadcast }: HostRouteContext): () => void {
  const changed = () => broadcast({ event: 'snapshot-changed', data: { changed: true } })
  const unsubscribeAccounts = runtime.credentialLibrary.subscribe(changed)
  const unsubscribeCli = runtime.githubCli.subscribe(changed)
  const unsubscribeBrowser = runtime.verificationBrowser.subscribe(changed)
  const reject = (res: Parameters<typeof writeError>[0], error: unknown) =>
    writeError(
      res,
      error instanceof CredentialError ? 400 : 500,
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
          // The older library granted accounts per agent: an account added here reaches the agents granted it.
          const record = await runtime.credentialLibrary.create({
            kind: 'github',
            github: githubSource(HostApiContracts.addCommandAccount.parseRequest(await readJsonBody(req))),
            agentScope: { agentIds: [] },
            autoUse: true,
          })
          fulfilCredentialRequests(runtime, record)
          writeContractJson(res, 200, HostApiContracts.addCommandAccount, await view(runtime))
          return
        }
        if (accountId !== undefined && req.method === 'PUT') {
          await runtime.credentialLibrary.replaceValue(accountCredential(accountId), {
            github: githubSource(HostApiContracts.replaceCommandAccountToken.parseRequest(await readJsonBody(req))),
          })
          writeContractJson(res, 200, HostApiContracts.replaceCommandAccountToken, await view(runtime))
          return
        }
        if (accountId !== undefined && req.method === 'DELETE') {
          const id = credentialIdOfAccount(accountId)
          if (id !== undefined && runtime.credentialLibrary.get(id)?.kind === 'github') {
            await runtime.credentialLibrary.remove(id)
          }
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
    unsubscribeAccounts()
    unsubscribeCli()
    unsubscribeBrowser()
  }
}

/** Grants may only name accounts the library holds, one per service. */
export const knownCommandAccounts = <Grant extends { readonly accountId: string }>(
  runtime: NekroRuntime,
  grants: readonly Grant[],
): Grant[] => {
  for (const grant of grants) {
    const id = credentialIdOfAccount(grant.accountId)
    if (id === undefined || runtime.credentialLibrary.get(id)?.kind !== 'github') {
      throw new Error('授权的账号已不存在，请刷新后重试。')
    }
  }
  return [...grants]
}

/**
 * The older account controls grant an account to agents, one per agent. Each account is a GitHub credential limited to
 * listed agents, so saving the grants keeps the agent in exactly the scopes of the accounts it was granted.
 */
export const syncGrantedAccounts = async (
  runtime: NekroRuntime,
  agentId: AgentId,
  grants: readonly { readonly accountId: string }[] | undefined,
): Promise<void> => {
  if (grants === undefined) return
  const granted = new Set(grants.flatMap((grant) => credentialIdOfAccount(grant.accountId) ?? []))
  // Removals first, so moving an agent to another account never meets its old one on `GH_TOKEN`.
  for (const adding of [false, true]) {
    for (const record of runtime.credentialLibrary.list()) {
      if (record.kind !== 'github' || 'all' in record.agentScope) continue
      const listed = record.agentScope.agentIds.includes(agentId)
      if (listed === granted.has(record.id) || listed === adding) continue
      await runtime.credentialLibrary.update(record.id, {
        agentScope: {
          agentIds: adding
            ? [...record.agentScope.agentIds, agentId]
            : record.agentScope.agentIds.filter((id) => id !== agentId),
        },
      })
    }
  }
}
