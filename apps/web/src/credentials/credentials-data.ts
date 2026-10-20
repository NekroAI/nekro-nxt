import {
  AgentIdSchema,
  CredentialEnvNameSchema,
  CredentialNameSchema,
  ExtensionNetworkDomainSchema,
  HostApiContracts,
  type CredentialAgentScope,
  type CredentialsView,
  type CredentialView,
} from '@nekro-nxt/contracts'
import { useCallback, useEffect, useState } from 'react'
import { callHostApi, StaleHostReadError } from '../host-api-client.js'

/**
 * Named credentials as the settings page and the forms that bind them read them. Each user loads its own copy when
 * it mounts; a change returns the new view, which the caller passes to `replace`.
 */
export function useCredentials(enabled = true) {
  const [view, setView] = useState<CredentialsView>()
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    try {
      const next = await callHostApi(HostApiContracts.getCredentials, {}, undefined)
      setView(next)
      setError('')
      return next
    } catch (cause) {
      if (!(cause instanceof StaleHostReadError)) setError(cause instanceof Error ? cause.message : String(cause))
      return undefined
    }
  }, [])
  useEffect(() => {
    if (enabled) void load()
  }, [enabled, load])
  return { view, error, load, replace: setView }
}

/** Whether an agent (or, without one, every agent: the host layer) may use the credential. */
export const credentialOpenTo = (credential: CredentialView, agentId: string | undefined): boolean =>
  'all' in credential.agentScope ||
  (agentId !== undefined && credential.agentScope.agentIds.some((candidate) => candidate === agentId))

/** The environment variable an agent's commands receive the credential under, or `undefined`. */
export const commandEnvOf = (credential: CredentialView): string | undefined =>
  credential.kind === 'github'
    ? 'GH_TOKEN'
    : credential.usage === 'program' && credential.envName !== null
      ? credential.envName
      : undefined

/** Credentials one agent's commands receive: open to it, with a variable, used automatically or approved for it. */
export const commandCredentialsOf = (credentials: readonly CredentialView[], agentId: string) =>
  credentials.flatMap((credential) => {
    const env = commandEnvOf(credential)
    if (env === undefined || !credentialOpenTo(credential, agentId)) return []
    if (!credential.autoUse && !credential.approvedAgentIds.some((candidate) => candidate === agentId)) return []
    return [{ credential, env }]
  })

/** One line telling where the credential goes: its domains, or that programs read it. */
export const credentialUsageText = (credential: CredentialView): string => {
  if (credential.usage === 'program') {
    const env = commandEnvOf(credential)
    return env === undefined ? '程序可读' : `程序可读 · ${env}`
  }
  return credential.domains.join('、')
}

/** The editable part of a credential, as the add form and the detail page hold it. */
export interface CredentialDraft {
  readonly name: string
  readonly description: string
  readonly usage: 'request' | 'program'
  /** Domains as typed, separated by commas, spaces or new lines. */
  readonly domains: string
  readonly envName: string
  readonly autoUse: boolean
  readonly allAgents: boolean
  readonly agentIds: readonly string[]
}

export const emptyCredentialDraft: CredentialDraft = {
  name: '',
  description: '',
  usage: 'request',
  domains: '',
  envName: '',
  autoUse: true,
  allAgents: true,
  agentIds: [],
}

export const draftOfCredential = (credential: CredentialView): CredentialDraft => ({
  name: credential.name,
  description: credential.description,
  usage: credential.usage,
  domains: credential.domains.join(', '),
  envName: credential.envName ?? '',
  autoUse: credential.autoUse,
  allAgents: 'all' in credential.agentScope,
  agentIds: 'all' in credential.agentScope ? [] : credential.agentScope.agentIds,
})

export const parseDomains = (text: string): readonly string[] =>
  text
    .split(/[\s,，、]+/u)
    .map((domain) => domain.trim().toLowerCase())
    .filter((domain) => domain !== '')

export const scopeOfDraft = (draft: CredentialDraft): CredentialAgentScope =>
  draft.allAgents ? { all: true } : { agentIds: draft.agentIds.map((id) => AgentIdSchema.parse(id)) }

/** Field problems of a draft; GitHub credentials have no usage, domains or variable of their own. */
export const credentialDraftIssues = (
  draft: CredentialDraft,
  kind: 'generic' | 'github',
): Readonly<Partial<Record<'name' | 'domains' | 'envName', string>>> => {
  const issues: Partial<Record<'name' | 'domains' | 'envName', string>> = {}
  const name = CredentialNameSchema.safeParse(draft.name)
  if (!name.success) issues.name = name.error.issues[0]?.message ?? '名称无效。'
  if (kind === 'github') return issues
  const domains = parseDomains(draft.domains)
  const invalid = domains.find((domain) => !ExtensionNetworkDomainSchema.safeParse(domain).success)
  if (invalid !== undefined) issues.domains = `「${invalid}」不是有效的域名，例如 api.example.com 或 *.example.com。`
  else if (draft.usage === 'request' && domains.length === 0) issues.domains = '至少填写一个域名。'
  if (draft.usage === 'program' && draft.envName.trim() !== '') {
    const env = CredentialEnvNameSchema.safeParse(draft.envName)
    if (!env.success) issues.envName = env.error.issues[0]?.message ?? '环境变量名无效。'
  }
  return issues
}

export const errorText = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))
