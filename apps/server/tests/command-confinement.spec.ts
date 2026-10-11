import { Context } from '@deepseek-ai/cordis'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  bwrapArgs,
  extendConfinedArgv,
  hostCommandConfinement,
  installRootOf,
  landlockReadRoots,
  readRules,
  seatbeltForms,
} from '../src/command-confinement.ts'
import { WorkspaceFileSystem } from '../src/workspace-file-system.ts'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** A fictional host: home with a private key and a toolchain, a data root with credentials and two workspaces. */
const fixture = () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'nekro-nxt-confinement-')))
  directories.push(root)
  const home = path.join(root, 'home')
  const data = path.join(home, 'nxt-data')
  const workspace = path.join(data, 'workspaces', 'agent-a')
  const other = path.join(data, 'workspaces', 'agent-b')
  for (const directory of [path.join(home, '.ssh'), path.join(home, '.nvm'), workspace, other]) {
    mkdirSync(directory, { recursive: true })
  }
  writeFileSync(path.join(home, '.ssh', 'id_fixture'), 'fixture-key')
  writeFileSync(path.join(home, '.nvm', 'node'), 'fixture-node')
  mkdirSync(path.join(data, 'credentials'))
  writeFileSync(path.join(data, 'credentials', 'fixture.secret'), 'fixture-secret')
  writeFileSync(path.join(other, 'notes.txt'), 'agent-b notes')
  const confinement = {
    ...hostCommandConfinement({
      dataRoot: data,
      workspaceRoot: path.join(data, 'workspaces'),
      installRoot: path.join(root, 'install'),
      runtimeRoots: [],
      home,
      pathEnv: '',
    }),
    network: false,
  }
  return { root, home, data, workspace, other, confinement }
}

describe('command confinement', () => {
  it('orders read rules so the narrowest one decides, keeping only existing paths', () => {
    const { home, data, workspace, confinement } = fixture()
    expect(readRules(confinement, workspace)).toEqual([
      { path: home, allow: false },
      { path: path.join(home, '.nvm'), allow: true },
      { path: data, allow: false },
      { path: path.join(data, 'workspaces'), allow: false },
      { path: workspace, allow: true },
    ])
  })

  it('hides the data root and home from Seatbelt reads and closes the network when it is off', () => {
    const { home, workspace, confinement } = fixture()
    const rules = readRules(confinement, workspace)
    const closed = seatbeltForms(rules, false)
    expect(closed).toContain(`(deny file-read* (subpath "${home}"))`)
    expect(closed.indexOf(`(allow file-read* (subpath "${workspace}"))`)).toBeGreaterThan(
      closed.indexOf(`(deny file-read* (subpath "${home}"))`),
    )
    expect(closed).toContain(`(allow file-read-metadata (literal "${home}")`)
    expect(closed).toContain('(allow signal (target same-sandbox))')
    expect(closed).toContain('(deny network-outbound (remote ip))')
    expect(seatbeltForms(rules, true)).not.toContain('(remote ip)')
  })

  it('covers hidden roots with tmpfs and binds the workspace back writable under bwrap', () => {
    const { home, workspace, confinement } = fixture()
    const rules = readRules(confinement, workspace)
    const args = bwrapArgs(rules, { mode: 'workspace-write', workspaceRoot: workspace }, false)
    expect(args.slice(0, 2)).toEqual(['--tmpfs', home])
    expect(args).toContain('--unshare-net')
    expect(args.slice(-4)).toEqual(['--bind', workspace, workspace, '--unshare-net'])
    expect(bwrapArgs(rules, { mode: 'read-only', workspaceRoot: workspace }, true).slice(-3)).toEqual([
      '--ro-bind',
      workspace,
      workspace,
    ])
  })

  it('grants Landlock reads for everything except hidden roots, following only safe symlinks', () => {
    const { root, home, data, workspace, confinement } = fixture()
    symlinkSync(path.join(data, 'credentials'), path.join(root, 'credentials-link'))
    symlinkSync(path.join(home, '.nvm'), path.join(root, 'nvm-link'))
    const roots = landlockReadRoots(readRules(confinement, workspace))
    expect(roots).toContain(workspace)
    expect(roots).toContain(path.join(home, '.nvm'))
    expect(roots).toContain(path.join(root, 'nvm-link'))
    expect(roots).not.toContain(path.join(root, 'credentials-link'))
    const readable = (target: string) => roots.some((entry) => target === entry || target.startsWith(`${entry}/`))
    expect(readable(path.join(home, '.ssh', 'id_fixture'))).toBe(false)
    expect(readable(path.join(data, 'credentials', 'fixture.secret'))).toBe(false)
    expect(readable(path.join(data, 'workspaces', 'agent-b', 'notes.txt'))).toBe(false)
  })

  it('leaves directories DSH grants writable to that grant instead of listing their entries', () => {
    const { home, workspace, confinement } = fixture()
    // A writable temporary directory that holds hidden roots, as when the data root sits under /tmp.
    const scratch = path.join(home, 'scratch')
    mkdirSync(path.join(scratch, 'short-lived'), { recursive: true })
    const roots = landlockReadRoots(readRules(confinement, workspace), [home])
    expect(roots.some((entry) => entry === home || entry.startsWith(`${home}/`))).toBe(false)
    // Everything outside it is still listed as before.
    expect(roots.length).toBeGreaterThan(0)
  })

  it('rewrites only the runners it knows', () => {
    const { workspace, confinement } = fixture()
    const policy = { mode: 'workspace-write' as const, workspaceRoot: workspace }
    const support = { readScope: true, networkControl: true }
    const windows = ['node', 'runner.js', '--workspace', workspace, '--', 'pwsh', '-c', 'echo']
    expect(extendConfinedArgv(windows, policy, confinement, support)).toEqual(windows)
    const landlock = extendConfinedArgv(
      ['/x/landlock-run', '--ro', '/', '--rw', '/dev/null', '--rw', workspace, '--', 'bash', '-c', 'true'],
      policy,
      confinement,
      support,
    )
    expect(landlock).not.toContain('/')
    expect(landlock.slice(-8)).toEqual(['--rw', '/dev/null', '--rw', workspace, '--', 'bash', '-c', 'true'])
    // Without network control bwrap keeps the network rather than failing the command.
    const bwrap = extendConfinedArgv(['bwrap', '--', 'true'], policy, confinement, {
      ...support,
      networkControl: false,
    })
    expect(bwrap).not.toContain('--unshare-net')
  })

  it('finds the install root above node_modules', () => {
    expect(installRootOf('/opt/nekro/server/node_modules/.pnpm/pkg/node_modules/pkg/package.json')).toBe(
      '/opt/nekro/server',
    )
  })

  it.runIf(process.platform === 'darwin')('keeps commands out of hidden roots and off the network on macOS', () => {
    const { home, data, workspace, confinement } = fixture()
    const policy = { mode: 'workspace-write' as const, workspaceRoot: workspace }
    const profile = '(version 1) (allow default) (deny file-write*) (allow file-write* (subpath "' + workspace + '"))'
    const argv = extendConfinedArgv(
      ['/usr/bin/sandbox-exec', '-p', profile, '--', '/bin/bash', '-c', 'true'],
      policy,
      confinement,
      { readScope: true, networkControl: true },
    )
    const run = (script: string) =>
      spawnSync(argv[0]!, [...argv.slice(1, -1), script], { cwd: workspace, encoding: 'utf8' }).stdout.trim()
    expect(run(`cat "${path.join(data, 'credentials', 'fixture.secret')}" 2>/dev/null || echo denied`)).toBe('denied')
    expect(run(`cat "${path.join(home, '.ssh', 'id_fixture')}" 2>/dev/null || echo denied`)).toBe('denied')
    expect(run(`cat "${path.join(data, 'workspaces', 'agent-b', 'notes.txt')}" 2>/dev/null || echo denied`)).toBe(
      'denied',
    )
    expect(run('echo own > own.txt && cat own.txt')).toBe('own')
    expect(run(`cat "${path.join(home, '.nvm', 'node')}"`)).toBe('fixture-node')
    expect(run(`${process.execPath} -e "console.log(require('fs').realpathSync('.'))"`)).toBe(workspace)
    expect(
      run(
        `${process.execPath} -e "require('net').connect(9,'127.0.0.1').on('error',e=>console.log(e.code)).on('connect',()=>console.log('open'))"`,
      ),
    ).toBe('EPERM')
  })
})

describe('workspace file system', () => {
  const mount = async (mode: 'workspace-write' | 'danger-full-access') => {
    const { home, workspace, other } = fixture()
    writeFileSync(path.join(workspace, 'own.txt'), 'own')
    symlinkSync(path.join(other, 'notes.txt'), path.join(workspace, 'link.txt'))
    const context = new Context()
    await context.plugin(SessionProjections)
    await context.plugin(SandboxPolicyService, { mode, workspaceRoot: workspace })
    await context.plugin(WorkspaceFileSystem, { cwd: workspace })
    return { fs: context.fs, home, workspace, other }
  }

  it('reads only inside the workspace, judging symlinks by their target', async () => {
    const { fs, other } = await mount('workspace-write')
    expect(await fs.readText(await fs.resolve('own.txt'))).toBe('own')
    await expect(fs.readText(await fs.resolve(path.join(other, 'notes.txt')))).rejects.toMatchObject({
      code: 'FS_SANDBOX_DENIED',
    })
    await expect(fs.readText(await fs.resolve('link.txt'))).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    await expect(fs.listDir(await fs.resolve('..'))).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(await fs.lstat('link.txt')).toBeDefined()
    await expect(fs.lstat(path.join(other, 'notes.txt'))).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  })

  it('keeps reads open under full access', async () => {
    const { fs, other } = await mount('danger-full-access')
    expect(await fs.readText(await fs.resolve(path.join(other, 'notes.txt')))).toBe('agent-b notes')
  })
})
