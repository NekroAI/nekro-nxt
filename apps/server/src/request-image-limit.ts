import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import type { ImageOffloadTarget, OffloadableSession } from './compaction-pressure.js'
import { nxtRecordOf } from './nxt-session-records.js'
import type {} from './request-timing.js'

/**
 * Images a request carries, trimmed in steps. Every omission rewrites the conversation from the oldest image it
 * touches, so the provider's cached prefix is lost from there once. Omitting a whole step at a time, and acting
 * again only when the conversation is past the limit once more, keeps that to one rewrite per step of new images.
 */

/** How many images one trimming step omits for a limit of `maxImages`. */
export const requestImageStep = (maxImages: number): number => Math.max(2, Math.ceil(maxImages / 4))

/**
 * Byte guard for routes that send every image in full with each request. 8 MiB of pictures is already several
 * seconds of upload per step, and stays well below the 20 MiB inline cap DSH enforces itself; DSH trims at that cap
 * one image at a time, which would rewrite the conversation on every step from then on. Trimming to 2 MiB under the
 * guard leaves room for a few more pictures before the next rewrite.
 */
export const REQUEST_IMAGE_BYTE_LIMIT = 8 * 1024 * 1024
export const REQUEST_IMAGE_BYTE_STEP = 2 * 1024 * 1024

/** What one conversation's requests are held to; both absent means images are left alone. */
export interface RequestImageLimits {
  readonly maxImages?: number | undefined
  /** Set only for routes that send images in full; uploaded files cost nothing per request. */
  readonly maxBytes?: number | undefined
}

/** How a route sends the images already in a conversation. */
export type RequestImageTransport = 'uploaded' | 'resent' | 'unknown'

/** The most images restoring after compaction puts back, so the next step does not omit them right away. */
export const restoredImageCap = (maxImages: number, maxRequestImages: number | undefined): number =>
  maxRequestImages === undefined
    ? maxImages
    : Math.min(maxImages, Math.max(0, maxRequestImages - requestImageStep(maxRequestImages)))

/**
 * Roughly what an image costs a request. The stored reference carries the original's bytes; the request sends it
 * scaled to at most 2048 px on the long side (the high-detail size; 512 at low detail), so a large photo is counted at
 * the share of its pixels that survive. Re-encoding usually shrinks it further, so this errs high.
 */
export const estimatedRequestImageBytes = (image: {
  readonly attachmentId: unknown
  readonly bytes: number
  readonly width: number
  readonly height: number
}): number => {
  // `nxt-asset:<assetId>:<detail>`, see `nekroImageAttachmentId`.
  const side = typeof image.attachmentId === 'string' && image.attachmentId.endsWith(':low') ? 512 : 2048
  const longSide = Math.max(image.width, image.height, 1)
  const scale = Math.min(1, side / longSide)
  return Math.ceil(image.bytes * scale * scale)
}

interface VisibleImage {
  readonly seq: SessionSeq
  readonly imageIndex: number
  readonly bytes: number
}

/** Images the model still receives, oldest first, with indexes counting every image occurrence in a message. */
const visibleImages = (session: Pick<OffloadableSession, 'eventAt' | 'deriveEventMessage' | 'surface'>) => {
  const images: VisibleImage[] = []
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq)
    if (event?.type !== 'user/message' && event?.type !== 'tool/result') continue
    const message = session.deriveEventMessage(event)
    if (message === null) continue
    let imageIndex = 0
    for (const block of message.content) {
      if (block.type !== 'image') continue
      if (block.offloaded !== true)
        images.push({ seq, imageIndex, bytes: estimatedRequestImageBytes(block.attachment) })
      imageIndex += 1
    }
  }
  return images
}

/** Image references in the messages about to join the conversation, in order; they are not logged yet. */
export const incomingImages = (messages: readonly { readonly content: readonly ContentBlock[] }[]) =>
  messages.flatMap((message) =>
    message.content.flatMap((block) => (block.type === 'image' && block.offloaded !== true ? [block.attachment] : [])),
  )

/**
 * Omits the oldest images when the next request would be past its image count or byte limit: down to one step below
 * the limit, in one `image/offload` decision. `incoming` are the images of the messages this step adds, which count
 * toward the request but can only be omitted once logged, at a later step. Below the limit it does nothing, which is
 * what keeps the next omission a full step of new images away. Returns how many images were omitted.
 */
export const trimRequestImages = (input: {
  readonly session: OffloadableSession
  readonly limits: RequestImageLimits
  readonly incoming?: readonly Parameters<typeof estimatedRequestImageBytes>[0][]
  readonly log: (message: string) => void
}): number => {
  const { session, limits, log } = input
  if (limits.maxImages === undefined && limits.maxBytes === undefined) return 0
  const logged = visibleImages(session)
  const sizes = [...logged.map((image) => image.bytes), ...(input.incoming ?? []).map(estimatedRequestImageBytes)]
  let byCount = 0
  if (limits.maxImages !== undefined && sizes.length > limits.maxImages) {
    byCount = sizes.length - Math.max(0, limits.maxImages - requestImageStep(limits.maxImages))
  }
  let byBytes = 0
  const totalBytes = sizes.reduce((sum, bytes) => sum + bytes, 0)
  if (limits.maxBytes !== undefined && totalBytes > limits.maxBytes) {
    const target = Math.max(0, limits.maxBytes - REQUEST_IMAGE_BYTE_STEP)
    let left = totalBytes
    while (byBytes < sizes.length && left > target) {
      left -= sizes[byBytes]!
      byBytes += 1
    }
  }
  const count = Math.min(logged.length, Math.max(byCount, byBytes))
  if (count === 0) return 0
  const targets: { readonly seq: SessionSeq; readonly imageIndexes: number[] }[] = []
  for (const image of logged.slice(0, count)) {
    const last = targets.at(-1)
    if (last?.seq === image.seq) last.imageIndexes.push(image.imageIndex)
    else targets.push({ seq: image.seq, imageIndexes: [image.imageIndex] })
  }
  session.append('image/offload', { targets: targets satisfies ImageOffloadTarget[] })
  log(
    byCount >= byBytes
      ? `省略了最早的 ${count} 张图片：单次请求最多附带 ${limits.maxImages} 张`
      : `省略了最早的 ${count} 张图片：图片共约 ${Math.round(totalBytes / 1024 / 1024)} MiB，每次请求都要整份发送`,
  )
  return count
}

/**
 * What the latest request that carried images says about the route: `uploaded` when it sent file ids, `resent`
 * when it fell back to sending them in full, undefined when no such request is on record.
 */
export const observedRequestImages = (
  events: readonly SessionEvent[],
): Exclude<RequestImageTransport, 'unknown'> | undefined => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    // Recorded by `request-timing.ts` for official DeepSeek requests.
    const data = nxtRecordOf(events[index]!, 'plugin:nekro-nxt/request-sent')?.data
    if (data === undefined) continue
    if (data.images === 0) continue
    return data.fileImages === 0 ? 'resent' : 'uploaded'
  }
  return undefined
}

/** DeepSeek's own endpoint, where images are uploaded once and later requests name the file. */
export const isOfficialDeepSeekBaseUrl = (baseURL: string | undefined): boolean => {
  if (baseURL === undefined) return true
  try {
    return new URL(baseURL).hostname === 'api.deepseek.com'
  } catch {
    return false
  }
}

/**
 * How a provider sends images, from its settings namespace: OpenAI-compatible, Anthropic-protocol and subscription
 * routes (`llm-pi-ai`) always send them in full; the DeepSeek adapter uploads them, unless its endpoint was changed to
 * a relay that may not accept uploads. What recent requests did overrides the guess.
 */
export const requestImageTransport = (input: {
  readonly settingsNs: string | undefined
  readonly baseURL: string | undefined
  readonly observed: readonly (Exclude<RequestImageTransport, 'unknown'> | undefined)[]
}): RequestImageTransport => {
  if (input.settingsNs === 'llm-pi-ai') return 'resent'
  if (input.settingsNs !== 'llm-deepseek') return 'unknown'
  if (input.observed.includes('resent')) return 'resent'
  if (input.observed.includes('uploaded')) return 'uploaded'
  return isOfficialDeepSeekBaseUrl(input.baseURL) ? 'uploaded' : 'unknown'
}
