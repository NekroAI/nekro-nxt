import { canonicalPath, type ConfinedArgv, type SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import LocalSandboxProvider from '@deepseek-ai/dsh-sandbox-local'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/**
 * What NXT adds to DSH's file-write confinement for one agent's commands: directories hidden from reads (with
 * narrower roots read back inside them) and whether the command may open network connections. The calling
 * workspace is always readable.
 */
export interface CommandConfinement {
  readonly hidden: readonly string[]
  readonly readable: readonly string[]
  readonly network: boolean
}

/** What the platform runner can enforce beyond file writes. */
export interface CommandConfinementSupport {
  readonly readScope: boolean
  readonly networkControl: boolean
}

interface ReadRule {
  readonly path: string
  readonly allow: boolean
}

const isWithin = (target: string, root: string): boolean => {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

const isStrictlyWithin = (target: string, root: string): boolean => target !== root && isWithin(target, root)

/** Read rules ordered from broadest to narrowest; the narrowest rule covering a path decides it. */
export const readRules = (confinement: CommandConfinement, workspaceRoot: string): readonly ReadRule[] => {
  const existing = (paths: readonly string[]) => [
    ...new Set(paths.filter((entry) => existsSync(entry)).map((entry) => canonicalPath(entry))),
  ]
  const rules = [
    ...existing(confinement.hidden).map((entry) => ({ path: entry, allow: false })),
    ...existing([...confinement.readable, workspaceRoot]).map((entry) => ({ path: entry, allow: true })),
  ]
  // Equal paths keep the allow rule last so a re-allowed root wins over the same hidden one.
  return rules.sort((left, right) => left.path.length - right.path.length || Number(left.allow) - Number(right.allow))
}

const readableBy = (rules: readonly ReadRule[], target: string): boolean => {
  let allowed = true
  for (const rule of rules) if (isWithin(target, rule.path)) allowed = rule.allow
  return allowed
}

/** Seatbelt forms appended to DSH's write profile; later forms win, and ancestors of read roots stay stat-able. */
export const seatbeltForms = (rules: readonly ReadRule[], network: boolean): string => {
  const quote = (value: string) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
  const forms = rules.map((rule) => `(${rule.allow ? 'allow' : 'deny'} file-read* (subpath ${quote(rule.path)}))`)
  const ancestors = new Set<string>()
  for (const rule of rules) {
    if (!rule.allow) continue
    for (let current = path.dirname(rule.path); current !== path.dirname(current); current = path.dirname(current)) {
      ancestors.add(current)
    }
  }
  if (ancestors.size > 0) {
    forms.push(`(allow file-read-metadata ${[...ancestors].map((entry) => `(literal ${quote(entry)})`).join(' ')})`)
  }
  for (const rule of rules) {
    if (!rule.allow) forms.push(`(deny network-outbound (remote unix-socket (subpath ${quote(rule.path)})))`)
  }
  forms.push('(deny signal)', '(allow signal (target same-sandbox))')
  if (!network) {
    forms.push(
      '(deny network-outbound (remote ip))',
      '(deny network-inbound (local ip))',
      '(deny network-bind (local ip))',
      // Name lookups go through this socket and would still carry data out.
      `(deny network-outbound (literal ${quote('/private/var/run/mDNSResponder')}))`,
    )
  }
  return forms.join(' ')
}

/** bwrap arguments inserted after DSH's profile: hidden roots become empty tmpfs, read roots are bound back. */
export const bwrapArgs = (
  rules: readonly ReadRule[],
  policy: Pick<SandboxPolicy, 'mode' | 'workspaceRoot'>,
  network: boolean,
): string[] => {
  const workspace = canonicalPath(policy.workspaceRoot)
  const args = rules.flatMap((rule) =>
    !rule.allow
      ? ['--tmpfs', rule.path]
      : rule.path === workspace && policy.mode === 'workspace-write'
        ? ['--bind', rule.path, rule.path]
        : ['--ro-bind', rule.path, rule.path],
  )
  if (!network) args.push('--unshare-net')
  return args
}

/**
 * Landlock only allows: the readable set is every directory or file whose narrowest rule allows it, found by
 * walking down only the directories that contain a rule. A symlink is granted only when its target is readable
 * and holds no rule, because Landlock grants the target itself.
 */
export const landlockReadRoots = (rules: readonly ReadRule[]): string[] => {
  const roots: string[] = []
  const visit = (entry: string) => {
    const nested = rules.some((rule) => isStrictlyWithin(rule.path, entry))
    if (!nested) {
      if (readableBy(rules, entry)) roots.push(entry)
      return
    }
    let children
    try {
      children = readdirSync(entry, { withFileTypes: true })
    } catch {
      return
    }
    for (const child of children) {
      const childPath = path.join(entry, child.name)
      if (!child.isSymbolicLink()) {
        visit(childPath)
        continue
      }
      let target: string
      try {
        target = realpathSync(childPath)
      } catch {
        continue
      }
      if (
        readableBy(rules, childPath) &&
        readableBy(rules, target) &&
        !rules.some((rule) => isStrictlyWithin(rule.path, target))
      ) {
        roots.push(childPath)
      }
    }
  }
  visit(path.parse(process.cwd()).root)
  return roots
}

const ARGV_SEPARATOR = '--'

/** Rewrites the runner argv DSH's local provider produced; runners NXT cannot extend are returned unchanged. */
export const extendConfinedArgv = (
  argv: readonly string[],
  policy: SandboxPolicy,
  confinement: CommandConfinement,
  support: CommandConfinementSupport,
): string[] => {
  const separator = argv.indexOf(ARGV_SEPARATOR)
  if (separator < 1) return [...argv]
  const runner = path.basename(argv[0]!)
  const profile = argv.slice(1, separator)
  const command = argv.slice(separator)
  const rules = readRules(confinement, policy.workspaceRoot)
  if (runner === 'sandbox-exec') {
    const at = profile.indexOf('-p')
    if (at < 0 || profile[at + 1] === undefined) return [...argv]
    const next = [...profile]
    next[at + 1] = `${profile[at + 1]} ${seatbeltForms(rules, confinement.network)}`
    return [argv[0]!, ...next, ...command]
  }
  if (runner === 'bwrap') {
    return [
      argv[0]!,
      ...profile,
      ...bwrapArgs(rules, policy, confinement.network || !support.networkControl),
      ...command,
    ]
  }
  if (runner === 'landlock-run') {
    // DSH grants `--ro /`; every other grant (the writable roots) is kept as is.
    const kept: string[] = []
    for (let index = 0; index < profile.length; index += 2) {
      if (profile[index] === '--ro' && profile[index + 1] === '/') continue
      kept.push(profile[index]!, profile[index + 1]!)
    }
    const reads = landlockReadRoots(rules).flatMap((root) => ['--ro', root])
    return [argv[0]!, ...reads, ...kept, ...command]
  }
  return [...argv]
}

let bwrapNetworkProbe: boolean | undefined

const probeBwrapNetwork = (): boolean => {
  bwrapNetworkProbe ??=
    spawnSync(
      'bwrap',
      ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--unshare-net', '--', 'true'],
      { timeout: 5_000, stdio: 'ignore' },
    ).status === 0
  return bwrapNetworkProbe
}

/**
 * Seatbelt and bwrap enforce both read scope and network; Linux without bwrap falls back to Landlock, which here
 * scopes reads only; the Windows runner restricts writes only.
 */
export const commandConfinementSupport = (platform: NodeJS.Platform = process.platform): CommandConfinementSupport => {
  if (platform === 'darwin') return { readScope: true, networkControl: true }
  if (platform === 'linux') {
    const bwrap = probeBwrapNetwork()
    return { readScope: true, networkControl: bwrap }
  }
  return { readScope: false, networkControl: false }
}

/** Toolchain directories under home that commands may still read; anything else there stays hidden. */
const HOME_TOOLCHAINS = [
  '.nvm',
  '.volta',
  '.fnm',
  '.bun/bin',
  '.deno/bin',
  '.pyenv',
  '.rbenv',
  '.cargo/bin',
  '.rustup',
  'go/bin',
  'go/pkg',
  '.sdkman/candidates',
  '.asdf/installs',
  '.asdf/shims',
  '.conda',
  'miniconda3',
  'anaconda3',
  'miniforge3',
  'mambaforge',
  '.local/bin',
  '.local/lib',
  '.local/pipx',
  '.local/share/uv',
  '.local/share/mise',
  '.local/share/pnpm',
  '.local/share/fonts',
  '.fonts',
  '.cache/ms-playwright',
  'Library/Python',
  'Library/Fonts',
  'Library/pnpm',
  'Library/Caches/ms-playwright',
]

/**
 * The host's command confinement: the data root, the workspaces root and the user's home are hidden; toolchains,
 * `PATH` directories, the install that runs NXT and downloaded runtimes stay readable.
 */
export const hostCommandConfinement = (input: {
  readonly dataRoot: string
  readonly workspaceRoot: string | undefined
  readonly installRoot: string
  readonly runtimeRoots: readonly string[]
  readonly home?: string
  readonly pathEnv?: string | undefined
}): Omit<CommandConfinement, 'network'> => {
  const home = input.home ?? homedir()
  const pathDirs = (input.pathEnv ?? process.env['PATH'] ?? '')
    .split(path.delimiter)
    .filter((entry) => path.isAbsolute(entry) && entry !== home)
  return {
    hidden: [input.dataRoot, ...(input.workspaceRoot === undefined ? [] : [input.workspaceRoot]), home],
    readable: [
      input.installRoot,
      ...input.runtimeRoots,
      ...HOME_TOOLCHAINS.map((entry) => path.join(home, entry)),
      ...pathDirs,
    ],
  }
}

/** The directory that holds the `node_modules` NXT runs from: the repository, the app bundle or the image. */
export const installRootOf = (moduleFile: string): string => {
  const real = canonicalPath(moduleFile)
  const marker = `${path.sep}node_modules${path.sep}`
  const at = real.indexOf(marker)
  return at < 0 ? path.dirname(real) : real.slice(0, at)
}

/**
 * DSH's local provider with NXT's read scope, signal scope and network switch added to every confined command.
 * `resolve` returns undefined for calls it does not know, which then keep DSH's own profile.
 */
export const createConfinedSandboxProvider = (
  resolve: (policy: SandboxPolicy) => CommandConfinement | undefined,
  support: CommandConfinementSupport = commandConfinementSupport(),
): typeof LocalSandboxProvider =>
  class ConfinedSandboxProvider extends LocalSandboxProvider {
    override async confine(
      argv: readonly string[],
      policy: SandboxPolicy,
      signal?: AbortSignal,
    ): Promise<ConfinedArgv> {
      const confined = await super.confine(argv, policy, signal)
      const confinement = resolve(policy)
      if (confinement === undefined) return confined
      return { ...confined, argv: extendConfinedArgv(confined.argv, policy, confinement, support) }
    }
  }
