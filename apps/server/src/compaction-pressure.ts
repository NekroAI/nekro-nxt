import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'

/** The compaction policy fields NekroNXT reads to price its own decisions. */
export interface CompactionBudgetPolicy {
  readonly thresholdRatio: number
  readonly retainRatio?: number
  readonly retainTokens?: number
}

/** Token levels one conversation is held to: compaction starts at the threshold and keeps the retained tail. */
export interface CompactionBudget {
  readonly thresholdTokens: number
  readonly retainTokens: number
}

/**
 * The pressure threshold and retained tail for one model window. DSH derives its own figures from the same ratios
 * after reserving output tokens, so these are a close upper estimate, used only to leave room below the threshold.
 */
export const compactionBudget = (policy: CompactionBudgetPolicy, contextWindow: number): CompactionBudget => ({
  thresholdTokens: Math.floor(contextWindow * policy.thresholdRatio),
  retainTokens: policy.retainTokens ?? Math.floor(contextWindow * (policy.retainRatio ?? 0.16)),
})

/**
 * Where restored images and offloading stop: one retained tail below the threshold, so the next turn has room
 * before compaction is due again.
 */
export const roomyTarget = (budget: CompactionBudget): number =>
  Math.max(0, budget.thresholdTokens - budget.retainTokens)

/**
 * DSH reports these when compacting cannot shrink the conversation: what is old enough to summarize is already
 * shorter than any summary, typically because images fill the retained tail.
 */
export const isUnshrinkableCompaction = (error: unknown): boolean =>
  error instanceof Error &&
  (error.message.startsWith('summary is not smaller than the shadowed content') ||
    error.message.startsWith('compaction still above threshold'))

/**
 * What DSH's token meter reports. The total is the provider's usage at the last answered request plus a heuristic
 * for what changed since; the heuristic prices an image as its small reference, so images count at their real size
 * only through that usage.
 */
export interface PressureMeasurement {
  readonly totalTokens: number
  readonly surfaceTokens: number
  /** Heuristic change since the last answered request; negative when something was removed since. */
  readonly surfaceDeltaTokens: number
  readonly baseline: { readonly kind: string; readonly tokens: number }
}

/** Used when the conversation gives nothing to learn an image's size from. */
export const FALLBACK_IMAGE_TOKENS = 1000
const MIN_IMAGE_TOKENS = 85

/**
 * What one image costs on this route. The provider's usage exceeds the heuristic mostly by the images it priced
 * small; spread over the images in view, that gap is the price per image. It also carries the tool definitions, so
 * it errs high, which only makes restoring and offloading more cautious.
 */
export const imageTokenEstimate = (measurement: PressureMeasurement, visibleImages: number): number => {
  const gap = measurement.totalTokens - measurement.surfaceTokens
  if (measurement.baseline.kind !== 'usage' || visibleImages === 0 || gap <= 0) return FALLBACK_IMAGE_TOKENS
  return Math.max(MIN_IMAGE_TOKENS, Math.ceil(gap / visibleImages))
}

/** One `image/offload` target: an input message and the image occurrences in it to omit. */
export interface ImageOffloadTarget {
  readonly seq: SessionSeq
  readonly imageIndexes: readonly number[]
}

/** A session as offloading sees it: its surface, its events, and the log it appends the decision to. */
export type OffloadableSession = Pick<Session, 'eventAt' | 'deriveEventMessage'> & {
  readonly surface: { readonly nodes: readonly SessionSeq[] }
  append(type: 'image/offload', data: { readonly targets: ImageOffloadTarget[] }): unknown
}

type ImageReader = Pick<OffloadableSession, 'eventAt' | 'deriveEventMessage' | 'surface'>

/**
 * The oldest `count` images still sent to the model, in request order, in the shape DSH's image offload records.
 * Indexes count every image occurrence in a message, including ones already omitted.
 */
export const oldestImageTargets = (session: ImageReader, count: number): ImageOffloadTarget[] => {
  const targets: ImageOffloadTarget[] = []
  let left = count
  for (const seq of session.surface.nodes) {
    if (left === 0) break
    const event = session.eventAt(seq)
    if (event?.type !== 'user/message' && event?.type !== 'tool/result') continue
    const message = session.deriveEventMessage(event)
    if (message === null) continue
    const imageIndexes: number[] = []
    let imageIndex = 0
    for (const block of message.content) {
      if (block.type !== 'image') continue
      if (left > 0 && block.offloaded !== true) {
        imageIndexes.push(imageIndex)
        left -= 1
      }
      imageIndex += 1
    }
    if (imageIndexes.length > 0) targets.push({ seq, imageIndexes })
  }
  return targets
}

/** How many images the model still receives in this session. */
export const visibleImageCount = (session: ImageReader): number =>
  oldestImageTargets(session, Number.MAX_SAFE_INTEGER).reduce((sum, target) => sum + target.imageIndexes.length, 0)

/**
 * Conversations whose last compaction could not shrink them, with the size they had then, and the usage reading
 * images were last omitted against. Compacting again before the conversation grows by a retained tail would only
 * pay for another summary that is thrown away; omitting again before the provider answers would count the same
 * images twice, since the reading still includes the ones already omitted.
 */
export class CompactionStall {
  readonly #stalledAt = new WeakMap<object, number>()
  readonly #offloadedAgainst = new WeakMap<object, number>()

  /** Whether compaction should wait: it stalled before and the conversation has not grown enough since. */
  waiting(session: object, tokens: number, budget: CompactionBudget): boolean {
    const stalledAt = this.#stalledAt.get(session)
    return stalledAt !== undefined && tokens < stalledAt + budget.retainTokens
  }

  record(session: object, tokens: number): void {
    this.#stalledAt.set(session, tokens)
  }

  clear(session: object): void {
    this.#stalledAt.delete(session)
  }

  offloadedAgainst(session: object): number | undefined {
    return this.#offloadedAgainst.get(session)
  }

  noteOffload(session: object, baselineTokens: number): void {
    this.#offloadedAgainst.set(session, baselineTokens)
  }
}

/**
 * Omits the oldest images, in one decision, until the conversation should sit a retained tail below the threshold.
 * Acts only on a fresh provider reading: right after compaction or an earlier omission the reading still counts
 * images that are gone, and acting on it would omit recent ones. Returns how many images were omitted.
 */
export const offloadOldestImages = (input: {
  readonly session: OffloadableSession
  readonly budget: CompactionBudget
  readonly measurement: PressureMeasurement
  readonly stall: CompactionStall
  readonly log: (message: string) => void
}): number => {
  const { session, budget, measurement, stall, log } = input
  if (measurement.totalTokens < budget.thresholdTokens) return 0
  if (measurement.baseline.kind !== 'usage' || measurement.surfaceDeltaTokens < 0) return 0
  if (stall.offloadedAgainst(session) === measurement.baseline.tokens) return 0
  const visible = visibleImageCount(session)
  if (visible === 0) return 0
  const perImage = imageTokenEstimate(measurement, visible)
  const count = Math.min(visible, Math.ceil((measurement.totalTokens - roomyTarget(budget)) / perImage))
  const targets = oldestImageTargets(session, count)
  if (targets.length === 0) return 0
  session.append('image/offload', { targets })
  stall.noteOffload(session, measurement.baseline.tokens)
  log(
    `省略了最早的 ${count} 张图片（每张约 ${perImage} token），让上下文回到阈值 ${budget.thresholdTokens} 以下并留出余量`,
  )
  return count
}

/**
 * Pressure compaction that stops paying for summaries it cannot use. When the old part of the conversation is
 * already shorter than any summary (images filling the retained tail), it waits until the conversation has grown
 * by a retained tail and omits the oldest images instead, so the conversation gets back under the threshold.
 */
export const relievePressure = async <Result>(input: {
  readonly session: OffloadableSession
  readonly budget: CompactionBudget
  readonly stall: CompactionStall
  readonly measure: () => PressureMeasurement
  readonly compact: () => Promise<Result | null>
  readonly log: (message: string) => void
}): Promise<Result | null> => {
  const { session, budget, stall, measure, log } = input
  const before = measure()
  if (stall.waiting(session, before.totalTokens, budget)) {
    offloadOldestImages({ session, budget, measurement: before, stall, log })
    return null
  }
  try {
    const result = await input.compact()
    stall.clear(session)
    return result
  } catch (error) {
    if (!isUnshrinkableCompaction(error)) throw error
    const after = measure()
    stall.record(session, after.totalTokens)
    log(
      `跳过压缩：可以整理的文字太少（约 ${after.totalTokens} token，阈值 ${budget.thresholdTokens}），对话再增长 ${budget.retainTokens} token 前不再尝试`,
    )
    offloadOldestImages({ session, budget, measurement: after, stall, log })
    return null
  }
}
