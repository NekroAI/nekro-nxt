import SandboxBashExecutor from '@deepseek-ai/dsh-bash-sandbox'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AgentId, CommandCredentialGrant, CredentialId } from '@nekro-nxt/contracts'
import { credentialIdOfAccount } from './credentials-library.js'

/** One credential as an agent's commands may receive it: in the agent's scope and allowed for program use. */
export interface CommandCredential {
  readonly name: string
  readonly description: string
  readonly kind: 'generic' | 'github'
  /** GitHub login, for GitHub credentials. */
  readonly login?: string
  readonly value: string
}

/** What the host knows about credentials and the GitHub CLI when one agent's command environment is built. */
export interface CommandCredentialSources {
  /** The credential cleared for this agent's commands, or `undefined` when it is gone, out of scope or request-only. */
  readonly credential: (credentialId: CredentialId, agentId: AgentId) => CommandCredential | undefined
  /** Called when a command environment carries the credential. */
  readonly used?: (credentialId: CredentialId, agentId: AgentId) => void
  /** Directory of a downloaded GitHub CLI to put in front of `PATH`; `undefined` when `gh` is already on it. */
  readonly githubCliDirectory: () => string | undefined
  readonly githubCliAvailable: () => boolean
}

type UsageHint = CommandCredentialGrant['usage'][number]

const USAGE_TEXT: Record<UsageHint, string> = {
  read: '查看仓库、issue 和 PR',
  issues: '创建和评论 issue',
  'pull-requests': '创建和更新 PR',
  push: '推送代码',
}

/**
 * The agent's command grants: `commandCredentials`, then each older `commandAccounts` grant as the credential it was
 * migrated to, given as `GH_TOKEN`. A credential or variable named twice keeps its first grant.
 */
export const effectiveCommandGrants = (capabilities: {
  readonly commandCredentials: readonly CommandCredentialGrant[]
  readonly commandAccounts: readonly { readonly accountId: string; readonly usage: readonly UsageHint[] }[]
}): readonly CommandCredentialGrant[] => {
  const grants: CommandCredentialGrant[] = []
  const candidates = [
    ...capabilities.commandCredentials,
    ...capabilities.commandAccounts.flatMap((grant) => {
      const credentialId = credentialIdOfAccount(grant.accountId)
      return credentialId === undefined ? [] : [{ credentialId, env: 'GH_TOKEN', usage: [...grant.usage] }]
    }),
  ]
  for (const grant of candidates) {
    if (grants.some((kept) => kept.credentialId === grant.credentialId || kept.env === grant.env)) continue
    grants.push(grant)
  }
  return grants
}

const cleared = (
  agentId: AgentId,
  grants: readonly CommandCredentialGrant[],
  sources: CommandCredentialSources,
): Array<{ readonly grant: CommandCredentialGrant; readonly credential: CommandCredential }> =>
  grants.flatMap((grant) => {
    const credential = sources.credential(grant.credentialId, agentId)
    return credential === undefined ? [] : [{ grant, credential }]
  })

/**
 * Environment variables added to one agent's commands. DSH removes credential-shaped variables from the host's own
 * environment, so these are the only way a command receives a credential. The first GitHub credential also sets up
 * `gh` and, through an in-memory credential helper, `git` over https; the token stays out of every file.
 */
export const commandCredentialEnvironment = (
  agentId: AgentId,
  grants: readonly CommandCredentialGrant[],
  sources: CommandCredentialSources,
  basePath: string | undefined = process.env['PATH'],
): Record<string, string> => {
  const environment: Record<string, string> = {}
  let github = false
  for (const { grant, credential } of cleared(agentId, grants, sources)) {
    sources.used?.(grant.credentialId, agentId)
    environment[grant.env] = credential.value
    if (credential.kind !== 'github' || github) continue
    github = true
    const cliDirectory = sources.githubCliDirectory()
    Object.assign(environment, {
      GH_TOKEN: credential.value,
      GH_PROMPT_DISABLED: '1',
      GH_NO_UPDATE_NOTIFIER: '1',
      GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
      // The user's own `gh` configuration is out of reach for commands; give it a scratch one.
      GH_CONFIG_DIR: path.join(tmpdir(), 'nekro-nxt-gh', agentId),
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'credential.https://github.com.helper',
      GIT_CONFIG_VALUE_0: '!f() { test "$1" = get && echo username=x-access-token && echo "password=$GH_TOKEN"; }; f',
      ...(cliDirectory === undefined ? {} : { PATH: `${cliDirectory}${path.delimiter}${basePath ?? ''}` }),
    })
  }
  return environment
}

/** What the agent is told about the credentials its commands receive, or `undefined` when there are none. */
export const commandCredentialPrompt = (
  agentId: AgentId,
  grants: readonly CommandCredentialGrant[],
  sources: CommandCredentialSources,
): string | undefined => {
  const lines: string[] = []
  let github = false
  for (const { grant, credential } of cleared(agentId, grants, sources)) {
    if (credential.kind === 'github' && !github && credential.login !== undefined) {
      github = true
      lines.push(
        sources.githubCliAvailable()
          ? `命令里的 GitHub 已用账号 ${credential.login} 登录：gh 可以直接用，git 走 https 也会带上这个账号。`
          : `命令里的 GitHub 账号是 ${credential.login}，这台设备上没有 gh：需要时用 curl 调 GitHub 的 REST 接口，请求头里带环境变量 GH_TOKEN；git 走 https 会自动带上这个账号。`,
      )
      if (grant.usage.length > 0) {
        lines.push(
          `这个账号交给你的用途是：${grant.usage.map((usage) => USAGE_TEXT[usage]).join('、')}。用途之外的操作，先和管理员确认。`,
        )
      }
      if (grant.env === 'GH_TOKEN') continue
    }
    lines.push(
      `命令的环境变量 ${grant.env} 是凭据「${credential.name}」${credential.description === '' ? '' : `（${credential.description}）`}，用 $${grant.env} 引用，不要把它的值打印出来。`,
    )
  }
  return lines.length === 0 ? undefined : lines.join('\n')
}

type ExecutorRequest = Parameters<SandboxBashExecutor['resolve']>[0]

/**
 * DSH's sandbox executor that adds the agent's credential variables to every command. The variables are read when the
 * command starts, so removing a credential stops it at the next command.
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
