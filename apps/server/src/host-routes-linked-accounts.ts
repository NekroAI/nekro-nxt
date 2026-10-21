import {
  HostApiContracts,
  LinkedAccountPlatformIdSchema,
  type LinkedAccountView,
  type LinkedAccountsView,
} from '@nekro-nxt/contracts'
import type { LinkedAccountRecord } from '@nekro-nxt/storage-sqlite'
import { z } from 'zod'
import type { NekroRuntime } from './bootstrap.js'
import { readJsonBody, writeContractJson, writeError, type HostRouteContext } from './host-route-support.js'
import type { AgentGrants } from './linked-accounts/library.js'
import { LinkedAccountError } from './linked-accounts/platform.js'

const agentGrants = (runtime: NekroRuntime): AgentGrants[] =>
  runtime.core.listAgents().map((commit) => ({
    agentId: commit.definition.id,
    grants: commit.revision.capabilities.commandAccounts,
  }))

const accountView = (runtime: NekroRuntime, record: LinkedAccountRecord, agents: AgentGrants[]): LinkedAccountView => {
  const library = runtime.linkedAccounts
  const source = record.source === 'gh-login' ? 'gh-login' : 'token'
  return {
    id: record.id,
    platform: LinkedAccountPlatformIdSchema.parse(record.platform),
    login: record.login,
    scopes: record.scopes === undefined ? null : [...record.scopes],
    source,
    available: library.available(record.id),
    grantedAgentIds: library.grantedAgentIds(record.id, agents),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastUsedAt: record.lastUsedAt ?? null,
  }
}

/** Every supported platform with its accounts and tools; accounts on platforms this host lacks are left out. */
export const linkedAccountsView = async (runtime: NekroRuntime): Promise<LinkedAccountsView> => {
  const library = runtime.linkedAccounts
  const agents = agentGrants(runtime)
  return {
    platforms: library.platforms.list().map((platform) => {
      const tool = platform.tool?.()
      return {
        id: platform.id,
        name: platform.name,
        addMethods: [...platform.addMethods],
        ...(tool === undefined ? {} : { tool: { id: tool.id, name: tool.name, availability: tool.availability } }),
        accounts: library
          .list()
          .filter((record) => record.platform === platform.id)
          .map((record) => accountView(runtime, record, agents)),
      }
    }),
    localGithubLogins: await library.localGithubLogins(),
  }
}

/**
 * Grants may only name accounts the library holds, on the grant's platform, one per platform (the capability schema
 * checks the last). Saved grants name the account by its current id.
 */
export const knownAccountGrants = <Grant extends { readonly service: string; readonly accountId: string }>(
  runtime: NekroRuntime,
  grants: readonly Grant[],
): Grant[] =>
  grants.map((grant) => {
    const account = runtime.linkedAccounts.resolveGrant(grant)
    if (account === undefined) throw new Error('授权的账号已不存在，请刷新后重试。')
    return { ...grant, accountId: account.id }
  })

/**
 * Grants as clients see them: older grants name the account without its `acc_` prefix, shown here by the account's
 * id so a client can match them against the account list. Grants of removed accounts stay as stored.
 */
export const currentAccountGrants = <Grant extends { readonly service: string; readonly accountId: string }>(
  runtime: NekroRuntime,
  grants: readonly Grant[],
): Grant[] =>
  grants.map((grant) => {
    const account = runtime.linkedAccounts.resolveGrant(grant)
    return account === undefined || account.id === grant.accountId ? grant : { ...grant, accountId: account.id }
  })

/** Agent capabilities as clients see them, with grants naming accounts by their current ids. */
export const clientCapabilities = <
  Capabilities extends {
    readonly commandAccounts: readonly { readonly service: string; readonly accountId: string }[]
  },
>(
  runtime: NekroRuntime,
  capabilities: Capabilities,
): Capabilities => ({ ...capabilities, commandAccounts: currentAccountGrants(runtime, capabilities.commandAccounts) })

/** 设置 → 关联账号: linking, replacing and removing accounts, and their recorded uses. Grants live on agents. */
export function registerLinkedAccountRoutes({ runtime, registerRoute, broadcast }: HostRouteContext): () => void {
  const changed = () => broadcast({ event: 'snapshot-changed', data: { changed: true } })
  const unsubscribe = runtime.linkedAccounts.subscribe(changed)
  const reject = (res: Parameters<typeof writeError>[0], error: unknown) => {
    const known = error instanceof LinkedAccountError || error instanceof z.ZodError
    writeError(res, known ? 400 : 500, 'linked-account-failed', error instanceof Error ? error.message : String(error))
  }
  const base = '/api/settings/linked-accounts'

  registerRoute({
    kind: 'prefix',
    path: base,
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const parts = url.pathname
        .slice(base.length)
        .split('/')
        .filter((part) => part !== '')
        .map((part) => decodeURIComponent(part))
      try {
        if (parts.length === 0 && req.method === 'GET') {
          writeContractJson(res, 200, HostApiContracts.getLinkedAccounts, await linkedAccountsView(runtime))
          return
        }
        if (parts.length === 0 && req.method === 'POST') {
          await runtime.linkedAccounts.add(HostApiContracts.addLinkedAccount.parseRequest(await readJsonBody(req)))
          writeContractJson(res, 200, HostApiContracts.addLinkedAccount, await linkedAccountsView(runtime))
          return
        }
        if (parts.length === 2) {
          const { accountId } = HostApiContracts.getLinkedAccountUses.parseParams({ accountId: parts[0] })
          if (parts[1] === 'token' && req.method === 'PUT') {
            await runtime.linkedAccounts.replaceToken(
              accountId,
              HostApiContracts.replaceLinkedAccountToken.parseRequest(await readJsonBody(req)),
            )
            writeContractJson(res, 200, HostApiContracts.replaceLinkedAccountToken, await linkedAccountsView(runtime))
            return
          }
          if (parts[1] === 'remove' && req.method === 'POST') {
            const input = HostApiContracts.removeLinkedAccount.parseRequest(await readJsonBody(req))
            if (runtime.linkedAccounts.get(accountId) === undefined) throw new LinkedAccountError('没有找到这个账号。')
            const grantedAgentIds = runtime.linkedAccounts.grantedAgentIds(accountId, agentGrants(runtime))
            if (!input.confirm && grantedAgentIds.length > 0) {
              writeContractJson(res, 200, HostApiContracts.removeLinkedAccount, { removed: false, grantedAgentIds })
              return
            }
            await runtime.linkedAccounts.remove(accountId)
            writeContractJson(res, 200, HostApiContracts.removeLinkedAccount, {
              removed: true,
              view: await linkedAccountsView(runtime),
            })
            return
          }
          if (parts[1] === 'uses' && req.method === 'GET') {
            if (runtime.linkedAccounts.get(accountId) === undefined) throw new LinkedAccountError('没有找到这个账号。')
            writeContractJson(res, 200, HostApiContracts.getLinkedAccountUses, {
              uses: runtime.linkedAccounts.uses(accountId).map((use) => ({
                at: use.at,
                agentId: use.agentId ?? null,
                channelId: use.channelId ?? null,
                consumerKind: use.consumerKind,
                consumerId: use.consumerId,
              })),
            })
            return
          }
        }
        writeError(res, 404, 'not-found', `Unknown route: ${req.method} ${url.pathname}`)
      } catch (error) {
        reject(res, error)
      }
    },
  })
  return unsubscribe
}
