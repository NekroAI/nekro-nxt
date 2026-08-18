import { LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { access, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultWebDistIndex, parseLlmProviderRoutes, startNekroServer } from '../src/main.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

class SilentModel extends LlmAdapter {
  override providerInfo(provider: string) {
    return { id: provider, name: 'Workspace test provider' }
  }

  override listModels(provider: string) {
    return Promise.resolve([{ provider, id: 'workspace-model', name: 'Workspace model' }])
  }

  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 16_000 } })
  }

  override async *stream(): AsyncIterable<StreamChunk> {
    await Promise.resolve()
    yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const exerciseDevelopmentWorkspace = async (developmentWorkspaceRoot?: string) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-main-workspace-'))
  temporaryDirectories.push(directory)
  const dataRoot = path.join(directory, 'data')
  const distRoot = path.join(directory, 'dist')
  const distIndex = path.join(distRoot, 'index.html')
  await mkdir(distRoot, { recursive: true })
  await writeFile(distIndex, '<div id="root"></div>', 'utf8')
  const handle = await startNekroServer({
    dataRoot,
    distIndex,
    ...(developmentWorkspaceRoot === undefined ? {} : { developmentWorkspaceRoot }),
    configureLlm: (context) => {
      context.llm.registerAdapter(['workspace-provider'], new SilentModel())
    },
  })
  const origin = `http://127.0.0.1:${handle.port}`
  try {
    const createdResponse = await fetch(`${origin}/api/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: '开发工作区智能体',
        persona: '',
        model: { provider: 'workspace-provider', model: 'workspace-model' },
        capabilities: { fileTools: true, developmentShell: true },
      }),
    })
    expect(createdResponse.status).toBe(201)
    const created = (await createdResponse.json()) as { agentId: string; channelId: string }
    const admitted = await fetch(`${origin}/api/channels/${created.channelId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parts: [{ type: 'text', text: '检查开发工作区。' }], clientEventId: 'workspace-1' }),
    })
    expect(admitted.status).toBe(200)
    const root = developmentWorkspaceRoot ?? path.join(dataRoot, 'workspaces')
    const workspace = path.join(root, created.agentId)
    await expect
      .poll(
        async () => {
          try {
            return (await stat(workspace)).isDirectory()
          } catch {
            return false
          }
        },
        { timeout: 5_000 },
      )
      .toBe(true)
    expect((await stat(workspace)).mode & 0o777).toBe(0o700)
    return { dataRoot, workspace }
  } finally {
    await handle.stop()
  }
}

describe('Server executable defaults', () => {
  it('resolves the Web build independently from the workspace command cwd', () => {
    expect(defaultWebDistIndex()).toBe(path.resolve(import.meta.dirname, '../../web/dist/index.html'))
  })

  it('parses an explicit, deduplicated DSH provider route allowlist', () => {
    expect(parseLlmProviderRoutes(undefined)).toEqual([])
    expect(parseLlmProviderRoutes(' opencode-go,deepseek,opencode-go ')).toEqual(['opencode-go', 'deepseek'])
    expect(() => parseLlmProviderRoutes('opencode-go,../forged')).toThrow('无效路由')
  })

  it('creates an isolated intelligent-agent workspace under the unified data root by default', async () => {
    const { dataRoot, workspace } = await exerciseDevelopmentWorkspace()
    expect(workspace.startsWith(path.join(dataRoot, 'workspaces') + path.sep)).toBe(true)
    await expect(access(path.join(dataRoot, path.basename(workspace)))).rejects.toThrow()
  })

  it('honors an explicit external workspace root without dropping files into data root', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-main-workspace-override-'))
    temporaryDirectories.push(directory)
    const overrideRoot = path.join(directory, 'external-workspaces')
    const { dataRoot, workspace } = await exerciseDevelopmentWorkspace(overrideRoot)
    expect(workspace.startsWith(overrideRoot + path.sep)).toBe(true)
    await expect(access(path.join(dataRoot, 'workspaces'))).rejects.toThrow()
  })
})
