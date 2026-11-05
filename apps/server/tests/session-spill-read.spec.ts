import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { extendConfinedArgv, hostCommandConfinement } from '../src/command-confinement.ts'
import { sessionSpillDirectory } from '../src/dsh-spill.ts'
import { mountWorkspaceFileTools } from '../src/workspace-file-tools.ts'
import { createWorkspaceFileSystem } from '../src/workspace-file-system.ts'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/**
 * A fictional data root with one agent workspace and the spill files of two Sessions. It lives outside the system
 * temporary directory, which DSH lets every workspace write to, so a refused write is the spill rule at work.
 */
const fixture = () => {
  const cache = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '.cache')
  mkdirSync(cache, { recursive: true })
  const data = realpathSync(mkdtempSync(path.join(cache, 'nekro-nxt-spill-')))
  directories.push(data)
  const workspace = path.join(data, 'workspaces', 'agent-a')
  const spillRoot = path.join(data, 'dsh', 'spill')
  const own = sessionSpillDirectory(spillRoot, 'nxt-episode-own')
  const other = sessionSpillDirectory(spillRoot, 'nxt-episode-other')
  for (const directory of [workspace, own, other]) mkdirSync(directory, { recursive: true })
  writeFileSync(path.join(own, 'a1b2c3-bash.txt'), 'own tool output line')
  writeFileSync(path.join(other, 'd4e5f6-bash.txt'), 'other tool output line')
  return { data, workspace, spillRoot, own, other }
}

describe('reading back the Session spill files (#130)', () => {
  const mountFs = async () => {
    const paths = fixture()
    const context = new Context()
    await context.plugin(SessionProjections)
    await context.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: paths.workspace })
    await context.plugin(
      createWorkspaceFileSystem(() => [paths.own]),
      { cwd: paths.workspace },
    )
    return { fs: context.fs, ...paths }
  }

  it("reads and lists this Session's spill files", async () => {
    const { fs, own } = await mountFs()
    const file = path.join(own, 'a1b2c3-bash.txt')
    expect(await fs.readText(await fs.resolve(file))).toBe('own tool output line')
    expect(await fs.stat(await fs.resolve(file))).toBeDefined()
    expect(await fs.lstat(file)).toBeDefined()
    expect((await fs.listDir(await fs.resolve(own))).map((entry) => entry.name)).toEqual(['a1b2c3-bash.txt'])
  })

  it("refuses another Session's spill files and the spill root itself", async () => {
    const { fs, other, spillRoot } = await mountFs()
    await expect(fs.readText(await fs.resolve(path.join(other, 'd4e5f6-bash.txt')))).rejects.toMatchObject({
      code: 'FS_SANDBOX_DENIED',
    })
    await expect(fs.listDir(await fs.resolve(spillRoot))).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  })

  it('refuses paths that climb or link out of the Session spill directory', async () => {
    const { fs, own, other } = await mountFs()
    const climbing = path.join(own, '..', path.basename(other), 'd4e5f6-bash.txt')
    await expect(fs.readText(await fs.resolve(climbing))).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    symlinkSync(path.join(other, 'd4e5f6-bash.txt'), path.join(own, 'link.txt'))
    await expect(fs.readText(await fs.resolve(path.join(own, 'link.txt')))).rejects.toMatchObject({
      code: 'FS_SANDBOX_DENIED',
    })
  })

  it('keeps the spill files read-only while the workspace stays writable', async () => {
    const { fs, own, workspace } = await mountFs()
    const file = path.join(own, 'a1b2c3-bash.txt')
    await expect(fs.writeText(await fs.resolve(file), 'changed')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    await expect(fs.writeText(await fs.resolve(path.join(own, 'new.txt')), 'new')).rejects.toMatchObject({
      code: 'FS_SANDBOX_DENIED',
    })
    expect(readFileSync(file, 'utf8')).toBe('own tool output line')
    await fs.writeText(await fs.resolve(path.join(workspace, 'notes.txt')), 'notes')
    expect(readFileSync(path.join(workspace, 'notes.txt'), 'utf8')).toBe('notes')
  })

  it("lets grep and glob search this Session's spill files only", async () => {
    const { workspace, own, other } = fixture()
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, { personaPrefix: '', includeHarnessIdentity: false })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SessionProjections)
    await ctx.plugin(LocalSubprocessRuntime)
    mountWorkspaceFileTools(ctx, { workspace, unrestricted: false, readOnlyRoots: () => [own] })
    const run = async (name: string, args: Record<string, unknown>) => {
      const result = await ctx.tools.execute({
        callId: ToolCallId(`${name}-call`),
        name,
        arguments: args,
        signal: new AbortController().signal,
      })
      return {
        isError: result.isError,
        text: result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n'),
      }
    }
    const grep = await run('grep', { pattern: 'tool output', path: own })
    expect(grep.isError).toBe(false)
    expect(grep.text).toContain('a1b2c3-bash.txt')
    expect((await run('glob', { pattern: '*.txt', path: own })).text).toContain('a1b2c3-bash.txt')
    expect((await run('grep', { pattern: 'tool output', path: other })).isError).toBe(true)
    expect((await run('grep', { pattern: 'tool output', path: path.join(own, '..') })).isError).toBe(true)
  })

  it.runIf(process.platform === 'darwin')(
    "lets confined commands read this Session's spill files but not write them on macOS",
    () => {
      const { data, workspace, own, other } = fixture()
      const base = hostCommandConfinement({
        dataRoot: data,
        workspaceRoot: path.join(data, 'workspaces'),
        installRoot: path.join(data, 'install'),
        runtimeRoots: [],
        home: path.join(data, 'home'),
        pathEnv: '',
      })
      const confinement = { ...base, readable: [...base.readable, own], network: false }
      const policy = { mode: 'workspace-write' as const, workspaceRoot: workspace }
      const profile = '(version 1) (allow default) (deny file-write*) (allow file-write* (subpath "' + workspace + '"))'
      const argv = extendConfinedArgv(
        ['/usr/bin/sandbox-exec', '-p', profile, '--', '/bin/bash', '-c', 'true'],
        policy,
        confinement,
        { childOutput: true, readScope: true, networkControl: true },
      )
      const run = (script: string) =>
        spawnSync(argv[0]!, [...argv.slice(1, -1), script], { cwd: workspace, encoding: 'utf8' }).stdout.trim()
      expect(run(`cat "${path.join(own, 'a1b2c3-bash.txt')}"`)).toBe('own tool output line')
      expect(run(`cat "${path.join(other, 'd4e5f6-bash.txt')}" 2>/dev/null || echo denied`)).toBe('denied')
      expect(run(`echo changed > "${path.join(own, 'a1b2c3-bash.txt')}" 2>/dev/null || echo denied`)).toBe('denied')
      expect(readFileSync(path.join(own, 'a1b2c3-bash.txt'), 'utf8')).toBe('own tool output line')
    },
  )
})
