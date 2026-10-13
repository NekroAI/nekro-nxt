import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { materializeImportedRevision } from '@nekro-nxt/extension-format'
import { ExtensionRevisionIdSchema } from '@nekro-nxt/contracts'
import { NekroRuntime } from '../src/bootstrap.js'
import { projectHistoryEntry } from '../src/host-route-support.js'

// Uses the installable example, real builder, verifier, activation and persisted command service.
describe('command extension installation lifecycle', () => {
  it('imports, enables without Session, updates immutable handlers, disables and deletes', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nxt-command-lifecycle-'))
    const runtime = await NekroRuntime.create({
      coreDatabasePath: path.join(directory, 'core.sqlite'),
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      assetRoot: path.join(directory, 'assets'),
      extensionDataRoot: path.join(directory, 'extensions'),
      extensionCacheRoot: path.join(directory, 'cache'),
    })
    try {
      await runtime.start()
      const agent = runtime.core.createAgent({
        displayName: '命令测试智能体',
        persona: '',
        model: { provider: 'deepseek', model: 'deepseek-v4-flash' },
      })
      const channel = runtime.core.createChannel({
        connectionId: runtime.internalConnectionId,
        platformChannelId: 'command-test',
        kind: 'internal',
      })
      runtime.core.createBinding({ channelId: channel.id, agentId: agent.definition.id, triggerPolicy: 'observe-only' })
      const manifest: unknown = JSON.parse(
        await readFile(new URL('../examples/command-echo/manifest.json', import.meta.url), 'utf8'),
      )
      const source = await readFile(new URL('../examples/command-echo/source/host.ts', import.meta.url), 'utf8')
      const materialized = materializeImportedRevision({ manifest, sources: { host: source } })
      const importRevision = (content: typeof materialized) =>
        runtime.extensionService.importRevision({
          extension: {
            id: content.manifest.extensionId,
            slug: 'command-echo',
            displayName: '命令回声示例',
            description: '生命周期测试',
          },
          revision: {
            id: content.manifest.revisionId,
            contentDigest: content.contentDigest,
            payloadDigest: content.payloadDigest,
          },
          manifest: content.manifest,
          sources: content.sources,
        })
      const first = await importRevision(materialized)
      expect((await importRevision(materialized)).idempotent).toBe(true)
      await runtime.extensions.activate({
        agentId: agent.definition.id,
        extensionId: first.extension.id,
        revisionId: first.revision.id,
      })
      const result = await runtime.commands.executeWeb(channel.id, '/echo "测试 文本" --count 2', 'first', 'local')
      expect(result.status).toBe('succeeded')
      expect(result.result?.parts).toEqual([{ type: 'text', text: '测试 文本\n测试 文本' }])
      expect(runtime.repository.getActiveEpisode(channel.id, agent.definition.id)).toBeUndefined()
      // A missing adapter must not hide a completed command result from channel history.
      const delivery = vi.spyOn(runtime.channels, 'sendCommandReply').mockRejectedValueOnce(new Error('offline'))
      const offline = await runtime.commands.executeWeb(channel.id, '/echo 离线结果', 'offline', 'local')
      expect(offline.status).toBe('succeeded')
      expect(offline.replyIntentId).toBeUndefined()
      expect(offline.replyError).toBeDefined()
      const entry = runtime.repository
        .listChannelHistory(channel.id)
        .find((entry) => entry.sourceId === offline.eventId)!
      const projected = projectHistoryEntry(runtime, entry)
      expect(projected.parts).toContainEqual({ type: 'text', text: '离线结果' })
      delivery.mockRestore()
      const secondContent = materializeImportedRevision({
        manifest: { ...materialized.manifest, revisionId: ExtensionRevisionIdSchema.parse('xrv_COMMANDDEMO2') },
        sources: {
          host: source.replace("String(context.arguments['text'])", "'新版本：' + String(context.arguments['text'])"),
        },
      })
      const second = await importRevision(secondContent)
      await runtime.extensions.activate({
        agentId: agent.definition.id,
        extensionId: first.extension.id,
        revisionId: second.revision.id,
      })
      const updated = await runtime.commands.executeWeb(channel.id, '/echo 测试', 'second', 'local')
      expect(updated.extensionRevisionId).toBe(second.revision.id)
      expect(updated.result?.parts).toEqual([{ type: 'text', text: '新版本：测试' }])
      expect(runtime.repository.commands.get(result.id)?.extensionRevisionId).toBe(first.revision.id)
      await runtime.extensions.disable(agent.definition.id, first.extension.id)
      expect(runtime.commands.catalog(channel.id).some((c) => c.fullName.includes(':echo'))).toBe(false)
      await runtime.deleteLocalExtension(first.extension.id)
      expect(runtime.repository.getExtension(first.extension.id)).toBeUndefined()
      expect(runtime.repository.commands.get(result.id)?.status).toBe('succeeded')
    } finally {
      await runtime.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  }, 30000)
})
