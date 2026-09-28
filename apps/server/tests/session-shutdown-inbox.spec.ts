import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { EpisodeIdSchema } from '@nekro-nxt/contracts'
import { AssetService, CoreService } from '@nekro-nxt/core'
import { openMigratedCoreDatabase, SqliteCoreRepository } from '@nekro-nxt/storage-sqlite'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { DshHostRuntime } from '../src/index.js'
import { checkpointShutdownInbox, restoreShutdownInbox } from '../src/session-shutdown-inbox.js'

const disposers: Array<() => void | Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const dispose of disposers.splice(0).reverse()) await dispose()
})

class InboxModel extends LlmAdapter {
  readonly calls: GenerateOptions[] = []
  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text'] as const })
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    await Promise.resolve()
    this.calls.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '已读取恢复输入。' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const fixture = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nxt-shutdown-inbox-'))
  disposers.push(() => rm(directory, { recursive: true, force: true }))
  const database = await openMigratedCoreDatabase(path.join(directory, 'core.sqlite'))
  disposers.push(() => database.close())
  const repository = new SqliteCoreRepository(database)
  const core = new CoreService(repository)
  const definition = core.createAgent({
    displayName: '收件箱恢复探针',
    persona: '',
    model: { provider: 'synthetic', model: 'inbox' },
  })
  const connection = core.createConnection({ adapterKey: 'fixture-alpha', config: {} })
  const channel = core.createChannel({ connectionId: connection.id, platformChannelId: 'inbox', kind: 'internal' })
  const model = new InboxModel()
  const input = {
    episodeId: EpisodeIdSchema.parse('eps_SHUTDOWNINBOX'),
    channelId: channel.id,
    agentId: definition.definition.id,
    agentRevisionId: definition.revision.id,
  }
  const root = path.join(directory, 'dsh', 'shutdown-inbox')
  const create = async () => {
    let context: Context | undefined
    const host = await DshHostRuntime.create({
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      communication: { sendMessage: () => Promise.reject(new Error('Unexpected visible message')) },
      history: repository,
      assets: repository,
      assetService: new AssetService(repository, path.join(directory, 'assets')),
      resolveAgentRevision: (id) => repository.getAgentRevision(id),
      configureLlm(ctx) {
        context = ctx
        ctx.llm.registerAdapter(['synthetic'], model)
      },
    })
    disposers.push(() => host.dispose())
    if (!context) throw new Error('Missing public Host Context')
    const hostContext = context
    return {
      host,
      context: hostContext,
      open: async (episodeId = input.episodeId): Promise<Agent> => {
        const id = await host.createSession({ ...input, episodeId })
        const agent = hostContext.agents.get(SessionId(id))
        if (!agent) throw new Error('Missing public Agent')
        return agent
      },
    }
  }
  const checkpointFile = async () => {
    const names = await readdir(root)
    expect(names).toHaveLength(1)
    return path.join(root, names[0]!)
  }
  return { root, create, model, checkpointFile }
}

const message = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

describe('normal shutdown pending-input journal', () => {
  it('preserves both inbox targets and their order across two cold restarts without waking the model', async () => {
    const f = await fixture()
    const first = await f.create()
    const agent = await first.open()
    const steps = [message('待注入一'), message('待注入二')]
    const turns = [message('后续轮次一'), message('后续轮次二')]
    for (const item of steps) agent.inbox.append('next-step', item)
    for (const item of turns) agent.inbox.append('next-turn', item)
    await first.host.dispose()
    await f.checkpointFile()
    for (let restart = 0; restart < 2; restart += 1) {
      const next = await f.create()
      const restored = await next.open()
      expect(restored.inbox.nextStep).toEqual(steps)
      expect(restored.inbox.nextTurn).toEqual(turns)
      expect(restored.status).toBe('idle')
      expect(f.model.calls).toEqual([])
      expect(await readdir(f.root)).toEqual([])
      await next.host.dispose()
    }
  })

  it('deduplicates a surviving journal against pending and already consumed message identities', async () => {
    const f = await fixture()
    const first = await f.create()
    const agent = await first.open()
    const input = message('只能消费一次')
    agent.inbox.append('next-step', input)
    await checkpointShutdownInbox(f.root, agent)
    const file = await f.checkpointFile()
    const receipt = await readFile(file, 'utf8')
    // Simulate a retry before deletion: the same input is already in the live inbox.
    await restoreShutdownInbox(f.root, first.context, agent)
    expect(agent.inbox.nextStep).toEqual([input])
    agent.followup(message('现在读取待注入输入'))
    await agent.whenIdle()
    expect(agent.inbox.nextStep).toEqual([])
    expect(
      first.host.sessionEvents(agent.id).filter((event) => event.type === 'user/message' && event.data.id === input.id),
    ).toHaveLength(1)
    await first.host.dispose()
    // Simulate a crash after the session flush succeeded but before deleting the old journal.
    await writeFile(file, receipt)
    const second = await f.create()
    const restored = await second.open()
    expect(restored.inbox.nextStep).toEqual([])
    expect(restored.inbox.nextTurn).toEqual([])
    expect(
      second.host
        .sessionEvents(agent.id)
        .filter((event) => event.type === 'user/message' && event.data.id === input.id),
    ).toHaveLength(1)
    expect(await readdir(f.root)).toEqual([])
    expect(f.model.calls).toHaveLength(1)
  })

  it('retains the journal on flush failure and retries without duplicating live input', async () => {
    const f = await fixture()
    const current = await f.create()
    const agent = await current.open()
    const input = message('必须可靠恢复')
    agent.inbox.append('next-step', input)
    await checkpointShutdownInbox(f.root, agent)
    const file = await f.checkpointFile()
    const before = await readFile(file, 'utf8')
    agent.inbox.clear()
    expect(agent.inbox.nextStep).toEqual([])
    vi.spyOn(current.context.sessions, 'flush').mockRejectedValueOnce(new Error('synthetic flush failure'))
    await expect(restoreShutdownInbox(f.root, current.context, agent)).rejects.toThrow('synthetic flush failure')
    expect(await readFile(file, 'utf8')).toBe(before)
    await restoreShutdownInbox(f.root, current.context, agent)
    expect(agent.inbox.nextStep).toEqual([input])
    expect(await readdir(f.root)).toEqual([])
  })

  it.each(['wrong-session', 'future-version', 'malformed-message'] as const)(
    'refuses %s without consuming the journal',
    async (kind) => {
      const f = await fixture()
      const current = await f.create()
      const agent = await current.open()
      agent.inbox.append('next-step', message('保留原输入'))
      await checkpointShutdownInbox(f.root, agent)
      const file = await f.checkpointFile()
      const document = z.record(z.string(), z.unknown()).parse(JSON.parse(await readFile(file, 'utf8')))
      if (kind === 'wrong-session') document['sessionId'] = 'another-synthetic-session'
      else if (kind === 'future-version') document['version'] = 999
      else {
        document['nextStep'] = [message('必须先校验整份检查点才能插入')]
        document['nextTurn'] = [{ role: 'assistant', id: 'invalid', content: [] }]
      }
      const corrupted = JSON.stringify(document)
      await writeFile(file, corrupted)
      const before = [...agent.inbox.nextStep]
      await expect(restoreShutdownInbox(f.root, current.context, agent)).rejects.toThrow()
      expect(agent.inbox.nextStep).toEqual(before)
      expect(agent.inbox.nextTurn).toEqual([])
      expect(await readFile(file, 'utf8')).toBe(corrupted)
      expect(f.model.calls).toEqual([])
    },
  )

  it('restores only the selected Session and preserves later user input across another restart', async () => {
    const f = await fixture()
    const first = await f.create()
    const primary = await first.open()
    const siblingEpisode = EpisodeIdSchema.parse('eps_SIBLINGINBOX')
    const sibling = await first.open(siblingEpisode)
    const original = message('原 Session 的待处理输入')
    const other = message('另一个 Session 的输入')
    primary.inbox.append('next-step', original)
    sibling.inbox.append('next-turn', other)
    await first.host.dispose()
    const files = await readdir(f.root)
    expect(files).toHaveLength(2)
    const rows = await Promise.all(
      files.map(async (name) => ({
        file: path.join(f.root, name),
        text: await readFile(path.join(f.root, name), 'utf8'),
      })),
    )
    const siblingJournal = rows.find(
      ({ text }) => z.object({ sessionId: z.string() }).parse(JSON.parse(text)).sessionId === sibling.id,
    )!
    const second = await f.create()
    const restored = await second.open()
    expect(restored.inbox.nextStep).toEqual([original])
    expect(restored.inbox.nextTurn).toEqual([])
    expect(await readdir(f.root)).toEqual([path.basename(siblingJournal.file)])
    expect(await readFile(siblingJournal.file, 'utf8')).toBe(siblingJournal.text)
    const fresh = message('恢复后用户追加的新输入')
    restored.inbox.append('next-step', fresh)
    await restoreShutdownInbox(f.root, second.context, restored)
    expect(restored.inbox.nextStep).toEqual([original, fresh])
    await second.host.dispose()
    const third = await f.create()
    const again = await third.open()
    expect(again.inbox.nextStep).toEqual([original, fresh])
    const restoredSibling = await third.open(siblingEpisode)
    expect(restoredSibling.inbox.nextStep).toEqual([])
    expect(restoredSibling.inbox.nextTurn).toEqual([other])
    expect(await readdir(f.root)).toEqual([])
    expect(f.model.calls).toEqual([])
  })

  it('keeps identical Session IDs in separate data roots independent', async () => {
    const left = await fixture()
    const right = await fixture()
    const leftHost = await left.create()
    const rightHost = await right.create()
    const leftAgent = await leftHost.open()
    const rightAgent = await rightHost.open()
    expect(leftAgent.id).toBe(rightAgent.id)
    const leftInput = message('左侧数据库输入')
    const rightInput = message('右侧数据库输入')
    leftAgent.inbox.append('next-step', leftInput)
    rightAgent.inbox.append('next-step', rightInput)
    await leftHost.host.dispose()
    await rightHost.host.dispose()
    const rightFile = await right.checkpointFile()
    const rightReceipt = await readFile(rightFile, 'utf8')
    const resumedLeft = await left.create()
    expect((await resumedLeft.open()).inbox.nextStep).toEqual([leftInput])
    expect(await readFile(rightFile, 'utf8')).toBe(rightReceipt)
    const resumedRight = await right.create()
    expect((await resumedRight.open()).inbox.nextStep).toEqual([rightInput])
  })

  it('keeps the checkpoint until the public Session flush completes', async () => {
    const f = await fixture()
    const current = await f.create()
    const agent = await current.open()
    const pending = message('必须先持久化后删除恢复文件')
    agent.inbox.append('next-step', pending)
    await checkpointShutdownInbox(f.root, agent)
    const file = await f.checkpointFile()
    agent.inbox.clear()
    const flush = current.context.sessions.flush.bind(current.context.sessions)
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    vi.spyOn(current.context.sessions, 'flush').mockImplementationOnce(async (...args) => {
      entered()
      await gate
      return flush(...args)
    })
    const restoring = restoreShutdownInbox(f.root, current.context, agent)
    try {
      await started
      expect(await readFile(file, 'utf8')).toContain(pending.id)
      expect(agent.inbox.nextStep).toEqual([pending])
    } finally {
      release()
      await restoring
    }
    expect(await readdir(f.root)).toEqual([])
    const handle = await current.context.sessionPersistence.open(agent.id, 'read')
    try {
      const lastInput = (await handle.read()).events.filter((event) => event.type === 'agent/inbox/spliced').at(-1)
      expect(lastInput).toMatchObject({
        type: 'agent/inbox/spliced',
        data: { target: 'next-step', inserted: [pending] },
      })
    } finally {
      await handle.close()
    }
  })

  it('does not create a journal for an empty inbox and accepts a missing journal', async () => {
    const f = await fixture()
    const current = await f.create()
    const agent = await current.open()
    await checkpointShutdownInbox(f.root, agent)
    await expect(readdir(f.root)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(restoreShutdownInbox(f.root, current.context, agent)).resolves.toBeUndefined()
    expect(f.model.calls).toEqual([])
  })
})
