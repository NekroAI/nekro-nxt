import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import {
  extensionCapabilitiesExpand,
  ExtensionCapabilitiesSchema,
  HostApiContracts,
  summarizeExtensionCapabilities,
  type McpServerForm,
} from '@nekro-nxt/contracts'
import { extensionManifestSchema } from '@nekro-nxt/extension-runtime'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { buffer } from 'node:stream/consumers'
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NekroRuntime } from '../src/bootstrap.js'
import { createNekroHostApi } from '../src/host-api.js'
import { mcpExtensionSnapshot, testMcpServer } from '../src/mcp-servers.js'

const temporaryDirectories: string[] = []
const fixtureServer = fileURLToPath(new URL('./fixtures/mcp-echo-server.mjs', import.meta.url))

abstract class FixtureModel extends LlmAdapter {
  override providerInfo(provider: string) {
    return { id: provider, name: 'quiet model' }
  }
  override listModels(provider: string) {
    return Promise.resolve([{ provider, id: 'chat-model', name: 'chat', inputModalities: ['text'] as const }])
  }
  override resolveModel(provider: string, model: string) {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      inputModalities: ['text'] as const,
      context: { contextWindow: 128_000 },
    })
  }
}

/** Calls the MCP echo tool once it is offered and keeps what the tool returned. */
class EchoCallingModel extends FixtureModel {
  toolResult: string | undefined
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    await Promise.resolve()
    const callId = ToolCallId('mcp-echo-call')
    const result = options.messages.find((message) => message.role === 'tool' && message.toolCallId === callId)
    if (result !== undefined) {
      this.toolResult = JSON.stringify(result)
    } else if (options.tools?.some((tool) => tool.name === 'mcp__fixture__echo') === true) {
      const argumentsText = JSON.stringify({ text: '示例' })
      const toolCall = { type: 'tool-call' as const, id: callId, name: 'mcp__fixture__echo', arguments: argumentsText }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: callId, name: 'mcp__fixture__echo', argumentsDelta: argumentsText }
      yield { type: 'block-end', index: 0, block: toolCall }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const stdioForm = (token: string): Extract<McpServerForm, { transport: 'stdio' }> => ({
  transport: 'stdio',
  name: 'fixture',
  command: process.execPath,
  args: [fixtureServer],
  env: [{ name: 'FIXTURE_TOKEN', value: token, secret: true }],
})

describe('MCP capability declarations', () => {
  it('keeps credentials out of the Revision and asks for approval when the target changes', () => {
    const { snapshot, secretFields } = mcpExtensionSnapshot({
      displayName: '示例 MCP',
      description: '示例',
      server: {
        transport: 'streamable-http',
        name: 'demo',
        url: 'https://mcp.example.com/mcp',
        headers: [
          { name: 'Authorization', value: 'Bearer fixture-token', secret: true },
          { name: 'X-Mode', value: 'read', secret: false },
        ],
      },
    })
    expect(JSON.stringify(snapshot)).not.toContain('fixture-token')
    expect(secretFields).toEqual([{ key: 'header_1', name: 'Authorization' }])
    const capabilities = ExtensionCapabilitiesSchema.parse(snapshot.permissions?.agent)
    expect(capabilities.mcp?.servers[0]).toEqual({
      transport: 'streamable-http',
      name: 'demo',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: { secret: 'header_1' }, 'X-Mode': 'read' },
    })
    expect(summarizeExtensionCapabilities(capabilities)).toEqual([
      { key: 'mcp.demo', risk: 'sensitive', label: '连接 MCP 服务 demo', detail: 'mcp.example.com' },
    ])
    const local = ExtensionCapabilitiesSchema.parse({
      mcp: { servers: [{ transport: 'stdio', name: 'local', command: 'example-mcp', args: ['--readonly'] }] },
    })
    expect(summarizeExtensionCapabilities(local)[0]).toMatchObject({ risk: 'high', detail: 'example-mcp --readonly' })
    expect(extensionCapabilitiesExpand(capabilities, capabilities)).toBe(false)
    expect(
      extensionCapabilitiesExpand(capabilities, {
        mcp: ExtensionCapabilitiesSchema.parse({
          mcp: { servers: [{ transport: 'streamable-http', name: 'demo', url: 'https://other.example.com/mcp' }] },
        }).mcp,
      }),
    ).toBe(true)
  })

  it('rejects a credential reference that is not a secret config field', () => {
    const manifest = {
      schemaVersion: 7,
      extensionId: 'ext_mcpfixture',
      revisionId: 'xrv_mcpfixture',
      entrypoints: { host: 'source/host.ts' },

      contributions: [],
      permissions: {
        permissions: [],
        networkOrigins: [],
        agent: {
          mcp: {
            servers: [
              {
                transport: 'streamable-http',
                name: 'demo',
                url: 'https://mcp.example.com/mcp',
                headers: { Authorization: { secret: 'token' } },
              },
            ],
          },
        },
      },
    }
    expect(extensionManifestSchema.safeParse(manifest).success).toBe(false)
  })
})

/** Fictional remote MCP server that only answers requests carrying the expected bearer token. */
const startHttpFixture = async (): Promise<{ readonly url: string; readonly server: Server }> => {
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'fixture-remote', version: '1.0.0' })
    server.registerTool('lookup', { description: 'Look up a fictional entry.', inputSchema: z.object({}) }, () => ({
      content: [{ type: 'text', text: 'entry' }],
    }))
    return server
  })
  const server = createServer((req, res) => {
    void (async () => {
      if (req.headers.authorization !== 'Bearer fixture-token') {
        res.writeHead(401).end()
        return
      }
      const body = await buffer(req)
      const headers = new Headers()
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers.set(name, value)
      }
      const response = await handler.fetch(
        new Request(`http://127.0.0.1${req.url ?? '/'}`, {
          method: req.method ?? 'GET',
          headers,
          ...(body.byteLength === 0 ? {} : { body }),
        }),
      )
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
      res.end(Buffer.from(await response.arrayBuffer()))
    })()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Fixture server has no port.')
  return { url: `http://127.0.0.1:${address.port}/mcp`, server }
}

describe('MCP servers in a real Host', () => {
  it('tests a remote server with its credential header and reports a rejected one', async () => {
    const fixture = await startHttpFixture()
    try {
      const form = (token: string): McpServerForm => ({
        transport: 'streamable-http',
        name: 'remote',
        url: fixture.url,
        headers: [{ name: 'Authorization', value: token, secret: true }],
      })
      await expect(testMcpServer(form('Bearer fixture-token'), tmpdir())).resolves.toMatchObject({
        ok: true,
        tools: [{ name: 'lookup' }],
      })
      await expect(testMcpServer(form('Bearer wrong'), tmpdir())).resolves.toMatchObject({ ok: false })
    } finally {
      await new Promise((resolve) => fixture.server.close(resolve))
    }
  })

  it('tests, creates, enables and connects a local MCP server with its credential', async () => {
    const tested = await testMcpServer(stdioForm('fixture-token'), tmpdir())
    expect(tested).toMatchObject({ ok: true, serverName: 'fixture-echo', tools: [{ name: 'echo' }] })
    const failed = await testMcpServer({ ...stdioForm(''), args: ['missing-fixture.mjs'] }, tmpdir())
    expect(failed.ok).toBe(false)

    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-mcp-'))
    temporaryDirectories.push(directory)
    const model = new EchoCallingModel()
    const runtime = await NekroRuntime.create({
      coreDatabasePath: path.join(directory, 'core.sqlite'),
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      assetRoot: path.join(directory, 'assets'),
      extensionDataRoot: path.join(directory, 'extension-data'),
      extensionCacheRoot: path.join(directory, 'extension-cache'),
      configureLlm: (context) => {
        context.llm.registerAdapter(['test-provider'], model)
      },
    })
    const webContext = new Context()
    try {
      await runtime.start()
      const entity = await runtime.createAgentWithInternalChannel({
        displayName: 'MCP 智能体',
        persona: '',
        model: { provider: 'test-provider', model: 'chat-model' },
      })
      await webContext.plugin(WebServer, { host: '127.0.0.1', port: 0 })
      const api = createNekroHostApi(webContext.webServer, runtime)
      const base = `http://127.0.0.1:${api.port}`
      const created = await fetch(`${base}/api/mcp-servers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: '示例回声', server: stdioForm('') }),
      })
      const createdBody: unknown = await created.json()
      expect(created.status, JSON.stringify(createdBody)).toBe(200)
      const { extensionId, revisionId, secretFields } = HostApiContracts.createMcpExtension.parseResponse(createdBody)
      expect(secretFields).toEqual([{ key: 'env_1', name: 'FIXTURE_TOKEN' }])

      const requirement = runtime.extensions.agentRequirement(entity.agentId, extensionId, revisionId)
      expect(requirement.approvalRequired).toBe(true)
      await runtime.extensions.activate({
        agentId: entity.agentId,
        extensionId,
        revisionId,
        permissionApproval: { permissionDigest: requirement.permissionDigest },
      })
      const configured = await fetch(
        `${base}/api/agents/${entity.agentId}/extensions/${extensionId}/activation/config`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ config: {}, secrets: { env_1: 'fixture-token' } }),
        },
      )
      expect(configured.status).toBe(200)

      await runtime.internalChannel.postMessage({
        channelId: entity.channelId,
        clientEventId: 'mcp-session',
        parts: [{ type: 'text', text: '建立会话。' }],
      })
      const sessionId = runtime.repository.listActiveEpisodesForAgent(entity.agentId)[0]?.dshSessionId
      if (!sessionId) throw new Error('Expected a live DSH Session.')
      await vi.waitFor(() => expect(runtime.host.toolNames(sessionId)).toContain('mcp__fixture__echo'), {
        timeout: 15_000,
        interval: 100,
      })

      await vi.waitFor(() =>
        expect(runtime.mcpStatus.list(entity.agentId, extensionId)).toEqual([
          expect.objectContaining({ name: 'fixture', state: 'connected', toolCount: 1 }),
        ]),
      )

      // The bridged tool runs in the server process with the stored credential, not the one typed in the test call.
      await runtime.internalChannel.postMessage({
        channelId: entity.channelId,
        clientEventId: 'mcp-call',
        parts: [{ type: 'text', text: '调用回声工具。' }],
      })
      await vi.waitFor(() => expect(model.toolResult).toContain('echo:示例:token'), { timeout: 15_000 })

      // A second agent enabled without the credential reports it instead of connecting.
      const second = await runtime.createAgentWithInternalChannel({
        displayName: 'MCP 智能体二',
        persona: '',
        model: { provider: 'test-provider', model: 'chat-model' },
      })
      await runtime.extensions.activate({
        agentId: second.agentId,
        extensionId,
        revisionId,
        permissionApproval: {
          permissionDigest: runtime.extensions.agentRequirement(second.agentId, extensionId, revisionId)
            .permissionDigest,
        },
      })
      await runtime.internalChannel.postMessage({
        channelId: second.channelId,
        clientEventId: 'mcp-missing',
        parts: [{ type: 'text', text: '建立会话。' }],
      })
      await vi.waitFor(() =>
        expect(runtime.mcpStatus.list(second.agentId, extensionId)).toEqual([
          expect.objectContaining({ name: 'fixture', state: 'missing-credentials', missing: ['FIXTURE_TOKEN'] }),
        ]),
      )

      const disabled = await fetch(`${base}/api/agents/${entity.agentId}/extensions/${extensionId}/activation`, {
        method: 'DELETE',
      })
      expect(disabled.status).toBe(200)
      // Disabling may also end the Session; either way no live Session keeps the server's tools.
      const liveTools = () =>
        runtime.repository.listActiveEpisodesForAgent(entity.agentId).flatMap((episode) => {
          try {
            return episode.dshSessionId === undefined ? [] : runtime.host.toolNames(episode.dshSessionId)
          } catch {
            return []
          }
        })
      await vi.waitFor(() => expect(liveTools()).not.toContain('mcp__fixture__echo'))
    } finally {
      await webContext.fiber.dispose()
      await runtime.dispose()
    }
  }, 60_000)
})
