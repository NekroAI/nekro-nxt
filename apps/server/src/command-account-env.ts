import SandboxBashExecutor from '@deepseek-ai/dsh-bash-sandbox'
import path from 'node:path'
import type { AgentId, CredentialId, LinkedAccountId } from '@nekro-nxt/contracts'
import type { CommandAccountGrant } from '@nekro-nxt/core'

/** One credential an agent's commands receive, under `env`. */
export interface CommandCredential {
  readonly id: CredentialId
  readonly name: string
  readonly description: string
  readonly env: string
  readonly value: string
}

/** One linked account an agent's commands act as: the variables that carry it and what the agent is told. */
export interface CommandAccount {
  readonly id: LinkedAccountId
  /** `<platform> <login>`, for logs. */
  readonly label: string
  readonly environment: Readonly<Record<string, string>>
  readonly prompt: readonly string[]
}

/** What the host knows about credentials and linked accounts when one agent's command environment is built. */
export interface CommandCredentialSources {
  /**
   * Generic credentials the agent's commands receive now: program credentials in its scope with a variable, used
   * automatically or approved for it. Read for every command, so a removed credential stops at the next one.
   */
  readonly credentials: (agentId: AgentId) => readonly CommandCredential[]
  /** Linked accounts the agent's grants name that still exist; read for every command like credentials. */
  readonly accounts: (agentId: AgentId, grants: readonly CommandAccountGrant[]) => readonly CommandAccount[]
  /** Called when a command environment carries the credential. */
  readonly used?: (credentialId: CredentialId, agentId: AgentId) => void
  /** Called when a command environment carries the account. */
  readonly accountUsed?: (accountId: LinkedAccountId, agentId: AgentId) => void
}

/** Overlaps already reported, so a command that runs again does not log the same warning. */
const reportedOverlaps = new Set<string>()

/**
 * Environment variables added to one agent's commands: its generic credentials under their own variables, then its
 * granted linked accounts. DSH removes credential-shaped variables from the host's own environment, so these are the
 * only way a command receives a secret. Where an account and a credential would set the same variable, the account
 * wins and the overlap is logged once.
 */
export const commandCredentialEnvironment = (
  agentId: AgentId,
  grants: readonly CommandAccountGrant[],
  sources: CommandCredentialSources,
): Record<string, string> => {
  const environment: Record<string, string> = {}
  const fromCredential = new Map<string, string>()
  for (const credential of sources.credentials(agentId)) {
    sources.used?.(credential.id, agentId)
    environment[credential.env] = credential.value
    fromCredential.set(credential.env, credential.name)
  }
  for (const account of sources.accounts(agentId, grants)) {
    sources.accountUsed?.(account.id, agentId)
    for (const [name, value] of Object.entries(account.environment)) {
      const credential = fromCredential.get(name)
      const key = `${agentId}\0${name}\0${account.id}`
      if (credential !== undefined && !reportedOverlaps.has(key)) {
        reportedOverlaps.add(key)
        console.warn(
          `[nekro-nxt] 智能体 ${agentId} 的命令里，关联账号 ${account.label} 和凭据「${credential}」都使用 ${name}，取关联账号的值。`,
        )
      }
      environment[name] = value
    }
  }
  return environment
}

/**
 * What the agent is told about the accounts and credentials its commands receive: accounts by platform and login with
 * their usage hints, then credentials by name and variable. Never values.
 */
export const commandCredentialPrompt = (
  agentId: AgentId,
  grants: readonly CommandAccountGrant[],
  sources: CommandCredentialSources,
): string | undefined => {
  const lines: string[] = []
  for (const account of sources.accounts(agentId, grants)) lines.push(...account.prompt)
  for (const credential of sources.credentials(agentId)) {
    lines.push(
      `命令的环境变量 ${credential.env} 是凭据「${credential.name}」${credential.description === '' ? '' : `（${credential.description}）`}，用 $${credential.env} 引用，不要把它的值打印出来。`,
    )
  }
  return lines.length === 0 ? undefined : lines.join('\n')
}

/**
 * `PATH` for agents' commands with the folders of the add-ons' programs (附加功能 F4): a downloaded or bundled program
 * goes in front, so the provider people chose wins over another copy on `PATH`; a program of this device whose folder
 * is missing from `PATH` goes last, so it does not change which other tools commands find. `undefined` when every
 * folder is already on `PATH`.
 */
export const programSearchPath = (
  programs: readonly { readonly path: string; readonly source?: string | undefined }[],
  basePath: string | undefined,
  delimiter: string = path.delimiter,
): string | undefined => {
  const base = (basePath ?? '').split(delimiter).filter((entry) => entry !== '')
  const front: string[] = []
  const back: string[] = []
  for (const program of programs) {
    const directory = path.dirname(program.path)
    if (base.includes(directory) || front.includes(directory) || back.includes(directory)) continue
    ;(program.source === 'system' ? back : front).push(directory)
  }
  if (front.length === 0 && back.length === 0) return undefined
  return [...front, ...base, ...back].join(delimiter)
}

type ExecutorRequest = Parameters<SandboxBashExecutor['resolve']>[0]
type ExecutorArgv = Parameters<SandboxBashExecutor['executeArgv']>[1]

/** What a command gets when the bash it would run in is missing; the agent should pass it on, not retry. */
export const MISSING_SHELL_MESSAGE =
  '这条命令没有执行：这台 Windows 设备还没有可用的 Bash。请把这个情况告诉管理员：在 设置 → 附加功能 里安装「Git 与 Bash」后，命令就能运行。管理员处理之前，不要再尝试运行命令。'

/** DSH starts every command as `bash -c …`; this puts the chosen bash in place of the bare name. */
const withShell = (argv: readonly string[], shell: string): string[] => {
  const separator = argv.indexOf('--')
  const at = separator < 0 ? 0 : separator + 1
  return argv[at] === 'bash' ? [...argv.slice(0, at), shell, ...argv.slice(at + 1)] : [...argv]
}

/**
 * DSH's sandbox executor that adds the agent's credential and account variables to every command, and runs commands in
 * the bash `shell` names. The variables and the bash are read when the command starts, so removing a credential or an
 * account stops it at the next command. `shell` returning `undefined` means there is no bash to use (Windows without
 * Git for Windows, #96): the command fails with {@link MISSING_SHELL_MESSAGE} instead of reaching another `bash` on
 * `PATH`, such as the launcher of the Windows Subsystem for Linux.
 */
export const createEnvForwardingExecutor = (
  environment: () => Readonly<Record<string, string>>,
  shell: () => string | undefined = () => 'bash',
): typeof SandboxBashExecutor =>
  class EnvForwardingExecutor extends SandboxBashExecutor {
    override resolve(request: ExecutorRequest) {
      const added = environment()
      if (Object.keys(added).length === 0) return super.resolve(request)
      return super.resolve({ ...request, env: { ...request.env, ...added } })
    }

    override executeArgv(
      spec: Parameters<SandboxBashExecutor['executeArgv']>[0],
      argvOrPrepare: ExecutorArgv,
      onStarted?: Parameters<SandboxBashExecutor['executeArgv']>[2],
    ) {
      const program = shell()
      if (program === undefined) return Promise.reject(new Error(MISSING_SHELL_MESSAGE))
      const argv: ExecutorArgv =
        typeof argvOrPrepare === 'function'
          ? async (signal) => withShell(await argvOrPrepare(signal), program)
          : withShell(argvOrPrepare, program)
      return super.executeArgv(spec, argv, onStarted)
    }
  }
