import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import path from 'node:path'

/**
 * Host-wide `workingDirectory` for Sessions without a workspace. DSH's subagent service requires one at the root, but
 * the official service also writes the directory into every agent's prompt and stats the filesystem; a chat agent has
 * no workspace to show. Agents with file tools or a shell mount the official service in their own capability context,
 * where their tools find it first.
 */
export class NekroNxtSessionWorkingDirectory extends Service {
  readonly defaultDirectory: string
  private readonly changed = new WeakMap<Session, string>()

  constructor(context: Context, config: { readonly defaultDirectory: string }) {
    super(context, 'workingDirectory')
    if (!path.isAbsolute(config.defaultDirectory))
      throw new Error('workingDirectory: defaultDirectory must be absolute')
    this.defaultDirectory = config.defaultDirectory
  }

  get(session: Session): string {
    return this.changed.get(session) ?? session.header.cwd ?? this.defaultDirectory
  }

  ensure(agent: Agent, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    return Promise.resolve(this.get(agent.session))
  }

  set(agent: Agent, directory: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    if (directory.length === 0) throw new Error('workingDirectory: directory must not be empty')
    const resolved = path.resolve(this.get(agent.session), directory)
    this.changed.set(agent.session, resolved)
    return Promise.resolve(resolved)
  }
}
