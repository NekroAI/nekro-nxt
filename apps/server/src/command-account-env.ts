import SandboxBashExecutor from '@deepseek-ai/dsh-bash-sandbox'
import { tmpdir } from 'node:os'
import path from 'node:path'

/** What the host knows about the accounts and the GitHub CLI when one agent's command environment is built. */
export interface CommandAccountSources {
  readonly tokenFor: (accountId: string) => string | undefined
  readonly loginOf: (accountId: string) => string | undefined
  /** Directory of a downloaded GitHub CLI to put in front of `PATH`; `undefined` when `gh` is already on it. */
  readonly githubCliDirectory: () => string | undefined
  readonly githubCliAvailable: () => boolean
}

export interface CommandAccountGrantInput {
  readonly service: 'github'
  readonly accountId: string
  readonly usage: readonly ('read' | 'issues' | 'pull-requests' | 'push')[]
}

const USAGE_TEXT: Record<CommandAccountGrantInput['usage'][number], string> = {
  read: '查看仓库、issue 和 PR',
  issues: '创建和评论 issue',
  'pull-requests': '创建和更新 PR',
  push: '推送代码',
}

/**
 * Environment variables added to one agent's commands. DSH removes credential-shaped variables from the host's own
 * environment, so these are the only way a command receives an account. `git` over https reads the same token
 * through an in-memory credential helper, which keeps it out of every file.
 */
export const commandAccountEnvironment = (
  agentId: string,
  grants: readonly CommandAccountGrantInput[],
  sources: CommandAccountSources,
  basePath: string | undefined = process.env['PATH'],
): Record<string, string> => {
  const github = grants.find((grant) => grant.service === 'github')
  const token = github === undefined ? undefined : sources.tokenFor(github.accountId)
  if (token === undefined) return {}
  const cliDirectory = sources.githubCliDirectory()
  return {
    GH_TOKEN: token,
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
  }
}

/** The line that tells the agent which account its commands act as, or `undefined` when there is none to tell. */
export const commandAccountPrompt = (
  grants: readonly CommandAccountGrantInput[],
  sources: CommandAccountSources,
): string | undefined => {
  const github = grants.find((grant) => grant.service === 'github')
  if (github === undefined || sources.tokenFor(github.accountId) === undefined) return undefined
  const login = sources.loginOf(github.accountId)
  if (login === undefined) return undefined
  const lines = [
    sources.githubCliAvailable()
      ? `命令里的 GitHub 已用账号 ${login} 登录：gh 可以直接用，git 走 https 也会带上这个账号。`
      : `命令里的 GitHub 账号是 ${login}，这台设备上没有 gh：需要时用 curl 调 GitHub 的 REST 接口，请求头里带环境变量 GH_TOKEN；git 走 https 会自动带上这个账号。`,
  ]
  if (github.usage.length > 0) {
    lines.push(
      `这个账号交给你的用途是：${github.usage.map((usage) => USAGE_TEXT[usage]).join('、')}。用途之外的操作，先和管理员确认。`,
    )
  }
  return lines.join('\n')
}

type ExecutorRequest = Parameters<SandboxBashExecutor['resolve']>[0]

/**
 * DSH's sandbox executor that adds the agent's account variables to every command. The variables are read when the
 * command starts, so removing an account stops it at the next command.
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
