import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { HostApiContracts } from '@nekro-nxt/contracts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NekroRuntime } from '../src/bootstrap.js'
import { createNekroHostApi } from '../src/host-api.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('NekroNxt domain API — local Extension lifecycle (M4 slice)', () => {
  it('lists a saved Extension in the snapshot and activates/disables it through the API', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-extension-api-'))
    temporaryDirectories.push(directory)
    const runtime = await NekroRuntime.create({
      coreDatabasePath: path.join(directory, 'core.sqlite'),
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      assetRoot: path.join(directory, 'assets'),
      extensionDataRoot: path.join(directory, 'extension-data'),
      extensionCacheRoot: path.join(directory, 'extension-cache'),
    })
    await runtime.start()
    await runtime.recover()

    // Create an intelligent-agent and a saved local Extension Revision directly
    // against the assembled services (the dynamic-capture prerequisite is the
    // creator workbench, out of scope for this API lifecycle test).
    const agent = runtime.core.createAgent({
      displayName: '启用智能体的测试智能体',
      persona: '',
      model: { provider: 'test-provider', model: 'chat-model' },
    })
    const saved = await runtime.extensionService.saveDynamicPackage({
      snapshot: {
        name: '频道摘要',
        purpose: '生成结构化阶段摘要。',
        hostCode: `return {
        inject: ['tools'],
        apply(ctx) {
          harness.registerTool(ctx, harness.defineTool({
            name: 'summary_tool',
            description: 'summary',
            parameters: {},
            output: { schema: { type: 'string' }, render(_a, v) { return [{ type: 'text', text: v }] } },
            execute() { return 'ok' }
          }))
        }
      }`,
      },
      slug: 'channel-summary',
      displayName: '频道摘要',
      description: '生成结构化阶段摘要。',
      createdByAgentId: agent.definition.id,
    })

    const webContext = new Context()
    await webContext.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const api = createNekroHostApi(webContext.webServer, runtime)
    const origin = `http://127.0.0.1:${api.port}`

    try {
      // The saved Extension appears in the authoritative snapshot (inactive).
      let snapshot = HostApiContracts.snapshot.parseResponse(await (await fetch(`${origin}/api/snapshot`)).json())
      expect(snapshot.extensions).toHaveLength(1)
      expect(snapshot.extensions[0]).toMatchObject({
        slug: 'channel-summary',
        revisions: [{ id: saved.revision.id, revisionNumber: 1 }],
        activations: [],
      })

      // Activate it for the intelligent-agent through the API.
      const activationResponse = await fetch(
        `${origin}/api/agents/${agent.definition.id}/extensions/${saved.extension.id}/activation`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ revisionId: saved.revision.id }),
        },
      )
      expect(activationResponse.ok).toBe(true)
      const activationJson = HostApiContracts.activateExtension.parseResponse(await activationResponse.json())
      expect(activationJson.activation).toMatchObject({
        agentId: agent.definition.id,
        extensionId: saved.extension.id,
        extensionRevisionId: saved.revision.id,
      })

      // The snapshot now reports the Extension as active for that agent.
      snapshot = HostApiContracts.snapshot.parseResponse(await (await fetch(`${origin}/api/snapshot`)).json())
      expect(snapshot.extensions.find((extension) => extension.id === saved.extension.id)?.activations).toEqual([
        expect.objectContaining({ agentId: agent.definition.id, extensionRevisionId: saved.revision.id }),
      ])

      // Disable it through the API.
      const disableResponse = await fetch(
        `${origin}/api/agents/${agent.definition.id}/extensions/${saved.extension.id}/activation`,
        { method: 'DELETE' },
      )
      expect(disableResponse.ok).toBe(true)

      snapshot = HostApiContracts.snapshot.parseResponse(await (await fetch(`${origin}/api/snapshot`)).json())
      expect(snapshot.extensions.find((extension) => extension.id === saved.extension.id)?.activations).toEqual([])
    } finally {
      api.dispose()
      await webContext.fiber.dispose()
      await runtime.dispose()
    }
  })
})
