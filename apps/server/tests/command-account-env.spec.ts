import { Context } from '@deepseek-ai/cordis'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentIdSchema, CredentialIdSchema, type CommandCredentialGrant } from '@nekro-nxt/contracts'
import {
  commandCredentialEnvironment,
  commandCredentialPrompt,
  createEnvForwardingExecutor,
  effectiveCommandGrants,
  type CommandCredential,
  type CommandCredentialSources,
} from '../src/command-account-env.ts'
import { createConfinedSandboxProvider } from '../src/command-confinement.ts'

const directories: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const agent = AgentIdSchema.parse('agt_fixture')
const githubId = CredentialIdSchema.parse('crd_acct')
const weatherId = CredentialIdSchema.parse('crd_weather')

/** Credentials the library clears for the fixture agent; anything else is gone, out of scope or request-only. */
const cleared: Record<string, CommandCredential> = {
  [githubId]: {
    name: 'GitHub octo-fixture',
    description: '',
    kind: 'github',
    login: 'octo-fixture',
    value: 'tok-fixture',
  },
  [weatherId]: { name: '天气服务', description: '示例天气接口', kind: 'generic', value: 'weather-fixture-key' },
}

const sources = (overrides: Partial<CommandCredentialSources> = {}): CommandCredentialSources => ({
  credential: (id, agentId) => (agentId === agent ? cleared[id] : undefined),
  githubCliDirectory: () => undefined,
  githubCliAvailable: () => true,
  ...overrides,
})

const grant: CommandCredentialGrant = { credentialId: githubId, env: 'GH_TOKEN', usage: [] }
const weather: CommandCredentialGrant = { credentialId: weatherId, env: 'WEATHER_KEY', usage: [] }

describe('command credential environment', () => {
  it('gives commands the token for gh and, through an in-memory helper, for git', () => {
    const env = commandCredentialEnvironment(agent, [grant], sources(), '/usr/bin')
    expect(env['GH_TOKEN']).toBe('tok-fixture')
    expect(env['GIT_CONFIG_KEY_0']).toBe('credential.https://github.com.helper')
    expect(env['GIT_CONFIG_VALUE_0']).toContain('$GH_TOKEN')
    expect(env['GIT_CONFIG_VALUE_0']).not.toContain('tok-fixture')
    expect(env['GH_CONFIG_DIR']).toBe(path.join(tmpdir(), 'nekro-nxt-gh', 'agt_fixture'))
    expect(env).not.toHaveProperty('PATH')
  })

  it('gives a generic credential under its variable name and records the use', () => {
    const used: string[] = []
    const env = commandCredentialEnvironment(agent, [weather], sources({ used: (id) => used.push(id) }), '/usr/bin')
    expect(env).toEqual({ WEATHER_KEY: 'weather-fixture-key' })
    expect(used).toEqual([weatherId])
  })

  it('puts a downloaded gh in front of PATH', () => {
    const env = commandCredentialEnvironment(
      agent,
      [grant],
      sources({ githubCliDirectory: () => '/data/runtimes/gh/bin' }),
      '/usr/bin',
    )
    expect(env['PATH']).toBe(`/data/runtimes/gh/bin${path.delimiter}/usr/bin`)
  })

  it('adds nothing without a grant, for a credential that is gone, or for another agent', () => {
    const other = AgentIdSchema.parse('agt_other')
    expect(commandCredentialEnvironment(agent, [], sources())).toEqual({})
    expect(
      commandCredentialEnvironment(
        agent,
        [{ ...grant, credentialId: CredentialIdSchema.parse('crd_gone') }],
        sources(),
      ),
    ).toEqual({})
    expect(commandCredentialEnvironment(other, [grant, weather], sources())).toEqual({})
    expect(commandCredentialPrompt(agent, [], sources())).toBeUndefined()
    expect(commandCredentialPrompt(other, [grant], sources())).toBeUndefined()
  })

  it('maps older account grants to their migrated credentials and keeps the first grant of a variable', () => {
    expect(
      effectiveCommandGrants({
        commandCredentials: [weather],
        commandAccounts: [{ accountId: 'acct', usage: ['read'] }],
      }),
    ).toEqual([weather, { credentialId: githubId, env: 'GH_TOKEN', usage: ['read'] }])
    expect(
      effectiveCommandGrants({
        commandCredentials: [{ ...weather, env: 'GH_TOKEN' }],
        commandAccounts: [{ accountId: 'acct', usage: [] }],
      }),
    ).toEqual([{ ...weather, env: 'GH_TOKEN' }])
  })

  it('tells the agent which account it acts as, the usage hint as guidance, and each variable it has', () => {
    expect(commandCredentialPrompt(agent, [grant], sources())).toBe(
      '命令里的 GitHub 已用账号 octo-fixture 登录：gh 可以直接用，git 走 https 也会带上这个账号。',
    )
    const hinted = commandCredentialPrompt(agent, [{ ...grant, usage: ['issues', 'read'] }], sources())
    expect(hinted).toContain('这个账号交给你的用途是：创建和评论 issue、查看仓库、issue 和 PR。')
    expect(hinted).toContain('先和管理员确认')
    const generic = commandCredentialPrompt(agent, [weather], sources())
    expect(generic).toContain('WEATHER_KEY')
    expect(generic).toContain('天气服务')
    expect(generic).not.toContain('weather-fixture-key')
  })

  it('says plainly when gh is not installed, without exposing the token', () => {
    const prompt = commandCredentialPrompt(agent, [grant], sources({ githubCliAvailable: () => false }))
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
      const env = commandCredentialEnvironment(agent, [grant], sources(), '/usr/bin')
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
