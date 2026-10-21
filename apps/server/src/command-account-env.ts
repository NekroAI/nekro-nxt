import SandboxBashExecutor from '@deepseek-ai/dsh-bash-sandbox'
import type { AgentId, CredentialId, LinkedAccountId } from '@nekro-nxt/contracts'
import type { CommandAccountGrant } from '@nekro-nxt/core'

/** One credential an agent's commands receive, under `env`. */
export interface CommandCredential {
  readonly id: CredentialId
  readonly name: string
  readonly description: string
  readonly env: string
  readonly value: string
}

/** One linked account an agent's commands act as: the variables that carry it and what the agent is told. */
export interface CommandAccount {
  readonly id: LinkedAccountId
  /** `<platform> <login>`, for logs. */
  readonly label: string
  readonly environment: Readonly<Record<string, string>>
  readonly prompt: readonly string[]
}

/** What the host knows about credentials and linked accounts when one agent's command environment is built. */
export interface CommandCredentialSources {
  /**
   * Generic credentials the agent's commands receive now: program credentials in its scope with a variable, used
   * automatically or approved for it. Read for every command, so a removed credential stops at the next one.
   */
  readonly credentials: (agentId: AgentId) => readonly CommandCredential[]
  /** Linked accounts the agent's grants name that still exist; read for every command like credentials. */
  readonly accounts: (agentId: AgentId, grants: readonly CommandAccountGrant[]) => readonly CommandAccount[]
  /** Called when a command environment carries the credential. */
  readonly used?: (credentialId: CredentialId, agentId: AgentId) => void
  /** Called when a command environment carries the account. */
  readonly accountUsed?: (accountId: LinkedAccountId, agentId: AgentId) => void
}

/** Overlaps already reported, so a command that runs again does not log the same warning. */
const reportedOverlaps = new Set<string>()

/**
 * Environment variables added to one agent's commands: its generic credentials under their own variables, then its
 * granted linked accounts. DSH removes credential-shaped variables from the host's own environment, so these are the
 * only way a command receives a secret. Where an account and a credential would set the same variable, the account
 * wins and the overlap is logged once.
 */
export const commandCredentialEnvironment = (
  agentId: AgentId,
  grants: readonly CommandAccountGrant[],
  sources: CommandCredentialSources,
): Record<string, string> => {
  const environment: Record<string, string> = {}
  const fromCredential = new Map<string, string>()
  for (const credential of sources.credentials(agentId)) {
    sources.used?.(credential.id, agentId)
    environment[credential.env] = credential.value
    fromCredential.set(credential.env, credential.name)
  }
  for (const account of sources.accounts(agentId, grants)) {
    sources.accountUsed?.(account.id, agentId)
    for (const [name, value] of Object.entries(account.environment)) {
      const credential = fromCredential.get(name)
      const key = `${agentId}\0${name}\0${account.id}`
      if (credential !== undefined && !reportedOverlaps.has(key)) {
        reportedOverlaps.add(key)
        console.warn(
          `[nekro-nxt] 智能体 ${agentId} 的命令里，关联账号 ${account.label} 和凭据「${credential}」都使用 ${name}，取关联账号的值。`,
        )
      }
      environment[name] = value
    }
  }
  return environment
}

/**
 * What the agent is told about the accounts and credentials its commands receive: accounts by platform and login with
 * their usage hints, then credentials by name and variable. Never values.
 */
export const commandCredentialPrompt = (
  agentId: AgentId,
  grants: readonly CommandAccountGrant[],
  sources: CommandCredentialSources,
): string | undefined => {
  const lines: string[] = []
  for (const account of sources.accounts(agentId, grants)) lines.push(...account.prompt)
  for (const credential of sources.credentials(agentId)) {
    lines.push(
      `命令的环境变量 ${credential.env} 是凭据「${credential.name}」${credential.description === '' ? '' : `（${credential.description}）`}，用 $${credential.env} 引用，不要把它的值打印出来。`,
    )
  }
  return lines.length === 0 ? undefined : lines.join('\n')
}

type ExecutorRequest = Parameters<SandboxBashExecutor['resolve']>[0]

/**
 * DSH's sandbox executor that adds the agent's credential and account variables to every command. The variables are
 * read when the command starts, so removing a credential or an account stops it at the next command.
 */
export const createEnvForwardingExecutor = (
  environment: () => Readonly<Record<string, string>>,
): typeof SandboxBashExecutor =>
  class EnvForwardingExecutor extends SandboxBashExecutor {
    override resolve(request: ExecutorRequest) {
      const added = environment()
      if (Object.keys(added).length === 0) return super.resolve(request)
      return super.resolve({ ...request, env: { ...request.env, ...added } })
    }
  }
