import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { GithubCredentialSource } from '@nekro-nxt/contracts'

const run = promisify(execFile)

const GITHUB_API_USER_URL = 'https://api.github.com/user'
const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u

/** A message safe to show the user: what failed, without the token. */
export class CredentialError extends Error {}

export interface GithubIdentity {
  readonly login: string
  readonly scopes?: string[]
}

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
  source: GithubCredentialSource,
  executable: string | undefined,
): Promise<string> => {
  if (source.source === 'token') return source.token.trim()
  if (!LOGIN_PATTERN.test(source.login)) throw new CredentialError('账号名不合法。')
  if (executable === undefined) throw new CredentialError('这台设备上没有 GitHub CLI。')
  try {
    const { stdout } = await run(executable, ['auth', 'token', '--hostname', 'github.com', '--user', source.login], {
      timeout: 15_000,
    })
    const token = stdout.trim()
    if (token === '') throw new Error('empty')
    return token
  } catch {
    throw new CredentialError(`没有取到 ${source.login} 的登录，请先在终端里用 gh auth login 登录。`)
  }
}

/** Asks GitHub whose token this is; the scopes come back for classic tokens only. */
export const verifyGithubToken = async (fetcher: typeof fetch, token: string): Promise<GithubIdentity> => {
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
    throw new CredentialError('连不上 GitHub，检查网络后再试。')
  }
  if (response.status === 401) throw new CredentialError('GitHub 不接受这个 token，可能已过期或被撤销。')
  if (!response.ok) throw new CredentialError(`GitHub 返回了 ${response.status}，稍后再试。`)
  const body = z.object({ login: z.string() }).safeParse(await response.json())
  if (!body.success || !LOGIN_PATTERN.test(body.data.login)) {
    throw new CredentialError('GitHub 没有返回账号名。')
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
