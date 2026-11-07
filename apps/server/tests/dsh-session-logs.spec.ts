import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeDshSessionLogs, type SessionLogContext } from '../src/dsh-session-logs.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('removeDshSessionLogs', () => {
  it('removes ended sessions with their forked descendants and leaves loaded ones', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-session-logs-'))
    directories.push(root)
    const project = path.join(root, 'project-a')
    for (const id of ['root', 'child', 'grandchild', 'loaded-child', 'unrelated']) {
      await mkdir(path.join(project, id), { recursive: true })
      await writeFile(path.join(project, id, 'session.v3.jsonl'), '{}\n')
    }
    const headers = [
      { id: 'root' },
      { id: 'child', parentSession: 'root' },
      { id: 'grandchild', parentSession: 'child' },
      { id: 'loaded-child', parentSession: 'root' },
      { id: 'unrelated' },
    ]
    const context: SessionLogContext = {
      sessionPersistence: { list: () => Promise.resolve(headers.map((header) => ({ header }))) },
      agents: { get: (id) => (id === 'loaded-child' ? {} : undefined) },
    }

    const result = await removeDshSessionLogs({ context, sessionsRoot: root, sessionIds: ['root'] })
    expect([...result.removed].sort()).toEqual(['child', 'grandchild', 'root'])
    expect(result.loaded).toEqual(['loaded-child'])
    expect((await readdir(project)).sort()).toEqual(['loaded-child', 'unrelated'])
    await expect(removeDshSessionLogs({ context, sessionsRoot: root, sessionIds: [] })).resolves.toEqual({
      removed: [],
      loaded: [],
    })
  })
})
