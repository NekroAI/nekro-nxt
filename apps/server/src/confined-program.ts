import { Context } from '@deepseek-ai/cordis'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { spawn } from 'node:child_process'
import path from 'node:path'
import {
  commandConfinementSupport,
  createConfinedSandboxProvider,
  extendConfinedArgv,
  type CommandConfinement,
  type CommandConfinementSupport,
} from './command-confinement.js'

/** Wraps one argv for the platform's command sandbox, as DSH's local provider does for agents' commands. */
export interface ProgramSandbox {
  confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv>
}

/** One run of a host program for media processing or a command profile (附加功能 F7). */
export interface ConfinedProgramRequest {
  readonly executable: string
  readonly args: readonly string[]
  /** The only folder the program may write; it is also its working directory. */
  readonly cwd: string
  /** Files and folders the program reads besides its own install and `cwd`, such as its inputs. */
  readonly readable?: readonly string[]
  readonly timeoutMs: number
  readonly signal?: AbortSignal
  /** Kept bytes of each of stdout and stderr; the rest is dropped and `truncated` is set. */
  readonly maxOutputBytes?: number
}

export interface ConfinedProgramResult {
  readonly exitCode: number | null
  readonly stdout: Buffer
  readonly stderr: string
  readonly truncated: boolean
  readonly timedOut: boolean
  /** How the run was confined: `full`/`partial` as the platform runner reports, `none` where no runner works. */
  readonly confinement: 'full' | 'partial' | 'none'
}

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024

/** The variables a program needs to start; nothing of the server's own environment otherwise reaches it. */
const programEnvironment = (): NodeJS.ProcessEnv => {
  const keep = ['PATH', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'LANG']
  return Object.fromEntries(
    keep.flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name]]])),
  )
}

const abortReason = (signal: AbortSignal | undefined): Error =>
  signal?.reason instanceof Error ? signal.reason : new Error('The program run was aborted.')

let reportedUnconfined = false

/**
 * Runs one program without a shell, inside the command sandbox with no network: it writes only `cwd`, and reads what
 * the host confinement leaves readable plus its own folder and `readable`. Where the platform has no working runner the
 * program runs with the same arguments and limits, and the result says `confinement: 'none'`. A timeout or an abort
 * kills the whole process group.
 */
export const runConfinedProgram = async (
  sandbox: ProgramSandbox,
  confinement: Omit<CommandConfinement, 'network'>,
  request: ConfinedProgramRequest,
  support: CommandConfinementSupport = commandConfinementSupport(),
): Promise<ConfinedProgramResult> => {
  request.signal?.throwIfAborted()
  const argv = [request.executable, ...request.args]
  const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: request.cwd }
  const scope: CommandConfinement = {
    hidden: confinement.hidden,
    readable: [...confinement.readable, path.dirname(request.executable), ...(request.readable ?? [])],
    network: false,
  }
  let spawned: readonly string[]
  let level: ConfinedProgramResult['confinement']
  try {
    const confined = await sandbox.confine(argv, policy, request.signal)
    spawned = extendConfinedArgv(confined.argv, policy, scope, support)
    level = confined.enforcement
  } catch (error) {
    request.signal?.throwIfAborted()
    if (!reportedUnconfined) {
      reportedUnconfined = true
      console.warn(
        `[nekro-nxt] Media programs run without the command sandbox on this device: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    spawned = argv
    level = 'none'
  }
  const limit = request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  return await new Promise<ConfinedProgramResult>((resolve, reject) => {
    const child = spawn(spawned[0]!, spawned.slice(1), {
      cwd: request.cwd,
      env: programEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const kept = { stdout: 0, stderr: 0 }
    let truncated = false
    const collect = (stream: 'stdout' | 'stderr', chunks: Buffer[]) => (chunk: Buffer) => {
      const room = limit - kept[stream]
      if (room <= 0) {
        truncated = true
        return
      }
      const part = chunk.length > room ? chunk.subarray(0, room) : chunk
      if (part.length < chunk.length) truncated = true
      chunks.push(part)
      kept[stream] += part.length
    }
    child.stdout.on('data', collect('stdout', stdout))
    child.stderr.on('data', collect('stderr', stderr))
    let timedOut = false
    const kill = () => {
      try {
        if (child.pid !== undefined && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {
        // Already gone.
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, request.timeoutMs)
    const abort = () => kill()
    request.signal?.addEventListener('abort', abort, { once: true })
    const settle = () => {
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', abort)
    }
    child.once('error', (error) => {
      settle()
      reject(error)
    })
    child.once('close', (code) => {
      settle()
      if (request.signal?.aborted === true) {
        reject(abortReason(request.signal))
        return
      }
      resolve({
        exitCode: code,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString('utf8'),
        truncated,
        timedOut,
        confinement: level,
      })
    })
  })
}

/** DSH's local sandbox provider, mounted in a context of its own so host programs can be confined outside agents. */
export const createProgramSandbox = async (): Promise<ProgramSandbox & { dispose(): Promise<void> }> => {
  const context = new Context()
  const fiber = await context.plugin(
    createConfinedSandboxProvider(() => undefined),
    {},
  )
  const sandbox = context.get('sandbox') as ProgramSandbox | undefined
  if (sandbox === undefined) throw new Error('The local sandbox provider did not start.')
  return {
    confine: (argv, policy, signal) => sandbox.confine(argv, policy, signal),
    dispose: () => fiber.dispose(),
  }
}

/**
 * Runs host programs through {@link runConfinedProgram} with a shared limit on how many run at once; later runs wait
 * their turn, and an aborted one leaves the queue.
 */
export class ConfinedProgramRunner {
  readonly #sandbox: ProgramSandbox
  readonly #confinement: Omit<CommandConfinement, 'network'>
  readonly #concurrency: number
  readonly #support: CommandConfinementSupport | undefined
  #running = 0
  readonly #waiting: (() => void)[] = []

  constructor(options: {
    readonly sandbox: ProgramSandbox
    readonly confinement: Omit<CommandConfinement, 'network'>
    readonly concurrency?: number
    readonly support?: CommandConfinementSupport
  }) {
    this.#sandbox = options.sandbox
    this.#confinement = options.confinement
    this.#concurrency = options.concurrency ?? 2
    this.#support = options.support
  }

  async run(request: ConfinedProgramRequest): Promise<ConfinedProgramResult> {
    await this.#acquire(request.signal)
    try {
      return await runConfinedProgram(this.#sandbox, this.#confinement, request, this.#support)
    } finally {
      this.#release()
    }
  }

  async #acquire(signal: AbortSignal | undefined): Promise<void> {
    signal?.throwIfAborted()
    if (this.#running < this.#concurrency) {
      this.#running += 1
      return
    }
    await new Promise<void>((resolve, reject) => {
      const turn = () => {
        signal?.removeEventListener('abort', leave)
        this.#running += 1
        resolve()
      }
      const leave = () => {
        const at = this.#waiting.indexOf(turn)
        if (at >= 0) this.#waiting.splice(at, 1)
        reject(abortReason(signal))
      }
      signal?.addEventListener('abort', leave, { once: true })
      this.#waiting.push(turn)
    })
  }

  #release(): void {
    this.#running -= 1
    this.#waiting.shift()?.()
  }
}
