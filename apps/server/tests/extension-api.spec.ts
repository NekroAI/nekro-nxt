import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { HostApiContracts } from '@nekro-nxt/contracts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
        hostCode: `harness.handle('summary', (input) => ({ echoed: input }))
      return {
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
        clientCode: `return {
        inject: ['panels', 'data'],
        apply(ctx) {
          ctx.panels.register(
            { id: 'summary-panel', anchor: 'extension', title: '摘要', densities: ['full'] },
            ({ anchor }) => React.createElement('section', { 'data-extension-panel': anchor.id }, '摘要面板')
          )
        }
      }`,
        permissions: { permissions: ['agents.read'], networkOrigins: [] },
        config: {
          schema: {
            type: 'object',
            dict: { length: { type: 'natural', meta: { description: '摘要长度', default: 3 } } },
          },
        },
        contributions: [
          { kind: 'tool', name: 'summary_tool', description: 'summary' },
          { kind: 'rpc', method: 'summary' },
          { kind: 'panel', id: 'summary-panel', anchor: 'extension', title: '摘要', densities: ['full'] },
        ],
      },
      slug: 'channel-summary',
      displayName: '频道摘要',
      description: '生成结构化阶段摘要。',
      createdByAgentId: agent.definition.id,
      verification: {
        dshVersion: '0.1.1-rc.2',
        contractVersion: 'nekro-nxt-extension-v4',
        origin: {
          episodeId: 'eps_synthetic_extension_api',
          pluginId: 'plugin-synthetic-extension-api',
          packageId: 'package-synthetic-extension-api',
          pluginRunId: 'run-synthetic-extension-api',
        },
        toolInvocations: [{ name: 'summary_tool', succeeded: true }],
        rpcMethods: ['summary'],
        renderedPanels: ['summary-panel'],
        renderedToolViews: [],
        renderedMessageRenderers: [],
        permissions: { permissions: ['agents.read'], networkOrigins: [] },
      },
    })

    const webContext = new Context()
    await webContext.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const api = createNekroHostApi(webContext.webServer, runtime)
    const origin = `http://127.0.0.1:${api.port}`

    try {
      // The saved Extension appears in the authoritative snapshot (inactive).
      const projectedBuildKey = 'f'.repeat(64)
      const buildKeyProjection = vi
        .spyOn(runtime.extensionService, 'currentBuildKey')
        .mockReturnValue(projectedBuildKey)
      let snapshot = HostApiContracts.snapshot.parseResponse(await (await fetch(`${origin}/api/snapshot`)).json())
      expect(snapshot.extensions).toHaveLength(1)
      expect(snapshot.extensions[0]).toMatchObject({
        slug: 'channel-summary',
        revisions: [
          {
            id: saved.revision.id,
            revisionNumber: 1,
            format: 'current',
            ui: { panels: [expect.objectContaining({ id: 'summary-panel', anchor: 'extension' })] },
            verification: { buildKey: projectedBuildKey },
          },
        ],
        activations: [],
      })
      buildKeyProjection.mockRestore()

      // Activation asks for permission approval first, then accepts the exact digest.
      const activationUrl = `${origin}/api/agents/${agent.definition.id}/extensions/${saved.extension.id}/activation`
      const unapproved = await fetch(activationUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revisionId: saved.revision.id }),
      })
      expect(unapproved.status).toBe(400)
      const unapprovedJson: unknown = await unapproved.json()
      const digest = /permission-approval-required:([a-f0-9]{64})/u.exec(JSON.stringify(unapprovedJson))?.[1]
      expect(digest).toBeDefined()
      const activationResponse = await fetch(activationUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revisionId: saved.revision.id, permissionApproval: { permissionDigest: digest } }),
      })
      expect(activationResponse.ok).toBe(true)
      const activationJson = HostApiContracts.activateExtension.parseResponse(await activationResponse.json())
      expect(activationJson.activation).toMatchObject({
        agentId: agent.definition.id,
        extensionId: saved.extension.id,
        extensionRevisionId: saved.revision.id,
        config: { length: 3 },
      })
      const invalidConfig = await fetch(`${activationUrl}/config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ config: { length: -1 } }),
      })
      expect(invalidConfig.status).toBe(400)
      const configResponse = await fetch(`${activationUrl}/config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ config: { length: 5 } }),
      })
      expect(HostApiContracts.updateExtensionActivationConfig.parseResponse(await configResponse.json())).toEqual({
        config: { length: 5 },
      })

      const artifact = await runtime.extensionService.buildRevision(saved.revision)
      expect(artifact.clientEntry).toBeDefined()
      const staleArtifactResponse = await fetch(
        `${origin}/api/extensions/${saved.extension.id}/revisions/${saved.revision.id}/client/${'0'.repeat(64)}.mjs?agentId=${agent.definition.id}`,
      )
      expect(staleArtifactResponse.status).toBe(409)
      const artifactResponse = await fetch(
        `${origin}/api/extensions/${saved.extension.id}/revisions/${saved.revision.id}/client/${artifact.buildKey}.mjs?agentId=${agent.definition.id}`,
      )
      expect(artifactResponse.ok).toBe(true)
      expect(artifactResponse.headers.get('content-type')).toContain('text/javascript')
      expect(await artifactResponse.text()).toContain('summary-panel')

      const rpcResponse = await fetch(
        `${origin}/api/extensions/${saved.extension.id}/revisions/${saved.revision.id}/call`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ agentId: agent.definition.id, method: 'summary', input: { value: 'synthetic' } }),
        },
      )
      expect(rpcResponse.ok).toBe(true)
      expect(HostApiContracts.extensionClientCall.parseResponse(await rpcResponse.json())).toEqual({
        value: { echoed: { value: 'synthetic' } },
      })

      const diagnosticResponse = await fetch(
        `${origin}/api/extensions/${saved.extension.id}/revisions/${saved.revision.id}/client-diagnostic`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ agentId: agent.definition.id, status: 'loaded' }),
        },
      )
      expect(diagnosticResponse.ok).toBe(true)

      // The snapshot now reports the Extension as active for that agent.
      snapshot = HostApiContracts.snapshot.parseResponse(await (await fetch(`${origin}/api/snapshot`)).json())
      expect(snapshot.extensions.find((extension) => extension.id === saved.extension.id)?.activations).toEqual([
        expect.objectContaining({ agentId: agent.definition.id, extensionRevisionId: saved.revision.id }),
      ])
      expect(snapshot.extensions.find((extension) => extension.id === saved.extension.id)?.clientDiagnostics).toEqual([
        expect.objectContaining({ agentId: agent.definition.id, revisionId: saved.revision.id, status: 'loaded' }),
      ])

      // Disable it through the API.
      const disableResponse = await fetch(
        `${origin}/api/agents/${agent.definition.id}/extensions/${saved.extension.id}/activation`,
        { method: 'DELETE' },
      )
      expect(disableResponse.ok).toBe(true)

      const inactiveRpc = await fetch(
        `${origin}/api/extensions/${saved.extension.id}/revisions/${saved.revision.id}/call`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ agentId: agent.definition.id, method: 'summary' }),
        },
      )
      expect(inactiveRpc.ok).toBe(false)

      snapshot = HostApiContracts.snapshot.parseResponse(await (await fetch(`${origin}/api/snapshot`)).json())
      expect(snapshot.extensions.find((extension) => extension.id === saved.extension.id)?.activations).toEqual([])
      expect(snapshot.extensions.find((extension) => extension.id === saved.extension.id)?.clientDiagnostics).toEqual(
        [],
      )
    } finally {
      api.dispose()
      await webContext.fiber.dispose()
      await runtime.dispose()
    }
  })
})

describe('agent extension credentials', () => {
  it('stores secrets through the config API, never returns them, and deletes them when the extension goes away', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-extension-secrets-'))
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
    const agent = runtime.core.createAgent({
      displayName: '凭据测试智能体',
      persona: '',
      model: { provider: 'test-provider', model: 'chat-model' },
    })
    const saved = await runtime.extensionService.saveDynamicPackage({
      snapshot: {
        name: '带凭据的工具',
        purpose: '读取凭据。',
        hostCode: `return {
        inject: ['tools', 'nxt'],
        apply(ctx) {
          harness.registerTool(ctx, harness.defineTool({
            name: 'secret_probe',
            description: 'probe',
            parameters: {},
            output: { schema: { type: 'string' }, render(_a, v) { return [{ type: 'text', text: v }] } },
            async execute() { return (await ctx.nxt.secrets.get('apiKey')) ? 'set' : 'missing' }
          }))
        }
      }`,
        permissions: { permissions: [], networkOrigins: [] },
        config: {
          schema: {
            type: 'object',
            dict: { apiKey: { type: 'string', meta: { description: 'API Key', role: 'secret' } } },
          },
        },
        contributions: [{ kind: 'tool', name: 'secret_probe', description: 'probe' }],
      },
      slug: 'secret-probe',
      displayName: '带凭据的工具',
      description: '读取凭据。',
      createdByAgentId: agent.definition.id,
      verification: {
        dshVersion: '0.1.1-rc.2',
        contractVersion: 'nekro-nxt-extension-v4',
        origin: {
          episodeId: 'eps_synthetic_secret',
          pluginId: 'plugin-synthetic-secret',
          packageId: 'package-synthetic-secret',
          pluginRunId: 'run-synthetic-secret',
        },
        toolInvocations: [{ name: 'secret_probe', succeeded: true }],
        rpcMethods: [],
        renderedPanels: [],
        renderedToolViews: [],
        renderedMessageRenderers: [],
        permissions: { permissions: [], networkOrigins: [] },
      },
    })
    const webContext = new Context()
    try {
      await runtime.activation.activate({
        agentId: agent.definition.id,
        extensionId: saved.extension.id,
        revisionId: saved.revision.id,
      })
      await webContext.plugin(WebServer, { host: '127.0.0.1', port: 0 })
      const api = createNekroHostApi(webContext.webServer, runtime)
      const base = `http://127.0.0.1:${api.port}/api/agents/${agent.definition.id}/extensions/${saved.extension.id}/activation`
      const updated = await fetch(`${base}/config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ config: {}, secrets: { apiKey: 'fixture-api-key' } }),
      })
      const updatedBody: unknown = await updated.json()
      expect(updatedBody, JSON.stringify(updatedBody)).toEqual({ config: {}, configuredSecrets: ['apiKey'] })
      const stored = runtime.repository.getActivation(agent.definition.id, saved.extension.id)?.config
      const reference =
        stored !== null && typeof stored === 'object' && !Array.isArray(stored) ? stored['apiKey'] : undefined
      if (typeof reference !== 'string') throw new Error('Activation config does not hold a credential reference.')
      expect(await runtime.credentials.has(reference)).toBe(true)

      const disabled = await fetch(base, { method: 'DELETE' })
      expect(disabled.status).toBe(200)
      expect(await runtime.credentials.has(reference)).toBe(false)
    } finally {
      await webContext.fiber.dispose()
      await runtime.dispose()
    }
  })
})

describe('agent extension switching while the agent is replying', () => {
  it('answers pending at once, shows the waiting request, and lands or fails at the safe gap', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-extension-pending-'))
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
    const agent = runtime.core.createAgent({
      displayName: '忙碌的测试智能体',
      persona: '',
      model: { provider: 'test-provider', model: 'chat-model' },
    })
    const saved = await runtime.extensionService.saveDynamicPackage({
      snapshot: {
        name: '掷骰探针',
        purpose: '验证回复期间的启停。',
        hostCode: `return {
        inject: ['tools'],
        apply(ctx) {
          harness.registerTool(ctx, harness.defineTool({
            name: 'dice_probe',
            description: 'probe',
            parameters: {},
            output: { schema: { type: 'string' }, render(_a, v) { return [{ type: 'text', text: v }] } },
            execute() { return '4' }
          }))
        }
      }`,
        permissions: { permissions: [], networkOrigins: [] },
        contributions: [{ kind: 'tool', name: 'dice_probe', description: 'probe' }],
      },
      slug: 'dice-probe',
      displayName: '掷骰探针',
      description: '验证回复期间的启停。',
      createdByAgentId: agent.definition.id,
      verification: {
        dshVersion: '0.1.1-rc.2',
        contractVersion: 'nekro-nxt-extension-v4',
        origin: {
          episodeId: 'eps_synthetic_pending',
          pluginId: 'plugin-synthetic-pending',
          packageId: 'package-synthetic-pending',
          pluginRunId: 'run-synthetic-pending',
        },
        toolInvocations: [{ name: 'dice_probe', succeeded: true }],
        rpcMethods: [],
        renderedPanels: [],
        renderedToolViews: [],
        renderedMessageRenderers: [],
        permissions: { permissions: [], networkOrigins: [] },
      },
    })
    // The agent is "replying" until the test opens the gate.
    let openGate: () => void = () => undefined
    const closeGate = () =>
      new Promise<void>((resolve) => {
        openGate = resolve
      })
    let gate = closeGate()
    const waitUntilSafe = vi.spyOn(runtime.host, 'waitUntilSafe').mockImplementation(() => gate)
    const webContext = new Context()
    await webContext.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const api = createNekroHostApi(webContext.webServer, runtime)
    const origin = `http://127.0.0.1:${api.port}`
    const activationUrl = `${origin}/api/agents/${agent.definition.id}/extensions/${saved.extension.id}/activation`
    const projected = async () =>
      HostApiContracts.snapshot
        .parseResponse(await (await fetch(`${origin}/api/snapshot`)).json())
        .extensions.find((extension) => extension.id === saved.extension.id)
    const until = async (check: () => Promise<boolean>) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (await check()) return
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      throw new Error('Condition was not reached.')
    }
    try {
      const enabling = await fetch(activationUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revisionId: saved.revision.id }),
      })
      expect(enabling.status).toBe(200)
      const enabled = HostApiContracts.activateExtension.parseResponse(await enabling.json())
      expect(enabled.activation).toBeUndefined()
      expect(enabled.pending).toMatchObject({ agentId: agent.definition.id, target: 'enabled', state: 'waiting' })
      expect((await projected())?.activationTransitions).toEqual([
        expect.objectContaining({ agentId: agent.definition.id, target: 'enabled', state: 'waiting' }),
      ])
      expect((await projected())?.activations).toEqual([])

      openGate()
      await until(async () => (await projected())?.activations.length === 1)
      expect((await projected())?.activationTransitions).toBeUndefined()

      // Disabling while replying is pending as well.
      gate = closeGate()
      const disabling = await fetch(activationUrl, { method: 'DELETE' })
      expect(HostApiContracts.deactivateExtension.parseResponse(await disabling.json()).pending).toMatchObject({
        target: 'disabled',
        state: 'waiting',
      })
      openGate()
      await until(async () => (await projected())?.activations.length === 0)

      // A failure at the safe gap stays visible with its reason.
      gate = closeGate()
      vi.spyOn(runtime.host, 'mount').mockRejectedValueOnce(new Error('扩展加载失败：示例原因'))
      const failing = await fetch(activationUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revisionId: saved.revision.id }),
      })
      expect(failing.status).toBe(200)
      openGate()
      await until(async () => (await projected())?.activationTransitions?.[0]?.state === 'failed')
      expect((await projected())?.activationTransitions).toEqual([
        expect.objectContaining({ target: 'enabled', state: 'failed', message: '扩展加载失败：示例原因' }),
      ])
      expect((await projected())?.activations).toEqual([])

      // An idle agent gets the committed Activation in the same response.
      waitUntilSafe.mockImplementation(() => Promise.resolve())
      const immediate = await fetch(activationUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revisionId: saved.revision.id }),
      })
      expect(HostApiContracts.activateExtension.parseResponse(await immediate.json()).activation).toMatchObject({
        extensionRevisionId: saved.revision.id,
      })
      expect((await projected())?.activationTransitions).toBeUndefined()
    } finally {
      openGate()
      api.dispose()
      await webContext.fiber.dispose()
      await runtime.dispose()
    }
  })
})
