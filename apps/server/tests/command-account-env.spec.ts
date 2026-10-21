import { Context } from '@deepseek-ai/cordis'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentIdSchema, CredentialIdSchema, LinkedAccountIdSchema, type AgentId } from '@nekro-nxt/contracts'
import type { CommandAccountGrant } from '@nekro-nxt/core'
import {
  commandCredentialEnvironment,
  commandCredentialPrompt,
  createEnvForwardingExecutor,
  type CommandAccount,
  type CommandCredential,
  type CommandCredentialSources,
} from '../src/command-account-env.ts'
import { createGithubPlatform } from '../src/linked-accounts/github.ts'
import { createConfinedSandboxProvider } from '../src/command-confinement.ts'

const directories: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const agent = AgentIdSchema.parse('agt_fixture')
const grant = { service: 'github' as const, accountId: 'acc_fixture', usage: [] }

/** A GitHub platform whose `gh` is on PATH (or downloaded to `cliDirectory`) for the environment tests. */
const githubPlatform = (options: { readonly cliDirectory?: string; readonly cliAvailable?: boolean } = {}) =>
  createGithubPlatform({
    cli: {
      executable: () => (options.cliAvailable === false ? undefined : '/usr/bin/gh'),
      directoryForPath: () => options.cliDirectory,
      status: () => ({ available: options.cliAvailable !== false }),
    },
  })

const githubAccount = (platform = githubPlatform(), usage: CommandAccountGrant['usage'] = []): CommandAccount => ({
  id: LinkedAccountIdSchema.parse('acc_fixture'),
  label: 'GitHub octo-fixture',
  environment: platform.commandEnvironment({ agentId: agent, token: 'tok-fixture', basePath: '/usr/bin' }),
  prompt: platform.promptLines({ login: 'octo-fixture', usage }),
})
const weather: CommandCredential = {
  id: CredentialIdSchema.parse('crd_weather'),
  name: '天气服务',
  description: '示例天气接口',
  env: 'WEATHER_KEY',
  value: 'weather-fixture-key',
}

/** The libraries' answer for the fixture agent; other agents receive nothing, and accounts need a grant. */
const sources = (
  credentials: readonly CommandCredential[],
  accounts: readonly CommandAccount[] = [],
  overrides: Partial<CommandCredentialSources> = {},
): CommandCredentialSources => ({
  credentials: (agentId: AgentId) => (agentId === agent ? credentials : []),
  accounts: (agentId: AgentId, grants) => (agentId === agent && grants.length > 0 ? accounts : []),
  ...overrides,
})

describe('command credential environment', () => {
  it('gives commands the GitHub token for gh and, through an in-memory helper, for git', () => {
    const env = commandCredentialEnvironment(agent, [grant], sources([], [githubAccount()]))
    expect(env['GH_TOKEN']).toBe('tok-fixture')
    expect(env['GIT_CONFIG_KEY_0']).toBe('credential.https://github.com.helper')
    expect(env['GIT_CONFIG_VALUE_0']).toContain('$GH_TOKEN')
    expect(env['GIT_CONFIG_VALUE_0']).not.toContain('tok-fixture')
    expect(env['GH_CONFIG_DIR']).toBe(path.join(tmpdir(), 'nekro-nxt-gh', 'agt_fixture'))
    expect(env).not.toHaveProperty('PATH')
  })

  it('gives a generic credential under its own variable and records the use', () => {
    const used: string[] = []
    const env = commandCredentialEnvironment(agent, [], sources([weather], [], { used: (id) => used.push(id) }))
    expect(env).toEqual({ WEATHER_KEY: 'weather-fixture-key' })
    expect(used).toEqual([weather.id])
  })

  it('puts a downloaded gh in front of PATH', () => {
    const env = commandCredentialEnvironment(
      agent,
      [grant],
      sources([], [githubAccount(githubPlatform({ cliDirectory: '/data/runtimes/gh/bin' }))]),
    )
    expect(env['PATH']).toBe(`/data/runtimes/gh/bin${path.delimiter}/usr/bin`)
  })

  it('lets the account win where it and a credential set the same variable, and says so once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const clash: CommandCredential = { ...weather, name: '旧令牌', env: 'GH_TOKEN', value: 'credential-value' }
    const accountUsed: string[] = []
    const both = sources([clash, weather], [githubAccount()], { accountUsed: (id) => accountUsed.push(id) })
    expect(commandCredentialEnvironment(agent, [grant], both)).toMatchObject({
      GH_TOKEN: 'tok-fixture',
      WEATHER_KEY: 'weather-fixture-key',
    })
    commandCredentialEnvironment(agent, [grant], both)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('GH_TOKEN')
    expect(String(warn.mock.calls[0]?.[0])).not.toContain('credential-value')
    expect(accountUsed).toEqual(['acc_fixture', 'acc_fixture'])
    warn.mockRestore()
  })

  it('adds nothing when the agent receives no credential and no account', () => {
    const other = AgentIdSchema.parse('agt_other')
    expect(commandCredentialEnvironment(agent, [], sources([]))).toEqual({})
    expect(commandCredentialEnvironment(other, [grant], sources([weather], [githubAccount()]))).toEqual({})
    expect(commandCredentialEnvironment(agent, [], sources([], [githubAccount()]))).toEqual({})
    expect(commandCredentialPrompt(agent, [], sources([]))).toBeUndefined()
  })

  it('tells the agent which account it acts as, the usage hint as guidance, and each variable it has', () => {
    expect(commandCredentialPrompt(agent, [grant], sources([], [githubAccount()]))).toBe(
      '命令里的 GitHub 已用账号 octo-fixture 登录：gh 可以直接用，git 走 https 也会带上这个账号。',
    )
    const hinted = commandCredentialPrompt(
      agent,
      [grant],
      sources([], [githubAccount(githubPlatform(), ['issues', 'read'])]),
    )
    expect(hinted).toContain('这个账号交给你的用途是：创建和评论 issue、查看仓库、issue 和 PR。')
    expect(hinted).toContain('先和管理员确认')
    const both = commandCredentialPrompt(agent, [grant], sources([weather], [githubAccount()]))
    expect(both?.split('\n')).toEqual([
      '命令里的 GitHub 已用账号 octo-fixture 登录：gh 可以直接用，git 走 https 也会带上这个账号。',
      '命令的环境变量 WEATHER_KEY 是凭据「天气服务」（示例天气接口），用 $WEATHER_KEY 引用，不要把它的值打印出来。',
    ])
    expect(both).not.toContain('weather-fixture-key')
    expect(both).not.toContain('tok-fixture')
  })

  it('says plainly when gh is not installed, without exposing the token', () => {
    const prompt = commandCredentialPrompt(
      agent,
      [grant],
      sources([], [githubAccount(githubPlatform({ cliAvailable: false }))]),
    )
    expect(prompt).toContain('没有 gh')
    expect(prompt).toContain('GH_TOKEN')
    expect(prompt).not.toContain('tok-fixture')
  })
})

interface ShellLike {
  resolve(request: object): object
  execute(spec: object): Promise<{ result(): Promise<{ stdout: { text: string } }> }>
}

const isShell = (value: unknown): value is ShellLike =>
  typeof value === 'object' && value !== null && 'resolve' in value && 'execute' in value

const shellOf = (ctx: Context): ShellLike => {
  const shell: unknown = Reflect.get(ctx, 'shell')
  if (!isShell(shell)) throw new Error('The shell service is not mounted.')
  return shell
}

/** Runs one command through DSH's own shell executor, the way an agent's tool call does. */
const runCommand = async (
  mode: 'workspace-write' | 'danger-full-access',
  environment: Record<string, string>,
  command: string,
) => {
  const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), 'nekro-nxt-env-')))
  directories.push(workspace)
  const ctx = new Context()
  await ctx.plugin(SessionProjections)
  await ctx.plugin(SandboxPolicyService, { mode, workspaceRoot: workspace })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(
    createConfinedSandboxProvider(() => ({ hidden: [], readable: [], network: true })),
    {},
  )
  await ctx.plugin(
    createEnvForwardingExecutor(() => environment),
    { cwd: workspace },
  )
  const shell = shellOf(ctx)
  const spec = shell.resolve({ command, workdir: workspace, dshEnv: {} })
  return (await (await shell.execute(spec)).result()).stdout.text.trim()
}

describe.skipIf(process.platform === 'win32')('commands receive the granted account', () => {
  it('forwards the variables through the confined executor while the host environment stays scrubbed', async () => {
    vi.stubEnv('GH_TOKEN', 'host-token-must-not-leak')
    vi.stubEnv('SOME_API_TOKEN', 'another-host-token')
    const command = 'echo "gh=$GH_TOKEN other=$SOME_API_TOKEN"'
    expect(await runCommand('danger-full-access', {}, command)).toBe('gh= other=')
    expect(await runCommand('danger-full-access', { GH_TOKEN: 'tok-fixture' }, command)).toBe('gh=tok-fixture other=')
  })

  it.runIf(process.platform === 'darwin')('also under the confined workspace mode', async () => {
    expect(await runCommand('workspace-write', { GH_TOKEN: 'tok-fixture' }, 'echo "gh=$GH_TOKEN"')).toBe(
      'gh=tok-fixture',
    )
  })

  it.runIf(process.platform === 'darwin')(
    'leaves the scratch gh configuration writable inside the confined workspace mode',
    async () => {
      const env = commandCredentialEnvironment(agent, [grant], sources([], [githubAccount()]))
      expect(
        await runCommand(
          'workspace-write',
          env,
          'mkdir -p "$GH_CONFIG_DIR" && echo written > "$GH_CONFIG_DIR/probe" && cat "$GH_CONFIG_DIR/probe"',
        ),
      ).toBe('written')
    },
  )

  it('reads the environment when each command starts, so a removed account stops at the next command', async () => {
    const live: Record<string, string> = { GH_TOKEN: 'tok-fixture' }
    const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), 'nekro-nxt-env-')))
    directories.push(workspace)
    const ctx = new Context()
    await ctx.plugin(SessionProjections)
    await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: workspace })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(
      createConfinedSandboxProvider(() => ({ hidden: [], readable: [], network: true })),
      {},
    )
    await ctx.plugin(
      createEnvForwardingExecutor(() => live),
      { cwd: workspace },
    )
    const shell = shellOf(ctx)
    const echo = async () =>
      (
        await (
          await shell.execute(shell.resolve({ command: 'echo "gh=$GH_TOKEN"', workdir: workspace, dshEnv: {} }))
        ).result()
      ).stdout.text.trim()
    expect(await echo()).toBe('gh=tok-fixture')
    delete live['GH_TOKEN']
    expect(await echo()).toBe('gh=')
  })
})
