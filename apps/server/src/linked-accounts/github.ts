import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { CommandAccountUsage, LinkedAccountTokenSource } from '@nekro-nxt/contracts'
import type { GithubCliStatus } from '../github-cli.js'
import { LinkedAccountError, type LinkedAccountIdentity, type LinkedAccountPlatform } from './platform.js'

const run = promisify(execFile)

const GITHUB_API_USER_URL = 'https://api.github.com/user'
const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u

/** Logins the local GitHub CLI holds; empty when it is missing, logged out or too old to say. */
export const localGithubLogins = async (
  executable: string | undefined,
): Promise<Array<{ login: string; active: boolean }>> => {
  if (executable === undefined) return []
  try {
    const { stdout } = await run(executable, ['auth', 'status', '--hostname', 'github.com', '--json', 'hosts'], {
      timeout: 15_000,
    })
    const parsed = z
      .object({
        hosts: z.record(
          z.string(),
          z.array(z.object({ login: z.string(), active: z.boolean(), state: z.string() }).passthrough()),
        ),
      })
      .safeParse(JSON.parse(stdout))
    if (!parsed.success) return []
    return (parsed.data.hosts['github.com'] ?? [])
      .filter((entry) => entry.state === 'success' && LOGIN_PATTERN.test(entry.login))
      .map((entry) => ({ login: entry.login, active: entry.active }))
  } catch {
    return []
  }
}

/** The token a request names: typed, or read once from the local `gh` for one of its logins. */
export const githubTokenOf = async (
  source: LinkedAccountTokenSource,
  executable: string | undefined,
): Promise<string> => {
  if (source.method === 'token') return source.token.trim()
  if (!LOGIN_PATTERN.test(source.login)) throw new LinkedAccountError('账号名不合法。')
  if (executable === undefined) throw new LinkedAccountError('这台设备上没有 GitHub CLI。')
  try {
    const { stdout } = await run(executable, ['auth', 'token', '--hostname', 'github.com', '--user', source.login], {
      timeout: 15_000,
    })
    const token = stdout.trim()
    if (token === '') throw new Error('empty')
    return token
  } catch {
    throw new LinkedAccountError(`没有取到 ${source.login} 的登录，请先在终端里用 gh auth login 登录。`)
  }
}

/** Asks GitHub whose token this is; the scopes come back for classic tokens only. */
export const verifyGithubToken = async (fetcher: typeof fetch, token: string): Promise<LinkedAccountIdentity> => {
  let response: Response
  try {
    response = await fetcher(GITHUB_API_USER_URL, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'NekroNXT',
        'x-github-api-version': '2022-11-28',
      },
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    throw new LinkedAccountError('连不上 GitHub，检查网络后再试。')
  }
  if (response.status === 401) throw new LinkedAccountError('GitHub 不接受这个 token，可能已过期或被撤销。')
  if (!response.ok) throw new LinkedAccountError(`GitHub 返回了 ${response.status}，稍后再试。`)
  const body = z.object({ login: z.string() }).safeParse(await response.json())
  if (!body.success || !LOGIN_PATTERN.test(body.data.login)) {
    throw new LinkedAccountError('GitHub 没有返回账号名。')
  }
  const header = response.headers.get('x-oauth-scopes')
  return {
    login: body.data.login,
    ...(header === null
      ? {}
      : {
          scopes: header
            .split(',')
            .map((scope) => scope.trim())
            .filter((scope) => scope !== ''),
        }),
  }
}

const USAGE_TEXT: Record<CommandAccountUsage, string> = {
  read: '查看仓库、issue 和 PR',
  issues: '创建和评论 issue',
  'pull-requests': '创建和更新 PR',
  push: '推送代码',
}

/** The GitHub CLI as the platform needs it: where the program is and whether it can be downloaded. */
export interface GithubCliPort {
  executable(): string | undefined
  /** The directory to put in front of `PATH`; `undefined` when `gh` is already on it. */
  directoryForPath(): string | undefined
  status(): GithubCliStatus
}

/**
 * GitHub accounts (命令账号授权 A4–A9). Commands receive the token as `GH_TOKEN`, a scratch `gh` configuration, and an
 * in-memory credential helper so `git` over https uses the same token without it reaching any file.
 */
export const createGithubPlatform = (options: {
  readonly cli: GithubCliPort
  readonly fetch?: typeof fetch
}): LinkedAccountPlatform => {
  const fetcher: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init))
  return {
    id: 'github',
    name: 'GitHub',
    addMethods: ['token', 'gh-login'],
    tokenOf: (source) => githubTokenOf(source, options.cli.executable()),
    verify: (token) => verifyGithubToken(fetcher, token),
    sameAccount: (current, next) => current.login.toLowerCase() === next.login.toLowerCase(),
    commandEnvironment: ({ agentId, token, basePath = process.env['PATH'] }) => {
      const cliDirectory = options.cli.directoryForPath()
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
    },
    promptLines: ({ login, usage }) => [
      options.cli.executable() !== undefined
        ? `命令里的 GitHub 已用账号 ${login} 登录：gh 可以直接用，git 走 https 也会带上这个账号。`
        : `命令里的 GitHub 账号是 ${login}，这台设备上没有 gh：需要时用 curl 调 GitHub 的 REST 接口，请求头里带环境变量 GH_TOKEN；git 走 https 会自动带上这个账号。`,
      ...(usage.length === 0
        ? []
        : [
            `这个账号交给你的用途是：${usage.map((hint) => USAGE_TEXT[hint]).join('、')}。用途之外的操作，先和管理员确认。`,
          ]),
    ],
    tool: () => ({ id: 'github-cli', name: 'GitHub CLI', availability: options.cli.status() }),
    localLogins: () => localGithubLogins(options.cli.executable()),
  }
}
