import { Context } from '@deepseek-ai/cordis'
import DeepSeekLlmApiExtensionRegistry, { type DeepSeekLlmApiJson } from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import SessionStore, { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { AgentIdSchema, ChannelIdSchema, type HostLogScope } from '@nekro-nxt/contracts'
import { describe, expect, it } from 'vitest'
import { normalizeSessionEvents } from '../src/channel-runtime-events.ts'
import { projectChannelRuntime } from '../src/channel-runtime-projection.ts'
import type { HostLogSink } from '../src/logs/service.ts'
import { mountRequestTiming, reuploadedImageCount, requestImageFacts } from '../src/request-timing.ts'

const fileImage = (id: string): DeepSeekLlmApiJson => ({ type: 'image', source: { type: 'file', file_id: id } })
const requestBody = (...images: DeepSeekLlmApiJson[]): Record<string, DeepSeekLlmApiJson> => ({
  model: 'deepseek-flash',
  messages: [
    { role: 'user', content: [{ type: 'text', text: '看图' }, ...images.slice(0, 1)] },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call_fixture', content: images.slice(1) }],
    },
  ],
})

describe('request image facts', () => {
  it('counts images in messages and tool results, and collects file ids', () => {
    const facts = requestImageFacts(
      requestBody(
        fileImage('file-a'),
        { type: 'image', source: { type: 'base64', data: 'AAAA' } },
        fileImage('file-b'),
      ),
    )
    expect(facts.images).toBe(3)
    expect([...facts.fileIds]).toEqual(['file-a', 'file-b'])
  })

  it('treats new ids beyond the images the history gained as uploads of the same pictures', () => {
    const before = { images: 2, fileIds: new Set(['file-a', 'file-b']) }
    expect(reuploadedImageCount(undefined, before)).toBe(0)
    expect(reuploadedImageCount(before, { images: 3, fileIds: new Set(['file-a', 'file-b', 'file-c']) })).toBe(0)
    expect(reuploadedImageCount(before, { images: 1, fileIds: new Set(['file-b']) })).toBe(0)
    expect(reuploadedImageCount(before, { images: 3, fileIds: new Set(['file-x', 'file-y', 'file-z']) })).toBe(2)
  })
})

describe('request timing', () => {
  const mounted = async () => {
    const context = new Context()
    await context.plugin(SessionStore)
    await context.plugin(DeepSeekLlmApiExtensionRegistry)
    const writes: Parameters<HostLogSink['write']>[0][] = []
    const scope: HostLogScope = { sessionId: 'fixture-request-timing' }
    mountRequestTiming(context, {
      logs: { write: (entry) => void writes.push(entry) },
      scopeOf: () => scope,
    })
    const session = context.sessions.create(SessionId('fixture-request-timing'))
    const send = (body: Record<string, DeepSeekLlmApiJson>, purpose?: 'compaction') =>
      context.deepseekLlmApiExtensions.prepare({
        body,
        sessionId: String(session.id),
        signal: new AbortController().signal,
        ...(purpose === undefined ? {} : { purpose }),
      })
    const sent = () => session.snapshotEvents().filter((event) => event.type === 'nekro-nxt/request-sent')
    return { context, session, send, sent, writes }
  }

  it('records each dispatch under its step without adding a request field', async () => {
    const { session, send, sent, writes } = await mounted()
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })

    const prepared = await send(requestBody(fileImage('file-a'), fileImage('file-b')))
    await send(requestBody(fileImage('file-a'), fileImage('file-b')), 'compaction')

    expect(prepared.fields).toEqual({})
    expect(sent()).toHaveLength(1)
    expect(sent()[0]?.data).toMatchObject({ turn: 1, step: 1, images: 2, fileImages: 2, reuploadedImages: 0 })
    expect(writes).toEqual([])
  })

  it('warns when the next step uploads the same pictures again', async () => {
    const { session, send, sent, writes } = await mounted()
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    await send(requestBody(fileImage('file-a'), fileImage('file-b')))
    session.append('step/start', { turn: 1, step: 2 })
    await send(requestBody(fileImage('file-c'), fileImage('file-d')))

    expect(sent()[1]?.data).toMatchObject({ turn: 1, step: 2, reuploadedImages: 2 })
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ level: 'warn', details: { reuploadedImages: 2 } })
    expect(writes[0]?.message).toContain('2 张图片被重复上传')
  })

  it('shows the time before dispatch on the step', () => {
    const events = normalizeSessionEvents([
      { type: 'turn/start', seq: SessionSeq(1), time: 1000, data: { turn: 1 } },
      { type: 'step/start', seq: SessionSeq(2), time: 1000, data: { turn: 1, step: 1 } },
      {
        type: 'nekro-nxt/request-sent',
        seq: SessionSeq(3),
        time: 23_000,
        data: { turn: 1, step: 1, beforeRequestMs: 22_000, images: 12, fileImages: 12, reuploadedImages: 12 },
      },
    ])
    const projection = projectChannelRuntime({
      channelId: ChannelIdSchema.parse('chn_webmain'),
      agentId: AgentIdSchema.parse('agt_observer'),
      sessionStatus: 'running',
      pendingInjectCount: 0,
      events,
    })
    expect(projection.turns[0]?.steps[0]).toMatchObject({ beforeRequestMs: 22_000, reuploadedImages: 12 })
  })
})
