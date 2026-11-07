import { readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'

/** The parts of the DSH root context this needs. */
export interface SessionLogContext {
  readonly agents: { get(id: SessionId): unknown }
  readonly sessionPersistence: {
    list(): Promise<readonly { readonly header: { readonly id: string; readonly parentSession?: string } }[]>
  }
}

export interface RemovedSessionLogs {
  /** Sessions whose directories were removed, descendants included. */
  readonly removed: readonly string[]
  /** Sessions still loaded in this process; their logs stay. */
  readonly loaded: readonly string[]
}

/**
 * Removes the stored logs of ended DSH sessions together with every session forked from them (subagent children and
 * their children). DSH has no delete; a session lives in `<sessionsRoot>/<project>/<sessionId>/`, so its directory is
 * removed directly. A session still loaded in this process is left alone.
 */
export async function removeDshSessionLogs(input: {
  readonly context: SessionLogContext
  readonly sessionsRoot: string
  readonly sessionIds: readonly string[]
}): Promise<RemovedSessionLogs> {
  if (input.sessionIds.length === 0) return { removed: [], loaded: [] }
  const children = new Map<string, string[]>()
  for (const { header } of await input.context.sessionPersistence.list()) {
    if (header.parentSession === undefined) continue
    const siblings = children.get(header.parentSession) ?? []
    siblings.push(header.id)
    children.set(header.parentSession, siblings)
  }
  const targets = new Set<string>()
  const pending = [...input.sessionIds]
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (targets.has(id)) continue
    targets.add(id)
    pending.push(...(children.get(id) ?? []))
  }
  let projects: string[]
  try {
    projects = await readdir(input.sessionsRoot)
  } catch {
    projects = []
  }
  const removed: string[] = []
  const loaded: string[] = []
  for (const id of targets) {
    if (id === '' || id === '.' || id === '..' || /[\\/]/u.test(id)) continue
    if (input.context.agents.get(SessionId(id)) !== undefined) {
      loaded.push(id)
      continue
    }
    for (const project of projects) {
      await rm(path.join(input.sessionsRoot, project, id), { recursive: true, force: true })
    }
    removed.push(id)
  }
  return { removed, loaded }
}
