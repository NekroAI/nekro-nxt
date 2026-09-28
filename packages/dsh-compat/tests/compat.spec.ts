import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { boot, composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { defineTool, ToolRuntime } from '@deepseek-ai/dsh-tools'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { RootOwnerProps } from '../src/client.ts'
import { assertDshPackageVersions, DSH_PACKAGE_VERSIONS, readInstalledDshVersions } from '../src/index.ts'
import { DSH_RUNTIME_RELEASE } from '../src/release.ts'

const parsePackageManifest = (input: unknown): { readonly version: string } => {
  if (typeof input !== 'object' || input === null || !('version' in input) || typeof input.version !== 'string') {
    throw new Error('DSH package does not expose a string version.')
  }
  return { version: input.version }
}

const parseDependencies = (input: unknown): Record<string, string> => {
  if (typeof input !== 'object' || input === null) throw new Error('Invalid package dependencies.')
  const result: Record<string, string> = {}
  for (const [name, version] of Object.entries(input)) {
    if (typeof version !== 'string') throw new Error(`Invalid package version: ${name}`)
    result[name] = version
  }
  return result
}

describe('DSH package family', () => {
  it('resolves every production Client package at the exact validated version', () => {
    expect(readInstalledDshVersions()).toEqual(DSH_PACKAGE_VERSIONS)
    expect(assertDshPackageVersions).not.toThrow()
  })

  it('validates all declared compatibility packages against the release manifest', async () => {
    const require = createRequire(import.meta.url)
    const manifest: unknown = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    if (
      typeof manifest !== 'object' ||
      manifest === null ||
      !('dependencies' in manifest) ||
      !('devDependencies' in manifest)
    ) {
      throw new Error('Compatibility package manifest is incomplete.')
    }
    const declared = Object.entries({
      ...parseDependencies(manifest.dependencies),
      ...parseDependencies(manifest.devDependencies),
    }).filter(([name]) => name.startsWith('@deepseek-ai/'))
    expect(declared.length).toBeGreaterThan(10)
    for (const [name, version] of declared) {
      expect(DSH_RUNTIME_RELEASE.packages[name], name).toBe(version)
      expect(parsePackageManifest(require(`${name}/package.json`)).version, name).toBe(version)
    }
  })

  it('loads representative public Host entries', async () => {
    const [agent, session, cordisTool, compaction, webserver, persistence] = await Promise.all([
      import('@deepseek-ai/dsh-agent'),
      import('@deepseek-ai/dsh-session'),
      import('@deepseek-ai/dsh-tool-cordis'),
      import('@deepseek-ai/dsh-compaction-basic'),
      import('@deepseek-ai/dsh-host-webserver'),
      import('@deepseek-ai/dsh-session-persistence-jsonl'),
    ])
    expect(agent.AgentRegistry).toBeTypeOf('function')
    expect(session.Session).toBeTypeOf('function')
    expect(cordisTool.name).toBeTypeOf('string')
    expect(cordisTool.apply).toBeTypeOf('function')
    expect(compaction.BasicCompactionEngine).toBeTypeOf('function')
    expect(webserver.WebServer).toBeTypeOf('function')
    expect(persistence.default).toBeTypeOf('function')
  })

  it('composes the published Base and Web Bundle patches through the public profile seam', () => {
    const require = createRequire(import.meta.url)
    const base = loadOverlayPatches('nekro-nxt-m0', require.resolve('@deepseek-ai/dsh-base/cordis.patch.yml'))
    const web = loadOverlayPatches('nekro-nxt-m0', require.resolve('@deepseek-ai/dsh-web-app/cordis.patch.yml'))
    const entries = composeEntries([base, web])
    const byId = new Map(entries.map((entry) => [entry.id, entry]))

    expect(byId.get('session')).toMatchObject({ name: '@deepseek-ai/dsh-session' })
    expect(byId.get('agent')).toMatchObject({ name: '@deepseek-ai/dsh-agent' })
    expect(byId.get('webserver')).toMatchObject({ name: '@deepseek-ai/dsh-host-webserver' })
    expect(byId.get('ui-renderer')).toMatchObject({ name: '@deepseek-ai/dsh-client-ui-renderer' })
  })

  it('boots published services through the Loader and flushes an agent-owned Session', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-dsh-boot-'))
    try {
      const runtime = await bootAgentHost(directory)
      try {
        expect(runtime.agents).toBeInstanceOf(AgentRegistry)
        const owner = await runtime.agents.create({ sessionId: SessionId('compat-loader-session') })
        try {
          owner.agent.session.append('turn/start', { turn: 1 })
          owner.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
          expect(await runtime.sessions.flush(owner.agent.session)).toBe(true)
          expect((await runtime.sessionPersistence.list()).map(({ header }) => header.id)).toContain(owner.agent.id)
          const reader = await runtime.sessionPersistence.open(owner.agent.id, 'read')
          try {
            expect((await reader.read()).events.map(({ type }) => type)).toEqual(['turn/start', 'turn/end'])
          } finally {
            await reader.close()
          }
        } finally {
          await owner.dispose()
        }
        expect(runtime.agents.list()).toEqual([])
        expect(runtime.sessions.list()).toEqual([])
      } finally {
        await runtime.fiber.dispose()
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('DSH scope and Client Slot seams', () => {
  it('owns scoped registrations through a disposable agent-level context', async () => {
    const root = new Context()
    const identity = {}
    const scope = createScope(root, identity)
    expect(scopeOf(scope.ctx)).toBe(identity)
    await scope.dispose()
    expect(scope.ctx.fiber.state).not.toBe('active')
  })

  it('constructs the public Slot registry with the framework root declaration', () => {
    const slots = new SlotCore()
    expect(slots.specDynamic('root')).toMatchObject({ kind: 'single', scope: 'root' })
    expect(slots.entries('root')).toEqual([])

    const dispose = slots.register({ name: 'root' }, (() => null) satisfies (props: RootOwnerProps) => null)
    expect(slots.entriesOfSlot('root')).toHaveLength(1)
    dispose()
    expect(slots.entriesOfSlot('root')).toEqual([])
  })

  it('registers, replaces and disposes a contribution only in its target agent scope', async () => {
    const root = new Context()
    try {
      await root.plugin(SystemPrompt, {})
      await root.plugin(ToolRuntime, { mode: 'native' })
      const agentA = createScope(root, { agentId: 'agent-a' })
      const agentB = createScope(root, { agentId: 'agent-b' })
      const start = async (version: string) => {
        const fiber = agentA.ctx.plugin({
          inject: ['tools'],
          apply: (context) =>
            context.tools.register(
              defineTool({
                name: 'dynamic_probe',
                description: `Scoped dynamic probe ${version}`,
                parameters: {},
                output: {
                  schema: { type: 'string' },
                  render: (_arguments, value) => [{ type: 'text', text: value }],
                },
                execute: () => Promise.resolve(version),
              }),
            ),
        })
        await fiber
        return fiber
      }

      try {
        const version1 = await start('v1')
        expect(root.tools.get('dynamic_probe', scopeOf(agentA.ctx))?.description).toContain('v1')
        expect(root.tools.get('dynamic_probe', scopeOf(agentB.ctx))).toBeUndefined()

        await version1.dispose()
        await start('v2')
        expect(root.tools.get('dynamic_probe', scopeOf(agentA.ctx))?.description).toContain('v2')
      } finally {
        await agentA.dispose()
        await agentB.dispose()
      }

      expect(root.tools.get('dynamic_probe')).toBeUndefined()
    } finally {
      await root.fiber.dispose()
    }
  })
})

describe('DSH Session persistence assembly', () => {
  it('writes and reopens the exact committed log using public JSONL handles', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-dsh-handle-'))
    const writer = new Context()
    const reader = new Context()
    const session = Session.create(SessionId('compat-jsonl-handle'))
    const events = [
      session.append('turn/start', { turn: 1 }),
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ]
    try {
      await writer.plugin(JsonlSessionPersistence, { root: directory })
      const handle = await writer.sessionPersistence.create(session.header)
      try {
        await handle.append(events)
        await handle.flush()
        expect((await handle.read()).events).toEqual(events)
        await expect(writer.sessionPersistence.open(session.id, 'write')).rejects.toThrow()
      } finally {
        await handle.close()
      }
      await writer.fiber.dispose()

      await reader.plugin(JsonlSessionPersistence, { root: directory })
      const restored = await reader.sessionPersistence.open(session.id, 'read')
      try {
        expect(restored.header).toMatchObject(session.header)
        expect((await restored.read()).events).toEqual(events)
        await expect(restored.append([])).rejects.toThrow()
      } finally {
        await restored.close()
      }
      // Teardown releases the single-writer lease; a new owner can open it.
      const successor = await reader.sessionPersistence.open(session.id, 'write')
      await successor.close()
    } finally {
      await writer.fiber.dispose()
      await reader.fiber.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rolls back failed unpublished setup and releases persistence ownership for a later resume', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-dsh-rollback-'))
    const sessionId = SessionId('compat-failed-setup')
    try {
      const runtime = await bootAgentHost(directory)
      try {
        const owner = await runtime.agents.create({ sessionId })
        owner.agent.session.append('turn/start', { turn: 1 })
        owner.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
        await owner.dispose()
        await expect(
          runtime.agents.resume({
            resumeSessionId: sessionId,
            setup: () => {
              throw new Error('synthetic setup failure')
            },
          }),
        ).rejects.toThrow('synthetic setup failure')
        expect(runtime.agents.get(sessionId)).toBeUndefined()
        expect(runtime.sessions.get(sessionId)).toBeUndefined()
        const replacement = await runtime.agents.resume({ resumeSessionId: sessionId })
        expect(runtime.agents.get(sessionId)).toBe(replacement.agent)
        await replacement.dispose()
      } finally {
        await runtime.fiber.dispose()
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('resumes a persisted agent with fresh scoped setup and drains both registries on disposal', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-dsh-resume-'))
    const sessionId = SessionId('compat-agent-resume')
    try {
      const writer = await bootAgentHost(directory)
      try {
        const owner = await writer.agents.create({ sessionId })
        owner.agent.session.append('turn/start', { turn: 1 })
        owner.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
        await owner.dispose()
        expect(writer.agents.get(sessionId)).toBeUndefined()
        expect(writer.sessions.get(sessionId)).toBeUndefined()
      } finally {
        await writer.fiber.dispose()
      }

      const reader = await bootAgentHost(directory)
      try {
        let setupCount = 0
        const owner = await reader.agents.resume({
          resumeSessionId: sessionId,
          setup: (agentContext, agent) => {
            expect(reader.agents.get(sessionId)).toBeUndefined()
            expect(reader.sessions.get(sessionId)).toBeUndefined()
            expect(scopeOf(agentContext)).toBe(agent)
            setupCount += 1
          },
        })
        try {
          expect(setupCount).toBe(1)
          expect(reader.agents.get(sessionId)).toBe(owner.agent)
          expect(reader.sessions.get(sessionId)).toBe(owner.agent.session)
          expect(await reader.sessions.flush(owner.agent.session)).toBe(true)
          const stored = await reader.sessionPersistence.open(sessionId, 'read')
          try {
            expect((await stored.read()).events.map(({ type }) => type)).toEqual([
              'turn/start',
              'turn/end',
              'session/end-seed',
            ])
          } finally {
            await stored.close()
          }
        } finally {
          await owner.dispose()
        }
        expect(reader.agents.get(sessionId)).toBeUndefined()
        expect(reader.sessions.get(sessionId)).toBeUndefined()
      } finally {
        await reader.fiber.dispose()
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

/** Resolve the representative host from the public Base bundle's declared dependencies. */
async function bootAgentHost(directory: string): Promise<Context> {
  const require = createRequire(import.meta.url)
  const configPath = path.join(directory, 'cordis.json')
  const entries = ['session', 'agent', 'llm', 'system-prompt', 'tools', 'session-projection', 'agent-loop'].map(
    (id) => ({
      id,
      name: `@deepseek-ai/dsh-${id}`,
    }),
  )
  await writeFile(
    configPath,
    JSON.stringify([
      ...entries,
      {
        id: 'session-persistence-jsonl',
        name: '@deepseek-ai/dsh-session-persistence-jsonl',
        config: { root: path.join(directory, 'sessions') },
      },
    ]),
  )
  const anchor = pathToFileURL(require.resolve('@deepseek-ai/dsh-base/package.json')).href
  return boot('nekro-nxt-compat', configPath, undefined, undefined, anchor)
}
