import { Context } from '@deepseek-ai/cordis'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  commandAccountEnvironment,
  commandAccountPrompt,
  createEnvForwardingExecutor,
  type CommandAccountSources,
} from '../src/command-account-env.ts'
import { createConfinedSandboxProvider } from '../src/command-confinement.ts'

const directories: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const sources = (overrides: Partial<CommandAccountSources> = {}): CommandAccountSources => ({
  tokenFor: (id) => (id === 'acct-a' ? 'tok-fixture' : undefined),
  loginOf: (id) => (id === 'acct-a' ? 'octo-fixture' : undefined),
  githubCliDirectory: () => undefined,
  githubCliAvailable: () => true,
  ...overrides,
})

const grant = { service: 'github', accountId: 'acct-a', usage: [] } as const

describe('command account environment', () => {
  it('gives commands the token for gh and, through an in-memory helper, for git', () => {
    const env = commandAccountEnvironment('agent-1', [grant], sources(), '/usr/bin')
    expect(env['GH_TOKEN']).toBe('tok-fixture')
    expect(env['GIT_CONFIG_KEY_0']).toBe('credential.https://github.com.helper')
    expect(env['GIT_CONFIG_VALUE_0']).toContain('$GH_TOKEN')
    expect(env['GIT_CONFIG_VALUE_0']).not.toContain('tok-fixture')
    expect(env['GH_CONFIG_DIR']).toBe(path.join(tmpdir(), 'nekro-nxt-gh', 'agent-1'))
    expect(env).not.toHaveProperty('PATH')
  })

  it('puts a downloaded gh in front of PATH', () => {
    const env = commandAccountEnvironment(
      'agent-1',
      [grant],
      sources({ githubCliDirectory: () => '/data/runtimes/gh/bin' }),
      '/usr/bin',
    )
    expect(env['PATH']).toBe(`/data/runtimes/gh/bin${path.delimiter}/usr/bin`)
  })

  it('adds nothing without a grant, for an account that was removed, or one without a token', () => {
    expect(commandAccountEnvironment('agent-1', [], sources())).toEqual({})
    expect(commandAccountEnvironment('agent-1', [{ ...grant, accountId: 'gone' }], sources())).toEqual({})
    expect(commandAccountPrompt([], sources())).toBeUndefined()
    expect(commandAccountPrompt([{ ...grant, accountId: 'gone' }], sources())).toBeUndefined()
  })

  it('tells the agent which account it acts as, and the usage hint as guidance', () => {
    expect(commandAccountPrompt([grant], sources())).toBe(
      '命令里的 GitHub 已用账号 octo-fixture 登录：gh 可以直接用，git 走 https 也会带上这个账号。',
    )
    const hinted = commandAccountPrompt([{ ...grant, usage: ['issues', 'read'] }], sources())
    expect(hinted).toContain('这个账号交给你的用途是：创建和评论 issue、查看仓库、issue 和 PR。')
    expect(hinted).toContain('先和管理员确认')
  })

  it('says plainly when gh is not installed, without exposing the token', () => {
    const prompt = commandAccountPrompt([grant], sources({ githubCliAvailable: () => false }))
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
      const env = commandAccountEnvironment('agt_fixture', [grant], sources(), '/usr/bin')
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
