import { SessionSeq } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import {
  CompactionStall,
  FALLBACK_IMAGE_TOKENS,
  compactionBudget,
  imageTokenEstimate,
  isUnshrinkableCompaction,
  offloadOldestImages,
  oldestImageTargets,
  relievePressure,
  roomyTarget,
  visibleImageCount,
  type ImageOffloadTarget,
  type OffloadableSession,
  type PressureMeasurement,
} from '../src/compaction-pressure.js'

/** What a provider charges per image and per text message in these conversations. */
const IMAGE_TOKENS = 1000
const TEXT_TOKENS = 500
/** What DSH's heuristic charges for an image: its small reference. */
const IMAGE_REFERENCE_TOKENS = 40

type Block = { readonly type: 'text'; readonly text: string } | { type: 'image'; offloaded?: true }

/**
 * A conversation measured the way DSH's meter does: the provider's usage at the last answered request plus the
 * heuristic change since. `answer()` stands for the provider answering the next request.
 */
const conversation = (messages: readonly (readonly Block['type'][])[]) => {
  const contents = messages.map((blocks) =>
    blocks.map((type): Block => (type === 'image' ? { type: 'image' } : { type: 'text', text: '聊天' })),
  )
  const offloads: ImageOffloadTarget[][] = []
  const priced = (perImage: number) =>
    contents
      .flat()
      .reduce((sum, block) => sum + (block.type === 'text' ? TEXT_TOKENS : block.offloaded ? 0 : perImage), 0)
  const heuristic = () =>
    contents.flat().reduce((sum, block) => sum + (block.type === 'text' ? TEXT_TOKENS : IMAGE_REFERENCE_TOKENS), 0)
  let usage = priced(IMAGE_TOKENS)
  let anchorSurface = heuristic()
  const measure = (): PressureMeasurement => {
    const surfaceTokens = heuristic()
    const surfaceDeltaTokens = surfaceTokens - anchorSurface
    return {
      totalTokens: usage + surfaceDeltaTokens,
      surfaceTokens,
      surfaceDeltaTokens,
      baseline: { kind: 'usage', tokens: usage },
    }
  }
  const answer = () => {
    usage = priced(IMAGE_TOKENS)
    anchorSurface = heuristic()
  }
  const fake = {
    surface: { nodes: contents.map((_, index) => SessionSeq(index + 1)) },
    eventAt: (seq: SessionSeq) => ({ type: 'user/message', seq }),
    deriveEventMessage: (event: { readonly seq: SessionSeq }) => ({ content: contents[Number(event.seq) - 1]! }),
    append: (_type: 'image/offload', data: { readonly targets: ImageOffloadTarget[] }) => {
      offloads.push(data.targets)
      for (const target of data.targets) {
        const images = contents[Number(target.seq) - 1]!.filter((block) => block.type === 'image')
        for (const index of target.imageIndexes) images[index]!.offloaded = true
      }
    },
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Offloading reads only these members.
  return { session: fake as unknown as OffloadableSession, offloads, measure, answer }
}

const BUDGET = { thresholdTokens: 8000, retainTokens: 1600 }

describe('compaction budget', () => {
  it('derives the threshold and retained tail and leaves one tail of room under the threshold', () => {
    const budget = compactionBudget({ thresholdRatio: 0.8, retainRatio: 0.16 }, 10_000)
    expect(budget).toEqual({ thresholdTokens: 8000, retainTokens: 1600 })
    expect(roomyTarget(budget)).toBe(6400)
    expect(compactionBudget({ thresholdRatio: 0.8, retainTokens: 900 }, 10_000).retainTokens).toBe(900)
  })

  it('recognises only the failures where compacting cannot shrink the conversation', () => {
    expect(
      isUnshrinkableCompaction(
        new Error('summary is not smaller than the shadowed content (1241 estimated framed tokens >= 1241)'),
      ),
    ).toBe(true)
    expect(isUnshrinkableCompaction(new Error('compaction still above threshold after 3 compaction attempts'))).toBe(
      true,
    )
    expect(isUnshrinkableCompaction(new Error('upstream timed out'))).toBe(false)
    expect(isUnshrinkableCompaction('summary is not smaller than the shadowed content')).toBe(false)
  })

  it('waits after a stall until the conversation has grown by a retained tail', () => {
    const stall = new CompactionStall()
    const session = {}
    expect(stall.waiting(session, 9000, BUDGET)).toBe(false)
    stall.record(session, 9000)
    expect(stall.waiting(session, 10_599, BUDGET)).toBe(true)
    expect(stall.waiting(session, 10_600, BUDGET)).toBe(false)
    stall.clear(session)
    expect(stall.waiting(session, 9000, BUDGET)).toBe(false)
  })

  it('learns the price of an image from the gap between the provider usage and the heuristic', () => {
    const { session, measure } = conversation([
      ['image', 'image', 'text'],
      ['image', 'image'],
    ])
    expect(visibleImageCount(session)).toBe(4)
    // Usage 4500 against a heuristic of 660: (4500 - 660) / 4 images.
    expect(imageTokenEstimate(measure(), 4)).toBe(960)
    expect(imageTokenEstimate({ ...measure(), baseline: { kind: 'estimated', tokens: 0 } }, 4)).toBe(
      FALLBACK_IMAGE_TOKENS,
    )
    expect(imageTokenEstimate(measure(), 0)).toBe(FALLBACK_IMAGE_TOKENS)
  })
})

describe('omitting images', () => {
  it('picks the oldest images still sent, skipping ones already omitted and counting them in the indexes', () => {
    const { session } = conversation([['text', 'image', 'image'], ['image'], ['text']])
    expect(oldestImageTargets(session, 2)).toEqual([{ seq: SessionSeq(1), imageIndexes: [0, 1] }])
    session.append('image/offload', { targets: [{ seq: SessionSeq(1), imageIndexes: [0] }] })
    expect(oldestImageTargets(session, 2)).toEqual([
      { seq: SessionSeq(1), imageIndexes: [1] },
      { seq: SessionSeq(2), imageIndexes: [0] },
    ])
  })

  it('omits just enough of the oldest images at once and not again until the provider answers', () => {
    // Eight images and one text message: 8500 tokens against a threshold of 8000 and a goal of 6400.
    const { session, offloads, measure, answer } = conversation([
      ['image', 'image', 'image', 'image'],
      ['text'],
      ['image', 'image', 'image', 'image'],
    ])
    const stall = new CompactionStall()
    const log = vi.fn()
    expect(offloadOldestImages({ session, budget: BUDGET, measurement: measure(), stall, log })).toBe(3)
    expect(offloads).toEqual([[{ seq: SessionSeq(1), imageIndexes: [0, 1, 2] }]])
    // The reading still counts the omitted images; omitting again now would take recent ones.
    expect(measure().totalTokens).toBe(8500)
    expect(offloadOldestImages({ session, budget: BUDGET, measurement: measure(), stall, log })).toBe(0)
    answer()
    expect(measure().totalTokens).toBe(5500)
    expect(offloadOldestImages({ session, budget: BUDGET, measurement: measure(), stall, log })).toBe(0)
    expect(visibleImageCount(session)).toBe(5)
  })

  it('leaves images alone right after something was removed, while the reading is out of date', () => {
    const { session, measure } = conversation([
      ['image', 'image', 'image', 'image', 'image', 'image', 'image', 'image'],
      ['text'],
    ])
    const stale = { ...measure(), surfaceDeltaTokens: -2000 }
    expect(
      offloadOldestImages({ session, budget: BUDGET, measurement: stale, stall: new CompactionStall(), log: vi.fn() }),
    ).toBe(0)
    expect(visibleImageCount(session)).toBe(8)
  })
})

describe('relieving pressure', () => {
  const unshrinkable = () =>
    Promise.reject(new Error('summary is not smaller than the shadowed content (1241 estimated framed tokens >= 1241)'))

  it('omits images instead of failing when the summary cannot shrink, then stops summarizing until it grows', async () => {
    const { session, measure, answer } = conversation([
      ['image', 'image', 'image', 'image'],
      ['text'],
      ['image', 'image', 'image', 'image'],
    ])
    const stall = new CompactionStall()
    const compact = vi.fn(unshrinkable)
    const log = vi.fn<(message: string) => void>()
    expect(await relievePressure({ session, budget: BUDGET, stall, measure, compact, log })).toBeNull()
    expect(compact).toHaveBeenCalledOnce()
    expect(log.mock.calls.map(([message]) => message)).toEqual([
      '跳过压缩：可以整理的文字太少（约 8500 token，阈值 8000），对话再增长 1600 token 前不再尝试',
      '省略了最早的 3 张图片（每张约 960 token），让上下文回到阈值 8000 以下并留出余量',
    ])
    // The next step checks pressure before the provider answers: no summary, no second omission.
    expect(await relievePressure({ session, budget: BUDGET, stall, measure, compact, log })).toBeNull()
    answer()
    expect(await relievePressure({ session, budget: BUDGET, stall, measure, compact, log })).toBeNull()
    expect(compact).toHaveBeenCalledOnce()
    expect(log).toHaveBeenCalledTimes(2)
  })

  it('compacts normally, clears a stall on success and lets other failures through', async () => {
    const { session, measure } = conversation([['text']])
    const stall = new CompactionStall()
    stall.record(session, -2000)
    const log = vi.fn()
    expect(
      await relievePressure({
        session,
        budget: BUDGET,
        stall,
        measure,
        compact: () => Promise.resolve('compacted'),
        log,
      }),
    ).toBe('compacted')
    expect(stall.waiting(session, measure().totalTokens, BUDGET)).toBe(false)
    await expect(
      relievePressure({
        session,
        budget: BUDGET,
        stall,
        measure,
        compact: () => Promise.reject(new Error('upstream timed out')),
        log,
      }),
    ).rejects.toThrow('upstream timed out')
    expect(log).not.toHaveBeenCalled()
  })
})
