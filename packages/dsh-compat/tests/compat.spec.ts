import { Context } from '@deepseek-ai/cordis'
import { boot, composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { SqliteSessionPersistence } from '@deepseek-ai/dsh-session-persistence-sqlite'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { defineTool, ToolRuntime } from '@deepseek-ai/dsh-tools'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RootOwnerProps } from '../src/client.ts'
import { assertDshPackageVersions, DSH_PACKAGE_VERSIONS, readInstalledDshVersions } from '../src/index.ts'

const DSH_DEVELOPMENT_COMPATIBILITY_VERSIONS = {
  '@deepseek-ai/cordis': '4.0.1',
  '@deepseek-ai/dsh-agent': '0.1.1-rc.2',
  '@deepseek-ai/dsh-agent-presets': '0.1.1-rc.2',
  '@deepseek-ai/dsh-app-boot': '0.1.1-rc.2',
  '@deepseek-ai/dsh-base': '0.1.1-rc.2',
  '@deepseek-ai/dsh-client-runtime': '0.1.1-rc.2',
  '@deepseek-ai/dsh-client-ui-slots': '0.1.1-rc.2',
  '@deepseek-ai/dsh-client-web': '0.1.1-rc.2',
  '@deepseek-ai/dsh-compaction-basic': '0.1.1-rc.2',
  '@deepseek-ai/dsh-host-webserver': '0.1.1-rc.2',
  '@deepseek-ai/dsh-scope': '0.1.1-rc.2',
  '@deepseek-ai/dsh-session': '0.1.1-rc.2',
  '@deepseek-ai/dsh-session-persistence-sqlite': '0.1.1-rc.2',
  '@deepseek-ai/dsh-system-prompt': '0.1.1-rc.2',
  '@deepseek-ai/dsh-tool-cordis': '0.1.1-rc.2',
  '@deepseek-ai/dsh-tools': '0.1.1-rc.2',
  '@deepseek-ai/dsh-web-app': '0.1.1-rc.2',
} as const

const parsePackageManifest = (input: unknown): { readonly version: string } => {
  if (typeof input !== 'object' || input === null || !('version' in input) || typeof input.version !== 'string') {
    throw new Error('DSH package does not expose a string version.')
  }
  return { version: input.version }
}

describe('DSH package family', () => {
  it('resolves every production Client package at the exact validated version', () => {
    expect(readInstalledDshVersions()).toEqual(DSH_PACKAGE_VERSIONS)
    expect(assertDshPackageVersions).not.toThrow()
  })

  it('pins the broader development compatibility surface without making it a production dependency', () => {
    const require = createRequire(import.meta.url)
    const installed = Object.fromEntries(
      Object.keys(DSH_DEVELOPMENT_COMPATIBILITY_VERSIONS).map((name) => {
        const manifest = parsePackageManifest(require(`${name}/package.json`))
        return [name, manifest.version]
      }),
    )
    expect(installed).toEqual(DSH_DEVELOPMENT_COMPATIBILITY_VERSIONS)
  })

  it('loads representative public Host entries', async () => {
    const [agent, session, presets, cordisTool, compaction, webserver, persistence] = await Promise.all([
      import('@deepseek-ai/dsh-agent'),
      import('@deepseek-ai/dsh-session'),
      import('@deepseek-ai/dsh-agent-presets'),
      import('@deepseek-ai/dsh-tool-cordis'),
      import('@deepseek-ai/dsh-compaction-basic'),
      import('@deepseek-ai/dsh-host-webserver'),
      import('@deepseek-ai/dsh-session-persistence-sqlite'),
    ])
    expect(agent.AgentRegistry).toBeTypeOf('function')
    expect(session.Session).toBeTypeOf('function')
    expect(presets.AgentPresets).toBeTypeOf('function')
    expect(cordisTool.name).toBeTypeOf('string')
    expect(cordisTool.apply).toBeTypeOf('function')
    expect(compaction.BasicCompactionEngine).toBeTypeOf('function')
    expect(webserver.WebServer).toBeTypeOf('function')
    expect(persistence.SqliteSessionPersistence).toBeTypeOf('function')
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
    expect(byId.get('client-runtime')).toMatchObject({ name: '@deepseek-ai/dsh-client-runtime' })
  })

  it('boots a minimal published DSH package composition through the Loader', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-dsh-boot-'))
    const configPath = path.join(directory, 'cordis.yml')
    const databasePath = path.join(directory, 'sessions.sqlite')
    await writeFile(
      configPath,
      [
        '- id: session',
        "  name: '@deepseek-ai/dsh-session'",
        '- id: persistence',
        "  name: '@deepseek-ai/dsh-session-persistence-sqlite'",
        '  config:',
        `    path: ${JSON.stringify(databasePath)}`,
        '    writeBatchMaxDelayMs: 1',
        '',
      ].join('\n'),
      'utf8',
    )

    try {
      const packageAnchor = new URL('../package.json', import.meta.url).href
      const runtime = await boot('nekro-nxt-m0', configPath, undefined, undefined, packageAnchor)
      try {
        const session = runtime.sessions.create(SessionId('m0-loader-session'))
        session.append('turn/start', { turn: 1 })
        session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
        expect(await runtime.sessions.flush(session)).toBe(true)
        expect((await runtime.sessionPersistence.list()).map(({ id }) => id)).toContain(session.id)
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
  it('persists a committed turn and resumes the exact unpublished Session', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-dsh-session-'))
    const databasePath = path.join(directory, 'sessions.sqlite')
    const sessionId = SessionId('m0-session-resume')

    try {
      const writer = new Context()
      try {
        await writer.plugin(SessionStore)
        await writer.plugin(SqliteSessionPersistence, { path: databasePath, writeBatchMaxDelayMs: 1 })

        const session = writer.sessions.create(sessionId)
        session.append('turn/start', { turn: 1 })
        session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

        expect(await writer.sessions.flush(session)).toBe(true)
        expect((await writer.sessionPersistence.inspect(sessionId)).events).toEqual(session.events)
      } finally {
        await writer.fiber.dispose()
      }

      const reader = new Context()
      try {
        await reader.plugin(SessionStore)
        await reader.plugin(SqliteSessionPersistence, { path: databasePath, writeBatchMaxDelayMs: 1 })

        const preparation = await reader.sessionPersistence.prepare(sessionId)
        try {
          const detach = reader.sessions.enter(preparation.session)
          try {
            reader.sessions.announce(preparation.session)
            expect(reader.sessions.get(sessionId)).toBe(preparation.session)
            expect(preparation.session.events.map(({ type }) => type)).toEqual([
              'turn/start',
              'turn/end',
              'session/end-seed',
            ])
          } finally {
            detach()
          }
        } finally {
          preparation[Symbol.dispose]()
        }
      } finally {
        await reader.fiber.dispose()
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
