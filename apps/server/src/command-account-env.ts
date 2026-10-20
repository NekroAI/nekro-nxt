import SandboxBashExecutor from '@deepseek-ai/dsh-bash-sandbox'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AgentId, CredentialId } from '@nekro-nxt/contracts'

/** One credential an agent's commands receive, under `env`. */
export interface CommandCredential {
  readonly id: CredentialId
  readonly name: string
  readonly description: string
  readonly kind: 'generic' | 'github'
  readonly env: string
  /** GitHub login, for GitHub credentials. */
  readonly login?: string
  readonly value: string
}

/** What the host knows about credentials and the GitHub CLI when one agent's command environment is built. */
export interface CommandCredentialSources {
  /**
   * Credentials the agent's commands receive now: program credentials in its scope with a variable, used automatically
   * or approved for it. Read for every command, so a removed credential stops at the next one.
   */
  readonly credentials: (agentId: AgentId) => readonly CommandCredential[]
  /** Called when a command environment carries the credential. */
  readonly used?: (credentialId: CredentialId, agentId: AgentId) => void
  /** Directory of a downloaded GitHub CLI to put in front of `PATH`; `undefined` when `gh` is already on it. */
  readonly githubCliDirectory: () => string | undefined
  readonly githubCliAvailable: () => boolean
}

/** What the user wants a GitHub account used for, from the older account grants. Told to the agent only. */
export type CommandUsageHint = 'read' | 'issues' | 'pull-requests' | 'push'

const USAGE_TEXT: Record<CommandUsageHint, string> = {
  read: '查看仓库、issue 和 PR',
  issues: '创建和评论 issue',
  'pull-requests': '创建和更新 PR',
  push: '推送代码',
}

/**
 * Environment variables added to one agent's commands. DSH removes credential-shaped variables from the host's own
 * environment, so these are the only way a command receives a credential. A GitHub credential also sets up `gh` and,
 * through an in-memory credential helper, `git` over https; the token stays out of every file.
 */
export const commandCredentialEnvironment = (
  agentId: AgentId,
  sources: CommandCredentialSources,
  basePath: string | undefined = process.env['PATH'],
): Record<string, string> => {
  const environment: Record<string, string> = {}
  for (const credential of sources.credentials(agentId)) {
    sources.used?.(credential.id, agentId)
    environment[credential.env] = credential.value
    if (credential.kind !== 'github') continue
    const cliDirectory = sources.githubCliDirectory()
    Object.assign(environment, {
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

/**
 * What the agent is told about the credentials its commands receive: names and variables, never values. `usage` are
 * the hints an older account grant gave for a GitHub credential.
 */
export const commandCredentialPrompt = (
  agentId: AgentId,
  sources: CommandCredentialSources,
  usage: (credentialId: CredentialId) => readonly CommandUsageHint[] = () => [],
): string | undefined => {
  const lines: string[] = []
  for (const credential of sources.credentials(agentId)) {
    if (credential.kind === 'github' && credential.login !== undefined) {
      lines.push(
        sources.githubCliAvailable()
          ? `命令里的 GitHub 已用账号 ${credential.login} 登录：gh 可以直接用，git 走 https 也会带上这个账号。`
          : `命令里的 GitHub 账号是 ${credential.login}，这台设备上没有 gh：需要时用 curl 调 GitHub 的 REST 接口，请求头里带环境变量 GH_TOKEN；git 走 https 会自动带上这个账号。`,
      )
      const hints = usage(credential.id)
      if (hints.length > 0) {
        lines.push(
          `这个账号交给你的用途是：${hints.map((hint) => USAGE_TEXT[hint]).join('、')}。用途之外的操作，先和管理员确认。`,
        )
      }
      continue
    }
    lines.push(
      `命令的环境变量 ${credential.env} 是凭据「${credential.name}」${credential.description === '' ? '' : `（${credential.description}）`}，用 $${credential.env} 引用，不要把它的值打印出来。`,
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
