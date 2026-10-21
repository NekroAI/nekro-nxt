import {
  HostApiContracts,
  ExtensionIdSchema,
  type AgentId,
  type CredentialId,
  type CredentialUsers,
  type CredentialView,
  type CredentialsView,
  type JsonValue,
  type ModelProviderAccess,
} from '@nekro-nxt/contracts'
import type { CredentialRecord } from '@nekro-nxt/storage-sqlite'
import { z } from 'zod'
import type { NekroRuntime } from './bootstrap.js'
import { CredentialError, commandEnvName, namedCredentialId } from './credentials-library.js'
import { readJsonBody, writeContractJson, writeError, type HostRouteContext } from './host-route-support.js'

const boundIn = (config: JsonValue | undefined, id: CredentialId): boolean =>
  config !== null &&
  config !== undefined &&
  typeof config === 'object' &&
  !Array.isArray(config) &&
  Object.values(config).some((value) => namedCredentialId(value) === id)

/** Extension configurations that bind the credential, and agents whose commands receive it. */
export const credentialUsers = (runtime: NekroRuntime, id: CredentialId): CredentialUsers => {
  const repository = runtime.repository
  const extensions = new Map<
    string,
    { extensionId: CredentialUsers['extensions'][number]['extensionId']; agentIds: AgentId[]; host: boolean }
  >()
  const entry = (extensionId: CredentialUsers['extensions'][number]['extensionId']) => {
    const existing = extensions.get(extensionId) ?? { extensionId, agentIds: [], host: false }
    extensions.set(extensionId, existing)
    return existing
  }
  for (const installation of repository.listHostInstallations()) {
    if (boundIn(installation.config, id)) entry(installation.extensionId).host = true
  }
  for (const activation of repository.listActivations()) {
    if (boundIn(activation.config, id)) entry(activation.extensionId).agentIds.push(activation.agentId)
  }
  return {
    extensions: [...extensions.values()].map((usage) => ({
      ...usage,
      name: repository.getExtension(usage.extensionId)?.displayName ?? '扩展',
    })),
    commandAgents: runtime.core
      .listAgents()
      .filter(
        (commit) =>
          commit.revision.capabilities.developmentShell &&
          runtime.credentialLibrary.commandCredentials(commit.definition.id).some(({ record }) => record.id === id),
      )
      .map((commit) => commit.definition.id),
  }
}

export const credentialView = (runtime: NekroRuntime, record: CredentialRecord): CredentialView => ({
  id: record.id,
  name: record.name,
  description: record.description,
  usage: record.usage,
  domains: [...record.domains],
  agentScope: 'all' in record.agentScope ? { all: true } : { agentIds: [...record.agentScope.agentIds] },
  autoUse: record.autoUse,
  envName: commandEnvName(record) ?? null,
  approvedAgentIds: [...record.approvedAgentIds],
  redactable: runtime.credentialLibrary.redactable(record.id),
  available: runtime.credentialLibrary.available(record.id),
  usedBy: credentialUsers(runtime, record.id),
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
  lastUsedAt: record.lastUsedAt ?? null,
})

/** Configured model providers with their openness; empty on hosts without model settings. */
export const modelProviderAccessList = async (runtime: NekroRuntime): Promise<ModelProviderAccess[]> => {
  let providers
  try {
    providers = (await runtime.host.getLlmProviderSettings()).providers
  } catch {
    return []
  }
  // The catalog lists every provider DSH knows; only those configured in 设置 → 模型 can be opened.
  return providers
    .filter((provider) => provider.configured)
    .map((provider) => ({
      provider: provider.provider,
      name: provider.displayName,
      open: runtime.modelProviderAccess.isOpen(provider.provider),
    }))
}

export const credentialsView = async (runtime: NekroRuntime): Promise<CredentialsView> => ({
  credentials: runtime.credentialLibrary.list().map((record) => credentialView(runtime, record)),
  modelProviders: await modelProviderAccessList(runtime),
  requests: [...runtime.credentialRequests.list()],
})

/** A saved credential answers the agent requests filed under its name. */
export const fulfilCredentialRequests = (runtime: NekroRuntime, record: CredentialRecord): void => {
  runtime.credentialRequests.fulfil(record.name)
}

/** Settings → credentials: the library, recorded uses, agent requests and model provider openness. */
export function registerCredentialRoutes({ runtime, registerRoute, broadcast }: HostRouteContext): () => void {
  const changed = () => broadcast({ event: 'snapshot-changed', data: { changed: true } })
  const unsubscribe = runtime.credentialLibrary.subscribe(changed)
  const reject = (res: Parameters<typeof writeError>[0], error: unknown) => {
    const known = error instanceof CredentialError || error instanceof z.ZodError
    writeError(res, known ? 400 : 500, 'credential-failed', error instanceof Error ? error.message : String(error))
  }

  registerRoute({
    kind: 'prefix',
    path: '/api/settings/credentials',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const parts = url.pathname
        .slice('/api/settings/credentials'.length)
        .split('/')
        .filter((part) => part !== '')
        .map((part) => decodeURIComponent(part))
      try {
        if (parts.length === 0 && req.method === 'GET') {
          writeContractJson(res, 200, HostApiContracts.getCredentials, await credentialsView(runtime))
          return
        }
        if (parts.length === 0 && req.method === 'POST') {
          const record = await runtime.credentialLibrary.create(
            HostApiContracts.createCredential.parseRequest(await readJsonBody(req)),
          )
          fulfilCredentialRequests(runtime, record)
          writeContractJson(res, 200, HostApiContracts.createCredential, await credentialsView(runtime))
          return
        }
        if (parts[0] === 'requests' && parts.length === 2 && req.method === 'DELETE') {
          const params = HostApiContracts.dismissCredentialRequest.parseParams({ requestId: parts[1] })
          runtime.credentialRequests.dismiss(params.requestId)
          writeContractJson(res, 200, HostApiContracts.dismissCredentialRequest, await credentialsView(runtime))
          return
        }
        if (parts[0] === 'model-providers' && parts.length === 2 && req.method === 'PUT') {
          const params = HostApiContracts.setModelProviderAccess.parseParams({ provider: parts[1] })
          const input = HostApiContracts.setModelProviderAccess.parseRequest(await readJsonBody(req))
          if (!(await modelProviderAccessList(runtime)).some((entry) => entry.provider === params.provider)) {
            throw new CredentialError('没有找到这个模型供应商。')
          }
          runtime.modelProviderAccess.set(params.provider, input.open)
          changed()
          writeContractJson(res, 200, HostApiContracts.setModelProviderAccess, await credentialsView(runtime))
          return
        }
        if (parts.length >= 1 && parts[0] !== 'requests' && parts[0] !== 'model-providers') {
          const { credentialId } = HostApiContracts.updateCredential.parseParams({ credentialId: parts[0] })
          if (parts.length === 1 && req.method === 'PATCH') {
            const record = await runtime.credentialLibrary.update(
              credentialId,
              HostApiContracts.updateCredential.parseRequest(await readJsonBody(req)),
            )
            fulfilCredentialRequests(runtime, record)
            writeContractJson(res, 200, HostApiContracts.updateCredential, await credentialsView(runtime))
            return
          }
          if (parts.length === 2 && parts[1] === 'value' && req.method === 'PUT') {
            await runtime.credentialLibrary.replaceValue(
              credentialId,
              HostApiContracts.replaceCredentialValue.parseRequest(await readJsonBody(req)),
            )
            writeContractJson(res, 200, HostApiContracts.replaceCredentialValue, await credentialsView(runtime))
            return
          }
          if (parts.length === 2 && parts[1] === 'remove' && req.method === 'POST') {
            const input = HostApiContracts.removeCredential.parseRequest(await readJsonBody(req))
            const usedBy = credentialUsers(runtime, credentialId)
            if (!input.confirm && (usedBy.extensions.length > 0 || usedBy.commandAgents.length > 0)) {
              writeContractJson(res, 200, HostApiContracts.removeCredential, { removed: false, usedBy })
              return
            }
            await runtime.credentialLibrary.remove(credentialId)
            writeContractJson(res, 200, HostApiContracts.removeCredential, {
              removed: true,
              view: await credentialsView(runtime),
            })
            return
          }
          if (parts.length === 2 && parts[1] === 'uses' && req.method === 'GET') {
            if (runtime.credentialLibrary.get(credentialId) === undefined) {
              throw new CredentialError('没有找到这个凭据。')
            }
            writeContractJson(res, 200, HostApiContracts.getCredentialUses, {
              uses: runtime.credentialLibrary.uses(credentialId).map((use) => {
                const extension =
                  use.consumerKind === 'extension' || use.consumerKind === 'mcp'
                    ? ExtensionIdSchema.safeParse(use.consumerId)
                    : undefined
                return {
                  at: use.at,
                  agentId: use.agentId ?? null,
                  channelId: use.channelId ?? null,
                  requesterMemberId: use.requesterMemberId ?? null,
                  consumerKind: use.consumerKind,
                  consumerId: use.consumerId,
                  consumerName:
                    extension?.success === true
                      ? (runtime.repository.getExtension(extension.data)?.displayName ?? null)
                      : null,
                  targetHost: use.targetHost ?? null,
                }
              }),
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
