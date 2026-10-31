import { EpisodeIdSchema } from '@nekro-nxt/contracts'
import { describe, expect, it, vi } from 'vitest'
import { finishChannelTurnTool, type ChannelWaitRequester } from '../src/index.ts'

const episodeId = EpisodeIdSchema.parse('eps_waitfixture')

const run = async (
  args: Record<string, unknown>,
  wait?: { readonly episodeId: typeof episodeId; readonly request: ChannelWaitRequester },
) => {
  const concludeTurn = vi.fn()
  const tool = finishChannelTurnTool(() => false, wait)
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- The tool reads only these two members.
  const exec = { agent: {}, concludeTurn } as unknown as Parameters<typeof tool.execute>[1]
  const result = await tool.execute(args, exec)
  return { result, concludeTurn }
}

describe('finish_channel_turn waiting-for-more (Decision 2026-10-31 R2)', () => {
  it('starts a wait for the latest speaker and ends the turn', async () => {
    const request = vi.fn<ChannelWaitRequester>(() => ({ accepted: true, displayName: '阿离', seconds: 20 }))
    const { result, concludeTurn } = await run(
      { outcome: 'waiting-for-more', reason: '她只说了半句。', seconds: 25 },
      { episodeId, request },
    )
    expect(request).toHaveBeenCalledWith({ episodeId, seconds: 25 })
    expect(result).toEqual({
      status: 'finished',
      outcome: 'waiting-for-more',
      reason: '她只说了半句。',
      waiting: { displayName: '阿离', seconds: 20 },
    })
    expect(concludeTurn).toHaveBeenCalledOnce()
  })

  it('keeps the turn open with the refusal as the tool error', async () => {
    const request: ChannelWaitRequester = () => ({ accepted: false, reason: '这个频道关闭了等待。' })
    await expect(
      run({ outcome: 'waiting-for-more', reason: '等等看。', seconds: 10 }, { episodeId, request }),
    ).rejects.toThrow('这个频道关闭了等待。')
    await expect(run({ outcome: 'waiting-for-more', reason: '等等看。' })).rejects.toThrow('waiting-for-more')
  })

  it('leaves the other outcomes as they were', async () => {
    const request = vi.fn<ChannelWaitRequester>()
    const { result } = await run({ outcome: 'no-response-needed', reason: '没在叫我。' }, { episodeId, request })
    expect(result).toEqual({ status: 'finished', outcome: 'no-response-needed', reason: '没在叫我。' })
    expect(request).not.toHaveBeenCalled()
  })
})
