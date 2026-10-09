import { LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { ExtensionLayeredConfigSchema, ExtensionPermissionsSchema, JsonValueSchema } from '@nekro-nxt/contracts'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { NekroRuntime } from '../src/bootstrap.js'

/**
 * Porting benchmark runner. Each directory under `NXT_PORTING_DIR` holds `definition.json` and `host.js`; the runner
 * walks dynamic define → verified run → save (import verification) → approved enable in a fresh synthetic Host and
 * writes `result.json` next to the definition. Skipped unless the variable is set.
 */
const portingRoot = process.env['NXT_PORTING_DIR']

const DefinitionSchema = z
  .object({
    name: z.string().min(1),
    purpose: z.string().min(1),
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,48}$/u),
    permissions: ExtensionPermissionsSchema.default({ permissions: [], networkOrigins: [] }),
    config: ExtensionLayeredConfigSchema.optional(),
    verificationInputs: z
      .object({
        tools: z.record(z.string(), z.record(z.string(), JsonValueSchema)).default({}),
        rpc: z.record(z.string(), JsonValueSchema).default({}),
      })
      .optional(),
  })
  .strict()

class QuietModel extends LlmAdapter {
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
  override async *stream(): AsyncIterable<StreamChunk> {
    await Promise.resolve()
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: '基准模型回复' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '基准模型回复' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const portOne = async (directory: string): Promise<Record<string, unknown>> => {
  const definition = DefinitionSchema.parse(JSON.parse(await readFile(path.join(directory, 'definition.json'), 'utf8')))
  const host = await readFile(path.join(directory, 'host.js'), 'utf8')
  const root = await mkdtemp(path.join(tmpdir(), 'nxt-porting-'))
  const stages: string[] = []
  const runtime = await NekroRuntime.create({
    coreDatabasePath: path.join(root, 'core.sqlite'),
    sessionDatabasePath: path.join(root, 'sessions.sqlite'),
    assetRoot: path.join(root, 'assets'),
    extensionDataRoot: path.join(root, 'extension-data'),
    extensionCacheRoot: path.join(root, 'extension-cache'),
    configureLlm: (context) => {
      context.llm.registerAdapter(['test-provider'], new QuietModel())
    },
  })
  try {
    await runtime.start()
    const entity = await runtime.createAgentWithInternalChannel({
      displayName: '移植基准智能体',
      persona: '',
      model: { provider: 'test-provider', model: 'chat-model' },
      capabilities: { dynamicCreation: true },
    })
    await runtime.internalChannel.postMessage({
      channelId: entity.channelId,
      clientEventId: 'seed',
      parts: [{ type: 'text', text: '建立会话。' }],
    })
    const dshSessionId = runtime.repository
      .listActiveEpisodesForAgent(entity.agentId)
      .find((episode) => episode.dshSessionId !== undefined)?.dshSessionId
    if (dshSessionId === undefined) throw new Error('没有建立活动会话。')
    const defined = runtime.host.defineDynamicAuthoringPackage(dshSessionId, {
      plugin: { kind: 'new', idPrefix: 'port' },
      name: definition.name,
      purpose: definition.purpose,
      code: { host },
      resources: {},
      permissions: definition.permissions,
      contributions: [],
      ...(definition.config === undefined ? {} : { config: definition.config }),
      ...(definition.verificationInputs === undefined
        ? {}
        : {
            verificationInputs: {
              tools: definition.verificationInputs.tools,
              rpc: definition.verificationInputs.rpc,
            },
          }),
    })
    stages.push('defined')
    const run = await runtime.host.runDynamicPackage(dshSessionId, defined.pluginId, defined.packageId, 'run')
    if (!run.ok || run.status !== 'running') throw new Error(`动态运行失败：${JSON.stringify(run)}`)
    const task = runtime.repository.listAuthoringTasks(entity.agentId)[0]
    const attempt = task === undefined ? undefined : runtime.repository.listAuthoringAttempts(task.id).at(-1)
    if (task === undefined || attempt === undefined) throw new Error('没有创造任务记录。')
    if (runtime.repository.getAuthoringTask(task.id)?.status !== 'ready') {
      throw new Error(`验证未通过：${JSON.stringify(attempt.error ?? attempt.verification ?? {})}`)
    }
    stages.push('verified')
    const saved = await runtime.authoring.save({
      taskId: task.id,
      attemptId: attempt.id,
      displayName: definition.name,
      slug: definition.slug,
      description: definition.purpose,
    })
    stages.push('saved')
    const requirement = runtime.extensions.agentRequirement(entity.agentId, saved.extension.id, saved.revision.id)
    const hostRequirement = runtime.extensions.hostRequirement(saved.extension.id, saved.revision.id)
    await runtime.extensions.activate({
      agentId: entity.agentId,
      extensionId: saved.extension.id,
      revisionId: saved.revision.id,
      ...(hostRequirement.approvalRequired
        ? { hostPermissionApproval: { permissionDigest: hostRequirement.permissionDigest } }
        : {}),
      ...(requirement.approvalRequired
        ? { permissionApproval: { permissionDigest: requirement.permissionDigest } }
        : {}),
    })
    stages.push('enabled')
    const verification = runtime.repository.getExtensionRevisionVerification(saved.revision.id)
    return {
      ok: true,
      stages,
      tools: verification?.toolInvocations ?? [],
      capabilities: Object.keys(definition.permissions.agent ?? {}),
    }
  } catch (error) {
    return { ok: false, stages, error: error instanceof Error ? error.message : String(error) }
  } finally {
    await runtime.dispose()
    await rm(root, { recursive: true, force: true })
  }
}

describe.skipIf(portingRoot === undefined)('porting benchmark', () => {
  it('ports every candidate in NXT_PORTING_DIR', { timeout: 600_000 }, async () => {
    const root = portingRoot ?? ''
    const only = process.env['NXT_PORTING_ONLY']
    const entries = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && (only === undefined || entry.name === only))
      .map((entry) => entry.name)
      .sort()
    const results: Record<string, unknown> = {}
    for (const name of entries) {
      const directory = path.join(root, name)
      const result = await portOne(directory).catch((error: unknown) => ({
        ok: false,
        stages: [],
        error: error instanceof Error ? error.message : String(error),
      }))
      results[name] = result
      await writeFile(path.join(directory, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
    }
    process.stderr.write(`PORTING ${JSON.stringify(results)}\n`)
    expect(entries.length).toBeGreaterThan(0)
  })
})
