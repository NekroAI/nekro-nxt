import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { programSearchPath } from './command-account-env.js'

/**
 * What an agent's commands find on this host (#113): the system, whether it is the official image, whether commands
 * run as root and which common programs are on `PATH`. Read once per server process, so the prompt built from it stays
 * the same for every Session.
 */
export interface CommandHost {
  readonly platform: NodeJS.Platform
  /** The system's name, such as `Debian GNU/Linux 12 (bookworm)`; empty when unknown. */
  readonly system: string
  /** `<data root>/tools` in the official image, where agents install their own programs; undefined elsewhere. */
  readonly toolsRoot: string | undefined
  readonly root: boolean
  readonly tools: readonly string[]
}

/** Programs worth telling an agent about, in the order they are listed. */
const POSIX_TOOLS = [
  'git',
  'curl',
  'wget',
  'python3',
  'pip3',
  'node',
  'npm',
  'jq',
  'rg',
  'unzip',
  'zip',
  'xz',
  'tar',
  'ssh',
  'ps',
  'ffmpeg',
  'gh',
  'uv',
  'docker',
  'make',
  'gcc',
] as const
// Git and bash are covered by the Windows commands section; `curl.exe` ships with Windows.
const WINDOWS_TOOLS = ['python', 'node', 'npm', 'tar', 'ssh', 'jq', 'rg', 'ffmpeg', 'gh', 'uv', 'docker'] as const

/** The image sets this; plain Linux hosts and other containers get no install hints for `/data/tools`. */
export const isOfficialImage = (env: NodeJS.ProcessEnv = process.env): boolean => env['NEKRO_CONTAINER'] === 'docker'

/** Where agents install their own programs: `<data root>/tools` in the official image, nowhere elsewhere. */
export const toolsRootOf = (dataRoot: string, env: NodeJS.ProcessEnv = process.env): string | undefined =>
  isOfficialImage(env) ? path.join(dataRoot, 'tools') : undefined

/** The bin directories under the tools root, in the order commands search them. */
export const toolBinDirectories = (toolsRoot: string): string[] => [
  path.join(toolsRoot, 'bin'),
  path.join(toolsRoot, 'npm', 'bin'),
  path.join(toolsRoot, 'python', 'bin'),
]

/** `PATH` for commands in the official image: the tools root's bin directories go in front. */
export const toolSearchPath = (
  toolsRoot: string | undefined,
  basePath: string | undefined,
  delimiter: string = path.delimiter,
): string | undefined => {
  if (toolsRoot === undefined) return basePath
  const base = (basePath ?? '').split(delimiter).filter((entry) => entry !== '')
  return [...toolBinDirectories(toolsRoot).filter((entry) => !base.includes(entry)), ...base].join(delimiter)
}

/**
 * Variables that send `npm install -g` and `pip install` under the tools root, caches included, so installed programs
 * outlive the container and stay out of upgrade restore points. Only commands with full access can write there.
 * Debian marks its Python as system-managed; without the override pip refuses user installs too.
 */
export const toolInstallEnvironment = (toolsRoot: string): Record<string, string> => ({
  NPM_CONFIG_PREFIX: path.join(toolsRoot, 'npm'),
  NPM_CONFIG_CACHE: path.join(toolsRoot, 'cache', 'npm'),
  PYTHONUSERBASE: path.join(toolsRoot, 'python'),
  PIP_CACHE_DIR: path.join(toolsRoot, 'cache', 'pip'),
  PIP_BREAK_SYSTEM_PACKAGES: '1',
})

/**
 * What the tools root and the add-ons' programs add to one agent's commands: `PATH` when it changes, and in the
 * official image the install locations for commands with full access.
 */
export const commandToolEnvironment = (input: {
  readonly toolsRoot: string | undefined
  readonly unrestricted: boolean
  readonly programs: readonly { readonly path: string; readonly source?: string | undefined }[]
  readonly basePath: string | undefined
}): Record<string, string> => {
  const { toolsRoot, basePath } = input
  const install = toolsRoot !== undefined && input.unrestricted ? toolInstallEnvironment(toolsRoot) : {}
  const withTools = toolSearchPath(toolsRoot, basePath)
  const searchPath = programSearchPath(input.programs, withTools) ?? withTools
  return searchPath === undefined || searchPath === basePath ? install : { ...install, PATH: searchPath }
}

const systemName = (platform: NodeJS.Platform): string => {
  if (platform === 'darwin') return 'macOS'
  if (platform === 'win32') return 'Windows'
  if (platform !== 'linux') return ''
  try {
    const release = readFileSync('/etc/os-release', 'utf8')
    const pretty = /^PRETTY_NAME="?([^"\n]*)"?$/mu.exec(release)?.[1]
    return pretty ?? 'Linux'
  } catch {
    return 'Linux'
  }
}

/** Which of the candidates are on `PATH`, found the way the platform's shell finds them. */
export const findTools = (platform: NodeJS.Platform, pathEnv: string | undefined): string[] => {
  const env = { ...process.env, PATH: pathEnv ?? '' }
  if (platform === 'win32') {
    const found = spawnSync('where.exe', [...WINDOWS_TOOLS], {
      env,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    })
    const names = new Set(
      (found.stdout ?? '')
        .split(/\r?\n/u)
        // The Store's python.exe placeholder only opens the Store.
        .filter((line) => line.trim() !== '' && !line.includes('\\WindowsApps\\'))
        .map((line) =>
          path.win32
            .basename(line.trim())
            .replace(/\.[^.]+$/u, '')
            .toLowerCase(),
        ),
    )
    return WINDOWS_TOOLS.filter((name) => names.has(name))
  }
  const script = 'for t in "$@"; do command -v "$t" >/dev/null 2>&1 && echo "$t"; done'
  const found = spawnSync('/bin/sh', ['-c', script, 'sh', ...POSIX_TOOLS], { env, encoding: 'utf8', timeout: 5000 })
  const names = new Set((found.stdout ?? '').split('\n'))
  return POSIX_TOOLS.filter((name) => names.has(name))
}

/** Looks at this host once; later calls return the same answer. */
let detected: CommandHost | undefined
export const detectCommandHost = (dataRoot: string): CommandHost => {
  if (detected !== undefined) return detected
  const platform = process.platform
  const toolsRoot = toolsRootOf(dataRoot)
  detected = {
    platform,
    system: systemName(platform),
    toolsRoot,
    root: process.getuid?.() === 0,
    tools: findTools(platform, toolSearchPath(toolsRoot, process.env['PATH'])),
  }
  return detected
}

const toolsLine = (tools: readonly string[], lead: string): string[] =>
  tools.length === 0 ? [] : [`${lead}${tools.join('、')}。`]

/**
 * What an agent with commands is told about where they run. Windows gets one line about its programs; the rest of
 * what it needs is in the Windows commands section.
 */
export const commandHostPrompt = (host: CommandHost, unrestricted: boolean): string => {
  if (host.platform === 'win32') return toolsLine(host.tools, '命令里还有：').join('')
  const workspaceOnly = unrestricted ? [] : ['你只能写自己的工作区。']
  if (host.toolsRoot !== undefined) {
    const tools = host.toolsRoot
    const system = host.system === '' ? 'Linux' : host.system
    return [
      host.root
        ? `你的命令运行在 Docker 容器里，系统是 ${system}，用户是 root。apt 装的软件在容器重建后会丢失。`
        : `你的命令运行在 Docker 容器里，系统是 ${system}，用户不是 root，没有 sudo，apt 装不了软件。`,
      ...toolsLine(host.tools, '命令里有：'),
      ...(unrestricted
        ? [
            `自己的文件放在工作区。缺少的工具装到 ${tools}，容器重建后还在：npm install -g 会装到这里；Python 包用 pip install --user 安装，或用 python3 -m venv ${tools}/venv/<名字> 建虚拟环境；单个程序可以放进 ${tools}/bin。这几处的 bin 目录已经在 PATH 里。`,
          ]
        : [
            `你只能写自己的工作区，${tools} 里已经装好的工具可以直接用。要装新的工具，需要管理员把你的访问权限调到「完整访问」，可以这样告诉用户。`,
          ]),
    ].join('\n')
  }
  if (host.platform === 'darwin') {
    return [
      '这台设备是 macOS，命令用 bash 运行；sed、date 等是 BSD 版本，参数和 Linux 上的不同。',
      ...toolsLine(host.tools, '命令里有：'),
      ...workspaceOnly,
    ].join('\n')
  }
  return [
    `这台设备是 ${host.system === '' ? host.platform : host.system}，命令用 bash 运行，用户${host.root ? '是' : '不是'} root。`,
    ...toolsLine(host.tools, '命令里有：'),
    ...workspaceOnly,
  ].join('\n')
}
