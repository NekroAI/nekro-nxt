import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parse, stringify } from 'yaml'
import { z } from 'zod'
import { NekroRuntime } from '../src/bootstrap.js'

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

class MaintenanceModel extends LlmAdapter {
  calls = 0
  override providerInfo(provider: string) {
    return { id: provider, name: 'Maintenance fixture' }
  }
  override listModels(provider: string) {
    return Promise.resolve([{ provider, id: 'fixture-model', name: 'Fixture' }])
  }
  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 128_000 } })
  }
  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    void _options
    await Promise.resolve()
    const first = ++this.calls === 1
    const name = first ? 'maintenance_fixture_wait' : 'finish_channel_turn'
    const id = ToolCallId(`maintenance-${this.calls}`)
    const args = JSON.stringify(first ? {} : { outcome: 'no-response-needed', reason: '测试任务保持静默。' })
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'nxt-dsh-maintenance-'))
  const entered = deferred()
  const releaseTool = deferred()
  const model = new MaintenanceModel()
  let hostContext: Context | undefined
  let toolSignal: AbortSignal | undefined
  const runtime = await NekroRuntime.create({
    coreDatabasePath: path.join(root, 'core.sqlite'),
    sessionDatabasePath: path.join(root, 'sessions.sqlite'),
    assetRoot: path.join(root, 'assets'),
    extensionDataRoot: path.join(root, 'extension-data'),
    extensionCacheRoot: path.join(root, 'extension-cache'),
    llmSettingsPath: path.join(root, 'dsh/settings.yaml'),
    llmCredentialPath: path.join(root, 'dsh/credentials.yaml'),
    configureLlm: (context) => {
      hostContext = context
      context.llm.registerAdapter(['maintenance-fixture'], model)
      context.inject(['tools'], (injected) => {
        injected.effect(() =>
          injected.tools.register({
            name: 'maintenance_fixture_wait',
            description: 'Synthetic tool held while settings are edited.',
            parameters: {},
            output: {
              schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
              render: () => [{ type: 'text', text: 'done' }],
            },
            execute: async (_args, exec) => {
              toolSignal = exec.signal
              entered.resolve()
              await releaseTool.promise
              exec.signal.throwIfAborted()
              return { ok: true }
            },
          }),
        )
      })
    },
  })
  cleanups.push(async () => {
    releaseTool.resolve()
    await runtime.dispose()
    await rm(root, { recursive: true, force: true })
  })
  await runtime.start()
  if (!hostContext) throw new Error('Missing fixture host context')
  const entity = await runtime.createAgentWithInternalChannel({
    displayName: '设置维护测试智能体',
    persona: '保持当前任务连续。',
    model: { provider: 'maintenance-fixture', model: 'fixture-model' },
  })
  const post = (id: string) =>
    runtime.internalChannel.postMessage({
      channelId: entity.channelId,
      clientEventId: id,
      parts: [{ type: 'text', text: '执行测试。' }],
    })
  return { root, runtime, context: hostContext, entity, model, entered, releaseTool, post, signal: () => toolSignal }
}

describe('DSH settings maintenance at the product entrypoint', () => {
  it('waits for a running tool, parks new input during the write and retains the same agent and Revision', async () => {
    const f = await fixture()
    await f.post('first')
    await f.entered.promise
    const agent = f.context.agents.list()[0]!
    const loop = [...f.context.loader.entries()].find(({ options }) => options.id === 'agent-loop')!.fiber
    const before = f.runtime.host.listDshSettings().find(({ ns }) => ns === 'web-search-deepseek')!
    const writeEntered = deferred()
    const releaseWrite = deferred()
    const settings = f.context.settings
    const mutate = settings.mutate.bind(settings)
    const spy = vi.spyOn(settings, 'mutate').mockImplementationOnce(async (...args) => {
      writeEntered.resolve()
      await releaseWrite.promise
      return mutate(...args)
    })
    const editing = f.runtime.host.mutateDshSettings(before.ns, before.revision, [
      { op: 'set', path: ['maxUses'], value: 3 },
    ])
    try {
      await Promise.resolve()
      expect(spy).not.toHaveBeenCalled()
      expect(f.signal()?.aborted).toBe(false)
      f.releaseTool.resolve()
      await writeEntered.promise
      const callsBeforeInput = f.model.calls
      await f.post('during-write')
      expect(f.model.calls).toBe(callsBeforeInput)
      expect(f.context.agents.get(agent.id)).toBe(agent)
      expect(f.signal()?.aborted).toBe(false)
    } finally {
      releaseWrite.resolve()
    }
    expect(await editing).toMatchObject({ resolved: { maxUses: 3 } })
    await agent.whenIdle()
    expect(f.model.calls).toBeGreaterThan(2)
    expect([...f.context.loader.entries()].find(({ options }) => options.id === 'agent-loop')!.fiber).toBe(loop)
    expect(f.runtime.repository.listActiveEpisodesForAgent(f.entity.agentId)[0]?.agentRevisionId).toBe(
      f.entity.revisionId,
    )
  })

  it('releases maintenance on a failed save, preserves cold fields and lets the next edit and message proceed', async () => {
    const f = await fixture()
    f.releaseTool.resolve()
    await f.post('first')
    const agent = f.context.agents.list()[0]!
    await agent.whenIdle()
    const before = f.runtime.host.listDshSettings().find(({ ns }) => ns === 'subagent')!
    vi.spyOn(f.context.settings, 'mutate').mockRejectedValueOnce(new Error('synthetic settings write failure'))
    await expect(
      f.runtime.host.mutateDshSettings(before.ns, before.revision, [
        { op: 'set', path: ['maxActiveSubagents'], value: 4 },
      ]),
    ).rejects.toThrow('synthetic settings write failure')
    expect(
      await f.runtime.host.mutateDshSettings(before.ns, before.revision, [
        { op: 'set', path: ['maxActiveSubagents'], value: 4 },
      ]),
    ).toMatchObject({ resolved: { maxActiveSubagents: 4 } })
    const loop = f.runtime.host.listDshSettings().find(({ ns }) => ns === 'agent-loop')!
    await expect(
      f.runtime.host.mutateDshSettings(loop.ns, loop.revision, [{ op: 'set', path: ['agents'], value: [] }]),
    ).rejects.toThrow('not volatile')
    expect(f.runtime.host.listDshSettings().some(({ ns }) => ns === 'spill-policy')).toBe(false)
    await f.post('after-rejected-edit')
    await agent.whenIdle()
    expect(f.context.agents.get(agent.id)).toBe(agent)
  })

  it('refuses a cold on-disk AgentLoop reload before it can dispose a live session', async () => {
    const f = await fixture()
    f.releaseTool.resolve()
    await f.post('first')
    const agent = f.context.agents.list()[0]!
    await agent.whenIdle()
    const filename = f.context.profileContext.patchPath
    const source = await readFile(filename, 'utf8')
    const patches = z.array(z.record(z.string(), z.unknown())).parse(parse(source))
    await writeFile(
      filename,
      stringify([...patches, { id: 'agent-loop', config: { agents: [{ id: 'unexpected-cold-agent' }] } }]),
    )
    const before = f.runtime.host.listDshSettings().find(({ ns }) => ns === 'web-search-deepseek')!
    try {
      await expect(
        f.runtime.host.mutateDshSettings(before.ns, before.revision, [{ op: 'set', path: ['maxUses'], value: 3 }]),
      ).rejects.toThrow()
      expect(f.context.agents.get(agent.id)).toBe(agent)
    } finally {
      await writeFile(filename, source)
    }
    await f.post('after-cold-rejection')
    await agent.whenIdle()
    expect(f.context.agents.get(agent.id)).toBe(agent)
  })
})
