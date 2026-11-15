import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { describe, expect, it } from 'vitest'
import type { ImageOffloadTarget, OffloadableSession } from '../src/compaction-pressure.js'
import {
  REQUEST_IMAGE_BYTE_LIMIT,
  estimatedRequestImageBytes,
  incomingImages,
  isOfficialDeepSeekBaseUrl,
  observedRequestImages,
  requestImageStep,
  requestImageTransport,
  restoredImageCap,
  trimRequestImages,
} from '../src/request-image-limit.js'

const MIB = 1024 * 1024

interface FakeImage {
  readonly type: 'image'
  readonly attachment: { attachmentId: string; bytes: number; width: number; height: number }
  offloaded?: true
}

/** A conversation of one-image messages; `add` appends a message, `offloaded` lists which images are omitted. */
const conversation = () => {
  const messages: FakeImage[][] = []
  const offloads: ImageOffloadTarget[][] = []
  const fake = {
    surface: { nodes: [] as SessionSeq[] },
    eventAt: (seq: SessionSeq) => ({ type: 'user/message', seq }),
    deriveEventMessage: (event: { readonly seq: SessionSeq }) => ({ content: messages[Number(event.seq) - 1]! }),
    append: (_type: 'image/offload', data: { readonly targets: ImageOffloadTarget[] }) => {
      offloads.push(data.targets)
      for (const target of data.targets) {
        const images = messages[Number(target.seq) - 1]!
        for (const index of target.imageIndexes) images[index]!.offloaded = true
      }
    },
  }
  const add = (count = 1, bytes = 100_000) => {
    messages.push(
      Array.from({ length: count }, (_, index) => ({
        type: 'image' as const,
        attachment: { attachmentId: `nxt-asset:ast_${messages.length}_${index}:auto`, bytes, width: 800, height: 600 },
      })),
    )
    fake.surface.nodes.push(SessionSeq(messages.length))
  }
  const offloaded = () => messages.flat().map((image) => image.offloaded === true)
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Trimming reads only these members.
  return { session: fake as unknown as OffloadableSession, offloads, add, offloaded }
}

const silent = () => undefined

describe('request image limit', () => {
  it('trims a quarter of the limit at a time, at least two images', () => {
    expect([4, 6, 8, 12, 16, 24, 32].map(requestImageStep)).toEqual([2, 2, 2, 3, 4, 6, 8])
  })

  it('omits the oldest images only when a round crosses the limit, then waits for a full step of new ones', () => {
    const c = conversation()
    const rounds: number[] = []
    for (let round = 1; round <= 20; round += 1) {
      c.add()
      rounds.push(trimRequestImages({ session: c.session, limits: { maxImages: 8 }, log: silent }))
    }
    // Eight fit; the ninth trims down to six, and each later trim is two new images away.
    expect(rounds.map((count, index) => (count > 0 ? index + 1 : 0)).filter((round) => round > 0)).toEqual([
      9, 12, 15, 18,
    ])
    expect(rounds.filter((count) => count > 0)).toEqual([3, 3, 3, 3])
    // What was omitted is always a prefix: the oldest images, never one in the middle.
    const flags = c.offloaded()
    const firstKept = flags.indexOf(false)
    expect(flags.slice(0, firstKept).every(Boolean)).toBe(true)
    expect(flags.slice(firstKept).some(Boolean)).toBe(false)
    expect(flags.filter((flag) => !flag)).toHaveLength(8)
  })

  it('trims a message with several images in one decision and counts indexes within the message', () => {
    const c = conversation()
    c.add(5)
    c.add(5)
    expect(trimRequestImages({ session: c.session, limits: { maxImages: 8 }, log: silent })).toBe(4)
    expect(c.offloads).toEqual([[{ seq: SessionSeq(1), imageIndexes: [0, 1, 2, 3] }]])
    c.add(3)
    // Nine visible: past the limit again, so the remaining old one and two of the second message go.
    expect(trimRequestImages({ session: c.session, limits: { maxImages: 8 }, log: silent })).toBe(3)
    expect(c.offloads[1]).toEqual([
      { seq: SessionSeq(1), imageIndexes: [4] },
      { seq: SessionSeq(2), imageIndexes: [0, 1] },
    ])
  })

  it('guards the bytes a route resends with each request, also without an image limit', () => {
    const c = conversation()
    const rounds: number[] = []
    for (let round = 1; round <= 12; round += 1) {
      c.add(1, 1 * MIB)
      rounds.push(
        trimRequestImages({ session: c.session, limits: { maxBytes: REQUEST_IMAGE_BYTE_LIMIT }, log: silent }),
      )
    }
    // Nine 1 MiB pictures pass 8 MiB; trimming leaves 6 MiB, so the next trim is three pictures away.
    expect(rounds).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 3])
    expect(c.offloaded().filter((flag) => !flag)).toHaveLength(6)
  })

  it('counts the images a step is about to add, though only logged ones can be omitted', () => {
    const c = conversation()
    for (let round = 0; round < 6; round += 1) c.add()
    const picture = {
      attachmentId: AttachmentId('nxt-asset:ast_new:auto'),
      mediaType: 'image/png' as const,
      bytes: 100_000,
      width: 800,
      height: 600,
    }
    const adding = [
      {
        content: [
          { type: 'text' as const, text: '看这张' },
          { type: 'image' as const, attachment: picture },
        ],
      },
    ]
    expect(incomingImages(adding)).toEqual([picture])
    // Six logged plus one arriving is past six: trim to four, all of them from the logged ones.
    expect(
      trimRequestImages({
        session: c.session,
        limits: { maxImages: 6 },
        incoming: incomingImages(adding),
        log: silent,
      }),
    ).toBe(3)
    expect(c.offloaded()).toEqual([true, true, true, false, false, false])
    // More arriving than the limit: every logged image goes, the rest wait until they are logged.
    const many = Array.from({ length: 9 }, () => picture)
    expect(trimRequestImages({ session: c.session, limits: { maxImages: 6 }, incoming: many, log: silent })).toBe(3)
    expect(c.offloaded().every(Boolean)).toBe(true)
  })

  it('does nothing without limits', () => {
    const c = conversation()
    for (let round = 0; round < 50; round += 1) c.add()
    expect(trimRequestImages({ session: c.session, limits: {}, log: silent })).toBe(0)
    expect(c.offloads).toEqual([])
  })

  it('counts a large photo at the size it is sent, and a low-detail image smaller still', () => {
    const photo = { attachmentId: 'nxt-asset:ast_1:auto', bytes: 4 * MIB, width: 4096, height: 3072 }
    expect(estimatedRequestImageBytes(photo)).toBe(MIB)
    expect(estimatedRequestImageBytes({ ...photo, attachmentId: 'nxt-asset:ast_1:low' })).toBe(MIB / 16)
    expect(estimatedRequestImageBytes({ ...photo, width: 800, height: 600 })).toBe(4 * MIB)
  })

  it('restores after compaction a step under the limit', () => {
    expect(restoredImageCap(12, undefined)).toBe(12)
    expect(restoredImageCap(12, 8)).toBe(6)
    expect(restoredImageCap(4, 32)).toBe(4)
  })
})

const requestSent = (images: number, fileImages: number): SessionEvent =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Only type and data are read.
  ({
    type: 'nekro-nxt/request-sent',
    data: { turn: 1, step: 1, beforeRequestMs: 0, images, fileImages, reuploadedImages: 0 },
  }) as unknown as SessionEvent

describe('request image transport', () => {
  it('reads the latest request that carried images', () => {
    expect(observedRequestImages([])).toBeUndefined()
    expect(observedRequestImages([requestSent(3, 3), requestSent(0, 0)])).toBe('uploaded')
    expect(observedRequestImages([requestSent(3, 3), requestSent(4, 0)])).toBe('resent')
    expect(observedRequestImages([requestSent(4, 0), requestSent(5, 5)])).toBe('uploaded')
  })

  it('tells uploading DeepSeek routes from routes that resend images', () => {
    const none = [undefined]
    expect(requestImageTransport({ settingsNs: 'llm-pi-ai', baseURL: undefined, observed: none })).toBe('resent')
    expect(requestImageTransport({ settingsNs: 'llm-deepseek', baseURL: undefined, observed: none })).toBe('uploaded')
    expect(
      requestImageTransport({
        settingsNs: 'llm-deepseek',
        baseURL: 'https://api.deepseek.com/anthropic',
        observed: none,
      }),
    ).toBe('uploaded')
    expect(
      requestImageTransport({ settingsNs: 'llm-deepseek', baseURL: 'https://relay.example.test/v1', observed: none }),
    ).toBe('unknown')
    // A recent fallback to sending images in full counts even on the official endpoint.
    expect(
      requestImageTransport({ settingsNs: 'llm-deepseek', baseURL: undefined, observed: ['uploaded', 'resent'] }),
    ).toBe('resent')
    expect(
      requestImageTransport({
        settingsNs: 'llm-deepseek',
        baseURL: 'https://relay.example.test/v1',
        observed: ['uploaded'],
      }),
    ).toBe('uploaded')
    expect(requestImageTransport({ settingsNs: 'llm-other', baseURL: undefined, observed: none })).toBe('unknown')
    expect(isOfficialDeepSeekBaseUrl('not a url')).toBe(false)
  })
})
