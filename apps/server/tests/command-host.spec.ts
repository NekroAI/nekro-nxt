import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  commandHostPrompt,
  commandToolEnvironment,
  findTools,
  isOfficialImage,
  toolsRootOf,
  type CommandHost,
} from '../src/command-host.ts'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const docker: CommandHost = {
  platform: 'linux',
  system: 'Debian GNU/Linux 12 (bookworm)',
  toolsRoot: '/data/tools',
  root: false,
  tools: ['git', 'curl', 'python3', 'jq'],
}

describe('what agents are told about where their commands run (#113)', () => {
  it('tells an agent with full access in the image where to install what it lacks', () => {
    const text = commandHostPrompt(docker, true)
    expect(text).toContain('Docker 容器里，系统是 Debian GNU/Linux 12 (bookworm)，用户不是 root，没有 sudo')
    expect(text).toContain('命令里有：git、curl、python3、jq。')
    expect(text).toContain('npm install -g 会装到这里')
    expect(text).toContain('pip install --user')
    expect(text).toContain('python3 -m venv /data/tools/venv/<名字>')
    expect(text).not.toContain('完整访问')
    expect(text.length).toBeLessThanOrEqual(400)
  })

  it('tells a confined agent in the image it can use installed tools and who can install more', () => {
    const text = commandHostPrompt(docker, false)
    expect(text).toContain('你只能写自己的工作区，/data/tools 里已经装好的工具可以直接用')
    expect(text).toContain('「完整访问」')
    expect(text).not.toContain('npm install -g')
  })

  it('says apt installs do not last when the image runs as root', () => {
    const text = commandHostPrompt({ ...docker, root: true }, true)
    expect(text).toContain('用户是 root')
    expect(text).toContain('容器重建后会丢失')
    expect(text).not.toContain('没有 sudo')
  })

  it('describes a plain Linux host without the image install hints', () => {
    const host: CommandHost = { ...docker, system: 'Ubuntu 24.04 LTS', toolsRoot: undefined, tools: ['git', 'rg'] }
    expect(commandHostPrompt(host, false)).toBe(
      '这台设备是 Ubuntu 24.04 LTS，命令用 bash 运行，用户不是 root。\n命令里有：git、rg。\n你只能写自己的工作区。',
    )
    expect(commandHostPrompt(host, true)).not.toContain('工作区')
    expect(commandHostPrompt(host, true)).not.toContain('/data/tools')
  })

  it('warns about BSD tools on macOS and leaves out an empty program list', () => {
    const host: CommandHost = { platform: 'darwin', system: 'macOS', toolsRoot: undefined, root: false, tools: [] }
    expect(commandHostPrompt(host, true)).toBe(
      '这台设备是 macOS，命令用 bash 运行；sed、date 等是 BSD 版本，参数和 Linux 上的不同。',
    )
  })

  it('gives Windows one line about its programs, next to the Windows commands section', () => {
    const host: CommandHost = {
      platform: 'win32',
      system: 'Windows',
      toolsRoot: undefined,
      root: false,
      tools: ['python', 'node'],
    }
    expect(commandHostPrompt(host, false)).toBe('命令里还有：python、node。')
    expect(commandHostPrompt({ ...host, tools: [] }, false)).toBe('')
  })

  it('recognizes the official image by its marker only', () => {
    expect(isOfficialImage({ NEKRO_CONTAINER: 'docker' })).toBe(true)
    expect(isOfficialImage({})).toBe(false)
    expect(isOfficialImage({ NEKRO_CONTAINER: 'podman' })).toBe(false)
    expect(toolsRootOf('/data', { NEKRO_CONTAINER: 'docker' })).toBe(path.join('/data', 'tools'))
    expect(toolsRootOf('/data', {})).toBeUndefined()
  })
})

describe.skipIf(process.platform === 'win32')('finding programs on PATH', () => {
  it('lists only the known programs the shell finds', () => {
    const folder = realpathSync(mkdtempSync(path.join(tmpdir(), 'nekro-nxt-host-')))
    directories.push(folder)
    for (const name of ['jq', 'rg', 'not-a-listed-tool']) {
      writeFileSync(path.join(folder, name), '#!/bin/sh\n', { mode: 0o755 })
    }
    expect(findTools(process.platform, folder)).toEqual(['jq', 'rg'])
  })
})

describe('the tools root in commands’ environment', () => {
  const base = ['/usr/local/bin', '/usr/bin'].join(path.delimiter)

  it('puts the tools bin directories in front and sends installs there with full access', () => {
    expect(
      commandToolEnvironment({ toolsRoot: '/data/tools', unrestricted: true, programs: [], basePath: base }),
    ).toEqual({
      NPM_CONFIG_PREFIX: path.join('/data/tools', 'npm'),
      NPM_CONFIG_CACHE: path.join('/data/tools', 'cache', 'npm'),
      PYTHONUSERBASE: path.join('/data/tools', 'python'),
      PIP_CACHE_DIR: path.join('/data/tools', 'cache', 'pip'),
      PIP_BREAK_SYSTEM_PACKAGES: '1',
      PATH: [
        path.join('/data/tools', 'bin'),
        path.join('/data/tools', 'npm', 'bin'),
        path.join('/data/tools', 'python', 'bin'),
        base,
      ].join(path.delimiter),
    })
  })

  it('lets confined commands find installed tools without install locations they cannot write', () => {
    const environment = commandToolEnvironment({
      toolsRoot: '/data/tools',
      unrestricted: false,
      programs: [],
      basePath: base,
    })
    expect(Object.keys(environment)).toEqual(['PATH'])
    expect(environment['PATH']?.startsWith(path.join('/data/tools', 'bin'))).toBe(true)
  })

  it('adds nothing outside the image unless an add-on program is off PATH', () => {
    expect(commandToolEnvironment({ toolsRoot: undefined, unrestricted: true, programs: [], basePath: base })).toEqual(
      {},
    )
    expect(
      commandToolEnvironment({
        toolsRoot: undefined,
        unrestricted: true,
        programs: [{ path: '/data/runtimes/gh/gh', source: 'download' }],
        basePath: base,
      }),
    ).toEqual({ PATH: ['/data/runtimes/gh', base].join(path.delimiter) })
  })
})
