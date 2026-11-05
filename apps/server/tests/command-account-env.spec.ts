import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentIdSchema, CredentialIdSchema, LinkedAccountIdSchema, type AgentId } from '@nekro-nxt/contracts'
import type { CommandAccountGrant } from '@nekro-nxt/core'
import {
  commandCredentialEnvironment,
  commandCredentialPrompt,
  createEnvForwardingExecutor,
  createPwshEnvForwardingExecutor,
  programSearchPath,
  type CommandAccount,
  type CommandCredential,
  type CommandCredentialSources,
} from '../src/command-account-env.ts'
import { createGithubPlatform } from '../src/linked-accounts/github.ts'
import { mountDevelopmentCapabilities, windowsCommandsPrompt } from '../src/index.ts'
import { createConfinedSandboxProvider } from '../src/command-confinement.ts'

const directories: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const agent = AgentIdSchema.parse('agt_fixture')
const grant = { service: 'github' as const, accountId: 'acc_fixture', usage: [] }

/** A GitHub platform whose `gh` is on PATH for the environment tests. */
const githubPlatform = (options: { readonly cliAvailable?: boolean } = {}) =>
  createGithubPlatform({
    cli: { executable: () => (options.cliAvailable === false ? undefined : '/usr/bin/gh') },
  })

const githubAccount = (platform = githubPlatform(), usage: CommandAccountGrant['usage'] = []): CommandAccount => ({
  id: LinkedAccountIdSchema.parse('acc_fixture'),
  label: 'GitHub octo-fixture',
  environment: platform.commandEnvironment({ agentId: agent, token: 'tok-fixture' }),
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
      '命令里的 GitHub 已用账号 octo-fixture 登录：gh 可以直接用，git 走 https 也会带上这个账号。gh 操作仓库时用 -R 所有者/仓库 写明是哪个仓库；GH_TOKEN 和 GH_CONFIG_DIR 已经设好，不要改。',
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
      '命令里的 GitHub 已用账号 octo-fixture 登录：gh 可以直接用，git 走 https 也会带上这个账号。gh 操作仓库时用 -R 所有者/仓库 写明是哪个仓库；GH_TOKEN 和 GH_CONFIG_DIR 已经设好，不要改。',
      '命令的环境变量 WEATHER_KEY 是凭据「天气服务」（示例天气接口），用 $WEATHER_KEY 引用，不要把它的值打印出来。',
    ])
    expect(both).not.toContain('weather-fixture-key')
    expect(both).not.toContain('tok-fixture')
  })

  it('on Windows, refers to variables the PowerShell way and promises no git over https (#96)', () => {
    const windowsGithub = createGithubPlatform({ cli: { executable: () => 'C:\\gh\\gh.exe' }, platform: 'win32' })
    const prompt = commandCredentialPrompt(agent, [grant], sources([weather], [githubAccount(windowsGithub)]), 'win32')
    expect(prompt).toContain('用 $env:WEATHER_KEY 引用')
    expect(prompt).toContain('gh 可以直接用')
    expect(prompt).not.toContain('git 走 https')
    const withoutGh = createGithubPlatform({ cli: { executable: () => undefined }, platform: 'win32' })
    expect(withoutGh.promptLines({ login: 'octo-fixture', usage: [] })[0]).toContain('curl.exe')
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

describe('program search path', () => {
  const programs = [
    { path: '/data/runtimes/media/b6.1.1/ffmpeg', source: 'downloaded' },
    { path: '/data/runtimes/media/b6.1.1/ffprobe', source: 'downloaded' },
    { path: '/opt/fixture/bin/gh', source: 'system' },
    { path: '/usr/bin/node', source: 'system' },
  ]

  it('puts downloaded programs in front, folders of this device missing from PATH last, each once', () => {
    expect(programSearchPath(programs, '/usr/bin:/bin', ':')).toBe(
      '/data/runtimes/media/b6.1.1:/usr/bin:/bin:/opt/fixture/bin',
    )
  })

  it('leaves PATH alone when every folder is already on it', () => {
    expect(programSearchPath([{ path: '/usr/bin/node', source: 'system' }], '/usr/bin:/bin', ':')).toBeUndefined()
    expect(programSearchPath([], '/usr/bin', ':')).toBeUndefined()
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
  const executor = shellOf(ctx)
  const spec = executor.resolve({ command, workdir: workspace, dshEnv: {} })
  return (await (await executor.execute(spec)).result()).stdout.text.trim()
}

describe.skipIf(process.platform === 'win32')('commands receive the granted account', () => {
  it('forwards the variables through the confined executor while the host environment stays scrubbed', async () => {
    vi.stubEnv('GH_TOKEN', 'host-token-must-not-leak')
    vi.stubEnv('SOME_API_TOKEN', 'another-host-token')
    const command = 'echo "gh=$GH_TOKEN other=$SOME_API_TOKEN"'
    expect(await runCommand('danger-full-access', {}, command)).toBe('gh= other=')
    expect(await runCommand('danger-full-access', { GH_TOKEN: 'tok-fixture' }, command)).toBe('gh=tok-fixture other=')
  })

  it('finds an add-on program through the PATH it is given', async () => {
    const folder = realpathSync(mkdtempSync(path.join(tmpdir(), 'nekro-nxt-program-')))
    directories.push(folder)
    writeFileSync(path.join(folder, 'fixture-tool'), '#!/bin/sh\necho fixture-tool-ran\n', { mode: 0o755 })
    const searchPath = programSearchPath(
      [{ path: path.join(folder, 'fixture-tool'), source: 'downloaded' }],
      process.env['PATH'],
    )
    expect(await runCommand('danger-full-access', { PATH: searchPath! }, 'fixture-tool')).toBe('fixture-tool-ran')
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

describe('commands on Windows run in PowerShell at every access level (#96)', () => {
  /** Mounts an agent's development capabilities the way the host does, as if this were a Windows device. */
  const mountForWindows = async (
    unrestrictedFileAccess: boolean,
    environment: Record<string, string> = {},
    hostPrompt = '',
  ) => {
    const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), 'nekro-nxt-pwsh-')))
    directories.push(workspace)
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, { personaPrefix: '', includeHarnessIdentity: false })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SessionProjections)
    await mountDevelopmentCapabilities(
      ctx,
      { fileTools: true, developmentShell: true, unrestrictedFileAccess },
      workspace,
      { hidden: [], readable: [], network: true },
      () => environment,
      () => true,
      'win32',
      () => [],
      hostPrompt,
    )
    return { ctx, workspace }
  }

  it.each([false, true])('gives the agent the pwsh tool and no bash tool (full access: %s)', async (unrestricted) => {
    const { ctx } = await mountForWindows(unrestricted)
    expect(ctx.tools.get('pwsh')).toBeDefined()
    expect(ctx.tools.get('bash')).toBeUndefined()
    expect(JSON.stringify(await ctx.systemPrompt.assemble())).toContain('命令用 PowerShell 运行')
  })

  it('adds the programs line to the Windows commands section (#113)', async () => {
    const { ctx } = await mountForWindows(true, {}, '命令里还有：python、node。')
    const section = (await ctx.systemPrompt.assemble()).sections.find(
      ({ name }) => name === 'nekro-nxt:windows-commands',
    )
    expect(section?.text).toMatch(/^这台设备是 Windows[\s\S]*\n命令里还有：python、node。$/u)
  })

  it('forwards the agent credentials to PowerShell commands', async () => {
    const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), 'nekro-nxt-pwsh-')))
    directories.push(workspace)
    const ctx = new Context()
    await ctx.plugin(SessionProjections)
    await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: workspace })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(
      createConfinedSandboxProvider(() => ({ hidden: [], readable: [], network: true })),
      {},
    )
    await ctx.plugin(
      createPwshEnvForwardingExecutor(() => ({ WEATHER_KEY: 'weather-fixture-key' })),
      { cwd: workspace, pwshPath: '' },
    )
    expect(shellOf(ctx).resolve({ command: 'Get-Location', workdir: workspace, dshEnv: {} })).toMatchObject({
      env: { WEATHER_KEY: 'weather-fixture-key' },
    })
  })

  it('tells the agent what fails inside the sandbox and what git and bash it has', () => {
    const confined = windowsCommandsPrompt(false, true)
    expect(confined).toContain('`2>&1`')
    expect(confined).toContain('「完整访问」')
    expect(confined).toContain('git 做本地操作')
    expect(confined).not.toContain('bash -c')
    const full = windowsCommandsPrompt(true, true)
    expect(full).toContain('bash -c')
    expect(full).not.toContain('沙箱')
    expect(windowsCommandsPrompt(true, false)).toContain('安装「Git 与 Bash」')
  })
})

describe('the command host section (#113)', () => {
  it.each([
    ['这台设备是 Ubuntu 24.04 LTS，命令用 bash 运行，用户不是 root。', true],
    ['', false],
  ])('shows %j to an agent with bash commands', async (hostPrompt, shown) => {
    const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), 'nekro-nxt-host-')))
    directories.push(workspace)
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, { personaPrefix: '', includeHarnessIdentity: false })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SessionProjections)
    await mountDevelopmentCapabilities(
      ctx,
      { fileTools: true, developmentShell: true, unrestrictedFileAccess: true },
      workspace,
      { hidden: [], readable: [], network: true },
      () => ({}),
      () => false,
      'linux',
      () => [],
      hostPrompt,
    )
    expect(ctx.tools.get('bash')).toBeDefined()
    const assembled = JSON.stringify(await ctx.systemPrompt.assemble())
    expect(assembled.includes('命令用 bash 运行')).toBe(shown)
  })
})
